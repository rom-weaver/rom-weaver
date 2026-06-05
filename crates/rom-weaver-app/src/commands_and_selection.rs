/// The destination and selection settings for an extract-with-interactive-fallback call,
/// grouped so the helper takes one descriptor instead of six positional arguments.
#[derive(Clone, Copy)]
struct SelectionExtract<'a> {
    out_dir: &'a Path,
    selections: &'a [String],
    kind_filter: ArchiveEntryKindFilter,
    split_bin: bool,
    ignore_common_files: bool,
    overwrite: bool,
    source_label: &'a str,
}

/// Identifies the inner payload selected from a tar stream for the streamed-checksum fast path.
#[derive(Clone, Copy)]
struct TarStreamCandidate<'a> {
    tar_format: &'a str,
    candidate_name: &'a str,
    candidate_index: usize,
}

/// The checksum command's stream/auto-extract option flags, grouped so the streaming-checksum
/// helpers take one descriptor instead of threading eight individual arguments.
#[derive(Clone, Copy)]
struct ChecksumStreamOptions<'a> {
    algo: &'a [String],
    select: &'a [String],
    kind_filter: ArchiveEntryKindFilter,
    no_extract: bool,
    no_ignore: bool,
    strip_header: bool,
    no_trim_fix: bool,
    start: Option<u64>,
    length: Option<u64>,
}

impl CliApp {
    fn new(
        reporter: Arc<dyn ProgressSink>,
        emit_progress_events: bool,
        interactive_selection_enabled: bool,
    ) -> Self {
        Self {
            reporter,
            emit_progress_events,
            interactive_selection_enabled,
            containers: ContainerRegistry::new(),
            patches: PatchRegistry::new(),
            checksum: NativeChecksumEngine,
        }
    }

