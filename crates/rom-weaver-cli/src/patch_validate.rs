use super::*;

use rayon::prelude::*;

use super::patch_commands::{
    PatchApplyProgressSink, PatchApplyProgressTracker, patch_progress_segment_start,
};

impl CliApp {
    pub(super) fn run_patch_validate(&self, args: PatchValidateCommand) -> AppRunOutcome {
        let rom_filter = args.rom_filter();
        let patch_filter = args.patch_filter();
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            rom_filter,
            patch_filter,
            patch_count = args.patches.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            assume_in = args.assume_in.len(),
            expect_in = args.expect_in.len(),
            strip_header = args.strip_header,
            n64_byte_order = ?args.n64_byte_order,
            ignore_checksum_validation = args.ignore_checksum_validation,
            independent = args.independent,
            plan = args.plan,
            patch_basis = args.patch_basis.len(),
            patch_input_checks = args.patch_input_check.len(),
            patch_output_checks = args.patch_output_check.len(),
            threads = %args.threads,
            "starting patch-validate command"
        );
        let PatchValidateCommand {
            input,
            select,
            filter: _,
            no_extract,
            no_ignore,
            patches,
            assume_in,
            expect_in,
            strip_header,
            n64_byte_order,
            ignore_checksum_validation,
            independent,
            plan,
            patch_basis,
            patch_input_check,
            patch_output_check,
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
        let probe_threads = context.single_thread_execution();
        let fail = |stage: &str, message: String| {
            OperationReport::failed(
                OperationFamily::Patch,
                None,
                stage,
                message,
                probe_threads.clone(),
            )
        };
        let cached_input_checksums = match parse_expect_tokens(&assume_in, "--assume-in", false) {
            Ok(spec) => spec.checksums,
            Err(error) => {
                return self.finish("patch-validate", fail("validate", error.to_string()));
            }
        };
        let n64_byte_order = n64_byte_order.unwrap_or_default();
        let expect_spec = match parse_expect_tokens(&expect_in, "--expect-in", true) {
            Ok(spec) => spec,
            Err(error) => {
                return self.finish("patch-validate", fail("validate", error.to_string()));
            }
        };
        let mut expected_input_checksums = expect_spec.checksums;
        let mut effective_expected_size = expect_spec.size;
        let validate_with_min_size = expect_spec.min_size;
        // Plan mode routes every patch's filename requirements through the
        // planner as per-patch declared checks instead of folding the first
        // patch's into the hard input gate.
        if !ignore_checksum_validation
            && !plan
            && let Some(first_patch) = patches.first()
            && let Some(patch_name) = first_patch.file_name().and_then(|name| name.to_str())
            && let Some(report) = self.merge_filename_requirements(
                "patch-validate",
                first_patch,
                patch_name,
                &mut expected_input_checksums,
                &mut effective_expected_size,
                probe_threads.clone(),
            )
        {
            return self.finish("patch-validate", report);
        }
        if let Some(report) = self.require_readable_path(
            "patch-validate",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-validate", report);
        }
        for patch_path in &patches {
            if let Some(report) = self.require_readable_path(
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
                stop_on_disc_image_codec: false,
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish("patch-validate", fail("prepare", error.to_string()));
            }
        };
        let ResolvedChecksumSource {
            source: resolved_input,
            extracted_archives,
            cleanup_paths,
        } = resolved_input;
        // Reuse the host-provided input checksums (the CRC32 the webapp already computed during
        // staging) for the handler's source-checksum verification - preflight otherwise
        // re-reads the whole input just to re-derive a CRC32 we already have.
        context.seed_checksums(&resolved_input, &cached_input_checksums);
        let mut temp_paths = cleanup_paths;
        let (resolved_patches, extracted_patch_notes) = match self.resolve_patches(
            &patches,
            &select,
            &context,
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter: patch_kind_filter,
                stop_on_disc_image_codec: false,
            },
            PatchResolveLabels {
                command: "patch-validate",
                noun: "patch validate",
                temp_prefix: "patch-validate-patch-extract",
            },
            &mut temp_paths,
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish("patch-validate", fail("prepare", error.to_string()));
            }
        };

        let report = (|| {
            if patches.is_empty() {
                return fail(
                    "validate",
                    "at least one --patch value is required".to_string(),
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
                            context.single_thread_execution(),
                        );
                    }
                }
            } else {
                resolved_input.clone()
            };
            let mut n64_order = None;
            let validate_input = match self.resolve_patch_n64_target(
                &validate_input,
                resolved_patches.first().map(|(_, patch)| patch.as_path()),
                expected_input_checksums.get("crc32").map(String::as_str),
                n64_byte_order,
                &context,
            ) {
                Ok(Some((source_order, target_order))) => {
                    n64_order = Some(N64ByteOrderTransform {
                        from: target_order,
                        to: source_order,
                    });
                    if source_order == target_order {
                        validate_input
                    } else {
                        self.emit_running(
                            OperationLabel {
                                command: "patch-validate",
                                family: OperationFamily::Patch,
                                format: None,
                            },
                            "compat",
                            format!(
                                "transforming N64 input byte order to {}",
                                target_order.label()
                            ),
                            None,
                            context.single_thread_execution(),
                        );
                        let transformed_path = context
                            .temp_paths()
                            .next_path("patch-validate-input-n64-byte-order", Some("bin"));
                        if let Err(error) = Self::rewrite_n64_byte_order(
                            &validate_input,
                            &transformed_path,
                            source_order,
                            target_order,
                        ) {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                None,
                                "compat",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                        temp_paths.push(transformed_path.clone());
                        transformed_path
                    }
                }
                Ok(None) => validate_input,
                Err(error) => {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "compat",
                        error.to_string(),
                        context.single_thread_execution(),
                    );
                }
            };
            let transformed_checksum_hints = BTreeMap::new();
            let effective_checksum_hints = if validate_input == resolved_input {
                &cached_input_checksums
            } else {
                &transformed_checksum_hints
            };
            if effective_expected_size.is_some() || validate_with_min_size.is_some() {
                match Self::validate_patch_input_size(
                    &validate_input,
                    effective_expected_size,
                    validate_with_min_size,
                ) {
                    Ok(label) => validation_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
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
                    context.single_thread_execution(),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &validate_input,
                    &expected_input_checksums,
                    effective_checksum_hints,
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
                            context.single_thread_execution(),
                        );
                    }
                }
            }

            if plan {
                return self.run_patch_validate_plan(
                    &resolved_patches,
                    &validate_input,
                    &context,
                    probe_threads.clone(),
                    IndependentValidationSummary {
                        extracted_archives,
                        n64_byte_order: (n64_order.is_some()
                            || n64_byte_order != PatchN64ByteOrderMode::Auto)
                            .then_some(n64_byte_order),
                        extracted_patch_notes,
                        validation_labels,
                        min_size: validate_with_min_size,
                        expected_size: effective_expected_size,
                        expected_input_checksums: expected_input_checksums.clone(),
                    },
                    PlanFlagInputs {
                        basis: patch_basis,
                        input_checks: patch_input_check,
                        output_checks: patch_output_check,
                        cached_input_checksums: cached_input_checksums.clone(),
                    },
                );
            }

            if independent {
                return self.run_patch_validate_independent(
                    &resolved_patches,
                    &validate_input,
                    &context,
                    probe_threads.clone(),
                    IndependentValidationSummary {
                        extracted_archives,
                        n64_byte_order: (n64_order.is_some()
                            || n64_byte_order != PatchN64ByteOrderMode::Auto)
                            .then_some(n64_byte_order),
                        extracted_patch_notes,
                        validation_labels,
                        min_size: validate_with_min_size,
                        expected_size: effective_expected_size,
                        expected_input_checksums: expected_input_checksums.clone(),
                    },
                );
            }

            let patch_count = resolved_patches.len();
            let mut current_input = validate_input;
            let mut formats = Vec::with_capacity(patch_count);
            for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
                let handler = match self.probe_patch_handler(
                    patch_path,
                    resolved_patch_path,
                    index,
                    patch_count,
                    probe_threads.clone(),
                ) {
                    Ok(handler) => handler,
                    Err(report) => return *report,
                };
                if !handler.capabilities().apply {
                    return OperationReport::unsupported(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "validate",
                        format!(
                            "{} does not support patch preflight",
                            handler.descriptor().name
                        ),
                        context.single_thread_execution(),
                    );
                }
                formats.push(handler.descriptor().name.to_string());

                if index > 0
                    && let Err(error) = self.transition_n64_byte_order(
                        n64_byte_order,
                        resolved_patch_path,
                        &mut current_input,
                        &mut n64_order,
                        &context,
                        &mut temp_paths,
                    )
                {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "prepare",
                        format!(
                            "patch {}/{} (`{}`): N64 byte-order transition failed: {error}",
                            index + 1,
                            patch_count,
                            patch_path.display()
                        ),
                        context.single_thread_execution(),
                    );
                }

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
                        Err(RomWeaverError::Unsupported(op)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                op.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                context.single_thread_execution(),
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
                            context.single_thread_execution(),
                        );
                    }

                    let request = PatchApplyRequest {
                        input: current_input.clone(),
                        patches: vec![resolved_patch_path.clone()],
                        output: output.clone(),
                    };
                    let report = match handler.apply(&request, &patch_context) {
                        Ok(report) => report,
                        Err(RomWeaverError::Unsupported(op)) => {
                            return OperationReport::unsupported(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                op.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                Some(handler.descriptor().name.to_string()),
                                "validate",
                                error.to_string(),
                                context.single_thread_execution(),
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
                        report
                            .thread_execution
                            .or_else(|| context.single_thread_execution()),
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
            if n64_order.is_some() || n64_byte_order != PatchN64ByteOrderMode::Auto {
                validation_labels.push(format!("n64_byte_order={}", n64_byte_order.id()));
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
                context.single_thread_execution(),
            );
            report.details = Some(json!({
                "patch_validation": {
                    "preflight": true,
                    "format": final_format,
                    "formats": formats,
                    "patch_count": patch_count,
                    "source_values": {
                        "minimum_size": validate_with_min_size,
                        "size": effective_expected_size,
                        "checksums": expected_input_checksums,
                    },
                    "status": "passed",
                }
            }));
            report
        })();

        Self::cleanup_temp_paths(&temp_paths);
        self.finish("patch-validate", report)
    }

    /// Validate each patch independently against the ORIGINAL prepared input (no
    /// sequential chaining). A single failing patch never aborts the others - the
    /// command collects a per-patch verdict for every patch and exits 0 so the
    /// webapp can read individual results (a hard failure would lose them). A
    /// genuine cancellation is the sole exception: it returns a `Cancelled`
    /// failure so the whole call maps to a retryable "unknown".
    fn run_patch_validate_independent(
        &self,
        resolved_patches: &[(PathBuf, PathBuf)],
        validate_input: &Path,
        context: &OperationContext,
        probe_threads: Option<ThreadExecution>,
        summary: IndependentValidationSummary,
    ) -> OperationReport {
        let patch_count = resolved_patches.len();
        debug!(
            patch_count,
            "patch-validate running independent (non-chained) per-patch validation"
        );

        // Probe each patch's handler sequentially (cheap header sniffing). Patches whose handler
        // cannot be resolved - or that cannot run preflight - become already-decided "failed"
        // verdicts rather than aborting the batch.
        let mut ready_jobs: Vec<IndependentReadyJob> = Vec::new();
        let mut decided: Vec<PerPatchVerdict> = Vec::new();
        for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
            let patch_label = patch_path.to_string_lossy().to_string();
            match self.probe_patch_handler(
                patch_path,
                resolved_patch_path,
                index,
                patch_count,
                probe_threads.clone(),
            ) {
                Ok(handler) => {
                    let format = handler.descriptor().name.to_string();
                    if handler.capabilities().apply {
                        ready_jobs.push(IndependentReadyJob {
                            index,
                            patch: patch_label,
                            resolved: resolved_patch_path.clone(),
                            format,
                            handler,
                        });
                    } else {
                        let message = format!("{format} does not support patch preflight");
                        trace!(
                            index,
                            patch_count, format, "independent patch verdict: failed (unsupported)"
                        );
                        decided.push(PerPatchVerdict {
                            index,
                            patch: patch_label,
                            format: Some(format),
                            passed: false,
                            message,
                        });
                    }
                }
                Err(report) => {
                    trace!(
                        index,
                        patch_count, "independent patch verdict: failed (probe)"
                    );
                    decided.push(PerPatchVerdict {
                        index,
                        patch: patch_label,
                        format: report.format.clone(),
                        passed: false,
                        message: report.label.clone(),
                    });
                }
            }
        }

        let (computed, planned) = match self.validate_ready_jobs(
            &ready_jobs,
            validate_input,
            context,
            patch_count,
            &format!("validating {patch_count} patch(es) independently"),
        ) {
            Ok(result) => result,
            Err(report) => return *report,
        };

        let mut verdicts = decided;
        verdicts.extend(computed);
        verdicts.sort_by_key(|verdict| verdict.index);
        let passed_count = verdicts.iter().filter(|verdict| verdict.passed).count();
        let failed_count = patch_count.saturating_sub(passed_count);
        let status = if failed_count == 0 { "passed" } else { "mixed" };

        let mut formats: Vec<String> = Vec::new();
        for verdict in &verdicts {
            if let Some(format) = &verdict.format
                && !formats.iter().any(|existing| existing == format)
            {
                formats.push(format.clone());
            }
        }

        let IndependentValidationSummary {
            extracted_archives,
            n64_byte_order,
            extracted_patch_notes,
            mut validation_labels,
            min_size,
            expected_size,
            expected_input_checksums,
        } = summary;
        if extracted_archives > 0 {
            validation_labels.push(format!(
                "input resolved via {extracted_archives} container extract step(s)"
            ));
        }
        if let Some(mode) = n64_byte_order {
            validation_labels.push(format!("n64_byte_order={}", mode.id()));
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
        let per_patch = verdicts
            .iter()
            .map(|verdict| {
                json!({
                    "index": verdict.index,
                    "patch": verdict.patch,
                    "format": verdict.format,
                    "status": if verdict.passed { "passed" } else { "failed" },
                    "message": verdict.message,
                })
            })
            .collect::<Vec<_>>();

        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            formats.first().cloned(),
            "validate",
            format!(
                "independent patch validation {status}: {passed_count}/{patch_count} passed ({format_label}){suffix}"
            ),
            Some(100.0),
            Some(planned),
        );
        report.details = Some(json!({
            "patch_validation": {
                "preflight": true,
                "independent": true,
                "status": status,
                "patch_count": patch_count,
                "passed_count": passed_count,
                "failed_count": failed_count,
                "format": formats.first().cloned(),
                "formats": formats,
                "per_patch": per_patch,
                "source_values": {
                    "minimum_size": min_size,
                    "size": expected_size,
                    "checksums": expected_input_checksums,
                },
            }
        }));
        report
    }

    /// Fan patch preflight validations across the op's thread budget (capped at the
    /// number of runnable patches; serial on the non-threaded wasm build). A
    /// per-patch `Cancelled` is the only error that aborts the whole batch -
    /// every other handler error is captured as that patch's "failed"
    /// verdict. `Err` carries the whole-batch abort report.
    fn validate_ready_jobs(
        &self,
        ready_jobs: &[IndependentReadyJob],
        validate_input: &Path,
        context: &OperationContext,
        patch_count: usize,
        running_label: &str,
    ) -> std::result::Result<(Vec<PerPatchVerdict>, ThreadExecution), Box<OperationReport>> {
        let run_one =
            |job: &IndependentReadyJob| -> std::result::Result<PerPatchVerdict, RomWeaverError> {
                let request = PatchValidateRequest {
                    input: validate_input.to_path_buf(),
                    patches: vec![job.resolved.clone()],
                };
                let verdict = match job.handler.validate(&request, context) {
                    Ok(report) if report.status == OperationStatus::Succeeded => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: true,
                        message: report.label,
                    },
                    Ok(report) => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: false,
                        message: report.label,
                    },
                    Err(RomWeaverError::Cancelled) => return Err(RomWeaverError::Cancelled),
                    Err(RomWeaverError::Unsupported(op)) => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: false,
                        message: op.to_string(),
                    },
                    Err(error) => PerPatchVerdict {
                        index: job.index,
                        patch: job.patch.clone(),
                        format: Some(job.format.clone()),
                        passed: false,
                        message: error.to_string(),
                    },
                };
                trace!(
                    index = verdict.index,
                    patch_count,
                    format = job.format,
                    passed = verdict.passed,
                    "patch preflight verdict"
                );
                Ok(verdict)
            };

        let capability = ThreadCapability::parallel(Some(ready_jobs.len().max(1)));
        let planned = context.plan_threads(capability.clone());
        let computed = if !ready_jobs.is_empty() {
            self.emit_running(
                OperationLabel {
                    command: "patch-validate",
                    family: OperationFamily::Patch,
                    format: None,
                },
                "validate",
                running_label.to_string(),
                None,
                None,
            );
            if planned.used_parallelism {
                let (execution, pool) = match context.build_pool(capability) {
                    Ok(built) => built,
                    Err(error) => {
                        return Err(Box::new(OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
                        )));
                    }
                };
                trace!(
                    used_parallelism = execution.used_parallelism,
                    threads = execution.effective_threads,
                    jobs = ready_jobs.len(),
                    "patch preflight fan-out (parallel)"
                );
                pool.install(|| {
                    ready_jobs
                        .par_iter()
                        .map(run_one)
                        .collect::<std::result::Result<Vec<_>, _>>()
                })
            } else {
                trace!(
                    used_parallelism = false,
                    jobs = ready_jobs.len(),
                    "patch preflight fan-out (serial)"
                );
                ready_jobs
                    .iter()
                    .map(run_one)
                    .collect::<std::result::Result<Vec<_>, _>>()
            }
        } else {
            Ok(Vec::new())
        };

        match computed {
            Ok(verdicts) => Ok((verdicts, planned)),
            // A genuine cancellation aborts the whole batch as a hard failure so the webapp maps the
            // call to a retryable "unknown" rather than reading partial per-patch verdicts.
            Err(error) => {
                debug!("patch preflight cancelled");
                Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    error.to_string(),
                    Some(planned),
                )))
            }
        }
    }

    /// `patch-validate --plan`: resolve every patch's input basis and chain
    /// order statically via the verification planner, dry-run only the
    /// patches that consume the original input (chain position 0 and
    /// base-basis patches - mid-chain previous-basis patches are
    /// `chain_deferred`, never falsely "failed" against the wrong bytes),
    /// and emit the typed `PatchValidationPlan` under
    /// `details.patch_validation`. Exit contract matches `--independent`:
    /// mixed results still exit 0; only cancellation is a hard failure.
    fn run_patch_validate_plan(
        &self,
        resolved_patches: &[(PathBuf, PathBuf)],
        validate_input: &Path,
        context: &OperationContext,
        probe_threads: Option<ThreadExecution>,
        summary: IndependentValidationSummary,
        flags: PlanFlagInputs,
    ) -> OperationReport {
        let patch_count = resolved_patches.len();
        debug!(patch_count, "patch-validate running plan resolution");
        let fail = |message: String| {
            OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                message,
                probe_threads.clone(),
            )
        };

        let PlanAlignedMetadata {
            basis_modes,
            input_check_flags,
            output_check_flags,
        } = match Self::align_plan_metadata(&flags, patch_count) {
            Ok(metadata) => metadata,
            Err(error) => return fail(error.to_string()),
        };

        // Probe handlers; a failed probe (or a format without preflight support)
        // still plans, it just cannot contribute embedded checks or a preflight verdict.
        let ProbedPlanHandlers {
            handlers,
            failures: probe_failures,
        } = self.probe_plan_handlers(resolved_patches, patch_count, probe_threads.clone());

        // Assemble what is known about each patch.
        let mut plan_inputs: Vec<patch_plan::PlanPatchInput> = Vec::with_capacity(patch_count);
        for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
            let mut declared_input = patch_plan::PlanState::default();
            if let Some(patch_name) = patch_path.file_name().and_then(|name| name.to_str()) {
                let requirements = parse_filename_requirements(patch_name);
                declared_input.checksums = requirements.checksums;
                declared_input.size = requirements.size;
            }
            if let Some(tokens) = input_check_flags[index].as_ref() {
                match Self::parse_plan_check_tokens(tokens, "--patch-input-check") {
                    // Explicit flags win over filename tokens per algorithm.
                    Ok(parsed) => declared_input.checksums.extend(parsed),
                    Err(error) => return fail(error.to_string()),
                }
            }
            let mut declared_output = patch_plan::PlanState::default();
            if let Some(tokens) = output_check_flags[index].as_ref() {
                match Self::parse_plan_check_tokens(tokens, "--patch-output-check") {
                    Ok(parsed) => declared_output.checksums.extend(parsed),
                    Err(error) => return fail(error.to_string()),
                }
            }
            let embedded = handlers[index]
                .as_ref()
                .and_then(|handler| handler.describe_metadata(resolved_patch_path, context).ok())
                .map(|report| patch_plan::parse_endpoint_variants(report.details.as_ref()))
                .unwrap_or_default();
            plan_inputs.push(patch_plan::PlanPatchInput {
                name: patch_path.to_string_lossy().to_string(),
                format: handlers[index]
                    .as_ref()
                    .map(|handler| handler.descriptor().name.to_string()),
                declared_basis: basis_modes[index].unwrap_or_default().declared(),
                declared_input,
                declared_output,
                embedded,
            });
        }

        let base_variants =
            match self.plan_base_variants(validate_input, &plan_inputs, &flags, context) {
                Ok(variants) => variants,
                Err(error) => return fail(error.to_string()),
            };

        let resolved = patch_plan::resolve_verification_plan(&base_variants, &plan_inputs);
        let mut per_patch = resolved.per_patch;

        // Probe failures override whatever the planner said.
        for (index, failure) in probe_failures.into_iter().enumerate() {
            if let Some(message) = failure {
                per_patch[index].input_verdict = PatchInputVerdict::Failed;
                per_patch[index].message = message;
            }
        }

        // Probe the base for chain heads, proven base inputs, and speculative chained inputs. A
        // checksumless patch should not appear chained merely because it follows another patch.
        let is_speculative_base = |verdict: &PatchPlanVerdict| {
            verdict.basis == PatchInputBasis::Previous
                && verdict.basis_source == PatchBasisSource::Default
        };
        let ready_jobs: Vec<IndependentReadyJob> = resolved_patches
            .iter()
            .enumerate()
            .filter_map(|(index, (patch_path, resolved_patch_path))| {
                let verdict = &per_patch[index];
                let consumes_base = index == 0
                    || verdict.basis == PatchInputBasis::Base
                    || is_speculative_base(verdict);
                if !consumes_base || verdict.input_verdict == PatchInputVerdict::Failed {
                    return None;
                }
                let handler = handlers[index].clone()?;
                handler.capabilities().apply.then(|| IndependentReadyJob {
                    index,
                    patch: patch_path.to_string_lossy().to_string(),
                    resolved: resolved_patch_path.clone(),
                    format: handler.descriptor().name.to_string(),
                    handler,
                })
            })
            .collect();
        let preflight_count = ready_jobs.len();
        let (preflight_verdicts, planned) = match self.validate_ready_jobs(
            &ready_jobs,
            validate_input,
            context,
            patch_count,
            &format!("validating {preflight_count} of {patch_count} patch(es) against the input"),
        ) {
            Ok(result) => result,
            Err(report) => return *report,
        };
        for preflight in preflight_verdicts {
            let entry = &mut per_patch[preflight.index];
            let speculative = is_speculative_base(entry);
            if preflight.passed {
                if entry.input_verdict == PatchInputVerdict::Unknown
                    || (speculative && entry.input_verdict == PatchInputVerdict::ChainDeferred)
                {
                    entry.input_verdict = PatchInputVerdict::Passed;
                    entry.message = preflight.message;
                    // A guessed-chain patch that cleanly applies to the ROM consumes the base like
                    // the head: present it identically (base basis, green check) so its verdict no
                    // longer depends on list position.
                    if speculative {
                        entry.basis = PatchInputBasis::Base;
                    }
                }
            } else if !speculative {
                // A definite base consumer that fails is a real failure. A guessed-chain patch that
                // fails to apply to the base is NOT proven bad - it may genuinely target an
                // intermediate - so its honest `chain_deferred` verdict stands.
                entry.input_verdict = PatchInputVerdict::Failed;
                entry.message = preflight.message;
            }
        }

        let passed_count = per_patch
            .iter()
            .filter(|verdict| verdict.input_verdict == PatchInputVerdict::Passed)
            .count();
        let failed_count = per_patch
            .iter()
            .filter(|verdict| verdict.input_verdict == PatchInputVerdict::Failed)
            .count();
        let status = if failed_count == 0 { "passed" } else { "mixed" };
        let mut formats: Vec<String> = Vec::new();
        for verdict in &per_patch {
            if let Some(format) = &verdict.format
                && !formats.iter().any(|existing| existing == format)
            {
                formats.push(format.clone());
            }
        }

        let IndependentValidationSummary {
            extracted_archives,
            n64_byte_order,
            extracted_patch_notes,
            mut validation_labels,
            min_size,
            expected_size,
            expected_input_checksums,
        } = summary;
        if extracted_archives > 0 {
            validation_labels.push(format!(
                "input resolved via {extracted_archives} container extract step(s)"
            ));
        }
        if let Some(target_order) = n64_byte_order {
            validation_labels.push(format!("n64_byte_order={}", target_order.id()));
        }
        validation_labels.extend(extracted_patch_notes);
        if let Some(order) = &resolved.suggested_order {
            let rendered = order
                .iter()
                .map(|index| (index + 1).to_string())
                .collect::<Vec<_>>()
                .join(", ");
            validation_labels.push(format!("suggested patch order: {rendered}"));
        }

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

        let plan_payload = PatchValidationPlan {
            plan: true,
            per_patch,
            suggested_order: resolved.suggested_order,
            output_verification: resolved.output_verification,
            status: status.to_string(),
            patch_count: patch_count as u32,
            passed_count: passed_count as u32,
            failed_count: failed_count as u32,
            formats: formats.clone(),
        };
        let mut payload = serde_json::to_value(&plan_payload)
            .expect("verification plan serializes")
            .as_object()
            .cloned()
            .expect("verification plan is a JSON object");
        payload.insert("preflight".to_string(), json!(true));
        payload.insert(
            "source_values".to_string(),
            json!({
                "minimum_size": min_size,
                "size": expected_size,
                "checksums": expected_input_checksums,
            }),
        );

        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            formats.first().cloned(),
            "validate",
            format!(
                "patch verification plan {status}: {passed_count} passed, {failed_count} failed, {} deferred of {patch_count} ({format_label}){suffix}",
                patch_count - passed_count - failed_count
            ),
            Some(100.0),
            Some(planned),
        );
        report.details = Some(json!({ "patch_validation": payload }));
        report
    }

    fn align_plan_metadata(
        flags: &PlanFlagInputs,
        patch_count: usize,
    ) -> Result<PlanAlignedMetadata> {
        Ok(PlanAlignedMetadata {
            basis_modes: crate::bundle_create::aligned_metadata(
                &flags.basis,
                patch_count,
                "--patch-basis",
            )?,
            input_check_flags: crate::bundle_create::aligned_metadata(
                &flags.input_checks,
                patch_count,
                "--patch-input-check",
            )?,
            output_check_flags: crate::bundle_create::aligned_metadata(
                &flags.output_checks,
                patch_count,
                "--patch-output-check",
            )?,
        })
    }

    fn probe_plan_handlers(
        &self,
        resolved_patches: &[(PathBuf, PathBuf)],
        patch_count: usize,
        probe_threads: Option<ThreadExecution>,
    ) -> ProbedPlanHandlers {
        let mut handlers = Vec::with_capacity(patch_count);
        let mut probe_failures = vec![None; patch_count];
        for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
            match self.probe_patch_handler(
                patch_path,
                resolved_patch_path,
                index,
                patch_count,
                probe_threads.clone(),
            ) {
                Ok(handler) => handlers.push(Some(handler)),
                Err(report) => {
                    probe_failures[index] = Some(report.label.clone());
                    handlers.push(None);
                }
            }
        }
        ProbedPlanHandlers {
            handlers,
            failures: probe_failures,
        }
    }

    /// Parse a comma-separable `ALGO=HEX` flag value.
    fn parse_plan_check_tokens(value: &str, flag: &str) -> Result<BTreeMap<String, String>> {
        let tokens: Vec<String> = value
            .split(',')
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .map(str::to_owned)
            .collect();
        if tokens.is_empty() {
            return Ok(BTreeMap::new());
        }
        Self::parse_patch_apply_checksum_values(&tokens, flag)
    }

    /// Compute the base ROM variants the planner matches against: `raw`
    /// covering the union of algorithms any patch references (seeded values
    /// reused), plus a `headerless` CRC32 variant when a strippable copier
    /// header is detected and any patch pins a CRC32.
    fn plan_base_variants(
        &self,
        validate_input: &Path,
        plan_inputs: &[patch_plan::PlanPatchInput],
        flags: &PlanFlagInputs,
        context: &OperationContext,
    ) -> Result<Vec<patch_plan::BaseVariant>> {
        let mut algorithms: Vec<String> = Vec::new();
        let mut wants_crc32 = false;
        for input in plan_inputs {
            let mut collect = |state: &patch_plan::PlanState| {
                for algorithm in state.checksums.keys() {
                    if algorithm == "crc32" {
                        wants_crc32 = true;
                    }
                    if !algorithms.iter().any(|existing| existing == algorithm) {
                        algorithms.push(algorithm.clone());
                    }
                }
            };
            collect(&input.declared_input);
            for (embedded_input, _) in &input.embedded {
                collect(embedded_input);
            }
        }

        let input_size = fs::metadata(validate_input)?.len();
        let mut raw = patch_plan::PlanState {
            checksums: BTreeMap::new(),
            size: Some(input_size),
        };
        let missing: Vec<&str> = algorithms
            .iter()
            .filter(|algorithm| !flags.cached_input_checksums.contains_key(*algorithm))
            .map(String::as_str)
            .collect();
        for (algorithm, value) in &flags.cached_input_checksums {
            if algorithms.iter().any(|wanted| wanted == algorithm) {
                raw.checksums
                    .insert(algorithm.clone(), value.to_ascii_lowercase());
            }
        }
        if !missing.is_empty() {
            trace!(algorithms = ?missing, "computing base checksums for verification plan");
            let computed = checksum_file_values(validate_input, &missing, context)?;
            raw.checksums.extend(computed);
        }
        let mut variants = vec![patch_plan::BaseVariant {
            name: "raw".to_string(),
            state: raw,
        }];

        // Phase 1 keeps the headerless variant CRC32-only: the copier-header
        // formats that need it (BPS/UPS/IPS-with-filename-tokens) all pin
        // CRC32.
        if wants_crc32
            && let Ok(header_match) = Self::detect_strippable_rom_header(validate_input)
            && let Some(stripped) = header_match.stripped_bytes()
        {
            let stripped = stripped as u64;
            let mut reader = BufReader::new(File::open(validate_input)?);
            reader.seek(SeekFrom::Start(stripped))?;
            if let Some(crc32) = Self::crc32_of_reader(&mut reader, context)? {
                let mut checksums = BTreeMap::new();
                checksums.insert("crc32".to_string(), crc32);
                variants.push(patch_plan::BaseVariant {
                    name: "headerless".to_string(),
                    state: patch_plan::PlanState {
                        checksums,
                        size: Some(input_size.saturating_sub(stripped)),
                    },
                });
            }
        }
        Ok(variants)
    }
}

