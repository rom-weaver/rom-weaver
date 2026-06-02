/* jscpd:ignore-start */
impl CliApp {
    fn run_patch_apply(&self, args: PatchApplyCommand) -> AppRunOutcome {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
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
            threads = %args.threads,
            "starting patch-apply command"
        );
        let PatchApplyCommand {
            input,
            select,
            no_extract,
            no_ignore,
            patches,
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
            threads,
        } = args;
        let context =
            self.context(threads)
                .with_patch_checksum_validation(if ignore_checksum_validation {
                    PatchChecksumValidation::Ignore
                } else {
                    PatchChecksumValidation::Strict
                });
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
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
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
            no_extract,
            no_ignore,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch apply input",
                temp_prefix: "patch-apply-input-extract",
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
        let outer_container_format = if compression_options.enabled && compression_options.auto_mode
        {
            self.detect_patch_apply_outer_container_format(&input, &context)
        } else {
            None
        };
        let mut temp_paths = cleanup_paths;
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
                no_extract,
                no_ignore,
                &context,
                AutoExtractResolutionLabels {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: None,
                    source_label: patch_source_label.as_str(),
                    temp_prefix: "patch-apply-patch-extract",
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
            if !cached_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "prepare",
                    format!(
                        "seeding {} requested input checksum cache value(s)",
                        cached_input_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                if let Err(error) =
                    seed_checksum_file_cache(&apply_input, &cached_input_checksums, &context)
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }
            }
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
                let staged_path = context
                    .temp_paths()
                    .next_path("patch-apply-output-staged", Some("bin"));
                temp_paths.push(staged_path.clone());
                staged_path
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
                let patch_completion_percent = patch_progress_completion_percent(index, patch_count);

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
                let patch_context = context.clone().with_progress_sink(Arc::new(
                    PatchApplyProgressSink::new(
                        context.progress_sink(),
                        index,
                        patch_count,
                        progress_tracker.clone(),
                    ),
                ));
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
                        Some(patch_completion_percent),
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
                    let raw_path = context
                        .temp_paths()
                        .next_path("patch-apply-output-raw-final", Some("bin"));
                    temp_paths.push(raw_path.clone());
                    raw_path
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
                    &raw_ready_output,
                    &resolved_input,
                    outer_container_format.as_deref(),
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
                    inputs: vec![raw_ready_output],
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
                report.stage = "compress".to_string();
                report.label = format!(
                    "{}; patch output compressed as {} (codec={}, path=`{}`; {}){}",
                    report.label,
                    compression_plan.format,
                    codec_label,
                    compression_plan.output_path.display(),
                    compression_plan.auto_note,
                    extension_note
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

    fn run_patch_validate(&self, args: PatchValidateCommand) -> AppRunOutcome {
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
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
            no_extract,
            no_ignore,
            &context,
            AutoExtractResolutionLabels {
                command: "patch-validate",
                family: OperationFamily::Patch,
                format: None,
                source_label: "patch validate input",
                temp_prefix: "patch-validate-input-extract",
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
                format!("patch validate patch {}/{} source", index + 1, patches.len())
            };
            let resolved_patch = match self.resolve_source_with_auto_extract(
                patch_path,
                &select,
                no_extract,
                no_ignore,
                &context,
                AutoExtractResolutionLabels {
                    command: "patch-validate",
                    family: OperationFamily::Patch,
                    format: None,
                    source_label: patch_source_label.as_str(),
                    temp_prefix: "patch-validate-patch-extract",
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
            if !cached_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-validate",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "prepare",
                    format!(
                        "seeding {} requested input checksum cache value(s)",
                        cached_input_checksums.len()
                    ),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                if let Err(error) =
                    seed_checksum_file_cache(&validate_input, &cached_input_checksums, &context)
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "prepare",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
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
                        report.thread_execution
                            .or_else(|| Some(context.plan_threads(ThreadCapability::single_threaded()))),
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
                        Some(patch_progress_completion_percent(index, patch_count)),
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

    fn run_patch_create(&self, args: PatchCreateCommand) -> AppRunOutcome {
        trace!(
            original = %args.original.display(),
            modified = %args.modified.display(),
            output = %args.output.display(),
            format = %args.format,
            ignore_checksum_validation = args.ignore_checksum_validation,
            threads = %args.threads,
            xdelta_secondary = %args.xdelta_secondary,
            "starting patch-create command"
        );
        let base_context = self.context(args.threads);
        let probe_threads = Some(base_context.plan_threads(ThreadCapability::single_threaded()));
        let xdelta_secondary_mode = match args.xdelta_secondary.parse::<XdeltaSecondaryMode>() {
            Ok(mode) => mode,
            Err(error) => {
                return self.finish(
                    "patch-create",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some(args.format.clone()),
                        "validate",
                        error.to_string(),
                        probe_threads.clone(),
                    ),
                );
            }
        };
        let context = base_context
            .with_patch_checksum_validation(if args.ignore_checksum_validation {
                PatchChecksumValidation::Ignore
            } else {
                PatchChecksumValidation::Strict
            })
            .with_xdelta_secondary_mode(xdelta_secondary_mode);
        if let Some(report) = self.require_existing_path(
            "patch-create",
            OperationFamily::Patch,
            Some(args.format.clone()),
            &args.original,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create", report);
        }
        if let Some(report) = self.require_existing_path(
            "patch-create",
            OperationFamily::Patch,
            Some(args.format.clone()),
            &args.modified,
            probe_threads.clone(),
        ) {
            return self.finish("patch-create", report);
        }

        let requested_format = args.format;
        let Some(handler) = self.patches.find_by_name(&requested_format) else {
            let label = explicitly_unsupported_patch_reason_for_name(&requested_format)
                .map(|reason| {
                    format!(
                        "requested patch format `{requested_format}` is explicitly not supported: {reason}"
                    )
                })
                .unwrap_or_else(|| "requested patch format is not registered".to_string());
            return self.finish(
                "patch-create",
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(requested_format),
                    "probe",
                    label,
                    probe_threads,
                ),
            );
        };

        let request = PatchCreateRequest {
            original: args.original,
            modified: args.modified,
            output: args.output,
            format: handler.descriptor().name.to_string(),
        };
        self.emit_running(
            OperationLabel {
                command: "patch-create",
                family: OperationFamily::Patch,
                format: Some(handler.descriptor().name),
            },
            "create",
            format!("creating {} patch", handler.descriptor().name),
            Some(0.0),
            None,
        );
        let report = match handler.create(&request, &context) {
            Ok(report) => report,
            Err(RomWeaverError::Unsupported(label)) => OperationReport::unsupported(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "create",
                label,
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            ),
            Err(error) => OperationReport::failed(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "create",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            ),
        };
        self.finish("patch-create", report)
    }

    fn parse_patch_apply_checksum_values(
        values: &[String],
        flag_name: &str,
    ) -> Result<BTreeMap<String, String>> {
        let mut parsed = BTreeMap::new();
        for raw in values {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value cannot be empty; expected ALGO=HEX"
                )));
            }
            let (algorithm_raw, checksum_raw) = trimmed.split_once('=').ok_or_else(|| {
                RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; expected ALGO=HEX"
                ))
            })?;

            let algorithm = algorithm_raw.trim().to_ascii_lowercase();
            if algorithm.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum algorithm is missing before `=`"
                )));
            }
            if !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(&algorithm))
            {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} uses unsupported checksum algorithm `{}`",
                    algorithm_raw.trim()
                )));
            }

            let checksum = checksum_raw.trim();
            if checksum.is_empty() {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum value is missing after `=`"
                )));
            }
            let checksum = checksum
                .strip_prefix("0x")
                .or_else(|| checksum.strip_prefix("0X"))
                .unwrap_or(checksum)
                .to_ascii_lowercase();
            if !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; checksum must be hexadecimal"
                )));
            }
            let Some(expected_hex_len) = Self::checksum_hex_len(&algorithm) else {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} uses unsupported checksum algorithm `{}`",
                    algorithm_raw.trim()
                )));
            };
            if checksum.len() != expected_hex_len {
                return Err(RomWeaverError::Validation(format!(
                    "{flag_name} value `{trimmed}` is invalid; `{}` expects {expected_hex_len} hex characters, got {}",
                    algorithm,
                    checksum.len()
                )));
            }

            match parsed.get(&algorithm) {
                Some(existing) if existing != &checksum => {
                    return Err(RomWeaverError::Validation(format!(
                        "{flag_name} provides conflicting values for `{algorithm}`"
                    )));
                }
                Some(_) => {}
                None => {
                    parsed.insert(algorithm, checksum);
                }
            }
        }
        Ok(parsed)
    }

    fn validate_patch_apply_expected_checksums(
        source: &Path,
        expected: &BTreeMap<String, String>,
        scope: &str,
        context: &OperationContext,
    ) -> Result<String> {
        if expected.is_empty() {
            return Ok(String::new());
        }

        let algorithms = expected.keys().map(String::as_str).collect::<Vec<&str>>();
        let actual = checksum_file_values(source, &algorithms, context)?;
        for (algorithm, expected_value) in expected {
            let Some(actual_value) = actual.get(algorithm) else {
                return Err(RomWeaverError::Validation(format!(
                    "checksum engine did not return `{algorithm}` while validating {scope} checksums"
                )));
            };
            if actual_value != expected_value {
                return Err(RomWeaverError::Validation(format!(
                    "{scope} checksum mismatch for {algorithm}; expected {expected_value}, actual {actual_value}"
                )));
            }
        }

        let rendered = expected
            .iter()
            .map(|(algorithm, value)| format!("{algorithm}={value}"))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!("{scope} checksum(s) verified ({rendered})"))
    }

    fn validate_patch_input_size(
        source: &Path,
        expected_size: Option<u64>,
        minimum_size: Option<u64>,
    ) -> Result<String> {
        let actual_size = fs::metadata(source)?.len();
        if let Some(expected) = expected_size
            && actual_size != expected
        {
            return Err(RomWeaverError::Validation(format!(
                "input size mismatch; expected {expected} byte(s), actual {actual_size}"
            )));
        }
        if let Some(minimum) = minimum_size
            && actual_size < minimum
        {
            return Err(RomWeaverError::Validation(format!(
                "input size is below required minimum; expected at least {minimum} byte(s), actual {actual_size}"
            )));
        }

        let mut labels = Vec::new();
        if let Some(expected) = expected_size {
            labels.push(format!("size={expected}"));
        }
        if let Some(minimum) = minimum_size {
            labels.push(format!("min_size={minimum}"));
        }
        if labels.is_empty() {
            Ok(format!("input size verified ({actual_size} byte(s))"))
        } else {
            Ok(format!("input size verified ({})", labels.join(", ")))
        }
    }

    fn checksum_hex_len(algorithm: &str) -> Option<usize> {
        match algorithm {
            "crc16" => Some(4),
            "crc32" | "crc32c" | "adler32" => Some(8),
            "md5" => Some(32),
            "sha1" => Some(40),
            "sha256" | "blake3" => Some(64),
            _ => None,
        }
    }
}

