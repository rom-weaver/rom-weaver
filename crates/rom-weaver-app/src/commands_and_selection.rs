use super::checksum_streaming::ChecksumStreamOptions;
use super::selection_resolution::{SelectionExtract, SelectionResolutionOptions};
use super::*;

impl CliApp {
    pub(super) fn new(
        reporter: Arc<dyn ProgressSink>,
        prompter: Arc<dyn SelectionPrompter>,
        emit_progress_events: bool,
        interactive_selection_enabled: bool,
    ) -> Self {
        Self {
            reporter,
            prompter,
            emit_progress_events,
            interactive_selection_enabled,
            containers: ContainerRegistry::new(),
            patches: PatchRegistry::new(),
            checksum: NativeChecksumEngine,
        }
    }

    pub(super) fn run(&self, command: Commands) -> AppRunOutcome {
        let command_name = Self::command_name(&command);
        trace!(command = command_name, "dispatching CLI command");
        match command {
            Commands::Probe(args) => self.run_probe(args),
            Commands::List(args) => self.run_list(args),
            Commands::Extract(args) => self.run_extract(args),
            Commands::Checksum(args) => self.run_checksum(args),
            Commands::Compress(args) => self.run_compress(args),
            Commands::Trim(args) => self.run_trim(args),
            Commands::BatchHeaderFixer(args) => self.run_batch_header_fixer(args),
            Commands::Patch(command) => match command {
                PatchCommands::Apply(args) => self.run_patch_apply(args),
                PatchCommands::Validate(args) => self.run_patch_validate(args),
                PatchCommands::CreateCandidates(args) => self.run_patch_create_candidates(args),
                PatchCommands::Create(args) => self.run_patch_create(args),
            },
        }
    }

