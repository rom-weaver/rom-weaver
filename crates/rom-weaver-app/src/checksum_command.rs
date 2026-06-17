use super::checksum_streaming::ChecksumStreamOptions;
use super::*;

impl CliApp {
    pub(super) fn run_checksum(&self, args: ChecksumCommand) -> AppRunOutcome {
        trace!(
            source = %args.source.display(),
            algorithm_count = args.algo.len(),
            selections = args.select.len(),
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_trim_fix = args.no_trim_fix,
            start = ?args.start,
            length = ?args.length,
            threads = %args.threads,
            "starting checksum command"
        );
        let ChecksumCommand {
            source,
            algo,
            select,
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
            no_trim_fix,
            start,
            length,
            threads,
        } = args;
        let kind_filter = Self::archive_entry_kind_filter(rom_filter, patch_filter);
        let context = self.context(threads);
        let thread_execution =
            Some(context.plan_threads(ThreadCapability::parallel(Some(algo.len().max(1)))));
        if let Some(report) = self.require_existing_path(
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            &source,
            thread_execution.clone(),
        ) {
            return self.finish("checksum", report);
        }

        let invalid = algo.iter().find(|algo| {
            !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(algo))
        });
        if let Some(invalid) = invalid {
            return self.finish(
                "checksum",
                OperationReport::failed(
                    OperationFamily::Checksum,
                    Some(self.checksum.name().to_string()),
                    "validate",
                    format!("unsupported checksum algorithm `{invalid}`"),
                    thread_execution,
                ),
            );
        }

        let checksum_options = ChecksumStreamOptions {
            algo: &algo,
            select: &select,
            kind_filter,
            no_extract,
            no_ignore,
            no_trim_fix,
            start,
            length,
        };

        match self.try_run_checksum_chd_raw_sha1_fast_path(
            &source,
            &checksum_options,
            &context,
            thread_execution.clone(),
        ) {
            Ok(Some(report)) => return self.finish("checksum", report),
            Ok(None) => {}
            Err(error) => {
                return self.finish(
                    "checksum",
                    OperationReport::failed(
                        OperationFamily::Checksum,
                        Some(self.checksum.name().to_string()),
                        "checksum",
                        error.to_string(),
                        thread_execution.clone(),
                    ),
                );
            }
        }

        match self.try_run_checksum_tar_stream_auto_extract(
            &source,
            &checksum_options,
            &context,
            thread_execution.clone(),
        ) {
            Ok(Some(report)) => return self.finish("checksum", report),
            Ok(None) => {}
            Err(error) => {
                return self.finish(
                    "checksum",
                    OperationReport::failed(
                        OperationFamily::Checksum,
                        Some(self.checksum.name().to_string()),
                        "checksum",
                        error.to_string(),
                        thread_execution.clone(),
                    ),
                );
            }
        }

        if let Some(stream_format) =
            self.select_streamed_checksum_auto_extract_format(&source, &checksum_options)
        {
            return self.finish(
                "checksum",
                self.run_checksum_stream_auto_extract(
                    &source,
                    stream_format,
                    &algo,
                    &context,
                    thread_execution.clone(),
                )
                .unwrap_or_else(|error| {
                    OperationReport::failed(
                        OperationFamily::Checksum,
                        Some(self.checksum.name().to_string()),
                        "checksum",
                        error.to_string(),
                        thread_execution.clone(),
                    )
                }),
            );
        }

        let resolved = match self.resolve_source_with_auto_extract(
            &source,
            &select,
            &context,
            AutoExtractResolutionLabels {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
                source_label: "checksum",
                temp_prefix: "checksum-extract",
            },
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter,
                stop_on_disc_image_codec: false,
            },
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "checksum",
                    OperationReport::failed(
                        OperationFamily::Checksum,
                        Some(self.checksum.name().to_string()),
                        "prepare",
                        error.to_string(),
                        thread_execution,
                    ),
                );
            }
        };
        let ResolvedChecksumSource {
            source: resolved_source,
            extracted_archives,
            mut cleanup_paths,
        } = resolved;

        self.emit_running(
            OperationLabel {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
            },
            "checksum",
            format!("computing {} checksum algorithm(s)", algo.len()),
            Some(0.0),
            thread_execution.clone(),
        );

        let mut temp_paths = Vec::new();
        // The checksum command always hashes the full file so its output matches the inline checksum
        // computed during extract (extract has no trim step). A trimmed-boundary checksum is a
        // separate concern handled by the `trim` command, not folded into the primary value here.
        let user_requested_range = start.is_some() || length.is_some();
        let checksum_source = resolved_source.clone();
        temp_paths.append(&mut cleanup_paths);
        let request = ChecksumRequest {
            source: checksum_source,
            algorithms: algo
                .into_iter()
                .map(|algorithm| algorithm.to_ascii_lowercase())
                .collect(),
            start,
            length,
        };
        let checksum_stage = if request.start.is_some() || request.length.is_some() {
            "checksum-range"
        } else {
            "checksum"
        };
        let checksum_algorithm_count = request.algorithms.len();
        let variants_enabled = !user_requested_range;
        let mut report = if variants_enabled {
            self.run_checksum_variants_with_progress(
                &request,
                &context,
                checksum_stage,
                &mut |progress| {
                    self.emit_running(
                        OperationLabel {
                            command: "checksum",
                            family: OperationFamily::Checksum,
                            format: Some(self.checksum.name()),
                        },
                        "checksum",
                        format!(
                            "computing {} checksum algorithm(s)",
                            checksum_algorithm_count
                        ),
                        Some(progress.percent()),
                        thread_execution.clone(),
                    );
                },
            )
        } else {
            self.checksum.checksum_report_with_progress(
                &request,
                &context,
                checksum_stage,
                &mut |progress| {
                    self.emit_running(
                        OperationLabel {
                            command: "checksum",
                            family: OperationFamily::Checksum,
                            format: Some(self.checksum.name()),
                        },
                        "checksum",
                        format!(
                            "computing {} checksum algorithm(s)",
                            checksum_algorithm_count
                        ),
                        Some(progress.percent()),
                        thread_execution.clone(),
                    );
                },
            )
        }
        .unwrap_or_else(|error| {
            OperationReport::failed(
                OperationFamily::Checksum,
                Some(self.checksum.name().to_string()),
                "checksum",
                error.to_string(),
                Some(
                    context
                        .plan_threads(ThreadCapability::parallel(Some(request.algorithms.len()))),
                ),
            )
        });
        if report.status == OperationStatus::Succeeded && extracted_archives > 0 {
            report.label = format!(
                "{}; checksum source resolved via {extracted_archives} container extract step(s)",
                report.label
            );
        }
        Self::cleanup_temp_paths(&temp_paths);
        self.finish("checksum", report)
    }
}
