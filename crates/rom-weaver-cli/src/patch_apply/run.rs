//! The stages of `patch apply` after bundle resolution: settle the command,
//! resolve the route and sources, run the patch chain, then finalize, publish,
//! and report the output.

use super::*;

#[cfg(not(target_arch = "wasm32"))]
use super::super::bundle_cheats::SkippedBundleCheat;
use super::super::cheats_apply::CheatApplySummary;

/// The state shared by the stages of [`CliApp::run_patch_apply_resolved`].
/// Each stage fills its fields in order; a field that a later stage sets holds
/// an empty default before that stage runs.
struct PatchApplyRun {
    args: PatchApplyCommand,
    bundle_resolution: Option<BundleApplyResolution>,
    original_input: PathBuf,
    local_bundle: Option<PathBuf>,
    patch_step_metadata: Vec<PatchApplyStepMetadata>,
    bundle_step_metadata_selected: bool,
    direct_has_step_selectors: bool,
    direct_selectors_align: bool,
    has_manual_cheats: bool,
    #[cfg(not(target_arch = "wasm32"))]
    native_cheat_selection: bool,
    #[cfg(not(target_arch = "wasm32"))]
    bundle_cheats: Vec<BundleCheatEntry>,
    has_cheats: bool,
    discover_implicit_patches: bool,
    input_kind_filter: ArchiveEntryKindFilter,
    patch_kind_filter: ArchiveEntryKindFilter,
    context: OperationContext,
    probe_threads: Option<ThreadExecution>,
    any_explicit_n64_transform: bool,
    auto_evidence_available: bool,
    any_explicit_strip: bool,
    output_header_mode: PatchApplyOutputHeaderMode,
    compression_options: PatchApplyCompressionOptions,
    cached_input_checksums: BTreeMap<String, String>,
    expected_input_checksums: BTreeMap<String, String>,
    expected_output_checksums: BTreeMap<String, String>,
    // Set by `resolve_patch_apply_route`.
    disc_context: Option<DiscContext>,
    sidecar_cleanup_paths: Vec<PathBuf>,
    expected_input_size: Option<u64>,
    // Set by `resolve_patch_apply_target`.
    resolved_input: PathBuf,
    extracted_archives: usize,
    name_warning: Option<String>,
    output: PathBuf,
    output_was_inferred: bool,
    temp_paths: Vec<PathBuf>,
    // Set by `resolve_patch_apply_rom_members` and `resolve_patch_apply_patches`.
    rom_member_inputs: BTreeMap<String, PathBuf>,
    resolved_patches: Vec<ResolvedPatch>,
    extracted_patch_notes: Vec<String>,
    #[cfg(not(target_arch = "wasm32"))]
    skipped_bundle_cheats: Vec<SkippedBundleCheat>,
    cheat_summary: Option<CheatApplySummary>,
    // Set by `publish_patch_apply_output` when the run succeeds.
    terminal_output: Option<PathBuf>,
}

impl PatchApplyRun {
    fn is_disc(&self) -> bool {
        self.disc_context.is_some()
    }

    fn cheat_patch_count(&self) -> usize {
        usize::from(!self.args.codes.is_empty())
    }

    fn fail(&self, stage: &str, message: String) -> Box<OperationReport> {
        Box::new(OperationReport::failed(
            OperationFamily::Patch,
            None,
            stage,
            message,
            self.probe_threads.clone(),
        ))
    }

    fn fail_error(&self, stage: &str, error: RomWeaverError) -> Box<OperationReport> {
        Box::new(OperationReport::failed_with_error(
            OperationFamily::Patch,
            None,
            stage,
            error,
            self.probe_threads.clone(),
        ))
    }
}

/// The patch chain as planned before it runs, plus what the apply loop adds.
struct PatchApplyChain {
    checksum_verification_labels: Vec<String>,
    apply_input: PathBuf,
    header_state: ChainHeaderState,
    n64_order: Option<N64ByteOrderTransform>,
    add_header: bool,
    strip_output_header: bool,
    patch_count: usize,
    extension_swap_note: Option<String>,
    requires_compat_finalize: bool,
    staged_output: PathBuf,
    patch_steps: Vec<PatchApplyStep>,
    shared_patch_basis: PatchBasisMode,
    target_lanes_present: bool,
    // Set by the apply loop.
    applied_formats: Vec<&'static str>,
    disc_track_replacements: BTreeMap<PathBuf, PathBuf>,
}

/// Where the finished output bytes live on their way to the terminal path.
struct PatchApplyOutputPaths {
    terminal_output_path: PathBuf,
    raw_ready_output: PathBuf,
    terminal_output_source: PathBuf,
    disc_track_overrides: Vec<CreateInputOverride>,
}

impl CliApp {
    /// The body of `patch apply` after bundle resolution: `args` is a plain,
    /// fully-merged command.
    pub(super) fn run_patch_apply_resolved(
        &self,
        inputs: RunPatchApplyResolvedInputs<'_>,
    ) -> OperationReport {
        let RunPatchApplyResolvedInputs {
            args,
            bundle_resolution,
            original_input,
            local_bundle,
            final_output,
            emit_steps,
            applied_cheats,
        } = inputs;
        let mut run = match self.settle_patch_apply_run(
            args,
            bundle_resolution,
            original_input,
            local_bundle,
        ) {
            Ok(run) => run,
            Err(report) => return *report,
        };
        if let Err(report) = self
            .resolve_patch_apply_route(&mut run)
            .and_then(|()| self.resolve_patch_apply_target(&mut run))
            .and_then(|()| self.resolve_patch_apply_rom_members(&mut run))
            .and_then(|()| self.resolve_patch_apply_patches(&mut run, applied_cheats))
        {
            return *report;
        }
        let report = self.patch_apply_run_report(&mut run, emit_steps);
        Self::finish_patch_apply_run(report, run, final_output)
    }

