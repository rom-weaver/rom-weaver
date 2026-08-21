use super::*;

use super::bundle_apply::BundleApplyResolution;
use super::bundle_parse::bundle_validation;
use super::patch_apply_disc::DiscContext;
use super::patch_basis_decision::ChecksumBasisProof;
use super::patch_commands::{
    DiscoveredPatchApplySidecars, PatchApplyProgressSink, PatchApplyProgressTracker,
    patch_progress_segment_start,
};

use rom_weaver_patches::basis_probe::PatchBasis;

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (fs::canonicalize(left), fs::canonicalize(right)),
            (Ok(left), Ok(right)) if left == right
        )
        || native_file_identity_matches(left, right)
}

fn path_is_occupied(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(RomWeaverError::Io(error)),
    }
}

static INFERRED_PUBLISH_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

pub(super) fn warn_on_rom_name_mismatch(expected: Option<&str>, actual_path: &Path) {
    let Some(expected) = expected else {
        return;
    };
    let Some(actual) = actual_path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    if expected.to_lowercase() == actual.to_lowercase() {
        return;
    }
    warn!(
        expected_rom_name = expected,
        actual_rom_name = actual,
        "bundle ROM name mismatch; continuing because file-name checks are advisory"
    );
}

// same-file compares dev/inode on Unix and volume serial + file index on
// Windows. The Windows half cannot be written against std on stable: the
// MetadataExt equivalents are still unstable behind `windows_by_handle`
// (rust-lang/rust#63010), which is why the previous hand-rolled cfg(windows)
// branch never compiled.
#[cfg(not(target_arch = "wasm32"))]
fn native_file_identity_matches(left: &Path, right: &Path) -> bool {
    same_file::is_same_file(left, right).unwrap_or(false)
}

#[cfg(target_arch = "wasm32")]
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
    default_basis: PatchBasisMode,
    output: Option<PathBuf>,
    threads: ThreadBudget,
}

struct PatchApplyPrepareChainInputs<'a> {
    resolved_patches: &'a [(PathBuf, PathBuf)],
    resolved_input: &'a Path,
    is_disc: bool,
    has_codes: bool,
    patch_header: &'a [PatchApplyHeaderMode],
    auto_evidence_available: bool,
    n64_byte_order: &'a [PatchN64ByteOrderMode],
    expected_input_checksums: &'a BTreeMap<String, String>,
    cached_input_checksums: &'a BTreeMap<String, String>,
    expected_input_size: Option<u64>,
    repair_checksum: bool,
    context: &'a OperationContext,
    temp_paths: &'a mut Vec<PathBuf>,
}

struct PatchApplyPreparedChain {
    chain_header_modes: Vec<PatchApplyHeaderMode>,
    chain_n64_modes: Vec<PatchN64ByteOrderMode>,
    checksum_verification_labels: Vec<String>,
    apply_input: PathBuf,
    header_state: ChainHeaderState,
    n64_order: Option<N64ByteOrderTransform>,
}

struct PatchApplyDiscInputs<'a> {
    input: &'a Path,
    target: Option<&'a str>,
    patches: &'a [PathBuf],
    ignore_checksum_validation: bool,
    any_explicit_strip: bool,
    output_header: Option<PatchApplyOutputHeaderMode>,
    repair_checksum: bool,
    any_explicit_n64_transform: bool,
    has_expected_output_checksums: bool,
    context: &'a OperationContext,
}

struct PatchApplyReportDecoration<'a> {
    patch_count: usize,
    applied_formats: &'a [&'static str],
    header_state: &'a ChainHeaderState,
    extension_swap_note: Option<&'a str>,
    n64_order: Option<N64ByteOrderTransform>,
    chain_n64_modes: &'a [PatchN64ByteOrderMode],
    extracted_archives: usize,
    extracted_patch_notes: &'a [String],
    expected_output_checksums: &'a BTreeMap<String, String>,
    raw_ready_output: &'a Path,
    context: &'a OperationContext,
}

