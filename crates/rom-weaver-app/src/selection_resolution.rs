use super::*;

/// The destination and selection settings for an extract-with-interactive-fallback call,
/// grouped so the helper takes one descriptor instead of six positional arguments.
#[derive(Clone, Copy)]
pub(super) struct SelectionExtract<'a> {
    pub(super) out_dir: &'a Path,
    pub(super) selections: &'a [String],
    pub(super) kind_filter: ArchiveEntryKindFilter,
    pub(super) split_bin: bool,
    pub(super) ignore_common_files: bool,
    pub(super) overwrite: bool,
    pub(super) source_label: &'a str,
    pub(super) allow_multi_select: bool,
}

#[derive(Clone, Copy)]
pub(super) struct SelectionResolutionOptions<'a> {
    pub(super) kind_filter: ArchiveEntryKindFilter,
    pub(super) split_bin: bool,
    pub(super) ignore_common_files: bool,
    pub(super) source_label: &'a str,
}

impl CliApp {
    pub(super) fn archive_entry_kind_filter(
        rom_filter: bool,
        patch_filter: bool,
    ) -> ArchiveEntryKindFilter {
        ArchiveEntryKindFilter::new(rom_filter, patch_filter)
    }

    pub(super) fn kind_filtered_container_list_entries(
        entries: &[ContainerListEntry],
        kind_filter: ArchiveEntryKindFilter,
        ignore_common_files: bool,
    ) -> (Vec<ContainerListEntry>, Vec<ContainerListEntry>) {
        if kind_filter.disabled() {
            return (entries.to_vec(), Vec::new());
        }
        let mut payload_matches = Vec::new();
        let mut container_fallback_matches = Vec::new();
        for entry in entries {
            if ignore_common_files && should_ignore_common_container_file(&entry.path) {
                continue;
            }
            if kind_filter.matches_payload_name(&entry.path) {
                payload_matches.push(entry.clone());
            } else if kind_filter.matches_container_fallback_name(&entry.path) {
                container_fallback_matches.push(entry.clone());
            }
        }
        (payload_matches, container_fallback_matches)
    }

    pub(super) fn extract_with_selection_fallback(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        extract: SelectionExtract,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let SelectionExtract {
            out_dir,
            selections,
            kind_filter,
            split_bin,
            ignore_common_files,
            overwrite,
            source_label,
            allow_multi_select,
        } = extract;
        let request = ContainerExtractRequest {
            source: source.to_path_buf(),
            selections: selections.to_vec(),
            kind_filter,
            out_dir: out_dir.to_path_buf(),
            split_bin,
            ignore_common_files,
            overwrite,
            parent: None,
        };
        match handler.extract(&request, context) {
            Ok(report) => Ok(report),
            Err(error) => {
                if !self.interactive_selection_enabled
                    || !Self::is_selection_resolution_error(&error.to_string())
                {
                    return Err(error);
                }

                let selected_entries = self.prompt_for_container_selections(
                    handler,
                    source,
                    source_label,
                    allow_multi_select,
                    context,
                )?;
                if selected_entries.is_empty() {
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        source.display()
                    )));
                }

