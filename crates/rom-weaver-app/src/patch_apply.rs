use super::*;

use super::patch_commands::{
    DiscoveredPatchApplySidecars, PatchApplyProgressSink, PatchApplyProgressTracker,
    patch_progress_segment_start,
};

impl CliApp {
    pub(super) fn run_patch_apply(&self, args: PatchApplyCommand) -> AppRunOutcome {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            patch_count = args.patches.len(),
            output = %args.output.display(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_compress = args.no_compress,
            compress_format = ?args.compress_format,
            compress_codec = ?args.compress_codec,
            compress_level = ?args.compress_level,
            checksum_cache = args.checksum_cache.len(),
            validate_with_checksums = args.validate_with_checksums.len(),
            strip_header = args.strip_header,
            add_header = args.add_header,
            repair_checksum = args.repair_checksum,
            ignore_checksum_validation = args.ignore_checksum_validation,
            validate_with_output_checksums = args.validate_with_output_checksums.len(),
            ppf_undo_aware = args.ppf_undo_aware,
            threads = %args.threads,
            "starting patch-apply command"
        );
        let PatchApplyCommand {
            input,
            select,
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
            mut patches,
            output,
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
            checksum_cache,
            validate_with_checksums,
            strip_header,
            add_header,
            repair_checksum,
            ignore_checksum_validation,
            validate_with_output_checksums,
            ppf_undo_aware,
            threads,
        } = args;
        let discover_implicit_patches = patches.is_empty() && !no_extract;
        let input_kind_filter =
            Self::archive_entry_kind_filter(rom_filter || discover_implicit_patches, false);
        let patch_kind_filter = Self::archive_entry_kind_filter(false, patch_filter);
        let context = self
            .context(threads)
            .with_patch_checksum_validation(if ignore_checksum_validation {
                PatchChecksumValidation::Ignore
            } else {
                PatchChecksumValidation::Strict
            })
            .with_ppf_undo_aware(ppf_undo_aware);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let compression_options = match Self::parse_patch_apply_compression_options(
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
        ) {
            Ok(options) => options,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let cached_input_checksums =
            match Self::parse_patch_apply_checksum_values(&checksum_cache, "--checksum-cache") {
                Ok(values) => values,
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            };
        let expected_input_checksums = match Self::parse_patch_apply_checksum_values(
            &validate_with_checksums,
            "--validate-with-checksum",
        ) {
            Ok(values) => values,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let expected_output_checksums = match Self::parse_patch_apply_checksum_values(
            &validate_with_output_checksums,
            "--validate-output-checksum",
        ) {
            Ok(values) => values,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        let discovered_sidecars = if discover_implicit_patches {
            match self.discover_patch_apply_sidecars(&input, &select, no_ignore, &context) {
                Ok(discovered) => discovered,
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "prepare",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            }
        } else {
            DiscoveredPatchApplySidecars::default()
        };
        if patches.is_empty() {
            patches = discovered_sidecars.patches.clone();
        }
        if patches.is_empty() {
            return self.finish(
                "patch-apply",
                OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "patch apply requires at least one --patch file or RetroArch-style sidecar patch inside the input archive".to_string(),
                    probe_threads.clone(),
                ),
            );
        }
        for patch_path in &patches {
            if let Some(report) = self.require_existing_path(
                "patch-apply",
                OperationFamily::Patch,
                None,
                patch_path,
                probe_threads.clone(),
            ) {
                return self.finish("patch-apply", report);
            }
        }

        let resolved_input = match self.resolve_source_with_auto_extract(
            &input,
            &select,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch apply input",
                temp_prefix: "patch-apply-input-extract",
            },
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter: input_kind_filter,
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let ResolvedChecksumSource {
            source: resolved_input,
            extracted_archives,
            cleanup_paths,
        } = resolved_input;
        let mut temp_paths = cleanup_paths;
        temp_paths.extend(discovered_sidecars.cleanup_paths);
        let mut resolved_patches = Vec::with_capacity(patches.len());
        let mut extracted_patch_notes = Vec::new();
        for (index, patch_path) in patches.iter().enumerate() {
            let patch_source_label = if patches.len() == 1 {
                "patch apply patch source".to_string()
            } else {
                format!("patch apply patch {}/{} source", index + 1, patches.len())
            };
            let resolved_patch = match self.resolve_source_with_auto_extract(
                patch_path,
                &select,
                &context,
                AutoExtractResolutionLabels {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: None,
                    source_label: patch_source_label.as_str(),
                    temp_prefix: "patch-apply-patch-extract",
                },
                AutoExtractResolutionFlags {
                    no_extract,
                    no_ignore,
                    kind_filter: patch_kind_filter,
                },
            ) {
                Ok(resolved) => resolved,
                Err(error) => {
                    return self.finish(
                        "patch-apply",
                        OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "prepare",
                            error.to_string(),
                            probe_threads.clone(),
                        ),
                    );
                }
            };
            let ResolvedChecksumSource {
                source: resolved_patch_source,
                extracted_archives: resolved_patch_extracted_archives,
                cleanup_paths: resolved_patch_cleanup_paths,
            } = resolved_patch;
            if resolved_patch_extracted_archives > 0 {
                let note = if patches.len() == 1 {
                    format!(
                        "patch apply patch source resolved via {} container extract step(s)",
                        resolved_patch_extracted_archives
                    )
                } else {
                    format!(
                        "patch {}/{} source resolved via {} container extract step(s)",
                        index + 1,
                        patches.len(),
                        resolved_patch_extracted_archives
                    )
                };
                extracted_patch_notes.push(note);
            }
            temp_paths.extend(resolved_patch_cleanup_paths);
            resolved_patches.push((patch_path.clone(), resolved_patch_source));
        }

        let report = (|| {
            if patches.is_empty() {
                return OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "at least one --patch value is required",
                    probe_threads.clone(),
                );
            }

            let mut stripped_header = None;
            let mut stripped_header_match = None;
            let mut checksum_verification_labels = Vec::new();
            let apply_input = if strip_header {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "prepare",
                    "stripping ROM header before patch apply",
                    None,
                    None,
                );
                let stripped_path = context
                    .temp_paths()
                    .next_path("patch-apply-input-noheader", Some("bin"));
                match Self::strip_header_to_temp(&resolved_input, &stripped_path) {
                    Ok(result) => {
                        stripped_header = Some(result.header_bytes);
                        stripped_header_match = result.matched_header;
                        temp_paths.push(stripped_path.clone());
                        stripped_path
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            } else {
                resolved_input.clone()
            };
            if !expected_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "validate",
                    format!(
                        "validating {} requested input checksum(s)",
                        expected_input_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &apply_input,
                    &expected_input_checksums,
                    &cached_input_checksums,
                    "input",
                    &context,
                ) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            let patch_count = resolved_patches.len();
            let requires_compat_finalize = add_header || repair_checksum || patch_count > 1;
            let needs_staged_output = requires_compat_finalize || compression_options.enabled;
            let staged_output = if needs_staged_output {
                if compression_options.enabled {
                    match Self::patch_apply_raw_output_path(
                        &output,
                        &resolved_input,
                        &context,
                        "patch-apply-output-staged",
                        &mut temp_paths,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                None,
                                "prepare",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    }
                } else {
                    let staged_path = context
                        .temp_paths()
                        .next_path("patch-apply-output-staged", Some("bin"));
                    temp_paths.push(staged_path.clone());
                    staged_path
                }
            } else {
                output.clone()
            };
            let mut terminal_output_path = output.clone();

            let mut current_input = apply_input;
            let mut applied_formats = Vec::with_capacity(patch_count);
            let mut report = OperationReport::failed(
                OperationFamily::Patch,
                None,
                "apply",
                "patch apply was not executed",
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );

            for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
                let Some(handler) = self.patches.probe(resolved_patch_path) else {
                    let patch_label = if patch_path == resolved_patch_path {
                        format!("`{}`", patch_path.display())
                    } else {
                        format!(
                            "`{}` (resolved from `{}`)",
                            resolved_patch_path.display(),
                            patch_path.display()
                        )
                    };
                    let unsupported_reason =
                        explicitly_unsupported_patch_reason_for_path(resolved_patch_path);
                    let (format_name, label) = match unsupported_reason {
                        Some(reason) => (
                            Some("PDS".to_string()),
                            format!(
                                "patch {}/{}: {} is explicitly not supported: {reason}",
                                index + 1,
                                patch_count,
                                patch_label
                            ),
                        ),
                        None => (
                            None,
                            format!(
                                "patch {}/{}: no registered patch handler matched {}",
                                index + 1,
                                patch_count,
                                patch_label
                            ),
                        ),
                    };
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        format_name,
                        "probe",
                        label,
                        probe_threads.clone(),
                    );
                };
                applied_formats.push(handler.descriptor().name);
                let patch_start_percent = patch_progress_segment_start(index, patch_count);

                let is_last = index + 1 == patch_count;
                let apply_output = if is_last {
                    staged_output.clone()
                } else {
                    let intermediate_output = context
                        .temp_paths()
                        .next_path("patch-apply-output-step", Some("bin"));
                    temp_paths.push(intermediate_output.clone());
                    intermediate_output
                };
                if let Some(parent) = apply_output.parent()
                    && !parent.exists()
                    && let Err(error) = fs::create_dir_all(parent)
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "prepare",
                        format!(
                            "failed to prepare output path `{}`: {error}",
                            apply_output.display()
                        ),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }

                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: Some(handler.descriptor().name),
                    },
                    "apply",
                    if patch_count == 1 {
                        format!("applying patch using {}", handler.descriptor().name)
                    } else {
                        format!(
                            "applying patch {}/{} using {} (`{}`)",
                            index + 1,
                            patch_count,
                            handler.descriptor().name,
                            patch_path.display()
                        )
                    },
                    Some(patch_start_percent),
                    None,
                );

