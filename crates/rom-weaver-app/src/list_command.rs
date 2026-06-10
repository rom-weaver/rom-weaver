use super::*;

impl CliApp {
    pub(super) fn run_list(&self, args: ListCommand) -> AppRunOutcome {
        let ListCommand {
            source,
            select,
            rom_filter,
            patch_filter,
            no_ignore,
            split_bin,
        } = args;
        let kind_filter = Self::archive_entry_kind_filter(rom_filter, patch_filter);
        trace!(
            source = %source.display(),
            selections = select.len(),
            rom_filter,
            patch_filter,
            no_ignore,
            split_bin,
            "starting list command"
        );
        let context = self.context(ThreadBudget::Fixed(1));
        if let Some(report) =
            self.require_existing_path("list", OperationFamily::Command, None, &source, None)
        {
            return self.finish("list", report);
        }

        let labels = AutoExtractResolutionLabels {
            command: "list",
            family: OperationFamily::Command,
            format: None,
            source_label: "list",
            temp_prefix: "list-extract",
        };
        if select.is_empty()
            && kind_filter.enabled()
            && let Some(handler) = self.containers.probe(&source)
        {
            let request = ContainerProbeRequest {
                source: source.clone(),
                split_bin,
            };
            match handler.list_entry_records(&request, &context) {
                Ok(entries) => {
                    let (payload_entries, fallback_entries) =
                        Self::kind_filtered_container_list_entries(
                            &entries,
                            kind_filter,
                            !no_ignore,
                        );
                    let report_entries = if payload_entries.is_empty() {
                        fallback_entries
                    } else {
                        payload_entries
                    };
                    let report = if report_entries.is_empty() {
                        OperationReport::failed(
                            OperationFamily::Container,
                            Some(handler.descriptor().name.to_string()),
                            "list",
                            format!(
                                "no list entries from `{}` matched {}",
                                source.display(),
                                kind_filter.flag_label()
                            ),
                            None,
                        )
                    } else {
                        self.build_container_list_report(
                            handler.as_ref(),
                            &source,
                            report_entries,
                            &context,
                        )
                    };
                    let report =
                        Self::attach_split_bin_list_note(report, handler.as_ref(), split_bin);
                    return self.finish_list(report, 0, Vec::new());
                }
                Err(error) => {
                    let report = OperationReport::failed(
                        OperationFamily::Container,
                        Some(handler.descriptor().name.to_string()),
                        "list",
                        error.to_string(),
                        None,
                    );
                    return self.finish_list(report, 0, Vec::new());
                }
            }
        }
        let resolved = if select.is_empty() && kind_filter.disabled() {
            Ok(ResolvedChecksumSource {
                source: source.clone(),
                extracted_archives: 0,
                cleanup_paths: Vec::new(),
            })
        } else {
            self.resolve_source_with_single_auto_extract(
                &source,
                &select,
                kind_filter,
                no_ignore,
                &context,
                labels,
            )
        };
        let ResolvedChecksumSource {
            source: list_source,
            extracted_archives,
            cleanup_paths,
        } = match resolved {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish(
                    "list",
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

        self.emit_running(
            OperationLabel {
                command: "list",
                family: OperationFamily::Command,
                format: None,
            },
            "probe",
            format!("probing handlers for `{}`", list_source.display()),
            Some(0.0),
            None,
        );

        if let Some(handler) = self.containers.probe(&list_source) {
            let request = ContainerProbeRequest {
                source: list_source.clone(),
                split_bin,
            };
            self.emit_running(
                OperationLabel {
                    command: "list",
                    family: OperationFamily::Container,
                    format: Some(handler.descriptor().name),
                },
                "list",
                format!("listing entries for `{}`", list_source.display()),
                None,
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            let report = match handler.list_entry_records(&request, &context) {
                Ok(entries) => self.build_container_list_report(
                    handler.as_ref(),
                    &list_source,
                    entries,
                    &context,
                ),
                Err(error) => OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "list",
                    error.to_string(),
                    None,
                ),
            };
            let report = Self::attach_split_bin_list_note(report, handler.as_ref(), split_bin);
            return self.finish_list(report, extracted_archives, cleanup_paths);
        }

        if let Some(handler) = self.patches.probe(&list_source) {
            let report = OperationReport::failed(
                OperationFamily::Patch,
                Some(handler.descriptor().name.to_string()),
                "list",
                "list is only supported for container formats",
                None,
            );
            return self.finish_list(report, extracted_archives, cleanup_paths);
        }

        if let Ok(Some(_header_match)) = Self::detect_known_rom_header(&list_source) {
            let report = OperationReport::failed(
                OperationFamily::Command,
                Some("rom-header".to_string()),
                "list",
                "list is only supported for container formats",
                None,
            );
            return self.finish_list(report, extracted_archives, cleanup_paths);
        }

        let report = OperationReport::failed(
            OperationFamily::Command,
            None,
            "probe",
            format!(
                "no registered container handler matched `{}`",
                list_source.display()
            ),
            None,
        );
        self.finish_list(report, extracted_archives, cleanup_paths)
    }

    pub(super) fn finish_list(
        &self,
        mut report: OperationReport,
        extracted_archives: usize,
        cleanup_paths: Vec<PathBuf>,
    ) -> AppRunOutcome {
        if report.status == OperationStatus::Succeeded && extracted_archives > 0 {
            report.label = format!(
                "{}; list source resolved via {extracted_archives} container extract step(s)",
                report.label
            );
        }
        Self::cleanup_temp_paths(cleanup_paths);
        self.finish("list", report)
    }

    pub(super) fn build_container_list_report(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        entries: Vec<ContainerListEntry>,
        context: &OperationContext,
    ) -> OperationReport {
        let mut report = OperationReport::succeeded(
            OperationFamily::Container,
            Some(handler.descriptor().name.to_string()),
            "list",
            format!(
                "listed {} selectable entr{} for `{}`",
                entries.len(),
                if entries.len() == 1 { "y" } else { "ies" },
                source.display()
            ),
            Some(100.0),
            Some(context.plan_threads(ThreadCapability::single_threaded())),
        );
        if handler.descriptor().matches_name("chd") {
            let request = ContainerProbeRequest {
                source: source.to_path_buf(),
                split_bin: false,
            };
            if let Ok(probe_report) = handler.probe_details(&request, context)
                && let Some(Value::Object(mut probe_details)) = probe_report.details
                && let Some(chd_details) = probe_details.remove("chd")
            {
                let mut details = match report.details.take() {
                    Some(Value::Object(map)) => map,
                    _ => Map::new(),
                };
                details.insert("chd".to_string(), chd_details);
                report.details = Some(Value::Object(details));
            }
        }
        Self::attach_container_probe_details(
            report,
            Some(entries),
            self.probe_compress_recommendation(source).as_ref(),
        )
    }
}
