/* jscpd:ignore-start */
impl CliApp {
    fn run_compress(&self, args: CompressCommand) -> ExitCode {
        trace!(
            input_count = args.input.len(),
            output = %args.output.display(),
            requested_format = ?args.format,
            codec = ?args.codec,
            level = ?args.level,
            threads = %args.threads,
            "starting compress command"
        );
        let CompressCommand {
            input,
            format,
            output,
            codec,
            level: level_profile,
            threads,
        } = args;
        let requested_format = match format {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return self.finish(
                        "compress",
                        OperationReport::failed(
                            OperationFamily::Container,
                            None,
                            "validate",
                            "--format cannot be empty",
                            None,
                        ),
                    );
                }
                Some(trimmed.to_string())
            }
            None => None,
        };
        let requested_or_auto_format = requested_format
            .clone()
            .unwrap_or_else(|| "auto".to_string());
        let auto_mode = requested_format
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("auto"))
            .unwrap_or(true);

        let context = self.context(threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        for input in &input {
            if let Some(report) = self.require_existing_path(
                "compress",
                OperationFamily::Container,
                Some(requested_or_auto_format.clone()),
                input,
                probe_threads.clone(),
            ) {
                return self.finish("compress", report);
            }
        }
        if auto_mode && input.len() != 1 {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some("auto".to_string()),
                    "validate",
                    "auto format selection requires exactly one input file; pass --format <name> when compressing multiple inputs",
                    probe_threads,
                ),
            );
        }
        let (resolved_format, auto_label_suffix) = if auto_mode {
            let recommendation = self.containers.recommend_compress_format(&input[0]);
            (
                recommendation.format_name.to_string(),
                Some(format!(
                    "auto format={} reason={}",
                    recommendation.format_name, recommendation.reason
                )),
            )
        } else {
            let Some(explicit_format) = requested_format.clone() else {
                return self.finish(
                    "compress",
                    OperationReport::failed(
                        OperationFamily::Container,
                        None,
                        "validate",
                        "internal validation error: explicit compression mode requires --format",
                        probe_threads,
                    ),
                );
            };
            (explicit_format, None)
        };
        let (codec, explicit_level) = match Self::resolve_codec_level(codec, "--codec") {
            Ok(value) => value,
            Err(error) => {
                return self.finish(
                    "compress",
                    OperationReport::failed(
                        OperationFamily::Container,
                        Some(resolved_format.clone()),
                        "validate",
                        error.to_string(),
                        probe_threads,
                    ),
                );
            }
        };
        let codec = if auto_mode { None } else { codec };
        let explicit_level = if auto_mode { None } else { explicit_level };
        let level = Self::resolve_compression_level_for_profile(
            &resolved_format,
            Self::primary_codec_name(codec.as_deref()),
            explicit_level,
            level_profile,
        );

        let Some(handler) = self.containers.find_by_name(&resolved_format) else {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(resolved_format),
                    "probe",
                    "requested output format is not registered",
                    probe_threads,
                ),
            );
        };
        let capabilities = handler.capabilities();
        if !capabilities.inspect && !capabilities.extract && !capabilities.create {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(resolved_format),
                    "probe",
                    "requested output format is not registered",
                    probe_threads,
                ),
            );
        }
        let create_threads = Some(context.plan_threads(capabilities.create_threads.clone()));
        let suppress_scaffold_percent =
            Self::container_handler_emits_incremental_byte_progress(handler.descriptor().name);
        self.emit_running(
            "compress",
            OperationFamily::Container,
            Some(handler.descriptor().name),
            "create",
            format!(
                "creating {} archive from {} input(s)",
                handler.descriptor().name,
                input.len()
            ),
            Some(0.0),
            create_threads.clone(),
        );
        self.emit_running(
            "compress",
            OperationFamily::Container,
            Some(handler.descriptor().name),
            "create",
            format!("preparing {} archive build", handler.descriptor().name),
            if suppress_scaffold_percent {
                None
            } else {
                Some(1.0)
            },
            create_threads.clone(),
        );

        let expected_output = output.clone();
        let request = ContainerCreateRequest {
            inputs: input,
            output,
            format: resolved_format.clone(),
            codec,
            level,
            parent: None,
        };
        let mut report = handler.create(&request, &context).unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Container,
                Some(handler.descriptor().name.to_string()),
                "create",
                error.to_string(),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            )
        });
        if report.status == OperationStatus::Succeeded
            && let Some(auto_label_suffix) = auto_label_suffix
        {
            report.label = format!("{}; {auto_label_suffix}", report.label);
        }
        if report.status == OperationStatus::Succeeded {
            self.emit_running(
                "compress",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "create",
                format!("finalizing `{}` archive", handler.descriptor().name),
                if suppress_scaffold_percent {
                    None
                } else {
                    Some(99.0)
                },
                report.thread_execution.clone(),
            );
            report =
                Self::attach_emitted_files_details(report, vec![expected_output], Some("archive"));
        }
        self.finish("compress", report)
    }

    fn container_handler_emits_incremental_byte_progress(format_name: &str) -> bool {
        matches!(
            format_name,
            "zip" | "zipx" | "7z" | "rar" | "tar" | "tar.gz" | "tar.bz2" | "tar.xz"
        )
    }

    fn run_trim(&self, args: TrimCommand) -> ExitCode {
        trace!(
            source_count = args.source.len(),
            output = ?args.output.as_ref().map(|path| path.display().to_string()),
            extension = ?args.extension,
            in_place = args.in_place,
            dry_run = args.dry_run,
            revert = args.revert,
            recursive = args.recursive,
            threads = %args.threads,
            "starting trim command"
        );
        let TrimCommand {
            source,
            output,
            extension,
            in_place,
            dry_run,
            revert,
            recursive,
            threads,
        } = args;
        let operation = if revert {
            TrimOperation::Revert
        } else {
            TrimOperation::Trim
        };
        let context = self.context(threads);
        let thread_execution = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let extension = extension
            .unwrap_or_else(|| Self::default_trim_extension_pattern(operation).to_string());
        let extension = match Self::normalize_trim_extension(&extension) {
            Ok(value) => value,
            Err(error) => {
                return self.finish(
                    "trim",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("nds".to_string()),
                        "validate",
                        error.to_string(),
                        thread_execution,
                    ),
                );
            }
        };

        let mut skipped_non_nds = 0usize;
        let trim_sources =
            match self.collect_trim_input_files(&source, recursive, &mut skipped_non_nds) {
                Ok(paths) => paths,
                Err(error) => {
                    return self.finish(
                        "trim",
                        OperationReport::failed(
                            OperationFamily::Command,
                            Some("nds".to_string()),
                            "validate",
                            error.to_string(),
                            thread_execution,
                        ),
                    );
                }
            };

        if trim_sources.is_empty() {
            return self.finish(
                "trim",
                OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "trim",
                    format!("no trim-eligible inputs found; skipped_non_nds={skipped_non_nds}"),
                    Some(100.0),
                    thread_execution,
                ),
            );
        }

        if output.is_some() && trim_sources.len() != 1 {
            return self.finish(
                "trim",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "validate",
                    "--output requires exactly one trim-eligible source file",
                    thread_execution,
                ),
            );
        }

        let mut trimmed_count = 0usize;
        let mut already_trimmed_count = 0usize;
        let mut failed_count = 0usize;
        let mut first_error = None;
        let mut mode_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
        let mut single_detail = None;
        let mut irreversible_xiso = false;
        let mut irreversible_rvz_scrub = false;

        for trim_source in &trim_sources {
            let output_path = if in_place {
                trim_source.path.clone()
            } else if let Some(explicit_output) = output.as_ref() {
                explicit_output.clone()
            } else {
                Self::default_trim_output_path(trim_source, &extension)
            };
            let output_label = if in_place {
                "in-place".to_string()
            } else {
                output_path.display().to_string()
            };

            self.emit_running(
                "trim",
                OperationFamily::Command,
                Some("nds"),
                operation.stage(),
                format!(
                    "{} `{}` -> `{output_label}`",
                    operation.running_label(dry_run),
                    trim_source.path.display()
                ),
                Some(0.0),
                thread_execution.clone(),
            );

            match self.trim_file(
                &trim_source.path,
                &output_path,
                in_place,
                dry_run,
                operation,
                trim_source.kind,
                &context,
            ) {
                Ok(outcome) => {
                    let mode_count = mode_counts.entry(outcome.mode).or_insert(0);
                    *mode_count = mode_count.saturating_add(1);
                    if operation == TrimOperation::Trim && !outcome.revert_supported {
                        if outcome.mode == TrimInputKind::Xiso.mode_label() {
                            irreversible_xiso = true;
                        }
                        if outcome.mode == TrimInputKind::RvzScrub.mode_label() {
                            irreversible_rvz_scrub = true;
                        }
                    }
                    if outcome.already_target_size {
                        already_trimmed_count = already_trimmed_count.saturating_add(1);
                    } else {
                        trimmed_count = trimmed_count.saturating_add(1);
                    }
                    if trim_sources.len() == 1 {
                        let status = if outcome.already_target_size {
                            if operation == TrimOperation::Trim {
                                "already-trimmed"
                            } else {
                                "already-untrimmed"
                            }
                        } else if operation == TrimOperation::Trim {
                            "trimmed"
                        } else {
                            "reverted"
                        };
                        let result_size_label = if operation == TrimOperation::Trim {
                            "trimmed_size"
                        } else {
                            "reverted_size"
                        };
                        single_detail = Some(format!(
                            "{status} mode={} original_size={} {result_size_label}={} preserved_download_play_cert={} revert_supported={} output={}",
                            outcome.mode,
                            outcome.original_size,
                            outcome.result_size,
                            outcome.preserved_download_play_cert,
                            outcome.revert_supported,
                            outcome.output_path.display()
                        ));
                    }
                }
                Err(error) => {
                    failed_count = failed_count.saturating_add(1);
                    if first_error.is_none() {
                        first_error = Some(format!("{}: {error}", trim_source.path.display()));
                    }
                }
            }
        }

        if failed_count > 0 {
            return self.finish(
                "trim",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "trim",
                    format!(
                        "{} completed with failures; processed={} trimmed={} already_trimmed={} failed={} skipped_non_nds={}; first_error={}",
                        if dry_run {
                            if operation == TrimOperation::Trim {
                                "trim simulation"
                            } else {
                                "trim revert simulation"
                            }
                        } else if operation == TrimOperation::Trim {
                            "trim"
                        } else {
                            "trim revert"
                        },
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        failed_count,
                        skipped_non_nds,
                        first_error.unwrap_or_else(|| "(none)".to_string()),
                    ),
                    thread_execution,
                ),
            );
        }

        let irreversible_warning = if operation != TrimOperation::Trim {
            ""
        } else if irreversible_xiso && !irreversible_rvz_scrub {
            "; warning=trimmed xiso output cannot be reverted to original padding; keep backup"
        } else if irreversible_rvz_scrub && !irreversible_xiso {
            "; warning=trimmed rvz-scrub output cannot be reverted to original source format; keep backup"
        } else if irreversible_xiso && irreversible_rvz_scrub {
            "; warning=some trimmed outputs cannot be reverted to original source format; keep backups"
        } else {
            ""
        };

        self.finish(
            "trim",
            OperationReport::succeeded(
                OperationFamily::Command,
                Some("nds".to_string()),
                "trim",
                match single_detail {
                    Some(single_detail) => format!(
                        "{single_detail}; {}; processed={} trimmed={} already_trimmed={} changed={} already_target={} skipped_non_nds={} mode_counts={}{}",
                        operation.summary_label(dry_run),
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        trimmed_count,
                        already_trimmed_count,
                        skipped_non_nds,
                        Self::format_mode_counts(&mode_counts),
                        irreversible_warning,
                    ),
                    None => format!(
                        "{}; processed={} trimmed={} already_trimmed={} changed={} already_target={} skipped_non_nds={} mode_counts={}{}",
                        operation.summary_label(dry_run),
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        trimmed_count,
                        already_trimmed_count,
                        skipped_non_nds,
                        Self::format_mode_counts(&mode_counts),
                        irreversible_warning,
                    ),
                },
                Some(100.0),
                thread_execution,
            ),
        )
    }

    fn run_batch_header_fixer(&self, args: BatchHeaderFixerCommand) -> ExitCode {
        trace!(
            source_count = args.source.len(),
            output = ?args.output.as_ref().map(|path| path.display().to_string()),
            extension = ?args.extension,
            in_place = args.in_place,
            dry_run = args.dry_run,
            recursive = args.recursive,
            threads = %args.threads,
            "starting batch-header-fixer command"
        );
        let BatchHeaderFixerCommand {
            source,
            output,
            extension,
            in_place,
            dry_run,
            recursive,
            threads,
        } = args;
        let context = self.context(threads);
        let thread_execution = Some(context.plan_threads(ThreadCapability::single_threaded()));
        let extension = extension.unwrap_or_else(|| "fixed.{ext}".to_string());
        let extension = match Self::normalize_trim_extension(&extension) {
            Ok(value) => value,
            Err(error) => {
                return self.finish(
                    "batch-header-fixer",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("header-fix".to_string()),
                        "validate",
                        error.to_string(),
                        thread_execution,
                    ),
                );
            }
        };

        let mut skipped_non_rom = 0usize;
        let input_files = match self.collect_batch_header_fix_input_files(
            &source,
            recursive,
            &mut skipped_non_rom,
        ) {
            Ok(paths) => paths,
            Err(error) => {
                return self.finish(
                    "batch-header-fixer",
                    OperationReport::failed(
                        OperationFamily::Command,
                        Some("header-fix".to_string()),
                        "validate",
                        error.to_string(),
                        thread_execution,
                    ),
                );
            }
        };

        if input_files.is_empty() {
            let mut report = OperationReport::succeeded(
                OperationFamily::Command,
                Some("header-fix".to_string()),
                "fix",
                format!(
                    "no header-fix eligible inputs found; skipped_non_rom={skipped_non_rom}; supported_system_count={}",
                    BATCH_HEADER_FIX_SYSTEM_PROFILES.len()
                ),
                Some(100.0),
                thread_execution,
            );
            let mut details = Map::new();
            details.insert(
                "batch_header_fixer".to_string(),
                json!({
                    "supported_system_count": BATCH_HEADER_FIX_SYSTEM_PROFILES.len(),
                    "supported_profiles": BATCH_HEADER_FIX_SYSTEM_PROFILES,
                    "processed_files": 0,
                    "repaired_files": 0,
                    "matched_files": 0,
                    "unsupported_files": 0,
                    "failed_files": 0,
                    "skipped_non_rom": skipped_non_rom,
                    "dry_run": dry_run,
                    "in_place": in_place,
                    "repaired_profiles": Vec::<String>::new(),
                    "matched_profiles": Vec::<String>::new(),
                }),
            );
            report.details = Some(Value::Object(details));
            return self.finish("batch-header-fixer", report);
        }

        if output.is_some() && input_files.len() != 1 {
            return self.finish(
                "batch-header-fixer",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("header-fix".to_string()),
                    "validate",
                    "--output requires exactly one header-fix source file",
                    thread_execution,
                ),
            );
        }

        let mut repaired_files = 0usize;
        let mut matched_files = 0usize;
        let mut unsupported_files = 0usize;
        let mut failed_files = 0usize;
        let mut first_error = None;
        let mut emitted_files = Vec::new();
        let mut repaired_profiles = BTreeSet::new();
        let mut matched_profiles = BTreeSet::new();
        let mut single_detail = None;

        for input_path in &input_files {
            let output_path = if in_place {
                input_path.clone()
            } else if let Some(explicit_output) = output.as_ref() {
                explicit_output.clone()
            } else {
                Self::default_batch_header_fix_output_path(input_path, &extension)
            };
            let output_label = if in_place {
                "in-place".to_string()
            } else {
                output_path.display().to_string()
            };

            self.emit_running(
                "batch-header-fixer",
                OperationFamily::Command,
                Some("header-fix"),
                "fix",
                format!(
                    "fixing ROM header `{}` -> `{output_label}`",
                    input_path.display()
                ),
                Some(0.0),
                thread_execution.clone(),
            );

            match Self::fix_headers_for_file(input_path, &output_path, in_place, dry_run) {
                Ok(outcome) => {
                    for profile in &outcome.repaired_profiles {
                        repaired_profiles.insert(*profile);
                    }
                    for profile in &outcome.matched_without_changes {
                        matched_profiles.insert(*profile);
                    }

                    if !outcome.repaired_profiles.is_empty() {
                        repaired_files = repaired_files.saturating_add(1);
                    } else if !outcome.matched_without_changes.is_empty() {
                        matched_files = matched_files.saturating_add(1);
                    } else {
                        unsupported_files = unsupported_files.saturating_add(1);
                    }

                    if !in_place && !dry_run {
                        emitted_files.push(output_path.clone());
                    }

                    if input_files.len() == 1 {
                        let status = if !outcome.repaired_profiles.is_empty() {
                            "repaired"
                        } else if !outcome.matched_without_changes.is_empty() {
                            "matched-no-change"
                        } else {
                            "unsupported"
                        };
                        single_detail = Some(format!(
                            "{status} source={} output={} repaired_profiles={} matched_profiles={}",
                            input_path.display(),
                            output_path.display(),
                            if outcome.repaired_profiles.is_empty() {
                                "none".to_string()
                            } else {
                                outcome.repaired_profiles.join(",")
                            },
                            if outcome.matched_without_changes.is_empty() {
                                "none".to_string()
                            } else {
                                outcome.matched_without_changes.join(",")
                            },
                        ));
                    }
                }
                Err(error) => {
                    failed_files = failed_files.saturating_add(1);
                    if first_error.is_none() {
                        first_error = Some(format!("{}: {error}", input_path.display()));
                    }
                }
            }
        }

        let repaired_profiles = repaired_profiles.into_iter().collect::<Vec<_>>();
        let matched_profiles = matched_profiles.into_iter().collect::<Vec<_>>();

        let summary = match single_detail {
            Some(single_detail) => format!(
                "{single_detail}; {}; processed={} repaired={} matched={} unsupported={} failed={} skipped_non_rom={} supported_system_count={}",
                if dry_run {
                    "header-fix simulation completed"
                } else {
                    "header-fix completed"
                },
                input_files.len(),
                repaired_files,
                matched_files,
                unsupported_files,
                failed_files,
                skipped_non_rom,
                BATCH_HEADER_FIX_SYSTEM_PROFILES.len(),
            ),
            None => format!(
                "{}; processed={} repaired={} matched={} unsupported={} failed={} skipped_non_rom={} supported_system_count={}",
                if dry_run {
                    "header-fix simulation completed"
                } else {
                    "header-fix completed"
                },
                input_files.len(),
                repaired_files,
                matched_files,
                unsupported_files,
                failed_files,
                skipped_non_rom,
                BATCH_HEADER_FIX_SYSTEM_PROFILES.len(),
            ),
        };

        let mut report = if failed_files > 0 {
            OperationReport::failed(
                OperationFamily::Command,
                Some("header-fix".to_string()),
                "fix",
                format!(
                    "{summary}; first_error={}",
                    first_error.unwrap_or_else(|| "(none)".to_string())
                ),
                thread_execution.clone(),
            )
        } else {
            OperationReport::succeeded(
                OperationFamily::Command,
                Some("header-fix".to_string()),
                "fix",
                summary,
                Some(100.0),
                thread_execution.clone(),
            )
        };
        if !emitted_files.is_empty() {
            report = Self::attach_emitted_files_details(report, emitted_files, Some("rom"));
        }

        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        details.insert(
            "batch_header_fixer".to_string(),
            json!({
                "supported_system_count": BATCH_HEADER_FIX_SYSTEM_PROFILES.len(),
                "supported_profiles": BATCH_HEADER_FIX_SYSTEM_PROFILES,
                "processed_files": input_files.len(),
                "repaired_files": repaired_files,
                "matched_files": matched_files,
                "unsupported_files": unsupported_files,
                "failed_files": failed_files,
                "skipped_non_rom": skipped_non_rom,
                "dry_run": dry_run,
                "in_place": in_place,
                "repaired_profiles": repaired_profiles,
                "matched_profiles": matched_profiles,
            }),
        );
        report.details = Some(Value::Object(details));
        self.finish("batch-header-fixer", report)
    }
}
/* jscpd:ignore-end */
