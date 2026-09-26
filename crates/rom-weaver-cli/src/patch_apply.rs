use super::*;

use super::bundle_apply::BundleApplyResolution;
use super::bundle_parse::{bundle_validation, normalized_member_path};
use super::cheats_apply::CheatIpsRequest;
use super::patch_apply_disc::DiscContext;
use super::patch_basis_decision::ChecksumBasisProof;
use super::patch_commands::{
    DiscoveredPatchApplySidecars, PatchApplyProgressSink, PatchApplyProgressTracker,
    patch_progress_segment_start,
};

use rom_weaver_patches::basis_probe::PatchBasis;

mod chain_loop;
mod run;
mod step_plan;

pub(super) fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    left == right
        || matches!(
            (fs::canonicalize(left), fs::canonicalize(right)),
            (Ok(left), Ok(right)) if left == right
        )
        || native_file_identity_matches(left, right)
}

#[cfg(test)]
mod cheat_ordering_tests {
    use std::sync::{Arc, Mutex};

    use assert_fs::TempDir;
    use rom_weaver_core::{ProgressEvent, ProgressSink};
    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct EventSink(Mutex<Vec<ProgressEvent>>);

    impl ProgressSink for EventSink {
        fn emit(&self, event: ProgressEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    #[test]
    fn database_cheat_compare_uses_the_post_patch_rom() {
        assert_database_cheat_compare_uses_the_post_patch_rom(false);
    }

    #[test]
    fn database_cheat_compare_keeps_target_lane_metadata_patch_aligned() {
        assert_database_cheat_compare_uses_the_post_patch_rom(true);
    }

    fn assert_database_cheat_compare_uses_the_post_patch_rom(with_target_lanes: bool) {
        let temp = TempDir::new().unwrap();
        let input = temp.path().join("game.nes");
        let patch = temp.path().join("change-compare.ips");
        let output = temp.path().join("output.nes");
        let mut rom = vec![0u8; 0x8000];
        rom[0x4000] = 0xff;
        fs::write(&input, rom).unwrap();
        fs::write(
            &patch,
            [
                b'P', b'A', b'T', b'C', b'H', 0x00, 0x40, 0x00, 0x00, 0x01, 0x00, b'E', b'O', b'F',
            ],
        )
        .unwrap();

        let mut command = json!({
            "input": input,
            "patches": [patch],
            "output": output,
            "no_compress": true,
            "cheat_records": [{
                "id": "compare-cheat",
                "system": "nes",
                "gameId": "synthetic",
                "description": "Compare cheat",
                "rawCode": "C00012FF",
                "codeKind": "pro-action-replay",
                "rawFields": { "code": "C00012FF" },
                "sourceFile": "fixture.cht",
                "sourceIndex": 0,
                "sourceRevision": "test"
            }]
        });
        if with_target_lanes {
            command["patches"] = json!([patch.clone(), patch]);
            command["patch_target"] = json!([{ "rom": true }, null]);
        }
        let args: PatchApplyCommand = serde_json::from_value(command).unwrap();
        let sink = Arc::new(EventSink::default());
        let app = CliApp::new(
            sink.clone(),
            Arc::new(rom_weaver_core::NoninteractivePrompter),
            false,
            false,
            false,
        );
        let outcome = app.run(Commands::Patch(PatchCommands::Apply(Box::new(args))));
        assert_eq!(outcome.status, OperationStatus::Failed);
        let labels = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.label.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(labels.contains("compare-cheat"), "{labels}");
        assert!(labels.contains("cheat_no_compare_match"), "{labels}");
    }

    fn patch_apply_json_outcome(value: serde_json::Value) -> (OperationStatus, String) {
        let args: PatchApplyCommand = serde_json::from_value(value).unwrap();
        let sink = Arc::new(EventSink::default());
        let app = CliApp::new(
            sink.clone(),
            Arc::new(rom_weaver_core::NoninteractivePrompter),
            false,
            false,
            false,
        );
        let outcome = app.run(Commands::Patch(PatchCommands::Apply(Box::new(args))));
        let labels = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.label.clone())
            .collect::<Vec<_>>()
            .join("\n");
        (outcome.status, labels)
    }

    fn write_patch_apply_selector_fixture(temp: &TempDir) -> (PathBuf, PathBuf) {
        let input = temp.path().join("game.nes");
        let patch = temp.path().join("change.ips");
        fs::write(&input, vec![0u8; 0x8000]).unwrap();
        fs::write(
            &patch,
            [
                b'P', b'A', b'T', b'C', b'H', 0x00, 0x00, 0x00, 0x00, 0x01, 0x01, b'E', b'O', b'F',
            ],
        )
        .unwrap();
        (input, patch)
    }

    #[test]
    fn direct_json_patch_selector_lengths_must_match_the_patch_list() {
        let temp = TempDir::new().unwrap();
        let (input, patch) = write_patch_apply_selector_fixture(&temp);
        let (status, labels) = patch_apply_json_outcome(serde_json::json!({
            "input": input,
            "patches": [patch.clone(), patch],
            "output": temp.path().join("output.nes"),
            "no_compress": true,
            "patch_input": [{ "rom": true }]
        }));

        assert_eq!(status, OperationStatus::Failed);
        assert!(
            labels.contains("bundle patch targets require one resolved file per selected patch"),
            "{labels}"
        );
    }

    #[test]
    fn direct_json_patch_id_lengths_must_match_the_patch_list() {
        let temp = TempDir::new().unwrap();
        let (input, patch) = write_patch_apply_selector_fixture(&temp);
        let (status, labels) = patch_apply_json_outcome(serde_json::json!({
            "input": input,
            "patches": [patch.clone(), patch],
            "output": temp.path().join("output.nes"),
            "no_compress": true,
            "patch_id": ["producer"]
        }));

        assert_eq!(status, OperationStatus::Failed);
        assert!(
            labels.contains("bundle patch targets require one resolved file per selected patch"),
            "{labels}"
        );
    }