/// Per-patch plan flags handed from `run_patch_validate` into plan mode,
/// index-aligned with `patches` (native argv alignment or wasm vectors).
struct PlanFlagInputs {
    basis: Vec<PatchBasisMode>,
    input_checks: Vec<String>,
    output_checks: Vec<String>,
    cached_input_checksums: BTreeMap<String, String>,
}

struct PlanAlignedMetadata {
    basis_modes: Vec<Option<PatchBasisMode>>,
    input_check_flags: Vec<Option<String>>,
    output_check_flags: Vec<Option<String>>,
}

struct ProbedPlanHandlers {
    handlers: Vec<Option<Arc<dyn rom_weaver_core::PatchHandler>>>,
    failures: Vec<Option<String>>,
}

/// Shared input-level context threaded into independent-mode validation: the
/// notes/labels already accumulated by the shared input preparation plus the
/// expected source values, so the independent report carries the same suffix and
/// `source_values` block the chained report does.
struct IndependentValidationSummary {
    extracted_archives: usize,
    n64_byte_order: Option<PatchN64ByteOrderMode>,
    extracted_patch_notes: Vec<String>,
    validation_labels: Vec<String>,
    min_size: Option<u64>,
    expected_size: Option<u64>,
    expected_input_checksums: BTreeMap<String, String>,
}

/// A patch whose handler resolved and supports preflight, queued for the
/// parallel independent validation fan-out.
struct IndependentReadyJob {
    index: usize,
    patch: String,
    resolved: PathBuf,
    format: String,
    handler: Arc<dyn rom_weaver_core::PatchHandler>,
}

/// One patch's independent-mode verdict, collected regardless of pass/fail.
struct PerPatchVerdict {
    index: usize,
    patch: String,
    format: Option<String>,
    passed: bool,
    message: String,
}
