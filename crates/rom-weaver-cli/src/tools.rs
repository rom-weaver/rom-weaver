use super::*;

impl CliApp {
    pub(super) fn run_tools(&self, command: ToolsCommands) -> AppRunOutcome {
        match command {
            ToolsCommands::PpfUndo(args) => self.run_ppf_undo(args),
        }
    }

    fn run_ppf_undo(&self, args: PpfUndoCommand) -> AppRunOutcome {
        let command = "tools-ppf-undo";
        let execution = None;
        for (label, path) in [("ROM", &args.rom), ("PPF patch", &args.patch)] {
            if let Some(report) = self.require_readable_path(
                command,
                OperationFamily::Patch,
                Some("PPF".to_string()),
                path,
                execution.clone(),
            ) {
                return self.finish(command, report);
            }
            if super::patch_apply::paths_refer_to_same_file(path, &args.output) {
                return self.finish(
                    command,
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some("PPF".to_string()),
                        "validate",
                        format!("PPF undo output and {label} resolve to the same file; choose a different --output path"),
                        execution.clone(),
                    ),
                );
            }
            if path.is_dir() {
                return self.finish(
                    command,
                    OperationReport::failed(
                        OperationFamily::Patch,
                        Some("PPF".to_string()),
                        "validate",
                        format!("{label} path is a directory: `{}`", path.display()),
                        execution.clone(),
                    ),
                );
            }
        }