    #[test]
    fn direct_json_duplicate_ids_are_validated_without_selectors() {
        let temp = TempDir::new().unwrap();
        let (input, patch) = write_patch_apply_selector_fixture(&temp);
        let (status, labels) = patch_apply_json_outcome(serde_json::json!({
            "input": input,
            "patches": [patch.clone(), patch],
            "output": temp.path().join("output.nes"),
            "no_compress": true,
            "patch_id": ["producer", "producer"]
        }));

        assert_eq!(status, OperationStatus::Failed);
        assert!(
            labels.contains("patch ID at index 1 must be unique and non-empty"),
            "{labels}"
        );
    }

    #[test]
    fn database_cheat_position_changes_actual_apply_order() {
        let temp = TempDir::new().unwrap();
        let input = temp.path().join("game.nes");
        let patch = temp.path().join("change-after-cheat.ips");
        let output = temp.path().join("output.nes");
        let mut rom = vec![0u8; 0x8000];
        rom[0x4000] = 0xff;
        fs::write(&input, rom).unwrap();
        fs::write(
            &patch,
            [
                b'P', b'A', b'T', b'C', b'H', 0x00, 0x40, 0x00, 0x00, 0x01, 0x00, b'E', b'O', b'F',
            ],
        )
        .unwrap();

        let args: PatchApplyCommand = serde_json::from_value(json!({
            "input": input,
            "patches": [patch],
            "output": output,
            "no_compress": true,
            "cheat_records": [{
                "id": "compare-cheat",
                "system": "nes",
                "gameId": "synthetic",
                "description": "Compare cheat",
                "rawCode": "C00012FF",
                "codeKind": "pro-action-replay",
                "rawFields": { "code": "C00012FF" },
                "sourceFile": "fixture.cht",
                "sourceIndex": 0,
                "sourceRevision": "test"
            }],
            "cheat_positions": [0]
        }))
        .unwrap();
        let app = CliApp::new(
            Arc::new(EventSink::default()),
            Arc::new(rom_weaver_core::NoninteractivePrompter),
            false,
            false,
            false,
        );
        let outcome = app.run(Commands::Patch(PatchCommands::Apply(Box::new(args))));

        assert_eq!(outcome.status, OperationStatus::Succeeded);
        assert_eq!(fs::read(output).unwrap()[0x4000], 0);
    }

    #[test]
    fn database_cheats_at_one_position_still_detect_write_conflicts() {
        let temp = TempDir::new().unwrap();
        let input = temp.path().join("game.nes");
        let output = temp.path().join("output.nes");
        fs::write(&input, vec![0xff; 0x8000]).unwrap();
        let record = |id: &str, code: &str| {
            json!({
                "id": id,
                "system": "nes",
                "gameId": "synthetic",
                "description": id,
                "rawCode": code,
                "codeKind": "pro-action-replay",
                "rawFields": { "code": code },
                "sourceFile": "fixture.cht",
                "sourceIndex": 0,
                "sourceRevision": "test"
            })
        };
        let args: PatchApplyCommand = serde_json::from_value(json!({
            "input": input,
            "output": output,
            "no_compress": true,
            "cheat_records": [record("first", "C00012FF"), record("second", "C00013FF")],
            "cheat_positions": [0, 0]
        }))
        .unwrap();
        let sink = Arc::new(EventSink::default());
        let app = CliApp::new(
            sink.clone(),
            Arc::new(rom_weaver_core::NoninteractivePrompter),
            false,
            false,
            false,
        );
        let outcome = app.run(Commands::Patch(PatchCommands::Apply(Box::new(args))));

        assert_eq!(outcome.status, OperationStatus::Failed);
        let labels = sink
            .0
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.label.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(labels.contains("cheat_write_conflict"), "{labels}");
    }
}

fn path_is_occupied(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(RomWeaverError::Io(error)),
    }
}

fn validate_patch_step_selectors(steps: &[PatchApplyStepMetadata]) -> Result<()> {
    let mut producers = BTreeSet::new();
    for (index, step) in steps.iter().enumerate() {
        for (kind, selector) in [("input", &step.input), ("target", &step.target)] {
            let Some(selector) = selector else {
                continue;
            };
            match selector {
                BundlePatchInput::Rom { rom, member } => {
                    if !rom {
                        return Err(RomWeaverError::Validation(format!(
                            "patch {kind} at index {index} has rom=false"
                        )));
                    }
                    if let Some(member) = member
                        && normalized_member_path(member, "patch member").is_err()
                    {
                        return Err(RomWeaverError::Validation(format!(
                            "patch {kind} at index {index} has an invalid member selector"
                        )));
                    }
                }
                BundlePatchInput::Patch { patch, member } => {
                    if patch.trim().is_empty() || !producers.contains(patch) {
                        return Err(RomWeaverError::Validation(format!(
                            "patch {kind} at index {index} must reference an earlier patch ID"
                        )));
                    }
                    if let Some(member) = member
                        && normalized_member_path(member, "patch member").is_err()
                    {
                        return Err(RomWeaverError::Validation(format!(
                            "patch {kind} at index {index} has an invalid member selector"
                        )));
                    }
                }
            }
        }
        if let Some(id) = &step.id
            && (id.trim().is_empty() || !producers.insert(id.clone()))
        {
            return Err(RomWeaverError::Validation(format!(
                "patch ID at index {index} must be unique and non-empty"
            )));
        }
    }
    Ok(())
}

fn validate_resolved_patch_apply_step_metadata(
    steps: &[PatchApplyStepMetadata],
    resolved_patch_count: usize,
    bundle_step_metadata_selected: bool,
    direct_has_step_selectors: bool,
    direct_selectors_align: bool,
    thread_execution: &Option<ThreadExecution>,
) -> std::result::Result<(), Box<OperationReport>> {
    let has_step_selectors = if bundle_step_metadata_selected {
        !steps.is_empty()
    } else {
        direct_has_step_selectors
    };
    if !has_step_selectors {
        return Ok(());
    }
    if steps.len() != resolved_patch_count
        || (!bundle_step_metadata_selected && !direct_selectors_align)
    {
        return Err(Box::new(OperationReport::failed(
            OperationFamily::Patch,
            None,
            "prepare",
            "bundle patch targets require one resolved file per selected patch",
            thread_execution.clone(),
        )));
    }
    validate_patch_step_selectors(steps).map_err(|error| {
        Box::new(OperationReport::failed_with_error(
            OperationFamily::Patch,
            None,
            "validate",
            error,
            thread_execution.clone(),
        ))
    })
}

