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

    fn run(&self, command: Commands) -> ExitCode {
        let command_name = Self::command_name(&command);
        trace!(command = command_name, "dispatching CLI command");
        match command {
            Commands::Inspect(args) => self.run_inspect(args),
            Commands::Extract(args) => self.run_extract(args),
            Commands::Checksum(args) => self.run_checksum(args),
            Commands::Compress(args) => self.run_compress(args),
            Commands::Trim(args) => self.run_trim(args),
            Commands::BatchHeaderFixer(args) => self.run_batch_header_fixer(args),
            Commands::PatchApply(args) => self.run_patch_apply(args),
            Commands::PatchCreate(args) => self.run_patch_create(args),
        }
    }

    fn command_name(command: &Commands) -> &'static str {
        match command {
            Commands::Inspect(_) => "inspect",
            Commands::Extract(_) => "extract",
            Commands::Checksum(_) => "checksum",
            Commands::Compress(_) => "compress",
            Commands::Trim(_) => "trim",
            Commands::BatchHeaderFixer(_) => "batch-header-fixer",
            Commands::PatchApply(_) => "patch-apply",
            Commands::PatchCreate(_) => "patch-create",
        }
    }

    fn run_inspect(&self, args: InspectCommand) -> ExitCode {
        trace!(source = %args.source.display(), list = args.list, "starting inspect command");
        let context = self.context(ThreadBudget::Fixed(1));
        let source = args.source.clone();
        if let Some(report) =
            self.require_existing_path("inspect", OperationFamily::Command, None, &source, None)
        {
            return self.finish("inspect", report);
        }
        let inspect_recommendation = self.inspect_compress_recommendation(&source);

        self.emit_running(
            "inspect",
            OperationFamily::Command,
            None,
            "probe",
            format!("probing handlers for `{}`", source.display()),
            Some(0.0),
            None,
        );

        if let Some(handler) = self.containers.probe(&source) {
            self.emit_running(
                "inspect",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "inspect",
                format!("inspecting `{}`", source.display()),
                Some(0.0),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            let request = ContainerInspectRequest {
                source: source.clone(),
            };
            let mut report = handler.inspect(&request, &context).unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "inspect",
                    error.to_string(),
                    None,
                )
            });
            let mut listed_entries: Option<Vec<String>> = None;
            if report.status == OperationStatus::Succeeded && args.list {
                self.emit_running(
                    "inspect",
                    OperationFamily::Container,
                    Some(handler.descriptor().name),
                    "list",
                    format!("listing entries for `{}`", source.display()),
                    None,
                    Some(context.plan_threads(ThreadCapability::single_threaded())),
                );
                let listed = handler.list_entries(&request, &context).map_err(|error| {
                    OperationReport::failed(
                        OperationFamily::Container,
                        Some(handler.descriptor().name.to_string()),
                        "list",
                        error.to_string(),
                        None,
                    )
                });
                match listed {
                    Ok(entries) => {
                        if !self.emit_progress_events {
                            report.label = Self::append_entry_list_label(&report.label, &entries);
                        }
                        listed_entries = Some(entries);
                    }
                    Err(list_error) => {
                        report = list_error;
                    }
                }
            }
            if !self.emit_progress_events {
                report = Self::append_recommended_compress_label(
                    report,
                    inspect_recommendation.as_ref(),
                );
            }
            report = Self::attach_container_inspect_details(
                report,
                listed_entries,
                inspect_recommendation.as_ref(),
            );
            return self.finish("inspect", report);
        }

        if let Some(handler) = self.patches.probe(&source) {
            self.emit_running(
                "inspect",
                OperationFamily::Patch,
                Some(handler.descriptor().name),
                "inspect",
                format!("parsing `{}`", source.display()),
                Some(0.0),
                None,
            );
            if args.list {
                let report = OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "list",
                    "inspect --list is only supported for container formats",
                    None,
                );
                return self.finish("inspect", report);
            }
            let mut report = handler.parse(&source, &context).unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "inspect",
                    error.to_string(),
                    None,
                )
            });
            if !self.emit_progress_events {
                report = Self::append_recommended_compress_label(
                    report,
                    inspect_recommendation.as_ref(),
                );
            }
            return self.finish("inspect", Self::attach_patch_inspect_details(report));
        }

        if let Some(reason) = explicitly_unsupported_patch_reason_for_path(&source) {
            let mut report = OperationReport::failed(
                OperationFamily::Patch,
                Some("PDS".to_string()),
                "probe",
                format!(
                    "patch format for `{}` is explicitly not supported: {reason}",
                    source.display()
                ),
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            if !self.emit_progress_events {
                report = Self::append_recommended_compress_label(
                    report,
                    inspect_recommendation.as_ref(),
                );
            }
            return self.finish("inspect", report);
        }

        if let Ok(Some(header_match)) = Self::detect_known_rom_header(&source) {
            if args.list {
                let report = OperationReport::failed(
                    OperationFamily::Command,
                    Some("rom-header".to_string()),
                    "list",
                    "inspect --list is only supported for container formats",
                    None,
                );
                return self.finish("inspect", report);
            }
            let mut report = OperationReport::succeeded(
                OperationFamily::Command,
                Some("rom-header".to_string()),
                "inspect",
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
                    inspect_recommendation.as_ref(),
                );
            }
            return self.finish("inspect", report);
        }

        let mut report = OperationReport::failed(
            OperationFamily::Command,
            None,
            "probe",
            format!("no registered handler matched `{}`", source.display()),
            None,
        );
        if !self.emit_progress_events {
            report =
                Self::append_recommended_compress_label(report, inspect_recommendation.as_ref());
        }
        self.finish("inspect", report)
    }

    fn run_extract(&self, args: ExtractCommand) -> ExitCode {
        trace!(
            source = %args.source.display(),
            selections = args.select.len(),
            out_dir = %args.out_dir.display(),
            split_bin = args.split_bin,
            threads = %args.threads,
            "starting extract command"
        );
        let ExtractCommand {
            source,
            select: selections,
            out_dir,
            split_bin,
            threads,
        } = args;
        let out_dir_before = Self::snapshot_file_tree(&out_dir).unwrap_or_default();
        let context = self.context(threads);
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
        let suppress_scaffold_percent =
            Self::container_handler_emits_incremental_byte_progress(handler.descriptor().name);
        let extract_threads = Some(context.plan_threads(handler.capabilities().extract_threads));
        self.emit_running(
            "extract",
            OperationFamily::Container,
            Some(handler.descriptor().name),
            "extract",
            format!("extracting `{}`", source.display()),
            Some(0.0),
            extract_threads.clone(),
        );
        self.emit_running(
            "extract",
            OperationFamily::Container,
            Some(handler.descriptor().name),
            "extract",
            format!("preparing extraction for `{}`", source.display()),
            if suppress_scaffold_percent {
                None
            } else {
                Some(1.0)
            },
            extract_threads.clone(),
        );
        let mut report = self
            .extract_with_selection_fallback(
                handler.as_ref(),
                &source,
                &out_dir,
                &selections,
                extract_split_bin,
                "extract input",
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
        if report.status == OperationStatus::Succeeded {
            let progress_execution = report.thread_execution.clone();
            self.emit_running(
                "extract",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "extract",
                format!("extracting `{}`", source.display()),
                if suppress_scaffold_percent {
                    None
                } else {
                    Some(95.0)
                },
                progress_execution,
            );
            self.emit_running(
                "extract",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "nested-extract",
                format!("checking nested archives under `{}`", out_dir.display()),
                None,
                Some(context.plan_threads(ThreadCapability::single_threaded())),
            );
            match self.extract_nested_archives(&source, &out_dir, &context) {
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
            match Self::collect_changed_files(&out_dir, &out_dir_before) {
                Ok(emitted_files) => {
                    report = Self::attach_emitted_files_details(report, emitted_files, None);
                }
                Err(error) => {
                    trace!(
                        out_dir = %out_dir.display(),
                        error = %error,
                        "failed to collect extract emitted output metadata"
                    );
                }
            }
            self.emit_running(
                "extract",
                OperationFamily::Container,
                Some(handler.descriptor().name),
                "extract",
                format!("finalizing extracted output from `{}`", source.display()),
                if suppress_scaffold_percent {
                    None
                } else {
                    Some(99.0)
                },
                report.thread_execution.clone(),
            );
        }
        self.finish("extract", report)
    }

    fn run_checksum(&self, args: ChecksumCommand) -> ExitCode {
        trace!(
            source = %args.source.display(),
            algorithm_count = args.algo.len(),
            selections = args.select.len(),
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
            no_extract,
            no_ignore,
            strip_header,
            no_trim_fix,
            start,
            length,
            threads,
        } = args;
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

        match self.try_run_checksum_tar_stream_auto_extract(
            &source,
            &algo,
            &select,
            no_extract,
            no_ignore,
            no_trim_fix,
            strip_header,
            start,
            length,
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
            &select,
            no_extract,
            no_trim_fix,
            strip_header,
            start,
            length,
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
            no_extract || strip_header,
            no_ignore,
            &context,
            AutoExtractResolutionLabels {
                command: "checksum",
                family: OperationFamily::Checksum,
                format: Some(self.checksum.name()),
                source_label: "checksum",
                temp_prefix: "checksum-extract",
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
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name()),
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
                "checksum",
                OperationFamily::Checksum,
                Some(self.checksum.name()),
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
                "checksum",
                OperationFamily::Checksum,
                Some(self.checksum.name()),
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
                    "checksum",
                    OperationFamily::Checksum,
                    Some(self.checksum.name()),
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

    fn try_run_checksum_tar_stream_auto_extract(
        &self,
        source: &Path,
        algo: &[String],
        select: &[String],
        no_extract: bool,
        no_ignore: bool,
        no_trim_fix: bool,
        strip_header: bool,
        start: Option<u64>,
        length: Option<u64>,
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<Option<OperationReport>> {
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
            self.select_tar_stream_checksum_candidate(source, tar_format, no_ignore)?
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
            tar_format,
            &candidate_name,
            candidate_index,
            algo,
            context,
            thread_execution,
        )?;
        Ok(Some(report))
    }

    fn run_checksum_tar_stream_auto_extract(
        &self,
        source: &Path,
        tar_format: &str,
        candidate_name: &str,
        candidate_index: usize,
        algo: &[String],
        context: &OperationContext,
        thread_execution: Option<ThreadExecution>,
    ) -> Result<OperationReport> {
        trace!(
            source = %source.display(),
            tar_format,
            candidate_name,
            candidate_index,
            algorithm_count = algo.len(),
            "running streamed tar checksum auto-extract fast path"
        );
        self.emit_running(
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name()),
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
                            "checksum",
                            OperationFamily::Checksum,
                            Some(self.checksum.name()),
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
        if selected.len() != 1 {
            return Ok(None);
        }

        Ok(selected.into_iter().next())
    }

    fn select_streamed_checksum_auto_extract_format(
        &self,
        source: &Path,
        select: &[String],
        no_extract: bool,
        no_trim_fix: bool,
        strip_header: bool,
        start: Option<u64>,
        length: Option<u64>,
    ) -> Option<&'static str> {
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
            if let Some(next_handler) = self.containers.probe(&inferred_output)
                && !next_handler.descriptor().matches_name("xiso")
                && next_handler.capabilities().extract
            {
                return None;
            }

            if !no_trim_fix && self.trim_eligible_kind_for_path(&inferred_output).is_some() {
                return None;
            }
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
            "checksum",
            OperationFamily::Checksum,
            Some(self.checksum.name()),
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
                            "checksum",
                            OperationFamily::Checksum,
                            Some(self.checksum.name()),
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
        no_extract: bool,
        no_ignore: bool,
        context: &OperationContext,
        labels: AutoExtractResolutionLabels<'_>,
    ) -> Result<ResolvedChecksumSource> {
        trace!(
            source = %source.display(),
            selections = select.len(),
            no_extract,
            no_ignore,
            command = labels.command,
            family = ?labels.family,
            format = ?labels.format,
            source_label = labels.source_label,
            "starting auto-extract source resolution"
        );
        if no_extract {
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

            let inspect_request = ContainerInspectRequest {
                source: current_source.clone(),
            };
            if let Err(error) = handler.inspect(&inspect_request, context) {
                trace!(
                    current_source = %current_source.display(),
                    format = handler.descriptor().name,
                    error = %error,
                    "auto-extract stopped: handler inspect failed"
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
                labels.command,
                labels.family,
                Some(handler.descriptor().name),
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
                &out_dir,
                select,
                false,
                labels.source_label,
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

            let candidates = if no_ignore {
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
        out_dir: &Path,
        selections: &[String],
        split_bin: bool,
        source_label: &str,
        context: &OperationContext,
    ) -> Result<OperationReport> {
        let request = ContainerExtractRequest {
            source: source.to_path_buf(),
            selections: selections.to_vec(),
            out_dir: out_dir.to_path_buf(),
            split_bin,
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
                    out_dir: out_dir.to_path_buf(),
                    split_bin,
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
                &ContainerInspectRequest {
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
        let emitted = emitted_files
            .into_iter()
            .filter_map(|path| Self::build_emitted_file_detail(&path, default_kind))
            .collect::<Vec<_>>();
        details.insert("emitted_files".to_string(), Value::Array(emitted));
        report.details = Some(Value::Object(details));
        report
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
        let normalized = candidate_name.replace('\\', "/");
        let lower = normalized.to_ascii_lowercase();
        if lower.contains("maxcso") {
            return true;
        }
        if lower
            .split('/')
            .any(|component| component.eq_ignore_ascii_case("__macosx"))
        {
            return true;
        }
        if let Some(file_name) = lower.rsplit('/').next()
            && matches!(file_name, ".ds_store" | "thumbs.db" | "desktop.ini")
        {
            return true;
        }
        CHECKSUM_IGNORE_SIDECAR_EXTENSIONS
            .iter()
            .any(|extension| lower.ends_with(extension))
    }
}