        let context = self.context(args.threads);
        let mut temp_paths = Vec::new();
        let report = self
            .prepare_and_undo_ppf(&args, &context, &mut temp_paths)
            .unwrap_or_else(|error| {
                OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    Some("PPF".to_string()),
                    "undo",
                    error,
                    context.single_thread_execution(),
                )
            });
        Self::cleanup_temp_paths(&temp_paths);
        self.finish(command, report)
    }

    fn prepare_and_undo_ppf(
        &self,
        args: &PpfUndoCommand,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<OperationReport> {
        let compression_options = Self::parse_patch_apply_compression_options(
            args.no_compress,
            args.compress_format.clone(),
            args.compress_codec.clone(),
            args.compress_level,
        )?;
        let mut resolved_sources = Vec::new();
        let mut extracted_notes = Vec::new();
        for (label, source, select, rom_filter, patch_filter) in [
            ("PPF undo ROM", &args.rom, &args.select, true, false),
            (
                "PPF undo patch",
                &args.patch,
                &args.patch_select,
                false,
                true,
            ),
        ] {
            let resolve = if rom_filter {
                Self::resolve_ppf_undo_rom_source
            } else {
                Self::resolve_source_with_auto_extract
            };
            let resolved = resolve(
                self,
                source,
                select,
                context,
                AutoExtractResolutionLabels {
                    command: "tools-ppf-undo",
                    family: OperationFamily::Patch,
                    format: Some("PPF"),
                    source_label: label,
                    temp_prefix: "ppf-undo-input-extract",
                },
                AutoExtractResolutionFlags {
                    no_extract: args.no_extract,
                    no_ignore: args.no_ignore,
                    kind_filter: Self::archive_entry_kind_filter(rom_filter, patch_filter),
                    stop_on_single_payload_codec: false,
                },
            )?;
            temp_paths.extend(resolved.cleanup_paths);
            if resolved.extracted_archives > 0 {
                extracted_notes.push(format!(
                    "{label} source resolved via {} container extract step(s)",
                    resolved.extracted_archives
                ));
            }
            resolved_sources.push(resolved.source);
        }
        let resolved_rom = &resolved_sources[0];
        let patch = &resolved_sources[1];
        let disc = self.build_disc_context(resolved_rom, args.target.as_deref(), None, context)?;
        if disc.is_none() && args.target.is_some() {
            return Err(RomWeaverError::Validation(
                "--target requires a disc-sheet (.cue/.gdi) input".to_string(),
            ));
        }
        let input = disc
            .as_ref()
            .map(|disc| &disc.target_file)
            .unwrap_or(resolved_rom);
        let compression_options = self.resolve_patch_apply_output_options(
            compression_options,
            &args.output,
            resolved_rom,
        )?;
        let mut compression_plan = compression_options
            .enabled
            .then(|| {
                self.resolve_patch_apply_compression_plan(
                    &args.output,
                    resolved_rom,
                    &compression_options,
                )
            })
            .transpose()?;
        let output = compression_plan
            .as_ref()
            .map(|plan| plan.output_path.clone())
            .unwrap_or_else(|| args.output.clone());
        if disc.is_some() && !compression_options.enabled && detect_disc_sheet(&output).is_none() {
            return Err(RomWeaverError::Validation(format!(
                "--no-compress disc output `{}` must be a .cue/.gdi path so the tracks can be written beside it",
                output.display()
            )));
        }
        let mut sources = vec![
            args.rom.clone(),
            args.patch.clone(),
            resolved_rom.clone(),
            patch.clone(),
        ];
        let mut outputs = vec![output.clone()];
        if let Some(disc) = &disc {
            sources.extend(Self::disc_output_paths(disc, self.primary_disc_sheet(disc)));
            if !compression_options.enabled {
                outputs = Self::disc_output_paths(disc, &output);
            }
        }
        for destination in &outputs {
            for source in &sources {
                if super::patch_apply::paths_refer_to_same_file(source, destination) {
                    return Err(RomWeaverError::Validation(format!(
                        "PPF undo output and source `{}` resolve to the same file; choose a different --output path",
                        source.display()
                    )));
                }
            }
        }
        let raw_output = Self::patch_apply_raw_output_path(
            &output,
            input,
            context,
            "ppf-undo-restored",
            temp_paths,
        )?;
        self.emit_running(
            OperationLabel {
                command: "tools-ppf-undo",
                family: OperationFamily::Patch,
                format: Some("PPF"),
            },
            "undo",
            "restoring ROM from PPF undo data".to_string(),
            Some(0.0),
            context.single_thread_execution(),
        );
        rom_weaver_patches::undo_ppf(input, patch, &raw_output)?;
        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            Some("PPF".to_string()),
            "undo",
            format!("restored ROM written to `{}`", output.display()),
            Some(100.0),
            context.single_thread_execution(),
        );
        let mut ready_output = raw_output;
        if let Some(plan) = compression_plan.as_mut() {
            let staged_output = context.temp_paths().next_path(
                "ppf-undo-compressed",
                output.extension().and_then(|extension| extension.to_str()),
            );
            temp_paths.push(staged_output.clone());
            plan.output_path = staged_output.clone();
            let (compression_input, overrides) = if let Some(disc) = &disc {
                let replacement =
                    self.disc_target_track_override(disc, &ready_output, temp_paths)?;
                (
                    self.primary_disc_sheet(disc).to_path_buf(),
                    vec![replacement],
                )
            } else {
                (ready_output, Vec::new())
            };
            let (compressed, codec) = self.run_patch_apply_compression(
                "tools-ppf-undo",
                plan,
                vec![compression_input],
                &overrides,
                format!("compressing restored output as {}", plan.format),
                context,
            )?;
            if compressed.status != OperationStatus::Succeeded {
                return Ok(OperationReport {
                    family: OperationFamily::Patch,
                    format: Some("PPF".to_string()),
                    stage: "compress".to_string(),
                    ..compressed
                });
            }
            ready_output = staged_output;
            report.stage = "compress".to_string();
            report.label = format!(
                "{}; restored output compressed as {} (codec={codec}; {})",
                report.label, plan.format, plan.note
            );
            if plan.extension_appended {
                report
                    .label
                    .push_str("; output extension appended to match container format");
            }
            if let Some(warning) = &plan.warning {
                report.label.push_str(&format!("; warning: {warning}"));
            }
            Self::append_report_warnings(&mut report, plan.warning.clone());
        }
        if let Some(disc) = &disc {
            Self::append_report_warnings(&mut report, disc.warnings.clone());
            if !compression_options.enabled {
                ready_output =
                    self.stage_disc_directory(disc, &ready_output, context, temp_paths)?;
            }
        }
        for note in extracted_notes {
            report.label.push_str(&format!("; {note}"));
        }
        context.cancel().check()?;
        if let Some(parent) = output
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        if let Some(disc) = &disc
            && !compression_options.enabled
        {
            let note = self.write_disc_output(disc, &ready_output, &output)?;
            report.label.push_str(&format!("; {note}"));
        } else {
            fs::copy(&ready_output, &output)?;
        }
        Ok(Self::attach_emitted_files_details(
            report,
            outputs,
            Some(if compression_options.enabled {
                "archive"
            } else {
                "rom"
            }),
        ))
    }
}