/// Direct JSON/WASM selectors bypass bundle parsing, so normalize their member
/// keys before they become lane-map keys. Invalid values remain for the shared
/// validator to report with the command's normal error shape.
fn normalize_patch_step_member_selectors(selectors: &mut [Option<BundlePatchInput>]) {
    for selector in selectors.iter_mut().flatten() {
        let member = match selector {
            BundlePatchInput::Rom { member, .. } | BundlePatchInput::Patch { member, .. } => member,
        };
        if let Some(value) = member
            && let Ok(normalized) = normalized_member_path(value, "patch member")
        {
            *value = normalized;
        }
    }
}

struct DirectPatchStepSelectors {
    steps: Vec<PatchApplyStepMetadata>,
    has_selectors: bool,
    selectors_align: bool,
}

#[derive(Clone, Debug, Default)]
pub(super) struct PatchApplyStepMetadata {
    pub(super) input: Option<BundlePatchInput>,
    pub(super) target: Option<BundlePatchInput>,
    pub(super) id: Option<String>,
    pub(super) verification: Option<patch_plan::PatchStepVerification>,
    pub(super) cli_basis: Option<PatchBasisMode>,
    pub(super) header_mode: PatchApplyHeaderMode,
    pub(super) n64_byte_order_mode: PatchN64ByteOrderMode,
    pub(super) emit_header: Option<PatchApplyHeaderMode>,
    pub(super) emit_basis: Option<PatchBasisMode>,
}

#[derive(Clone, Debug)]
struct PatchApplyStep {
    patch: ResolvedPatch,
    metadata: PatchApplyStepMetadata,
    /// This existing leading-slot mapping MUST remain visible on each record
    /// so chain planning can preserve the current selector-to-patch behavior.
    user_index: Option<usize>,
}

fn prepare_direct_patch_step_selectors(
    mut inputs: Vec<Option<BundlePatchInput>>,
    mut targets: Vec<Option<BundlePatchInput>>,
    ids: Vec<String>,
    patch_count: usize,
) -> DirectPatchStepSelectors {
    let has_selectors = !inputs.is_empty() || !targets.is_empty() || !ids.is_empty();
    let count = if !has_selectors { 0 } else { patch_count };
    if inputs.is_empty() {
        inputs.resize(count, None);
    }
    if targets.is_empty() {
        targets.resize(count, None);
    }
    let ids = if ids.is_empty() {
        vec![None; count]
    } else {
        ids.into_iter().map(Some).collect()
    };
    let selectors_align = inputs.len() == targets.len() && inputs.len() == ids.len();
    normalize_patch_step_member_selectors(&mut inputs);
    normalize_patch_step_member_selectors(&mut targets);
    DirectPatchStepSelectors {
        steps: inputs
            .into_iter()
            .enumerate()
            .map(|(index, input)| PatchApplyStepMetadata {
                input,
                target: targets.get(index).cloned().unwrap_or_default(),
                id: ids.get(index).cloned().unwrap_or_default(),
                ..PatchApplyStepMetadata::default()
            })
            .collect(),
        has_selectors,
        selectors_align,
    }
}

fn normalize_patch_apply_steps(
    patches: Vec<ResolvedPatch>,
    metadata: &[PatchApplyStepMetadata],
    cli_basis: &[PatchBasisMode],
    header_modes: &[PatchApplyHeaderMode],
    n64_byte_order_modes: &[PatchN64ByteOrderMode],
    step_input_offset: usize,
) -> Vec<PatchApplyStep> {
    patches
        .into_iter()
        .enumerate()
        .map(|(index, patch)| {
            let user_index = index.checked_sub(step_input_offset);
            let mut metadata = user_index
                .and_then(|user_index| metadata.get(user_index))
                .cloned()
                .unwrap_or_default();
            metadata.cli_basis = user_index
                .and_then(|user_index| cli_basis.get(user_index))
                .copied();
            metadata.header_mode = header_modes.get(index).copied().unwrap_or_default();
            metadata.n64_byte_order_mode =
                n64_byte_order_modes.get(index).copied().unwrap_or_default();
            PatchApplyStep {
                patch,
                metadata,
                user_index,
            }
        })
        .collect()
}

static INFERRED_PUBLISH_COUNTER: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

pub(super) fn warn_on_rom_name_mismatch(
    expected: Option<&str>,
    actual_path: &Path,
) -> Option<String> {
    let expected = expected?;
    let actual = actual_path.file_name().and_then(|name| name.to_str())?;
    if expected.to_lowercase() == actual.to_lowercase() {
        return None;
    }
    warn!(
        expected_rom_name = expected,
        actual_rom_name = actual,
        "bundle ROM name mismatch; continuing because file-name checks are advisory"
    );
    Some(format!(
        "bundle ROM name mismatch: expected `{expected}`, found `{actual}`; file-name checks are advisory"
    ))
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
    steps: Vec<PatchApplyStepMetadata>,
    default_basis: PatchBasisMode,
    output: Option<PathBuf>,
    threads: ThreadBudget,
    /// The cheat selection this run applied, filled in after the apply.
    cheats: Vec<BundleCheatEntry>,
}

struct PatchApplyPrepareChainInputs<'a> {
    resolved_patches: &'a [ResolvedPatch],
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
    steps: &'a [PatchApplyStep],
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

/// The selectors a patch source may use: the shared `--select`, and the
/// per-patch `--patch-select` bound index-aligned with `--patch`.
#[derive(Clone, Copy)]
pub(super) struct PatchSelectors<'a> {
    pub select: &'a [String],
    pub per_patch: &'a [String],
}

