use rom_weaver_containers::libarchive::{RegularArchiveProbeFormat, probe_regular_archive_format};

use super::selection_resolution::{SelectionExtract, SelectionResolutionOptions};
use super::weave_load::is_stream_codec_format_name;
use super::*;
use rom_weaver_core::KindFilterNameMatch;

#[derive(Debug)]
pub(super) struct ResolvedChecksumSource {
    pub(super) source: PathBuf,
    pub(super) extracted_archives: usize,
    pub(super) cleanup_paths: Vec<PathBuf>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct AutoExtractResolutionLabels<'a> {
    pub(super) command: &'a str,
    pub(super) family: OperationFamily,
    pub(super) format: Option<&'a str>,
    pub(super) source_label: &'a str,
    pub(super) temp_prefix: &'a str,
}

/// One requested patch and the path that auto-extraction resolved for it.
#[derive(Clone, Debug)]
pub(super) struct ResolvedPatch {
    pub(super) source: PathBuf,
    pub(super) resolved: PathBuf,
}

/// Resolved patch records plus any "resolved via N container extract step(s)"
/// notes produced by [`CliApp::resolve_patches`].
#[derive(Debug)]
pub(super) struct ResolvedPatchList {
    pub(super) patches: Vec<ResolvedPatch>,
    pub(super) extracted_notes: Vec<String>,
}

/// Command-specific labels for [`CliApp::resolve_patches`]; the only difference
/// between the patch-apply and patch-validate resolution loops.
pub(super) struct PatchResolveLabels<'a> {
    pub(super) command: &'a str,
    pub(super) noun: &'a str,
    pub(super) temp_prefix: &'a str,
}

