use std::sync::atomic::{AtomicU32, Ordering};

use rom_weaver_core::{NoninteractivePrompter, RecordingProgressSink};

use super::*;

/// Monotonic suffix so parallel tests in this file never share a scratch dir.
static SCRATCH_COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch_dir(label: &str) -> PathBuf {
    let unique = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "rw-patch-apply-dcp-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn app_with_sink() -> (CliApp, Arc<RecordingProgressSink>) {
    let sink = Arc::new(RecordingProgressSink::default());
    let app = CliApp::new(
        sink.clone(),
        Arc::new(NoninteractivePrompter),
        true,
        false,
        false,
    );
    (app, sink)
}

/// `PatchApplyCommand` has no `Default`; the wasm wire deserializes it, so the
/// tests build one the same way and override the fields under test.
fn apply_args(input: &Path, dcp: &Path) -> PatchApplyCommand {
    serde_json::from_value(json!({
        "input": input.to_string_lossy(),
        "patches": [dcp.to_string_lossy()],
        "compress_format": null,
        "emit_bundle": null,
        "tui": false,
    }))
    .expect("patch apply args")
}

fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("fixture write");
    path
}

/// Run `patch apply` for a `.dcp` and return the terminal event's label.
fn failure_label(app: &CliApp, sink: &RecordingProgressSink, args: PatchApplyCommand) -> String {
    let outcome = app.run_dcp_apply(args, None);
    assert_eq!(outcome.exit_code, 1, "a rejected .dcp apply exits non-zero");
    let terminal = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal event");
    assert_eq!(terminal.status, OperationStatus::Failed);
    assert_eq!(terminal.command, "patch-apply");
    terminal.label
}

#[test]
fn a_dcp_cannot_be_chained_with_another_patch() {
    let dir = scratch_dir("chaining");
    let input = write_fixture(&dir, "disc.cue", b"");
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let other = write_fixture(&dir, "other.dcp", b"");
    let (app, sink) = app_with_sink();
    let mut args = apply_args(&input, &dcp);
    args.patches.push(other);

    let label = failure_label(&app, &sink, args);
    assert!(
        label.contains("must be applied on its own (no patch chaining)"),
        "{label}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dcp_rejects_every_byte_level_transform_flag() {
    let dir = scratch_dir("transform-flags");
    let input = write_fixture(&dir, "disc.cue", b"");
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let (app, sink) = app_with_sink();

    let variants: [fn(&mut PatchApplyCommand); 4] = [
        |args| args.patch_header = vec![PatchApplyHeaderMode::Strip],
        |args| args.output_header = Some(PatchApplyOutputHeaderMode::Strip),
        |args| args.repair_checksum = true,
        |args| args.n64_byte_order = vec![PatchN64ByteOrderMode::BigEndian],
    ];
    for apply_variant in variants {
        let mut args = apply_args(&input, &dcp);
        apply_variant(&mut args);
        let label = failure_label(&app, &sink, args);
        assert!(
            label.contains(
                "cannot be combined with --patch-header strip, --output-header, --repair-checksum, or --n64-byte-order"
            ),
            "{label}"
        );
    }
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dcp_rejects_cheat_codes_and_an_explicit_target() {
    let dir = scratch_dir("codes-and-target");
    let input = write_fixture(&dir, "disc.cue", b"");
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let (app, sink) = app_with_sink();

    let mut args = apply_args(&input, &dcp);
    args.codes = vec!["01234567 89AB".to_string()];
    let label = failure_label(&app, &sink, args);
    assert!(label.contains("cannot be combined with --code"), "{label}");

    let mut args = apply_args(&input, &dcp);
    args.target = Some("track02".to_string());
    let label = failure_label(&app, &sink, args);
    assert!(label.contains("a .dcp patch ignores --target"), "{label}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dcp_apply_reports_a_missing_input_or_patch_path() {
    let dir = scratch_dir("missing-paths");
    let input = write_fixture(&dir, "disc.cue", b"");
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let (app, sink) = app_with_sink();

    let args = apply_args(&dir.join("absent.cue"), &dcp);
    let label = failure_label(&app, &sink, args);
    assert!(
        label.contains("input path does not exist") && label.contains("absent.cue"),
        "{label}"
    );

    let args = apply_args(&input, &dir.join("absent.dcp"));
    let label = failure_label(&app, &sink, args);
    assert!(
        label.contains("input path does not exist") && label.contains("absent.dcp"),
        "{label}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dcp_apply_reports_contradictory_compression_flags() {
    let dir = scratch_dir("compression-flags");
    let input = write_fixture(&dir, "disc.cue", b"");
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let (app, sink) = app_with_sink();

    let mut args = apply_args(&input, &dcp);
    args.no_compress = true;
    args.compress_format = Some("chd".to_string());
    let label = failure_label(&app, &sink, args);
    assert!(
        label.contains("--no-compress cannot be combined with --compress-format"),
        "{label}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dcp_apply_reports_an_unresolvable_compression_plan() {
    let dir = scratch_dir("compression-plan");
    let input = write_fixture(&dir, "disc.cue", b"");
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let (app, sink) = app_with_sink();

    let mut args = apply_args(&input, &dcp);
    args.output = Some(dir.join("out.chd"));
    args.compress_format = Some("not-a-container-format".to_string());
    let label = failure_label(&app, &sink, args);
    assert!(
        label.contains("requested output format is not registered"),
        "{label}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dcp_apply_requires_a_disc_sheet_input() {
    let dir = scratch_dir("not-a-sheet");
    let input = write_fixture(&dir, "game.iso", &[0x00; 64]);
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let (app, sink) = app_with_sink();

    let mut args = apply_args(&input, &dcp);
    args.output = Some(dir.join("out.chd"));
    let label = failure_label(&app, &sink, args);
    assert!(
        label.contains("requires a disc-sheet (.cue/.gdi) input"),
        "{label}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_dcp_apply_reports_a_disc_sheet_that_cannot_be_resolved() {
    let dir = scratch_dir("broken-sheet");
    let input = write_fixture(
        &dir,
        "disc.cue",
        b"FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    );
    let dcp = write_fixture(&dir, "mod.dcp", b"");
    let (app, sink) = app_with_sink();

    let mut args = apply_args(&input, &dcp);
    args.output = Some(dir.join("out.chd"));
    let label = failure_label(&app, &sink, args);
    assert!(
        label.contains("track01.bin"),
        "the missing track is named: {label}"
    );
    fs::remove_dir_all(&dir).ok();
}