    pub(super) fn command_name(command: &Commands) -> &'static str {
        match command {
            Commands::Probe(_) => "probe",
            Commands::List(_) => "list",
            Commands::Extract(_) => "extract",
            Commands::Checksum(_) => "checksum",
            Commands::Compress(_) => "compress",
            Commands::Trim(_) => "trim",
            Commands::BatchHeaderFixer(_) => "batch-header-fixer",
            Commands::Patch(PatchCommands::Apply(_)) => "patch-apply",
            Commands::Patch(PatchCommands::Validate(_)) => "patch-validate",
            Commands::Patch(PatchCommands::CreateCandidates(_)) => "patch-create-candidates",
            Commands::Patch(PatchCommands::Create(_)) => "patch-create",
        }
    }

    /// Note that `--split-bin` was ignored when listing a container that does not support it (only
    /// CHD CD listing honors split CUE + per-track BIN output).
    pub(super) fn attach_split_bin_list_note(
        mut report: OperationReport,
        handler: &dyn ContainerHandler,
        split_bin: bool,
    ) -> OperationReport {
        if split_bin && !handler.descriptor().matches_name("chd") {
            report.label = format!(
                "{}; ignored --split-bin for non-CHD input `{}`",
                report.label,
                handler.descriptor().name
            );
        }
        report
    }

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
        let report = OperationReport::succeeded(
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
        Self::attach_container_probe_details(
            report,
            Some(entries),
            self.probe_compress_recommendation(source).as_ref(),
        )
    }

    pub(super) fn run_extract(&self, args: ExtractCommand) -> AppRunOutcome {
        trace!(
            source = %args.source.display(),
            selections = args.select.len(),
            out_dir = %args.out_dir.display(),
            split_bin = args.split_bin,
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            no_ignore = args.no_ignore,
            no_nested_extract = args.no_nested_extract,
            no_overwrite = args.no_overwrite,
            threads = %args.threads,
            "starting extract command"
        );
        let ExtractCommand {
            source,
            select: selections,
            rom_filter,
            patch_filter,
            out_dir,
            split_bin,
            no_ignore,
            no_nested_extract,
            no_overwrite,
            checksum,
            threads,
        } = args;
        let kind_filter = Self::archive_entry_kind_filter(rom_filter, patch_filter);
        let out_dir_before = Self::snapshot_file_tree(&out_dir).unwrap_or_default();
        let context = self
            .context(threads)
            .with_extract_checksum_algorithms(checksum);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        if let Some(report) = self.require_existing_path(
            "extract",
            OperationFamily::Container,
            None,
            &source,
            probe_threads.clone(),
        ) {
            return self.finish("extract", report);
        }

        let Some(handler) = self.containers.probe(&source) else {
            return self.finish(
                "extract",
                OperationReport::failed(
                    OperationFamily::Container,
                    None,
                    "probe",
                    format!("no registered container matched `{}`", source.display()),
                    probe_threads,
                ),
            );
        };

        let (extract_split_bin, split_bin_warning) =
            if split_bin && !handler.descriptor().matches_name("chd") {
                (
                    false,
                    Some(format!(
                        "ignored --split-bin for non-CHD input; matched `{}`",
                        handler.descriptor().name
                    )),
                )
            } else {
                (split_bin, None)
            };
        let extract_threads = Some(context.plan_threads(handler.capabilities().extract_threads));
        // When interactive selection is enabled and the caller did not pin an entry, extract a single
        // payload path instead of every entry: auto-pick when unambiguous, otherwise prompt the host
        // (the same resolution is applied per nested level during the descent below). This is what lets
        // the browser "just extract" with no separate `list` command.
        let selections = if self.interactive_selection_enabled && selections.is_empty() {
            match self.resolve_single_payload_selection(
                handler.as_ref(),
                &source,
                SelectionResolutionOptions {
                    kind_filter,
                    split_bin: extract_split_bin,
                    ignore_common_files: !no_ignore,
                    source_label: "extract input",
                },
                &context,
            ) {
                Ok(Some(entry)) => vec![entry],
                Ok(None) => selections,
                Err(error) => {
                    return self.finish(
                        "extract",
                        OperationReport::failed(
                            OperationFamily::Container,
                            Some(handler.descriptor().name.to_string()),
                            "extract",
                            error.to_string(),
                            extract_threads.clone(),
                        ),
                    );
                }
            }
        } else {
            selections
        };
        self.emit_running(
            OperationLabel {
                command: "extract",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "extract",
            format!("extracting `{}`", source.display()),
            None,
            extract_threads.clone(),
        );
        self.emit_running(
            OperationLabel {
                command: "extract",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "extract",
            format!("preparing extraction for `{}`", source.display()),
            None,
            extract_threads.clone(),
        );
        let mut report = self
            .extract_with_selection_fallback(
                handler.as_ref(),
                &source,
                SelectionExtract {
                    out_dir: &out_dir,
                    selections: &selections,
                    kind_filter,
                    split_bin: extract_split_bin,
                    ignore_common_files: !no_ignore,
                    overwrite: !no_overwrite,
                    source_label: "extract input",
                },
                &context,
            )
            .unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "extract",
                    error.to_string(),
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                )
            });
        let mut warnings = Vec::new();
        if let Some(split_bin_warning) = split_bin_warning {
            warnings.push(split_bin_warning);
        }
        if !warnings.is_empty() {
            report.label = format!("{}; warning={}", report.label, warnings.join("; "));
        }
        let mut primary_emitted_files = Vec::new();
        if report.status == OperationStatus::Succeeded {
            match Self::collect_changed_files(&out_dir, &out_dir_before) {
                Ok(emitted_files) => {
                    primary_emitted_files = emitted_files;
                }
                Err(error) => {
                    trace!(
                        out_dir = %out_dir.display(),
                        error = %error,
                        "failed to collect primary extract emitted output metadata"
                    );
                }
            }
        }
        if report.status == OperationStatus::Succeeded {
            let format_name = handler.descriptor().name;
            // Level 0 (the input container itself). Its outputs carry the inline checksums computed
            // by the handler when `--checksum` was requested.
            let primary_details = Self::build_emitted_file_detail_values(
                report.details.as_ref(),
                &primary_emitted_files,
                None,
            );
            self.emit_extract_step(ExtractStepEvent {
                format: format_name,
                depth: 0,
                source: &source,
                out_dir: &out_dir,
                step_status: "succeeded",
                outputs: &primary_details,
                thread_execution: report.thread_execution.clone(),
            });
            let mut all_emitted_details = primary_details;
            // Canonical paths (normalized) of every container we descended into; these are the
            // intermediate archives, so they are excluded from the final leaf output set.
            let mut descended: HashSet<String> = HashSet::new();
            if !no_nested_extract {
                self.emit_running(
                    OperationLabel {
                        command: "extract",
                        family: OperationFamily::Container,
                        format: Some(format_name),
                    },
                    "nested-extract",
                    "checking nested archives in extracted outputs".to_string(),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                match self.extract_nested_archives(
                    &source,
                    &primary_emitted_files,
                    kind_filter,
                    !no_ignore,
                    !no_overwrite,
                    &context,
                ) {
                    Ok(outcome) => {
                        descended = outcome.descended;
                        all_emitted_details.extend(outcome.emitted_details);
                        if outcome.count > 0 {
                            report.label = format!(
                                "{}; recursively extracted {} nested container(s)",
                                report.label, outcome.count
                            );
                        }
                    }
                    Err(error) => {
                        report = OperationReport::failed(
                            OperationFamily::Container,
                            Some(format_name.to_string()),
                            "extract",
                            error.to_string(),
                            Some(context.plan_threads(ThreadCapability::single_threaded())),
                        );
                    }
                }
            }
            if report.status == OperationStatus::Succeeded {
                // Report only the bottom/leaf outputs: any emitted file we did not further descend
                // into. For a non-nested extract `descended` is empty, so every primary output is a
                // leaf and the result is identical to the previous single-level behaviour.
                let leaves = all_emitted_details
                    .into_iter()
                    .filter(|value| {
                        match value
                            .as_object()
                            .and_then(|map| map.get("path"))
                            .and_then(Value::as_str)
                        {
                            Some(path) => !descended.contains(path),
                            None => true,
                        }
                    })
                    .collect::<Vec<_>>();
                report = Self::set_emitted_files_detail(report, leaves);
            }
        }
        self.finish("extract", report)
    }

    pub(super) fn run_checksum(&self, args: ChecksumCommand) -> AppRunOutcome {
        trace!(
            source = %args.source.display(),
            algorithm_count = args.algo.len(),
            selections = args.select.len(),
            rom_filter = args.rom_filter,
            patch_filter = args.patch_filter,
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            strip_header = args.strip_header,
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
            strip_header,
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
            strip_header,
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
                no_extract: no_extract || strip_header,
                no_ignore,
                kind_filter,
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
        let mut stripped_header_match = None;
        let mut stripped_header_offset = 0_u64;
        let mut trimmed_plan = None;
        let user_requested_range = start.is_some() || length.is_some();
        let mut start = start;
        let mut length = length;
        let should_auto_trim_fix = !no_trim_fix && !user_requested_range;
        if strip_header {
            self.emit_running(
                OperationLabel {
                    command: "checksum",
                    family: OperationFamily::Checksum,
                    format: Some(self.checksum.name()),
                },
                "prepare",
                "stripping ROM header before checksum",
                None,
                thread_execution.clone(),
            );
            match Self::detect_strippable_rom_header(&resolved_source) {
                Ok(header_match) => {
                    stripped_header_offset =
                        u64::try_from(header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES))
                            .unwrap_or(ROM_HEADER_BYTES as u64);
                    stripped_header_match = Some(header_match);
                    let translated_start = start.unwrap_or(0).checked_add(stripped_header_offset);
                    let Some(translated_start) = translated_start else {
                        return self.finish(
                            "checksum",
                            OperationReport::failed(
                                OperationFamily::Checksum,
                                Some(self.checksum.name().to_string()),
                                "validate",
                                "checksum range start overflows after header stripping",
                                thread_execution,
                            ),
                        );
                    };
                    start = Some(translated_start);
                }
                Err(error) => {
                    return self.finish(
                        "checksum",
                        OperationReport::failed(
                            OperationFamily::Checksum,
                            Some(self.checksum.name().to_string()),
                            "validate",
                            error.to_string(),
                            thread_execution,
                        ),
                    );
                }
            }
        }
        let checksum_source = resolved_source.clone();
        if should_auto_trim_fix {
            self.emit_running(
                OperationLabel {
                    command: "checksum",
                    family: OperationFamily::Checksum,
                    format: Some(self.checksum.name()),
                },
                "prepare",
                "resolving trim boundary before checksum",
                None,
                thread_execution.clone(),
            );
            if let Ok(plan) =
                self.read_checksum_trim_plan_with_offset(&checksum_source, stripped_header_offset)
            {
                start = Some(stripped_header_offset);
                length = Some(plan.trimmed_size);
                trimmed_plan = Some(plan);
            }
        }
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
        let header_only_translated_range = strip_header
            && !user_requested_range
            && !should_auto_trim_fix
            && stripped_header_offset > 0
            && request.start == Some(stripped_header_offset)
            && request.length.is_none();
        let checksum_stage = if (request.start.is_some() || request.length.is_some())
            && !header_only_translated_range
        {
            "checksum-range"
        } else {
            "checksum"
        };
        let checksum_algorithm_count = request.algorithms.len();
        let mut report = self
            .checksum
            .checksum_report_with_progress(&request, &context, checksum_stage, &mut |progress| {
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
            })
            .unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Checksum,
                    Some(self.checksum.name().to_string()),
                    "checksum",
                    error.to_string(),
                    Some(
                        context.plan_threads(ThreadCapability::parallel(Some(
                            request.algorithms.len(),
                        ))),
                    ),
                )
            });
        if report.status == OperationStatus::Succeeded {
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
            if let Some(plan) = trimmed_plan {
                report.label = format!(
                    "{}; trimmed_input_bytes={} mode={} preserved_download_play_cert={}",
                    report.label, plan.trimmed_size, plan.mode, plan.preserved_download_play_cert
                );
            }
            if extracted_archives > 0 {
                report.label = format!(
                    "{}; checksum source resolved via {extracted_archives} container extract step(s)",
                    report.label
                );
            }
        }
        Self::cleanup_temp_paths(temp_paths);
        self.finish("checksum", report)
    }
}
