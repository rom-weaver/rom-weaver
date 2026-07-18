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

/// One selectable unit in a fallback prompt: a single entry, or a loose multi-track disc
/// (its sheet + tracks) collapsed under one display label that expands to every member.
struct DiscSelectionGroup {
    label: String,
    key: String,
    members: Vec<String>,
    /// Summed size of every member file, when known; drives the prompt's size hint.
    size: Option<u64>,
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

    /// Group disc media/sheet entries that share a base name (a `.cue`/`.gdi` sheet plus its
    /// `(Track N)` tracks) into one selection group; every other entry stays a singleton.
    /// Order-preserving so the prompt reflects the listing order.
    fn group_disc_selection_entries(entries: &[String]) -> Vec<DiscSelectionGroup> {
        let mut groups: Vec<DiscSelectionGroup> = Vec::new();
        for entry in entries {
            match Self::disc_base_key(entry) {
                Some(key) => {
                    let lower = entry.to_ascii_lowercase();
                    let is_sheet = lower.ends_with(".cue") || lower.ends_with(".gdi");
                    if let Some(group) = groups.iter_mut().find(|group| group.key == key) {
                        group.members.push(entry.clone());
                        // Prefer a sheet (.cue/.gdi) name as the disc's display label.
                        if is_sheet {
                            group.label = entry.clone();
                        }
                    } else {
                        groups.push(DiscSelectionGroup {
                            label: entry.clone(),
                            key,
                            members: vec![entry.clone()],
                            size: None,
                        });
                    }
                }
                None => groups.push(DiscSelectionGroup {
                    label: entry.clone(),
                    key: entry.to_ascii_lowercase(),
                    members: vec![entry.clone()],
                    size: None,
                }),
            }
        }
        groups
    }

