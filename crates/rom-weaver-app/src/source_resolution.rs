use super::selection_resolution::{SelectionExtract, SelectionResolutionOptions};
use super::*;

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

/// The `(original, resolved)` patch pairs plus the "resolved via N container
/// extract step(s)" notes produced by [`CliApp::resolve_patches`].
pub(super) type ResolvedPatchList = (Vec<(PathBuf, PathBuf)>, Vec<String>);

/// Command-specific labels for [`CliApp::resolve_patches`]; the only difference
/// between the patch-apply and patch-validate resolution loops.
pub(super) struct PatchResolveLabels<'a> {
    pub(super) command: &'a str,
    pub(super) noun: &'a str,
    pub(super) temp_prefix: &'a str,
}

#[derive(Clone, Copy, Debug)]
struct AutoExtractResolutionOptions {
    no_extract: bool,
    no_ignore: bool,
    kind_filter: ArchiveEntryKindFilter,
    mode: AutoExtractMode,
    stop_on_disc_image_codec: bool,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct AutoExtractResolutionFlags {
    pub(super) no_extract: bool,
    pub(super) no_ignore: bool,
    pub(super) kind_filter: ArchiveEntryKindFilter,
    /// Treat single-payload disc-image codecs (CHD/RVZ/Z3DS/CSO/…) as terminal
    /// instead of decompressing them. Probe sets this so it reports the codec
    /// container itself; checksum/list keep extracting to reach the inner image.
    pub(super) stop_on_disc_image_codec: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AutoExtractMode {
    Recursive,
    SingleStep,
}

impl CliApp {
    pub(super) fn resolve_source_with_auto_extract(
        &self,
        source: &Path,
        select: &[String],
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
        flags: AutoExtractResolutionFlags,
    ) -> Result<ResolvedChecksumSource> {
        self.resolve_source_with_auto_extract_with_mode(
            source,
            select,
            context,
            labels,
            AutoExtractResolutionOptions {
                no_extract: flags.no_extract,
                no_ignore: flags.no_ignore,
                kind_filter: flags.kind_filter,
                mode: AutoExtractMode::Recursive,
                stop_on_disc_image_codec: flags.stop_on_disc_image_codec,
            },
        )
    }

    fn resolve_source_with_auto_extract_with_mode(
        &self,
        source: &Path,
        select: &[String],
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
        options: AutoExtractResolutionOptions,
    ) -> Result<ResolvedChecksumSource> {
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
            let Some(handler) = self.containers.probe(&current_source) else {
                trace!(
                    current_source = %current_source.display(),
                    "auto-extract stopped: no container handler matched source"
                );
                break;
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
                break;
            }
            if options.stop_on_disc_image_codec && handler.is_single_payload_disc_image() {
                trace!(
                    current_source = %current_source.display(),
                    format = handler.descriptor().name,
                    "auto-extract stopped: disc-image codec reported as terminal probe target"
                );
                break;
            }

            let probe_request = ContainerProbeRequest {
                source: current_source.clone(),
                split_bin: false,
            };
            if let Err(error) = handler.probe_details(&probe_request, context) {
                trace!(
                    current_source = %current_source.display(),
                    format = handler.descriptor().name,
                    error = %error,
                    "auto-extract stopped: handler probe failed"
                );
                break;
            }

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
                    labels.source_label,
                    current_source.display()
                )));
            }
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
            // Ask BEFORE extracting: when the caller pinned no `--select` and interactive selection
            // is enabled, resolve the container's logical ROMs up front and prompt for the one to
            // keep (single-select for ROMs) instead of extracting everything and prompting after.
            // An unambiguous container resolves to an empty list, so we extract it whole as before.
            let resolved_selections;
            let select_for_extract: &[String] =
                if select.is_empty() && self.interactive_selection_enabled {
                    resolved_selections = self.resolve_extract_payload_selections(
                        handler.as_ref(),
                        &current_source,
                        SelectionResolutionOptions {
                            kind_filter: options.kind_filter,
                            split_bin: false,
                            ignore_common_files: !options.no_ignore,
                            source_label: labels.source_label,
                        },
                        context,
                    )?;
                    if resolved_selections.is_empty() {
                        select
                    } else {
                        &resolved_selections
                    }
                } else {
                    select
                };
            self.extract_with_selection_fallback(
                handler.as_ref(),
                &current_source,
                SelectionExtract {
                    out_dir: &out_dir,
                    selections: select_for_extract,
                    kind_filter: options.kind_filter,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    source_label: labels.source_label,
                    allow_multi_select: false,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} payload extraction failed for `{}` ({}): {error}",
                    labels.source_label,
                    current_source.display(),
                    handler.descriptor().name
                ))
            })?;
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

            let all_candidates = self.collect_checksum_extract_candidates(&out_dir)?;
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

            let candidates = if options.no_ignore {
                all_candidates.clone()
            } else {
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
                if non_ignored.is_empty() {
                    if self.interactive_selection_enabled {
                        if let Some(selected) = self.prompt_for_checksum_candidate(
                            &current_source,
                            &all_candidates,
                            labels.source_label,
                            true,
                        )? {
                            trace!(
                                source = %current_source.display(),
                                selected = %selected.display_name,
                                selected_path = %selected.source.display(),
                                "auto-extract continued with interactively selected ignored candidate"
                            );
                            current_source = selected.source;
                            if options.mode == AutoExtractMode::SingleStep {
                                break;
                            }
                            continue;
                        }
                        trace!(
                            source = %current_source.display(),
                            "auto-extract failed: interactive selection cancelled while all candidates were ignored"
                        );
                        return Err(RomWeaverError::Validation(format!(
                            "interactive selection was cancelled for `{}`",
                            current_source.display()
                        )));
                    }
                    trace!(
                        source = %current_source.display(),
                        "auto-extract failed: all candidates ignored and no interactive selection"
                    );
                    return Err(RomWeaverError::Validation(format!(
                        "all extracted {} candidates from `{}` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>",
                        labels.source_label,
                        current_source.display()
                    )));
                }
                non_ignored
            };
            let candidates = if options.kind_filter.enabled() {
                let mut payload_matches = Vec::new();
                let mut container_fallback_matches = Vec::new();
                for candidate in &candidates {
                    if options
                        .kind_filter
                        .matches_payload_name(&candidate.display_name)
                    {
                        payload_matches.push(candidate.clone());
                    } else if options
                        .kind_filter
                        .matches_container_fallback_name(&candidate.display_name)
                    {
                        container_fallback_matches.push(candidate.clone());
                    }
                }
                let filtered = if payload_matches.is_empty() {
                    container_fallback_matches
                } else {
                    payload_matches
                };
                trace!(
                    source = %current_source.display(),
                    candidate_count = candidates.len(),
                    filtered_count = filtered.len(),
                    filter = %options.kind_filter.flag_label(),
                    "auto-extract applied candidate kind filters"
                );
                if filtered.is_empty() {
                    let choices = Self::render_checksum_candidate_choices(&candidates);
                    return Err(RomWeaverError::Validation(format!(
                        "no extracted {} candidates from `{}` matched {}; candidates: {choices}",
                        labels.source_label,
                        current_source.display(),
                        options.kind_filter.flag_label()
                    )));
                }
                filtered
            } else {
                candidates
            };
            if candidates.len() > 1 {
                if self.interactive_selection_enabled {
                    if let Some(selected) = self.prompt_for_checksum_candidate(
                        &current_source,
                        &candidates,
                        labels.source_label,
                        false,
                    )? {
                        trace!(
                            source = %current_source.display(),
                            selected = %selected.display_name,
                            selected_path = %selected.source.display(),
                            "auto-extract continued with interactively selected candidate"
                        );
                        current_source = selected.source;
                        if options.mode == AutoExtractMode::SingleStep {
                            break;
                        }
                        continue;
                    }
                    trace!(
                        source = %current_source.display(),
                        candidate_count = candidates.len(),
                        "auto-extract failed: interactive ambiguous candidate selection cancelled"
                    );
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        current_source.display()
                    )));
                }
                let choices = candidates
                    .iter()
                    .map(|candidate| format!("`{}`", candidate.display_name))
                    .collect::<Vec<_>>()
                    .join(", ");
                trace!(
                    source = %current_source.display(),
                    candidate_count = candidates.len(),
                    candidates = %choices,
                    "auto-extract failed: ambiguous candidates without interactive selection"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} payload resolution is ambiguous for `{}`; candidates: {choices}. Pass --select <pattern> to choose one payload",
                    labels.source_label,
                    current_source.display()
                )));
            }

            let Some(selected_candidate) = candidates.into_iter().next() else {
                return Err(RomWeaverError::Validation(format!(
                    "internal validation error: {} payload candidate set was empty for `{}`",
                    labels.source_label,
                    current_source.display()
                )));
            };
            trace!(
                source = %current_source.display(),
                selected = %selected_candidate.display_name,
                selected_path = %selected_candidate.source.display(),
                "auto-extract selected single candidate"
            );
            current_source = selected_candidate.source;
            if options.mode == AutoExtractMode::SingleStep {
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
