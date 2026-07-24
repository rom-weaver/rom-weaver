use super::checksum_streaming::ChecksumStreamOptions;
use super::*;

impl CliApp {
    pub(super) fn run_checksum(&self, mut args: ChecksumCommand) -> AppRunOutcome {
        let _stdin_guard = match crate::stdin_input::spool_stdin_if_dash(&mut args.input) {
            Ok(guard) => guard,
            Err(error) => {
                return self.finish(
                    "checksum",
                    OperationReport::failed(
                        OperationFamily::Checksum,
                        Some(self.checksum.name().to_string()),
                        "read",
                        format!("failed to read stdin input: {error}"),
                        None,
                    ),
                );
            }
        };
        let probe = args.probe;
        let mut report = self.run_checksum_inner(args);
        if probe {
            report = Self::apply_checksum_probe_gate(report);
        }
        self.finish("checksum", report)
    }

    /// Compute the checksum report (every path returns the report instead of finishing,
    /// so [`run_checksum`](Self::run_checksum) can apply the `--probe` fail-on-unidentified
    /// gate before the single terminal `finish`).
    fn run_checksum_inner(&self, args: ChecksumCommand) -> OperationReport {
        let rom_filter = args.rom_filter();
        let patch_filter = args.patch_filter();
        trace!(
            source = %args.input.display(),
            algorithm_count = args.algo.len(),
            selections = args.select.len(),
            rom_filter,
            patch_filter,
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_trim_fix = args.no_trim_fix,
            start = ?args.start,
            length = ?args.length,
            threads = %args.threads,
            "starting checksum command"
        );
        let ChecksumCommand {
            input: source,
            algo,
            select,
            filter: _,
            no_extract,
            no_ignore,
            no_trim_fix,
            start,
            length,
            // Consumed by the `run_checksum` wrapper before the inner body runs.
            probe: _,
            threads,
        } = args;
        let kind_filter = Self::archive_entry_kind_filter(rom_filter, patch_filter);
        let context = self.context(threads);
        let thread_execution =
            Some(context.plan_threads(ThreadCapability::parallel(Some(algo.len().max(1)))));
        if let Some(report) = self.require_readable_path(
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            &source,
            thread_execution.clone(),
        ) {
            return report;
        }

        let invalid = algo.iter().find(|algo| {
            !supported_algorithms()
                .iter()
                .any(|supported| supported.eq_ignore_ascii_case(algo))
        });
        if let Some(invalid) = invalid {
            return OperationReport::failed(
                OperationFamily::Checksum,
                Some(self.checksum.name().to_string()),
                "validate",
                format!("unsupported checksum algorithm `{invalid}`"),
                thread_execution,
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
            Ok(Some(report)) => return report,
            Ok(None) => {}
            Err(error) => {
                return OperationReport::failed(
                    OperationFamily::Checksum,
                    Some(self.checksum.name().to_string()),
                    "checksum",
                    error.to_string(),
                    thread_execution.clone(),
                );
            }
        }

        match self.try_run_checksum_tar_stream_auto_extract(
            &source,
            &checksum_options,
            &context,
            thread_execution.clone(),
        ) {
            Ok(Some(report)) => return report,
            Ok(None) => {}
            Err(error) => {
                return OperationReport::failed(
                    OperationFamily::Checksum,
                    Some(self.checksum.name().to_string()),
                    "checksum",
                    error.to_string(),
                    thread_execution.clone(),
                );
            }
        }

        if let Some(stream_format) =
            self.select_streamed_checksum_auto_extract_format(&source, &checksum_options)
        {
            return self
                .run_checksum_stream_auto_extract(
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
                });
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
                return OperationReport::failed(
                    OperationFamily::Checksum,
                    Some(self.checksum.name().to_string()),
                    "prepare",
                    error.to_string(),
                    thread_execution,
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
                "checksum",
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
        if !variants_enabled {
            // The variant engine already detected identity from the streamed prefix
            // (no extra read); only the range/plain path needs the fallback read.
            Self::attach_rom_identity_details(&mut report, &request.source);
        }
        Self::cleanup_temp_paths(&temp_paths);
        report
    }

    /// `--probe` gate: a succeeded checksum whose details carry no resolved platform
    /// (`platform`/`disc_format`) is failed. Plain checksum happily hashes unidentified
    /// bytes; `--probe` callers (the input section) want unknown inputs rejected. Identity
    /// is already attached during the run (streamed on the variant path, fallback read on
    /// the range path), so this never reads the source again.
    fn apply_checksum_probe_gate(report: OperationReport) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }
        let has_identity = report
            .details
            .as_ref()
            .and_then(serde_json::Value::as_object)
            .is_some_and(|map| map.contains_key("platform") || map.contains_key("disc_format"));
        if has_identity {
            return report;
        }
        OperationReport::failed(
            report.family,
            report.format.clone(),
            "probe",
            "probe: source did not resolve to a known platform",
            report.thread_execution.clone(),
        )
    }

    /// Augment a succeeded checksum report's `details` with the resolved source's
    /// console + optical medium (a bounded prefix read; no exact-title lookup).
    /// The resolved source is decoded bytes - a bare ROM or an extracted track -
    /// so prefix-based detection sees real header/system-area data.
    pub(super) fn attach_rom_identity_details(
        report: &mut OperationReport,
        source: &std::path::Path,
    ) {
        if report.status != OperationStatus::Succeeded {
            return;
        }
        let identity = rom_weaver_checksum::detect_rom_identity_for_path(source);
        if identity.is_empty() {
            return;
        }
        let mut details = match report.details.take() {
            Some(serde_json::Value::Object(map)) => map,
            // Checksum details are always an object; leave anything else untouched.
            Some(other) => {
                report.details = Some(other);
                return;
            }
            None => serde_json::Map::new(),
        };
        identity.write_into(&mut details);
        report.details = Some(serde_json::Value::Object(details));
    }
}
