use super::*;

impl CliApp {
    pub(super) fn run_probe(&self, mut args: ProbeCommand) -> AppRunOutcome {
        let _stdin_guard = match crate::stdin_input::spool_stdin_if_dash(&mut args.input) {
            Ok(guard) => guard,
            Err(error) => {
                return self.finish(
                    "probe",
                    OperationReport::failed(
                        OperationFamily::Command,
                        None,
                        "read",
                        format!("failed to read stdin input: {error}"),
                        None,
                    ),
                );
            }
        };
        let rom_filter = args.rom_filter();
        let patch_filter = args.patch_filter();
        let ProbeCommand {
            input: source,
            select,
            filter: _,
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
            self.require_readable_path("probe", OperationFamily::Command, None, &source, None)
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
                        context.single_thread_execution(),
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
                context.single_thread_execution(),
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
            // Enumerate the container's selectable entries (a cheap, decompression-free
            // central-directory/header scan) so probe is a strict superset of the former `list`
            // command. Honors the same `rom_filter`/`patch_filter`/`no_ignore` semantics: payload
            // matches win, falling back to container entries when no payload matches.
            let listed_entries =
                handler
                    .list_entry_records(&request, &context)
                    .ok()
                    .map(|entries| {
                        let (payload_entries, fallback_entries) =
                            Self::kind_filtered_container_list_entries(
                                &entries,
                                kind_filter,
                                !no_ignore,
                            );
                        if payload_entries.is_empty() {
                            fallback_entries
                        } else {
                            payload_entries
                        }
                    });
            report = Self::attach_container_probe_details(
                report,
                listed_entries,
                probe_recommendation.as_ref(),
            );
            // Console + optical medium of the resolved (decoded) source, from a bounded
            // prefix read - the same identity detection checksum/extract surface, now in
            // the probe path so platform identify lives with probe (no-op for archives
            // and other inputs with no on-disc signature).
            Self::attach_rom_identity_details(&mut report, &probe_source);
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
                context.single_thread_execution(),
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
                context.single_thread_execution(),
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
        Self::cleanup_temp_paths(&cleanup_paths);
        self.finish("probe", report)
    }
}