#[derive(Debug, Default)]
struct PatchApplyProgressTracker {
    saw_meaningful_running_progress: std::sync::atomic::AtomicBool,
}

impl PatchApplyProgressTracker {
    fn mark_meaningful_running_progress(&self) {
        self.saw_meaningful_running_progress
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn saw_meaningful_running_progress(&self) -> bool {
        self.saw_meaningful_running_progress
            .load(std::sync::atomic::Ordering::Relaxed)
    }
}

struct PatchApplyProgressSink {
    inner: Arc<dyn ProgressSink>,
    output_command: &'static str,
    output_stage: &'static str,
    segment_start_percent: f32,
    segment_end_percent: f32,
    tracker: Arc<PatchApplyProgressTracker>,
}

impl PatchApplyProgressSink {
    fn new(
        inner: Arc<dyn ProgressSink>,
        patch_index: usize,
        patch_count: usize,
        tracker: Arc<PatchApplyProgressTracker>,
    ) -> Self {
        Self::new_for_command(inner, patch_index, patch_count, tracker, "patch-apply", "apply")
    }

    fn new_for_command(
        inner: Arc<dyn ProgressSink>,
        patch_index: usize,
        patch_count: usize,
        tracker: Arc<PatchApplyProgressTracker>,
        output_command: &'static str,
        output_stage: &'static str,
    ) -> Self {
        Self {
            inner,
            output_command,
            output_stage,
            segment_start_percent: patch_progress_segment_start(patch_index, patch_count),
            segment_end_percent: patch_progress_segment_end(patch_index, patch_count),
            tracker,
        }
    }
}

impl ProgressSink for PatchApplyProgressSink {
    fn emit(&self, mut event: ProgressEvent) {
        if event.command == "patch-apply" && event.status == OperationStatus::Running && event.stage == "apply" {
            event.command = self.output_command.to_string();
            event.stage = self.output_stage.to_string();
            if let Some(percent) = event.percent
                && percent.is_finite()
            {
                let clamped = percent.clamp(0.0, 100.0);
                let scaled = if self.segment_end_percent > self.segment_start_percent {
                    self.segment_start_percent
                        + (clamped / 100.0) * (self.segment_end_percent - self.segment_start_percent)
                } else {
                    self.segment_end_percent
                };
                if scaled > self.segment_start_percent {
                    self.tracker.mark_meaningful_running_progress();
                }
                event.percent = Some(scaled);
            } else {
                self.tracker.mark_meaningful_running_progress();
            }
        }
        self.inner.emit(event);
    }
}

fn patch_progress_segment_start(index: usize, patch_count: usize) -> f32 {
    if patch_count <= 1 {
        0.0
    } else {
        ((index as f32) * 100.0) / (patch_count as f32)
    }
}

fn patch_progress_segment_end(index: usize, patch_count: usize) -> f32 {
    if patch_count <= 1 {
        100.0
    } else {
        (((index + 1) as f32) * 100.0) / (patch_count as f32)
    }
}

fn patch_progress_completion_percent(index: usize, patch_count: usize) -> f32 {
    let start = patch_progress_segment_start(index, patch_count);
    let end = patch_progress_segment_end(index, patch_count);
    let span = (end - start).max(0.0);
    if span <= f32::EPSILON {
        return end.min(99.9);
    }

    let completion = (start + span * 0.99).min(end);
    if completion > start {
        completion
    } else {
        (start + span * 0.5).min(end)
    }
}
/* jscpd:ignore-end */