                let retry_request = ContainerExtractRequest {
                    source: source.to_path_buf(),
                    selections: selected_entries,
                    kind_filter,
                    out_dir: out_dir.to_path_buf(),
                    split_bin,
                    ignore_common_files,
                    overwrite,
                    parent: None,
                };
                handler.extract(&retry_request, context)
            }
        }
    }

    /// Resolve payload entries to extract from `source`. Used when interactive selection is enabled
    /// and no explicit `--select` was given: lists the container's payload candidates (grouping a
    /// CD's cue + bin/iso/img tracks into the single cue candidate so a disc is not treated as
    /// ambiguous), keeps 0/1 logical payloads whole, and otherwise prompts the host to choose one or
    /// more entries. Returns an empty list when the container exposes no distinct ambiguous payload
    /// set, in which case the caller extracts everything as before.
    pub(super) fn resolve_extract_payload_selections(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        options: SelectionResolutionOptions<'_>,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        let entries = handler
            .list_entry_records(
                &ContainerProbeRequest {
                    source: source.to_path_buf(),
                    split_bin: options.split_bin,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "interactive selection could not list entries for `{}` ({}): {error}",
                    source.display(),
                    handler.descriptor().name
                ))
            })?;
        let (payload, containers) = Self::kind_filtered_container_list_entries(
            &entries,
            options.kind_filter,
            options.ignore_common_files,
        );
        let has_cue = payload
            .iter()
            .any(|entry| entry.path.to_ascii_lowercase().ends_with(".cue"));
        let mut candidates: Vec<(String, Option<u64>)> = Vec::new();
        for entry in payload.iter().chain(containers.iter()) {
            let name = Self::normalize_selection_entry_name(&entry.path);
            if name.is_empty() {
                continue;
            }
            if has_cue {
                let lower = name.to_ascii_lowercase();
                if lower.ends_with(".bin") || lower.ends_with(".iso") || lower.ends_with(".img") {
                    continue;
                }
            }
            if !candidates.iter().any(|(existing, _)| existing == &name) {
                candidates.push((name, entry.size));
            }
        }
        trace!(
            source = %source.display(),
            candidate_count = candidates.len(),
            interactive = self.interactive_selection_enabled,
            "resolving extract payload selections"
        );
        match candidates.len() {
            // 0 or 1 distinct payload: extract everything at this level. This keeps a single logical
            // payload whole — notably a CD image whose cue + bin/iso/img tracks were grouped into one
            // candidate must be extracted together, not just the cue.
            0 | 1 => Ok(Vec::new()),
            _ => {
                let prompt_candidates = candidates
                    .iter()
                    .map(|(name, size)| PromptCandidate {
                        value: name.clone(),
                        label: name.clone(),
                        size: *size,
                    })
                    .collect::<Vec<_>>();
                let heading = format!(
                    "{source_label} payload selection for `{}` is ambiguous. Choose one or more entries:",
                    source.display(),
                    source_label = options.source_label
                );
                let selected_indexes = self.prompt_for_selections(&heading, &prompt_candidates)?;
                if selected_indexes.is_empty() {
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        source.display()
                    )));
                }
                Ok(selected_indexes
                    .into_iter()
                    .map(|index| prompt_candidates[index].value.clone())
                    .collect())
            }
        }
    }

    pub(super) fn is_selection_resolution_error(label: &str) -> bool {
        let lower = label.to_ascii_lowercase();
        lower.contains("requested selections were not found")
            || lower.contains("requested selections resolved to no extractable")
            || lower.contains("does not support --select")
    }

    pub(super) fn prompt_for_container_selections(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        source_label: &str,
        allow_multi_select: bool,
        context: &OperationContext,
    ) -> Result<Vec<String>> {
        let entries = handler
            .list_entries(
                &ContainerProbeRequest {
                    source: source.to_path_buf(),
                    split_bin: false,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "interactive selection could not list entries for `{}` ({}): {error}",
                    source.display(),
                    handler.descriptor().name
                ))
            })?;

        let mut unique_entries = Vec::new();
        let mut seen = HashSet::new();
        for entry in entries {
            let normalized = Self::normalize_selection_entry_name(&entry);
            if normalized.is_empty() || !seen.insert(normalized.clone()) {
                continue;
            }
            unique_entries.push(normalized);
        }
        if unique_entries.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "interactive selection could not list selectable entries for `{}` ({})",
                source.display(),
                handler.descriptor().name
            )));
        }

        let prompt_candidates = unique_entries
            .iter()
            .map(|entry| PromptCandidate {
                value: entry.clone(),
                label: entry.clone(),
                size: None,
            })
            .collect::<Vec<_>>();
        let heading = format!(
            "{source_label} selection for `{}` did not resolve. Choose {}:",
            source.display(),
            if allow_multi_select {
                "one or more entries"
            } else {
                "one entry"
            }
        );
        let selected_indexes = if allow_multi_select {
            self.prompt_for_selections(&heading, &prompt_candidates)?
        } else {
            self.prompt_for_selection(&heading, &prompt_candidates)?
                .into_iter()
                .collect()
        };
        Ok(selected_indexes
            .into_iter()
            .map(|index| prompt_candidates[index].value.clone())
            .collect())
    }

    pub(super) fn prompt_for_checksum_candidate(
        &self,
        source: &Path,
        candidates: &[ChecksumExtractCandidate],
        source_label: &str,
        ignored_only: bool,
    ) -> Result<Option<ChecksumExtractCandidate>> {
        if candidates.is_empty() {
            return Ok(None);
        }
        let heading = if ignored_only {
            format!(
                "{source_label} payload candidates for `{}` were ignored by default filters. Choose one entry to continue:",
                source.display()
            )
        } else {
            format!(
                "{source_label} payload selection for `{}` is ambiguous. Choose one entry:",
                source.display()
            )
        };
        let prompt_candidates = candidates
            .iter()
            .map(|candidate| PromptCandidate {
                value: candidate.display_name.clone(),
                label: if ignored_only && candidate.ignored {
                    format!("{} [ignored by default]", candidate.display_name)
                } else {
                    candidate.display_name.clone()
                },
                size: fs::metadata(&candidate.source)
                    .ok()
                    .map(|metadata| metadata.len()),
            })
            .collect::<Vec<_>>();
        let selected_index = self.prompt_for_selection(&heading, &prompt_candidates)?;
        Ok(selected_index.map(|index| candidates[index].clone()))
    }

    pub(super) fn render_checksum_candidate_choices(
        candidates: &[ChecksumExtractCandidate],
    ) -> String {
        if candidates.is_empty() {
            return "(none)".to_string();
        }
        candidates
            .iter()
            .map(|candidate| format!("`{}`", candidate.display_name))
            .collect::<Vec<_>>()
            .join(", ")
    }

    pub(super) fn normalize_selection_entry_name(name: &str) -> String {
        name.trim()
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    #[cfg(test)]
    pub(super) fn parse_selection_input(
        input: &str,
        candidate_count: usize,
    ) -> ParsedSelectionInput {
        parse_selection_input(input, candidate_count)
    }

    /// Resolve a selection by delegating the terminal IO to the injected prompter. The control flow
    /// (candidate building, retries) stays here; only the rendering and stdin read live in the
    /// front-end's [`SelectionPrompter`].
    pub(super) fn prompt_for_selection(
        &self,
        heading: &str,
        candidates: &[PromptCandidate],
    ) -> Result<Option<usize>> {
        if !self.interactive_selection_enabled || candidates.is_empty() {
            return Ok(None);
        }
        match self.prompter.select(heading, candidates) {
            Selection::Selected(index) if index < candidates.len() => Ok(Some(index)),
            Selection::Selected(_) | Selection::Cancelled => Ok(None),
        }
    }

    pub(super) fn prompt_for_selections(
        &self,
        heading: &str,
        candidates: &[PromptCandidate],
    ) -> Result<Vec<usize>> {
        if !self.interactive_selection_enabled || candidates.is_empty() {
            return Ok(Vec::new());
        }
        match self.prompter.select_many(heading, candidates) {
            SelectionList::Selected(indexes) => Ok(indexes
                .into_iter()
                .filter(|index| *index < candidates.len())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect()),
            SelectionList::Cancelled => Ok(Vec::new()),
        }
    }

    pub(super) fn collect_checksum_extract_candidates(
        &self,
        root: &Path,
    ) -> Result<Vec<ChecksumExtractCandidate>> {
        let mut directories = vec![root.to_path_buf()];
        let mut candidates = Vec::new();
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }

                let relative = path.strip_prefix(root).map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "failed to derive checksum candidate path from `{}`",
                        path.display()
                    ))
                })?;
                let display_name = Self::normalize_checksum_candidate_name(relative);
                if display_name.is_empty() {
                    continue;
                }
                let ignored = Self::should_ignore_checksum_candidate(&display_name);
                candidates.push(ChecksumExtractCandidate {
                    source: path,
                    display_name,
                    ignored,
                });
            }
        }

        candidates.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        Ok(candidates)
    }

    pub(super) fn normalize_checksum_candidate_name(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    pub(super) fn should_ignore_checksum_candidate(candidate_name: &str) -> bool {
        should_ignore_common_container_file(candidate_name)
    }
}