impl<'a> PatchSelectors<'a> {
    /// The patch at `index` uses its own selector when it has a non-empty one,
    /// and otherwise falls back to `--select`.
    fn for_patch(&self, index: usize) -> &'a [String] {
        self.per_patch
            .get(index)
            .filter(|pattern| !pattern.is_empty())
            .map(std::slice::from_ref)
            .unwrap_or(self.select)
    }
}

impl CliApp {
    pub(super) fn run_patch_apply(&self, args: PatchApplyCommand) -> AppRunOutcome {
        if args.dry_run {
            let command = Commands::Patch(PatchCommands::Apply(Box::new(args.clone())));
            if let Some(outcome) = self.plan_dry_run(&command) {
                return outcome;
            }
            let original_input = args.input.clone();
            if let Some(outcome) =
                self.validate_patch_apply_output_preflight(&args, None, &original_input, None)
            {
                return outcome;
            }
            let report = self.run_patch_apply_resolved(RunPatchApplyResolvedInputs {
                args,
                bundle_resolution: None,
                original_input,
                local_bundle: None,
                final_output: &mut None,
                emit_steps: None,
                applied_cheats: &mut Vec::new(),
            });
            return self.finish("patch-apply", report);
        }
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
            cheat_record_count = args.cheat_records.len(),
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
                    OperationReport::failed_with_error(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error,
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
        let mut emit_steps = bundle_resolution
            .as_ref()
            .map(|resolution| resolution.steps.clone())
            .unwrap_or_else(|| {
                prepare_direct_patch_step_selectors(
                    args.patch_input.clone(),
                    args.patch_target.clone(),
                    args.patch_id.clone(),
                    args.patches.len(),
                )
                .steps
            });
        emit_steps.resize_with(args.patches.len(), PatchApplyStepMetadata::default);
        emit_steps.truncate(args.patches.len());
        for (index, step) in emit_steps.iter_mut().enumerate() {
            step.emit_header = args.patch_header.get(index).copied();
            step.emit_basis = args.patch_basis.get(index).copied();
        }
        let mut emit_inputs = emit_bundle.as_ref().map(|_| EmitBundleInputs {
            input: args.input.clone(),
            patches: args.patches.clone(),
            steps: emit_steps,
            default_basis: bundle_resolution
                .as_ref()
                .map(|resolution| resolution.patch_basis)
                .unwrap_or(args.default_patch_basis.unwrap_or(PatchBasisMode::Auto)),
            output: args.output.clone(),
            threads: args.threads,
            cheats: Vec::new(),
        });
        let mut final_output = None;
        let mut applied_cheats = Vec::new();
        let bundle_warnings = bundle_resolution
            .as_ref()
            .map(|resolution| resolution.warnings.clone())
            .unwrap_or_default();
        let mut report = if args.patches.iter().any(|patch| Self::is_dcp_patch(patch)) {
            let expected_rom_name = bundle_resolution
                .as_ref()
                .and_then(|resolution| resolution.expected_rom_name.as_deref());
            self.run_dcp_apply(args, expected_rom_name)
        } else {
            self.run_patch_apply_resolved(RunPatchApplyResolvedInputs {
                args,
                bundle_resolution,
                original_input,
                local_bundle,
                final_output: &mut final_output,
                emit_steps: emit_inputs.as_mut().map(|inputs| &mut inputs.steps),
                applied_cheats: &mut applied_cheats,
            })
        };
        Self::append_report_warnings(&mut report, bundle_warnings);
        // A failed sidecar MUST preserve the completed ROM and report its warning
        // before the terminal result is emitted.
        if let (Some(emit_path), Some(mut inputs)) = (emit_bundle, emit_inputs)
            && report.status == OperationStatus::Succeeded
        {
            inputs.output = final_output.or(inputs.output);
            inputs.cheats = applied_cheats;
            match self.emit_apply_bundle(&emit_path, inputs) {
                Ok(result) => {
                    Self::append_report_warnings(&mut report, result.warnings);
                    let mut paths = Self::emitted_file_detail_paths(report.details.as_ref());
                    paths.push(emit_path);
                    report = Self::attach_emitted_files_details(report, paths, None);
                }
                Err(error) => {
                    tracing::debug!(
                        %error,
                        bundle = %emit_path.display(),
                        "apply succeeded but --emit-bundle failed",
                    );
                    Self::append_report_warnings(
                        &mut report,
                        [format!(
                            "apply succeeded but --emit-bundle `{}` failed: {error}",
                            emit_path.display()
                        )],
                    );
                }
            }
        }
        self.finish("patch-apply", report)
    }

    /// Write a bundle describing a just-completed apply. Reuses
    /// `bundle_create_inner`, so the emitted bundle is byte-for-byte what
    /// `bundle create` would write for the same inputs.
    fn emit_apply_bundle(
        &self,
        emit_path: &Path,
        inputs: EmitBundleInputs,
    ) -> Result<BundleCreateResult> {
        if inputs.patches.is_empty() && inputs.cheats.is_empty() {
            return Err(RomWeaverError::Validation(
                "--emit-bundle needs at least one applied --patch or --cheat".to_string(),
            ));
        }
        let context = self.context(inputs.threads);
        let patch_specs = inputs
            .patches
            .iter()
            .zip(&inputs.steps)
            .map(|(path, step)| BundleCreatePatchSpec {
                path: path.clone(),
                id: step.id.clone(),
                input: step.input.clone(),
                target: step.target.clone(),
                header: step.emit_header,
                basis: step.emit_basis.and_then(PatchBasisMode::declared),
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
            cheats: inputs.cheats,
            ..BundleCreateCommand::default()
        };
        let result = self.bundle_create_inner(&create, &context)?;
        trace!(bundle = %emit_path.display(), "emitted bundle from apply");
        Ok(result)
    }

    fn update_emit_bundle_bases(
        emit_steps: Option<&mut Vec<PatchApplyStepMetadata>>,
        steps: &[PatchApplyStep],
    ) {
        let Some(emit_steps) = emit_steps else {
            return;
        };
        // A synthesized `--code` cheat patch runs after the user patches, so the
        // applied steps MAY outnumber the emitted patch list; its leading steps
        // still map one-to-one onto the emitted patches.
        if emit_steps.len() > steps.len() {
            return;
        }
        let Some(bases) = steps
            .iter()
            .map(|step| {
                step.metadata
                    .verification
                    .as_ref()
                    .and_then(|verification| verification.basis)
                    .map(|basis| match basis {
                        patch_plan::PatchInputBasis::Base => PatchBasisMode::Base,
                        patch_plan::PatchInputBasis::Previous => PatchBasisMode::Previous,
                    })
            })
            .collect::<Option<Vec<_>>>()
        else {
            return;
        };
        for (emit_step, basis) in emit_steps.iter_mut().zip(bases) {
            emit_step.emit_basis = Some(basis);
        }
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

    /// Fold the bundle's declared checks and then the first patch's file name
    /// into the expected input/output requirements. Precedence runs CLI, then
    /// bundle, then file name, so the bundle merges first and the file name
    /// only fills what is still unset. Returns the first conflicting report.
    fn merge_patch_apply_requirements(
        &self,
        inputs: MergePatchApplyRequirementsInputs<'_>,
    ) -> Option<OperationReport> {
        let MergePatchApplyRequirementsInputs {
            ignore_checksum_validation,
            bundle_resolution,
            is_disc,
            patches,
            expected_input_checksums,
            expected_input_size,
            expected_output_checksums,
            probe_threads,
        } = inputs;
        if ignore_checksum_validation {
            return None;
        }
        if let Some(resolution) = bundle_resolution
            && let Some(report) = self.merge_patch_apply_bundle_requirements(
                resolution,
                is_disc,
                expected_input_checksums,
                expected_input_size,
                expected_output_checksums,
                probe_threads.clone(),
            )
        {
            return Some(report);
        }
        if let Some(first_patch) = patches.first()
            && let Some(patch_name) = first_patch.file_name().and_then(|name| name.to_str())
            && let Some(report) = self.merge_filename_requirements(
                "patch-apply",
                first_patch,
                patch_name,
                expected_input_checksums,
                expected_input_size,
                probe_threads,
            )
        {
            return Some(report);
        }
        None
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
                RomWeaverError::Validation(unregistered_output_format_message(compress_format))
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
                OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    error,
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
                return Some(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    report.format.clone(),
                    "compress",
                    error,
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
                    return Some(OperationReport::failed_with_error(
                        OperationFamily::Patch,
                        report.format.clone(),
                        "compress",
                        error,
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
                return Some(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    report.format.clone(),
                    "compress",
                    error,
                    context.single_thread_execution(),
                ));
            }
        };
        if compress_report.status != OperationStatus::Succeeded {
            let error_kind = compress_report.resolved_error_kind();
            let mut failure = OperationReport::failed(
                OperationFamily::Patch,
                report.format.clone(),
                "compress",
                format!("patch output compression failed: {}", compress_report.label),
                compress_report.thread_execution,
            );
            if let Some(error_kind) = error_kind {
                failure = failure.with_error_kind(error_kind);
            }
            return Some(failure);
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
        Self::append_report_warnings(report, compression_plan.warning);
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
            .map(|patch| patch.resolved.as_path());
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
                Box::new(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    None,
                    "compat",
                    error,
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
                    Box::new(OperationReport::failed_with_error(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error,
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
                Box::new(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    None,
                    "validate",
                    error,
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
                Box::new(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    None,
                    "prepare",
                    error,
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
                .steps
                .iter()
                .map(|step| step.metadata.n64_byte_order_mode.id())
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
                Box::new(OperationReport::failed_with_error(
                    OperationFamily::Patch,
                    report.format.clone(),
                    "validate",
                    error,
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
        selectors: PatchSelectors<'_>,
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
                // A per-patch selector overrides --select, which otherwise
                // applies to the input and every patch alike.
                selectors.for_patch(index),
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
            resolved_patches.push(ResolvedPatch {
                source: patch_path.clone(),
                resolved: resolved_patch_source,
            });
        }
        Ok(ResolvedPatchList {
            patches: resolved_patches,
            extracted_notes: extracted_patch_notes,
        })
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
    disc_track_replacements: BTreeMap<PathBuf, PathBuf>,
}

/// The ROM copier-header state threaded through the patch chain: whether the
/// bytes currently feeding the next patch are headerless, plus the header
/// captured at the first strip (for mid-chain restores and the output re-add).
#[derive(Clone)]
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

/// Merge JSON-wire per-step checks into bundle declarations. These values are
/// authored requirements only; execution inputs are selected separately.
fn merge_apply_step_declarations(
    steps: &mut Vec<PatchApplyStepMetadata>,
    input_checks: &[String],
    output_checks: &[String],
    patch_count: usize,
) -> Result<()> {
    if input_checks.is_empty() && output_checks.is_empty() {
        return Ok(());
    }
    for (name, checks) in [
        ("patch_input_check", input_checks),
        ("patch_output_check", output_checks),
    ] {
        if checks.len() != patch_count {
            return Err(RomWeaverError::Validation(format!(
                "{name} must contain one value per patch (or be omitted); got {} value(s) for {patch_count} patch(es)",
                checks.len()
            )));
        }
    }
    if steps.is_empty() {
        steps.resize_with(patch_count, PatchApplyStepMetadata::default);
    } else if steps.len() != patch_count {
        return Err(RomWeaverError::Validation(
            "bundle patch declarations do not align with the resolved patches".to_string(),
        ));
    }
    for index in 0..patch_count {
        let verification = steps[index]
            .verification
            .get_or_insert_with(patch_plan::PatchStepVerification::default);
        if !input_checks[index].trim().is_empty() {
            let parsed =
                parse_expect_tokens(&[input_checks[index].clone()], "patch_input_check", true)?;
            verification.declared_input = Some(patch_plan::PlanState {
                checksums: parsed.checksums,
                size: parsed.size,
            });
        }
        if !output_checks[index].trim().is_empty() {
            let parsed =
                parse_expect_tokens(&[output_checks[index].clone()], "patch_output_check", true)?;
            verification.declared_output = Some(patch_plan::PlanState {
                checksums: parsed.checksums,
                size: parsed.size,
            });
        }
    }
    Ok(())
}

struct RunPatchApplyLoopInputs<'a> {
    steps: &'a [PatchApplyStep],
    apply_input: PathBuf,
    staged_output: &'a Path,
    plan_target_lanes: bool,
    shared_patch_basis: PatchBasisMode,
    rom_member_inputs: &'a BTreeMap<String, PathBuf>,
    generated_member_flags: AutoExtractResolutionFlags,
    disc: Option<&'a DiscContext>,
    header_state: &'a mut ChainHeaderState,
    n64_order: &'a mut Option<N64ByteOrderTransform>,
    probe_threads: &'a Option<ThreadExecution>,
    context: &'a OperationContext,
    temp_paths: &'a mut Vec<PathBuf>,
    cheat_records: &'a [CheatRecord],
    cheat_positions: &'a [usize],
    allow_cheat_conflicts: bool,
}

struct ApplyDatabaseCheatStageInputs<'a> {
    input: &'a Path,
    output: &'a Path,
    records: &'a [CheatRecord],
    allow_conflicts: bool,
    stage_index: usize,
    stage_count: usize,
    context: &'a OperationContext,
}

fn resolve_cheat_stage_positions(
    positions: &[usize],
    cheat_count: usize,
    patch_count: usize,
) -> Result<(Vec<usize>, bool, usize)> {
    if positions.is_empty() {
        return Ok((
            vec![patch_count; cheat_count],
            false,
            usize::from(cheat_count > 0),
        ));
    }
    if positions.len() != cheat_count {
        return Err(RomWeaverError::Validation(
            "cheat positions must align with the cheat record list".to_string(),
        ));
    }
    if let Some(position) = positions.iter().find(|position| **position > patch_count) {
        return Err(RomWeaverError::Validation(format!(
            "cheat position {position} exceeds the {patch_count} normal patch stages"
        )));
    }
    let stage_count = positions.iter().copied().collect::<BTreeSet<_>>().len();
    Ok((positions.to_vec(), true, stage_count))
}

fn cheat_records_at_position(
    records: &[CheatRecord],
    positions: &[usize],
    position: usize,
) -> Vec<CheatRecord> {
    records
        .iter()
        .zip(positions)
        .filter(|(_, candidate)| **candidate == position)
        .map(|(record, _)| record.clone())
        .collect()
}

fn database_cheat_stage_output(
    stage_index: usize,
    stage_count: usize,
    staged_output: &Path,
    context: &OperationContext,
    temp_paths: &mut Vec<PathBuf>,
) -> PathBuf {
    if stage_index + 1 == stage_count {
        return staged_output.to_path_buf();
    }
    let output = context
        .temp_paths()
        .next_path("patch-apply-cheat-step", Some("bin"));
    temp_paths.push(output.clone());
    output
}

/// Which end of a bundle chain step a `BundlePatchInput` reference names. The
/// two roles resolve identically and differ only in the validation codes and
/// messages reported when a reference cannot be resolved.
#[derive(Clone, Copy)]
enum ChainSourceRole {
    Target,
    Input,
}

impl ChainSourceRole {
    fn rom_member_code(self) -> &'static str {
        match self {
            Self::Target => "bundle.patch.target.rom.member.unavailable",
            Self::Input => "bundle.patch.input.rom.member.unavailable",
        }
    }

    fn rom_member_message(self) -> &'static str {
        match self {
            Self::Target => "target ROM member was not resolved from the bundle input",
            Self::Input => "input ROM member was not resolved from the bundle input",
        }
    }

    fn patch_code(self) -> &'static str {
        match self {
            Self::Target => "bundle.patch.target.patch.unavailable",
            Self::Input => "bundle.patch.input.patch.unavailable",
        }
    }

    fn patch_message(self) -> &'static str {
        match self {
            Self::Target => "target patch producer has not produced bytes",
            Self::Input => "patch input producer has not produced bytes",
        }
    }
}

struct ChainSourceInputs<'a> {
    /// The unpatched apply input, used when a ROM reference names no member.
    initial: &'a ProducedPatchOutput,
    rom_member_inputs: &'a BTreeMap<String, PathBuf>,
    producer_outputs: &'a BTreeMap<String, ProducedPatchOutput>,
    generated_member_flags: AutoExtractResolutionFlags,
    context: &'a OperationContext,
    temp_paths: &'a mut Vec<PathBuf>,
}

struct RunPatchApplyResolvedInputs<'a> {
    args: PatchApplyCommand,
    bundle_resolution: Option<BundleApplyResolution>,
    original_input: PathBuf,
    local_bundle: Option<PathBuf>,
    final_output: &'a mut Option<PathBuf>,
    emit_steps: Option<&'a mut Vec<PatchApplyStepMetadata>>,
    applied_cheats: &'a mut Vec<BundleCheatEntry>,
}

struct MergePatchApplyRequirementsInputs<'a> {
    ignore_checksum_validation: bool,
    bundle_resolution: Option<&'a BundleApplyResolution>,
    is_disc: bool,
    patches: &'a [PathBuf],
    expected_input_checksums: &'a mut BTreeMap<String, String>,
    expected_input_size: &'a mut Option<u64>,
    expected_output_checksums: &'a mut BTreeMap<String, String>,
    probe_threads: Option<ThreadExecution>,
}

struct LaneVerificationInputs<'a> {
    index: usize,
    steps: &'a [PatchApplyStep],
    plan_target_lanes: bool,
    lane_key: &'a Option<BundlePatchInput>,
    lane_seeds: &'a BTreeMap<Option<BundlePatchInput>, ProducedPatchOutput>,
    lane_plans: &'a mut BTreeMap<
        Option<BundlePatchInput>,
        BTreeMap<usize, patch_plan::PatchStepVerification>,
    >,
    shared_patch_basis: PatchBasisMode,
    context: &'a OperationContext,
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
    fn append_patch_apply_repair_notes(
        report: &mut OperationReport,
        finalized: PatchApplyFinalizeResult,
    ) {
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
            Self::append_report_warnings(report, [repair_warning]);
        }
    }

