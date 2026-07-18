use super::*;

use super::bundle_apply::BundleApplyResolution;
use super::bundle_parse::bundle_validation;
use super::patch_commands::{
    DiscoveredPatchApplySidecars, PatchApplyProgressSink, PatchApplyProgressTracker,
    patch_progress_segment_start,
};

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (fs::canonicalize(left), fs::canonicalize(right)),
            (Ok(left), Ok(right)) if left == right
        )
        || native_file_identity_matches(left, right)
}

#[cfg(unix)]
fn native_file_identity_matches(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    matches!(
        (fs::metadata(left), fs::metadata(right)),
        (Ok(left), Ok(right)) if left.dev() == right.dev() && left.ino() == right.ino()
    )
}

#[cfg(windows)]
fn native_file_identity_matches(left: &Path, right: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;

    matches!(
        (fs::metadata(left), fs::metadata(right)),
        (Ok(left), Ok(right))
            if left.volume_serial_number().is_some()
                && left.volume_serial_number() == right.volume_serial_number()
                && left.file_index().is_some()
                && left.file_index() == right.file_index()
    )
}

#[cfg(not(any(unix, windows)))]
fn native_file_identity_matches(_left: &Path, _right: &Path) -> bool {
    false
}

/// Snapshot of a resolved apply, captured before `args` moves into the run, so
/// `--emit-bundle` can describe exactly what was applied.
struct EmitBundleInputs {
    input: PathBuf,
    patches: Vec<PathBuf>,
    headers: Vec<PatchApplyHeaderMode>,
    bases: Vec<PatchBasisMode>,
    output: Option<PathBuf>,
    threads: ThreadBudget,
}

