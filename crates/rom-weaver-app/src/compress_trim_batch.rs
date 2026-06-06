/* jscpd:ignore-start */
impl CliApp {
    fn run_compress(&self, args: CompressCommand) -> AppRunOutcome {
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

        let context = self.context(threads);
        let probe_threads = Some(context.plan_threads(ThreadCapability::single_threaded()));
        for input in &input {
            if let Some(report) = self.require_existing_path(
                "compress",
                OperationFamily::Container,
                requested_format.clone(),
                input,
                probe_threads.clone(),
            ) {
                return self.finish("compress", report);
            }
        }
        // The output format is derived from the output filename's extension; an explicit --format
        // overrides it (with a warning when they disagree) and is required when the output has no
        // extension. There is no auto selection.
        let resolution = match self.resolve_container_output_format(
            requested_format.as_deref(),
            &output,
            "--format",
            "",
        ) {
            Ok(resolution) => resolution,
            Err(error) => {
                return self.finish(
                    "compress",
                    OperationReport::failed(
                        OperationFamily::Container,
                        requested_format.clone(),
                        "validate",
                        error.to_string(),
                        probe_threads,
                    ),
                );
            }
        };
        let resolved_format = resolution.format;
        let format_warning = resolution.warning;
        if let Some(warning) = format_warning.as_deref() {
            warn!(
                command = "compress",
                format = %resolved_format,
                output = %output.display(),
                "{warning}"
            );
        }
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
        if !capabilities.probe_details && !capabilities.extract && !capabilities.create {
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
        if !capabilities.create {
            return self.finish(
                "compress",
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "validate",
                    format!(
                        "{} is extract-only; supported create formats are 7z, zip, chd, rvz, and z3ds",
                        handler.descriptor().name
                    ),
                    probe_threads,
                ),
            );
        }
        let create_threads = Some(context.plan_threads(capabilities.create_threads.clone()));
        self.emit_running(
            OperationLabel {
                command: "compress",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "create",
            format!(
                "creating {} archive from {} input(s)",
                handler.descriptor().name,
                input.len()
            ),
            None,
            create_threads.clone(),
        );
        self.emit_running(
            OperationLabel {
                command: "compress",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "create",
            format!("preparing {} archive build", handler.descriptor().name),
            None,
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
            && let Some(warning) = format_warning.as_deref()
        {
            report.label = format!("{}; warning: {warning}", report.label);
        }
        if report.status == OperationStatus::Succeeded {
            self.emit_running(
                OperationLabel {
                    command: "compress",
                    family: OperationFamily::Container,
                    format: Some(handler.descriptor().name),
                },
                "create",
                format!("finalizing `{}` archive", handler.descriptor().name),
                None,
                report.thread_execution.clone(),
            );
            report =
                Self::attach_emitted_files_details(report, vec![expected_output], Some("archive"));
        }
        self.finish("compress", report)
    }

    fn run_trim(&self, args: TrimCommand) -> AppRunOutcome {
        trace!(
            source_count = args.source.len(),
            output = ?args.output.as_ref().map(|path| path.display().to_string()),
            extension = ?args.extension,
            in_place = args.in_place,
            dry_run = args.dry_run,
            revert = args.revert,
            recursive = args.recursive,
            rom_filter = args.rom_filter,
            no_extract = args.no_extract,
            revert_marker = args.revert_marker,
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
            rom_filter,
            no_extract,
            revert_marker,
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

        let mut skipped_unsupported = 0usize;
        let mut cleanup_paths: Vec<PathBuf> = Vec::new();
        let collect_options = TrimCollectOptions {
            recursive,
            rom_filter,
            no_extract,
            in_place,
            context: &context,
        };
        let trim_sources = match self.collect_trim_input_files(
            &source,
            collect_options,
            &mut cleanup_paths,
            &mut skipped_unsupported,
        ) {
                Ok(paths) => paths,
                Err(error) => {
                    Self::cleanup_temp_paths(cleanup_paths);
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
            Self::cleanup_temp_paths(cleanup_paths);
            return self.finish(
                "trim",
                OperationReport::succeeded(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "trim",
                    format!("no trim-eligible inputs found; skipped_unsupported={skipped_unsupported}"),
                    Some(100.0),
                    thread_execution,
                ),
            );
        }

        if output.is_some() && trim_sources.len() != 1 {
            Self::cleanup_temp_paths(cleanup_paths);
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
            // For `--in-place` archive inputs, confirm before rewriting an archive that holds files
            // beyond the ROM. Non-interactive runs fail; interactive runs prompt.
            if let Some(repack_root) = trim_source.repack_root.as_ref() {
                let archive = trim_source
                    .archive_origin
                    .as_ref()
                    .expect("repack source carries its archive origin");
                match self.confirm_archive_repack(
                    archive,
                    repack_root,
                    &trim_source.path,
                    dry_run,
                ) {
                    Ok(true) => {}
                    Ok(false) => {
                        let message = format!(
                            "--in-place repack declined for `{}`; archive left unchanged",
                            archive.display()
                        );
                        failed_count = failed_count.saturating_add(1);
                        if first_error.is_none() {
                            first_error = Some(message);
                        }
                        continue;
                    }
                    Err(error) => {
                        failed_count = failed_count.saturating_add(1);
                        if first_error.is_none() {
                            first_error = Some(error.to_string());
                        }
                        self.emit_running(
                            OperationLabel {
                                command: "trim",
                                family: OperationFamily::Command,
                                format: Some("nds"),
                            },
                            operation.stage(),
                            error.to_string(),
                            None,
                            thread_execution.clone(),
                        );
                        continue;
                    }
                }
            }
            let repack_root = trim_source.repack_root.as_ref();
            let output_path = if repack_root.is_some() {
                // Trim the extracted ROM in place inside the repack staging directory; the archive
                // is rebuilt from that directory after the trim succeeds.
                trim_source.path.clone()
            } else if let Some(explicit_output) = output.as_ref() {
                explicit_output.clone()
            } else if in_place {
                trim_source.path.clone()
            } else if let Some(archive) = trim_source.archive_origin.as_ref() {
                Self::archive_sidecar_trim_output_path(archive, trim_source, &extension)
            } else {
                Self::default_trim_output_path(trim_source, &extension)
            };
            let output_label = if let Some(archive) = trim_source
                .archive_origin
                .as_ref()
                .filter(|_| repack_root.is_some())
            {
                format!("repack `{}`", archive.display())
            } else if in_place {
                "in-place".to_string()
            } else {
                output_path.display().to_string()
            };
            // Repack sources always trim the staged ROM in place regardless of the batch flag.
            let trim_in_place = in_place || repack_root.is_some();

            self.emit_running(
                OperationLabel {
                    command: "trim",
                    family: OperationFamily::Command,
                    format: Some("nds"),
                },
                operation.stage(),
                format!(
                    "{} `{}` -> `{output_label}`",
                    operation.running_label(dry_run),
                    trim_source.path.display()
                ),
                Some(0.0),
                thread_execution.clone(),
            );

            let trim_result = self.trim_file(
                &trim_source.path,
                &output_path,
                TrimRequest {
                    in_place: trim_in_place,
                    dry_run,
                    operation,
                    kind: trim_source.kind,
                    revert_marker,
                },
                &context,
            );
            // Rebuild the archive over the original once the staged ROM is trimmed (skipped on a
            // dry run, which only reports what would happen).
            let trim_result = match (trim_result, repack_root) {
                (Ok(outcome), Some(repack_root)) if !dry_run => {
                    let archive = trim_source
                        .archive_origin
                        .as_ref()
                        .expect("repack source carries its archive origin");
                    self.repack_archive(archive, repack_root, &context)
                        .map(|()| outcome)
                }
                (result, _) => result,
            };
            match trim_result {
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
            Self::cleanup_temp_paths(cleanup_paths);
            return self.finish(
                "trim",
                OperationReport::failed(
                    OperationFamily::Command,
                    Some("nds".to_string()),
                    "trim",
                    format!(
                        "{} completed with failures; processed={} trimmed={} already_trimmed={} failed={} skipped_unsupported={}; first_error={}",
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
                        skipped_unsupported,
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

        Self::cleanup_temp_paths(cleanup_paths);
        self.finish(
            "trim",
            OperationReport::succeeded(
                OperationFamily::Command,
                Some("nds".to_string()),
                "trim",
                match single_detail {
                    Some(single_detail) => format!(
                        "{single_detail}; {}; processed={} trimmed={} already_trimmed={} changed={} already_target={} skipped_unsupported={} mode_counts={}{}",
                        operation.summary_label(dry_run),
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        trimmed_count,
                        already_trimmed_count,
                        skipped_unsupported,
                        Self::format_mode_counts(&mode_counts),
                        irreversible_warning,
                    ),
                    None => format!(
                        "{}; processed={} trimmed={} already_trimmed={} changed={} already_target={} skipped_unsupported={} mode_counts={}{}",
                        operation.summary_label(dry_run),
                        trim_sources.len(),
                        trimmed_count,
                        already_trimmed_count,
                        trimmed_count,
                        already_trimmed_count,
                        skipped_unsupported,
                        Self::format_mode_counts(&mode_counts),
                        irreversible_warning,
                    ),
                },
                Some(100.0),
                thread_execution,
            ),
        )
    }

    /// Files staged for repack besides the ROM being trimmed, used to decide whether `--in-place`
    /// needs confirmation before rewriting the archive.
    fn repack_other_files(repack_root: &Path, rom_path: &Path) -> Result<Vec<PathBuf>> {
        let mut others = Vec::new();
        let mut directories = vec![repack_root.to_path_buf()];
        while let Some(directory) = directories.pop() {
            for entry in fs::read_dir(&directory)? {
                let path = entry?.path();
                if path.is_dir() {
                    directories.push(path);
                } else if path.is_file() && path != rom_path {
                    others.push(path);
                }
            }
        }
        others.sort();
        Ok(others)
    }

    /// Decide whether an `--in-place` archive repack may proceed. Archives that only contain the
    /// ROM repack freely. When other files are present the rewrite is destructive, so a dry run
    /// just reports it, non-interactive runs fail, and interactive runs prompt for confirmation.
    fn confirm_archive_repack(
        &self,
        archive: &Path,
        repack_root: &Path,
        rom_path: &Path,
        dry_run: bool,
    ) -> Result<bool> {
        let others = Self::repack_other_files(repack_root, rom_path)?;
        trace!(
            archive = %archive.display(),
            other_file_count = others.len(),
            dry_run,
            interactive = self.interactive_selection_enabled,
            "evaluating in-place archive repack confirmation"
        );
        if others.is_empty() {
            return Ok(true);
        }
        if dry_run {
            self.emit_running(
                OperationLabel {
                    command: "trim",
                    family: OperationFamily::Command,
                    format: Some("nds"),
                },
                "trim",
                format!(
                    "would repack `{}` in place, preserving {} other file(s)",
                    archive.display(),
                    others.len()
                ),
                None,
                None,
            );
            return Ok(true);
        }
        if !self.interactive_selection_enabled {
            return Err(RomWeaverError::Validation(format!(
                "refusing to repack `{}` in place: it contains {} other file(s) that would be rewritten; rerun in an interactive terminal to confirm, or omit --in-place to write the trimmed ROM beside the archive",
                archive.display(),
                others.len()
            )));
        }

        let heading = format!(
            "About to repack `{}` in place. This rewrites the archive and preserves {} other file(s):",
            archive.display(),
            others.len()
        );
        let detail_lines = others
            .iter()
            .map(|other| {
                other
                    .strip_prefix(repack_root)
                    .unwrap_or(other)
                    .display()
                    .to_string()
            })
            .collect::<Vec<_>>();
        Ok(self.prompter.confirm(&heading, &detail_lines))
    }

    /// Rebuild `archive` from the trimmed contents staged in `repack_root`, writing to a temporary
    /// sibling file first and renaming over the original so a failed build never destroys it.
    fn repack_archive(
        &self,
        archive: &Path,
        repack_root: &Path,
        context: &OperationContext,
    ) -> Result<()> {
        let Some(handler) = self.containers.probe(archive) else {
            return Err(RomWeaverError::Validation(format!(
                "cannot repack `{}`: no container handler matched the original archive",
                archive.display()
            )));
        };
        let format = handler.descriptor().name.to_string();
        if !handler.capabilities().create {
            return Err(RomWeaverError::Validation(format!(
                "cannot repack `{}`: the `{format}` format cannot be recreated",
                archive.display()
            )));
        }

        let mut inputs = fs::read_dir(repack_root)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        inputs.sort();
        if inputs.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "cannot repack `{}`: staged contents are empty",
                archive.display()
            )));
        }

        let parent = archive
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let file_name = archive
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("archive");
        let mut temp_output = parent.join(format!("{file_name}.rwtrim-repack"));
        for index in 1usize.. {
            if !temp_output.exists() {
                break;
            }
            temp_output = parent.join(format!("{file_name}.rwtrim-repack-{index}"));
        }

        self.emit_running(
            OperationLabel {
                command: "trim",
                family: OperationFamily::Container,
                format: Some(handler.descriptor().name),
            },
            "create",
            format!("repacking `{}`", archive.display()),
            None,
            Some(context.plan_threads(handler.capabilities().create_threads.clone())),
        );
        trace!(
            archive = %archive.display(),
            format = %format,
            input_count = inputs.len(),
            temp_output = %temp_output.display(),
            "rebuilding archive for in-place trim repack"
        );

        let request = ContainerCreateRequest {
            inputs,
            output: temp_output.clone(),
            format: format.clone(),
            codec: None,
            level: None,
            parent: None,
        };
        let report = handler.create(&request, context)?;
        if report.status != OperationStatus::Succeeded {
            let _ = fs::remove_file(&temp_output);
            return Err(RomWeaverError::Validation(format!(
                "repack of `{}` failed: {}",
                archive.display(),
                report.label
            )));
        }

        if let Err(error) = fs::rename(&temp_output, archive) {
            let _ = fs::remove_file(&temp_output);
            return Err(RomWeaverError::Validation(format!(
                "repack of `{}` could not replace the original archive: {error}",
                archive.display()
            )));
        }
        Ok(())
    }

    fn run_batch_header_fixer(&self, args: BatchHeaderFixerCommand) -> AppRunOutcome {
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
                OperationLabel {
                    command: "batch-header-fixer",
                    family: OperationFamily::Command,
                    format: Some("header-fix"),
                },
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