    fn apply_database_cheat_stage(
        &self,
        inputs: ApplyDatabaseCheatStageInputs<'_>,
    ) -> std::result::Result<OperationReport, Box<OperationReport>> {
        let ApplyDatabaseCheatStageInputs {
            input,
            output,
            records,
            allow_conflicts,
            stage_index,
            stage_count,
            context,
        } = inputs;
        let description = if records.len() == 1 {
            format!("`{}`", records[0].description)
        } else {
            format!("{} database ROM cheats", records.len())
        };
        self.emit_running(
            OperationLabel {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: Some("cheat"),
            },
            "apply",
            format!(
                "applying cheat {}/{} ({})",
                stage_index + 1,
                stage_count,
                description
            ),
            Some(patch_progress_segment_start(stage_index, stage_count)),
            None,
        );
        let fail = |stage: &str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                Some("cheat".to_string()),
                stage,
                error,
                context.single_thread_execution(),
            ))
        };
        let fail_io = |stage: &str, error: std::io::Error| {
            Box::new(
                OperationReport::failed(
                    OperationFamily::Patch,
                    Some("cheat".to_string()),
                    stage,
                    error.to_string(),
                    context.single_thread_execution(),
                )
                .with_error_kind(rom_weaver_core::RomWeaverErrorKind::Io),
            )
        };
        let mut rom = fs::read(input).map_err(|error| fail_io("apply", error))?;
        let (writes, summary) = Self::resolve_database_cheat_writes(&rom, records, allow_conflicts)
            .map_err(|error| fail("validate", error))?;
        cheats::apply_writes(&mut rom, summary.system, &writes)
            .map_err(|error| fail("apply", error))?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| fail_io("prepare", error))?;
        }
        fs::write(output, rom).map_err(|error| fail_io("apply", error))?;
        Ok(OperationReport::succeeded(
            OperationFamily::Patch,
            Some("cheat".to_string()),
            "apply",
            format!("applied {description}; {}", summary.label()),
            Some(((stage_index + 1) as f32 / stage_count as f32) * 100.0),
            context.single_thread_execution(),
        ))
    }

    fn resolve_lane_step_verification(
        &self,
        inputs: LaneVerificationInputs<'_>,
    ) -> Result<Option<patch_plan::PatchStepVerification>> {
        let LaneVerificationInputs {
            index,
            steps,
            plan_target_lanes,
            lane_key,
            lane_seeds,
            lane_plans,
            shared_patch_basis,
            context,
        } = inputs;
        if !plan_target_lanes {
            return Ok(steps
                .get(index)
                .and_then(|step| step.metadata.verification.clone()));
        }
        if !lane_plans.contains_key(lane_key) {
            let lane_indices = steps
                .iter()
                .enumerate()
                .filter(|(_, step)| step.metadata.target == *lane_key)
                .map(|(index, _)| index)
                .collect::<Vec<_>>();
            let mut lane_steps = lane_indices
                .iter()
                .map(|index| steps[*index].clone())
                .collect::<Vec<_>>();
            let lane_cheat_steps = lane_steps
                .iter()
                .take_while(|step| step.user_index.is_none())
                .count();
            let lane_cli_basis_count = lane_steps
                .iter()
                .filter(|step| step.metadata.cli_basis.is_some())
                .count();
            let lane_seed = lane_seeds.get(lane_key).expect("lane seed initialized");
            self.plan_apply_step_verifications(
                &mut lane_steps,
                lane_cheat_steps,
                shared_patch_basis,
                lane_cli_basis_count,
                PatchApplyBaseInputs {
                    prepared: &lane_seed.path,
                    original: &lane_seed.path,
                    prepared_headerless: lane_seed.header_state.headerless.then_some(true),
                    prepared_n64_byte_order: lane_seed.n64_order.map(|order| order.from),
                    original_n64_byte_order: lane_seed.n64_order.map(|order| order.from),
                },
                context,
            )?;
            lane_plans.insert(
                lane_key.clone(),
                lane_indices
                    .into_iter()
                    .zip(lane_steps.into_iter().map(|step| {
                        step.metadata
                            .verification
                            .expect("planned lane steps have verification metadata")
                    }))
                    .collect(),
            );
        }
        Ok(lane_plans
            .get(lane_key)
            .and_then(|plan| plan.get(&index))
            .cloned())
    }

    /// Resolve the bytes a chain step reads from, for either the step's target
    /// lane seed or its explicit input. Errors carry the failing operation
    /// report so the caller can return it unchanged.
    fn resolve_chain_source(
        &self,
        reference: &BundlePatchInput,
        role: ChainSourceRole,
        sources: ChainSourceInputs<'_>,
    ) -> std::result::Result<ProducedPatchOutput, Box<OperationReport>> {
        let ChainSourceInputs {
            initial,
            rom_member_inputs,
            producer_outputs,
            generated_member_flags,
            context,
            temp_paths,
        } = sources;
        let failed = |stage: &'static str, error: RomWeaverError| {
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                None,
                stage,
                error,
                context.single_thread_execution(),
            ))
        };
        match reference {
            BundlePatchInput::Rom { member, .. } => match member {
                Some(member) => {
                    let path = rom_member_inputs.get(member).cloned().ok_or_else(|| {
                        failed(
                            "validate",
                            RomWeaverError::ValidationCode(
                                ValidationCodeError::new(role.rom_member_code())
                                    .with_message(role.rom_member_message())
                                    .with_field("member", member.clone()),
                            ),
                        )
                    })?;
                    self.produced_patch_output_for_source(path)
                        .map_err(|error| failed("prepare", error))
                }
                None => Ok(initial.clone()),
            },
            BundlePatchInput::Patch { patch, member } => {
                let producer = producer_outputs.get(patch).ok_or_else(|| {
                    failed(
                        "validate",
                        RomWeaverError::ValidationCode(
                            ValidationCodeError::new(role.patch_code())
                                .with_message(role.patch_message())
                                .with_field("patch", patch.clone()),
                        ),
                    )
                })?;
                match member {
                    Some(member) => self
                        .resolve_generated_patch_output_member(
                            producer,
                            member,
                            generated_member_flags,
                            context,
                            temp_paths,
                        )
                        .map_err(|error| failed("prepare", error)),
                    None => Ok(producer.clone()),
                }
            }
        }
    }

    fn resolve_generated_patch_output_member(
        &self,
        producer: &ProducedPatchOutput,
        member: &str,
        flags: AutoExtractResolutionFlags,
        context: &OperationContext,
        temp_paths: &mut Vec<PathBuf>,
    ) -> Result<ProducedPatchOutput> {
        let resolved = self.resolve_exact_member_source(
            &producer.path,
            member,
            context,
            AutoExtractResolutionLabels {
                command: "patch-apply",
                family: OperationFamily::Patch,
                format: None,
                source_label: "generated patch output member",
                temp_prefix: "patch-apply-generated-output-member",
            },
            flags,
        )?;
        temp_paths.extend(resolved.cleanup_paths);
        let output = self.produced_patch_output_for_source(resolved.source)?;
        trace!(
            producer = %producer.path.display(),
            member,
            selected = %output.path.display(),
            headerless = output.header_state.headerless,
            n64_order = ?output.n64_order,
            "resolved generated patch output member"
        );
        Ok(output)
    }

    fn produced_patch_output_for_source(&self, path: PathBuf) -> Result<ProducedPatchOutput> {
        let has_header = Self::detect_known_rom_header(&path)?.is_some();
        let n64_order =
            Self::detect_n64_byte_order_path(&path)?.map(|order| N64ByteOrderTransform {
                from: order,
                to: order,
            });
        trace!(
            source = %path.display(),
            has_header,
            n64_order = ?n64_order,
            "recomputed selected source representation"
        );
        Ok(ProducedPatchOutput {
            path,
            header_state: ChainHeaderState {
                headerless: false,
                stripped_header: None,
                stripped_header_match: None,
            },
            n64_order,
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

    fn verify_declared_chain_output(
        &self,
        context: &OperationContext,
        target: Option<&BundlePatchInput>,
        is_last: bool,
        step: Option<&patch_plan::PatchStepVerification>,
        explicit_input: Option<&BundlePatchInput>,
        output: &Path,
    ) -> Result<()> {
        let Some(step) = step else {
            return Ok(());
        };
        if !(context.strict_patch_checksums()
            && (target.is_some() || !is_last)
            && (step.is_chain_prefix || explicit_input.is_some()))
        {
            return Ok(());
        }
        let Some(declared) = step.declared_output.as_ref() else {
            return Ok(());
        };
        Self::verify_chain_step_state(output, declared, context)
    }

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
            Box::new(OperationReport::failed_with_error(
                OperationFamily::Patch,
                report_format.clone(),
                "compress",
                error,
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

    /// Discover RetroArch-style sidecar patches beside the input, or yield an
    /// empty set when this run does not look for them (explicit patches were
    /// given, cheats supply the work, or the input is a disc).
    fn discover_patch_apply_sidecars_for_run(
        &self,
        discover: bool,
        input: &Path,
        select: &[String],
        no_ignore: bool,
        context: &OperationContext,
    ) -> Result<DiscoveredPatchApplySidecars> {
        if !discover {
            return Ok(DiscoveredPatchApplySidecars::default());
        }
        self.discover_patch_apply_sidecars(input, select, no_ignore, context)
    }

    /// Validate the `--dry-run` preconditions, then plan the apply without
    /// writing bytes. The output path MUST be given: with no bytes written
    /// there is no archive member to infer it from.
    fn run_patch_apply_dry_run(
        &self,
        input: &Path,
        patches: &[PathBuf],
        output: Option<&Path>,
        compression_options: &PatchApplyCompressionOptions,
        probe_threads: Option<ThreadExecution>,
    ) -> OperationReport {
        let Some(output) = output else {
            return OperationReport::failed(
                OperationFamily::Patch,
                None,
                "validate",
                "--dry-run requires --output when the output path cannot be inferred before selecting an archive member".to_string(),
                probe_threads,
            );
        };
        for patch in patches {
            if let Some(report) = self.require_readable_path(
                "patch-apply",
                OperationFamily::Patch,
                None,
                patch,
                probe_threads.clone(),
            ) {
                return report;
            }
        }
        self.patch_apply_dry_run(input, patches, output, compression_options, probe_threads)
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
                    return OperationReport::failed_with_error(
                        OperationFamily::Patch,
                        None,
                        "validate",
                        error,
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
        details.insert("command".to_string(), json!("patch-apply"));
        details.insert("writes".to_string(), json!([output.display().to_string()]));
        details.insert("downloads".to_string(), json!([]));
        details.insert("read_only".to_string(), json!(false));
        details.insert("notes".to_string(), json!([
            "patch contents, checksums, archive members, and destination write access are not validated during dry run"
        ]));
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
                unregistered_output_format_message(&plan.format),
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
            archive_names: None,
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
                OperationReport::failed_with_error(
                    OperationFamily::Container,
                    Some(handler.descriptor().name.to_string()),
                    "create",
                    error,
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

#[derive(Clone)]
struct ProducedPatchOutput {
    path: PathBuf,
    header_state: ChainHeaderState,
    n64_order: Option<N64ByteOrderTransform>,
}

#[cfg(test)]
#[path = "../tests/unit/patch_apply.rs"]
mod tests;