impl CliApp {
    pub(super) fn run_patch_apply(&self, args: PatchApplyCommand) -> AppRunOutcome {
        let rom_filter = args.rom_filter();
        let patch_filter = args.patch_filter();
        trace!(
            input = %args.input.display(),
            selections = args.select.len(),
            target = ?args.target,
            rom_filter,
            patch_filter,
            patch_count = args.patches.len(),
            output = ?args.output,
            bundle = ?args.bundle,
            with_patches = args.with_patches.len(),
            without_patches = args.without_patches.len(),
            no_extract = args.no_extract,
            no_ignore = args.no_ignore,
            no_compress = args.no_compress,
            compress_format = ?args.compress_format,
            compress_codec = ?args.compress_codec,
            compress_level = ?args.compress_level,
            assume_in = args.assume_in.len(),
            expect_in = args.expect_in.len(),
            patch_header = ?args.patch_header,
            output_header = ?args.output_header,
            repair_checksum = args.repair_checksum,
            n64_byte_order = ?args.n64_byte_order,
            ignore_checksum_validation = args.ignore_checksum_validation,
            expect_out = args.expect_out.len(),
            code_count = args.codes.len(),
            code_system = ?args.code_system,
            code_kind = %args.code_kind,
            threads = %args.threads,
            "starting patch-apply command"
        );
        // Bundle-driven runs merge the rom-weaver-bundle.json into a plain command first.
        // The context built here owns the temp namespace any bundle-extracted
        // archive members live in, so it must outlive the whole apply - it is
        // dropped (and its files cleaned) only after the run completes.
        let mut args = args;
        let original_input = args.input.clone();
        let local_bundle = args.bundle.as_ref().filter(|path| path.exists()).cloned();
        let bundle_context = self.context(args.threads);
        let bundle_resolution = match self.resolve_bundle_apply(&mut args, &bundle_context) {
            Ok(resolution) => resolution,
            Err(error) => {
                let thread_execution = bundle_context.single_thread_execution();
                return self.finish(
                    "patch-apply",
                    OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        thread_execution,
                    ),
                );
            }
        };
        // Snapshot what --emit-bundle needs before `args` moves into the run:
        // the resolved input rom, the ordered patches, and per-patch header/basis.
        let emit_bundle = args.emit_bundle.clone();
        let emit_inputs = emit_bundle.as_ref().map(|_| EmitBundleInputs {
            input: args.input.clone(),
            patches: args.patches.clone(),
            headers: args.patch_header.clone(),
            bases: args.patch_basis.clone(),
            output: args.output.clone(),
            threads: args.threads,
        });
        let outcome =
            self.run_patch_apply_resolved(args, bundle_resolution, original_input, local_bundle);
        // A successful apply optionally emits a bundle describing it. Failures
        // here don't undo the apply (the output is already written), so warn
        // rather than fail.
        if let (Some(emit_path), Some(inputs)) = (emit_bundle, emit_inputs)
            && outcome.status == OperationStatus::Succeeded
            && let Err(error) = self.emit_apply_bundle(&emit_path, inputs)
        {
            tracing::warn!(
                %error,
                bundle = %emit_path.display(),
                "apply succeeded but --emit-bundle failed",
            );
        }
        outcome
    }

    /// Write a bundle describing a just-completed apply: the input ROM (checks
    /// computed), the ordered patches (referenced by base name, header/basis
    /// preserved), and the produced output's checks/name. Reuses
    /// `bundle_create_inner`, so the emitted bundle is byte-for-byte what
    /// `bundle create` would write for the same inputs.
    fn emit_apply_bundle(&self, emit_path: &Path, inputs: EmitBundleInputs) -> Result<()> {
        if inputs.patches.is_empty() {
            return Err(RomWeaverError::Validation(
                "--emit-bundle needs at least one applied --patch".to_string(),
            ));
        }
        let context = self.context(inputs.threads);
        let patch_specs = inputs
            .patches
            .iter()
            .enumerate()
            .map(|(index, path)| BundleCreatePatchSpec {
                path: path.clone(),
                header: inputs.headers.get(index).copied(),
                basis: inputs.bases.get(index).and_then(|mode| mode.declared()),
                ..BundleCreatePatchSpec::default()
            })
            .collect();
        let output = inputs.output.as_deref().filter(|path| path.is_file());
        let output_check = match output {
            Some(path) => {
                let algorithms = ["crc32", "md5", "sha1"];
                checksum_file_values(path, &algorithms, &context)?
                    .into_iter()
                    .map(|(algorithm, hex)| format!("{algorithm}={hex}"))
                    .collect()
            }
            None => Vec::new(),
        };
        let output_name = output
            .and_then(|path| path.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_owned);
        let create = BundleCreateCommand {
            rom: Some(inputs.input),
            output: emit_path.to_path_buf(),
            output_name,
            output_check,
            threads: inputs.threads,
            patch_specs,
            ..BundleCreateCommand::default()
        };
        self.bundle_create_inner(&create, &context)?;
        trace!(bundle = %emit_path.display(), "emitted bundle from apply");
        Ok(())
    }

    /// The body of `patch apply` after bundle resolution: `args` is a plain,
    /// fully-merged command.
    fn run_patch_apply_resolved(
        &self,
        args: PatchApplyCommand,
        bundle_resolution: Option<BundleApplyResolution>,
        original_input: PathBuf,
        local_bundle: Option<PathBuf>,
    ) -> AppRunOutcome {
        // Everything downstream (staging, finalize, compression naming) needs a
        // concrete output path. A bundle-driven run fills this from
        // output.name before we get here, so only the flag-less, bundle-less
        // case can still be empty.
        let Some(output) = args.output.as_deref() else {
            let thread_execution = self.context(args.threads).single_thread_execution();
            return self.finish(
                "patch-apply",
                OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    bundle_validation(
                        "bundle.output.missing",
                        "patch apply requires --output or a bundle output.name",
                    )
                    .to_string(),
                    thread_execution,
                ),
            );
        };
        let alias_message = if paths_refer_to_same_file(&original_input, output)
            || paths_refer_to_same_file(&args.input, output)
        {
            Some(
                "patch apply input and output resolve to the same file; choose a different --output path"
                    .to_string(),
            )
        } else if let Some(patch) = args
            .patches
            .iter()
            .find(|patch| paths_refer_to_same_file(patch, output))
        {
            Some(format!(
                "patch apply output and patch file `{}` resolve to the same file; choose a different --output path",
                patch.display()
            ))
        } else {
            local_bundle
                .as_deref()
                .filter(|bundle| paths_refer_to_same_file(bundle, output))
                .map(|bundle| {
                    format!(
                        "patch apply output and bundle source `{}` resolve to the same file; choose a different --output path",
                        bundle.display()
                    )
                })
        };
        if let Some(message) = alias_message {
            let thread_execution = self.context(args.threads).single_thread_execution();
            return self.finish(
                "patch-apply",
                OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    message,
                    thread_execution,
                ),
            );
        }
        // A `.dcp` (Universal Dreamcast Patcher) patch rebuilds a GD-ROM data
        // track's filesystem rather than patching bytes, so it follows a
        // dedicated path.
        if args.patches.iter().any(|patch| {
            patch
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("dcp"))
        }) {
            return self.run_dcp_apply(args);
        }
        let rom_filter = args.rom_filter();
        let patch_filter = args.patch_filter();
        let PatchApplyCommand {
            input,
            select,
            target,
            filter: _,
            no_extract,
            no_ignore,
            mut patches,
            output,
            bundle: _,
            with_patches: _,
            without_patches: _,
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
            assume_in,
            expect_in,
            patch_header,
            patch_basis,
            output_header,
            repair_checksum,
            n64_byte_order,
            ignore_checksum_validation,
            expect_out,
            codes,
            code_system,
            code_kind,
            emit_bundle: _,
            tui: _,
            threads,
        } = args;
        let mut output = output.expect("output presence is validated above");
        let discover_implicit_patches = patches.is_empty() && codes.is_empty() && !no_extract;
        let input_kind_filter =
            Self::archive_entry_kind_filter(rom_filter || discover_implicit_patches, false);
        let patch_kind_filter = Self::archive_entry_kind_filter(false, patch_filter);
        let context =
            self.context(threads)
                .with_patch_checksum_validation(if ignore_checksum_validation {
                    PatchChecksumValidation::Ignore
                } else {
                    PatchChecksumValidation::Strict
                });
        let probe_threads = context.single_thread_execution();
        let fail = |stage: &str, message: String| {
            OperationReport::failed(
                OperationFamily::Patch,
                None,
                stage,
                message,
                probe_threads.clone(),
            )
        };
        // Per-patch header modes: entry i governs patch i; a missing entry inherits
        // the last given mode (so a single value applies to the whole chain) and an
        // empty list means all-auto. `Auto` needs checksum evidence to act on:
        // N64 byte-order rewrites and cheat codes pin offsets to the original bytes,
        // and --ignore-checksum-validation removes the evidence itself, so those runs
        // degrade auto to keep.
        let any_explicit_n64_transform = n64_byte_order.iter().any(|mode| mode.target().is_some());
        let auto_evidence_available =
            !any_explicit_n64_transform && codes.is_empty() && !ignore_checksum_validation;
        let patch_header_mode = |index: usize| -> PatchApplyHeaderMode {
            let mode = patch_header
                .get(index)
                .or_else(|| patch_header.last())
                .copied()
                .unwrap_or_default();
            if mode == PatchApplyHeaderMode::Auto && !auto_evidence_available {
                PatchApplyHeaderMode::Keep
            } else {
                mode
            }
        };
        let any_explicit_strip = patch_header.contains(&PatchApplyHeaderMode::Strip);
        let n64_byte_order_mode = |index: usize| -> PatchN64ByteOrderMode {
            n64_byte_order
                .get(index)
                .or_else(|| n64_byte_order.last())
                .copied()
                .unwrap_or_default()
        };
        let output_header_mode = output_header.unwrap_or_default();
        if !codes.is_empty() && (any_explicit_strip || any_explicit_n64_transform) {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "--code cannot be combined with --patch-header strip or --n64-byte-order; cheat offsets are computed against the original ROM bytes".to_string(),
                ),
            );
        }
        let ParsedPatchApplyInputs {
            compression_options,
            cached_input_checksums,
            mut expected_input_checksums,
            mut expected_output_checksums,
        } = match Self::parse_patch_apply_inputs(
            &assume_in,
            &expect_in,
            &expect_out,
            no_compress,
            compress_format,
            compress_codec,
            compress_level.unwrap_or_default(),
        ) {
            Ok(parsed) => parsed,
            Err(error) => {
                return self.finish("patch-apply", fail("validate", error.to_string()));
            }
        };
        if let Some(report) = self.require_existing_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        // A `.cue`/`.gdi` input is a multi-track disc: patch one referenced
        // track (chosen by `--target`) and reassemble the full disc. Plain
        // inputs return `None` here and follow the single-file path unchanged.
        let patch_source_crc32 = if ignore_checksum_validation {
            None
        } else {
            patches
                .first()
                .and_then(|patch| self.patch_source_crc32_for_auto_target(patch, &context))
        };
        let disc_context = match self.build_disc_context(
            &input,
            target.as_deref(),
            patch_source_crc32.as_deref(),
            &context,
        ) {
            Ok(context) => context,
            Err(error) => {
                return self.finish("patch-apply", fail("prepare", error.to_string()));
            }
        };
        if disc_context.is_none() && target.is_some() {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "--target requires a disc-sheet (.cue/.gdi) input".to_string(),
                ),
            );
        }
        if disc_context.is_some()
            && (any_explicit_strip
                || output_header.is_some()
                || repair_checksum
                || any_explicit_n64_transform)
        {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "disc patch apply (.cue/.gdi input) cannot be combined with --patch-header strip, --output-header, --repair-checksum, or --n64-byte-order".to_string(),
                ),
            );
        }
        // A disc reassembles into multiple track files (or a CHD), not a single
        // checksummable artifact; the would-be output path here is the sheet
        // text, so checksumming it never reflects the patched disc. Reject the
        // combination rather than report a misleading validate failure.
        if disc_context.is_some() && !expected_output_checksums.is_empty() {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "disc patch apply (.cue/.gdi input) cannot be combined with --expect-out; the reassembled disc is emitted as multiple track files (or a CHD), not a single checksummable output".to_string(),
                ),
            );
        }
        let is_disc = disc_context.is_some();
        trace!(
            is_disc,
            patches = patches.len(),
            no_compress,
            "patch apply route resolved"
        );
        let discovered_sidecars = if discover_implicit_patches && !is_disc {
            match self.discover_patch_apply_sidecars(&input, &select, no_ignore, &context) {
                Ok(discovered) => discovered,
                Err(error) => {
                    return self.finish("patch-apply", fail("prepare", error.to_string()));
                }
            }
        } else {
            DiscoveredPatchApplySidecars::default()
        };
        if patches.is_empty() {
            patches = discovered_sidecars.patches.clone();
        }
        if patches.is_empty() && codes.is_empty() {
            return self.finish(
                "patch-apply",
                fail(
                    "validate",
                    "patch apply requires at least one --patch file, --code, or RetroArch-style sidecar patch inside the input archive".to_string(),
                ),
            );
        }
        for patch_path in &patches {
            if let Some(report) = self.require_existing_path(
                "patch-apply",
                OperationFamily::Patch,
                None,
                patch_path,
                probe_threads.clone(),
            ) {
                return self.finish("patch-apply", report);
            }
        }

        let mut expected_input_size: Option<u64> = None;
        // Bundle checks merge after the CLI flags (already parsed into
        // `expected_input_checksums`) and before the file-name requirements,
        // so precedence is CLI > bundle > file name and any conflict names
        // the bundle source that introduced it.
        if !ignore_checksum_validation && let Some(resolution) = &bundle_resolution {
            for (source_label, requirements) in &resolution.checks {
                if let Some(report) = self.merge_expected_input_requirements(
                    "patch-apply",
                    source_label,
                    requirements,
                    &mut expected_input_checksums,
                    &mut expected_input_size,
                    probe_threads.clone(),
                ) {
                    return self.finish("patch-apply", report);
                }
            }
            // Bundle output checks merge after the CLI output flags with
            // the same conflict rule as input requirements. Disc inputs
            // reassemble into multiple files, so there is no single output to
            // checksum - skip rather than fail an otherwise valid bundle.
            match (&resolution.output_checks, disc_context.is_some()) {
                (Some((source_label, _)), true) => {
                    trace!(
                        source = %source_label,
                        "bundle output checks skipped: disc apply emits no single checksummable output"
                    );
                }
                (Some((source_label, requirements)), false) => {
                    for (algorithm, hex) in &requirements.checksums {
                        match expected_output_checksums.get(algorithm) {
                            Some(existing) if existing != hex => {
                                return self.finish(
                                    "patch-apply",
                                    fail(
                                        "validate",
                                        format!(
                                            "{source_label} requires output {algorithm} {hex} but {existing} was already requested"
                                        ),
                                    ),
                                );
                            }
                            Some(_) => {}
                            None => {
                                trace!(
                                    source = %source_label,
                                    algorithm = %algorithm,
                                    checksum = %hex,
                                    "merged expected output checksum requirement"
                                );
                                expected_output_checksums.insert(algorithm.clone(), hex.clone());
                            }
                        }
                    }
                }
                (None, _) => {}
            }
        }
        if !ignore_checksum_validation
            && let Some(first_patch) = patches.first()
            && let Some(patch_name) = first_patch.file_name().and_then(|name| name.to_str())
            && let Some(report) = self.merge_filename_requirements(
                "patch-apply",
                first_patch,
                patch_name,
                &mut expected_input_checksums,
                &mut expected_input_size,
                probe_threads.clone(),
            )
        {
            return self.finish("patch-apply", report);
        }

        // For a disc input the patch applies to the chosen track directly (no
        // container auto-extract); the full disc is reassembled after the apply
        // loop. Plain inputs resolve through the normal auto-extract path.
        let (resolved_input, extracted_archives, input_cleanup_paths) =
            if let Some(disc) = disc_context.as_ref() {
                (disc.target_file.clone(), 0usize, Vec::new())
            } else {
                let resolved = match self.resolve_source_with_auto_extract(
                    &input,
                    &select,
                    &context,
                    AutoExtractResolutionLabels {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                        source_label: "patch apply input",
                        temp_prefix: "patch-apply-input-extract",
                    },
                    AutoExtractResolutionFlags {
                        no_extract,
                        no_ignore,
                        kind_filter: input_kind_filter,
                        stop_on_disc_image_codec: false,
                    },
                ) {
                    Ok(resolved) => resolved,
                    Err(error) => {
                        return self.finish("patch-apply", fail("prepare", error.to_string()));
                    }
                };
                let ResolvedChecksumSource {
                    source,
                    extracted_archives,
                    cleanup_paths,
                } = resolved;
                (source, extracted_archives, cleanup_paths)
            };
        // Reuse the host-provided input checksums (the CRC32 the webapp already computed during
        // staging) for the handler's source-checksum verification instead of re-reading the input.
        // Keyed by the original resolved path; any header/N64 transform writes a distinct temp path
        // whose lookup misses and falls back to a fresh compute. Skipped for disc apply, where the
        // resolved input is a single track but the cached checksums describe the whole disc.
        if disc_context.is_none() {
            context.seed_checksums(&resolved_input, &cached_input_checksums);
        }
        let mut temp_paths = input_cleanup_paths;
        temp_paths.extend(discovered_sidecars.cleanup_paths);
        let (mut resolved_patches, extracted_patch_notes) = match self.resolve_patches(
            &patches,
            &select,
            &context,
            AutoExtractResolutionFlags {
                no_extract,
                no_ignore,
                kind_filter: patch_kind_filter,
                stop_on_disc_image_codec: false,
            },
            PatchResolveLabels {
                command: "patch-apply",
                noun: "patch apply",
                temp_prefix: "patch-apply-patch-extract",
            },
            &mut temp_paths,
        ) {
            Ok(resolved) => resolved,
            Err(error) => {
                return self.finish("patch-apply", fail("prepare", error.to_string()));
            }
        };

        // Bake cheat codes into a synthetic IPS patch applied before the explicit
        // patches. Resolved against the resolved input ROM bytes (header strip /
        // N64 byte-order rewrite are rejected above so offsets stay valid).
        let mut cheat_summary = None;
        if !codes.is_empty() {
            match self.synthesize_cheat_ips(
                &resolved_input,
                &codes,
                code_system.as_deref(),
                &code_kind,
                &context,
                &mut temp_paths,
            ) {
                Ok((cheat_patch, summary)) => {
                    cheat_summary = Some(summary);
                    resolved_patches.insert(0, (cheat_patch.clone(), cheat_patch));
                }
                Err(error) => {
                    Self::cleanup_temp_paths(&temp_paths);
                    return self.finish("patch-apply", fail("prepare", error.to_string()));
                }
            }
        }

        let report = (|| {
            if resolved_patches.is_empty() {
                return OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    "at least one --patch value or --code is required",
                    probe_threads.clone(),
                );
            }

            // One resolved mode per resolved patch. Disc apply and cheat-code runs
            // never transform headers (explicit strip is rejected above; auto has
            // no evidence), so they pin every step to keep.
            let chain_header_modes: Vec<PatchApplyHeaderMode> = if is_disc || !codes.is_empty() {
                vec![PatchApplyHeaderMode::Keep; resolved_patches.len()]
            } else {
                (0..resolved_patches.len()).map(patch_header_mode).collect()
            };
            let chain_n64_modes = (0..resolved_patches.len())
                .map(n64_byte_order_mode)
                .collect::<Vec<_>>();
            // Patch 0 sets the initial header state (the strip happens on the
            // resolved input, before checksum validation). Later patches transition
            // the state inside the apply loop on their own evidence.
            let strip_header = match chain_header_modes.first().copied().unwrap_or_default() {
                PatchApplyHeaderMode::Strip => true,
                PatchApplyHeaderMode::Keep => false,
                PatchApplyHeaderMode::Auto => self.auto_header_strip_decision(
                    &resolved_input,
                    resolved_patches
                        .first()
                        .map(|(_, resolved)| resolved.as_path()),
                    &expected_input_checksums,
                    &cached_input_checksums,
                    &context,
                ),
            };

            let mut checksum_verification_labels = Vec::new();
            let PreparedApplyInput {
                apply_input,
                stripped_header,
                stripped_header_match,
                mut n64_order,
            } = match self.prepare_patch_apply_input(
                &resolved_input,
                strip_header,
                chain_n64_modes.first().copied().unwrap_or_default(),
                resolved_patches
                    .first()
                    .map(|(_, resolved)| resolved.as_path()),
                expected_input_checksums.get("crc32").map(String::as_str),
                repair_checksum,
                &context,
                &mut temp_paths,
            ) {
                Ok(prepared) => prepared,
                Err(error) => {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "compat",
                        error.to_string(),
                        context.single_thread_execution(),
                    );
                }
            };
            let transformed_checksum_hints = BTreeMap::new();
            let effective_checksum_hints = if apply_input == resolved_input {
                &cached_input_checksums
            } else {
                &transformed_checksum_hints
            };
            if let Some(expected_size) = expected_input_size {
                match Self::validate_patch_input_size(&apply_input, Some(expected_size), None) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            }
            if !expected_input_checksums.is_empty() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: None,
                    },
                    "validate",
                    format!(
                        "validating {} requested input checksum(s)",
                        expected_input_checksums.len()
                    ),
                    None,
                    context.single_thread_execution(),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &apply_input,
                    &expected_input_checksums,
                    effective_checksum_hints,
                    "input",
                    &context,
                ) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            None,
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            }

            let mut header_state = ChainHeaderState {
                headerless: stripped_header_match.is_some(),
                stripped_header,
                stripped_header_match,
            };
            // The output-header decision: on a headerless final state, `--output-header`
            // decides whether the stripped header returns (auto re-adds emulator-required
            // headers like iNES/fwNES/LNX/A78 and drops junk copier headers like SNES/PCE/
            // Game Doctor - except NSRT-signed copier headers, which carry real dump
            // metadata and come back, matching the RUP handler's own normalization).
            // Explicit `--output-header strip` on a headered state removes
            // the still-present header during finalize. Evaluated here for the patch-0
            // state; chains re-evaluate after the loop from the final chain state (they
            // always stage, so the staging decision below is unaffected).
            let resolve_output_header = |state: &ChainHeaderState| -> (bool, bool) {
                let add_header = state.headerless
                    && state
                        .stripped_header_match
                        .as_ref()
                        .is_some_and(|header_match| {
                            let nsrt_metadata = state
                                .stripped_header
                                .as_deref()
                                .is_some_and(header_has_nsrt_metadata);
                            let add = match output_header_mode {
                                PatchApplyOutputHeaderMode::Keep => true,
                                PatchApplyOutputHeaderMode::Strip => false,
                                PatchApplyOutputHeaderMode::Auto => {
                                    header_match.header.retained_on_output() || nsrt_metadata
                                }
                            };
                            debug!(
                                header = ?header_match.header,
                                output_header = ?output_header_mode,
                                nsrt_metadata,
                                add_header = add,
                                "output header resolved for stripped input"
                            );
                            add
                        });
                let strip_output_header = output_header == Some(PatchApplyOutputHeaderMode::Strip)
                    && !state.headerless
                    && !is_disc;
                (add_header, strip_output_header)
            };
            let (mut add_header, mut strip_output_header) = resolve_output_header(&header_state);

            let patch_count = resolved_patches.len();
            // Single-patch runs know the final header state before anything is
            // written, so the extension swap lands here and every writer (direct
            // handler output, finalize, compression entry naming) targets the
            // adjusted path - no post-hoc rename, which the browser VFS cannot
            // observe. Chains re-evaluate after the loop; they always stage, so
            // the finalize/compression writers pick the adjusted path up there.
            let mut extension_swap_note: Option<String> = None;
            if patch_count == 1
                && !is_disc
                && let Some((swapped_output, note)) = Self::resolve_header_extension_swap(
                    &output,
                    &header_state,
                    add_header,
                    strip_output_header,
                    &resolved_input,
                )
            {
                output = swapped_output;
                extension_swap_note = Some(note);
            }
            // Disc inputs reject the header/N64 transforms and do their own
            // reassembly, so they skip the standard compat finalize; they always
            // stage the patched track before reassembling the full disc.
            let requires_compat_finalize = !is_disc
                && (add_header
                    || strip_output_header
                    || repair_checksum
                    || n64_order.is_some_and(|order| order.from != order.to)
                    || patch_count > 1);
            let needs_staged_output =
                is_disc || requires_compat_finalize || compression_options.enabled;
            let staged_output = if needs_staged_output {
                if compression_options.enabled {
                    match Self::patch_apply_raw_output_path(
                        &output,
                        &resolved_input,
                        &context,
                        "patch-apply-output-staged",
                        &mut temp_paths,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                None,
                                "prepare",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    }
                } else {
                    let staged_path = context
                        .temp_paths()
                        .next_path("patch-apply-output-staged", Some("bin"));
                    temp_paths.push(staged_path.clone());
                    staged_path
                }
            } else {
                output.clone()
            };

            // Resolve every step's input basis (CLI flag > bundle declaration >
            // inference against the prepared input) and verify declared
            // base-basis steps against the base once, before the chain runs.
            let step_verifications = match self.resolve_apply_step_verifications(
                &resolved_patches,
                usize::from(!codes.is_empty()),
                bundle_resolution
                    .as_ref()
                    .map(|resolution| resolution.step_verifications.clone())
                    .unwrap_or_default(),
                &patch_basis,
                &apply_input,
                &context,
            ) {
                Ok(steps) => steps,
                Err(error) => {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        context.single_thread_execution(),
                    );
                }
            };

            let PatchApplyLoopOutcome {
                mut report,
                applied_formats,
            } = match self.run_patch_apply_loop(
                &resolved_patches,
                apply_input,
                &staged_output,
                &chain_header_modes,
                &step_verifications,
                &mut header_state,
                &chain_n64_modes,
                &mut n64_order,
                &probe_threads,
                &context,
                &mut temp_paths,
            ) {
                Ok(outcome) => outcome,
                Err(report) => return *report,
            };

            // Mid-chain transitions may have changed the header state; chains always
            // stage (patch_count > 1 forces the compat finalize), so re-resolving the
            // output-header decision and the extension swap here still lands before
            // the finalize copy chooses its destination.
            if patch_count > 1 {
                (add_header, strip_output_header) = resolve_output_header(&header_state);
                if report.status == OperationStatus::Succeeded
                    && !is_disc
                    && let Some((swapped_output, note)) = Self::resolve_header_extension_swap(
                        &output,
                        &header_state,
                        add_header,
                        strip_output_header,
                        &staged_output,
                    )
                {
                    output = swapped_output;
                    extension_swap_note = Some(note);
                }
            }
            let mut terminal_output_path = output.clone();

            let mut raw_ready_output = staged_output.clone();
            let mut disc_track_overrides: Vec<CreateInputOverride> = Vec::new();
            if report.status == OperationStatus::Succeeded && requires_compat_finalize {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: applied_formats.last().copied(),
                    },
                    "compat",
                    if add_header || repair_checksum {
                        "finalizing compatibility output transforms"
                    } else {
                        "finalizing multi-patch output"
                    },
                    None,
                    context.single_thread_execution(),
                );
                let finalized_output_path = if compression_options.enabled {
                    match Self::patch_apply_raw_output_path(
                        &output,
                        &resolved_input,
                        &context,
                        "patch-apply-output-raw-final",
                        &mut temp_paths,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                report.format.clone(),
                                "prepare",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    }
                } else {
                    output.clone()
                };
                match Self::finalize_patch_apply_output(
                    &staged_output,
                    &finalized_output_path,
                    add_header,
                    header_state.stripped_header.as_deref(),
                    strip_output_header,
                    repair_checksum,
                    Some(&resolved_input),
                    n64_order.filter(|order| order.from != order.to),
                ) {
                    Ok(finalized) => {
                        raw_ready_output = finalized_output_path;
                        if finalized.repaired_profiles.len() == 1 {
                            report.label = format!(
                                "{}; repaired checksum ({})",
                                report.label, finalized.repaired_profiles[0]
                            );
                        } else if !finalized.repaired_profiles.is_empty() {
                            report.label = format!(
                                "{}; repaired headers ({})",
                                report.label,
                                finalized.repaired_profiles.join(", ")
                            );
                        }
                        if let Some(repair_warning) = finalized.repair_warning {
                            report.label = format!("{}; warning={repair_warning}", report.label);
                        }
                    }
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compat",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            }

            // Reassemble the full disc from the patched track. When compressing,
            // every untouched track is read in place from the original disc and
            // only the patched track is redirected via a create override (no
            // whole-disc scratch copy); the original sheet feeds the compressor
            // below. With --no-compress the disc is staged and written beside
            // `output` directly.
            if is_disc && report.status == OperationStatus::Succeeded {
                let disc = disc_context
                    .as_ref()
                    .expect("disc context present for disc input");
                for warning in &disc.warnings {
                    report.label = format!("{}; {}", report.label, warning);
                }
                if compression_options.enabled {
                    match self.disc_target_track_override(disc, &staged_output, &mut temp_paths) {
                        Ok(track_override) => disc_track_overrides.push(track_override),
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                report.format.clone(),
                                "prepare",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    }
                    raw_ready_output = self.primary_disc_sheet(disc).to_path_buf();
                } else {
                    let staged_sheet = match self.stage_disc_directory(
                        disc,
                        &staged_output,
                        &context,
                        &mut temp_paths,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                report.format.clone(),
                                "prepare",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    };
                    match self.write_disc_output(disc, &staged_sheet, &output) {
                        Ok(note) => report.label = format!("{}; {}", report.label, note),
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                report.format.clone(),
                                "compat",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    }
                    raw_ready_output = staged_sheet;
                }
            }

            if patch_count > 1 {
                report.label = format!(
                    "applied {patch_count} patches sequentially ({}); {}",
                    applied_formats.join(" -> "),
                    report.label
                );
            }
            if let Some(header_match) = header_state.stripped_header_match.as_ref() {
                report.label = format!(
                    "{}; input header stripped ({} bytes, {})",
                    report.label,
                    header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES),
                    header_match.profile_name()
                );
            }
            if let Some(note) = extension_swap_note.as_deref() {
                report.label = format!("{}; {note}", report.label);
            }
            if n64_order.is_some() {
                let modes = chain_n64_modes
                    .iter()
                    .map(|mode| mode.id())
                    .collect::<Vec<_>>()
                    .join(",");
                report.label = format!("{}; n64_byte_order={modes}", report.label);
            }
            if extracted_archives > 0 {
                report.label = format!(
                    "{}; patch apply input source resolved via {extracted_archives} container extract step(s)",
                    report.label
                );
            }
            if !extracted_patch_notes.is_empty() {
                report.label = format!("{}; {}", report.label, extracted_patch_notes.join("; "));
            }
            if report.status == OperationStatus::Succeeded && !expected_output_checksums.is_empty()
            {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: report.format.as_deref(),
                    },
                    "validate",
                    format!(
                        "validating {} requested output checksum(s)",
                        expected_output_checksums.len()
                    ),
                    None,
                    context.single_thread_execution(),
                );
                match Self::validate_patch_apply_expected_checksums(
                    &raw_ready_output,
                    &expected_output_checksums,
                    &BTreeMap::new(),
                    "output",
                    &context,
                ) {
                    Ok(label) => checksum_verification_labels.push(label),
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "validate",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                }
            }

            if !checksum_verification_labels.is_empty() {
                report.label = format!(
                    "{}; {}",
                    report.label,
                    checksum_verification_labels.join("; ")
                );
            }

            if report.status == OperationStatus::Succeeded && compression_options.enabled {
                let compression_plan = match self.resolve_patch_apply_compression_plan(
                    &output,
                    &resolved_input,
                    &compression_options,
                ) {
                    Ok(plan) => plan,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compress",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                };
                // For a disc, feed the original sheet to the compressor: untouched
                // tracks are read in place from the source disc and the patched
                // track is redirected via `disc_track_overrides`. Plain inputs
                // stage the single patched payload under an archive-appropriate
                // entry name.
                let archive_input = if is_disc {
                    raw_ready_output.clone()
                } else {
                    match Self::stage_patch_apply_archive_input(
                        &raw_ready_output,
                        &output,
                        &resolved_input,
                    ) {
                        Ok(path) => path,
                        Err(error) => {
                            return OperationReport::failed(
                                OperationFamily::Patch,
                                report.format.clone(),
                                "compress",
                                error.to_string(),
                                context.single_thread_execution(),
                            );
                        }
                    }
                };
                let running_label = format!(
                    "compressing patched output as {} (codec={})",
                    compression_plan.format,
                    compression_plan.codec.as_deref().unwrap_or("default")
                );
                let (compress_report, codec_label) = match self.run_patch_apply_compression(
                    &compression_plan,
                    vec![archive_input],
                    &disc_track_overrides,
                    running_label,
                    &context,
                ) {
                    Ok(result) => result,
                    Err(error) => {
                        return OperationReport::failed(
                            OperationFamily::Patch,
                            report.format.clone(),
                            "compress",
                            error.to_string(),
                            context.single_thread_execution(),
                        );
                    }
                };
                if compress_report.status != OperationStatus::Succeeded {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        format!("patch output compression failed: {}", compress_report.label),
                        compress_report.thread_execution,
                    );
                }
                let extension_note = if compression_plan.extension_appended {
                    "; output extension appended to match container format"
                } else {
                    ""
                };
                let warning_note = compression_plan
                    .warning
                    .as_deref()
                    .map(|warning| format!("; warning: {warning}"))
                    .unwrap_or_default();
                report.stage = "compress".to_string();
                report.label = format!(
                    "{}; patch output compressed as {} (codec={}, path=`{}`; {}){}{}",
                    report.label,
                    compression_plan.format,
                    codec_label,
                    compression_plan.output_path.display(),
                    compression_plan.note,
                    extension_note,
                    warning_note
                );
                terminal_output_path = compression_plan.output_path;
            }

            if report.status == OperationStatus::Succeeded {
                let kind_hint = if compression_options.enabled {
                    Some("archive")
                } else {
                    None
                };
                report = Self::attach_emitted_files_details(
                    report,
                    vec![terminal_output_path],
                    kind_hint,
                );
            }

            report
        })();

        let mut report = report;
        if report.status == OperationStatus::Succeeded
            && let Some(summary) = cheat_summary
        {
            report.label = format!("{}; {}", report.label, summary.label());
        }

        Self::cleanup_temp_paths(&temp_paths);
        self.finish("patch-apply", report)
    }

    /// Resolve each requested patch path through auto-extract, returning the
    /// `(original, resolved)` pairs plus any "resolved via N container extract
    /// step(s)" notes. Shared by patch-apply and patch-validate, which differ
    /// only in the command name, the label noun, and the temp-file prefix.
    /// Cleanup paths from each extract are pushed onto `temp_paths` as they are
    /// produced, matching the previous inline loops.
    /// Decide the default (`--patch-header auto`) handling for the FIRST patch: strip
    /// the detected copier header before apply only when the patch's required input
    /// checksum proves it was authored against the headerless bytes. Any doubt - no
    /// strippable header, no checksum evidence, or a checksum matching neither
    /// variant - keeps the input as-is, so runs without evidence behave exactly like
    /// the pre-policy default. Later chain steps decide per patch in
    /// [`Self::chain_header_transition`].
    fn auto_header_strip_decision(
        &self,
        resolved_input: &Path,
        first_resolved_patch: Option<&Path>,
        expected_input_checksums: &BTreeMap<String, String>,
        cached_input_checksums: &BTreeMap<String, String>,
        context: &OperationContext,
    ) -> bool {
        let Ok(header_match) = Self::detect_strippable_rom_header(resolved_input) else {
            trace!(
                input = %resolved_input.display(),
                "auto header: no strippable ROM header detected; keeping input as-is"
            );
            return false;
        };
        let header_len = header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES);
        let required_crc32 = expected_input_checksums.get("crc32").cloned().or_else(|| {
            first_resolved_patch.and_then(|patch| self.embedded_patch_source_crc32(patch, context))
        });
        let Some(required_crc32) = required_crc32 else {
            trace!(
                input = %resolved_input.display(),
                header = ?header_match.header,
                "auto header: strippable header present but no required input checksum; keeping header (ambiguous)"
            );
            return false;
        };
        if cached_input_checksums
            .get("crc32")
            .is_some_and(|cached| cached.eq_ignore_ascii_case(&required_crc32))
        {
            trace!(
                required_crc32 = %required_crc32,
                "auto header: required checksum matches the raw (headered) input; keeping header"
            );
            return false;
        }
        let headerless_crc32 = (|| -> Result<Option<String>> {
            let mut reader = BufReader::new(File::open(resolved_input)?);
            reader.seek(SeekFrom::Start(header_len as u64))?;
            Self::crc32_of_reader(&mut reader, context)
        })();
        match headerless_crc32 {
            Ok(Some(headerless)) if headerless.eq_ignore_ascii_case(&required_crc32) => {
                debug!(
                    header = ?header_match.header,
                    header_bytes = header_len,
                    required_crc32 = %required_crc32,
                    "auto header: required input checksum matches the headerless bytes; stripping header before apply and re-adding it after"
                );
                true
            }
            Ok(_) => {
                trace!(
                    required_crc32 = %required_crc32,
                    "auto header: required checksum matches neither the raw nor the headerless bytes; keeping header"
                );
                false
            }
            Err(error) => {
                trace!(
                    %error,
                    "auto header: could not hash the headerless bytes; keeping header"
                );
                false
            }
        }
    }

    /// Resolve the N64 order a patch should see. Auto acts only on checksum
    /// proof; without a source CRC32 (or when no variant matches), it keeps the
    /// current bytes so checksumless patches are never silently guessed.
    pub(super) fn resolve_patch_n64_target(
        &self,
        input: &Path,
        patch: Option<&Path>,
        expected_crc32: Option<&str>,
        mode: PatchN64ByteOrderMode,
        context: &OperationContext,
    ) -> Result<Option<(N64ByteOrder, N64ByteOrder)>> {
        let source = Self::detect_n64_byte_order_path(input)?;
        let Some(source) = source else {
            if mode.target().is_some() {
                return Err(RomWeaverError::Validation(format!(
                    "could not detect N64 byte order for `{}`",
                    input.display()
                )));
            }
            return Ok(None);
        };
        let target = match mode {
            PatchN64ByteOrderMode::Keep => source,
            PatchN64ByteOrderMode::Auto => {
                let required_crc32 = expected_crc32.map(str::to_owned).or_else(|| {
                    patch.and_then(|path| self.embedded_patch_source_crc32(path, context))
                });
                match required_crc32 {
                    Some(required) => {
                        Self::resolve_n64_byte_order_for_crc32(input, &required, context)?
                            .unwrap_or(source)
                    }
                    None => source,
                }
            }
            concrete => concrete.target().unwrap_or(source),
        };
        Ok(Some((source, target)))
    }

    pub(super) fn transition_n64_byte_order(
        &self,
        mode: PatchN64ByteOrderMode,
        resolved_patch: &Path,
        current_input: &mut PathBuf,
        state: &mut Option<N64ByteOrderTransform>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<()> {
        let Some((source, target)) = self.resolve_patch_n64_target(
            current_input,
            Some(resolved_patch),
            None,
            mode,
            context,
        )?
        else {
            return Ok(());
        };
        let original = state.map(|order| order.to).unwrap_or(source);
        if source != target {
            let transformed_path = context
                .temp_paths()
                .next_path("patch-apply-chain-n64-byte-order", Some("bin"));
            Self::rewrite_n64_byte_order(current_input, &transformed_path, source, target)?;
            temp_paths.push(transformed_path.clone());
            *current_input = transformed_path;
            debug!(
                from = source.id(),
                to = target.id(),
                "chain N64 byte order transformed for patch"
            );
        }
        *state = Some(N64ByteOrderTransform {
            from: target,
            to: original,
        });
        Ok(())
    }

    /// Adjust the requested output path when the final header state changes the
    /// ROM's conventional extension (SNES `.smc` vs headerless `.sfc`, LNX `.lnx`
    /// vs `.lyx`, ...). Fires only when the requested extension IS the known
    /// counterpart - unrelated extensions are never touched - and only when a
    /// header was actually in play (a strip somewhere in the chain, or an explicit
    /// output strip, whose header is detected from `detect_source`). Returns the
    /// swapped path plus the report-label note; mirrors the compression step's
    /// extension-adjustment precedent.
    fn resolve_header_extension_swap(
        output: &Path,
        state: &ChainHeaderState,
        add_header: bool,
        strip_output_header: bool,
        detect_source: &Path,
    ) -> Option<(PathBuf, String)> {
        let known_header = if state.headerless || state.stripped_header_match.is_some() {
            state
                .stripped_header_match
                .as_ref()
                .map(|header_match| header_match.header)
        } else if strip_output_header {
            Self::detect_strippable_rom_header(detect_source)
                .ok()
                .map(|header_match| header_match.header)
        } else {
            // The header was never touched: leave the requested name alone.
            None
        }?;
        let final_headerless = (state.headerless && !add_header) || strip_output_header;
        let (from_extension, to_extension) = if final_headerless {
            (
                known_header.headered_extension(),
                known_header.headerless_extension(),
            )
        } else {
            (
                known_header.headerless_extension(),
                known_header.headered_extension(),
            )
        };
        if from_extension == to_extension {
            return None;
        }
        let output_matches_from = output
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                from_extension
                    .strip_prefix('.')
                    .is_some_and(|from| extension.eq_ignore_ascii_case(from))
            });
        if !output_matches_from {
            return None;
        }
        let swapped_output = output.with_extension(to_extension.trim_start_matches('.'));
        debug!(
            header = ?known_header,
            final_headerless,
            from = from_extension,
            to = to_extension,
            output = %swapped_output.display(),
            "adjusting output extension to match final header state"
        );
        Some((
            swapped_output,
            format!(
                "output extension adjusted ({from_extension} -> {to_extension}) to match {} output",
                if final_headerless {
                    "headerless"
                } else {
                    "headered"
                }
            ),
        ))
    }

    /// Hash a reader's remaining bytes as the engine-formatted lowercase CRC32.
    pub(super) fn crc32_of_reader(
        reader: &mut impl Read,
        context: &OperationContext,
    ) -> Result<Option<String>> {
        let values = checksum_reader_values_with_progress(
            reader,
            &["crc32".to_string()],
            context,
            &mut |_| {},
        )?;
        Ok(values.values.get("crc32").cloned())
    }

    /// Transition the on-disk header state between chain steps so patch `mode`'s
    /// step applies against the bytes it was authored for. Explicit keep/strip
    /// force the state (a keep with nothing ever stripped is a no-op); auto acts
    /// only on checksum proof from this patch's embedded source CRC32 - no
    /// evidence, or evidence matching the current bytes, carries the state over
    /// untouched, and evidence matching neither variant is left for the handler's
    /// own strict validation to report.
    fn chain_header_transition(
        &self,
        mode: PatchApplyHeaderMode,
        resolved_patch: &Path,
        current_input: &mut PathBuf,
        state: &mut ChainHeaderState,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<()> {
        let desired_headerless = match mode {
            PatchApplyHeaderMode::Keep => false,
            PatchApplyHeaderMode::Strip => true,
            PatchApplyHeaderMode::Auto => {
                let Some(required_crc32) =
                    self.embedded_patch_source_crc32(resolved_patch, context)
                else {
                    trace!(
                        patch = %resolved_patch.display(),
                        headerless = state.headerless,
                        "chain header: patch embeds no source checksum; header state carries over"
                    );
                    return Ok(());
                };
                let current_crc32 = {
                    let mut reader = BufReader::new(File::open(&*current_input)?);
                    Self::crc32_of_reader(&mut reader, context)?
                };
                if current_crc32
                    .as_deref()
                    .is_some_and(|crc| crc.eq_ignore_ascii_case(&required_crc32))
                {
                    trace!(
                        required_crc32 = %required_crc32,
                        headerless = state.headerless,
                        "chain header: patch targets the current bytes; header state carries over"
                    );
                    return Ok(());
                }
                if !state.headerless {
                    let Ok(header_match) = Self::detect_strippable_rom_header(current_input) else {
                        trace!(
                            required_crc32 = %required_crc32,
                            "chain header: checksum mismatch but no strippable header on the current bytes; leaving state for strict validation"
                        );
                        return Ok(());
                    };
                    let header_len = header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES);
                    let headerless_crc32 = {
                        let mut reader = BufReader::new(File::open(&*current_input)?);
                        reader.seek(SeekFrom::Start(header_len as u64))?;
                        Self::crc32_of_reader(&mut reader, context)?
                    };
                    if !headerless_crc32
                        .as_deref()
                        .is_some_and(|crc| crc.eq_ignore_ascii_case(&required_crc32))
                    {
                        trace!(
                            required_crc32 = %required_crc32,
                            "chain header: checksum matches neither the current nor the headerless bytes; leaving state for strict validation"
                        );
                        return Ok(());
                    }
                    debug!(
                        header = ?header_match.header,
                        required_crc32 = %required_crc32,
                        "chain header: patch targets the headerless bytes; stripping between steps"
                    );
                    true
                } else if let Some(header_bytes) = state.stripped_header.as_deref() {
                    let headered_crc32 = {
                        let file = BufReader::new(File::open(&*current_input)?);
                        let mut reader = header_bytes.chain(file);
                        Self::crc32_of_reader(&mut reader, context)?
                    };
                    if !headered_crc32
                        .as_deref()
                        .is_some_and(|crc| crc.eq_ignore_ascii_case(&required_crc32))
                    {
                        trace!(
                            required_crc32 = %required_crc32,
                            "chain header: checksum matches neither the headerless nor the re-headered bytes; leaving state for strict validation"
                        );
                        return Ok(());
                    }
                    debug!(
                        required_crc32 = %required_crc32,
                        "chain header: patch targets the re-headered bytes; restoring the stripped header between steps"
                    );
                    false
                } else {
                    return Ok(());
                }
            }
        };
        if desired_headerless == state.headerless {
            return Ok(());
        }
        if desired_headerless {
            let stripped_path = context
                .temp_paths()
                .next_path("patch-apply-chain-noheader", Some("bin"));
            let result = Self::strip_header_to_temp(current_input, &stripped_path)?;
            temp_paths.push(stripped_path.clone());
            debug!(
                header = ?result.matched_header,
                "chain header: stripped header before this patch"
            );
            state.stripped_header = Some(result.header_bytes);
            if state.stripped_header_match.is_none() {
                state.stripped_header_match = result.matched_header;
            }
            state.headerless = true;
            *current_input = stripped_path;
        } else {
            let Some(header_bytes) = state.stripped_header.clone() else {
                // Keep on a chain that never stripped: nothing to restore.
                return Ok(());
            };
            let restored_path = context
                .temp_paths()
                .next_path("patch-apply-chain-rehead", Some("bin"));
            Self::copy_with_optional_header(current_input, &restored_path, Some(&header_bytes))?;
            temp_paths.push(restored_path.clone());
            debug!("chain header: restored the stripped header before this patch");
            state.headerless = false;
            *current_input = restored_path;
        }
        Ok(())
    }

    /// Read the first patch's embedded expected-source CRC32 (UPS/BPS store it in
    /// their header/footer) without applying the patch, formatted as the same
    /// lowercase 8-digit hex the checksum engine emits.
    pub(super) fn embedded_patch_source_crc32(
        &self,
        patch_path: &Path,
        context: &OperationContext,
    ) -> Option<String> {
        let handler = self.patches.probe(patch_path)?;
        let report = handler.describe_metadata(patch_path, context).ok()?;
        let source_crc32 = report
            .details
            .as_ref()?
            .as_object()?
            .get("patch")?
            .as_object()?
            .get("source_crc32")?
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())?;
        Some(format!("{source_crc32:08x}"))
    }

    pub(super) fn resolve_patches(
        &self,
        patches: &[PathBuf],
        select: &[String],
        context: &OperationContext,
        flags: AutoExtractResolutionFlags,
        labels: PatchResolveLabels<'_>,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<ResolvedPatchList> {
        let PatchResolveLabels {
            command,
            noun,
            temp_prefix,
        } = labels;
        let mut resolved_patches = Vec::with_capacity(patches.len());
        let mut extracted_patch_notes = Vec::new();
        for (index, patch_path) in patches.iter().enumerate() {
            let patch_source_label = if patches.len() == 1 {
                format!("{noun} patch source")
            } else {
                format!("{noun} patch {}/{} source", index + 1, patches.len())
            };
            let ResolvedChecksumSource {
                source: resolved_patch_source,
                extracted_archives: resolved_patch_extracted_archives,
                cleanup_paths: resolved_patch_cleanup_paths,
            } = self.resolve_source_with_auto_extract(
                patch_path,
                select,
                context,
                AutoExtractResolutionLabels {
                    command,
                    family: OperationFamily::Patch,
                    format: None,
                    source_label: patch_source_label.as_str(),
                    temp_prefix,
                },
                flags,
            )?;
            if resolved_patch_extracted_archives > 0 {
                let note = if patches.len() == 1 {
                    format!(
                        "{noun} patch source resolved via {} container extract step(s)",
                        resolved_patch_extracted_archives
                    )
                } else {
                    format!(
                        "patch {}/{} source resolved via {} container extract step(s)",
                        index + 1,
                        patches.len(),
                        resolved_patch_extracted_archives
                    )
                };
                extracted_patch_notes.push(note);
            }
            temp_paths.extend(resolved_patch_cleanup_paths);
            resolved_patches.push((patch_path.clone(), resolved_patch_source));
        }
        Ok((resolved_patches, extracted_patch_notes))
    }

    /// Probe a resolved patch path for a handler, or build the standard
    /// "patch i/n: ... is explicitly not supported / no registered patch handler
    /// matched ..." failure report shared by patch-apply and patch-validate.
    pub(super) fn probe_patch_handler(
        &self,
        patch_path: &Path,
        resolved_patch_path: &Path,
        index: usize,
        patch_count: usize,
        probe_threads: Option<ThreadExecution>,
    ) -> std::result::Result<Arc<dyn rom_weaver_core::PatchHandler>, Box<OperationReport>> {
        if let Some(handler) = self.patches.probe(resolved_patch_path) {
            return Ok(handler);
        }
        let patch_label = if patch_path == resolved_patch_path {
            format!("`{}`", patch_path.display())
        } else {
            format!(
                "`{}` (resolved from `{}`)",
                resolved_patch_path.display(),
                patch_path.display()
            )
        };
        let unsupported_reason = explicitly_unsupported_patch_reason_for_path(resolved_patch_path);
        let (format_name, label) = match unsupported_reason {
            Some(reason) => (
                Some("PDS".to_string()),
                format!(
                    "patch {}/{}: {} is explicitly not supported: {reason}",
                    index + 1,
                    patch_count,
                    patch_label
                ),
            ),
            None => (
                None,
                format!(
                    "patch {}/{}: no registered patch handler matched {}",
                    index + 1,
                    patch_count,
                    patch_label
                ),
            ),
        };
        Err(Box::new(OperationReport::failed(
            OperationFamily::Patch,
            format_name,
            "probe",
            label,
            probe_threads,
        )))
    }
}