                let request = PatchApplyRequest {
                    input: current_input,
                    patches: vec![resolved_patch_path.clone()],
                    output: apply_output.clone(),
                };
                let progress_tracker = Arc::new(PatchApplyProgressTracker::default());
                let patch_context =
                    context
                        .clone()
                        .with_progress_sink(Arc::new(PatchApplyProgressSink::new(
                            context.progress_sink(),
                            index,
                            patch_count,
                            progress_tracker.clone(),
                        )));
                report = match handler.apply(&request, &patch_context) {
                    Ok(report) => report,
                    Err(RomWeaverError::Unsupported(label)) => OperationReport::unsupported(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "apply",
                        label,
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    ),
                    Err(error) => OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "apply",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    ),
                };
                if report.status != OperationStatus::Succeeded {
                    if patch_count > 1 {
                        report.label = format!(
                            "patch {}/{} (`{}`): {}",
                            index + 1,
                            patch_count,
                            patch_path.display(),
                            report.label
                        );
                    }
                    return report;
                }
                if !progress_tracker.saw_meaningful_running_progress() {
                    self.emit_running(
                        OperationLabel {
                            command: "patch-apply",
                            family: OperationFamily::Patch,
                            format: Some(handler.descriptor().name),
                        },
                        "apply",
                        if patch_count == 1 {
                            format!("applied patch using {}", handler.descriptor().name)
                        } else {
                            format!(
                                "applied patch {}/{} using {} (`{}`)",
                                index + 1,
                                patch_count,
                                handler.descriptor().name,
                                patch_path.display()
                            )
                        },
                        None,
                        report.thread_execution.clone(),
                    );
                }

                current_input = apply_output;
            }

            let mut raw_ready_output = staged_output.clone();
            if report.status == OperationStatus::Succeeded && requires_compat_finalize {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: applied_formats.last().copied(),
                    },
                    "compat",
                    if add_header || repair_checksum {
                        "finalizing compatibility output transforms"
                    } else {
                        "finalizing multi-patch output"
                    },
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                let finalized_output_path = if compression_options.enabled {
                    match Self::patch_apply_raw_output_path(
                        &output,
                        &resolved_input,
                        &context,
                        "patch-apply-output-raw-final",
                        &mut temp_paths,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                report.format.clone(),
                                "prepare",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    }
                } else {
                    output.clone()
                };
                match Self::finalize_patch_apply_output(
                    &staged_output,
                    &finalized_output_path,
                    add_header,
                    stripped_header.as_deref(),
                    repair_checksum,
                    Some(&resolved_input),
                ) {
                    Ok(finalized) => {
                        raw_ready_output = finalized_output_path;
                        if finalized.repaired_profiles.len() == 1 {
                            report.label = format!(
                                "{}; repaired checksum ({})",
                                report.label, finalized.repaired_profiles[0]
                            );
                        } else if !finalized.repaired_profiles.is_empty() {
                            report.label = format!(
                                "{}; repaired headers ({})",
                                report.label,
                                finalized.repaired_profiles.join(", ")
                            );
                        }
                        if let Some(repair_warning) = finalized.repair_warning {
                            report.label = format!("{}; warning={repair_warning}", report.label);
                        }
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compat",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            if patch_count > 1 {
                report.label = format!(
                    "applied {patch_count} patches sequentially ({}); {}",
                    applied_formats.join(" -> "),
                    report.label
                );
            }
            if strip_header {
                if let Some(header_match) = stripped_header_match {
                    report.label = format!(
                        "{}; input header stripped ({} bytes, {})",
                        report.label,
                        header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES),
                        header_match.profile_name()
                    );
                } else {
                    report.label = format!(
                        "{}; input header stripped ({} bytes)",
                        report.label, ROM_HEADER_BYTES
                    );
                }
            }
            if extracted_archives > 0 {
                report.label = format!(
                    "{}; patch apply input source resolved via {extracted_archives} container extract step(s)",
                    report.label
                );
            }
            if !extracted_patch_notes.is_empty() {
                report.label = format!("{}; {}", report.label, extracted_patch_notes.join("; "));
            }
            if report.status == OperationStatus::Succeeded && !expected_output_checksums.is_empty()
            {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: report.format.as_deref(),
                    },
                    "validate",
                    format!(
                        "validating {} requested output checksum(s)",
                        expected_output_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &raw_ready_output,
                    &expected_output_checksums,
                    &BTreeMap::new(),
                    "output",
                    &context,
                ) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "validate",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }

            if !checksum_verification_labels.is_empty() {
                report.label = format!(
                    "{}; {}",
                    report.label,
                    checksum_verification_labels.join("; ")
                );
            }

            if report.status == OperationStatus::Succeeded && compression_options.enabled {
                let compression_plan = match self.resolve_patch_apply_compression_plan(
                    &output,
                    &resolved_input,
                    &compression_options,
                ) {
                    Ok(plan) => plan,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compress",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                };
                let Some(compress_handler) = self.containers.find_by_name(&compression_plan.format)
                else {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        "requested output format is not registered",
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                };
                let archive_input = match Self::stage_patch_apply_archive_input(
                    &raw_ready_output,
                    &output,
                    &resolved_input,
                ) {
                    Ok(path) => path,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compress",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                };
                let compress_threads =
                    Some(context.plan_threads(compress_handler.capabilities().create_threads));
                let codec_label = compression_plan
                    .codec
                    .as_deref()
                    .unwrap_or("default")
                    .to_string();
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: Some(compression_plan.format.as_str()),
                    },
                    "compress",
                    format!(
                        "compressing patched output as {} (codec={codec_label})",
                        compression_plan.format
                    ),
                    Some(0.0),
                    compress_threads,
                );
                let compress_request = ContainerCreateRequest {
                    inputs: vec![archive_input],
                    output: compression_plan.output_path.clone(),
                    format: compression_plan.format.clone(),
                    codec: compression_plan.codec.clone(),
                    level: compression_plan.level,
                    parent: None,
                };
                let compress_report = compress_handler
                    .create(&compress_request, &context)
                    .unwrap_or_else(|error| {
                        OperationReport::failed(
                            OperationFamily::Container,
                            Some(compress_handler.descriptor().name.to_string()),
                            "create",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        )
                    });
                if compress_report.status != OperationStatus::Succeeded {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        format!("patch output compression failed: {}", compress_report.label),
                        compress_report.thread_execution,
                    );
                }
                let extension_note = if compression_plan.extension_appended {
                    "; output extension appended to match container format"
                } else {
                    ""
                };
                let warning_note = compression_plan
                    .warning
                    .as_deref()
                    .map(|warning| format!("; warning: {warning}"))
                    .unwrap_or_default();
                report.stage = "compress".to_string();
                report.label = format!(
                    "{}; patch output compressed as {} (codec={}, path=`{}`; {}){}{}",
                    report.label,
                    compression_plan.format,
                    codec_label,
                    compression_plan.output_path.display(),
                    compression_plan.note,
                    extension_note,
                    warning_note
                );
                terminal_output_path = compression_plan.output_path;
            }

            if report.status == OperationStatus::Succeeded {
                let kind_hint = if compression_options.enabled {
                    Some("archive")
                } else {
                    None
                };
                report = Self::attach_emitted_files_details(
                    report,
                    vec![terminal_output_path],
                    kind_hint,
                );
            }

            report
        })();

        Self::cleanup_temp_paths(temp_paths);
        self.finish("patch-apply", report)
    }
}