struct PatchApplyCompressionInputs<'a> {
    report: &'a mut OperationReport,
    compression_options: &'a PatchApplyCompressionOptions,
    output: &'a Path,
    output_was_inferred: bool,
    resolved_input: &'a Path,
    is_disc: bool,
    raw_ready_output: &'a Path,
    disc_track_overrides: &'a [CreateInputOverride],
    context: &'a OperationContext,
    temp_paths: &'a mut Vec<PathBuf>,
    terminal_output_path: &'a mut PathBuf,
    terminal_output_source: &'a mut PathBuf,
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
        // The bundle context owns the temp namespace for bundle-extracted
        // archive members, so it must outlive the whole apply.
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
        if let Some(outcome) = self.validate_patch_apply_output_preflight(
            &args,
            bundle_resolution.as_ref(),
            &original_input,
            local_bundle.as_deref(),
        ) {
            return outcome;
        }
        let emit_bundle = args.emit_bundle.clone();
        let mut emit_inputs = emit_bundle.as_ref().map(|_| EmitBundleInputs {
            input: args.input.clone(),
            patches: args.patches.clone(),
            headers: args.patch_header.clone(),
            bases: args.patch_basis.clone(),
            default_basis: bundle_resolution
                .as_ref()
                .map(|resolution| resolution.patch_basis)
                .unwrap_or(args.default_patch_basis.unwrap_or(PatchBasisMode::Base)),
            output: args.output.clone(),
            threads: args.threads,
        });
        let mut final_output = None;
        let outcome = if args.patches.iter().any(|patch| Self::is_dcp_patch(patch)) {
            let expected_rom_name = bundle_resolution
                .as_ref()
                .and_then(|resolution| resolution.expected_rom_name.as_deref());
            self.run_dcp_apply(args, expected_rom_name)
        } else {
            self.run_patch_apply_resolved(
                args,
                bundle_resolution,
                original_input,
                local_bundle,
                &mut final_output,
                emit_inputs.as_mut().map(|inputs| &mut inputs.bases),
            )
        };
        // --emit-bundle failures don't undo the already-written apply; warn
        // rather than fail.
        if let (Some(emit_path), Some(mut inputs)) = (emit_bundle, emit_inputs)
            && outcome.status == OperationStatus::Succeeded
        {
            inputs.output = final_output.or(inputs.output);
            if let Err(error) = self.emit_apply_bundle(&emit_path, inputs) {
                tracing::warn!(
                    %error,
                    bundle = %emit_path.display(),
                    "apply succeeded but --emit-bundle failed",
                );
            }
        }
        outcome
    }

    /// Write a bundle describing a just-completed apply. Reuses
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
            default_patch_basis: Some(inputs.default_basis),
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

    fn update_emit_bundle_bases(
        emit_bases: Option<&mut Vec<PatchBasisMode>>,
        resolved_patches: &[(PathBuf, PathBuf)],
        step_verifications: &[patch_plan::PatchStepVerification],
    ) {
        let Some(emit_bases) = emit_bases else {
            return;
        };
        if step_verifications.len() != resolved_patches.len() {
            return;
        }
        let Some(bases) = step_verifications
            .iter()
            .map(|step| {
                step.basis.map(|basis| match basis {
                    patch_plan::PatchInputBasis::Base => PatchBasisMode::Base,
                    patch_plan::PatchInputBasis::Previous => PatchBasisMode::Previous,
                })
            })
            .collect::<Option<Vec<_>>>()
        else {
            return;
        };
        *emit_bases = bases;
    }

    /// Preflight every path `patch apply` is about to touch: each patch must be
    /// readable and the destination writable, checked before the ROM is opened
    /// so an access problem costs nothing.
    fn validate_patch_apply_access(
        &self,
        patches: &[PathBuf],
        output: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        for patch_path in patches {
            if let Some(report) = self.require_readable_path(
                "patch-apply",
                OperationFamily::Patch,
                None,
                patch_path,
                thread_execution.clone(),
            ) {
                return Some(report);
            }
        }
        self.require_writable_output_parent(
            "patch-apply",
            OperationFamily::Patch,
            None,
            output,
            thread_execution,
        )
    }

    /// The body of `patch apply` after bundle resolution: `args` is a plain,
    /// fully-merged command.
    fn run_patch_apply_resolved(
        &self,
        args: PatchApplyCommand,
        bundle_resolution: Option<BundleApplyResolution>,
        original_input: PathBuf,
        local_bundle: Option<PathBuf>,
        final_output: &mut Option<PathBuf>,
        emit_bases: Option<&mut Vec<PatchBasisMode>>,
    ) -> AppRunOutcome {
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
            default_patch_basis,
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
            force,
            dry_run,
            threads,
        } = args;
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
        // Per-patch header modes: a missing entry inherits the last given mode;
        // an empty list means all-auto. N64 byte-order rewrites and cheat codes
        // pin offsets to the original bytes, so those runs degrade auto to keep.
        // Ignoring checksum enforcement does not discard representation evidence.
        let any_explicit_n64_transform = n64_byte_order.iter().any(|mode| mode.target().is_some());
        let auto_evidence_available = !any_explicit_n64_transform && codes.is_empty();
        let any_explicit_strip = patch_header.contains(&PatchApplyHeaderMode::Strip);
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
            compress_format.clone(),
            compress_codec.clone(),
            compress_level,
        ) {
            Ok(parsed) => parsed,
            Err(error) => {
                return self.finish("patch-apply", fail("validate", error.to_string()));
            }
        };
        if let Some(report) = self.require_readable_path(
            "patch-apply",
            OperationFamily::Patch,
            None,
            &input,
            probe_threads.clone(),
        ) {
            return self.finish("patch-apply", report);
        }
        if dry_run {
            let Some(output) = output.as_deref() else {
                return self.finish(
                    "patch-apply",
                    fail(
                        "validate",
                        "--dry-run requires --output when the output path cannot be inferred before selecting an archive member".to_string(),
                    ),
                );
            };
            let report = self.patch_apply_dry_run(
                &input,
                &patches,
                output,
                &compression_options,
                probe_threads.clone(),
            );
            return self.finish("patch-apply", report);
        }
        let disc_context = match self.resolve_patch_apply_disc(PatchApplyDiscInputs {
            input: &input,
            target: target.as_deref(),
            patches: &patches,
            ignore_checksum_validation,
            any_explicit_strip,
            output_header,
            repair_checksum,
            any_explicit_n64_transform,
            has_expected_output_checksums: !expected_output_checksums.is_empty(),
            context: &context,
        }) {
            Ok(disc) => disc,
            Err(report) => return self.finish("patch-apply", *report),
        };
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
        let mut expected_input_size: Option<u64> = None;
        // Input-check precedence is CLI > bundle > file name; any conflict
        // names the bundle source that introduced it.
        if !ignore_checksum_validation
            && let Some(resolution) = &bundle_resolution
            && let Some(report) = self.merge_patch_apply_bundle_requirements(
                resolution,
                disc_context.is_some(),
                &mut expected_input_checksums,
                &mut expected_input_size,
                &mut expected_output_checksums,
                probe_threads.clone(),
            )
        {
            return self.finish("patch-apply", report);
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
                        stop_on_single_payload_codec: false,
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
        warn_on_rom_name_mismatch(
            bundle_resolution
                .as_ref()
                .and_then(|resolution| resolution.expected_rom_name.as_deref()),
            &resolved_input,
        );
        let (mut output, output_was_inferred) = match self.resolve_patch_apply_output_path(
            output,
            &input,
            &resolved_input,
            no_compress,
            compress_format.as_deref(),
        ) {
            Ok(resolved) => resolved,
            Err(error) => return self.finish("patch-apply", fail("validate", error.to_string())),
        };
        if let Some(message) = Self::patch_apply_output_alias_message(
            &input,
            &patches,
            &original_input,
            local_bundle.as_deref(),
            &output,
        ) {
            return self.finish("patch-apply", fail("validate", message));
        }
        let compression_options = match self.resolve_patch_apply_compression_options(
            no_compress,
            compress_format.clone(),
            compress_codec.clone(),
            compress_level,
            &output,
            &resolved_input,
        ) {
            Ok(options) => options,
            Err(error) => return self.finish("patch-apply", fail("validate", error.to_string())),
        };
        // Compressing can append an extension; the compression step re-checks
        // that resolved path after patch validation.
        if let Err(error) = ensure_output_available(&output, force) {
            return self.finish("patch-apply", fail("validate", error.to_string()));
        }
        if let Some(report) =
            self.validate_patch_apply_access(&patches, &output, probe_threads.clone())
        {
            return self.finish("patch-apply", report);
        }
        // Seed host-provided input checksums so handler source verification skips
        // a re-read. Keyed by the resolved path; header/N64 transforms write a
        // distinct temp path whose lookup misses and recomputes. Skipped for disc
        // apply, where the cached checksums describe the whole disc, not the track.
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
                stop_on_single_payload_codec: false,
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

        let mut terminal_output_for_apply = None;
        let report = if resolved_patches.is_empty() {
            OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                "at least one --patch value or --code is required",
                probe_threads.clone(),
            )
        } else {
            (|| {
                let PatchApplyPreparedChain {
                    chain_header_modes,
                    chain_n64_modes,
                    mut checksum_verification_labels,
                    apply_input,
                    mut header_state,
                    mut n64_order,
                } = match self.prepare_patch_apply_chain(PatchApplyPrepareChainInputs {
                    resolved_patches: &resolved_patches,
                    resolved_input: &resolved_input,
                    is_disc,
                    has_codes: !codes.is_empty(),
                    patch_header: &patch_header,
                    auto_evidence_available,
                    n64_byte_order: &n64_byte_order,
                    expected_input_checksums: &expected_input_checksums,
                    cached_input_checksums: &cached_input_checksums,
                    expected_input_size,
                    repair_checksum,
                    context: &context,
                    temp_paths: &mut temp_paths,
                }) {
                    Ok(prepared) => prepared,
                    Err(report) => return *report,
                };
                let (mut add_header, mut strip_output_header) =
                    Self::resolve_patch_apply_output_header(
                        &header_state,
                        output_header_mode,
                        output_header,
                        is_disc,
                    );

                let patch_count = resolved_patches.len();
                // Single-patch runs know the final header state up front, so the
                // extension swap lands before any writer chooses a path - no
                // post-hoc rename, which the browser VFS cannot observe. Chains
                // re-evaluate after the loop (they always stage).
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
                if let Some(report) = Self::inferred_output_collision_report(
                    output_was_inferred,
                    &mut output,
                    &input,
                    context.single_thread_execution(),
                ) {
                    return report;
                }
                // Disc inputs reject the header/N64 transforms and do their own
                // reassembly, so they skip the standard compat finalize; they always
                // stage the patched track before reassembling the full disc.
                let requires_compat_finalize = !is_disc
                    && (add_header
                        || strip_output_header
                        || repair_checksum
                        || n64_order.is_some()
                        || patch_count > 1);
                let needs_staged_output =
                    is_disc || requires_compat_finalize || compression_options.enabled;
                let staged_output = match Self::patch_apply_staged_output(
                    &output,
                    &resolved_input,
                    output_was_inferred,
                    needs_staged_output,
                    compression_options.enabled,
                    &context,
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
                };

                // Resolve every step's input basis (CLI flag > bundle declaration >
                // inference against the prepared input) and verify declared
                // base-basis steps against the base once, before the chain runs.
                let step_verifications = match self.plan_apply_step_verifications(
                    &resolved_patches,
                    usize::from(!codes.is_empty()),
                    PatchApplyBasisInputs {
                        bundle_steps: bundle_resolution
                            .as_ref()
                            .map(|resolution| resolution.step_verifications.clone())
                            .unwrap_or_default(),
                        shared: bundle_resolution
                            .as_ref()
                            .map(|resolution| resolution.patch_basis)
                            .unwrap_or(default_patch_basis.unwrap_or(PatchBasisMode::Base)),
                        cli: &patch_basis,
                    },
                    PatchApplyBaseInputs {
                        prepared: apply_input.as_path(),
                        original: resolved_input.as_path(),
                        prepared_headerless: header_state.headerless.then_some(true),
                        prepared_n64_byte_order: n64_order.map(|order| order.from),
                        original_n64_byte_order: n64_order.map(|order| order.to),
                    },
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
                Self::update_emit_bundle_bases(emit_bases, &resolved_patches, &step_verifications);

                let PatchApplyLoopOutcome {
                    mut report,
                    applied_formats,
                } = match self.run_patch_apply_loop(RunPatchApplyLoopInputs {
                    resolved_patches: &resolved_patches,
                    apply_input,
                    staged_output: &staged_output,
                    chain_header_modes: &chain_header_modes,
                    step_verifications: &step_verifications,
                    header_state: &mut header_state,
                    chain_n64_modes: &chain_n64_modes,
                    n64_order: &mut n64_order,
                    probe_threads: &probe_threads,
                    context: &context,
                    temp_paths: &mut temp_paths,
                }) {
                    Ok(outcome) => outcome,
                    Err(report) => return *report,
                };

                // Mid-chain transitions may have changed the header state; chains always
                // stage (patch_count > 1 forces the compat finalize), so re-resolving the
                // output-header decision and the extension swap here still lands before
                // the finalize copy chooses its destination.
                if patch_count > 1 {
                    (add_header, strip_output_header) = Self::resolve_patch_apply_output_header(
                        &header_state,
                        output_header_mode,
                        output_header,
                        is_disc,
                    );
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
                    if let Some(report) = Self::inferred_output_collision_report(
                        output_was_inferred,
                        &mut output,
                        &input,
                        context.single_thread_execution(),
                    ) {
                        return report;
                    }
                }
                let mut terminal_output_path = output.clone();

                let mut raw_ready_output = staged_output.clone();
                let mut terminal_output_source = raw_ready_output.clone();
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
                    let finalized_output_path =
                        if compression_options.enabled || output_was_inferred {
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
                        crate::header_detection_and_finalize::PatchApplyFinalizeOptions {
                            repair_hint_path: Some(&resolved_input),
                            restore_n64_order: n64_order.filter(|order| order.from != order.to),
                        },
                    ) {
                        Ok(finalized) => {
                            raw_ready_output = finalized_output_path;
                            if output_was_inferred {
                                terminal_output_source = raw_ready_output.clone();
                            }
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
                                report.label =
                                    format!("{}; warning={repair_warning}", report.label);
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
                // only the patched track is redirected via a create override
                // (untouched tracks read in place; no whole-disc scratch copy) and
                // the original sheet feeds the compressor below. With --no-compress
                // the disc is staged and written beside `output` directly.
                if is_disc && report.status == OperationStatus::Succeeded {
                    let disc = disc_context
                        .as_ref()
                        .expect("disc context present for disc input");
                    for warning in &disc.warnings {
                        report.label = format!("{}; {}", report.label, warning);
                    }
                    if compression_options.enabled {
                        match self.disc_target_track_override(disc, &staged_output, &mut temp_paths)
                        {
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
                        let disc_output = if output_was_inferred {
                            &staged_output
                        } else {
                            &output
                        };
                        match self.write_disc_output(disc, &staged_sheet, disc_output) {
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
                        if output_was_inferred {
                            terminal_output_source = staged_output.clone();
                        }
                    }
                }

                if let Err(error_report) = self.decorate_patch_apply_report(
                    &mut report,
                    &mut checksum_verification_labels,
                    PatchApplyReportDecoration {
                        patch_count,
                        applied_formats: &applied_formats,
                        header_state: &header_state,
                        extension_swap_note: extension_swap_note.as_deref(),
                        n64_order,
                        chain_n64_modes: &chain_n64_modes,
                        extracted_archives,
                        extracted_patch_notes: &extracted_patch_notes,
                        expected_output_checksums: &expected_output_checksums,
                        raw_ready_output: &raw_ready_output,
                        context: &context,
                    },
                ) {
                    return *error_report;
                }

                if report.status == OperationStatus::Succeeded
                    && compression_options.enabled
                    && let Err(error_report) = self.resolve_guarded_patch_apply_compression_plan(
                        &output,
                        &resolved_input,
                        &compression_options,
                        force,
                        report.format.clone(),
                        &context,
                    )
                {
                    return *error_report;
                }
                if let Some(error_report) =
                    self.compress_patch_apply_output(PatchApplyCompressionInputs {
                        report: &mut report,
                        compression_options: &compression_options,
                        output: &output,
                        output_was_inferred,
                        resolved_input: &resolved_input,
                        is_disc,
                        raw_ready_output: &raw_ready_output,
                        disc_track_overrides: &disc_track_overrides,
                        context: &context,
                        temp_paths: &mut temp_paths,
                        terminal_output_path: &mut terminal_output_path,
                        terminal_output_source: &mut terminal_output_source,
                    })
                {
                    return error_report;
                }

                if let Err(error) = Self::publish_inferred_patch_apply_output_if_needed(
                    output_was_inferred,
                    report.status,
                    &terminal_output_source,
                    &mut terminal_output_path,
                    &input,
                ) {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "publish",
                        error.to_string(),
                        context.single_thread_execution(),
                    );
                }
                terminal_output_for_apply = (report.status == OperationStatus::Succeeded)
                    .then(|| terminal_output_path.clone());

                if report.status == OperationStatus::Succeeded {
                    let kind_hint = compression_options.enabled.then_some("archive");
                    report = Self::attach_emitted_files_details(
                        report,
                        vec![terminal_output_path],
                        kind_hint,
                    );
                }

                report
            })()
        };

        let mut report = report;
        if report.status == OperationStatus::Succeeded
            && let Some(summary) = cheat_summary
        {
            report.label = format!("{}; {}", report.label, summary.label());
        }

        *final_output = terminal_output_for_apply;
        Self::cleanup_temp_paths(&temp_paths);
        self.finish("patch-apply", report)
    }

    fn merge_patch_apply_bundle_requirements(
        &self,
        resolution: &BundleApplyResolution,
        is_disc: bool,
        expected_input_checksums: &mut BTreeMap<String, String>,
        expected_input_size: &mut Option<u64>,
        expected_output_checksums: &mut BTreeMap<String, String>,
        probe_threads: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        for (source_label, requirements) in &resolution.checks {
            if let Some(report) = self.merge_expected_input_requirements(
                "patch-apply",
                source_label,
                requirements,
                expected_input_checksums,
                expected_input_size,
                probe_threads.clone(),
            ) {
                return Some(report);
            }
        }

        let (source_label, requirements) = resolution.output_checks.as_ref()?;
        if is_disc {
            trace!(
                source = %source_label,
                "bundle output checks skipped: disc apply emits no single checksummable output"
            );
            return None;
        }
        for (algorithm, hex) in &requirements.checksums {
            match expected_output_checksums.get(algorithm) {
                Some(existing) if existing != hex => {
                    return Some(OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        format!(
                            "{source_label} requires output {algorithm} {hex} but {existing} was already requested"
                        ),
                        probe_threads.clone(),
                    ));
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
        None
    }

    fn validate_patch_apply_output_preflight(
        &self,
        args: &PatchApplyCommand,
        bundle_resolution: Option<&BundleApplyResolution>,
        original_input: &Path,
        local_bundle: Option<&Path>,
    ) -> Option<AppRunOutcome> {
        // Bundle-driven runs retain their existing output requirement. DCP
        // rebuilds a disc sheet and also needs an explicit destination; plain
        // file applies can infer one after the ROM leaf is selected.
        let requires_explicit_output = bundle_resolution.is_some()
            || args.patches.iter().any(|patch| Self::is_dcp_patch(patch));
        if args.output.is_none() && requires_explicit_output {
            let thread_execution = self.context(args.threads).single_thread_execution();
            return Some(
                self.finish(
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
                ),
            );
        }
        let output = args.output.as_deref()?;
        let message = Self::patch_apply_output_alias_message(
            &args.input,
            &args.patches,
            original_input,
            local_bundle,
            output,
        )?;
        let thread_execution = self.context(args.threads).single_thread_execution();
        Some(self.finish(
            "patch-apply",
            OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                message,
                thread_execution,
            ),
        ))
    }

    pub(super) fn validate_patch_apply_compression_plan(
        &self,
        output: &Path,
        extension_source: &Path,
        options: &PatchApplyCompressionOptions,
    ) -> Result<()> {
        if !options.enabled {
            return Ok(());
        }
        self.resolve_patch_apply_compression_plan(output, extension_source, options)
            .map(|_| ())
    }

    fn patch_apply_output_alias_message(
        input: &Path,
        patches: &[PathBuf],
        original_input: &Path,
        local_bundle: Option<&Path>,
        output: &Path,
    ) -> Option<String> {
        if paths_refer_to_same_file(original_input, output)
            || paths_refer_to_same_file(input, output)
        {
            return Some(
                "patch apply input and output resolve to the same file; choose a different --output path"
                    .to_string(),
            );
        }
        if let Some(patch) = patches
            .iter()
            .find(|patch| paths_refer_to_same_file(patch, output))
        {
            return Some(format!(
                "patch apply output and patch file `{}` resolve to the same file; choose a different --output path",
                patch.display()
            ));
        }
        local_bundle
            .filter(|bundle| paths_refer_to_same_file(bundle, output))
            .map(|bundle| {
                format!(
                    "patch apply output and bundle source `{}` resolve to the same file; choose a different --output path",
                    bundle.display()
                )
            })
    }

    fn resolve_patch_apply_output_path(
        &self,
        output: Option<PathBuf>,
        input: &Path,
        resolved_input: &Path,
        no_compress: bool,
        compress_format: Option<&str>,
    ) -> Result<(PathBuf, bool)> {
        let output_was_inferred = output.is_none();
        let mut output = match output {
            Some(output) => output,
            None => Self::default_patch_apply_output_path(input, resolved_input)?,
        };
        if !output_was_inferred || no_compress {
            return Ok((output, output_was_inferred));
        }
        let Some(compress_format) = compress_format else {
            return Ok((output, output_was_inferred));
        };
        let handler = self
            .containers
            .find_by_name(compress_format)
            .ok_or_else(|| {
                RomWeaverError::Validation("requested output format is not registered".to_string())
            })?;
        if handler.descriptor().extensions.is_empty() {
            return Err(RomWeaverError::Validation(format!(
                "output format `{compress_format}` has no usable file extension"
            )));
        }
        output = Self::default_patch_apply_output_path_for_format(
            input,
            resolved_input,
            handler.descriptor().extensions,
        )?;
        Ok((output, output_was_inferred))
    }

    /// Pick a user-visible raw-ROM destination when a plain file apply omitted
    /// `--output`. The candidate lives beside the original input and advances
    /// with a numeric suffix instead of replacing an existing path.
    pub(super) fn default_patch_apply_output_path(
        input: &Path,
        extension_source: &Path,
    ) -> Result<PathBuf> {
        let extension = extension_source
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "cannot infer a patch output name because the selected ROM leaf has no file extension; pass --output"
                        .to_string(),
                )
            })?;
        Self::default_patch_apply_output_path_for_extension(input, extension)
    }

    fn default_patch_apply_output_path_for_extension(
        input: &Path,
        extension: &str,
    ) -> Result<PathBuf> {
        let extension = extension.trim_start_matches('.');
        if extension.is_empty() {
            return Err(RomWeaverError::Validation(
                "cannot infer a patch output name because the selected format has no file extension"
                    .to_string(),
            ));
        }
        let parent = input.parent().unwrap_or_else(|| Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("rom");
        let base_name = format!("{stem}-patched.{extension}");
        let candidate = parent.join(&base_name);
        if !path_is_occupied(&candidate)? {
            trace!(output = %candidate.display(), "inferred patch apply output path");
            return Ok(candidate);
        }

        let mut suffix = 1u64;
        loop {
            let candidate = parent.join(format!("{stem}-patched-{suffix}.{extension}"));
            if !path_is_occupied(&candidate)? {
                trace!(output = %candidate.display(), suffix, "inferred collision-safe patch apply output path");
                return Ok(candidate);
            }
            suffix = suffix.checked_add(1).ok_or_else(|| {
                RomWeaverError::Validation(
                    "could not find an unused inferred patch output path".to_string(),
                )
            })?;
        }
    }

    fn default_patch_apply_output_path_for_format(
        input: &Path,
        extension_source: &Path,
        extensions: &[&str],
    ) -> Result<PathBuf> {
        let parent = input.parent().unwrap_or_else(|| Path::new("."));
        let stem = input
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("rom");
        let base = parent.join(format!("{stem}-patched"));
        let (candidate, _) =
            Self::append_output_extension_if_missing(&base, extensions, Some(extension_source));
        let extension = candidate
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "cannot infer a patch output name because the selected format has no file extension"
                        .to_string(),
                )
            })?;
        Self::default_patch_apply_output_path_for_extension(input, extension)
    }

    fn ensure_inferred_output_available(
        output_was_inferred: bool,
        output: &mut PathBuf,
        input: &Path,
    ) -> Result<()> {
        if !output_was_inferred {
            return Ok(());
        }
        if !path_is_occupied(output)? {
            return Ok(());
        }
        let extension = output
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "inferred patch output path became occupied and has no file extension"
                        .to_string(),
                )
            })?;
        *output = Self::default_patch_apply_output_path_for_extension(input, extension)?;
        Ok(())
    }

    fn inferred_output_collision_report(
        output_was_inferred: bool,
        output: &mut PathBuf,
        input: &Path,
        thread_execution: Option<ThreadExecution>,
    ) -> Option<OperationReport> {
        Self::ensure_inferred_output_available(output_was_inferred, output, input)
            .err()
            .map(|error| {
                OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    error.to_string(),
                    thread_execution,
                )
            })
    }

    pub(super) fn publish_inferred_patch_apply_output(
        source: &Path,
        destination: &mut PathBuf,
        input: &Path,
    ) -> Result<()> {
        let extension = destination
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                RomWeaverError::Validation(
                    "inferred patch output path has no file extension".to_string(),
                )
            })?;
        loop {
            match Self::copy_to_new_output_file(source, destination) {
                Ok(()) => return Ok(()),
                Err(RomWeaverError::Io(error)) if error.kind() == io::ErrorKind::AlreadyExists => {
                    *destination =
                        Self::default_patch_apply_output_path_for_extension(input, &extension)?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn publish_inferred_patch_apply_output_if_needed(
        output_was_inferred: bool,
        status: OperationStatus,
        source: &Path,
        destination: &mut PathBuf,
        input: &Path,
    ) -> Result<()> {
        if !output_was_inferred || status != OperationStatus::Succeeded {
            return Ok(());
        }
        Self::publish_inferred_patch_apply_output(source, destination, input)
    }

    fn copy_file_create_new(source: &Path, destination: &Path) -> io::Result<()> {
        let mut source_file = File::open(source)?;
        let mut destination_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let copy_result = (|| {
            io::copy(&mut source_file, &mut destination_file)?;
            destination_file.sync_all()
        })();
        drop(destination_file);
        if let Err(error) = copy_result {
            let _ = fs::remove_file(destination);
            return Err(error);
        }
        Ok(())
    }

    #[cfg(not(target_family = "wasm"))]
    pub(super) fn install_staged_no_overwrite_with<F>(
        staged_path: &Path,
        destination_path: &Path,
        hard_link: F,
    ) -> io::Result<()>
    where
        F: FnOnce(&Path, &Path) -> io::Result<()>,
    {
        match hard_link(staged_path, destination_path) {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::NotFound
                ) =>
            {
                Err(error)
            }
            Err(_) => Self::copy_file_create_new(staged_path, destination_path),
        }
    }

    #[cfg(not(target_family = "wasm"))]
    fn install_staged_no_overwrite(staged_path: &Path, destination_path: &Path) -> io::Result<()> {
        Self::install_staged_no_overwrite_with(
            staged_path,
            destination_path,
            |source, destination| fs::hard_link(source, destination),
        )
    }

    #[cfg(target_family = "wasm")]
    fn install_staged_no_overwrite(staged_path: &Path, destination_path: &Path) -> io::Result<()> {
        Self::copy_file_create_new(staged_path, destination_path)
    }

    fn copy_to_new_output_file(source: &Path, destination: &Path) -> Result<()> {
        let mut source_file = File::open(source)?;
        let (staged_path, mut staged_file) = loop {
            let counter =
                INFERRED_PUBLISH_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let file_name = destination
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("output");
            let staged_path = destination
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(format!(
                    ".{file_name}.rom-weaver-stage-{}-{counter}",
                    Self::runtime_process_id()
                ));
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged_path)
            {
                Ok(file) => break (staged_path, file),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(RomWeaverError::Io(error)),
            }
        };
        let publish_result = (|| -> io::Result<()> {
            io::copy(&mut source_file, &mut staged_file)?;
            staged_file.sync_all()?;
            drop(staged_file);
            Self::install_staged_no_overwrite(&staged_path, destination)
        })();
        let cleanup_result = fs::remove_file(&staged_path);
        if let Err(error) = cleanup_result
            && error.kind() != io::ErrorKind::NotFound
        {
            if publish_result.is_ok() {
                warn!(
                    stage = %staged_path.display(),
                    "published inferred patch output but could not remove private stage"
                );
                return Ok(());
            }
            return Err(RomWeaverError::Io(error));
        }
        publish_result.map_err(RomWeaverError::Io)
    }

    fn compress_patch_apply_output(
        &self,
        inputs: PatchApplyCompressionInputs<'_>,
    ) -> Option<OperationReport> {
        let PatchApplyCompressionInputs {
            report,
            compression_options,
            output,
            output_was_inferred,
            resolved_input,
            is_disc,
            raw_ready_output,
            disc_track_overrides,
            context,
            temp_paths,
            terminal_output_path,
            terminal_output_source,
        } = inputs;
        if report.status != OperationStatus::Succeeded || !compression_options.enabled {
            return None;
        }
        let compression_plan = match self.resolve_patch_apply_compression_plan(
            output,
            resolved_input,
            compression_options,
        ) {
            Ok(plan) => plan,
            Err(error) => {
                return Some(OperationReport::failed(
                    OperationFamily::Patch,
                    report.format.clone(),
                    "compress",
                    error.to_string(),
                    context.single_thread_execution(),
                ));
            }
        };
        let final_output_path = compression_plan.output_path.clone();
        let mut compression_plan = compression_plan;
        if output_was_inferred {
            let extension = final_output_path
                .extension()
                .and_then(|value| value.to_str());
            let staged_output = context
                .temp_paths()
                .next_path("patch-apply-output-compressed", extension);
            temp_paths.push(staged_output.clone());
            compression_plan.output_path = staged_output;
        }
        // Disc inputs feed the original sheet to the compressor. Plain inputs
        // stage the payload under an archive-appropriate entry name.
        let archive_input = if is_disc {
            raw_ready_output.to_path_buf()
        } else {
            match Self::stage_patch_apply_archive_input(raw_ready_output, output, resolved_input) {
                Ok(path) => path,
                Err(error) => {
                    return Some(OperationReport::failed(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        error.to_string(),
                        context.single_thread_execution(),
                    ));
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
            disc_track_overrides,
            running_label,
            context,
        ) {
            Ok(result) => result,
            Err(error) => {
                return Some(OperationReport::failed(
                    OperationFamily::Patch,
                    report.format.clone(),
                    "compress",
                    error.to_string(),
                    context.single_thread_execution(),
                ));
            }
        };
        if compress_report.status != OperationStatus::Succeeded {
            return Some(OperationReport::failed(
                OperationFamily::Patch,
                report.format.clone(),
                "compress",
                format!("patch output compression failed: {}", compress_report.label),
                compress_report.thread_execution,
            ));
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
            final_output_path.display(),
            compression_plan.note,
            extension_note,
            warning_note
        );
        if output_was_inferred {
            *terminal_output_source = compression_plan.output_path;
        }
        *terminal_output_path = final_output_path;
        None
    }

    fn prepare_patch_apply_chain(
        &self,
        inputs: PatchApplyPrepareChainInputs<'_>,
    ) -> std::result::Result<PatchApplyPreparedChain, Box<OperationReport>> {
        let PatchApplyPrepareChainInputs {
            resolved_patches,
            resolved_input,
            is_disc,
            has_codes,
            patch_header,
            auto_evidence_available,
            n64_byte_order,
            expected_input_checksums,
            cached_input_checksums,
            expected_input_size,
            repair_checksum,
            context,
            temp_paths,
        } = inputs;
        let chain_header_modes = if is_disc || has_codes {
            vec![PatchApplyHeaderMode::Keep; resolved_patches.len()]
        } else {
            (0..resolved_patches.len())
                .map(|index| {
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
                })
                .collect()
        };
        let chain_n64_modes = (0..resolved_patches.len())
            .map(|index| {
                n64_byte_order
                    .get(index)
                    .or_else(|| n64_byte_order.last())
                    .copied()
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();
        let first_patch = resolved_patches
            .first()
            .map(|(_, resolved)| resolved.as_path());
        let (strip_header, inferred_basis_note) =
            match chain_header_modes.first().copied().unwrap_or_default() {
                PatchApplyHeaderMode::Strip => (true, None),
                PatchApplyHeaderMode::Keep => (false, None),
                PatchApplyHeaderMode::Auto => self.auto_header_strip_decision(
                    resolved_input,
                    first_patch,
                    expected_input_checksums,
                    cached_input_checksums,
                    context,
                    temp_paths,
                ),
            };
        let PreparedApplyInput {
            apply_input,
            stripped_header,
            stripped_header_match,
            n64_order,
            n64_order_note,
        } = self
            .prepare_patch_apply_input(PreparePatchApplyInputInputs {
                resolved_input,
                strip_header,
                n64_byte_order: chain_n64_modes.first().copied().unwrap_or_default(),
                inference: if auto_evidence_available {
                    N64AutoInference::Structural
                } else {
                    N64AutoInference::ChecksumOnly
                },
                first_patch,
                expected_crc32: expected_input_checksums.get("crc32").map(String::as_str),
                repair_checksum,
                context,
                temp_paths,
            })
            .map_err(|error| {
                Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "compat",
                    error.to_string(),
                    context.single_thread_execution(),
                ))
            })?;

        // An inferred header basis or byte order changes output bytes on
        // evidence rather than proof, so both are always reported.
        let mut checksum_verification_labels = Vec::from_iter(inferred_basis_note);
        checksum_verification_labels.extend(n64_order_note);
        if let Some(expected_size) = expected_input_size {
            let label = Self::validate_patch_input_size(&apply_input, Some(expected_size), None)
                .map_err(|error| {
                    Box::new(OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        context.single_thread_execution(),
                    ))
                })?;
            checksum_verification_labels.push(label);
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
            let transformed_checksum_hints = BTreeMap::new();
            let effective_checksum_hints = if apply_input == resolved_input {
                cached_input_checksums
            } else {
                &transformed_checksum_hints
            };
            let label = Self::validate_patch_apply_expected_checksums(
                &apply_input,
                expected_input_checksums,
                effective_checksum_hints,
                "input",
                context,
            )
            .map_err(|error| {
                Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    error.to_string(),
                    context.single_thread_execution(),
                ))
            })?;
            checksum_verification_labels.push(label);
        }

        let header_state = ChainHeaderState {
            headerless: stripped_header_match.is_some(),
            stripped_header,
            stripped_header_match,
        };
        Ok(PatchApplyPreparedChain {
            chain_header_modes,
            chain_n64_modes,
            checksum_verification_labels,
            apply_input,
            header_state,
            n64_order,
        })
    }

    fn resolve_patch_apply_disc(
        &self,
        inputs: PatchApplyDiscInputs<'_>,
    ) -> std::result::Result<Option<DiscContext>, Box<OperationReport>> {
        let patch_source_crc32 = if inputs.ignore_checksum_validation {
            None
        } else {
            inputs
                .patches
                .first()
                .and_then(|patch| self.patch_source_crc32_for_auto_target(patch, inputs.context))
        };
        let disc = self
            .build_disc_context(
                inputs.input,
                inputs.target,
                patch_source_crc32.as_deref(),
                inputs.context,
            )
            .map_err(|error| {
                Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    None,
                    "prepare",
                    error.to_string(),
                    inputs.context.single_thread_execution(),
                ))
            })?;
        if disc.is_none() && inputs.target.is_some() {
            return Err(Box::new(OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                "--target requires a disc-sheet (.cue/.gdi) input",
                inputs.context.single_thread_execution(),
            )));
        }
        if disc.is_some()
            && (inputs.any_explicit_strip
                || inputs.output_header.is_some()
                || inputs.repair_checksum
                || inputs.any_explicit_n64_transform)
        {
            return Err(Box::new(OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                "disc patch apply (.cue/.gdi input) cannot be combined with --patch-header strip, --output-header, --repair-checksum, or --n64-byte-order",
                inputs.context.single_thread_execution(),
            )));
        }
        // A disc reassembles into multiple track files (or a CHD), not a single
        // checksummable artifact, so --expect-out could never reflect the
        // patched disc; reject rather than fail validate misleadingly.
        if disc.is_some() && inputs.has_expected_output_checksums {
            return Err(Box::new(OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                "disc patch apply (.cue/.gdi input) cannot be combined with --expect-out; the reassembled disc is emitted as multiple track files (or a CHD), not a single checksummable output",
                inputs.context.single_thread_execution(),
            )));
        }
        Ok(disc)
    }

    fn resolve_patch_apply_output_header(
        state: &ChainHeaderState,
        output_header_mode: PatchApplyOutputHeaderMode,
        output_header: Option<PatchApplyOutputHeaderMode>,
        is_disc: bool,
    ) -> (bool, bool) {
        // On a headerless final state `--output-header` decides whether the
        // stripped header returns: auto re-adds emulator-required headers
        // (iNES/fwNES/LNX/A78) and NSRT-signed copier headers (real dump
        // metadata, matching RUP's normalization) but drops junk copier
        // headers (SNES/PCE/Game Doctor). Explicit strip removes a
        // still-present header during finalize. Chains re-evaluate after the
        // loop; they always stage, so the staging decision below holds.
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
    }

    fn decorate_patch_apply_report(
        &self,
        report: &mut OperationReport,
        checksum_verification_labels: &mut Vec<String>,
        decoration: PatchApplyReportDecoration<'_>,
    ) -> std::result::Result<(), Box<OperationReport>> {
        if decoration.patch_count > 1 {
            report.label = format!(
                "applied {} patches sequentially ({}); {}",
                decoration.patch_count,
                decoration.applied_formats.join(" -> "),
                report.label
            );
        }
        if let Some(header_match) = decoration.header_state.stripped_header_match.as_ref() {
            report.label = format!(
                "{}; input header stripped ({} bytes, {})",
                report.label,
                header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES),
                header_match.profile_name()
            );
        }
        if let Some(note) = decoration.extension_swap_note {
            report.label = format!("{}; {note}", report.label);
        }
        if decoration.n64_order.is_some() {
            let modes = decoration
                .chain_n64_modes
                .iter()
                .map(|mode| mode.id())
                .collect::<Vec<_>>()
                .join(",");
            report.label = format!("{}; n64_byte_order={modes}", report.label);
        }
        if decoration.extracted_archives > 0 {
            report.label = format!(
                "{}; patch apply input source resolved via {} container extract step(s)",
                report.label, decoration.extracted_archives
            );
        }
        if !decoration.extracted_patch_notes.is_empty() {
            report.label = format!(
                "{}; {}",
                report.label,
                decoration.extracted_patch_notes.join("; ")
            );
        }
        if report.status == OperationStatus::Succeeded
            && !decoration.expected_output_checksums.is_empty()
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
                    decoration.expected_output_checksums.len()
                ),
                None,
                decoration.context.single_thread_execution(),
            );
            let label = Self::validate_patch_apply_expected_checksums(
                decoration.raw_ready_output,
                decoration.expected_output_checksums,
                &BTreeMap::new(),
                "output",
                decoration.context,
            )
            .map_err(|error| {
                Box::new(OperationReport::failed(
                    OperationFamily::Patch,
                    report.format.clone(),
                    "validate",
                    error.to_string(),
                    decoration.context.single_thread_execution(),
                ))
            })?;
            checksum_verification_labels.push(label);
        }
        if !checksum_verification_labels.is_empty() {
            report.label = format!(
                "{}; {}",
                report.label,
                checksum_verification_labels.join("; ")
            );
        }
        Ok(())
    }

    fn patch_apply_staged_output(
        output: &Path,
        resolved_input: &Path,
        output_was_inferred: bool,
        needs_staged_output: bool,
        compression_enabled: bool,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<PathBuf> {
        if output_was_inferred {
            return Self::patch_apply_raw_output_path(
                output,
                resolved_input,
                context,
                "patch-apply-output-inferred",
                temp_paths,
            );
        }
        if !needs_staged_output {
            return Ok(output.to_path_buf());
        }
        if compression_enabled {
            return Self::patch_apply_raw_output_path(
                output,
                resolved_input,
                context,
                "patch-apply-output-staged",
                temp_paths,
            );
        }
        let staged_path = context
            .temp_paths()
            .next_path("patch-apply-output-staged", Some("bin"));
        temp_paths.push(staged_path.clone());
        Ok(staged_path)
    }

    fn is_dcp_patch(path: &Path) -> bool {
        path.extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dcp"))
    }

    /// Decide `--patch-header auto` for the FIRST patch: strip the detected
    /// copier header only when a required input checksum - declared or embedded
    /// in the patch, under whatever algorithm the patch offers - proves the
    /// patch was authored against the headerless bytes
    /// ([`Self::checksum_basis_proof`]). A patch with no checksum to prove it
    /// falls back to structural evidence ([`Self::structural_strip_decision`]);
    /// any remaining doubt keeps the input as-is. Later chain steps decide per
    /// patch in [`Self::chain_header_transition`].
    fn auto_header_strip_decision(
        &self,
        resolved_input: &Path,
        first_resolved_patch: Option<&Path>,
        expected_input_checksums: &BTreeMap<String, String>,
        cached_input_checksums: &BTreeMap<String, String>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> (bool, Option<String>) {
        let Ok(header_match) = Self::detect_strippable_rom_header(resolved_input) else {
            trace!(
                input = %resolved_input.display(),
                "auto header: no strippable ROM header detected; keeping input as-is"
            );
            return (false, None);
        };
        let header_len = header_match.stripped_bytes().unwrap_or(ROM_HEADER_BYTES);
        match self.checksum_basis_proof(
            resolved_input,
            first_resolved_patch,
            header_len as u64,
            expected_input_checksums,
            cached_input_checksums,
            context,
        ) {
            ChecksumBasisProof::Proved(PatchBasis::Headerless) => {
                debug!(
                    header = ?header_match.header,
                    header_bytes = header_len,
                    "auto header: a required input checksum matches the headerless bytes; stripping header before apply and re-adding it after"
                );
                // Proof, not evidence: no report note.
                return (true, None);
            }
            ChecksumBasisProof::Proved(PatchBasis::Raw) => {
                trace!(
                    input = %resolved_input.display(),
                    "auto header: a required input checksum matches the raw (headered) input; keeping header"
                );
                return (false, None);
            }
            ChecksumBasisProof::Unproven => {
                trace!(
                    input = %resolved_input.display(),
                    "auto header: required checksums prove no basis; keeping header without guessing"
                );
                return (false, None);
            }
            ChecksumBasisProof::NoEvidence => {}
        }
        trace!(
            input = %resolved_input.display(),
            header = ?header_match.header,
            "auto header: strippable header present but no required input checksum; falling back to structural evidence"
        );
        let Some(patch) = first_resolved_patch else {
            return (false, None);
        };
        match self.structural_strip_decision(
            resolved_input,
            patch,
            header_match,
            context,
            temp_paths,
        ) {
            Some((strip, note)) => (strip, Some(note)),
            None => (false, None),
        }
    }

    /// Resolve the N64 order a patch should see. Auto acts on checksum proof
    /// first; a patch with no source CRC32 falls back to structural evidence
    /// ([`Self::structural_n64_order_decision`]) when the caller allows it, and
    /// any remaining doubt keeps the current bytes.
    pub(super) fn resolve_patch_n64_target(
        &self,
        request: N64TargetRequest<'_>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<Option<N64TargetResolution>> {
        let N64TargetRequest {
            input,
            patch,
            expected_crc32,
            mode,
            inference,
        } = request;
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
        let (target, inferred_note) = match mode {
            PatchN64ByteOrderMode::Keep => (source, None),
            PatchN64ByteOrderMode::Auto => {
                let required_crc32 = expected_crc32.map(str::to_owned).or_else(|| {
                    patch.and_then(|path| self.embedded_patch_source_crc32(path, context))
                });
                match required_crc32 {
                    // A checksum that matches no variant means the input is not
                    // the patch's base at all. Structural evidence assumes it is,
                    // so proof that says otherwise ends the decision.
                    Some(required) => (
                        Self::resolve_n64_byte_order_for_crc32(input, &required, context)?
                            .unwrap_or(source),
                        None,
                    ),
                    None => self.infer_patch_n64_target(
                        input, patch, source, inference, context, temp_paths,
                    ),
                }
            }
            concrete => (concrete.target().unwrap_or(source), None),
        };
        Ok(Some(N64TargetResolution {
            source,
            target,
            inferred_note,
        }))
    }

    /// The checksumless half of `auto`: structural evidence plus the note that
    /// reports it, or the current order and no note when nothing separates the
    /// three.
    fn infer_patch_n64_target(
        &self,
        input: &Path,
        patch: Option<&Path>,
        source: N64ByteOrder,
        inference: N64AutoInference,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> (N64ByteOrder, Option<String>) {
        let (N64AutoInference::Structural, Some(patch)) = (inference, patch) else {
            trace!(
                input = %input.display(),
                "auto n64: patch embeds no source checksum and structural evidence is off for this step; keeping the current order"
            );
            return (source, None);
        };
        let Some((target, reason)) =
            self.structural_n64_order_decision(input, patch, source, context, temp_paths)
        else {
            trace!(
                input = %input.display(),
                patch = %patch.display(),
                "auto n64: nothing separates the three orders; keeping the current one"
            );
            return (source, None);
        };
        let note = format!(
            "patch N64 byte order inferred as {} ({reason})",
            target.label()
        );
        (target, Some(note))
    }

    pub(super) fn transition_n64_byte_order(
        &self,
        plan: ChainN64TransitionPlan<'_>,
        resolved_patch: &Path,
        current_input: &mut PathBuf,
        state: &mut Option<N64ByteOrderTransform>,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<()> {
        context.cancel().check()?;
        let ChainN64TransitionPlan {
            mode,
            base_variant,
            base_representation,
        } = plan;
        let planned_order = base_representation.and_then(|value| value.n64_byte_order);
        let (source, target) = if let Some(planned) = planned_order {
            let source = if let Some(order) = *state {
                order.from
            } else {
                Self::detect_n64_byte_order_path(current_input)?.ok_or_else(|| {
                    RomWeaverError::Validation(format!(
                        "could not detect N64 byte order for `{}`",
                        current_input.display()
                    ))
                })?
            };
            let requested = match mode {
                PatchN64ByteOrderMode::Auto => planned,
                PatchN64ByteOrderMode::Keep => source,
                concrete => concrete.target().unwrap_or(source),
            };
            if mode != PatchN64ByteOrderMode::Auto && requested != planned {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("patch.base.n64_byte_order_mismatch")
                        .with_message(
                            "patch N64 byte-order mode conflicts with the base ROM representation selected by checksum planning",
                        )
                        .with_field("patch", resolved_patch.display().to_string())
                        .with_field("base_variant", base_variant.unwrap_or_default().to_string())
                        .with_field("n64_byte_order", mode.id()),
                ));
            }
            debug!(
                base_variant = base_variant.unwrap_or_default(),
                n64_byte_order = planned.id(),
                "chain N64: enforcing the planner-selected base representation"
            );
            (source, requested)
        } else {
            // Later chain steps stay on checksum proof. The inferred-order note
            // has no channel out of the apply loop, and a decision that changes
            // output bytes on evidence must never go unreported.
            let Some(resolved) = self.resolve_patch_n64_target(
                N64TargetRequest {
                    input: current_input,
                    patch: Some(resolved_patch),
                    expected_crc32: None,
                    mode,
                    inference: N64AutoInference::ChecksumOnly,
                },
                context,
                temp_paths,
            )?
            else {
                return Ok(());
            };
            (resolved.source, resolved.target)
        };
        let original = state.map(|order| order.to).unwrap_or(source);
        if source != target {
            let transformed_path = context
                .temp_paths()
                .next_path("patch-apply-chain-n64-byte-order", Some("bin"));
            temp_paths.push(transformed_path.clone());
            Self::rewrite_n64_byte_order(current_input, &transformed_path, source, target)?;
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
    /// force a compatible state; auto first honors a base representation proven
    /// by the shared planner, then falls back to this patch's embedded source
    /// CRC32. With no evidence, the current state carries over untouched.
    fn chain_header_transition(
        &self,
        plan: ChainHeaderTransitionPlan<'_>,
        resolved_patch: &Path,
        current_input: &mut PathBuf,
        state: &mut ChainHeaderState,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<()> {
        context.cancel().check()?;
        let ChainHeaderTransitionPlan {
            mode,
            base_variant,
            base_representation,
        } = plan;
        let planned_headerless = base_representation.and_then(|value| value.headerless);
        let requested_headerless = match mode {
            PatchApplyHeaderMode::Keep => Some(false),
            PatchApplyHeaderMode::Strip => Some(true),
            PatchApplyHeaderMode::Auto => None,
        };
        if let (Some(planned), Some(requested)) = (planned_headerless, requested_headerless)
            && planned != requested
        {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("patch.base.header_mode_mismatch")
                    .with_message(
                        "patch header mode conflicts with the base ROM representation selected by checksum planning",
                    )
                    .with_field("patch", resolved_patch.display().to_string())
                    .with_field("base_variant", base_variant.unwrap_or_default().to_string())
                    .with_field(
                        "patch_header",
                        match mode {
                            PatchApplyHeaderMode::Keep => "keep",
                            PatchApplyHeaderMode::Strip => "strip",
                            PatchApplyHeaderMode::Auto => "auto",
                        },
                    ),
            ));
        }
        let desired_headerless = match (mode, planned_headerless) {
            (PatchApplyHeaderMode::Auto, Some(planned)) => {
                debug!(
                    base_variant = base_variant.unwrap_or_default(),
                    headerless = planned,
                    "chain header: enforcing the planner-selected base representation"
                );
                planned
            }
            (PatchApplyHeaderMode::Keep, _) => false,
            (PatchApplyHeaderMode::Strip, _) => true,
            (PatchApplyHeaderMode::Auto, None) => {
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
            temp_paths.push(stripped_path.clone());
            let result = Self::strip_header_to_temp(current_input, &stripped_path)?;
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
            temp_paths.push(restored_path.clone());
            Self::copy_with_optional_header(current_input, &restored_path, Some(&header_bytes))?;
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

    /// Resolve each requested patch path through auto-extract, returning
    /// `(original, resolved)` pairs plus any container-extract notes. Shared by
    /// patch-apply and patch-validate, which differ only in the labels.
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
    /// Set when the byte order came from structural evidence rather than
    /// checksum proof. Always reported.
    n64_order_note: Option<String>,
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

struct ChainHeaderTransitionPlan<'a> {
    mode: PatchApplyHeaderMode,
    base_variant: Option<&'a str>,
    base_representation: Option<patch_plan::BaseRepresentation>,
}

pub(super) struct ChainN64TransitionPlan<'a> {
    pub(super) mode: PatchN64ByteOrderMode,
    pub(super) base_variant: Option<&'a str>,
    pub(super) base_representation: Option<patch_plan::BaseRepresentation>,
}

struct PatchApplyBaseInputs<'a> {
    prepared: &'a Path,
    original: &'a Path,
    prepared_headerless: Option<bool>,
    prepared_n64_byte_order: Option<N64ByteOrder>,
    original_n64_byte_order: Option<N64ByteOrder>,
}

struct PatchApplyBasisInputs<'a> {
    bundle_steps: Vec<patch_plan::PatchStepVerification>,
    shared: PatchBasisMode,
    cli: &'a [PatchBasisMode],
}

struct RunPatchApplyLoopInputs<'a> {
    resolved_patches: &'a [(PathBuf, PathBuf)],
    apply_input: PathBuf,
    staged_output: &'a Path,
    chain_header_modes: &'a [PatchApplyHeaderMode],
    step_verifications: &'a [patch_plan::PatchStepVerification],
    header_state: &'a mut ChainHeaderState,
    chain_n64_modes: &'a [PatchN64ByteOrderMode],
    n64_order: &'a mut Option<N64ByteOrderTransform>,
    probe_threads: &'a Option<ThreadExecution>,
    context: &'a OperationContext,
    temp_paths: &'a mut Vec<PathBuf>,
}

struct PreparePatchApplyInputInputs<'a> {
    resolved_input: &'a Path,
    strip_header: bool,
    n64_byte_order: PatchN64ByteOrderMode,
    inference: N64AutoInference,
    first_patch: Option<&'a Path>,
    expected_crc32: Option<&'a str>,
    repair_checksum: bool,
    context: &'a OperationContext,
    temp_paths: &'a mut Vec<PathBuf>,
}