#[derive(Clone, Copy, Debug)]
struct AutoExtractResolutionOptions<'a> {
    labels: AutoExtractResolutionLabels<'a>,
    select: &'a [String],
    group_disc_payloads: bool,
    no_extract: bool,
    no_ignore: bool,
    kind_filter: ArchiveEntryKindFilter,
    mode: AutoExtractMode,
    stop_on_single_payload_codec: bool,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct AutoExtractResolutionFlags {
    pub(super) no_extract: bool,
    pub(super) no_ignore: bool,
    pub(super) kind_filter: ArchiveEntryKindFilter,
    /// Treat single-payload codecs (CHD/RVZ/Z3DS/CSO/…) as terminal
    /// instead of decompressing them. Probe sets this so it reports the codec
    /// container itself; checksum/list keep extracting to reach the inner image.
    pub(super) stop_on_single_payload_codec: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AutoExtractMode {
    Recursive,
    SingleStep,
    SingleStepWithCompanions,
}

fn is_split_7z_volume(source: &Path) -> bool {
    source
        .file_stem()
        .is_some_and(|stem| stem.to_string_lossy().to_ascii_lowercase().ends_with(".7z"))
        && source.extension().is_some_and(|extension| {
            let extension = extension.as_encoded_bytes();
            extension.len() >= 3 && extension.iter().all(u8::is_ascii_digit)
        })
}

fn probe_auto_extract_source(
    handler: &dyn ContainerHandler,
    current_source: &Path,
    context: &OperationContext,
    labels: AutoExtractResolutionLabels<'_>,
) -> Result<bool> {
    let probe_request = ContainerProbeRequest {
        source: current_source.to_path_buf(),
        split_bin: false,
    };
    if let Err(error) = handler.probe_details(&probe_request, context) {
        // A short signature can match raw ROM bytes by chance. Only a
        // file named as this container is a damaged archive; any
        // other file is used as-is.
        if !handler.descriptor().matches_path(current_source) && !is_split_7z_volume(current_source)
        {
            debug!(
                current_source = %current_source.display(),
                format = handler.descriptor().name,
                error = %error,
                "auto-extract stopped: signature-only match failed its probe; using the raw file"
            );
            return Ok(false);
        }
        trace!(
            current_source = %current_source.display(),
            format = handler.descriptor().name,
            error = %error,
            "auto-extract failed: handler probe failed"
        );
        if is_split_7z_volume(current_source) && handler.descriptor().matches_name("7z") {
            return Err(RomWeaverError::Validation(format!(
                "{} payload extraction failed for `{}` (7z): split 7z volume sets are unsupported; join the volumes into one archive or use --no-extract to use this volume as raw input: {error}",
                labels.source_label,
                current_source.display(),
            )));
        }
        return Err(RomWeaverError::Validation(format!(
            "{} payload extraction failed for `{}` ({}): {error}",
            labels.source_label,
            current_source.display(),
            handler.descriptor().name
        )));
    }

    Ok(true)
}

fn auto_extract_next_depth(
    current_source: &Path,
    depth: usize,
    source_label: &str,
) -> Result<usize> {
    let next_depth = depth + 1;
    if next_depth > MAX_NESTED_EXTRACT_DEPTH {
        trace!(
            current_source = %current_source.display(),
            next_depth,
            max_depth = MAX_NESTED_EXTRACT_DEPTH,
            "auto-extract failed: exceeded max recursion depth"
        );
        return Err(RomWeaverError::Validation(format!(
            "{} extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
            source_label,
            current_source.display()
        )));
    }
    Ok(next_depth)
}

impl CliApp {
    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn resolve_emulator_source(
        &self,
        source: &Path,
        select: &[String],
        context: &OperationContext,
        extensions: &std::collections::HashSet<String>,
    ) -> Result<ResolvedChecksumSource> {
        let mut resolved = ResolvedChecksumSource {
            source: source.to_path_buf(),
            extracted_archives: 0,
            cleanup_paths: Vec::new(),
        };
        for _ in 0..=MAX_NESTED_EXTRACT_DEPTH {
            let extension = resolved
                .source
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            // Emulator-readable disc images MUST remain whole, including after archive extraction.
            if extensions.contains(&extension) {
                return Ok(resolved);
            }
            let next = self.resolve_source_with_auto_extract_with_mode(
                &resolved.source,
                context,
                AutoExtractResolutionOptions {
                    select,
                    labels: AutoExtractResolutionLabels {
                        command: "test",
                        family: OperationFamily::Command,
                        format: None,
                        source_label: "ROM",
                        temp_prefix: "test-extract",
                    },
                    group_disc_payloads: false,
                    no_extract: false,
                    no_ignore: false,
                    kind_filter: ArchiveEntryKindFilter::new(true, false),
                    mode: AutoExtractMode::SingleStepWithCompanions,
                    stop_on_single_payload_codec: true,
                },
            )?;
            if next.source == resolved.source {
                return Ok(resolved);
            }
            resolved.source = next.source;
            resolved.extracted_archives += next.extracted_archives;
            resolved.cleanup_paths.extend(next.cleanup_paths);
        }
        Err(RomWeaverError::Validation(format!(
            "ROM extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH}"
        )))
    }

    pub(super) fn resolve_exact_member_source(
        &self,
        source: &Path,
        member: &str,
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
        flags: AutoExtractResolutionFlags,
    ) -> Result<ResolvedChecksumSource> {
        let member = super::weave_parse::normalized_member_path(member, labels.source_label)?;
        if flags.no_extract {
            return Err(RomWeaverError::Validation(format!(
                "{} `{member}` requires extraction; remove --no-extract",
                labels.source_label
            )));
        }
        let mut current = source.to_path_buf();
        let mut cleanup_paths = Vec::new();
        let result = (|| -> Result<ResolvedChecksumSource> {
            for depth in 0..MAX_NESTED_EXTRACT_DEPTH {
                if let Some(disc) =
                    self.build_disc_context(&current, Some(&member), None, context)?
                {
                    return Ok(ResolvedChecksumSource {
                        source: self.disc_member_path(&disc, &member)?,
                        extracted_archives: depth,
                        cleanup_paths: Vec::new(),
                    });
                }
                // Generated intermediates have no format extension. Exact
                // member lookup MAY recognize tar by its parsed archive format.
                let handler = self
                    .containers
                    .probe(&current)
                    .or_else(|| {
                        if probe_regular_archive_format(
                            &current,
                            "tar",
                            RegularArchiveProbeFormat::Tar,
                        )
                        .unwrap_or(false)
                        {
                            self.containers.find_by_name("tar")
                        } else {
                            None
                        }
                    })
                    .ok_or_else(|| {
                        RomWeaverError::Validation(format!(
                            "{} `{member}` was not found in `{}`",
                            labels.source_label,
                            source.display()
                        ))
                    })?;
                if is_stream_codec_format_name(handler.descriptor().name) {
                    let resolved = self.resolve_source_with_auto_extract_with_mode(
                        &current,
                        context,
                        AutoExtractResolutionOptions {
                            select: &[],
                            labels,
                            group_disc_payloads: false,
                            no_extract: false,
                            no_ignore: true,
                            kind_filter: ArchiveEntryKindFilter::default(),
                            mode: AutoExtractMode::SingleStep,
                            stop_on_single_payload_codec: false,
                        },
                    )?;
                    cleanup_paths.extend(resolved.cleanup_paths);
                    if resolved.extracted_archives == 0 {
                        return Err(RomWeaverError::Validation(format!(
                            "{} `{member}` could not be extracted from `{}`",
                            labels.source_label,
                            current.display()
                        )));
                    }
                    current = resolved.source;
                    continue;
                }
                let entries = handler.list_entries(
                    &ContainerProbeRequest {
                        source: current.clone(),
                        split_bin: true,
                    },
                    context,
                )?;
                let matches = entries
                    .iter()
                    .filter(|entry| normalize_archive_name(entry) == member)
                    .count();
                if matches != 1 {
                    return Err(RomWeaverError::Validation(format!(
                        "{} `{member}` matches {matches} entries in `{}`; expected one exact member",
                        labels.source_label,
                        current.display()
                    )));
                }
                let selection = member
                    .chars()
                    .fold(String::new(), |mut selection, character| {
                        match character {
                            '*' => selection.push_str("[*]"),
                            '?' => selection.push_str("[?]"),
                            '[' => selection.push_str("[[]"),
                            _ => selection.push(character),
                        }
                        selection
                    });
                let out_dir = context.temp_paths().next_path(labels.temp_prefix, None);
                fs::create_dir_all(&out_dir)?;
                cleanup_paths.push(out_dir.clone());
                trace!(source = %current.display(), member, format = handler.descriptor().name, "extracting exact target member");
                self.extract_container(
                    handler.as_ref(),
                    &ContainerExtractRequest {
                        source: current.clone(),
                        selections: vec![selection],
                        kind_filter: ArchiveEntryKindFilter::default(),
                        out_dir: out_dir.clone(),
                        split_bin: true,
                        ignore_common_files: false,
                        overwrite: true,
                        parent: None,
                        containing_archive: (current != source).then(|| source.to_path_buf()),
                    },
                    context,
                )?;
                let selected = out_dir.join(&member);
                if !selected.is_file() {
                    return Err(RomWeaverError::Validation(format!(
                        "{} `{member}` did not extract to a file",
                        labels.source_label
                    )));
                }
                return Ok(ResolvedChecksumSource {
                    source: selected,
                    extracted_archives: depth + 1,
                    cleanup_paths: Vec::new(),
                });
            }
            Err(RomWeaverError::Validation(format!(
                "{} `{member}` exceeded the extract depth limit",
                labels.source_label
            )))
        })();
        match result {
            Ok(mut resolved) => {
                resolved.cleanup_paths = cleanup_paths;
                Ok(resolved)
            }
            Err(error) => {
                Self::cleanup_temp_paths(&cleanup_paths);
                Err(error)
            }
        }
    }

    pub(super) fn resolve_source_with_auto_extract(
        &self,
        source: &Path,
        select: &[String],
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
        flags: AutoExtractResolutionFlags,
        group_disc_payloads: bool,
    ) -> Result<ResolvedChecksumSource> {
        self.resolve_source_with_auto_extract_with_mode(
            source,
            context,
            AutoExtractResolutionOptions {
                select,
                labels,
                group_disc_payloads,
                no_extract: flags.no_extract,
                no_ignore: flags.no_ignore,
                kind_filter: flags.kind_filter,
                mode: AutoExtractMode::Recursive,
                stop_on_single_payload_codec: flags.stop_on_single_payload_codec,
            },
        )
    }

    fn resolve_source_with_auto_extract_with_mode(
        &self,
        source: &Path,
        context: &OperationContext,
        options: AutoExtractResolutionOptions<'_>,
    ) -> Result<ResolvedChecksumSource> {
        let labels = options.labels;
        let select = options.select;
        trace!(
            source = %source.display(),
            selections = select.len(),
            no_extract = options.no_extract,
            no_ignore = options.no_ignore,
            rom_filter = options.kind_filter.rom,
            patch_filter = options.kind_filter.patch,
            mode = ?options.mode,
            command = labels.command,
            family = ?labels.family,
            format = ?labels.format,
            source_label = labels.source_label,
            "starting auto-extract source resolution"
        );
        if options.no_extract {
            trace!(
                source = %source.display(),
                "auto-extract source resolution disabled by flag"
            );
            return Ok(ResolvedChecksumSource {
                source: source.to_path_buf(),
                extracted_archives: 0,
                cleanup_paths: Vec::new(),
            });
        }

        let mut current_source = source.to_path_buf();
        let mut extracted_archives = 0usize;
        let mut depth = 0usize;
        let mut cleanup_paths = Vec::new();

        loop {
            trace!(
                current_source = %current_source.display(),
                depth,
                extracted_archives,
                "auto-extract iteration"
            );
            // A `.dcp` is a ZIP-shaped patch, not an archive: its inner entries are DCP operations.
            // An explicit `--select` against the top-level source still reaches inside it; a
            // nested `.dcp` was already picked by that selection, so it stays a leaf.
            if is_dcp_patch_name(&current_source.to_string_lossy())
                && (depth > 0 || select.is_empty())
            {
                trace!(
                    current_source = %current_source.display(),
                    "auto-extract stopped: DCP patch is a leaf"
                );
                break;
            }
            let Some(handler) = self.auto_extract_handler(&current_source, options) else {
                break;
            };
            if !probe_auto_extract_source(handler.as_ref(), &current_source, context, labels)? {
                break;
            }

            let next_depth = auto_extract_next_depth(&current_source, depth, labels.source_label)?;
            if extracted_archives >= MAX_NESTED_EXTRACT_ARCHIVES {
                trace!(
                    source = %source.display(),
                    extracted_archives,
                    max_archives = MAX_NESTED_EXTRACT_ARCHIVES,
                    "auto-extract failed: exceeded max archive count"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}",
                    labels.source_label
                )));
            }

            let out_dir = self.extract_auto_extract_payload(
                handler.as_ref(),
                &current_source,
                context,
                options,
            )?;
            cleanup_paths.push(out_dir.clone());
            extracted_archives = extracted_archives.saturating_add(1);
            depth = next_depth;
            trace!(
                source = %current_source.display(),
                format = handler.descriptor().name,
                out_dir = %out_dir.display(),
                extracted_archives,
                depth,
                "auto-extract archive extraction completed"
            );

            let selected_candidate =
                self.resolve_auto_extract_candidate(&current_source, &out_dir, options)?;
            trace!(
                source = %current_source.display(),
                selected = %selected_candidate.display_name,
                selected_path = %selected_candidate.source.display(),
                "auto-extract selected single candidate"
            );
            current_source = selected_candidate.source;
            if options.mode != AutoExtractMode::Recursive {
                break;
            }
        }

        trace!(
            source = %source.display(),
            resolved_source = %current_source.display(),
            extracted_archives,
            cleanup_paths = cleanup_paths.len(),
            "completed auto-extract source resolution"
        );
        Ok(ResolvedChecksumSource {
            source: current_source,
            extracted_archives,
            cleanup_paths,
        })
    }

    fn resolve_auto_extract_candidate(
        &self,
        current_source: &Path,
        out_dir: &Path,
        options: AutoExtractResolutionOptions<'_>,
    ) -> Result<ChecksumExtractCandidate> {
        let labels = options.labels;
        let select = options.select;
        let all_candidates = self.collect_checksum_extract_candidates(out_dir)?;
        let all_candidates = if options.group_disc_payloads {
            Self::group_disc_extract_candidates(all_candidates)?
        } else {
            all_candidates
        };
        if options.mode == AutoExtractMode::SingleStepWithCompanions && !select.is_empty() {
            let mut matcher = SelectionMatcher::new(select);
            let candidates = all_candidates
                .into_iter()
                .filter(|candidate| matcher.matches(&candidate.display_name))
                .collect();
            matcher.ensure_all_matched()?;
            return self.select_auto_extract_candidate(
                current_source,
                candidates,
                labels.source_label,
            );
        }
        trace!(
            source = %current_source.display(),
            candidate_count = all_candidates.len(),
            "auto-extract collected extracted candidates"
        );
        if all_candidates.is_empty() {
            trace!(
                source = %current_source.display(),
                "auto-extract failed: extracted archive produced no candidates"
            );
            return Err(RomWeaverError::Validation(format!(
                "{} payload extraction produced no files for `{}`",
                labels.source_label,
                current_source.display()
            )));
        }

        let (candidates, ignored_candidate_selected) = self
            .filter_ignored_auto_extract_candidates(
                current_source,
                all_candidates,
                labels.source_label,
                options.no_ignore,
            )?;
        let candidates = if ignored_candidate_selected {
            candidates
        } else {
            self.filter_kind_auto_extract_candidates(
                current_source,
                candidates,
                options.kind_filter,
            )?
        };
        self.select_auto_extract_candidate(current_source, candidates, labels.source_label)
    }

    fn auto_extract_handler(
        &self,
        current_source: &Path,
        options: AutoExtractResolutionOptions<'_>,
    ) -> Option<Arc<dyn ContainerHandler>> {
        let Some(handler) = self
            .containers
            .probe(current_source)
            .or_else(|| {
                is_split_7z_volume(current_source)
                    .then(|| self.containers.find_by_name("7z"))
                    .flatten()
            })
            .filter(|handler| !handler.is_self_contained_rom(current_source))
        else {
            trace!(
                current_source = %current_source.display(),
                "auto-extract stopped: no extractable container handler matched source"
            );
            return None;
        };
        let is_xiso = handler.descriptor().matches_name("xiso");
        let can_extract = handler.capabilities().extract;
        if is_xiso || !can_extract {
            trace!(
                current_source = %current_source.display(),
                format = handler.descriptor().name,
                is_xiso,
                can_extract,
                "auto-extract stopped: matched handler is not eligible for extract"
            );
            return None;
        }
        if options.stop_on_single_payload_codec && handler.is_single_payload_codec_container() {
            trace!(
                current_source = %current_source.display(),
                format = handler.descriptor().name,
                "auto-extract stopped: single-payload codec reported as terminal probe target"
            );
            return None;
        }

        Some(handler)
    }

    fn extract_auto_extract_payload(
        &self,
        handler: &dyn ContainerHandler,
        current_source: &Path,
        context: &OperationContext,
        options: AutoExtractResolutionOptions<'_>,
    ) -> Result<PathBuf> {
        let labels = options.labels;
        self.emit_running(
            OperationLabel {
                command: labels.command,
                family: labels.family,
                format: Some(handler.descriptor().name),
            },
            "prepare",
            format!(
                "extracting {} payload from `{}`",
                labels.source_label,
                current_source.display()
            ),
            None,
            Some(context.plan_threads(handler.capabilities().extract_threads)),
        );

        let out_dir = context.temp_paths().next_path(labels.temp_prefix, None);
        fs::create_dir_all(&out_dir)?;
        let resolved_selections =
            self.auto_extract_selections(handler, current_source, context, options)?;
        self.extract_with_selection_fallback(
            handler,
            current_source,
            SelectionExtract {
                out_dir: &out_dir,
                selections: &resolved_selections,
                kind_filter: if options.mode == AutoExtractMode::SingleStepWithCompanions {
                    ArchiveEntryKindFilter::default()
                } else {
                    options.kind_filter
                },
                split_bin: false,
                ignore_common_files: false,
                overwrite: true,
                source_label: labels.source_label,
                allow_multi_select: false,
            },
            context,
        )
        .map_err(|error| {
            if error.code() == Some(rom_weaver_core::ERROR_CODE_EXTRACT_NO_MATCHING_ENTRIES) {
                return error;
            }
            RomWeaverError::Validation(format!(
                "{} payload extraction failed for `{}` ({}): {error}",
                labels.source_label,
                current_source.display(),
                handler.descriptor().name
            ))
        })?;
        Ok(out_dir)
    }

    fn auto_extract_selections(
        &self,
        handler: &dyn ContainerHandler,
        current_source: &Path,
        context: &OperationContext,
        options: AutoExtractResolutionOptions<'_>,
    ) -> Result<Vec<String>> {
        // Disc sheets and playlists MUST retain their referenced archive members.
        if options.mode == AutoExtractMode::SingleStepWithCompanions {
            return Ok(Vec::new());
        }
        if !options.select.is_empty() || !self.interactive_selection_enabled {
            return Ok(options.select.to_vec());
        }
        self.resolve_extract_payload_selections(
            handler,
            current_source,
            SelectionResolutionOptions {
                kind_filter: options.kind_filter,
                split_bin: false,
                ignore_common_files: !options.no_ignore,
                source_label: options.labels.source_label,
            },
            context,
        )
    }

    fn group_disc_extract_candidates(
        candidates: Vec<ChecksumExtractCandidate>,
    ) -> Result<Vec<ChecksumExtractCandidate>> {
        let mut companions = BTreeSet::new();
        for candidate in &candidates {
            if detect_disc_sheet(&candidate.source).is_none() {
                continue;
            }
            let parent = candidate.source.parent().unwrap_or_else(|| Path::new("."));
            for name in enumerate_disc_sheet_refs(&candidate.source)?.referenced_files {
                let track = parent.join(name);
                companions.insert(fs::canonicalize(&track).unwrap_or(track));
            }
            if let Some(gdi) = sibling_gdi_path(&candidate.source) {
                companions.insert(fs::canonicalize(&gdi).unwrap_or(gdi));
            }
        }
        Ok(candidates
            .into_iter()
            .filter(|candidate| {
                let source = fs::canonicalize(&candidate.source)
                    .unwrap_or_else(|_| candidate.source.clone());
                !companions.contains(&source)
            })
            .collect())
    }

    fn filter_ignored_auto_extract_candidates(
        &self,
        current_source: &Path,
        all_candidates: Vec<ChecksumExtractCandidate>,
        source_label: &str,
        no_ignore: bool,
    ) -> Result<(Vec<ChecksumExtractCandidate>, bool)> {
        if no_ignore {
            return Ok((all_candidates, false));
        }
        let non_ignored = all_candidates
            .iter()
            .filter(|candidate| !candidate.ignored)
            .cloned()
            .collect::<Vec<_>>();
        trace!(
            source = %current_source.display(),
            candidate_count = all_candidates.len(),
            non_ignored_count = non_ignored.len(),
            "auto-extract applied candidate ignore filters"
        );
        if !non_ignored.is_empty() {
            return Ok((non_ignored, false));
        }
        if self.interactive_selection_enabled {
            if let Some(selected) = self.prompt_for_checksum_candidate(
                current_source,
                &all_candidates,
                source_label,
                true,
            )? {
                trace!(
                    source = %current_source.display(),
                    selected = %selected.display_name,
                    selected_path = %selected.source.display(),
                    "auto-extract continued with interactively selected ignored candidate"
                );
                return Ok((vec![selected], true));
            }
            trace!(
                source = %current_source.display(),
                "auto-extract failed: interactive selection cancelled while all candidates were ignored"
            );
            return Err(RomWeaverError::coded(
                rom_weaver_core::ERROR_CODE_SELECTION_CANCELLED,
                format!(
                    "interactive selection was cancelled for `{}`",
                    current_source.display()
                ),
            ));
        }
        trace!(
            source = %current_source.display(),
            "auto-extract failed: all candidates ignored and no interactive selection"
        );
        Err(RomWeaverError::ValidationCode(
            rom_weaver_core::ValidationCodeError::new(
                rom_weaver_core::ERROR_CODE_EXTRACT_ALL_ENTRIES_IGNORED,
            )
            .with_message(format!(
                "all extracted {source_label} candidates from `{}` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>",
                current_source.display()
            ))
            .with_field("path", current_source.display().to_string()),
        ))
    }

    fn filter_kind_auto_extract_candidates(
        &self,
        current_source: &Path,
        candidates: Vec<ChecksumExtractCandidate>,
        kind_filter: ArchiveEntryKindFilter,
    ) -> Result<Vec<ChecksumExtractCandidate>> {
        if !kind_filter.enabled() {
            return Ok(candidates);
        }
        let classified = candidates
            .iter()
            .map(|candidate| {
                let kind = match kind_filter.classify_name(&candidate.display_name) {
                    KindFilterNameMatch::Unnamed => {
                        let is_patch = self.is_patch_payload(&candidate.source);
                        if (kind_filter.patch && is_patch) || (kind_filter.rom && !is_patch) {
                            KindFilterNameMatch::Unnamed
                        } else {
                            KindFilterNameMatch::Rejected
                        }
                    }
                    // Resolving one candidate descends into a wrapper before reading its payload.
                    KindFilterNameMatch::UnnamedStream => KindFilterNameMatch::Container,
                    kind => kind,
                };
                trace!(candidate = %candidate.display_name, ?kind, "classified auto-extract candidate");
                (kind, candidate.clone())
            })
            .collect();
        let filtered = rom_weaver_core::select_kind_filter_matches(classified, false);
        trace!(
            source = %current_source.display(),
            candidate_count = candidates.len(),
            filtered_count = filtered.len(),
            filter = %kind_filter.flag_label(),
            "auto-extract applied candidate kind filters"
        );
        if filtered.is_empty() {
            let choices = Self::render_checksum_candidate_choices(&candidates);
            return Err(RomWeaverError::no_matching_extract_entries(
                current_source,
                &kind_filter.flag_label(),
                &format!("; candidates: {choices}"),
            ));
        }
        Ok(filtered)
    }

    fn select_auto_extract_candidate(
        &self,
        current_source: &Path,
        candidates: Vec<ChecksumExtractCandidate>,
        source_label: &str,
    ) -> Result<ChecksumExtractCandidate> {
        if candidates.len() == 1 {
            return candidates.into_iter().next().ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "internal validation error: {source_label} payload candidate set was empty for `{}`",
                    current_source.display()
                ))
            });
        }
        if self.interactive_selection_enabled {
            if let Some(selected) = self.prompt_for_checksum_candidate(
                current_source,
                &candidates,
                source_label,
                false,
            )? {
                trace!(
                    source = %current_source.display(),
                    selected = %selected.display_name,
                    selected_path = %selected.source.display(),
                    "auto-extract continued with interactively selected candidate"
                );
                return Ok(selected);
            }
            trace!(
                source = %current_source.display(),
                candidate_count = candidates.len(),
                "auto-extract failed: interactive ambiguous candidate selection cancelled"
            );
            return Err(RomWeaverError::coded(
                rom_weaver_core::ERROR_CODE_SELECTION_CANCELLED,
                format!(
                    "interactive selection was cancelled for `{}`",
                    current_source.display()
                ),
            ));
        }
        let choices = Self::render_checksum_candidate_choices(&candidates);
        trace!(
            source = %current_source.display(),
            candidate_count = candidates.len(),
            candidates = %choices,
            "auto-extract failed: ambiguous candidates without interactive selection"
        );
        Err(RomWeaverError::Validation(format!(
            "{source_label} payload resolution is ambiguous for `{}`; candidates: {choices}. Pass --select <pattern> to choose one payload",
            current_source.display()
        )))
    }

    /// Best-effort removal of staged temp files/dirs. Missing paths and removal
    /// errors are ignored (cleanup must never fail an operation). Takes a slice
    /// so callers can clean up without surrendering ownership of their path
    /// list.
    pub(super) fn cleanup_temp_paths(temp_paths: &[PathBuf]) {
        for temp_path in temp_paths {
            match fs::metadata(temp_path) {
                Ok(metadata) if metadata.is_dir() => {
                    let _ = fs::remove_dir_all(temp_path);
                }
                Ok(_) => {
                    let _ = fs::remove_file(temp_path);
                }
                Err(_) => {}
            }
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/source_resolution.rs"]
mod tests;
