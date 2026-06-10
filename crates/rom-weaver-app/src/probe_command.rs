use super::*;

impl CliApp {
    pub(super) fn run_probe(&self, args: ProbeCommand) -> AppRunOutcome {
        let ProbeCommand {
            source,
            select,
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
        } = args;
        let kind_filter = Self::archive_entry_kind_filter(rom_filter, patch_filter);
        trace!(
            source = %source.display(),
            selections = select.len(),
            rom_filter,
            patch_filter,
            no_extract,
            no_ignore,
            "starting probe command"
        );
        let context = self.context(ThreadBudget::Fixed(1));
        if let Some(report) =
            self.require_existing_path("probe", OperationFamily::Command, None, &source, None)
        {
            return self.finish("probe", report);
        }

        let resolved = if !no_extract {
            let labels = AutoExtractResolutionLabels {
                command: "probe",
                family: OperationFamily::Command,
                format: None,
                source_label: "probe",
                temp_prefix: "probe-extract",
            };
            self.resolve_source_with_auto_extract(
                &source,
                &select,
                &context,
                labels,
                AutoExtractResolutionFlags {
                    no_extract: false,
                    no_ignore,
                    kind_filter,
                    stop_on_disc_image_codec: true,
                },
            )
        } else {
            Ok(ResolvedChecksumSource {
                source: source.clone(),
                extracted_archives: 0,
                cleanup_paths: Vec::new(),
            })
        };
        let ResolvedChecksumSource {
            source: probe_source,
            extracted_archives,
            cleanup_paths,
        } = match resolved {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "probe",
                    OperationReport::failed(
                        OperationFamily::Command,
                        None,
                        "prepare",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    ),
                );
            }
        };
        let probe_recommendation = self.probe_compress_recommendation(&probe_source);

        self.emit_running(
            OperationLabel {
                command: "probe",
                family: OperationFamily::Command,
                format: None,
            },
            "probe",
            format!("probing handlers for `{}`", probe_source.display()),
            Some(0.0),
            None,
        );

        if let Some(handler) = self.containers.probe(&probe_source) {
            self.emit_running(
                OperationLabel {
                    command: "probe",
                    family: OperationFamily::Container,
                    format: Some(handler.descriptor().name),
                },
                "probe",
                format!("probing `{}`", probe_source.display()),
                Some(0.0),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            let request = ContainerProbeRequest {
                source: probe_source.clone(),
                split_bin: false,
            };
            let mut report = handler
                .probe_details(&request, &context)
                .unwrap_or_else(|error| {
                    OperationReport::failed(
                        OperationFamily::Container,
                        Some(handler.descriptor().name.to_string()),
                        "probe",
                        error.to_string(),
                        None,
                    )
                });
            if !self.emit_progress_events {
                report =
                    Self::append_recommended_compress_label(report, probe_recommendation.as_ref());
            }
            report =
                Self::attach_container_probe_details(report, None, probe_recommendation.as_ref());
            return self.finish_probe(report, extracted_archives, cleanup_paths);
        }

        if let Some(handler) = self.patches.probe(&probe_source) {
            self.emit_running(
                OperationLabel {
                    command: "probe",
                    family: OperationFamily::Patch,
                    format: Some(handler.descriptor().name),
                },
                "probe",
                format!("parsing `{}`", probe_source.display()),
                Some(0.0),
                None,
            );
            let mut report = handler
                .parse(&probe_source, &context)
                .unwrap_or_else(|error| {
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some(handler.descriptor().name.to_string()),
                        "probe",
                        error.to_string(),
                        None,
                    )
                });
            if !self.emit_progress_events {
                report =
                    Self::append_recommended_compress_label(report, probe_recommendation.as_ref());
            }
            return self.finish_probe(
                Self::attach_patch_probe_details(report),
                extracted_archives,
                cleanup_paths,
            );
        }

        if let Some(reason) = explicitly_unsupported_patch_reason_for_path(&probe_source) {
            let mut report = OperationReport::failed(
                OperationFamily::Patch,
                Some("PDS".to_string()),
                "probe",
                format!(
                    "patch format for `{}` is explicitly not supported: {reason}",
                    probe_source.display()
                ),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            if !self.emit_progress_events {
                report =
                    Self::append_recommended_compress_label(report, probe_recommendation.as_ref());
            }
            return self.finish_probe(report, extracted_archives, cleanup_paths);
        }

        if let Ok(Some(header_match)) = Self::detect_known_rom_header(&probe_source) {
            let mut report = OperationReport::succeeded(
                OperationFamily::Command,
                Some("rom-header".to_string()),
                "probe",
                format!(
                    "detected ROM header {}; stripped_bytes={}; headered_extension={}; headerless_extension={}",
                    header_match.profile_name(),
                    header_match
                        .stripped_bytes()
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "n/a".to_string()),
                    header_match.header.headered_extension(),
                    header_match.header.headerless_extension()
                ),
                Some(100.0),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            if !self.emit_progress_events {
                report =
                    Self::append_recommended_compress_label(report, probe_recommendation.as_ref());
            }
            return self.finish_probe(report, extracted_archives, cleanup_paths);
        }

        let mut report = OperationReport::failed(
            OperationFamily::Command,
            None,
            "probe",
            format!("no registered handler matched `{}`", probe_source.display()),
            None,
        );
        if !self.emit_progress_events {
            report = Self::append_recommended_compress_label(report, probe_recommendation.as_ref());
        }
        self.finish_probe(report, extracted_archives, cleanup_paths)
    }

    pub(super) fn finish_probe(
        &self,
        mut report: OperationReport,
        extracted_archives: usize,
        cleanup_paths: Vec<PathBuf>,
    ) -> AppRunOutcome {
        if report.status == OperationStatus::Succeeded && extracted_archives > 0 {
            report.label = format!(
                "{}; probe source resolved via {extracted_archives} container extract step(s)",
                report.label
            );
        }
        Self::cleanup_temp_paths(cleanup_paths);
        self.finish("probe", report)
    }
}