/// Parsed-and-validated patch-apply inputs: the compression options and the
/// three checksum maps (cache, expected-input, expected-output).
struct ParsedPatchApplyInputs {
    compression_options: PatchApplyCompressionOptions,
    cached_input_checksums: BTreeMap<String, String>,
    expected_input_checksums: BTreeMap<String, String>,
    expected_output_checksums: BTreeMap<String, String>,
}

/// The patch-apply input after the optional pre-apply compatibility transforms
/// (header strip, N64 byte-order rewrite, N64 normalize-for-repair), plus the
/// state needed to reverse/finalize them on the output.
struct PreparedApplyInput {
    apply_input: PathBuf,
    stripped_header: Option<Vec<u8>>,
    stripped_header_match: Option<KnownRomHeaderMatch>,
    n64_order: Option<N64ByteOrderTransform>,
}

/// The state carried out of [`CliApp::run_patch_apply_loop`] when every patch
/// applied successfully: the last successful apply report and the formats
/// applied in order. The fully patched bytes live at the `staged_output` path
/// the caller passed in (the final apply step writes there).
struct PatchApplyLoopOutcome {
    report: OperationReport,
    applied_formats: Vec<&'static str>,
}

/// The ROM copier-header state threaded through the patch chain: whether the
/// bytes currently feeding the next patch are headerless, plus the header
/// captured at the first strip (for mid-chain restores and the output re-add).
struct ChainHeaderState {
    headerless: bool,
    stripped_header: Option<Vec<u8>>,
    stripped_header_match: Option<KnownRomHeaderMatch>,
}