    /// Base key for grouping a disc's sheet + tracks: strips the directory, the file extension,
    /// and a trailing `(Track N)` segment. Returns `None` for non-disc entries so unrelated ROMs
    /// never collapse together.
    fn disc_base_key(name: &str) -> Option<String> {
        let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let lower = base.to_ascii_lowercase();
        let is_disc_member = [".bin", ".cue", ".gdi", ".iso", ".img", ".raw", ".wav"]
            .iter()
            .any(|ext| lower.ends_with(ext));
        if !is_disc_member {
            return None;
        }
        let stem = base.rfind('.').map_or(base, |idx| &base[..idx]);
        let mut key = stem.trim();
        // Drop a trailing "(Track N)" descriptor so every track shares the disc base.
        if let Some(open) = key.to_ascii_lowercase().rfind("(track") {
            let trimmed = key[..open].trim();
            if !trimmed.is_empty() {
                key = trimmed;
            }
        }
        Some(key.to_ascii_lowercase())
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
            containing_archive: None,
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
                    containing_archive: None,
                };
                handler.extract(&retry_request, context)
            }
        }
    }

    /// Resolve payload entries to extract from `source`. Used when interactive selection is enabled
    /// and no explicit `--select` was given: lists the container's payload candidates (grouping a
    /// CD/GD-ROM disc's cue/gdi sheet + bin/iso/img/raw tracks into the single sheet candidate so a
    /// disc is not treated as ambiguous), keeps 0/1 logical payloads whole, and otherwise prompts the host to choose one or
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
        // Collapse the container's entries into the LOGICAL ROMs it carries: a CD/GD-ROM disc
        // (its `.cue`/`.gdi` sheet plus every track) becomes one unit, while each loose ROM stays
        // its own unit. A disc must extract as a whole - sheet + all tracks together - so a chosen
        // unit expands back to every member file.
        let groups = Self::build_logical_payload_groups(
            &entries,
            options.kind_filter,
            options.ignore_common_files,
        );
        // Patch payloads stay multi-select (apply several patches at once); a ROM disambiguation is
        // "keep exactly one" so it is single-select.
        let multi_select = options.kind_filter.patch && !options.kind_filter.rom;
        trace!(
            source = %source.display(),
            group_count = groups.len(),
            entry_count = entries.len(),
            multi_select,
            interactive = self.interactive_selection_enabled,
            "resolving extract payload selections"
        );
        match groups.len() {
            // 0 or 1 logical payload: extract everything at this level. This keeps a single logical
            // payload whole - notably a CD image whose cue + bin/iso/img tracks were grouped into one
            // unit must be extracted together, not just the cue.
            0 | 1 => Ok(Vec::new()),
            _ => {
                let prompt_candidates = groups
                    .iter()
                    .map(|group| PromptCandidate {
                        value: group.label.clone(),
                        label: group.label.clone(),
                        size: group.size,
                    })
                    .collect::<Vec<_>>();
                let heading = format!(
                    "{source_label} payload selection for `{}` is ambiguous. {choose}:",
                    source.display(),
                    source_label = options.source_label,
                    choose = if multi_select {
                        "Choose one or more entries"
                    } else {
                        "Choose one ROM to keep"
                    }
                );
                let selected_indexes = if multi_select {
                    self.prompt_for_selections(&heading, &prompt_candidates)?
                } else {
                    self.prompt_for_selection(&heading, &prompt_candidates)?
                        .into_iter()
                        .collect()
                };
                if selected_indexes.is_empty() {
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        source.display()
                    )));
                }
                // Expand each chosen logical ROM back to its member files so a disc's sheet + tracks
                // all extract together.
                Ok(selected_indexes
                    .into_iter()
                    .flat_map(|index| groups[index].members.clone())
                    .collect())
            }
        }
    }

    /// Collapse a container's listed entries into the logical ROMs it carries, applying the
    /// `kind_filter`/common-file ignore rules. A CD/GD-ROM disc (a `.cue`/`.gdi` sheet plus its
    /// track media) becomes one group whose `members` are every file to extract; each loose ROM is
    /// its own single-member group. Detect sheets from the FULL entry list (a sheet that the kind
    /// filter drops from the payload must still anchor its disc) and keep listing order so prompts
    /// match the listing.
    fn build_logical_payload_groups(
        entries: &[ContainerListEntry],
        kind_filter: ArchiveEntryKindFilter,
        ignore_common_files: bool,
    ) -> Vec<DiscSelectionGroup> {
        let (payload, containers) =
            Self::kind_filtered_container_list_entries(entries, kind_filter, ignore_common_files);
        // Candidate payload names (payload preferred, else container fallbacks), order-preserving.
        let mut size_by_name: BTreeMap<String, Option<u64>> = BTreeMap::new();
        let mut candidate_names: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for entry in payload.iter().chain(containers.iter()) {
            let name = Self::normalize_selection_entry_name(&entry.path);
            if name.is_empty() {
                continue;
            }
            size_by_name.entry(name.clone()).or_insert(entry.size);
            if seen.insert(name.clone()) {
                candidate_names.push(name);
            }
        }
        // Disc sheets from the full listing - a sheet anchors its disc even when the kind filter
        // excludes it (e.g. a `--filter rom` run drops the non-payload `.cue`).
        let sheet_names: Vec<String> = entries
            .iter()
            .filter(|entry| {
                let lower = entry.path.to_ascii_lowercase();
                lower.ends_with(".cue") || lower.ends_with(".gdi")
            })
            .map(|entry| Self::normalize_selection_entry_name(&entry.path))
            .filter(|name| !name.is_empty())
            .collect();
        for sheet in &sheet_names {
            size_by_name.entry(sheet.clone()).or_insert_with(|| {
                entries
                    .iter()
                    .find_map(|entry| {
                        (Self::normalize_selection_entry_name(&entry.path) == *sheet)
                            .then_some(entry.size)
                    })
                    .flatten()
            });
        }

        let is_disc_media = |name: &str| {
            let lower = name.to_ascii_lowercase();
            [".bin", ".iso", ".img", ".raw", ".wav"]
                .iter()
                .any(|ext| lower.ends_with(ext))
        };

        let mut groups: Vec<DiscSelectionGroup> = if sheet_names.len() <= 1 {
            match sheet_names.first() {
                // Exactly one disc: collapse every disc-media candidate under the sheet; non-media
                // candidates stay their own logical ROMs.
                Some(sheet) => {
                    let mut disc_members = vec![sheet.clone()];
                    let mut others: Vec<DiscSelectionGroup> = Vec::new();
                    for name in &candidate_names {
                        if name == sheet {
                            continue;
                        }
                        if is_disc_media(name) {
                            disc_members.push(name.clone());
                        } else {
                            others.push(DiscSelectionGroup {
                                label: name.clone(),
                                key: name.to_ascii_lowercase(),
                                members: vec![name.clone()],
                                size: None,
                            });
                        }
                    }
                    let mut grouped = vec![DiscSelectionGroup {
                        label: sheet.clone(),
                        key: sheet.to_ascii_lowercase(),
                        members: disc_members,
                        size: None,
                    }];
                    grouped.extend(others);
                    grouped
                }
                // No sheet: each candidate is its own ROM, but loose same-base disc media (e.g. two
                // bins of one sheet-less disc) still collapse into one unit by shared base name.
                None => Self::group_disc_selection_entries(&candidate_names),
            }
        } else {
            // Multiple discs: group by shared base name so each disc's sheet + tracks collapse
            // together. Seed the sheets (kind-filtered out of the candidate list) so they anchor.
            let mut grouping_names = candidate_names.clone();
            for sheet in &sheet_names {
                if !grouping_names.iter().any(|name| name == sheet) {
                    grouping_names.push(sheet.clone());
                }
            }
            Self::group_disc_selection_entries(&grouping_names)
        };

        // Attach a summed size for each logical ROM so the prompt can show disc totals.
        for group in &mut groups {
            let total: u64 = group
                .members
                .iter()
                .filter_map(|name| size_by_name.get(name).copied().flatten())
                .sum();
            group.size = (total > 0).then_some(total);
        }
        groups
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

        // A loose multi-track disc ships a `.cue`/`.gdi` sheet plus its track files of a similar
        // name; group those into a SINGLE candidate so the disc reads as one ROM rather than
        // prompting per track (and dropping the sheet). Selecting the disc expands to every member.
        let groups = Self::group_disc_selection_entries(&unique_entries);
        // A single logical payload (e.g. one disc) needs no prompt - extract its whole group.
        if groups.len() == 1 {
            return Ok(groups
                .into_iter()
                .next()
                .map(|group| group.members)
                .unwrap_or_default());
        }

        let prompt_candidates = groups
            .iter()
            .map(|group| PromptCandidate {
                value: group.label.clone(),
                label: group.label.clone(),
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
            .flat_map(|index| groups[index].members.clone())
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

#[cfg(test)]
mod disc_grouping_tests {
    use super::CliApp;

    #[test]
    fn disc_base_key_strips_directory_extension_and_track_suffix() {
        assert_eq!(CliApp::disc_base_key("Game.cue").as_deref(), Some("game"));
        assert_eq!(
            CliApp::disc_base_key("Game (Track 1).bin").as_deref(),
            Some("game")
        );
        assert_eq!(
            CliApp::disc_base_key("disc/Game (Track 02).bin").as_deref(),
            Some("game")
        );
        assert_eq!(
            CliApp::disc_base_key("nested\\Game.gdi").as_deref(),
            Some("game")
        );
        assert_eq!(CliApp::disc_base_key("image.iso").as_deref(), Some("image"));
    }

    #[test]
    fn disc_base_key_returns_none_for_non_disc_members() {
        assert_eq!(CliApp::disc_base_key("readme.txt"), None);
        assert_eq!(CliApp::disc_base_key("cover.png"), None);
        assert_eq!(CliApp::disc_base_key("patch.bps"), None);
    }

    #[test]
    fn group_disc_selection_entries_collapses_one_disc_into_a_single_group() {
        let entries = vec![
            "Game (Track 1).bin".to_string(),
            "Game (Track 2).bin".to_string(),
            "Game.cue".to_string(),
        ];
        let groups = CliApp::group_disc_selection_entries(&entries);
        assert_eq!(groups.len(), 1);
        let group = &groups[0];
        // The `.cue` sheet wins the display label even though it is listed last.
        assert_eq!(group.label, "Game.cue");
        assert_eq!(group.members.len(), 3);
        assert!(group.members.contains(&"Game (Track 1).bin".to_string()));
        assert!(group.members.contains(&"Game.cue".to_string()));
    }

    #[test]
    fn group_disc_selection_entries_keeps_separate_discs_and_extras_apart() {
        let entries = vec![
            "Alpha.cue".to_string(),
            "Alpha (Track 1).bin".to_string(),
            "Beta.cue".to_string(),
            "Beta (Track 1).bin".to_string(),
            "manual.txt".to_string(),
        ];
        let groups = CliApp::group_disc_selection_entries(&entries);
        // Two discs + one unrelated file => three selection groups (still ambiguous => prompt).
        assert_eq!(groups.len(), 3);
        let labels: Vec<&str> = groups.iter().map(|group| group.label.as_str()).collect();
        assert_eq!(labels, vec!["Alpha.cue", "Beta.cue", "manual.txt"]);
        assert_eq!(groups[0].members.len(), 2);
        assert_eq!(groups[2].members, vec!["manual.txt".to_string()]);
    }

    #[test]
    fn group_disc_selection_entries_preserves_listing_order() {
        let entries = vec!["second.nes".to_string(), "first.nes".to_string()];
        let groups = CliApp::group_disc_selection_entries(&entries);
        let labels: Vec<&str> = groups.iter().map(|group| group.label.as_str()).collect();
        assert_eq!(labels, vec!["second.nes", "first.nes"]);
    }
}
