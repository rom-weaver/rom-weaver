use super::*;

use super::patch_commands::{
    PatchApplyProgressSink, PatchApplyProgressTracker, patch_progress_segment_start,
};

impl CliApp {
    pub(super) fn run_patch_validate(&self, args: PatchValidateCommand) -> AppRunOutcome {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            patch_count = args.patches.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            checksum_cache = args.checksum_cache.len(),
            validate_with_checksums = args.validate_with_checksums.len(),
            validate_with_size = ?args.validate_with_size,
            validate_with_min_size = ?args.validate_with_min_size,
            strip_header = args.strip_header,
            ignore_checksum_validation = args.ignore_checksum_validation,
            threads = %args.threads,
            "starting patch-validate command"
        );
        let PatchValidateCommand {
            input,
            select,
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
            patches,
            checksum_cache,
            validate_with_checksums,
            validate_with_size,
            validate_with_min_size,
            strip_header,
            ignore_checksum_validation,
            threads,
        } = args;
        let input_kind_filter = Self::archive_entry_kind_filter(rom_filter, false);
        let patch_kind_filter = Self::archive_entry_kind_filter(false, patch_filter);
        let context =
            self.context(threads)
                .with_patch_checksum_validation(if ignore_checksum_validation {
                    PatchChecksumValidation::Ignore
                } else {
                    PatchChecksumValidation::Strict
                });
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let cached_input_checksums =
            match Self::parse_patch_apply_checksum_values(&checksum_cache, "--checksum-cache") {
                Ok(values) => values,
                Err(error) => {
                    return self.finish(
                        "patch-validate",
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
                    "patch-validate",
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
            "patch-validate",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-validate", report);
        }
        for patch_path in &patches {
            if let Some(report) = self.require_existing_path(
                "patch-validate",
                OperationFamily::Patch,
                None,
                patch_path,
                probe_threads.clone(),
            ) {
                return self.finish("patch-validate", report);
            }
        }

        let resolved_input = match self.resolve_source_with_auto_extract(
            &input,
            &select,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-validate",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch validate input",
                temp_prefix: "patch-validate-input-extract",
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
                    "patch-validate",
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
        let mut resolved_patches = Vec::with_capacity(patches.len());
        let mut extracted_patch_notes = Vec::new();
        for (index, patch_path) in patches.iter().enumerate() {
            let patch_source_label = if patches.len() == 1 {
                "patch validate patch source".to_string()
            } else {
                format!(
                    "patch validate patch {}/{} source",
                    index + 1,
                    patches.len()
                )
            };
            let resolved_patch = match self.resolve_source_with_auto_extract(
                patch_path,
                &select,
                &context,
                AutoExtractResolutionLabels {
                    command: "patch-validate",
                    family: OperationFamily::Patch,
                    format: None,
                    source_label: patch_source_label.as_str(),
                    temp_prefix: "patch-validate-patch-extract",
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
                        "patch-validate",
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
                        "patch validate patch source resolved via {} container extract step(s)",
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

            let mut validation_labels = Vec::new();
            let validate_input = if strip_header {
                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "prepare",
                    "stripping ROM header before patch validation",
                    None,
                    None,
                );
                let stripped_path = context
                    .temp_paths()
                    .next_path("patch-validate-input-noheader", Some("bin"));
                match Self::strip_header_to_temp(&resolved_input, &stripped_path) {
                    Ok(_result) => {
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
            if validate_with_size.is_some() || validate_with_min_size.is_some() {
                match Self::validate_patch_input_size(
                    &validate_input,
                    validate_with_size,
                    validate_with_min_size,
                ) {
                    Ok(label) => validation_labels.push(label),
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
            if !expected_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
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
                    &validate_input,
                    &expected_input_checksums,
                    &cached_input_checksums,
                    "input",
                    &context,
                ) {
                    Ok(label) => validation_labels.push(label),
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
            let mut current_input = validate_input;
            let mut formats = Vec::with_capacity(patch_count);
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
                if !handler.capabilities().apply {
                    return OperationReport::unsupported(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "validate",
                        format!(
                            "{} does not support dry-run validation",
                            handler.descriptor().name
                        ),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }
                formats.push(handler.descriptor().name.to_string());

                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: Some(handler.descriptor().name),
                    },
                    "validate",
                    if patch_count == 1 {
                        format!("validating patch using {}", handler.descriptor().name)
                    } else {
                        format!(
                            "validating patch {}/{} using {} (`{}`)",
                            index + 1,
                            patch_count,
                            handler.descriptor().name,
                            patch_path.display()
                        )
                    },
                    Some(patch_progress_segment_start(index, patch_count)),
                    None,
                );

                let progress_tracker = Arc::new(PatchApplyProgressTracker::default());
                let patch_context = context.clone().with_progress_sink(Arc::new(
                    PatchApplyProgressSink::new_for_command(
                        context.progress_sink(),
                        index,
                        patch_count,
                        progress_tracker.clone(),
                        "patch-validate",
                        "validate",
                    ),
                ));

                let mut validate_output = None;
                let report = if patch_count == 1 {
                    let request = PatchValidateRequest {
                        input: current_input.clone(),
                        patches: vec![resolved_patch_path.clone()],
                    };
                    match handler.validate(&request, &patch_context) {
                        Ok(report) => report,
                        Err(RomWeaverError::Unsupported(label)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                label,
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    }
                } else {
                    let output = context
                        .temp_paths()
                        .next_path("patch-validate-output-step", Some("bin"));
                    temp_paths.push(output.clone());
                    if let Some(parent) = output.parent()
                        && !parent.exists()
                        && let Err(error) = fs::create_dir_all(parent)
                    {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            Some(handler.descriptor().name.to_string()),
                            "prepare",
                            format!(
                                "failed to prepare validation output path `{}`: {error}",
                                output.display()
                            ),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }

                    let request = PatchApplyRequest {
                        input: current_input.clone(),
                        patches: vec![resolved_patch_path.clone()],
                        output: output.clone(),
                    };
                    let report = match handler.apply(&request, &patch_context) {
                        Ok(report) => report,
                        Err(RomWeaverError::Unsupported(label)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                label,
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                Some(context.plan_threads(ThreadCapability::single_threaded())),
                            );
                        }
                    };
                    validate_output = Some(output);
                    report
                };
                if report.status != OperationStatus::Succeeded {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "validate",
                        report.label,
                        report.thread_execution.or_else(|| {
                            Some(context.plan_threads(ThreadCapability::single_threaded()))
                        }),
                    );
                }
                if !progress_tracker.saw_meaningful_running_progress() {
                    self.emit_running(
                        OperationLabel {
                            command: "patch-validate",
                            family: OperationFamily::Patch,
                            format: Some(handler.descriptor().name),
                        },
                        "validate",
                        if patch_count == 1 {
                            format!("validated patch using {}", handler.descriptor().name)
                        } else {
                            format!(
                                "validated patch {}/{} using {} (`{}`)",
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
                if let Some(output) = validate_output {
                    current_input = output;
                }
            }

            if extracted_archives > 0 {
                validation_labels.push(format!(
                    "input resolved via {extracted_archives} container extract step(s)"
                ));
            }
            validation_labels.extend(extracted_patch_notes);
            let format_label = if formats.is_empty() {
                "patch".to_string()
            } else {
                formats.join(", ")
            };
            let suffix = if validation_labels.is_empty() {
                String::new()
            } else {
                format!("; {}", validation_labels.join("; "))
            };
            let final_format = formats.last().cloned();
            let mut report = OperationReport::succeeded(
                OperationFamily::Patch,
                final_format.clone(),
                "validate",
                format!(
                    "patch validation passed for {} patch(es) ({format_label}){suffix}",
                    patch_count
                ),
                Some(100.0),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            report.details = Some(json!({
                "patch_validation": {
                    "dry_run": true,
                    "format": final_format,
                    "formats": formats,
                    "patch_count": patch_count,
                    "source_values": {
                        "minimum_size": validate_with_min_size,
                        "size": validate_with_size,
                        "checksums": expected_input_checksums,
                    },
                    "status": "passed",
                }
            }));
            report
        })();

        Self::cleanup_temp_paths(temp_paths);
        self.finish("patch-validate", report)
    }
}