    fn run(&self, command: Commands) -> AppRunOutcome {
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

    fn command_name(command: &Commands) -> &'static str {
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

    fn archive_entry_kind_filter(rom_filter: bool, patch_filter: bool) -> ArchiveEntryKindFilter {
        ArchiveEntryKindFilter::new(rom_filter, patch_filter)
    }

    fn kind_filtered_container_list_entries(
        entries: &[ContainerListEntry],
        kind_filter: ArchiveEntryKindFilter,
        ignore_common_files: bool,
    ) -> (Vec<ContainerListEntry>, Vec<ContainerListEntry>) {
        if kind_filter.disabled() {
            return (entries.to_vec(), Vec::new());
        }
        let mut payload_matches = Vec::new();
        let mut container_fallback_matches = Vec::new();
        for entry in entries {
            if ignore_common_files && should_ignore_common_container_file(&entry.path) {
                continue;
            }
            if kind_filter.matches_payload_name(&entry.path) {
                payload_matches.push(entry.clone());
            } else if kind_filter.matches_container_fallback_name(&entry.path) {
                container_fallback_matches.push(entry.clone());
            }
        }
        (payload_matches, container_fallback_matches)
    }

    fn run_probe(&self, args: ProbeCommand) -> AppRunOutcome {
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
            };
            let mut report = handler.probe_details(&request, &context).unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "probe",
                    error.to_string(),
                    None,
                )
            });
            if !self.emit_progress_events {
                report = Self::append_recommended_compress_label(
                    report,
                    probe_recommendation.as_ref(),
                );
            }
            report = Self::attach_container_probe_details(
                report,
                None,
                probe_recommendation.as_ref(),
            );
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
            let mut report = handler.parse(&probe_source, &context).unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "probe",
                    error.to_string(),
                    None,
                )
            });
            if !self.emit_progress_events {
                report = Self::append_recommended_compress_label(
                    report,
                    probe_recommendation.as_ref(),
                );
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
                report = Self::append_recommended_compress_label(
                    report,
                    probe_recommendation.as_ref(),
                );
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
                report = Self::append_recommended_compress_label(
                    report,
                    probe_recommendation.as_ref(),
                );
            }
            return self.finish_probe(report, extracted_archives, cleanup_paths);
        }

        let mut report = OperationReport::failed(
            OperationFamily::Command,
            None,
            "probe",
            format!(
                "no registered handler matched `{}`",
                probe_source.display()
            ),
            None,
        );
        if !self.emit_progress_events {
            report =
                Self::append_recommended_compress_label(report, probe_recommendation.as_ref());
        }
        self.finish_probe(report, extracted_archives, cleanup_paths)
    }

    fn finish_probe(
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

    fn run_list(&self, args: ListCommand) -> AppRunOutcome {
        let ListCommand {
            source,
            select,
            rom_filter,
            patch_filter,
            no_ignore,
        } = args;
        let kind_filter = Self::archive_entry_kind_filter(rom_filter, patch_filter);
        trace!(
            source = %source.display(),
            selections = select.len(),
            rom_filter,
            patch_filter,
            no_ignore,
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
            };
            match handler.list_entry_records(&request, &context) {
                Ok(entries) => {
                    let (payload_entries, fallback_entries) =
                        Self::kind_filtered_container_list_entries(&entries, kind_filter, !no_ignore);
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

    fn finish_list(
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

    fn build_container_list_report(
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

    fn run_extract(&self, args: ExtractCommand) -> AppRunOutcome {
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
        let context = self.context(threads).with_extract_checksum_algorithms(checksum);
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
        if report.status == OperationStatus::Succeeded && !no_nested_extract {
            let progress_execution = report.thread_execution.clone();
            self.emit_running(
                OperationLabel {
                    command: "extract",
                    family: OperationFamily::Container,
                    format: Some(handler.descriptor().name),
                },
                "extract",
                format!("extracting `{}`", source.display()),
                None,
                progress_execution,
            );
            self.emit_running(
                OperationLabel {
                    command: "extract",
                    family: OperationFamily::Container,
                    format: Some(handler.descriptor().name),
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
                Ok(0) => {}
                Ok(nested_count) => {
                    report.label = format!(
                        "{}; recursively extracted {nested_count} nested container(s)",
                        report.label
                    );
                }
                Err(error) => {
                    report = OperationReport::failed(
                        OperationFamily::Container,
                        Some(handler.descriptor().name.to_string()),
                        "extract",
                        error.to_string(),
                        Some(context.plan_threads(ThreadCapability::single_threaded())),
                    );
                }
            }
        }
        if report.status == OperationStatus::Succeeded {
            report = Self::attach_emitted_files_details(report, primary_emitted_files, None);
            self.emit_running(
                OperationLabel {
                    command: "extract",
                    family: OperationFamily::Container,
                    format: Some(handler.descriptor().name),
                },
                "extract",
                format!("finalizing extracted output from `{}`", source.display()),
                None,
                report.thread_execution.clone(),
            );
        }
        self.finish("extract", report)
    }

    fn run_checksum(&self, args: ChecksumCommand) -> AppRunOutcome {
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

        if let Some(stream_format) = self.select_streamed_checksum_auto_extract_format(
            &source,
            &checksum_options,
        ) {
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
        let header_only_translated_range =
            strip_header
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

    fn try_run_checksum_chd_raw_sha1_fast_path(
        &self,
        source: &Path,
        options: &ChecksumStreamOptions,
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<Option<OperationReport>> {
        let ChecksumStreamOptions {
            algo,
            select,
            kind_filter,
            no_extract,
            strip_header,
            no_trim_fix,
            start,
            length,
            ..
        } = *options;
        if self.interactive_selection_enabled
            || no_extract
            || strip_header
            || !no_trim_fix
            || !select.is_empty()
            || start.is_some()
            || length.is_some()
        {
            return Ok(None);
        }
        if algo.len() != 1 || !algo[0].eq_ignore_ascii_case("sha1") {
            return Ok(None);
        }

        let Some(handler) = self.containers.probe(source) else {
            return Ok(None);
        };
        if !handler.descriptor().matches_name("chd") {
            return Ok(None);
        }

        let request = ContainerProbeRequest {
            source: source.to_path_buf(),
        };
        let entries = handler.list_entries(&request, context)?;
        if !Self::chd_raw_sha1_fast_path_entries_supported(&entries) {
            return Ok(None);
        }
        if kind_filter.enabled() && !kind_filter.matches_payload_name(&entries[0]) {
            return Ok(None);
        }

        let report = handler.probe_details(&request, context)?;
        if report.status != OperationStatus::Succeeded {
            return Ok(None);
        }
        let Some(raw_sha1) = Self::extract_chd_raw_sha1_from_probe_details(report.details.as_ref())
        else {
            return Ok(None);
        };
        if !Self::is_valid_sha1_hex(&raw_sha1) {
            return Ok(None);
        }

        Ok(Some(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            "checksum",
            format!("sha1={raw_sha1}; checksum source resolved via chd raw_sha1 fast path"),
            Some(100.0),
            thread_execution,
        )))
    }

    fn chd_raw_sha1_fast_path_entries_supported(entries: &[String]) -> bool {
        if entries.len() != 1 {
            return false;
        }
        let entry = entries[0].to_ascii_lowercase();
        entry.ends_with(".bin") || entry.ends_with(".iso") || entry.ends_with(".img")
    }

    fn extract_chd_raw_sha1_from_probe_details(details: Option<&Value>) -> Option<String> {
        let details = details?;
        let Value::Object(map) = details else {
            return None;
        };
        let Value::Object(chd) = map.get("chd")? else {
            return None;
        };
        let value = chd.get("raw_sha1")?.as_str()?.trim().to_ascii_lowercase();
        if value.is_empty() {
            return None;
        }
        Some(value)
    }

    fn is_valid_sha1_hex(value: &str) -> bool {
        value.len() == 40 && value.chars().all(|ch| ch.is_ascii_hexdigit())
    }

    fn try_run_checksum_tar_stream_auto_extract(
        &self,
        source: &Path,
        options: &ChecksumStreamOptions,
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<Option<OperationReport>> {
        let ChecksumStreamOptions {
            algo,
            select,
            kind_filter,
            no_extract,
            no_ignore,
            strip_header,
            no_trim_fix,
            start,
            length,
        } = *options;
        if no_extract || strip_header || !select.is_empty() || start.is_some() || length.is_some() {
            return Ok(None);
        }

        let Some(handler) = self.containers.probe(source) else {
            return Ok(None);
        };
        let tar_format = handler.descriptor().name;
        if !matches!(tar_format, "tar" | "tar.gz" | "tar.bz2" | "tar.xz") {
            return Ok(None);
        }

        let Some((candidate_name, candidate_index)) =
            self.select_tar_stream_checksum_candidate(source, tar_format, no_ignore, kind_filter)?
        else {
            return Ok(None);
        };

        if let Some(next_handler) = self.containers.probe(Path::new(&candidate_name))
            && !next_handler.descriptor().matches_name("xiso")
            && next_handler.capabilities().extract
        {
            return Ok(None);
        }

        if !no_trim_fix {
            let candidate_lower = candidate_name.to_ascii_lowercase();
            if self
                .trim_eligible_kind_for_path(Path::new(&candidate_name))
                .is_some()
                || candidate_lower.ends_with(".iso")
            {
                return Ok(None);
            }
        }

        let report = self.run_checksum_tar_stream_auto_extract(
            source,
            TarStreamCandidate {
                tar_format,
                candidate_name: &candidate_name,
                candidate_index,
            },
            algo,
            context,
            thread_execution,
        )?;
        Ok(Some(report))
    }

    fn run_checksum_tar_stream_auto_extract(
        &self,
        source: &Path,
        candidate: TarStreamCandidate,
        algo: &[String],
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<OperationReport> {
        let TarStreamCandidate {
            tar_format,
            candidate_name,
            candidate_index,
        } = candidate;
        trace!(
            source = %source.display(),
            tar_format,
            candidate_name,
            candidate_index,
            algorithm_count = algo.len(),
            "running streamed tar checksum auto-extract fast path"
        );
        self.emit_running(
            OperationLabel {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
            },
            "prepare",
            format!(
                "streaming checksum payload `{candidate_name}` from `{}` ({tar_format})",
                source.display()
            ),
            None,
            thread_execution.clone(),
        );

        let algorithms = algo
            .iter()
            .map(|algorithm| algorithm.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let checksum_algorithm_count = algorithms.len();
        let values = with_regular_archive_file_entry_reader(
            source,
            tar_format,
            candidate_index,
            candidate_name,
            |entry_reader| {
                checksum_reader_values_with_progress(
                    entry_reader,
                    &algorithms,
                    context,
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
            },
        )?;

        let mut label = Self::render_streamed_checksum_label(&algorithms, &values.values);
        label.push_str(&format!(
            "; checksum source streamed from {tar_format} container entry `{candidate_name}`"
        ));
        Ok(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            "checksum",
            label,
            Some(100.0),
            Some(values.execution),
        ))
    }

    fn select_tar_stream_checksum_candidate(
        &self,
        source: &Path,
        tar_format: &str,
        no_ignore: bool,
        kind_filter: ArchiveEntryKindFilter,
    ) -> Result<Option<(String, usize)>> {
        let mut candidates = BTreeMap::new();
        for entry in list_regular_archive_file_entries(source, tar_format)? {
            let ignored = Self::should_ignore_checksum_candidate(&entry.name);
            candidates.insert(entry.name, (entry.index, ignored));
        }

        let selected = if no_ignore {
            candidates
                .into_iter()
                .map(|(name, (index, _ignored))| (name, index))
                .collect::<Vec<_>>()
        } else {
            candidates
                .into_iter()
                .filter_map(|(name, (index, ignored))| (!ignored).then_some((name, index)))
                .collect::<Vec<_>>()
        };
        let selected = if kind_filter.enabled() {
            let mut payload_matches = Vec::new();
            let mut container_fallback_matches = Vec::new();
            for (name, index) in selected {
                if kind_filter.matches_payload_name(&name) {
                    payload_matches.push((name, index));
                } else if kind_filter.matches_container_fallback_name(&name) {
                    container_fallback_matches.push((name, index));
                }
            }
            if payload_matches.is_empty() {
                container_fallback_matches
            } else {
                payload_matches
            }
        } else {
            selected
        };
        if selected.len() != 1 {
            return Ok(None);
        }

        Ok(selected.into_iter().next())
    }

    fn select_streamed_checksum_auto_extract_format(
        &self,
        source: &Path,
        options: &ChecksumStreamOptions,
    ) -> Option<&'static str> {
        let ChecksumStreamOptions {
            select,
            kind_filter,
            no_extract,
            no_trim_fix,
            strip_header,
            start,
            length,
            ..
        } = *options;
        if no_extract || strip_header || !select.is_empty() || start.is_some() || length.is_some() {
            return None;
        }

        let handler = self.containers.probe(source)?;
        let stream_format = handler.descriptor().name;
        if !matches!(stream_format, "gz" | "bz2" | "xz" | "zst") {
            return None;
        }

        if let Some(inferred_output) =
            Self::inferred_stream_extract_output_path(source, stream_format)
        {
            if kind_filter.enabled()
                && !kind_filter.matches_payload_name(&inferred_output.to_string_lossy())
            {
                return None;
            }
            if let Some(next_handler) = self.containers.probe(&inferred_output)
                && !next_handler.descriptor().matches_name("xiso")
                && next_handler.capabilities().extract
            {
                return None;
            }

            if !no_trim_fix && self.trim_eligible_kind_for_path(&inferred_output).is_some() {
                return None;
            }
        } else if kind_filter.enabled() {
            return None;
        }

        Some(stream_format)
    }

    fn run_checksum_stream_auto_extract(
        &self,
        source: &Path,
        stream_format: &str,
        algo: &[String],
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<OperationReport> {
        trace!(
            source = %source.display(),
            stream_format,
            algorithm_count = algo.len(),
            "running streamed checksum auto-extract fast path"
        );
        self.emit_running(
            OperationLabel {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
            },
            "prepare",
            format!(
                "streaming checksum payload from `{}` ({stream_format})",
                source.display()
            ),
            None,
            thread_execution.clone(),
        );

        let filter = Self::libarchive_read_filter_for_stream_format(stream_format)?;
        let algorithms = algo
            .iter()
            .map(|algorithm| algorithm.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let checksum_algorithm_count = algorithms.len();
        let values =
            with_raw_stream_reader(source, stream_format, filter, 64 * 1024, |stream_reader| {
                checksum_reader_values_with_progress(
                    stream_reader,
                    &algorithms,
                    context,
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
            })?;

        let mut label = Self::render_streamed_checksum_label(&algorithms, &values.values);
        label.push_str(&format!(
            "; checksum source streamed from {stream_format} container"
        ));
        Ok(OperationReport::succeeded(
            OperationFamily::Checksum,
            Some(self.checksum.name().to_string()),
            "checksum",
            label,
            Some(100.0),
            Some(values.execution),
        ))
    }

    fn libarchive_read_filter_for_stream_format(
        stream_format: &str,
    ) -> Result<LibarchiveReadFilter> {
        match stream_format {
            "gz" => Ok(LibarchiveReadFilter::Gzip),
            "bz2" => Ok(LibarchiveReadFilter::Bzip2),
            "xz" => Ok(LibarchiveReadFilter::Xz),
            "zst" => Ok(LibarchiveReadFilter::Zstd),
            _ => Err(RomWeaverError::Validation(format!(
                "streamed checksum auto-extract does not support `{stream_format}`"
            ))),
        }
    }

    fn inferred_stream_extract_output_path(source: &Path, stream_format: &str) -> Option<PathBuf> {
        let file_name = source.file_name()?.to_str()?;
        let extension = match stream_format {
            "gz" => ".gz",
            "bz2" => ".bz2",
            "xz" => ".xz",
            "zst" => ".zst",
            _ => return None,
        };
        let file_name_lower = file_name.to_ascii_lowercase();
        let trimmed = if file_name_lower.ends_with(extension) && extension.len() < file_name.len() {
            file_name[..file_name.len() - extension.len()].to_string()
        } else {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        };
        let normalized = trimmed.trim().trim_matches('.');
        let output_name = if normalized.is_empty() {
            format!("{stream_format}.out")
        } else {
            normalized.to_string()
        };
        let parent = source
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        Some(parent.join(output_name))
    }

    fn render_streamed_checksum_label(
        algorithms: &[String],
        values: &BTreeMap<String, String>,
    ) -> String {
        let mut ordered = Vec::new();
        let mut seen = BTreeSet::new();
        for algorithm in algorithms {
            let normalized = algorithm.trim().to_ascii_lowercase();
            if !seen.insert(normalized.clone()) {
                continue;
            }
            if let Some(value) = values.get(&normalized) {
                ordered.push(format!("{normalized}={value}"));
            }
        }
        if ordered.is_empty() {
            values
                .iter()
                .map(|(algorithm, value)| format!("{algorithm}={value}"))
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            ordered.join(" ")
        }
    }

    fn resolve_source_with_auto_extract(
        &self,
        source: &Path,
        select: &[String],
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
        flags: AutoExtractResolutionFlags,
    ) -> Result<ResolvedChecksumSource> {
        self.resolve_source_with_auto_extract_with_mode(
            source,
            select,
            context,
            labels,
            AutoExtractResolutionOptions {
                no_extract: flags.no_extract,
                no_ignore: flags.no_ignore,
                kind_filter: flags.kind_filter,
                mode: AutoExtractMode::Recursive,
            },
        )
    }

    fn resolve_source_with_single_auto_extract(
        &self,
        source: &Path,
        select: &[String],
        kind_filter: ArchiveEntryKindFilter,
        no_ignore: bool,
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
    ) -> Result<ResolvedChecksumSource> {
        self.resolve_source_with_auto_extract_with_mode(
            source,
            select,
            context,
            labels,
            AutoExtractResolutionOptions {
                no_extract: false,
                no_ignore,
                kind_filter,
                mode: AutoExtractMode::SingleStep,
            },
        )
    }

    fn resolve_source_with_auto_extract_with_mode(
        &self,
        source: &Path,
        select: &[String],
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
        options: AutoExtractResolutionOptions,
    ) -> Result<ResolvedChecksumSource> {
        trace!(
            source = %source.display(),
            selections = select.len(),
            no_extract = options.no_extract,
            no_ignore = options.no_ignore,
            rom_filter = options.kind_filter.rom,
            patch_filter = options.kind_filter.patch,
            mode = ?options.mode,
            command = labels.command,
            family = ?labels.family,
            format = ?labels.format,
            source_label = labels.source_label,
            "starting auto-extract source resolution"
        );
        if options.no_extract {
            trace!(
                source = %source.display(),
                "auto-extract source resolution disabled by flag"
            );
            return Ok(ResolvedChecksumSource {
                source: source.to_path_buf(),
                extracted_archives: 0,
                cleanup_paths: Vec::new(),
            });
        }

        let mut current_source = source.to_path_buf();
        let mut extracted_archives = 0usize;
        let mut depth = 0usize;
        let mut cleanup_paths = Vec::new();

        loop {
            trace!(
                current_source = %current_source.display(),
                depth,
                extracted_archives,
                "auto-extract iteration"
            );
            let Some(handler) = self.containers.probe(&current_source) else {
                trace!(
                    current_source = %current_source.display(),
                    "auto-extract stopped: no container handler matched source"
                );
                break;
            };
            let is_xiso = handler.descriptor().matches_name("xiso");
            let can_extract = handler.capabilities().extract;
            if is_xiso || !can_extract {
                trace!(
                    current_source = %current_source.display(),
                    format = handler.descriptor().name,
                    is_xiso,
                    can_extract,
                    "auto-extract stopped: matched handler is not eligible for extract"
                );
                break;
            }

            let probe_request = ContainerProbeRequest {
                source: current_source.clone(),
            };
            if let Err(error) = handler.probe_details(&probe_request, context) {
                trace!(
                    current_source = %current_source.display(),
                    format = handler.descriptor().name,
                    error = %error,
                    "auto-extract stopped: handler probe failed"
                );
                break;
            }

            let next_depth = depth + 1;
            if next_depth > MAX_NESTED_EXTRACT_DEPTH {
                trace!(
                    current_source = %current_source.display(),
                    next_depth,
                    max_depth = MAX_NESTED_EXTRACT_DEPTH,
                    "auto-extract failed: exceeded max recursion depth"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} extract exceeded max depth of {MAX_NESTED_EXTRACT_DEPTH} at `{}`",
                    labels.source_label,
                    current_source.display()
                )));
            }
            if extracted_archives >= MAX_NESTED_EXTRACT_ARCHIVES {
                trace!(
                    source = %source.display(),
                    extracted_archives,
                    max_archives = MAX_NESTED_EXTRACT_ARCHIVES,
                    "auto-extract failed: exceeded max archive count"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} extract exceeded max archive count of {MAX_NESTED_EXTRACT_ARCHIVES}",
                    labels.source_label
                )));
            }

            self.emit_running(
                OperationLabel {
                    command: labels.command,
                    family: labels.family,
                    format: Some(handler.descriptor().name),
                },
                "prepare",
                format!(
                    "extracting {} payload from `{}`",
                    labels.source_label,
                    current_source.display()
                ),
                None,
                Some(context.plan_threads(handler.capabilities().extract_threads)),
            );

            let out_dir = context.temp_paths().next_path(labels.temp_prefix, None);
            fs::create_dir_all(&out_dir)?;
            self.extract_with_selection_fallback(
                handler.as_ref(),
                &current_source,
                SelectionExtract {
                    out_dir: &out_dir,
                    selections: select,
                    kind_filter: options.kind_filter,
                    split_bin: false,
                    ignore_common_files: false,
                    overwrite: true,
                    source_label: labels.source_label,
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "{} payload extraction failed for `{}` ({}): {error}",
                    labels.source_label,
                    current_source.display(),
                    handler.descriptor().name
                ))
            })?;
            cleanup_paths.push(out_dir.clone());
            extracted_archives = extracted_archives.saturating_add(1);
            depth = next_depth;
            trace!(
                source = %current_source.display(),
                format = handler.descriptor().name,
                out_dir = %out_dir.display(),
                extracted_archives,
                depth,
                "auto-extract archive extraction completed"
            );

            let all_candidates = self.collect_checksum_extract_candidates(&out_dir)?;
            trace!(
                source = %current_source.display(),
                candidate_count = all_candidates.len(),
                "auto-extract collected extracted candidates"
            );
            if all_candidates.is_empty() {
                trace!(
                    source = %current_source.display(),
                    "auto-extract failed: extracted archive produced no candidates"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} payload extraction produced no files for `{}`",
                    labels.source_label,
                    current_source.display()
                )));
            }

            let candidates = if options.no_ignore {
                all_candidates.clone()
            } else {
                let non_ignored = all_candidates
                    .iter()
                    .filter(|candidate| !candidate.ignored)
                    .cloned()
                    .collect::<Vec<_>>();
                trace!(
                    source = %current_source.display(),
                    candidate_count = all_candidates.len(),
                    non_ignored_count = non_ignored.len(),
                    "auto-extract applied candidate ignore filters"
                );
                if non_ignored.is_empty() {
                    if self.interactive_selection_enabled {
                        if let Some(selected) = self.prompt_for_checksum_candidate(
                            &current_source,
                            &all_candidates,
                            labels.source_label,
                            true,
                        )? {
                            trace!(
                                source = %current_source.display(),
                                selected = %selected.display_name,
                                selected_path = %selected.source.display(),
                                "auto-extract continued with interactively selected ignored candidate"
                            );
                            current_source = selected.source;
                            if options.mode == AutoExtractMode::SingleStep {
                                break;
                            }
                            continue;
                        }
                        trace!(
                            source = %current_source.display(),
                            "auto-extract failed: interactive selection cancelled while all candidates were ignored"
                        );
                        return Err(RomWeaverError::Validation(format!(
                            "interactive selection was cancelled for `{}`",
                            current_source.display()
                        )));
                    }
                    trace!(
                        source = %current_source.display(),
                        "auto-extract failed: all candidates ignored and no interactive selection"
                    );
                    return Err(RomWeaverError::Validation(format!(
                        "all extracted {} candidates from `{}` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>",
                        labels.source_label,
                        current_source.display()
                    )));
                }
                non_ignored
            };
            let candidates = if options.kind_filter.enabled() {
                let mut payload_matches = Vec::new();
                let mut container_fallback_matches = Vec::new();
                for candidate in &candidates {
                    if options
                        .kind_filter
                        .matches_payload_name(&candidate.display_name)
                    {
                        payload_matches.push(candidate.clone());
                    } else if options
                        .kind_filter
                        .matches_container_fallback_name(&candidate.display_name)
                    {
                        container_fallback_matches.push(candidate.clone());
                    }
                }
                let filtered = if payload_matches.is_empty() {
                    container_fallback_matches
                } else {
                    payload_matches
                };
                trace!(
                    source = %current_source.display(),
                    candidate_count = candidates.len(),
                    filtered_count = filtered.len(),
                    filter = %options.kind_filter.flag_label(),
                    "auto-extract applied candidate kind filters"
                );
                if filtered.is_empty() {
                    let choices = Self::render_checksum_candidate_choices(&candidates);
                    return Err(RomWeaverError::Validation(format!(
                        "no extracted {} candidates from `{}` matched {}; candidates: {choices}",
                        labels.source_label,
                        current_source.display(),
                        options.kind_filter.flag_label()
                    )));
                }
                filtered
            } else {
                candidates
            };
            if candidates.len() > 1 {
                if self.interactive_selection_enabled {
                    if let Some(selected) = self.prompt_for_checksum_candidate(
                        &current_source,
                        &candidates,
                        labels.source_label,
                        false,
                    )? {
                        trace!(
                            source = %current_source.display(),
                            selected = %selected.display_name,
                            selected_path = %selected.source.display(),
                            "auto-extract continued with interactively selected candidate"
                        );
                        current_source = selected.source;
                        if options.mode == AutoExtractMode::SingleStep {
                            break;
                        }
                        continue;
                    }
                    trace!(
                        source = %current_source.display(),
                        candidate_count = candidates.len(),
                        "auto-extract failed: interactive ambiguous candidate selection cancelled"
                    );
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        current_source.display()
                    )));
                }
                let choices = candidates
                    .iter()
                    .map(|candidate| format!("`{}`", candidate.display_name))
                    .collect::<Vec<_>>()
                    .join(", ");
                trace!(
                    source = %current_source.display(),
                    candidate_count = candidates.len(),
                    candidates = %choices,
                    "auto-extract failed: ambiguous candidates without interactive selection"
                );
                return Err(RomWeaverError::Validation(format!(
                    "{} payload resolution is ambiguous for `{}`; candidates: {choices}. Pass --select <pattern> to choose one payload",
                    labels.source_label,
                    current_source.display()
                )));
            }

            let Some(selected_candidate) = candidates.into_iter().next() else {
                return Err(RomWeaverError::Validation(format!(
                    "internal validation error: {} payload candidate set was empty for `{}`",
                    labels.source_label,
                    current_source.display()
                )));
            };
            trace!(
                source = %current_source.display(),
                selected = %selected_candidate.display_name,
                selected_path = %selected_candidate.source.display(),
                "auto-extract selected single candidate"
            );
            current_source = selected_candidate.source;
            if options.mode == AutoExtractMode::SingleStep {
                break;
            }
        }

        trace!(
            source = %source.display(),
            resolved_source = %current_source.display(),
            extracted_archives,
            cleanup_paths = cleanup_paths.len(),
            "completed auto-extract source resolution"
        );
        Ok(ResolvedChecksumSource {
            source: current_source,
            extracted_archives,
            cleanup_paths,
        })
    }

    fn extract_with_selection_fallback(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        extract: SelectionExtract,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let SelectionExtract {
            out_dir,
            selections,
            kind_filter,
            split_bin,
            ignore_common_files,
            overwrite,
            source_label,
        } = extract;
        let request = ContainerExtractRequest {
            source: source.to_path_buf(),
            selections: selections.to_vec(),
            kind_filter,
            out_dir: out_dir.to_path_buf(),
            split_bin,
            ignore_common_files,
            overwrite,
            parent: None,
        };
        match handler.extract(&request, context) {
            Ok(report) => Ok(report),
            Err(error) => {
                if !self.interactive_selection_enabled
                    || !Self::is_selection_resolution_error(&error.to_string())
                {
                    return Err(error);
                }

                let Some(selected_entry) =
                    self.prompt_for_container_selection(handler, source, source_label, context)?
                else {
                    return Err(RomWeaverError::Validation(format!(
                        "interactive selection was cancelled for `{}`",
                        source.display()
                    )));
                };

                let retry_request = ContainerExtractRequest {
                    source: source.to_path_buf(),
                    selections: vec![selected_entry],
                    kind_filter,
                    out_dir: out_dir.to_path_buf(),
                    split_bin,
                    ignore_common_files,
                    overwrite,
                    parent: None,
                };
                handler.extract(&retry_request, context)
            }
        }
    }

    fn is_selection_resolution_error(label: &str) -> bool {
        let lower = label.to_ascii_lowercase();
        lower.contains("requested selections were not found")
            || lower.contains("requested selections resolved to no extractable")
            || lower.contains("does not support --select")
    }

    fn prompt_for_container_selection(
        &self,
        handler: &dyn ContainerHandler,
        source: &Path,
        source_label: &str,
        context: &OperationContext,
    ) -> Result<Option<String>> {
        let entries = handler
            .list_entries(
                &ContainerProbeRequest {
                    source: source.to_path_buf(),
                },
                context,
            )
            .map_err(|error| {
                RomWeaverError::Validation(format!(
                    "interactive selection could not list entries for `{}` ({}): {error}",
                    source.display(),
                    handler.descriptor().name
                ))
            })?;

        let mut unique_entries = Vec::new();
        let mut seen = HashSet::new();
        for entry in entries {
            let normalized = Self::normalize_selection_entry_name(&entry);
            if normalized.is_empty() || !seen.insert(normalized.clone()) {
                continue;
            }
            unique_entries.push(normalized);
        }
        if unique_entries.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "interactive selection could not list selectable entries for `{}` ({})",
                source.display(),
                handler.descriptor().name
            )));
        }

        let prompt_candidates = unique_entries
            .iter()
            .map(|entry| SelectionPromptCandidate {
                value: entry.clone(),
                label: entry.clone(),
            })
            .collect::<Vec<_>>();
        let heading = format!(
            "{source_label} selection for `{}` did not resolve. Choose one entry:",
            source.display()
        );
        let selected_index = self.prompt_for_selection(&heading, &prompt_candidates)?;
        Ok(selected_index.map(|index| prompt_candidates[index].value.clone()))
    }

    fn prompt_for_checksum_candidate(
        &self,
        source: &Path,
        candidates: &[ChecksumExtractCandidate],
        source_label: &str,
        ignored_only: bool,
    ) -> Result<Option<ChecksumExtractCandidate>> {
        if candidates.is_empty() {
            return Ok(None);
        }
        let heading = if ignored_only {
            format!(
                "{source_label} payload candidates for `{}` were ignored by default filters. Choose one entry to continue:",
                source.display()
            )
        } else {
            format!(
                "{source_label} payload selection for `{}` is ambiguous. Choose one entry:",
                source.display()
            )
        };
        let prompt_candidates = candidates
            .iter()
            .map(|candidate| SelectionPromptCandidate {
                value: candidate.display_name.clone(),
                label: if ignored_only && candidate.ignored {
                    format!("{} [ignored by default]", candidate.display_name)
                } else {
                    candidate.display_name.clone()
                },
            })
            .collect::<Vec<_>>();
        let selected_index = self.prompt_for_selection(&heading, &prompt_candidates)?;
        Ok(selected_index.map(|index| candidates[index].clone()))
    }

    fn render_checksum_candidate_choices(candidates: &[ChecksumExtractCandidate]) -> String {
        if candidates.is_empty() {
            return "(none)".to_string();
        }
        candidates
            .iter()
            .map(|candidate| format!("`{}`", candidate.display_name))
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn normalize_selection_entry_name(name: &str) -> String {
        name.trim()
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    fn parse_selection_input(input: &str, candidate_count: usize) -> ParsedSelectionInput {
        let trimmed = input.trim();
        if trimmed.eq_ignore_ascii_case("q")
            || trimmed.eq_ignore_ascii_case("quit")
            || trimmed.eq_ignore_ascii_case("exit")
        {
            return ParsedSelectionInput::Cancelled;
        }
        if let Ok(parsed) = trimmed.parse::<usize>()
            && (1..=candidate_count).contains(&parsed)
        {
            return ParsedSelectionInput::Selected(parsed - 1);
        }
        ParsedSelectionInput::Invalid
    }

    fn prompt_for_selection(
        &self,
        heading: &str,
        candidates: &[SelectionPromptCandidate],
    ) -> Result<Option<usize>> {
        if !self.interactive_selection_enabled || candidates.is_empty() {
            return Ok(None);
        }
        eprintln!("{heading}");
        for (index, candidate) in candidates.iter().enumerate() {
            eprintln!("  {}. {}", index + 1, candidate.label);
        }
        eprintln!(
            "Enter a number between 1 and {}, or `q` to cancel.",
            candidates.len()
        );

        loop {
            eprint!("selection> ");
            io::stderr().flush()?;
            let mut input = String::new();
            let bytes_read = io::stdin().read_line(&mut input)?;
            if bytes_read == 0 {
                return Ok(None);
            }
            let trimmed = input.trim();
            match Self::parse_selection_input(trimmed, candidates.len()) {
                ParsedSelectionInput::Cancelled => return Ok(None),
                ParsedSelectionInput::Selected(index) => return Ok(Some(index)),
                ParsedSelectionInput::Invalid => {}
            }
            eprintln!(
                "invalid selection `{trimmed}`. Enter 1..{} or `q`.",
                candidates.len()
            );
        }
    }

    fn cleanup_temp_paths(temp_paths: Vec<PathBuf>) {
        for temp_path in temp_paths {
            match fs::metadata(&temp_path) {
                Ok(metadata) if metadata.is_dir() => {
                    let _ = fs::remove_dir_all(temp_path);
                }
                Ok(_) => {
                    let _ = fs::remove_file(temp_path);
                }
                Err(_) => {}
            }
        }
    }

    fn snapshot_file_tree(root: &Path) -> Result<HashMap<PathBuf, FileSnapshot>> {
        if !root.exists() {
            return Ok(HashMap::new());
        }

        if root.is_file() {
            let mut snapshot = HashMap::new();
            snapshot.insert(root.to_path_buf(), Self::file_snapshot_for_path(root)?);
            return Ok(snapshot);
        }
        if !root.is_dir() {
            return Ok(HashMap::new());
        }

        let mut snapshot = HashMap::new();
        let mut directories = vec![root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                snapshot.insert(path.clone(), Self::file_snapshot_for_path(&path)?);
            }
        }
        Ok(snapshot)
    }

    fn file_snapshot_for_path(path: &Path) -> Result<FileSnapshot> {
        let metadata = fs::metadata(path)?;
        let modified_unix_nanos = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos());
        Ok(FileSnapshot {
            size_bytes: metadata.len(),
            modified_unix_nanos,
        })
    }

    fn collect_changed_files(
        root: &Path,
        baseline: &HashMap<PathBuf, FileSnapshot>,
    ) -> Result<Vec<PathBuf>> {
        let after = Self::snapshot_file_tree(root)?;
        let mut changed = after
            .into_iter()
            .filter_map(|(path, snapshot)| match baseline.get(&path) {
                Some(previous) if previous == &snapshot => None,
                _ => Some(path),
            })
            .collect::<Vec<_>>();
        changed.sort();
        Ok(changed)
    }

    fn attach_emitted_files_details(
        mut report: OperationReport,
        emitted_files: Vec<PathBuf>,
        default_kind: Option<&str>,
    ) -> OperationReport {
        if report.status != OperationStatus::Succeeded {
            return report;
        }

        let mut details = match report.details.take() {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        let existing = match details.remove("emitted_files") {
            Some(Value::Array(entries)) => entries
                .into_iter()
                .filter_map(|entry| match entry {
                    Value::Object(map) => {
                        let key = Self::emitted_file_detail_key(&map)?;
                        Some((key, map))
                    }
                    _ => None,
                })
                .collect::<BTreeMap<_, _>>(),
            _ => BTreeMap::new(),
        };
        let emitted = emitted_files
            .into_iter()
            .filter_map(|path| {
                let mut detail = match Self::build_emitted_file_detail(&path, default_kind)? {
                    Value::Object(map) => map,
                    _ => return None,
                };
                if let Some(extra) = existing.get(&Self::normalized_emitted_path_key(&path)) {
                    for (key, value) in extra {
                        detail.entry(key.clone()).or_insert_with(|| value.clone());
                    }
                }
                Some(Value::Object(detail))
            })
            .collect::<Vec<_>>();
        details.insert("emitted_files".to_string(), Value::Array(emitted));
        report.details = Some(Value::Object(details));
        report
    }

    fn emitted_file_detail_key(entry: &Map<String, Value>) -> Option<String> {
        entry
            .get("path")
            .and_then(Value::as_str)
            .map(Self::normalize_emitted_path_string)
    }

    fn normalized_emitted_path_key(path: &Path) -> String {
        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        Self::normalize_emitted_path_string(&canonical.to_string_lossy())
    }

    fn normalize_emitted_path_string(path: &str) -> String {
        path.replace('\\', "/")
    }

    fn build_emitted_file_detail(path: &Path, default_kind: Option<&str>) -> Option<Value> {
        let metadata = fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }

        let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let file_name = canonical.file_name()?.to_string_lossy().into_owned();
        let mut entry = Map::new();
        entry.insert(
            "path".to_string(),
            json!(canonical.to_string_lossy().replace('\\', "/")),
        );
        entry.insert("file_name".to_string(), json!(file_name));
        entry.insert("size_bytes".to_string(), json!(metadata.len()));
        if let Some(kind) = Self::infer_emitted_file_kind(&canonical).or(default_kind) {
            entry.insert("kind".to_string(), json!(kind));
        }
        Some(Value::Object(entry))
    }

    fn infer_emitted_file_kind(path: &Path) -> Option<&'static str> {
        let file_name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
        if file_name.ends_with(".cue") {
            return Some("cue");
        }
        if file_name.ends_with(".bin") {
            return Some("bin");
        }
        if EMITTED_ARCHIVE_EXTENSIONS
            .iter()
            .any(|extension| file_name.ends_with(extension))
        {
            return Some("archive");
        }
        if EMITTED_ROM_EXTENSIONS
            .iter()
            .any(|extension| file_name.ends_with(extension))
        {
            return Some("rom");
        }
        None
    }

    fn collect_checksum_extract_candidates(
        &self,
        root: &Path,
    ) -> Result<Vec<ChecksumExtractCandidate>> {
        let mut directories = vec![root.to_path_buf()];
        let mut candidates = Vec::new();
        while let Some(directory) = directories.pop() {
            let mut entries =
                fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.path());

            for entry in entries {
                let path = entry.path();
                let file_type = entry.file_type()?;
                if file_type.is_dir() {
                    directories.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }

                let relative = path.strip_prefix(root).map_err(|_| {
                    RomWeaverError::Validation(format!(
                        "failed to derive checksum candidate path from `{}`",
                        path.display()
                    ))
                })?;
                let display_name = Self::normalize_checksum_candidate_name(relative);
                if display_name.is_empty() {
                    continue;
                }
                let ignored = Self::should_ignore_checksum_candidate(&display_name);
                candidates.push(ChecksumExtractCandidate {
                    source: path,
                    display_name,
                    ignored,
                });
            }
        }

        candidates.sort_by(|left, right| left.display_name.cmp(&right.display_name));
        Ok(candidates)
    }

    fn normalize_checksum_candidate_name(path: &Path) -> String {
        path.to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches("./")
            .trim_matches('/')
            .to_string()
    }

    fn should_ignore_checksum_candidate(candidate_name: &str) -> bool {
        should_ignore_common_container_file(candidate_name)
    }
}