    /// Split the command into the run state and settle every flag that does not
    /// need the file system.
    fn settle_patch_apply_run(
        &self,
        mut args: PatchApplyCommand,
        bundle_resolution: Option<BundleApplyResolution>,
        original_input: PathBuf,
        local_bundle: Option<PathBuf>,
    ) -> std::result::Result<PatchApplyRun, Box<OperationReport>> {
        let rom_filter = args.rom_filter();
        let patch_filter = args.patch_filter();
        let DirectPatchStepSelectors {
            steps: direct_step_metadata,
            has_selectors: direct_has_step_selectors,
            selectors_align: direct_selectors_align,
        } = prepare_direct_patch_step_selectors(
            std::mem::take(&mut args.patch_input),
            std::mem::take(&mut args.patch_target),
            std::mem::take(&mut args.patch_id),
            args.patches.len(),
        );
        let bundle_step_metadata_selected = bundle_resolution.is_some();
        let patch_step_metadata = bundle_resolution
            .as_ref()
            .map(|resolution| resolution.steps.clone())
            .unwrap_or(direct_step_metadata);
        let has_manual_cheats = !args.codes.is_empty();
        // `--cheat` resolves to records only once the input ROM is resolved, so
        // the flag - not the (still empty) record list - decides whether this
        // run has database cheats. A bundle's recorded cheats count the same.
        let native_cheat_selection = !args.cheat_selection.cheats.is_empty();
        // Native-only: resolving a bundle cheat reads the local cheat database.
        #[cfg(not(target_arch = "wasm32"))]
        let bundle_cheats = bundle_resolution
            .as_ref()
            .map(|resolution| resolution.cheats.clone())
            .unwrap_or_default();
        #[cfg(target_arch = "wasm32")]
        let bundle_cheats: Vec<BundleCheatEntry> = Vec::new();
        let has_database_cheats =
            !args.cheat_records.is_empty() || native_cheat_selection || !bundle_cheats.is_empty();
        let has_cheats = has_manual_cheats || has_database_cheats;
        let discover_implicit_patches = args.patches.is_empty() && !has_cheats && !args.no_extract;
        let input_kind_filter =
            Self::archive_entry_kind_filter(rom_filter || discover_implicit_patches, false);
        let patch_kind_filter = Self::archive_entry_kind_filter(false, patch_filter);
        let context = self.context(args.threads).with_patch_checksum_validation(
            if args.ignore_checksum_validation {
                PatchChecksumValidation::Ignore
            } else {
                PatchChecksumValidation::Strict
            },
        );
        let probe_threads = context.single_thread_execution();
        // Per-patch header modes: a missing entry inherits the last given mode;
        // an empty list means all-auto. N64 byte-order rewrites and cheat codes
        // pin offsets to the original bytes, so those runs degrade auto to keep.
        // Ignoring checksum enforcement does not discard representation evidence.
        let any_explicit_n64_transform = args
            .n64_byte_order
            .iter()
            .any(|mode| mode.target().is_some());
        let auto_evidence_available = !any_explicit_n64_transform && !has_manual_cheats;
        let any_explicit_strip = args.patch_header.contains(&PatchApplyHeaderMode::Strip);
        let output_header_mode = args.output_header.unwrap_or_default();
        let fail_error = |stage: &str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                None,
                stage,
                error,
                probe_threads.clone(),
            ))
        };
        if has_manual_cheats && (any_explicit_strip || any_explicit_n64_transform) {
            return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "--code cannot be combined with --patch-header strip or --n64-byte-order; cheat offsets are computed against the original ROM bytes".to_string(),
                    probe_threads.clone(),
                )));
        }
        let ParsedPatchApplyInputs {
            compression_options,
            cached_input_checksums,
            expected_input_checksums,
            expected_output_checksums,
        } = Self::parse_patch_apply_inputs(
            &args.assume_in,
            &args.expect_in,
            &args.expect_out,
            args.no_compress,
            args.compress_format.clone(),
            args.compress_codec.clone(),
            args.compress_level,
        )
        .map_err(|error| fail_error("validate", error))?;
        Ok(PatchApplyRun {
            args,
            bundle_resolution,
            original_input,
            local_bundle,
            patch_step_metadata,
            bundle_step_metadata_selected,
            direct_has_step_selectors,
            direct_selectors_align,
            has_manual_cheats,
            #[cfg(not(target_arch = "wasm32"))]
            native_cheat_selection,
            #[cfg(not(target_arch = "wasm32"))]
            bundle_cheats,
            has_cheats,
            discover_implicit_patches,
            input_kind_filter,
            patch_kind_filter,
            context,
            probe_threads,
            any_explicit_n64_transform,
            auto_evidence_available,
            any_explicit_strip,
            output_header_mode,
            compression_options,
            cached_input_checksums,
            expected_input_checksums,
            expected_output_checksums,
            disc_context: None,
            sidecar_cleanup_paths: Vec::new(),
            expected_input_size: None,
            resolved_input: PathBuf::new(),
            extracted_archives: 0,
            name_warning: None,
            output: PathBuf::new(),
            output_was_inferred: false,
            temp_paths: Vec::new(),
            rom_member_inputs: BTreeMap::new(),
            resolved_patches: Vec::new(),
            extracted_patch_notes: Vec::new(),
            #[cfg(not(target_arch = "wasm32"))]
            skipped_bundle_cheats: Vec::new(),
            cheat_summary: None,
            terminal_output: None,
        })
    }

    /// Check the input, answer a dry run, pick the disc or plain route, find
    /// sidecar patches, and merge the input and output requirements.
    fn resolve_patch_apply_route(
        &self,
        run: &mut PatchApplyRun,
    ) -> std::result::Result<(), Box<OperationReport>> {
        if let Some(report) = self.require_readable_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &run.args.input,
            run.probe_threads.clone(),
        ) {
            return Err(Box::new(report));
        }
        if run.args.dry_run {
            let report = self.run_patch_apply_dry_run(
                &run.args.input,
                &run.args.patches,
                run.args.output.as_deref(),
                &run.compression_options,
                run.probe_threads.clone(),
            );
            return Err(Box::new(report));
        }
        run.disc_context = self.resolve_patch_apply_disc(PatchApplyDiscInputs {
            input: &run.args.input,
            target: run.args.target.as_deref(),
            patches: &run.args.patches,
            ignore_checksum_validation: run.args.ignore_checksum_validation,
            any_explicit_strip: run.any_explicit_strip,
            output_header: run.args.output_header,
            repair_checksum: run.args.repair_checksum,
            any_explicit_n64_transform: run.any_explicit_n64_transform,
            has_expected_output_checksums: !run.expected_output_checksums.is_empty(),
            context: &run.context,
        })?;
        let is_disc = run.is_disc();
        trace!(
            is_disc,
            patches = run.args.patches.len(),
            no_compress = run.args.no_compress,
            "patch apply route resolved"
        );
        let discovered_sidecars = self
            .discover_patch_apply_sidecars_for_run(
                run.discover_implicit_patches && !is_disc,
                &run.args.input,
                &run.args.select,
                run.args.no_ignore,
                &run.context,
            )
            .map_err(|error| run.fail_error("prepare", error))?;
        if run.args.patches.is_empty() {
            run.args.patches = discovered_sidecars.patches.clone();
        }
        run.sidecar_cleanup_paths = discovered_sidecars.cleanup_paths;
        if run.args.patches.is_empty() && !run.has_cheats {
            return Err(run.fail(
                    "validate",
                    "patch apply requires at least one --patch file, --code, or RetroArch-style sidecar patch inside the input archive".to_string(),
                ));
        }
        // Input-check precedence is CLI > bundle > file name; any conflict
        // names the bundle source that introduced it.
        if let Some(report) =
            self.merge_patch_apply_requirements(MergePatchApplyRequirementsInputs {
                ignore_checksum_validation: run.args.ignore_checksum_validation,
                bundle_resolution: run.bundle_resolution.as_ref(),
                is_disc,
                patches: &run.args.patches,
                expected_input_checksums: &mut run.expected_input_checksums,
                expected_input_size: &mut run.expected_input_size,
                expected_output_checksums: &mut run.expected_output_checksums,
                probe_threads: run.probe_threads.clone(),
            })
        {
            return Err(Box::new(report));
        }
        Ok(())
    }

    /// Resolve the ROM the chain starts from and the output it writes, then
    /// check that the output is free and every path is accessible.
    fn resolve_patch_apply_target(
        &self,
        run: &mut PatchApplyRun,
    ) -> std::result::Result<(), Box<OperationReport>> {
        // For a disc input the patch applies to the chosen track directly (no
        // container auto-extract); the full disc is reassembled after the apply
        // loop. Plain inputs resolve through the normal auto-extract path.
        let (resolved_input, extracted_archives, input_cleanup_paths) =
            if let Some(disc) = run.disc_context.as_ref() {
                (disc.target_file.clone(), 0usize, Vec::new())
            } else {
                let input_select = run
                    .bundle_resolution
                    .as_ref()
                    .and_then(|resolution| resolution.rom_member.as_ref())
                    .map(std::slice::from_ref)
                    .unwrap_or(&run.args.select);
                let resolved = self
                    .resolve_source_with_auto_extract(
                        &run.args.input,
                        input_select,
                        &run.context,
                        AutoExtractResolutionLabels {
                            command: "patch-apply",
                            family: OperationFamily::Patch,
                            format: None,
                            source_label: "patch apply input",
                            temp_prefix: "patch-apply-input-extract",
                        },
                        AutoExtractResolutionFlags {
                            no_extract: run.args.no_extract,
                            no_ignore: run.args.no_ignore,
                            kind_filter: run.input_kind_filter,
                            stop_on_single_payload_codec: false,
                        },
                    )
                    .map_err(|error| run.fail_error("prepare", error))?;
                let ResolvedChecksumSource {
                    source,
                    extracted_archives,
                    cleanup_paths,
                } = resolved;
                (source, extracted_archives, cleanup_paths)
            };
        run.resolved_input = resolved_input;
        run.extracted_archives = extracted_archives;
        run.name_warning = warn_on_rom_name_mismatch(
            run.bundle_resolution
                .as_ref()
                .and_then(|resolution| resolution.expected_rom_name.as_deref()),
            &run.resolved_input,
        );
        let (output, output_was_inferred) = self
            .resolve_patch_apply_output_path(
                run.args.output.take(),
                &run.args.input,
                &run.resolved_input,
                run.args.no_compress,
                run.args.compress_format.as_deref(),
            )
            .map_err(|error| run.fail_error("validate", error))?;
        run.output = output;
        run.output_was_inferred = output_was_inferred;
        if let Some(message) = Self::patch_apply_output_alias_message(
            &run.args.input,
            &run.args.patches,
            &run.original_input,
            run.local_bundle.as_deref(),
            &run.output,
        ) {
            return Err(run.fail("validate", message));
        }
        run.compression_options = self
            .resolve_patch_apply_compression_options(
                run.args.no_compress,
                run.args.compress_format.clone(),
                run.args.compress_codec.clone(),
                run.args.compress_level,
                &run.output,
                &run.resolved_input,
            )
            .map_err(|error| run.fail_error("validate", error))?;
        // Compressing can append an extension; the compression step re-checks
        // that resolved path after patch validation.
        ensure_output_available(&run.output, run.args.force)
            .map_err(|error| run.fail_error("validate", error))?;
        if let Some(report) = self.validate_patch_apply_access(
            &run.args.patches,
            &run.output,
            run.probe_threads.clone(),
        ) {
            return Err(Box::new(report));
        }
        // Seed host-provided input checksums so handler source verification skips
        // a re-read. Keyed by the resolved path; header/N64 transforms write a
        // distinct temp path whose lookup misses and recomputes. Skipped for disc
        // apply, where the cached checksums describe the whole disc, not the track.
        if run.disc_context.is_none() {
            run.context
                .seed_checksums(&run.resolved_input, &run.cached_input_checksums);
        }
        run.temp_paths = input_cleanup_paths;
        Ok(())
    }

    /// Resolve every ROM member a chain step names as its input or target.
    fn resolve_patch_apply_rom_members(
        &self,
        run: &mut PatchApplyRun,
    ) -> std::result::Result<(), Box<OperationReport>> {
        let bundle_rom_member = run
            .bundle_resolution
            .as_ref()
            .and_then(|resolution| resolution.rom_member.as_ref());
        let explicit_rom_members: BTreeSet<&str> = run
            .patch_step_metadata
            .iter()
            .flat_map(|step| [&step.input, &step.target])
            .filter_map(|input| match input.as_ref() {
                Some(BundlePatchInput::Rom {
                    member: Some(member),
                    ..
                }) => Some(member.as_str()),
                _ => None,
            })
            .collect();
        let fail_error = |stage: &str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                None,
                stage,
                error,
                run.probe_threads.clone(),
            ))
        };
        for member in explicit_rom_members {
            if let Some(disc) = run.disc_context.as_ref() {
                let path = self
                    .disc_member_path(disc, member)
                    .map_err(|error| fail_error("prepare", error))?;
                run.rom_member_inputs.insert(member.to_owned(), path);
                continue;
            }
            if bundle_rom_member.is_some_and(|root_member| root_member == member) {
                run.rom_member_inputs
                    .insert(member.to_owned(), run.resolved_input.clone());
                continue;
            }
            let resolved = self
                .resolve_exact_member_source(
                    &run.args.input,
                    member,
                    &run.context,
                    AutoExtractResolutionLabels {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                        source_label: "bundle ROM member",
                        temp_prefix: "patch-apply-bundle-rom-member",
                    },
                    AutoExtractResolutionFlags {
                        no_extract: run.args.no_extract,
                        no_ignore: run.args.no_ignore,
                        kind_filter: run.input_kind_filter,
                        stop_on_single_payload_codec: false,
                    },
                )
                .map_err(|error| fail_error("prepare", error))?;
            if resolved.extracted_archives == 0 {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "prepare",
                    format!("bundle ROM input has no extractable member `{member}`"),
                    run.probe_threads.clone(),
                )));
            }
            run.temp_paths.extend(resolved.cleanup_paths);
            run.rom_member_inputs
                .insert(member.to_owned(), resolved.source);
        }
        Ok(())
    }

    /// Resolve the patch files, check the step metadata against them, and add
    /// the cheats: database cheats as records, `--code` as a synthetic patch.
    fn resolve_patch_apply_patches(
        &self,
        run: &mut PatchApplyRun,
        applied_cheats: &mut Vec<BundleCheatEntry>,
    ) -> std::result::Result<(), Box<OperationReport>> {
        run.temp_paths
            .extend(std::mem::take(&mut run.sidecar_cleanup_paths));
        let ResolvedPatchList {
            patches: resolved_patches,
            extracted_notes: extracted_patch_notes,
        } = self
            .resolve_patches(
                &run.args.patches,
                PatchSelectors {
                    select: &run.args.select,
                    per_patch: &run.args.patch_select,
                },
                &run.context,
                AutoExtractResolutionFlags {
                    no_extract: run.args.no_extract,
                    no_ignore: run.args.no_ignore,
                    kind_filter: run.patch_kind_filter,
                    stop_on_single_payload_codec: false,
                },
                PatchResolveLabels {
                    command: "patch-apply",
                    noun: "patch apply",
                    temp_prefix: "patch-apply-patch-extract",
                },
                &mut run.temp_paths,
            )
            .map_err(|error| run.fail_error("prepare", error))?;
        run.resolved_patches = resolved_patches;
        run.extracted_patch_notes = extracted_patch_notes;
        if let Err(report) = validate_resolved_patch_apply_step_metadata(
            &run.patch_step_metadata,
            run.resolved_patches.len(),
            run.bundle_step_metadata_selected,
            run.direct_has_step_selectors,
            run.direct_selectors_align,
            &run.probe_threads,
        ) {
            Self::cleanup_temp_paths(&run.temp_paths);
            return Err(report);
        }

        // Resolve the bundle's recorded cheats and `--cheat` against the
        // resolved input ROM. Both bake after the patch chain, like the
        // webapp's. Native-only: the cheat database lives on disk.
        #[cfg(not(target_arch = "wasm32"))]
        match self.resolve_patch_apply_cheats(
            &run.resolved_input,
            &run.bundle_cheats,
            &run.args.cheat_selection,
            run.native_cheat_selection,
            &run.context,
        ) {
            Ok(cheats) => {
                run.args.cheat_records.extend(cheats.rom_records);
                applied_cheats.extend(cheats.applied);
                run.skipped_bundle_cheats = cheats.skipped;
            }
            Err(error) => {
                Self::cleanup_temp_paths(&run.temp_paths);
                return Err(run.fail_error("prepare", error));
            }
        }
        #[cfg(target_arch = "wasm32")]
        let _ = applied_cheats;

        // Bake cheat codes into a synthetic IPS patch applied after the explicit
        // patches, so a cheat wins over a patch that touches the same byte and a
        // checksum-carrying patch still sees the ROM it was built for. Offsets
        // are resolved against the input ROM bytes (header strip / N64
        // byte-order rewrite are rejected above so they stay valid), which is
        // the same basis the browser workflow uses.
        if run.has_manual_cheats {
            match self.synthesize_cheat_ips(CheatIpsRequest {
                source: &run.resolved_input,
                codes: &run.args.codes,
                system_override: run.args.code_system.as_deref(),
                kind_id: &run.args.code_kind,
                context: &run.context,
                temp_paths: &mut run.temp_paths,
            }) {
                Ok((cheat_patch, summary)) => {
                    run.cheat_summary = Some(summary);
                    run.resolved_patches.push(ResolvedPatch {
                        source: cheat_patch.clone(),
                        resolved: cheat_patch,
                    });
                }
                Err(error) => {
                    Self::cleanup_temp_paths(&run.temp_paths);
                    return Err(run.fail_error("prepare", error));
                }
            }
        }
        Ok(())
    }

    /// Reject a run with nothing left to apply, or run the chain.
    fn patch_apply_run_report(
        &self,
        run: &mut PatchApplyRun,
        emit_steps: Option<&mut Vec<PatchApplyStepMetadata>>,
    ) -> OperationReport {
        // Now that the selection is resolved, the record list - not the flags -
        // says whether this run bakes anything.
        let has_database_cheats = !run.args.cheat_records.is_empty();
        #[cfg(not(target_arch = "wasm32"))]
        let every_bundle_cheat_skipped = run.resolved_patches.is_empty()
            && !has_database_cheats
            && !run.skipped_bundle_cheats.is_empty();
        #[cfg(target_arch = "wasm32")]
        let every_bundle_cheat_skipped = false;
        if every_bundle_cheat_skipped {
            // Every recorded cheat was optional and unresolvable, so the run
            // has no patch and no cheat left: say which ones went missing
            // rather than report a bare "not executed".
            #[cfg(not(target_arch = "wasm32"))]
            let detail = run
                .skipped_bundle_cheats
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            #[cfg(target_arch = "wasm32")]
            let detail = String::new();
            OperationReport::failed(
                OperationFamily::Patch,
                Some("cheat".to_string()),
                "validate",
                format!(
                    "every cheat this bundle records was skipped, so there is nothing to apply: \
                     {detail}"
                ),
                run.probe_threads.clone(),
            )
        } else if run.resolved_patches.is_empty() && !has_database_cheats {
            OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                "at least one --patch value or --code is required",
                run.probe_threads.clone(),
            )
        } else {
            self.execute_patch_apply_chain(run, has_database_cheats, emit_steps)
        }
    }

    /// Plan the chain, run it, then finalize, compress, and publish its output.
    fn execute_patch_apply_chain(
        &self,
        run: &mut PatchApplyRun,
        has_database_cheats: bool,
        emit_steps: Option<&mut Vec<PatchApplyStepMetadata>>,
    ) -> OperationReport {
        let mut chain = match self.plan_patch_apply_chain(run, has_database_cheats, emit_steps) {
            Ok(chain) => chain,
            Err(report) => return *report,
        };
        let is_disc = run.is_disc();
        let PatchApplyLoopOutcome {
            mut report,
            applied_formats,
            disc_track_replacements,
        } = match self.run_patch_apply_loop(RunPatchApplyLoopInputs {
            steps: &chain.patch_steps,
            apply_input: std::mem::take(&mut chain.apply_input),
            staged_output: &chain.staged_output,
            plan_target_lanes: chain.target_lanes_present,
            shared_patch_basis: chain.shared_patch_basis,
            rom_member_inputs: &run.rom_member_inputs,
            generated_member_flags: AutoExtractResolutionFlags {
                no_extract: run.args.no_extract,
                no_ignore: run.args.no_ignore,
                kind_filter: run.input_kind_filter,
                stop_on_single_payload_codec: false,
            },
            disc: run.disc_context.as_ref(),
            header_state: &mut chain.header_state,
            n64_order: &mut chain.n64_order,
            probe_threads: &run.probe_threads,
            context: &run.context,
            temp_paths: &mut run.temp_paths,
            cheat_records: &run.args.cheat_records,
            cheat_positions: &run.args.cheat_positions,
            allow_cheat_conflicts: run.args.cheat_selection.allow_cheat_conflicts,
        }) {
            Ok(outcome) => outcome,
            Err(report) => return *report,
        };
        chain.applied_formats = applied_formats;
        chain.disc_track_replacements = disc_track_replacements;

        // Mid-chain transitions may have changed the header state; chains always
        // stage (patch_count > 1 forces the compat finalize), so re-resolving the
        // output-header decision and the extension swap here still lands before
        // the finalize copy chooses its destination.
        if chain.patch_count > 1 {
            (chain.add_header, chain.strip_output_header) = Self::resolve_patch_apply_output_header(
                &chain.header_state,
                run.output_header_mode,
                run.args.output_header,
                is_disc,
            );
            if report.status == OperationStatus::Succeeded
                && !is_disc
                && let Some((swapped_output, note)) = Self::resolve_header_extension_swap(
                    &run.output,
                    &chain.header_state,
                    chain.add_header,
                    chain.strip_output_header,
                    &chain.staged_output,
                )
            {
                run.output = swapped_output;
                chain.extension_swap_note = Some(note);
            }
            if let Some(report) = Self::inferred_output_collision_report(
                run.output_was_inferred,
                &mut run.output,
                &run.args.input,
                run.context.single_thread_execution(),
            ) {
                return report;
            }
        }
        let mut paths = PatchApplyOutputPaths {
            terminal_output_path: run.output.clone(),
            raw_ready_output: chain.staged_output.clone(),
            terminal_output_source: chain.staged_output.clone(),
            disc_track_overrides: Vec::new(),
        };
        if report.status == OperationStatus::Succeeded
            && chain.requires_compat_finalize
            && let Err(error_report) =
                self.finalize_patch_apply_compat(run, &chain, &mut report, &mut paths)
        {
            return *error_report;
        }
        if is_disc
            && report.status == OperationStatus::Succeeded
            && let Err(error_report) =
                self.reassemble_patch_apply_disc(run, &chain, &mut report, &mut paths)
        {
            return *error_report;
        }
        self.publish_patch_apply_output(run, &mut chain, report, paths)
    }

    /// Prepare the chain input, settle the output header and staging, and
    /// resolve every step's input basis before the chain runs.
    fn plan_patch_apply_chain(
        &self,
        run: &mut PatchApplyRun,
        has_database_cheats: bool,
        emit_steps: Option<&mut Vec<PatchApplyStepMetadata>>,
    ) -> std::result::Result<PatchApplyChain, Box<OperationReport>> {
        let is_disc = run.is_disc();
        let PatchApplyPreparedChain {
            chain_header_modes,
            chain_n64_modes,
            checksum_verification_labels,
            apply_input,
            header_state,
            n64_order,
        } = self.prepare_patch_apply_chain(PatchApplyPrepareChainInputs {
            resolved_patches: &run.resolved_patches,
            resolved_input: &run.resolved_input,
            is_disc,
            has_codes: run.has_manual_cheats,
            patch_header: &run.args.patch_header,
            auto_evidence_available: run.auto_evidence_available,
            n64_byte_order: &run.args.n64_byte_order,
            expected_input_checksums: &run.expected_input_checksums,
            cached_input_checksums: &run.cached_input_checksums,
            expected_input_size: run.expected_input_size,
            repair_checksum: run.args.repair_checksum,
            context: &run.context,
            temp_paths: &mut run.temp_paths,
        })?;
        let (add_header, strip_output_header) = Self::resolve_patch_apply_output_header(
            &header_state,
            run.output_header_mode,
            run.args.output_header,
            is_disc,
        );

        let patch_count = run.resolved_patches.len() + usize::from(has_database_cheats);
        // Single-patch runs know the final header state up front, so the
        // extension swap lands before any writer chooses a path - no
        // post-hoc rename, which the browser VFS cannot observe. Chains
        // re-evaluate after the loop (they always stage).
        let mut extension_swap_note: Option<String> = None;
        if patch_count == 1
            && !is_disc
            && let Some((swapped_output, note)) = Self::resolve_header_extension_swap(
                &run.output,
                &header_state,
                add_header,
                strip_output_header,
                &run.resolved_input,
            )
        {
            run.output = swapped_output;
            extension_swap_note = Some(note);
        }
        if let Some(report) = Self::inferred_output_collision_report(
            run.output_was_inferred,
            &mut run.output,
            &run.args.input,
            run.context.single_thread_execution(),
        ) {
            return Err(Box::new(report));
        }
        // Disc inputs reject the header/N64 transforms and do their own
        // reassembly, so they skip the standard compat finalize; they always
        // stage the patched track before reassembling the full disc.
        let requires_compat_finalize = !is_disc
            && (add_header
                || strip_output_header
                || run.args.repair_checksum
                || n64_order.is_some()
                || patch_count > 1);
        let needs_staged_output =
            is_disc || requires_compat_finalize || run.compression_options.enabled;
        let failed = |stage: &str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                None,
                stage,
                error,
                run.context.single_thread_execution(),
            ))
        };
        let staged_output = Self::patch_apply_staged_output(
            &run.output,
            &run.resolved_input,
            run.output_was_inferred,
            needs_staged_output,
            run.compression_options.enabled,
            &run.context,
            &mut run.temp_paths,
        )
        .map_err(|error| failed("prepare", error))?;

        // Resolve every step's input basis (CLI flag > bundle declaration >
        // inference against the prepared input) and verify declared
        // base-basis steps against the base once, before the chain runs.
        let cheat_patch_count = run.cheat_patch_count();
        merge_apply_step_declarations(
            &mut run.patch_step_metadata,
            &run.args.patch_input_check,
            &run.args.patch_output_check,
            run.resolved_patches.len().saturating_sub(cheat_patch_count),
        )
        .map_err(|error| failed("validate", error))?;
        let mut patch_steps = normalize_patch_apply_steps(
            std::mem::take(&mut run.resolved_patches),
            &run.patch_step_metadata,
            &run.args.patch_basis,
            &chain_header_modes,
            &chain_n64_modes,
            cheat_patch_count,
        );
        let shared_patch_basis = run
            .bundle_resolution
            .as_ref()
            .map(|resolution| resolution.patch_basis)
            .unwrap_or(run.args.default_patch_basis.unwrap_or(PatchBasisMode::Auto));
        // A target lane may begin from another ROM member or from a
        // generated output. Plan it only after that seed is available;
        // using the command's root input here would verify its authored
        // base checks against unrelated bytes.
        let target_lanes_present = patch_steps
            .iter()
            .any(|step| step.metadata.target.is_some());
        if !target_lanes_present {
            self.plan_apply_step_verifications(
                &mut patch_steps,
                cheat_patch_count,
                shared_patch_basis,
                run.args.patch_basis.len(),
                PatchApplyBaseInputs {
                    prepared: apply_input.as_path(),
                    original: run.resolved_input.as_path(),
                    prepared_headerless: header_state.headerless.then_some(true),
                    prepared_n64_byte_order: n64_order.map(|order| order.from),
                    original_n64_byte_order: n64_order.map(|order| order.to),
                },
                &run.context,
            )
            .map_err(|error| failed("validate", error))?;
            Self::update_emit_bundle_bases(emit_steps, &patch_steps);
        }
        Ok(PatchApplyChain {
            checksum_verification_labels,
            apply_input,
            header_state,
            n64_order,
            add_header,
            strip_output_header,
            patch_count,
            extension_swap_note,
            requires_compat_finalize,
            staged_output,
            patch_steps,
            shared_patch_basis,
            target_lanes_present,
            applied_formats: Vec::new(),
            disc_track_replacements: BTreeMap::new(),
        })
    }

    /// Apply the output header, checksum repair, and N64 byte-order restore to
    /// the staged chain output.
    fn finalize_patch_apply_compat(
        &self,
        run: &mut PatchApplyRun,
        chain: &PatchApplyChain,
        report: &mut OperationReport,
        paths: &mut PatchApplyOutputPaths,
    ) -> std::result::Result<(), Box<OperationReport>> {
        let failed = |format: Option<String>, stage: &str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                format,
                stage,
                error,
                run.context.single_thread_execution(),
            ))
        };
        self.emit_running(
            OperationLabel {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: chain.applied_formats.last().copied(),
            },
            "compat",
            if chain.add_header || run.args.repair_checksum {
                "finalizing compatibility output transforms"
            } else {
                "finalizing multi-patch output"
            },
            None,
            run.context.single_thread_execution(),
        );
        let finalized_output_path = if run.compression_options.enabled || run.output_was_inferred {
            Self::patch_apply_raw_output_path(
                &run.output,
                &run.resolved_input,
                &run.context,
                "patch-apply-output-raw-final",
                &mut run.temp_paths,
            )
            .map_err(|error| failed(report.format.clone(), "prepare", error))?
        } else {
            run.output.clone()
        };
        let finalized = Self::finalize_patch_apply_output(
            &chain.staged_output,
            &finalized_output_path,
            chain.add_header,
            chain.header_state.stripped_header.as_deref(),
            chain.strip_output_header,
            run.args.repair_checksum,
            crate::header_detection_and_finalize::PatchApplyFinalizeOptions {
                repair_hint_path: Some(&run.resolved_input),
                restore_n64_order: chain.n64_order.filter(|order| order.from != order.to),
            },
        )
        .map_err(|error| failed(report.format.clone(), "compat", error))?;
        paths.raw_ready_output = finalized_output_path;
        if run.output_was_inferred {
            paths.terminal_output_source = paths.raw_ready_output.clone();
        }
        Self::append_patch_apply_repair_notes(report, finalized);
        Ok(())
    }

    /// Reassemble the full disc from the patched track. When compressing,
    /// only the patched track is redirected via a create override (untouched
    /// tracks read in place; no whole-disc scratch copy) and the original sheet
    /// feeds the compressor. With --no-compress the disc is staged and written
    /// beside `output` directly.
    fn reassemble_patch_apply_disc(
        &self,
        run: &mut PatchApplyRun,
        chain: &PatchApplyChain,
        report: &mut OperationReport,
        paths: &mut PatchApplyOutputPaths,
    ) -> std::result::Result<(), Box<OperationReport>> {
        let disc = run
            .disc_context
            .as_ref()
            .expect("disc context present for disc input");
        let failed = |format: Option<String>, stage: &str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                format,
                stage,
                error,
                run.context.single_thread_execution(),
            ))
        };
        for warning in &disc.warnings {
            report.label = format!("{}; {}", report.label, warning);
        }
        Self::append_report_warnings(report, disc.warnings.iter().cloned());
        if run.compression_options.enabled {
            paths.disc_track_overrides = self
                .disc_track_overrides(disc, &chain.disc_track_replacements)
                .map_err(|error| failed(report.format.clone(), "prepare", error))?;
            paths.raw_ready_output = self.primary_disc_sheet(disc).to_path_buf();
            return Ok(());
        }
        let staged_sheet = self
            .stage_disc_directory_with_tracks(
                disc,
                &chain.disc_track_replacements,
                &run.context,
                &mut run.temp_paths,
            )
            .map_err(|error| failed(report.format.clone(), "prepare", error))?;
        let disc_output = if run.output_was_inferred {
            &chain.staged_output
        } else {
            &run.output
        };
        let note = self
            .write_disc_output(disc, &staged_sheet, disc_output)
            .map_err(|error| failed(report.format.clone(), "compat", error))?;
        report.label = format!("{}; {}", report.label, note);
        paths.raw_ready_output = staged_sheet;
        if run.output_was_inferred {
            paths.terminal_output_source = chain.staged_output.clone();
        }
        Ok(())
    }

    /// Decorate the report, compress the output when asked, publish an
    /// inferred output, and attach the emitted file paths.
    fn publish_patch_apply_output(
        &self,
        run: &mut PatchApplyRun,
        chain: &mut PatchApplyChain,
        mut report: OperationReport,
        paths: PatchApplyOutputPaths,
    ) -> OperationReport {
        let PatchApplyOutputPaths {
            mut terminal_output_path,
            raw_ready_output,
            mut terminal_output_source,
            disc_track_overrides,
        } = paths;
        if let Err(error_report) = self.decorate_patch_apply_report(
            &mut report,
            &mut chain.checksum_verification_labels,
            PatchApplyReportDecoration {
                patch_count: chain.patch_count,
                applied_formats: &chain.applied_formats,
                header_state: &chain.header_state,
                extension_swap_note: chain.extension_swap_note.as_deref(),
                n64_order: chain.n64_order,
                steps: &chain.patch_steps,
                extracted_archives: run.extracted_archives,
                extracted_patch_notes: &run.extracted_patch_notes,
                expected_output_checksums: &run.expected_output_checksums,
                raw_ready_output: &raw_ready_output,
                context: &run.context,
            },
        ) {
            return *error_report;
        }

        if report.status == OperationStatus::Succeeded
            && run.compression_options.enabled
            && let Err(error_report) = self.resolve_guarded_patch_apply_compression_plan(
                &run.output,
                &run.resolved_input,
                &run.compression_options,
                run.args.force,
                report.format.clone(),
                &run.context,
            )
        {
            return *error_report;
        }
        if let Some(error_report) = self.compress_patch_apply_output(PatchApplyCompressionInputs {
            report: &mut report,
            compression_options: &run.compression_options,
            output: &run.output,
            output_was_inferred: run.output_was_inferred,
            resolved_input: &run.resolved_input,
            is_disc: run.is_disc(),
            raw_ready_output: &raw_ready_output,
            disc_track_overrides: &disc_track_overrides,
            context: &run.context,
            temp_paths: &mut run.temp_paths,
            terminal_output_path: &mut terminal_output_path,
            terminal_output_source: &mut terminal_output_source,
        }) {
            return error_report;
        }

        if let Err(error) = Self::publish_inferred_patch_apply_output_if_needed(
            run.output_was_inferred,
            report.status,
            &terminal_output_source,
            &mut terminal_output_path,
            &run.args.input,
        ) {
            return OperationReport::failed_with_error(
                OperationFamily::Patch,
                report.format.clone(),
                "publish",
                error,
                run.context.single_thread_execution(),
            );
        }
        run.terminal_output =
            (report.status == OperationStatus::Succeeded).then(|| terminal_output_path.clone());

        let kind_hint = run.compression_options.enabled.then_some("archive");
        let emitted_paths = match run.disc_context.as_ref() {
            Some(disc) if !run.compression_options.enabled => {
                Self::disc_output_paths(disc, &terminal_output_path)
            }
            _ => vec![terminal_output_path],
        };
        Self::attach_emitted_files_details(report, emitted_paths, kind_hint)
    }

    /// Add the run-wide warnings and cheat notes to the report, hand the
    /// terminal output to the caller, and remove the temporary files.
    fn finish_patch_apply_run(
        mut report: OperationReport,
        run: PatchApplyRun,
        final_output: &mut Option<PathBuf>,
    ) -> OperationReport {
        Self::append_report_warnings(&mut report, run.name_warning);
        if report.status == OperationStatus::Succeeded
            && let Some(summary) = run.cheat_summary
        {
            report.label = format!("{}; {}", report.label, summary.label());
        }
        #[cfg(not(target_arch = "wasm32"))]
        if report.status == OperationStatus::Succeeded && !run.skipped_bundle_cheats.is_empty() {
            report.label = format!(
                "{}; skipped {} optional bundle cheat(s): {}",
                report.label,
                run.skipped_bundle_cheats.len(),
                run.skipped_bundle_cheats
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            Self::append_report_warnings(
                &mut report,
                [format!(
                    "skipped optional bundle cheats: {}",
                    run.skipped_bundle_cheats
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                )],
            );
        }

        *final_output = run.terminal_output;
        Self::cleanup_temp_paths(&run.temp_paths);
        report
    }
}