impl CliApp {
    /// Apply each resolved patch in sequence, threading the running output
    /// through every step (intermediate steps write temp files registered in
    /// `temp_paths`; the final step writes `staged_output`). Returns the last
    /// successful apply report plus the patched-output path and applied formats
    /// on full success, or `Err(report)` carrying the failure report when a
    /// patch handler is missing or an apply fails - the exact reports the
    /// inline loop produced. Extracted from `run_patch_apply` to shrink it; the
    /// `Err` early-exits map one-to-one onto the loop's former `return`s.
    #[expect(clippy::too_many_arguments)]
    fn run_patch_apply_loop(
        &self,
        resolved_patches: &[(PathBuf, PathBuf)],
        apply_input: PathBuf,
        staged_output: &Path,
        chain_header_modes: &[PatchApplyHeaderMode],
        step_verifications: &[patch_plan::PatchStepVerification],
        header_state: &mut ChainHeaderState,
        chain_n64_modes: &[PatchN64ByteOrderMode],
        n64_order: &mut Option<N64ByteOrderTransform>,
        probe_threads: &Option<ThreadExecution>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> std::result::Result<PatchApplyLoopOutcome, Box<OperationReport>> {
        let patch_count = resolved_patches.len();
        let mut current_input = apply_input;
        let mut applied_formats = Vec::with_capacity(patch_count);
        let mut report = OperationReport::failed(
            OperationFamily::Patch,
            None,
            "apply",
            "patch apply was not executed",
            context.single_thread_execution(),
        );

        for (index, (patch_path, resolved_patch_path)) in resolved_patches.iter().enumerate() {
            let handler = self.probe_patch_handler(
                patch_path,
                resolved_patch_path,
                index,
                patch_count,
                probe_threads.clone(),
            )?;
            applied_formats.push(handler.descriptor().name);
            let patch_start_percent = patch_progress_segment_start(index, patch_count);

            // Later chain steps may need a different header state than the previous
            // patch left behind (explicit per-patch mode, or auto evidence from this
            // patch's embedded source checksum).
            if index > 0
                && let Err(error) = self.chain_header_transition(
                    chain_header_modes.get(index).copied().unwrap_or_default(),
                    resolved_patch_path,
                    &mut current_input,
                    header_state,
                    context,
                    temp_paths,
                )
            {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "prepare",
                    format!(
                        "patch {}/{} (`{}`): header transition failed: {error}",
                        index + 1,
                        patch_count,
                        patch_path.display()
                    ),
                    context.single_thread_execution(),
                )));
            }
            if index > 0
                && let Err(error) = self.transition_n64_byte_order(
                    chain_n64_modes.get(index).copied().unwrap_or_default(),
                    resolved_patch_path,
                    &mut current_input,
                    n64_order,
                    context,
                    temp_paths,
                )
            {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "prepare",
                    format!(
                        "patch {}/{} (`{}`): N64 byte-order transition failed: {error}",
                        index + 1,
                        patch_count,
                        patch_path.display()
                    ),
                    context.single_thread_execution(),
                )));
            }

            let is_last = index + 1 == patch_count;
            let apply_output = if is_last {
                staged_output.to_path_buf()
            } else {
                let intermediate_output = context
                    .temp_paths()
                    .next_path("patch-apply-output-step", Some("bin"));
                temp_paths.push(intermediate_output.clone());
                intermediate_output
            };
            if let Some(parent) = apply_output.parent()
                && !parent.exists()
                && let Err(error) = fs::create_dir_all(parent)
            {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "prepare",
                    format!(
                        "failed to prepare output path `{}`: {error}",
                        apply_output.display()
                    ),
                    context.single_thread_execution(),
                )));
            }

            self.emit_running(
                OperationLabel {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: Some(handler.descriptor().name),
                },
                "apply",
                if patch_count == 1 {
                    format!("applying patch using {}", handler.descriptor().name)
                } else {
                    format!(
                        "applying patch {}/{} using {} (`{}`)",
                        index + 1,
                        patch_count,
                        handler.descriptor().name,
                        patch_path.display()
                    )
                },
                Some(patch_start_percent),
                None,
            );

            let step = step_verifications.get(index);
            let step_is_base = index > 0
                && step.and_then(|step| step.basis) == Some(patch_plan::PatchInputBasis::Base);
            // A previous-basis step with declared mid-chain input checks
            // verifies them against the real intermediate before it runs.
            if context.strict_patch_checksums()
                && !step_is_base
                && index > 0
                && let Some(declared) = step.and_then(|step| step.declared_input.as_ref())
                && let Err(error) = Self::verify_chain_step_state(&current_input, declared, context)
            {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "validate",
                    RomWeaverError::ValidationCode(
                        ValidationCodeError::new("patch.chain.input_mismatch")
                            .with_message(
                                "chain step input does not match the patch's declared input checks",
                            )
                            .with_field("patch_index", index as u64)
                            .with_field("patch", patch_path.display().to_string())
                            .with_field("detail", error.to_string()),
                    )
                    .to_string(),
                    context.single_thread_execution(),
                )));
            }

            let request = PatchApplyRequest {
                input: current_input,
                patches: vec![resolved_patch_path.clone()],
                output: apply_output.clone(),
            };
            let progress_tracker = Arc::new(PatchApplyProgressTracker::default());
            let mut patch_context =
                context
                    .clone()
                    .with_progress_sink(Arc::new(PatchApplyProgressSink::new(
                        context.progress_sink(),
                        index,
                        patch_count,
                        progress_tracker.clone(),
                    )));
            if step_is_base {
                // Both the embedded source and target checks describe the
                // base ROM (verified before the chain), not the running
                // intermediate - nothing at this step is enforceable. The
                // patch file's own integrity checksum still is.
                patch_context = patch_context.with_patch_check_scopes(PatchCheckScopes {
                    patch_integrity: context.strict_patch_checksums(),
                    source: false,
                    target: false,
                });
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: Some(handler.descriptor().name),
                    },
                    "apply",
                    format!(
                        "patch {}/{} input checks describe the base ROM (verified before the chain); embedded checks skipped for this step",
                        index + 1,
                        patch_count
                    ),
                    Some(patch_start_percent),
                    None,
                );
            }
            report = match handler.apply(&request, &patch_context) {
                Ok(report) => report,
                Err(RomWeaverError::Unsupported(op)) => OperationReport::unsupported(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "apply",
                    op.to_string(),
                    context.single_thread_execution(),
                ),
                Err(error) => OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "apply",
                    error.to_string(),
                    context.single_thread_execution(),
                ),
            };
            if report.status != OperationStatus::Succeeded {
                if patch_count > 1 {
                    report.label = format!(
                        "patch {}/{} (`{}`): {}",
                        index + 1,
                        patch_count,
                        patch_path.display(),
                        report.label
                    );
                }
                return Err(Box::new(report));
            }
            if !progress_tracker.saw_meaningful_running_progress() {
                self.emit_running(
                    OperationLabel {
                        command: "patch-apply",
                        family: OperationFamily::Patch,
                        format: Some(handler.descriptor().name),
                    },
                    "apply",
                    if patch_count == 1 {
                        format!("applied patch using {}", handler.descriptor().name)
                    } else {
                        format!(
                            "applied patch {}/{} using {} (`{}`)",
                            index + 1,
                            patch_count,
                            handler.descriptor().name,
                            patch_path.display()
                        )
                    },
                    None,
                    report.thread_execution.clone(),
                );
            }

            // A declared mid-chain output (bundle entry outputChecks) verifies
            // against the real intermediate when this step ends an exact
            // authored chain prefix. The final step keeps the existing
            // finalized-output gate instead (intermediates are raw bytes).
            if context.strict_patch_checksums()
                && !is_last
                && let Some(step) = step
                && step.is_chain_prefix
                && let Some(declared) = step.declared_output.as_ref()
                && let Err(error) = Self::verify_chain_step_state(&apply_output, declared, context)
            {
                return Err(Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    Some(handler.descriptor().name.to_string()),
                    "validate",
                    RomWeaverError::ValidationCode(
                        ValidationCodeError::new("patch.chain.output_mismatch")
                            .with_message(
                                "chain step output does not match the patch's declared output checks",
                            )
                            .with_field("patch_index", index as u64)
                            .with_field("patch", patch_path.display().to_string())
                            .with_field("detail", error.to_string()),
                    )
                    .to_string(),
                    context.single_thread_execution(),
                )));
            }

            current_input = apply_output;
        }

        Ok(PatchApplyLoopOutcome {
            report,
            applied_formats,
        })
    }

    /// Verify a chain intermediate against declared checks: every declared
    /// digest plus the exact size when pinned. A fresh read of the temp file -
    /// only runs at declared boundaries, which bundles rarely carry.
    fn verify_chain_step_state(
        state_path: &Path,
        declared: &patch_plan::PlanState,
        context: &OperationContext,
    ) -> Result<()> {
        if let Some(expected_size) = declared.size {
            Self::validate_patch_input_size(state_path, Some(expected_size), None)?;
        }
        if !declared.checksums.is_empty() {
            Self::validate_patch_apply_expected_checksums(
                state_path,
                &declared.checksums,
                &BTreeMap::new(),
                "chain step",
                context,
            )?;
        }
        Ok(())
    }

    /// Resolve each chain step's verification spec with precedence CLI
    /// `--patch-basis` > bundle `basis` > inference (the patch's embedded
    /// source CRC32 matching the prepared input). Declared base-basis
    /// mid-chain steps verify against the base here, once, before the chain
    /// runs. The synthetic cheat step (resolved index 0 when codes are
    /// present) consumes the base by construction and carries no declaration.
    /// With checksum validation ignored the whole resolution is skipped.
    fn resolve_apply_step_verifications(
        &self,
        resolved_patches: &[(PathBuf, PathBuf)],
        cheat_steps: usize,
        bundle_steps: Vec<patch_plan::PatchStepVerification>,
        cli_basis: &[PatchBasisMode],
        apply_input: &Path,
        context: &OperationContext,
    ) -> Result<Vec<patch_plan::PatchStepVerification>> {
        let step_count = resolved_patches.len();
        let mut steps: Vec<patch_plan::PatchStepVerification> =
            vec![patch_plan::PatchStepVerification::default(); step_count];
        if !context.strict_patch_checksums() || step_count <= 1 {
            return Ok(steps);
        }
        let user_count = step_count.saturating_sub(cheat_steps);
        // Declared sources align with the user-visible patch list; discovery
        // or archive expansion can change the resolved count, in which case
        // declarations cannot be attributed and only inference applies.
        let aligned = |declared_len: usize| declared_len == user_count;
        if !bundle_steps.is_empty() && aligned(bundle_steps.len()) {
            for (user_index, bundle_step) in bundle_steps.into_iter().enumerate() {
                steps[cheat_steps + user_index] = bundle_step;
            }
        }
        if !cli_basis.is_empty() {
            if !aligned(cli_basis.len()) {
                return Err(RomWeaverError::Validation(format!(
                    "--patch-basis must be given once per --patch (or not at all); got {} value(s) for {user_count} patch(es)",
                    cli_basis.len()
                )));
            }
            for (user_index, mode) in cli_basis.iter().enumerate() {
                if let Some(basis) = mode.declared() {
                    let step = &mut steps[cheat_steps + user_index];
                    step.basis = Some(basis);
                    step.basis_source = Some(PatchBasisSource::Declared);
                }
            }
        }

        // Lazy base identity: the CRC32 of the exact bytes the chain consumes.
        let mut cached_base_crc32: Option<Option<String>> = None;
        let mut resolve_base_crc32 = |context: &OperationContext| -> Option<String> {
            if cached_base_crc32.is_none() {
                let computed = context.seeded_checksum(apply_input, "crc32").or_else(|| {
                    File::open(apply_input)
                        .ok()
                        .and_then(|file| {
                            Self::crc32_of_reader(&mut BufReader::new(file), context).ok()
                        })
                        .flatten()
                });
                trace!(base_crc32 = ?computed, "resolved base identity for basis inference");
                cached_base_crc32 = Some(computed);
            }
            cached_base_crc32.clone().expect("just seeded")
        };

        for index in 1..step_count {
            let (patch_path, resolved_patch_path) = &resolved_patches[index];
            let step_basis = steps[index].basis;
            match step_basis {
                None => {
                    // Inference: a mid-chain patch whose embedded source CRC32
                    // equals the base consumes the base, not the previous
                    // patch's output.
                    let Some(embedded) =
                        self.embedded_patch_source_crc32(resolved_patch_path, context)
                    else {
                        continue;
                    };
                    if resolve_base_crc32(context).is_some_and(|base| base == embedded) {
                        debug!(
                            index,
                            patch = %patch_path.display(),
                            "patch input checks match the base ROM; resolved basis to base"
                        );
                        steps[index].basis = Some(patch_plan::PatchInputBasis::Base);
                        steps[index].basis_source =
                            Some(patch_plan::PatchBasisSource::InferredBase);
                    }
                }
                Some(patch_plan::PatchInputBasis::Base) => {
                    // A declared base step verifies against the base once, up
                    // front: its declared checks when present, else its
                    // embedded source CRC32.
                    if let Some(declared) = steps[index].declared_input.clone() {
                        Self::verify_chain_step_state(apply_input, &declared, context).map_err(
                            |error| {
                                RomWeaverError::ValidationCode(
                                    ValidationCodeError::new("patch.base.input_mismatch")
                                        .with_message(
                                            "patch declares basis base but its input checks do not match the ROM",
                                        )
                                        .with_field("patch_index", index as u64)
                                        .with_field("patch", patch_path.display().to_string())
                                        .with_field("detail", error.to_string()),
                                )
                            },
                        )?;
                    } else if let Some(embedded) =
                        self.embedded_patch_source_crc32(resolved_patch_path, context)
                        && let Some(base) = resolve_base_crc32(context)
                        && base != embedded
                    {
                        return Err(RomWeaverError::ValidationCode(
                            ValidationCodeError::new("patch.base.input_mismatch")
                                .with_message(
                                    "patch declares basis base but its embedded source checksum does not match the ROM",
                                )
                                .with_field("patch_index", index as u64)
                                .with_field("patch", patch_path.display().to_string())
                                .with_field("expected", embedded)
                                .with_field("actual", base),
                        ));
                    }
                }
                Some(patch_plan::PatchInputBasis::Previous) => {}
            }
        }
        Ok(steps)
    }

    /// Shared compress-and-emit core for `patch apply` output compression, used
    /// by both the plain patch-apply path and the `.dcp` disc rebuild. Resolves
    /// the create handler for `plan.format`, emits the caller-supplied
    /// "compressing…" running event, builds the container create request, runs
    /// it with `overrides`, and returns the create report plus the codec label.
    ///
    /// The two callers diverge on the surrounding wording (running noun,
    /// failure prefix, success label) and on the report family/format/threads
    /// they attach, so status-check and label assembly stay at the call sites;
    /// only this byte-for-byte-identical core (handler resolution, codec label,
    /// thread plan, running event, request build, create + create-error
    /// fallback) is shared. A missing handler - unreachable once `plan` came
    /// from [`Self::resolve_patch_apply_compression_plan`], which already
    /// validated registration/create capability - surfaces as the original
    /// "requested output format is not registered" validation error for the
    /// caller to wrap.
    pub(super) fn run_patch_apply_compression(
        &self,
        plan: &PatchApplyCompressionPlan,
        inputs: Vec<PathBuf>,
        overrides: &[CreateInputOverride],
        running_label: String,
        context: &OperationContext,
    ) -> Result<(OperationReport, String)> {
        let Some(handler) = self.containers.find_by_name(&plan.format) else {
            return Err(RomWeaverError::Validation(
                "requested output format is not registered".to_string(),
            ));
        };
        let codec_label = plan.codec.as_deref().unwrap_or("default").to_string();
        let compress_threads = Some(context.plan_threads(handler.capabilities().create_threads));
        self.emit_running(
            OperationLabel {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: Some(plan.format.as_str()),
            },
            "compress",
            running_label,
            Some(0.0),
            compress_threads,
        );
        let request = ContainerCreateRequest {
            inputs,
            output: plan.output_path.clone(),
            format: plan.format.clone(),
            codec: plan.codec.clone(),
            level: plan.level,
            parent: None,
        };
        let compress_report = handler
            .create_with_input_overrides(&request, overrides, context)
            .unwrap_or_else(|error| {
                OperationReport::failed(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "create",
                    error.to_string(),
                    context.single_thread_execution(),
                )
            });
        Ok((compress_report, codec_label))
    }

    /// Parse the compression options and the three checksum maps. Parse errors
    /// surface as [`RomWeaverError`]; the caller wraps them into a
    /// `validate`-stage report. Consumes the owned compress-* args (no later
    /// use).
    fn parse_patch_apply_inputs(
        assume_in: &[String],
        expect_in: &[String],
        expect_out: &[String],
        no_compress: bool,
        compress_format: Option<String>,
        compress_codec: Vec<String>,
        compress_level: CompressionLevelProfile,
    ) -> Result<ParsedPatchApplyInputs> {
        let compression_options = Self::parse_patch_apply_compression_options(
            no_compress,
            compress_format,
            compress_codec,
            compress_level,
        )?;
        // Patch apply has no input-size preflight, so `--expect-in`/`--assume-in`
        // are checksum-only here (`--expect-in size=N` size gating lives on
        // `patch validate`); `--expect-out` is checksum-only everywhere.
        let cached_input_checksums =
            parse_expect_tokens(assume_in, "--assume-in", false)?.checksums;
        let expected_input_checksums =
            parse_expect_tokens(expect_in, "--expect-in", false)?.checksums;
        let expected_output_checksums =
            parse_expect_tokens(expect_out, "--expect-out", false)?.checksums;
        Ok(ParsedPatchApplyInputs {
            compression_options,
            cached_input_checksums,
            expected_input_checksums,
            expected_output_checksums,
        })
    }

    /// Apply the optional pre-apply compatibility transforms to `resolved_input`
    /// (strip ROM header, rewrite N64 byte order, normalize N64 to big-endian
    /// for checksum repair), pushing any temp files into `temp_paths`. Returns
    /// the prepared input plus the state needed to finalize the output; failures
    /// surface as [`RomWeaverError`] for the caller to wrap into a `compat`
    /// report.
    #[expect(clippy::too_many_arguments)]
    fn prepare_patch_apply_input(
        &self,
        resolved_input: &Path,
        strip_header: bool,
        n64_byte_order: PatchN64ByteOrderMode,
        first_patch: Option<&Path>,
        expected_crc32: Option<&str>,
        repair_checksum: bool,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<PreparedApplyInput> {
        let mut stripped_header = None;
        let mut stripped_header_match = None;
        let mut n64_order = None;
        let apply_input = if strip_header {
            self.emit_running(
                OperationLabel {
                    command: "patch-apply",
                    family: OperationFamily::Patch,
                    format: None,
                },
                "prepare",
                "stripping ROM header before patch apply",
                None,
                None,
            );
            let stripped_path = context
                .temp_paths()
                .next_path("patch-apply-input-noheader", Some("bin"));
            match Self::strip_header_to_temp(resolved_input, &stripped_path) {
                Ok(result) => {
                    stripped_header = Some(result.header_bytes);
                    stripped_header_match = result.matched_header;
                    temp_paths.push(stripped_path.clone());
                    stripped_path
                }
                Err(error) => return Err(error),
            }
        } else {
            resolved_input.to_path_buf()
        };
        let apply_input = match self.resolve_patch_n64_target(
            &apply_input,
            first_patch,
            expected_crc32,
            n64_byte_order,
            context,
        )? {
            Some((source_order, target_order)) => {
                n64_order = Some(N64ByteOrderTransform {
                    from: target_order,
                    to: source_order,
                });
                if source_order == target_order {
                    apply_input
                } else {
                    self.emit_running(
                        OperationLabel {
                            command: "patch-apply",
                            family: OperationFamily::Patch,
                            format: None,
                        },
                        "compat",
                        format!(
                            "transforming N64 input byte order to {}",
                            target_order.label()
                        ),
                        None,
                        context.single_thread_execution(),
                    );
                    let transformed_path = context
                        .temp_paths()
                        .next_path("patch-apply-input-n64-byte-order", Some("bin"));
                    Self::rewrite_n64_byte_order(
                        &apply_input,
                        &transformed_path,
                        source_order,
                        target_order,
                    )?;
                    temp_paths.push(transformed_path.clone());
                    transformed_path
                }
            }
            None => apply_input,
        };
        let apply_input = if repair_checksum {
            let normalized_path = context
                .temp_paths()
                .next_path("patch-apply-input-z64", Some("bin"));
            match Self::normalize_n64_to_big_endian_to_temp(&apply_input, &normalized_path) {
                Ok(Some(order)) => {
                    self.emit_running(
                        OperationLabel {
                            command: "patch-apply",
                            family: OperationFamily::Patch,
                            format: None,
                        },
                        "compat",
                        "normalizing N64 byte order for header repair",
                        None,
                        context.single_thread_execution(),
                    );
                    if n64_order.is_none() {
                        n64_order = Some(N64ByteOrderTransform {
                            from: N64ByteOrder::BigEndian,
                            to: order,
                        });
                    } else if let Some(transform) = n64_order.as_mut() {
                        transform.from = N64ByteOrder::BigEndian;
                    }
                    temp_paths.push(normalized_path.clone());
                    normalized_path
                }
                Ok(None) => apply_input,
                Err(error) => return Err(error),
            }
        } else {
            apply_input
        };
        Ok(PreparedApplyInput {
            apply_input,
            stripped_header,
            stripped_header_match,
            n64_order,
        })
    }
}