/// What `--n64-byte-order auto` may act on for one step.
///
/// Only the first patch has a channel to report an inferred order in the
/// operation label, and cheat codes or an explicit byte-order transform pin
/// offsets to the bytes the user passed in. Everything else stays on checksum
/// proof.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum N64AutoInference {
    /// Checksum proof, then structural evidence.
    Structural,
    /// Checksum proof only.
    ChecksumOnly,
}

/// What to resolve an N64 byte-order target from.
pub(super) struct N64TargetRequest<'a> {
    pub(super) input: &'a Path,
    pub(super) patch: Option<&'a Path>,
    pub(super) expected_crc32: Option<&'a str>,
    pub(super) mode: PatchN64ByteOrderMode,
    pub(super) inference: N64AutoInference,
}

/// The order the input is in, the order the patch needs, and how that was
/// settled.
pub(super) struct N64TargetResolution {
    pub(super) source: N64ByteOrder,
    pub(super) target: N64ByteOrder,
    /// Set only when the target came from structural evidence rather than
    /// checksum proof, for the operation label.
    pub(super) inferred_note: Option<String>,
}

impl CliApp {
    /// Apply the resolved chain through temporary intermediates into
    /// `staged_output`. Errors carry the failing operation report.
    fn run_patch_apply_loop(
        &self,
        inputs: RunPatchApplyLoopInputs<'_>,
    ) -> std::result::Result<PatchApplyLoopOutcome, Box<OperationReport>> {
        let RunPatchApplyLoopInputs {
            resolved_patches,
            apply_input,
            staged_output,
            chain_header_modes,
            step_verifications,
            header_state,
            chain_n64_modes,
            n64_order,
            probe_threads,
            context,
            temp_paths,
        } = inputs;
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
            let step = step_verifications.get(index);

            // Later chain steps may need a different header state than the previous
            // patch left behind (explicit per-patch mode, or auto evidence from this
            // patch's embedded source checksum).
            if index > 0
                && let Err(error) = self.chain_header_transition(
                    ChainHeaderTransitionPlan {
                        mode: chain_header_modes.get(index).copied().unwrap_or_default(),
                        base_variant: step.and_then(|step| step.base_variant.as_deref()),
                        base_representation: step.and_then(|step| step.base_representation),
                    },
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
                    ChainN64TransitionPlan {
                        mode: chain_n64_modes.get(index).copied().unwrap_or_default(),
                        base_variant: step.and_then(|step| step.base_variant.as_deref()),
                        base_representation: step.and_then(|step| step.base_representation),
                    },
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

            let step_is_base = index > 0
                && step.and_then(|step| step.basis) == Some(patch_plan::PatchInputBasis::Base);
            let step_declares_base = step_is_base
                && step.and_then(|step| step.basis_source)
                    == Some(patch_plan::PatchBasisSource::Declared);
            // An unbased bundle input check still describes the real
            // intermediate even when embedded evidence independently infers
            // Base. Only an explicit Base declaration verifies once up front.
            if context.strict_patch_checksums()
                && !step_declares_base
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
            if let Some(selection) = step.and_then(|step| step.execution) {
                patch_context = patch_context.with_patch_endpoint_selection(selection);
            }
            if let Some(order) = n64_order.as_ref().map(|order| order.from).or_else(|| {
                step.and_then(|step| step.base_representation)
                    .and_then(|representation| representation.n64_byte_order)
            }) {
                patch_context = patch_context.with_patch_input_n64_byte_order(match order {
                    N64ByteOrder::BigEndian => PatchInputN64ByteOrder::BigEndian,
                    N64ByteOrder::LittleEndian => PatchInputN64ByteOrder::LittleEndian,
                    N64ByteOrder::ByteSwapped => PatchInputN64ByteOrder::ByteSwapped,
                });
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
            if report
                .details
                .as_ref()
                .and_then(|details| details.pointer("/patch/output_representation/n64_byte_order"))
                .and_then(Value::as_str)
                == Some("big-endian")
            {
                let original = n64_order
                    .as_ref()
                    .map_or(N64ByteOrder::BigEndian, |order| order.to);
                *n64_order = Some(N64ByteOrderTransform {
                    from: N64ByteOrder::BigEndian,
                    to: original,
                });
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

    /// Assemble apply's declarations, then use the same whole-file endpoint
    /// planner as `patch validate --plan` to resolve every step's basis.
    /// Declared base steps still verify against the base before the chain;
    /// ignore mode still resolves basis, representation, and execution but does
    /// not enforce declared or embedded checks.
    fn plan_apply_step_verifications(
        &self,
        resolved_patches: &[(PathBuf, PathBuf)],
        cheat_steps: usize,
        basis_inputs: PatchApplyBasisInputs<'_>,
        base_inputs: PatchApplyBaseInputs<'_>,
        context: &OperationContext,
    ) -> Result<Vec<patch_plan::PatchStepVerification>> {
        let PatchApplyBasisInputs {
            bundle_steps,
            shared,
            cli,
        } = basis_inputs;
        let original_representation = Self::base_representation(
            base_inputs.original,
            None,
            base_inputs.original_n64_byte_order,
        )?;
        let prepared_representation = Self::base_representation(
            base_inputs.prepared,
            base_inputs.prepared_headerless,
            base_inputs.prepared_n64_byte_order,
        )?;
        let endpoint_inputs = if base_inputs.prepared == base_inputs.original {
            vec![(base_inputs.prepared, "raw", prepared_representation)]
        } else {
            vec![
                (
                    base_inputs.prepared,
                    "prepared-raw",
                    prepared_representation,
                ),
                (base_inputs.original, "raw", original_representation),
            ]
        };
        let step_count = resolved_patches.len();
        let mut steps: Vec<patch_plan::PatchStepVerification> =
            vec![patch_plan::PatchStepVerification::default(); step_count];
        let user_count = step_count.saturating_sub(cheat_steps);
        // Declared sources align with the user-visible patch list; discovery
        // or archive expansion can change the resolved count, in which case
        // declarations cannot be attributed and only inference applies.
        let aligned = |declared_len: usize| declared_len == user_count;
        let mut bundle_steps_applied = false;
        if !bundle_steps.is_empty() && aligned(bundle_steps.len()) {
            for (user_index, bundle_step) in bundle_steps.into_iter().enumerate() {
                steps[cheat_steps + user_index] = bundle_step;
            }
            bundle_steps_applied = true;
        }
        if !bundle_steps_applied {
            for step in steps.iter_mut().skip(cheat_steps) {
                step.basis = shared.declared();
                step.basis_source = step.basis.map(|_| PatchBasisSource::Declared);
            }
        }
        if !cli.is_empty() {
            if !aligned(cli.len()) {
                return Err(RomWeaverError::Validation(format!(
                    "--patch-basis must be given once per --patch (or not at all); got {} value(s) for {user_count} patch(es)",
                    cli.len()
                )));
            }
            for (user_index, mode) in cli.iter().enumerate() {
                let step = &mut steps[cheat_steps + user_index];
                step.basis = mode.declared();
                step.basis_source = step.basis.map(|_| PatchBasisSource::Declared);
            }
        }
        if step_count <= 1 && context.strict_patch_checksums() {
            return Ok(steps);
        }

        let mut base_endpoint_matches = vec![Vec::new(); step_count];
        let plan_inputs: Vec<patch_plan::PlanPatchInput> = resolved_patches
            .iter()
            .enumerate()
            .map(|(index, (patch_path, resolved_patch_path))| {
                let handler = self.patches.probe(resolved_patch_path);
                let declared_basis = steps[index].basis;
                // Unbased bundle checks constrain inference and remain a
                // previous-step runtime gate; only explicit declarations may
                // use them as independent base evidence. Ignore mode retains
                // endpoint planning without turning declarations back into
                // validation gates.
                let declared_input = context
                    .strict_patch_checksums()
                    .then(|| steps[index].declared_input.clone())
                    .flatten()
                    .unwrap_or_default();
                let declared_output = context
                    .strict_patch_checksums()
                    .then(|| steps[index].declared_output.clone())
                    .flatten()
                    .unwrap_or_default();
                let mut plan_input = Self::build_plan_patch_input(
                    patch_path,
                    resolved_patch_path,
                    handler.as_deref(),
                    declared_basis,
                    declared_input,
                    declared_output,
                    context,
                );
                plan_input.declared_input_infers_base = steps[index].basis.is_some();
                if patch_plan::should_resolve_base_endpoints(index, plan_input.declared_basis)
                    && let Some(handler) = handler.as_deref()
                {
                    plan_input.base_executions = match Self::resolve_base_endpoint_selections(
                        handler,
                        resolved_patch_path,
                        &endpoint_inputs,
                        context,
                    ) {
                        Ok(matches) => {
                            let selections =
                                matches.iter().map(|matched| matched.selection).collect();
                            base_endpoint_matches[index] = matches;
                            selections
                        }
                        Err(RomWeaverError::Cancelled) => {
                            return Err(RomWeaverError::Cancelled);
                        }
                        Err(error) => {
                            debug!(
                                %error,
                                patch = %patch_path.display(),
                                "handler-normalized base endpoint evidence unavailable"
                            );
                            Vec::new()
                        }
                    };
                }
                Ok(plan_input)
            })
            .collect::<Result<Vec<_>>>()?;
        let base_variants = Self::plan_apply_base_variants(
            base_inputs.original,
            original_representation,
            base_inputs.prepared,
            prepared_representation,
            &plan_inputs,
            context,
        )?;
        let resolved = patch_plan::resolve_verification_plan(&base_variants, &plan_inputs);

        for (index, verdict) in resolved.per_patch.iter().enumerate() {
            if verdict.basis == patch_plan::PatchInputBasis::Base
                && plan_inputs[index].base_executions.len() > 1
            {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("patch.base.endpoint_ambiguous")
                        .with_message(
                            "patch input matches multiple reversible endpoints against the base ROM",
                        )
                        .with_field("patch_index", index as u64)
                        .with_field(
                            "patch",
                            resolved_patches[index].0.display().to_string(),
                        )
                        .with_field(
                            "matches",
                            plan_inputs[index].base_executions.len() as u64,
                        ),
                ));
            }
        }

        for index in 1..step_count {
            let (patch_path, _) = &resolved_patches[index];
            let required_base_failed = resolved.per_patch[index].input_verdict
                == patch_plan::PatchInputVerdict::Failed
                || (!plan_inputs[index].declared_input.is_empty()
                    && patch_plan::base_state_verdict(
                        &plan_inputs[index].declared_input,
                        &base_variants,
                    ) == patch_plan::PatchInputVerdict::Failed);
            if context.strict_patch_checksums()
                && steps[index].basis == Some(patch_plan::PatchInputBasis::Base)
                && steps[index].basis_source == Some(patch_plan::PatchBasisSource::Declared)
                && required_base_failed
            {
                return Err(RomWeaverError::ValidationCode(
                    ValidationCodeError::new("patch.base.input_mismatch")
                        .with_message(
                            "patch declares basis base but its input checks do not match the ROM",
                        )
                        .with_field("patch_index", index as u64)
                        .with_field("patch", patch_path.display().to_string())
                        .with_field("detail", resolved.per_patch[index].message.clone()),
                ));
            }
            if resolved.per_patch[index].basis_source == patch_plan::PatchBasisSource::InferredBase
            {
                debug!(
                    index,
                    patch = %patch_path.display(),
                    "patch input checks match the base ROM; resolved basis to base"
                );
            }
        }
        let mut steps = patch_plan::apply_resolved_bases(&resolved, &base_variants, steps);
        for ((step, verdict), endpoint_matches) in steps
            .iter_mut()
            .zip(&resolved.per_patch)
            .zip(&base_endpoint_matches)
        {
            if step.base_representation.is_none()
                && verdict.basis == patch_plan::PatchInputBasis::Base
                && let Some(selection) = verdict.execution
                && let Some(matched) = endpoint_matches
                    .iter()
                    .find(|matched| matched.selection == selection)
            {
                step.base_variant = Some(matched.variant.clone());
                step.base_representation = Some(matched.representation);
            }
        }
        Ok(steps)
    }

    /// Compress output for both plain apply and `.dcp` disc rebuilds, returning
    /// the create report and codec label.
    ///
    /// Caller-specific labels and report metadata stay outside. A missing
    /// handler preserves the validation error expected by callers, though the
    /// compression plan should already have validated it.
    /// Resolve the plan `--dry-run` reports. Only the dry run resolves the
    /// compression plan up front; doing it on the normal path would surface its
    /// errors ahead of the patch checks that run first today.
    /// Resolve the compression plan and re-check the resolved output path: the
    /// early guard checked the path the user named, and an appended container
    /// extension makes the real output a different file.
    fn resolve_guarded_patch_apply_compression_plan(
        &self,
        output: &Path,
        resolved_input: &Path,
        compression_options: &PatchApplyCompressionOptions,
        force: bool,
        report_format: Option<String>,
        context: &OperationContext,
    ) -> std::result::Result<PatchApplyCompressionPlan, Box<OperationReport>> {
        let fail = |error: RomWeaverError| {
            Box::new(OperationReport::failed(
                OperationFamily::Patch,
                report_format.clone(),
                "compress",
                error.to_string(),
                context.single_thread_execution(),
            ))
        };
        let plan = self
            .resolve_patch_apply_compression_plan(output, resolved_input, compression_options)
            .map_err(&fail)?;
        if plan.extension_appended {
            ensure_output_available(&plan.output_path, force).map_err(&fail)?;
        }
        Ok(plan)
    }

    fn patch_apply_dry_run(
        &self,
        input: &Path,
        patches: &[PathBuf],
        output: &Path,
        compression_options: &PatchApplyCompressionOptions,
        thread_execution: Option<ThreadExecution>,
    ) -> OperationReport {
        let planned_output = if compression_options.enabled {
            match self.resolve_patch_apply_compression_plan(output, input, compression_options) {
                Ok(plan) => Some(plan),
                Err(error) => {
                    return OperationReport::failed(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error.to_string(),
                        thread_execution,
                    );
                }
            }
        } else {
            None
        };
        let planned_output_path = planned_output
            .as_ref()
            .map(|plan| plan.output_path.clone())
            .unwrap_or_else(|| output.to_path_buf());
        Self::patch_apply_dry_run_report(
            input,
            patches,
            &planned_output_path,
            planned_output.as_ref(),
            thread_execution,
        )
    }

    /// The `--dry-run` answer for `patch apply`: the resolved inputs, patch
    /// chain, output path, and compression choices. Nothing is written.
    fn patch_apply_dry_run_report(
        input: &Path,
        patches: &[PathBuf],
        output: &Path,
        compression: Option<&PatchApplyCompressionPlan>,
        thread_execution: Option<ThreadExecution>,
    ) -> OperationReport {
        let mut details = Map::new();
        details.insert("dry_run".to_string(), json!(true));
        details.insert("input".to_string(), json!(input.display().to_string()));
        details.insert(
            "patches".to_string(),
            json!(
                patches
                    .iter()
                    .map(|patch| patch.display().to_string())
                    .collect::<Vec<_>>()
            ),
        );
        details.insert("output".to_string(), json!(output.display().to_string()));
        match compression {
            Some(plan) => {
                details.insert("format".to_string(), json!(plan.format));
                details.insert("codec".to_string(), json!(plan.codec));
                details.insert("level".to_string(), json!(plan.level));
            }
            None => {
                details.insert("format".to_string(), json!("raw"));
            }
        }
        let format_label = compression
            .map(|plan| plan.format.clone())
            .unwrap_or_else(|| "raw (no compression)".to_string());
        let label = format!(
            "dry run: would apply {} patch(es) to `{}` and write `{}` as {format_label}; nothing written",
            patches.len(),
            input.display(),
            output.display()
        );
        let mut report = OperationReport::succeeded(
            OperationFamily::Patch,
            compression.map(|plan| plan.format.clone()),
            "plan",
            label,
            None,
            thread_execution,
        );
        report.details = Some(Value::Object(details));
        report
    }

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
                unregistered_output_format_message(),
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
        compress_level: Option<CompressionLevelProfile>,
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
    fn prepare_patch_apply_input(
        &self,
        inputs: PreparePatchApplyInputInputs<'_>,
    ) -> Result<PreparedApplyInput> {
        let PreparePatchApplyInputInputs {
            resolved_input,
            strip_header,
            n64_byte_order,
            inference,
            first_patch,
            expected_crc32,
            repair_checksum,
            context,
            temp_paths,
        } = inputs;
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
            let result = Self::strip_header_to_temp(resolved_input, &stripped_path)?;
            stripped_header = Some(result.header_bytes);
            stripped_header_match = result.matched_header;
            temp_paths.push(stripped_path.clone());
            stripped_path
        } else {
            resolved_input.to_path_buf()
        };
        let resolved_n64 = self.resolve_patch_n64_target(
            N64TargetRequest {
                input: &apply_input,
                patch: first_patch,
                expected_crc32,
                mode: n64_byte_order,
                inference,
            },
            context,
            temp_paths,
        )?;
        let mut n64_order_note = None;
        let apply_input = match resolved_n64 {
            Some(N64TargetResolution {
                source: source_order,
                target: target_order,
                inferred_note,
            }) => {
                n64_order_note = inferred_note;
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
            n64_order_note,
        })
    }
}
