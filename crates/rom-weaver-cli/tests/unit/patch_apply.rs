use super::*;

use crate::patch_filename_checksum::FilenameRequirements;

fn app() -> CliApp {
    CliApp::new(
        Arc::new(rom_weaver_core::NoopProgressSink),
        Arc::new(rom_weaver_core::NoninteractivePrompter),
        false,
        false,
        false,
    )
}

fn test_context(temp_root: PathBuf) -> OperationContext {
    OperationContext::new(
        ThreadBudget::Fixed(1),
        temp_root,
        Arc::new(rom_weaver_core::NoopProgressSink),
        rom_weaver_core::CancellationToken::new(),
    )
}

/// A minimal IPS patch: `PATCH`, one literal record per entry, `EOF`.
fn ips_patch(records: &[(u32, &[u8])]) -> Vec<u8> {
    let mut bytes = b"PATCH".to_vec();
    for (offset, data) in records {
        bytes.extend_from_slice(&offset.to_be_bytes()[1..]);
        let len = u16::try_from(data.len()).expect("literal record length");
        bytes.extend_from_slice(&len.to_be_bytes());
        bytes.extend_from_slice(data);
    }
    bytes.extend_from_slice(b"EOF");
    bytes
}

/// A big-endian N64 image. The length is a multiple of 4 so the byte-order
/// rewrite accepts it.
fn z64_rom() -> Vec<u8> {
    let mut bytes = vec![0x80, 0x37, 0x12, 0x40];
    bytes.extend((0..1020_u32).map(|index| (index % 251) as u8));
    bytes
}

fn compression_options(format: Option<&str>) -> PatchApplyCompressionOptions {
    CliApp::parse_patch_apply_compression_options(
        false,
        format.map(str::to_owned),
        Vec::new(),
        None,
    )
    .expect("compression options")
}

fn apply_command(input: &Path, patches: Vec<PathBuf>) -> PatchApplyCommand {
    PatchApplyCommand {
        input: input.to_path_buf(),
        select: Vec::new(),
        target: None,
        filter: Vec::new(),
        no_extract: true,
        no_ignore: false,
        patches,
        output: None,
        bundle: None,
        with_patches: Vec::new(),
        without_patches: Vec::new(),
        no_compress: true,
        compress_format: None,
        compress_codec: Vec::new(),
        compress_level: None,
        assume_in: Vec::new(),
        expect_in: Vec::new(),
        patch_header: Vec::new(),
        patch_basis: Vec::new(),
        output_header: None,
        repair_checksum: false,
        n64_byte_order: Vec::new(),
        ignore_checksum_validation: false,
        expect_out: Vec::new(),
        codes: Vec::new(),
        code_system: None,
        code_kind: "auto".to_string(),
        emit_bundle: None,
        tui: false,
        threads: ThreadBudget::Fixed(1),
        force: false,
        dry_run: false,
    }
}

/// Run a full `patch apply` and hand back the command's own terminal report
/// event, so a failure can be asserted by reason rather than by status alone.
fn run_apply(args: PatchApplyCommand) -> (AppRunOutcome, ProgressEvent) {
    let recorder = Arc::new(rom_weaver_core::RecordingProgressSink::default());
    let app = CliApp::new(
        recorder.clone(),
        Arc::new(rom_weaver_core::NoninteractivePrompter),
        true,
        false,
        false,
    );
    let outcome = app.run_patch_apply(args);
    let terminal = recorder
        .snapshot()
        .into_iter()
        .rfind(|event| event.command == "patch-apply" && event.status != OperationStatus::Running)
        .expect("a terminal patch-apply event");
    (outcome, terminal)
}

fn details_of(report: &OperationReport) -> Map<String, Value> {
    match report.details.as_ref() {
        Some(Value::Object(map)) => map.clone(),
        other => panic!("report carries no detail object: {other:?}"),
    }
}

#[test]
fn a_dry_run_report_names_raw_when_no_compression_is_planned() {
    let report = CliApp::patch_apply_dry_run_report(
        Path::new("/roms/game.sfc"),
        &[
            PathBuf::from("/patches/a.ips"),
            PathBuf::from("/patches/b.ips"),
        ],
        Path::new("/roms/game-patched.sfc"),
        None,
        None,
    );

    assert_eq!(report.status, OperationStatus::Succeeded);
    assert_eq!(report.stage, "plan");
    assert_eq!(report.format, None);
    let details = details_of(&report);
    assert_eq!(details.get("dry_run"), Some(&json!(true)));
    assert_eq!(details.get("format"), Some(&json!("raw")));
    assert_eq!(
        details.get("patches"),
        Some(&json!(["/patches/a.ips", "/patches/b.ips"]))
    );
    assert!(details.get("codec").is_none());
    assert!(report.label.contains("would apply 2 patch(es)"));
    assert!(report.label.contains("raw (no compression)"));
    assert!(report.label.contains("nothing written"));
}

#[test]
fn a_dry_run_report_carries_the_planned_container_format_codec_and_level() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let app = app();
    let plan = app
        .resolve_patch_apply_compression_plan(
            &temp.path().join("game-patched.zip"),
            &input,
            &compression_options(Some("zip")),
        )
        .expect("compression plan");

    let report = CliApp::patch_apply_dry_run_report(
        &input,
        &[PathBuf::from("a.ips")],
        &plan.output_path,
        Some(&plan),
        None,
    );

    assert_eq!(report.status, OperationStatus::Succeeded);
    assert_eq!(report.format.as_deref(), Some("zip"));
    let details = details_of(&report);
    assert_eq!(details.get("format"), Some(&json!("zip")));
    assert!(details.contains_key("codec"));
    assert!(details.contains_key("level"));
    assert!(report.label.contains("as zip"));
}

#[test]
fn a_dry_run_resolves_the_compression_plan_before_reporting() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    // An extensionless --output makes the plan append the container extension,
    // which is the difference the dry run has to report.
    let requested = temp.path().join("game-patched");

    let report = app().patch_apply_dry_run(
        &input,
        &[PathBuf::from("a.ips")],
        &requested,
        &compression_options(Some("zip")),
        None,
    );

    assert_eq!(report.status, OperationStatus::Succeeded);
    let details = details_of(&report);
    assert_eq!(details.get("format"), Some(&json!("zip")));
    assert_eq!(
        details.get("output"),
        Some(&json!(
            requested.with_extension("zip").display().to_string()
        ))
    );
}

#[test]
fn a_dry_run_fails_when_the_requested_container_format_is_unknown() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");

    let report = app().patch_apply_dry_run(
        &input,
        &[PathBuf::from("a.ips")],
        &temp.path().join("out.bin"),
        &compression_options(Some("definitely-not-a-format")),
        None,
    );

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.stage, "validate");
    assert!(report.details.is_none());
}

#[test]
fn patch_apply_dry_run_without_an_output_path_is_rejected() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"X")])).expect("patch fixture");
    let mut args = apply_command(&input, vec![patch]);
    args.dry_run = true;

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("--dry-run requires --output"));
    assert!(!input.with_file_name("game-patched.sfc").exists());
}

#[test]
fn patch_apply_dry_run_writes_nothing() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"X")])).expect("patch fixture");
    let output = temp.path().join("out.sfc");
    let mut args = apply_command(&input, vec![patch]);
    args.dry_run = true;
    args.output = Some(output.clone());

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert_eq!(terminal.stage, "plan");
    assert!(terminal.label.contains("dry run: would apply 1 patch(es)"));
    assert!(!output.exists());
}

#[test]
fn cheat_codes_cannot_be_combined_with_an_explicit_header_strip() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let mut args = apply_command(&input, Vec::new());
    args.codes = vec!["AAAA-AAAA".to_string()];
    args.patch_header = vec![PatchApplyHeaderMode::Strip];
    args.output = Some(temp.path().join("out.sfc"));

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("--code cannot be combined with"));
}

#[test]
fn an_output_that_is_the_input_is_rejected_before_anything_is_read() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"X")])).expect("patch fixture");
    let mut args = apply_command(&input, vec![patch.clone()]);
    args.output = Some(input.clone());

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(
        terminal
            .label
            .contains("input and output resolve to the same file")
    );
    assert_eq!(fs::read(&input).expect("input untouched"), b"rom bytes");
}

#[test]
fn the_output_alias_message_names_whichever_input_the_output_collides_with() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    let original = temp.path().join("archive.zip");
    let patch = temp.path().join("fix.ips");
    let bundle = temp.path().join("run.json");
    for path in [&input, &original, &patch, &bundle] {
        fs::write(path, b"x").expect("fixture");
    }
    let patches = vec![patch.clone()];

    let same_input = CliApp::patch_apply_output_alias_message(
        &input,
        &patches,
        &original,
        Some(&bundle),
        &input,
    )
    .expect("input alias");
    assert!(same_input.contains("input and output resolve to the same file"));

    let same_original = CliApp::patch_apply_output_alias_message(
        &input,
        &patches,
        &original,
        Some(&bundle),
        &original,
    )
    .expect("original alias");
    assert!(same_original.contains("input and output resolve to the same file"));

    let same_patch = CliApp::patch_apply_output_alias_message(
        &input,
        &patches,
        &original,
        Some(&bundle),
        &patch,
    )
    .expect("patch alias");
    assert!(same_patch.contains("patch file"));
    assert!(same_patch.contains(&patch.display().to_string()));

    let same_bundle = CliApp::patch_apply_output_alias_message(
        &input,
        &patches,
        &original,
        Some(&bundle),
        &bundle,
    )
    .expect("bundle alias");
    assert!(same_bundle.contains("bundle source"));

    assert!(
        CliApp::patch_apply_output_alias_message(
            &input,
            &patches,
            &original,
            Some(&bundle),
            &temp.path().join("fresh.sfc"),
        )
        .is_none()
    );
}

#[test]
fn a_hard_link_counts_as_the_same_output_file() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let linked = temp.path().join("also-game.sfc");
    fs::hard_link(&input, &linked).expect("hard link");

    assert!(paths_refer_to_same_file(&input, &linked));
    assert!(!paths_refer_to_same_file(
        &input,
        &temp.path().join("missing.sfc")
    ));
}

#[cfg(unix)]
#[test]
fn path_occupancy_sees_a_dangling_symlink() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let real = temp.path().join("real.bin");
    fs::write(&real, b"x").expect("fixture");
    let dangling = temp.path().join("dangling.bin");
    std::os::unix::fs::symlink(temp.path().join("gone.bin"), &dangling).expect("symlink");

    assert!(path_is_occupied(&real).expect("real path"));
    assert!(path_is_occupied(&dangling).expect("dangling symlink"));
    assert!(!path_is_occupied(&temp.path().join("absent.bin")).expect("absent path"));
}

#[test]
fn a_dcp_patch_is_recognized_by_extension_regardless_of_case() {
    assert!(CliApp::is_dcp_patch(Path::new("disc.dcp")));
    assert!(CliApp::is_dcp_patch(Path::new("disc.DCP")));
    assert!(!CliApp::is_dcp_patch(Path::new("disc.ips")));
    assert!(!CliApp::is_dcp_patch(Path::new("disc")));
}

#[test]
fn an_inferred_output_name_advances_past_every_occupied_candidate() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    fs::write(temp.path().join("game-patched.sfc"), b"taken").expect("collision");
    fs::write(temp.path().join("game-patched-1.sfc"), b"taken").expect("collision");

    let chosen = CliApp::default_patch_apply_output_path(&input, &input).expect("inferred output");

    assert_eq!(chosen, temp.path().join("game-patched-2.sfc"));
}

#[test]
fn an_inferred_output_name_needs_an_extension_to_copy() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game");
    fs::write(&input, b"rom bytes").expect("rom fixture");

    let error = CliApp::default_patch_apply_output_path(&input, &input)
        .expect_err("an extensionless leaf cannot name an output");

    assert!(error.to_string().contains("pass --output"));
}

#[test]
fn ensuring_an_inferred_output_only_moves_an_occupied_inferred_path() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let taken = temp.path().join("game-patched.sfc");
    fs::write(&taken, b"taken").expect("collision");

    let mut explicit = taken.clone();
    CliApp::ensure_inferred_output_available(false, &mut explicit, &input)
        .expect("an explicit output is left alone");
    assert_eq!(explicit, taken);

    let mut free = temp.path().join("game-patched-9.sfc");
    CliApp::ensure_inferred_output_available(true, &mut free, &input)
        .expect("a free inferred output is left alone");
    assert_eq!(free, temp.path().join("game-patched-9.sfc"));

    let mut occupied = taken.clone();
    CliApp::ensure_inferred_output_available(true, &mut occupied, &input)
        .expect("an occupied inferred output advances");
    assert_eq!(occupied, temp.path().join("game-patched-1.sfc"));
}

#[test]
fn an_occupied_extensionless_inferred_output_reports_a_collision() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let mut occupied = temp.path().join("no-extension");
    fs::write(&occupied, b"taken").expect("collision");

    let report = CliApp::inferred_output_collision_report(true, &mut occupied, &input, None)
        .expect("collision report");

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.stage, "validate");
    assert!(report.label.contains("no file extension"));

    let mut fine = temp.path().join("game-patched.sfc");
    assert!(CliApp::inferred_output_collision_report(true, &mut fine, &input, None).is_none());
}

#[test]
fn publishing_an_inferred_output_never_overwrites_a_racing_file() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let source = temp.path().join("staged.bin");
    fs::write(&source, b"patched bytes").expect("staged fixture");
    let mut destination = temp.path().join("game-patched.sfc");
    fs::write(&destination, b"someone else").expect("racing file");

    CliApp::publish_inferred_patch_apply_output(&source, &mut destination, &input)
        .expect("publish past the collision");

    assert_eq!(destination, temp.path().join("game-patched-1.sfc"));
    assert_eq!(fs::read(&destination).expect("published"), b"patched bytes");
    assert_eq!(
        fs::read(temp.path().join("game-patched.sfc")).expect("untouched"),
        b"someone else"
    );
}

#[test]
fn publishing_an_inferred_output_needs_an_extension_to_retry_with() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let source = temp.path().join("staged.bin");
    fs::write(&source, b"patched bytes").expect("staged fixture");
    let mut destination = temp.path().join("no-extension");

    let error = CliApp::publish_inferred_patch_apply_output(
        &source,
        &mut destination,
        &temp.path().join("game.sfc"),
    )
    .expect_err("an extensionless destination cannot be retried");

    assert!(error.to_string().contains("no file extension"));
}

#[test]
fn copying_to_a_new_output_file_leaves_no_stage_behind() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let source = temp.path().join("staged.bin");
    fs::write(&source, b"patched bytes").expect("staged fixture");
    let destination = temp.path().join("out.sfc");

    CliApp::copy_to_new_output_file(&source, &destination).expect("copy");

    assert_eq!(fs::read(&destination).expect("copied"), b"patched bytes");
    let leftovers: Vec<_> = fs::read_dir(temp.path())
        .expect("listing")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("rom-weaver-stage"))
        .collect();
    assert!(leftovers.is_empty(), "stage files left: {leftovers:?}");

    let error = CliApp::copy_to_new_output_file(&source, &destination)
        .expect_err("an existing destination is never overwritten");
    assert!(matches!(
        error,
        RomWeaverError::Io(ref io_error) if io_error.kind() == io::ErrorKind::AlreadyExists
    ));
}

#[test]
fn create_new_copying_refuses_an_existing_destination() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let source = temp.path().join("staged.bin");
    fs::write(&source, b"patched bytes").expect("staged fixture");
    let destination = temp.path().join("out.sfc");

    CliApp::copy_file_create_new(&source, &destination).expect("first copy");
    assert_eq!(fs::read(&destination).expect("copied"), b"patched bytes");

    let error =
        CliApp::copy_file_create_new(&source, &destination).expect_err("second copy must fail");
    assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
    assert_eq!(fs::read(&destination).expect("untouched"), b"patched bytes");
}

#[test]
fn a_cross_device_link_failure_falls_back_to_copying() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let staged = temp.path().join("staged.bin");
    fs::write(&staged, b"patched bytes").expect("staged fixture");
    let destination = temp.path().join("out.sfc");

    CliApp::install_staged_no_overwrite_with(&staged, &destination, |_, _| {
        Err(io::Error::from(io::ErrorKind::CrossesDevices))
    })
    .expect("fallback copy");
    assert_eq!(fs::read(&destination).expect("copied"), b"patched bytes");

    // AlreadyExists and NotFound describe the destination, not the link
    // mechanism, so they must reach the caller instead of being retried.
    for kind in [io::ErrorKind::AlreadyExists, io::ErrorKind::NotFound] {
        let error = CliApp::install_staged_no_overwrite_with(
            &staged,
            &temp.path().join("other.sfc"),
            |_, _| Err(io::Error::from(kind)),
        )
        .expect_err("the destination error is preserved");
        assert_eq!(error.kind(), kind);
    }
}

#[test]
fn compressing_a_patched_output_writes_the_container_and_relabels_the_report() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let raw_ready = temp.path().join("game-patched.sfc");
    fs::write(&raw_ready, b"patched bytes").expect("patched fixture");
    let resolved_input = temp.path().join("game.sfc");
    fs::write(&resolved_input, b"rom bytes").expect("rom fixture");
    let requested = temp.path().join("game-patched.zip");
    let context = test_context(temp.path().join("compress-temp"));
    let mut report = OperationReport::succeeded(
        OperationFamily::Patch,
        Some("IPS".to_string()),
        "apply",
        "applied 1 patch".to_string(),
        None,
        None,
    );
    let mut temp_paths = Vec::new();
    let mut terminal_output_path = requested.clone();
    let mut terminal_output_source = raw_ready.clone();

    let failure = app().compress_patch_apply_output(PatchApplyCompressionInputs {
        report: &mut report,
        compression_options: &compression_options(Some("zip")),
        output: &requested,
        output_was_inferred: false,
        resolved_input: &resolved_input,
        is_disc: false,
        raw_ready_output: &raw_ready,
        disc_track_overrides: &[],
        context: &context,
        temp_paths: &mut temp_paths,
        terminal_output_path: &mut terminal_output_path,
        terminal_output_source: &mut terminal_output_source,
    });

    assert!(failure.is_none(), "compression failed: {failure:?}");
    assert_eq!(report.stage, "compress");
    assert!(report.label.contains("patch output compressed as zip"));
    assert_eq!(terminal_output_path, requested);
    assert!(requested.is_file());
}

#[test]
fn compression_is_skipped_for_a_failed_apply_and_when_it_is_disabled() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let raw_ready = temp.path().join("game-patched.sfc");
    fs::write(&raw_ready, b"patched bytes").expect("patched fixture");
    let requested = temp.path().join("game-patched.zip");
    let context = test_context(temp.path().join("skip-temp"));
    let app = app();
    let mut temp_paths = Vec::new();
    let mut terminal_output_path = requested.clone();
    let mut terminal_output_source = raw_ready.clone();
    let mut inputs = |report: &mut OperationReport, options: &PatchApplyCompressionOptions| {
        app.compress_patch_apply_output(PatchApplyCompressionInputs {
            report,
            compression_options: options,
            output: &requested,
            output_was_inferred: false,
            resolved_input: &raw_ready,
            is_disc: false,
            raw_ready_output: &raw_ready,
            disc_track_overrides: &[],
            context: &context,
            temp_paths: &mut temp_paths,
            terminal_output_path: &mut terminal_output_path,
            terminal_output_source: &mut terminal_output_source,
        })
    };

    let mut failed = OperationReport::failed(
        OperationFamily::Patch,
        None,
        "apply",
        "patch failed".to_string(),
        None,
    );
    assert!(inputs(&mut failed, &compression_options(Some("zip"))).is_none());
    assert_eq!(failed.stage, "apply");

    let mut succeeded = OperationReport::succeeded(
        OperationFamily::Patch,
        None,
        "apply",
        "applied".to_string(),
        None,
        None,
    );
    let disabled = CliApp::parse_patch_apply_compression_options(true, None, Vec::new(), None)
        .expect("disabled options");
    assert!(inputs(&mut succeeded, &disabled).is_none());
    assert_eq!(succeeded.stage, "apply");
    assert!(!requested.exists());
}

#[test]
fn compression_reports_an_unresolvable_container_format() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let raw_ready = temp.path().join("game-patched.sfc");
    fs::write(&raw_ready, b"patched bytes").expect("patched fixture");
    let requested = temp.path().join("game-patched.bin");
    let context = test_context(temp.path().join("bad-format-temp"));
    let mut report = OperationReport::succeeded(
        OperationFamily::Patch,
        Some("IPS".to_string()),
        "apply",
        "applied 1 patch".to_string(),
        None,
        None,
    );
    let mut temp_paths = Vec::new();
    let mut terminal_output_path = requested.clone();
    let mut terminal_output_source = raw_ready.clone();

    let failure = app()
        .compress_patch_apply_output(PatchApplyCompressionInputs {
            report: &mut report,
            compression_options: &compression_options(Some("definitely-not-a-format")),
            output: &requested,
            output_was_inferred: false,
            resolved_input: &raw_ready,
            is_disc: false,
            raw_ready_output: &raw_ready,
            disc_track_overrides: &[],
            context: &context,
            temp_paths: &mut temp_paths,
            terminal_output_path: &mut terminal_output_path,
            terminal_output_source: &mut terminal_output_source,
        })
        .expect("an unknown format must fail the compress stage");

    assert_eq!(failure.status, OperationStatus::Failed);
    assert_eq!(failure.stage, "compress");
    assert_eq!(failure.format.as_deref(), Some("IPS"));
}

#[test]
fn running_compression_rejects_a_format_no_handler_claims() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let payload = temp.path().join("payload.bin");
    fs::write(&payload, b"bytes").expect("payload fixture");
    let context = test_context(temp.path().join("unregistered-temp"));
    let plan = PatchApplyCompressionPlan {
        format: "definitely-not-a-format".to_string(),
        codec: None,
        level: None,
        output_path: temp.path().join("out.bin"),
        extension_appended: false,
        note: String::new(),
        warning: None,
    };

    let error = app()
        .run_patch_apply_compression(
            &plan,
            vec![payload],
            &[],
            "compressing".to_string(),
            &context,
        )
        .expect_err("an unregistered format has no handler");

    assert!(matches!(error, RomWeaverError::Validation(_)));
}

#[test]
fn running_compression_writes_the_container_and_names_the_codec() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let payload = temp.path().join("payload.bin");
    fs::write(&payload, b"bytes").expect("payload fixture");
    let output = temp.path().join("out.zip");
    let context = test_context(temp.path().join("zip-temp"));
    let plan = PatchApplyCompressionPlan {
        format: "zip".to_string(),
        codec: None,
        level: None,
        output_path: output.clone(),
        extension_appended: false,
        note: "note".to_string(),
        warning: None,
    };

    let (report, codec_label) = app()
        .run_patch_apply_compression(
            &plan,
            vec![payload],
            &[],
            "compressing".to_string(),
            &context,
        )
        .expect("zip creation");

    assert_eq!(report.status, OperationStatus::Succeeded);
    assert_eq!(codec_label, "default");
    assert!(output.is_file());
}

#[test]
fn the_guarded_compression_plan_refuses_to_overwrite_an_appended_extension_target() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let resolved_input = temp.path().join("game.sfc");
    fs::write(&resolved_input, b"rom bytes").expect("rom fixture");
    let requested = temp.path().join("game-patched");
    fs::write(temp.path().join("game-patched.zip"), b"already here").expect("occupied output");
    let context = test_context(temp.path().join("guard-temp"));
    let app = app();

    let report = app
        .resolve_guarded_patch_apply_compression_plan(
            &requested,
            &resolved_input,
            &compression_options(Some("zip")),
            false,
            Some("IPS".to_string()),
            &context,
        )
        .expect_err("the appended-extension target is already occupied");
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.stage, "compress");

    let forced = app
        .resolve_guarded_patch_apply_compression_plan(
            &requested,
            &resolved_input,
            &compression_options(Some("zip")),
            true,
            None,
            &context,
        )
        .expect("--force accepts the occupied target");
    assert!(forced.extension_appended);
    assert_eq!(forced.output_path, temp.path().join("game-patched.zip"));
}

#[test]
fn the_guarded_compression_plan_reports_an_unknown_format() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let resolved_input = temp.path().join("game.sfc");
    fs::write(&resolved_input, b"rom bytes").expect("rom fixture");
    let context = test_context(temp.path().join("guard-bad-temp"));

    let report = app()
        .resolve_guarded_patch_apply_compression_plan(
            &temp.path().join("out.bin"),
            &resolved_input,
            &compression_options(Some("definitely-not-a-format")),
            false,
            None,
            &context,
        )
        .expect_err("an unknown format cannot be planned");

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.stage, "compress");
}

#[test]
fn validating_a_compression_plan_is_a_no_op_when_compression_is_off() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let resolved_input = temp.path().join("game.sfc");
    fs::write(&resolved_input, b"rom bytes").expect("rom fixture");
    let app = app();
    let disabled = CliApp::parse_patch_apply_compression_options(true, None, Vec::new(), None)
        .expect("disabled options");

    app.validate_patch_apply_compression_plan(
        &temp.path().join("out.bin"),
        &resolved_input,
        &disabled,
    )
    .expect("a disabled plan needs no format");

    app.validate_patch_apply_compression_plan(
        &temp.path().join("out.bin"),
        &resolved_input,
        &compression_options(Some("definitely-not-a-format")),
    )
    .expect_err("an enabled plan validates the format");
}

#[test]
fn an_n64_input_is_rewritten_into_the_order_the_patch_asked_for() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.z64");
    fs::write(&input, z64_rom()).expect("rom fixture");
    let context = test_context(temp.path().join("n64-temp"));
    let mut temp_paths = Vec::new();

    let prepared = app()
        .prepare_patch_apply_input(PreparePatchApplyInputInputs {
            resolved_input: &input,
            strip_header: false,
            n64_byte_order: PatchN64ByteOrderMode::LittleEndian,
            inference: N64AutoInference::ChecksumOnly,
            first_patch: None,
            expected_crc32: None,
            repair_checksum: false,
            context: &context,
            temp_paths: &mut temp_paths,
        })
        .expect("prepared input");

    assert_ne!(prepared.apply_input, input);
    assert_eq!(
        prepared.n64_order,
        Some(N64ByteOrderTransform {
            from: N64ByteOrder::LittleEndian,
            to: N64ByteOrder::BigEndian,
        })
    );
    assert!(prepared.stripped_header.is_none());
    assert!(prepared.n64_order_note.is_none());
    assert!(temp_paths.contains(&prepared.apply_input));
    let rewritten = fs::read(&prepared.apply_input).expect("rewritten bytes");
    assert_eq!(&rewritten[..4], &[0x40, 0x12, 0x37, 0x80]);
    assert_eq!(rewritten.len(), 1024);
}

#[test]
fn keeping_the_n64_order_leaves_the_input_where_it_is() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.z64");
    fs::write(&input, z64_rom()).expect("rom fixture");
    let context = test_context(temp.path().join("n64-keep-temp"));
    let mut temp_paths = Vec::new();

    let prepared = app()
        .prepare_patch_apply_input(PreparePatchApplyInputInputs {
            resolved_input: &input,
            strip_header: false,
            n64_byte_order: PatchN64ByteOrderMode::Keep,
            inference: N64AutoInference::ChecksumOnly,
            first_patch: None,
            expected_crc32: None,
            repair_checksum: false,
            context: &context,
            temp_paths: &mut temp_paths,
        })
        .expect("prepared input");

    assert_eq!(prepared.apply_input, input);
    assert_eq!(
        prepared.n64_order,
        Some(N64ByteOrderTransform {
            from: N64ByteOrder::BigEndian,
            to: N64ByteOrder::BigEndian,
        })
    );
    assert!(temp_paths.is_empty());
}

#[test]
fn checksum_repair_normalizes_a_byte_swapped_input_to_big_endian() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let big_endian = z64_rom();
    let mut swapped = big_endian.clone();
    for word in swapped.chunks_exact_mut(4) {
        word.swap(0, 1);
        word.swap(2, 3);
    }
    let input = temp.path().join("game.v64");
    fs::write(&input, &swapped).expect("rom fixture");
    let context = test_context(temp.path().join("n64-repair-temp"));
    let mut temp_paths = Vec::new();

    let prepared = app()
        .prepare_patch_apply_input(PreparePatchApplyInputInputs {
            resolved_input: &input,
            strip_header: false,
            n64_byte_order: PatchN64ByteOrderMode::Keep,
            inference: N64AutoInference::ChecksumOnly,
            first_patch: None,
            expected_crc32: None,
            repair_checksum: true,
            context: &context,
            temp_paths: &mut temp_paths,
        })
        .expect("prepared input");

    assert_ne!(prepared.apply_input, input);
    assert_eq!(
        fs::read(&prepared.apply_input).expect("normalized bytes"),
        big_endian
    );
    // The reverse transform has to put the output back in byte-swapped order.
    assert_eq!(
        prepared.n64_order,
        Some(N64ByteOrderTransform {
            from: N64ByteOrder::BigEndian,
            to: N64ByteOrder::ByteSwapped,
        })
    );
}

#[test]
fn a_non_n64_input_with_an_explicit_order_is_rejected() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11; 1024]).expect("rom fixture");
    let context = test_context(temp.path().join("not-n64-temp"));
    let mut temp_paths = Vec::new();
    let app = app();

    let explicit = app.resolve_patch_n64_target(
        N64TargetRequest {
            input: &input,
            patch: None,
            expected_crc32: None,
            mode: PatchN64ByteOrderMode::BigEndian,
            inference: N64AutoInference::ChecksumOnly,
        },
        &context,
        &mut temp_paths,
    );
    let Err(error) = explicit else {
        panic!("an explicit order needs a detectable one to start from");
    };
    assert!(
        error
            .to_string()
            .contains("could not detect N64 byte order")
    );

    let ignored = app.resolve_patch_n64_target(
        N64TargetRequest {
            input: &input,
            patch: None,
            expected_crc32: None,
            mode: PatchN64ByteOrderMode::Auto,
            inference: N64AutoInference::ChecksumOnly,
        },
        &context,
        &mut temp_paths,
    );
    assert!(matches!(ignored, Ok(None)));
}

#[test]
fn an_auto_n64_target_without_evidence_keeps_the_current_order() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.z64");
    fs::write(&input, z64_rom()).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0x100, b"AAAA")])).expect("patch fixture");
    let context = test_context(temp.path().join("n64-auto-temp"));
    let mut temp_paths = Vec::new();

    let resolved = app()
        .resolve_patch_n64_target(
            N64TargetRequest {
                input: &input,
                patch: Some(&patch),
                expected_crc32: None,
                mode: PatchN64ByteOrderMode::Auto,
                inference: N64AutoInference::ChecksumOnly,
            },
            &context,
            &mut temp_paths,
        )
        .expect("auto resolution")
        .expect("an N64 input resolves");

    assert_eq!(resolved.source, N64ByteOrder::BigEndian);
    assert_eq!(resolved.target, N64ByteOrder::BigEndian);
    assert!(resolved.inferred_note.is_none());
    assert!(temp_paths.is_empty());
}

#[test]
fn a_chain_n64_mode_that_contradicts_the_planned_representation_is_rejected() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let mut current_input = temp.path().join("game.z64");
    fs::write(&current_input, z64_rom()).expect("rom fixture");
    let context = test_context(temp.path().join("n64-chain-temp"));
    let mut temp_paths = Vec::new();
    let mut state = None;

    let error = app()
        .transition_n64_byte_order(
            ChainN64TransitionPlan {
                mode: PatchN64ByteOrderMode::LittleEndian,
                base_variant: Some("n64-byte-swapped"),
                base_representation: Some(patch_plan::BaseRepresentation {
                    headerless: None,
                    n64_byte_order: Some(N64ByteOrder::ByteSwapped),
                }),
            },
            Path::new("fix.ips"),
            &mut current_input,
            &mut state,
            &context,
            &mut temp_paths,
        )
        .expect_err("an explicit order cannot contradict the planner");

    let message = error.to_string();
    assert!(
        message.contains("patch.base.n64_byte_order_mismatch"),
        "{message}"
    );
    assert!(state.is_none());
    assert!(temp_paths.is_empty());
}

#[test]
fn a_chain_step_follows_the_planner_selected_n64_representation() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let original = z64_rom();
    let mut current_input = temp.path().join("game.z64");
    fs::write(&current_input, &original).expect("rom fixture");
    let context = test_context(temp.path().join("n64-planned-temp"));
    let mut temp_paths = Vec::new();
    let mut state = None;

    app()
        .transition_n64_byte_order(
            ChainN64TransitionPlan {
                mode: PatchN64ByteOrderMode::Auto,
                base_variant: Some("n64-little-endian"),
                base_representation: Some(patch_plan::BaseRepresentation {
                    headerless: None,
                    n64_byte_order: Some(N64ByteOrder::LittleEndian),
                }),
            },
            Path::new("fix.ips"),
            &mut current_input,
            &mut state,
            &context,
            &mut temp_paths,
        )
        .expect("the planner-selected order is applied");

    assert_eq!(temp_paths.len(), 1);
    assert_eq!(current_input, temp_paths[0]);
    let rewritten = fs::read(&current_input).expect("rewritten bytes");
    assert_eq!(&rewritten[..4], &[0x40, 0x12, 0x37, 0x80]);
    // `to` records the order the output must be returned to.
    assert_eq!(
        state,
        Some(N64ByteOrderTransform {
            from: N64ByteOrder::LittleEndian,
            to: N64ByteOrder::BigEndian,
        })
    );
}

#[test]
fn a_chain_step_verifies_an_intermediate_against_its_declared_state() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let state_path = temp.path().join("step.bin");
    fs::write(&state_path, b"0123456789").expect("intermediate fixture");
    let context = test_context(temp.path().join("chain-step-temp"));

    CliApp::verify_chain_step_state(&state_path, &patch_plan::PlanState::default(), &context)
        .expect("an empty declaration always passes");

    let matching = patch_plan::PlanState {
        checksums: BTreeMap::from([("crc32".to_string(), "a684c7c6".to_string())]),
        size: Some(10),
    };
    CliApp::verify_chain_step_state(&state_path, &matching, &context)
        .expect("the declared size and checksum match");

    let wrong_size = patch_plan::PlanState {
        checksums: BTreeMap::new(),
        size: Some(11),
    };
    assert!(CliApp::verify_chain_step_state(&state_path, &wrong_size, &context).is_err());

    let wrong_checksum = patch_plan::PlanState {
        checksums: BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]),
        size: None,
    };
    assert!(CliApp::verify_chain_step_state(&state_path, &wrong_checksum, &context).is_err());
}

#[test]
fn probing_an_unhandled_patch_names_both_the_original_and_resolved_paths() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let requested = temp.path().join("bundle.zip");
    let resolved = temp.path().join("member.bin");
    fs::write(&resolved, b"not a patch").expect("fixture");
    let app = app();

    let Err(report) = app.probe_patch_handler(&requested, &resolved, 1, 3, None) else {
        panic!("no handler matches raw bytes");
    };
    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.stage, "probe");
    assert!(report.label.contains("patch 2/3"));
    assert!(report.label.contains("resolved from"));
    assert!(report.label.contains("no registered patch handler matched"));

    let Err(direct) = app.probe_patch_handler(&resolved, &resolved, 0, 1, None) else {
        panic!("no handler matches raw bytes");
    };
    assert!(!direct.label.contains("resolved from"));
}

#[test]
fn probing_a_real_patch_returns_its_handler() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"AB")])).expect("patch fixture");

    let handler = app()
        .probe_patch_handler(&patch, &patch, 0, 1, None)
        .expect("IPS is a registered patch format");

    assert_eq!(handler.descriptor().name, "IPS");
}

#[test]
fn resolving_patches_passes_plain_files_through_unchanged() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let first = temp.path().join("one.ips");
    let second = temp.path().join("two.ips");
    fs::write(&first, ips_patch(&[(0, b"A")])).expect("patch fixture");
    fs::write(&second, ips_patch(&[(1, b"B")])).expect("patch fixture");
    let context = test_context(temp.path().join("resolve-temp"));
    let mut temp_paths = Vec::new();

    let (resolved, notes) = app()
        .resolve_patches(
            &[first.clone(), second.clone()],
            &[],
            &context,
            AutoExtractResolutionFlags {
                no_extract: true,
                no_ignore: false,
                kind_filter: ArchiveEntryKindFilter::default(),
                stop_on_single_payload_codec: false,
            },
            PatchResolveLabels {
                command: "patch-apply",
                noun: "patch apply",
                temp_prefix: "patch-apply-patch-extract",
            },
            &mut temp_paths,
        )
        .expect("plain patch files resolve to themselves");

    assert_eq!(
        resolved,
        vec![(first.clone(), first), (second.clone(), second)]
    );
    assert!(notes.is_empty());
    assert!(temp_paths.is_empty());
}

#[test]
fn a_patch_without_an_embedded_source_checksum_offers_none() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"AB")])).expect("patch fixture");
    let context = test_context(temp.path().join("embedded-temp"));
    let app = app();

    assert!(app.embedded_patch_source_crc32(&patch, &context).is_none());
    assert!(
        app.embedded_patch_source_crc32(&temp.path().join("absent.ips"), &context)
            .is_none()
    );
}

#[test]
fn a_readers_crc32_is_the_lowercase_engine_formatted_digest() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let context = test_context(temp.path().join("crc-temp"));
    let mut reader = io::Cursor::new(b"0123456789".to_vec());

    let crc = CliApp::crc32_of_reader(&mut reader, &context).expect("crc32");

    assert_eq!(crc.as_deref(), Some("a684c7c6"));
}

fn header_state(header: Option<KnownRomHeader>) -> ChainHeaderState {
    ChainHeaderState {
        headerless: header.is_some(),
        stripped_header: header.map(|_| vec![0_u8; ROM_HEADER_BYTES]),
        stripped_header_match: header.map(|header| KnownRomHeaderMatch {
            header,
            stripped_bytes: Some(ROM_HEADER_BYTES),
        }),
    }
}

#[test]
fn a_header_that_was_never_touched_leaves_the_output_extension_alone() {
    assert!(
        CliApp::resolve_header_extension_swap(
            Path::new("out.sfc"),
            &header_state(None),
            false,
            false,
            Path::new("in.sfc"),
        )
        .is_none()
    );
}

#[test]
fn a_stripped_snes_copier_header_swaps_smc_for_sfc_on_the_output() {
    let (swapped, note) = CliApp::resolve_header_extension_swap(
        Path::new("/roms/out.smc"),
        &header_state(Some(KnownRomHeader::SnesCopier)),
        false,
        false,
        Path::new("/roms/in.smc"),
    )
    .expect("a headerless output renames .smc to .sfc");

    assert_eq!(swapped, PathBuf::from("/roms/out.sfc"));
    assert!(note.contains(".smc -> .sfc"));
    assert!(note.contains("headerless output"));
}

#[test]
fn re_adding_a_snes_copier_header_swaps_sfc_for_smc_on_the_output() {
    let (swapped, note) = CliApp::resolve_header_extension_swap(
        Path::new("/roms/out.sfc"),
        &header_state(Some(KnownRomHeader::SnesCopier)),
        true,
        false,
        Path::new("/roms/in.smc"),
    )
    .expect("a re-headered output renames .sfc to .smc");

    assert_eq!(swapped, PathBuf::from("/roms/out.smc"));
    assert!(note.contains(".sfc -> .smc"));
    assert!(note.contains("headered output"));
}

#[test]
fn an_unrelated_output_extension_is_never_swapped() {
    assert!(
        CliApp::resolve_header_extension_swap(
            Path::new("/roms/out.bin"),
            &header_state(Some(KnownRomHeader::SnesCopier)),
            false,
            false,
            Path::new("/roms/in.smc"),
        )
        .is_none()
    );
}

#[test]
fn a_header_whose_two_extensions_agree_is_never_swapped() {
    // iNES keeps `.nes` with and without its header, so there is nothing to
    // swap even though a header was stripped.
    assert!(
        CliApp::resolve_header_extension_swap(
            Path::new("/roms/out.nes"),
            &header_state(Some(KnownRomHeader::Nes)),
            false,
            false,
            Path::new("/roms/in.nes"),
        )
        .is_none()
    );
}

#[test]
fn an_explicit_output_strip_detects_the_header_from_the_source_file() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let headered = temp.path().join("in.smc");
    let mut bytes = vec![0_u8; ROM_HEADER_BYTES];
    bytes.extend(std::iter::repeat_n(0x5a_u8, 32 * 1024));
    fs::write(&headered, bytes).expect("headered fixture");

    let (swapped, note) = CliApp::resolve_header_extension_swap(
        &temp.path().join("out.smc"),
        &header_state(None),
        false,
        true,
        &headered,
    )
    .expect("an explicit output strip renames .smc to .sfc");

    assert_eq!(swapped, temp.path().join("out.sfc"));
    assert!(note.contains("headerless output"));
}

#[test]
fn applying_one_ips_patch_infers_an_output_name_beside_the_input() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");

    let (outcome, terminal) = run_apply(apply_command(&input, vec![patch]));

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert_eq!(terminal.format.as_deref(), Some("IPS"));
    let patched = fs::read(temp.path().join("game-patched.sfc")).expect("inferred output");
    let mut expected = vec![0x11_u8; 64];
    expected[4..8].copy_from_slice(b"ZZZZ");
    assert_eq!(patched, expected);
    assert_eq!(fs::read(&input).expect("input untouched").len(), 64);
}

#[test]
fn a_two_patch_chain_stages_the_intermediate_and_writes_one_output() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let first = temp.path().join("one.ips");
    fs::write(&first, ips_patch(&[(4, b"AAAA")])).expect("patch fixture");
    let second = temp.path().join("two.ips");
    fs::write(&second, ips_patch(&[(8, b"BBBB")])).expect("patch fixture");
    let output = temp.path().join("out.sfc");
    let mut args = apply_command(&input, vec![first, second]);
    args.output = Some(output.clone());

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert!(terminal.label.contains("2 patch"));
    let mut expected = vec![0x11_u8; 64];
    expected[4..8].copy_from_slice(b"AAAA");
    expected[8..12].copy_from_slice(b"BBBB");
    assert_eq!(fs::read(&output).expect("chained output"), expected);
}

#[test]
fn an_apply_with_no_patch_and_no_code_is_rejected() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let mut args = apply_command(&input, Vec::new());
    args.output = Some(temp.path().join("out.sfc"));

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(
        terminal
            .label
            .contains("requires at least one --patch file")
    );
    assert!(!temp.path().join("out.sfc").exists());
}

#[test]
fn an_apply_against_a_missing_input_never_writes_an_output() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let output = temp.path().join("out.sfc");
    let mut args = apply_command(&temp.path().join("absent.sfc"), vec![patch]);
    args.output = Some(output.clone());

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("absent.sfc"));
    assert!(!output.exists());
}

#[test]
fn a_mismatched_expected_input_checksum_stops_the_apply() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let output = temp.path().join("out.sfc");
    let mut args = apply_command(&input, vec![patch]);
    args.output = Some(output.clone());
    args.expect_in = vec!["crc32=deadbeef".to_string()];

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.to_lowercase().contains("crc32"));
    assert!(!output.exists());
}

#[test]
fn a_mismatched_expected_output_checksum_fails_after_the_apply() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let output = temp.path().join("out.sfc");
    let mut args = apply_command(&input, vec![patch]);
    args.output = Some(output.clone());
    args.expect_out = vec!["crc32=deadbeef".to_string()];

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.to_lowercase().contains("crc32"));
}

#[test]
fn an_apply_compresses_its_output_when_a_container_format_is_requested() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let output = temp.path().join("out.zip");
    let mut args = apply_command(&input, vec![patch]);
    args.output = Some(output.clone());
    args.no_compress = false;
    args.compress_format = Some("zip".to_string());

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert_eq!(terminal.stage, "compress");
    assert!(terminal.label.contains("patch output compressed as zip"));
    assert!(output.is_file());
}

#[test]
fn an_apply_refuses_an_output_that_already_exists() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let output = temp.path().join("out.sfc");
    fs::write(&output, b"already here").expect("existing output");
    let mut args = apply_command(&input, vec![patch]);
    args.output = Some(output.clone());

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("--force"));
    assert_eq!(fs::read(&output).expect("untouched"), b"already here");
}

#[test]
fn a_target_flag_needs_a_disc_sheet_input() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let mut args = apply_command(&input, vec![patch]);
    args.output = Some(temp.path().join("out.sfc"));
    args.target = Some("track01".to_string());

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("--target requires a disc-sheet"));
}

#[test]
fn a_rom_name_mismatch_is_advisory_and_never_stops_the_run() {
    // The bundle's declared name is compared case-insensitively; a mismatch only
    // warns, so the contract here is that no branch panics or returns.
    warn_on_rom_name_mismatch(None, Path::new("game.sfc"));
    warn_on_rom_name_mismatch(Some("GAME.SFC"), Path::new("game.sfc"));
    warn_on_rom_name_mismatch(Some("other.sfc"), Path::new("game.sfc"));
    warn_on_rom_name_mismatch(Some("game.sfc"), Path::new("/"));
}

fn requirements(pairs: &[(&str, &str)], size: Option<u64>) -> FilenameRequirements {
    FilenameRequirements {
        checksums: pairs
            .iter()
            .map(|(algorithm, hex)| ((*algorithm).to_string(), (*hex).to_string()))
            .collect(),
        size,
    }
}

fn bundle_resolution(
    checks: Vec<(String, FilenameRequirements)>,
    output_checks: Option<(String, FilenameRequirements)>,
) -> BundleApplyResolution {
    BundleApplyResolution {
        checks,
        expected_rom_name: None,
        output_checks,
        step_verifications: Vec::new(),
    }
}

#[test]
fn a_bundle_output_check_that_contradicts_expect_out_is_rejected() {
    let mut expected_input = BTreeMap::new();
    let mut expected_size = None;
    let mut expected_output = BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]);
    let resolution = bundle_resolution(
        Vec::new(),
        Some((
            "bundle output.checks".to_string(),
            requirements(&[("crc32", "a684c7c6")], None),
        )),
    );

    let report = app()
        .merge_patch_apply_bundle_requirements(
            &resolution,
            false,
            &mut expected_input,
            &mut expected_size,
            &mut expected_output,
            None,
        )
        .expect("a contradicting output check must fail");

    assert_eq!(report.status, OperationStatus::Failed);
    assert_eq!(report.stage, "validate");
    assert!(report.label.contains("bundle output.checks"));
    assert!(report.label.contains("was already requested"));
    assert_eq!(
        expected_output.get("crc32").map(String::as_str),
        Some("deadbeef")
    );
}

#[test]
fn a_bundle_output_check_fills_in_what_expect_out_left_open() {
    let mut expected_input = BTreeMap::new();
    let mut expected_size = None;
    let mut expected_output = BTreeMap::from([("crc32".to_string(), "a684c7c6".to_string())]);
    let resolution = bundle_resolution(
        vec![(
            "bundle rom.checks".to_string(),
            requirements(&[("md5", &"ab".repeat(16))], Some(64)),
        )],
        Some((
            "bundle output.checks".to_string(),
            requirements(&[("crc32", "a684c7c6"), ("sha1", &"cd".repeat(20))], None),
        )),
    );

    assert!(
        app()
            .merge_patch_apply_bundle_requirements(
                &resolution,
                false,
                &mut expected_input,
                &mut expected_size,
                &mut expected_output,
                None,
            )
            .is_none()
    );

    assert_eq!(
        expected_input.get("md5").map(String::as_str),
        Some(&"ab".repeat(16)[..])
    );
    assert_eq!(expected_size, Some(64));
    assert_eq!(expected_output.len(), 2);
    assert_eq!(
        expected_output.get("sha1").map(String::as_str),
        Some(&"cd".repeat(20)[..])
    );
}

#[test]
fn a_disc_apply_drops_the_bundle_output_checks_it_cannot_verify() {
    let mut expected_input = BTreeMap::new();
    let mut expected_size = None;
    let mut expected_output = BTreeMap::new();
    let resolution = bundle_resolution(
        Vec::new(),
        Some((
            "bundle output.checks".to_string(),
            requirements(&[("crc32", "a684c7c6")], None),
        )),
    );

    assert!(
        app()
            .merge_patch_apply_bundle_requirements(
                &resolution,
                true,
                &mut expected_input,
                &mut expected_size,
                &mut expected_output,
                None,
            )
            .is_none()
    );

    assert!(expected_output.is_empty());
}

#[test]
fn a_container_that_cannot_be_written_fails_the_compress_stage() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    // The staged payload MUST already carry the archive entry name the
    // requested output implies (`out.zip` -> `out.sfc`), or staging rejects it
    // before the container is ever created.
    let raw_ready = temp.path().join("out.sfc");
    fs::write(&raw_ready, b"patched bytes").expect("patched fixture");
    // The plan resolves, but a directory already sits on the output path, so
    // the container handler is the thing that fails.
    let requested = temp.path().join("out.zip");
    fs::create_dir(&requested).expect("directory in the way");
    let context = test_context(temp.path().join("create-fail-temp"));
    let mut report = OperationReport::succeeded(
        OperationFamily::Patch,
        Some("IPS".to_string()),
        "apply",
        "applied 1 patch".to_string(),
        None,
        None,
    );
    let mut temp_paths = Vec::new();
    let mut terminal_output_path = requested.clone();
    let mut terminal_output_source = raw_ready.clone();

    let failure = app()
        .compress_patch_apply_output(PatchApplyCompressionInputs {
            report: &mut report,
            compression_options: &compression_options(Some("zip")),
            output: &requested,
            output_was_inferred: false,
            resolved_input: &raw_ready,
            is_disc: false,
            raw_ready_output: &raw_ready,
            disc_track_overrides: &[],
            context: &context,
            temp_paths: &mut temp_paths,
            terminal_output_path: &mut terminal_output_path,
            terminal_output_source: &mut terminal_output_source,
        })
        .expect("an unwritable container path must fail the compress stage");

    assert_eq!(failure.status, OperationStatus::Failed);
    assert_eq!(failure.stage, "compress");
    assert!(
        failure.label.contains("patch output compression failed"),
        "{}",
        failure.label
    );
}

#[test]
fn an_inferred_output_is_compressed_through_a_staged_container() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let raw_ready = temp.path().join("game-patched.sfc");
    fs::write(&raw_ready, b"patched bytes").expect("patched fixture");
    let resolved_input = temp.path().join("game.sfc");
    fs::write(&resolved_input, b"rom bytes").expect("rom fixture");
    let requested = temp.path().join("game-patched.zip");
    let context = test_context(temp.path().join("inferred-compress-temp"));
    let mut report = OperationReport::succeeded(
        OperationFamily::Patch,
        Some("IPS".to_string()),
        "apply",
        "applied 1 patch".to_string(),
        None,
        None,
    );
    let mut temp_paths = Vec::new();
    let mut terminal_output_path = requested.clone();
    let mut terminal_output_source = raw_ready.clone();

    let failure = app().compress_patch_apply_output(PatchApplyCompressionInputs {
        report: &mut report,
        compression_options: &compression_options(Some("zip")),
        output: &requested,
        output_was_inferred: true,
        resolved_input: &resolved_input,
        is_disc: false,
        raw_ready_output: &raw_ready,
        disc_track_overrides: &[],
        context: &context,
        temp_paths: &mut temp_paths,
        terminal_output_path: &mut terminal_output_path,
        terminal_output_source: &mut terminal_output_source,
    });

    assert!(failure.is_none(), "compression failed: {failure:?}");
    // An inferred output is written under a private stage and only published
    // once the run succeeds, so the requested path must still be free.
    assert!(!requested.exists());
    assert_eq!(terminal_output_path, requested);
    assert_ne!(terminal_output_source, raw_ready);
    assert!(terminal_output_source.is_file());
    assert!(temp_paths.contains(&terminal_output_source));
}

#[test]
fn stripping_a_header_that_is_not_there_fails_the_compat_stage() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let output = temp.path().join("out.sfc");
    let mut args = apply_command(&input, vec![patch]);
    args.output = Some(output.clone());
    args.patch_header = vec![PatchApplyHeaderMode::Strip];

    let (outcome, terminal) = run_apply(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "compat");
    assert!(
        terminal
            .label
            .contains("could not detect a supported removable ROM header"),
        "{}",
        terminal.label
    );
    assert!(!output.exists());
}

fn cue_fixture(temp: &Path) -> PathBuf {
    let track = temp.join("track01.bin");
    fs::write(&track, vec![0x22_u8; 2352 * 8]).expect("track fixture");
    let sheet = temp.join("disc.cue");
    fs::write(
        &sheet,
        "FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
    )
    .expect("cue fixture");
    sheet
}

fn disc_inputs<'a>(sheet: &'a Path, context: &'a OperationContext) -> PatchApplyDiscInputs<'a> {
    PatchApplyDiscInputs {
        input: sheet,
        target: None,
        patches: &[],
        ignore_checksum_validation: true,
        any_explicit_strip: false,
        output_header: None,
        repair_checksum: false,
        any_explicit_n64_transform: false,
        has_expected_output_checksums: false,
        context,
    }
}

#[test]
fn a_disc_sheet_input_resolves_to_its_single_track() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let sheet = cue_fixture(temp.path());
    let context = test_context(temp.path().join("disc-temp"));

    let disc = app()
        .resolve_patch_apply_disc(disc_inputs(&sheet, &context))
        .expect("a cue sheet resolves")
        .expect("a cue sheet is a disc input");

    assert_eq!(disc.target_file, temp.path().join("track01.bin"));
}

#[test]
fn a_disc_apply_rejects_the_rom_compatibility_transforms() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let sheet = cue_fixture(temp.path());
    let context = test_context(temp.path().join("disc-reject-temp"));
    let app = app();

    for mutate in [
        (|inputs: &mut PatchApplyDiscInputs<'_>| inputs.any_explicit_strip = true)
            as fn(&mut PatchApplyDiscInputs<'_>),
        |inputs| inputs.output_header = Some(PatchApplyOutputHeaderMode::Strip),
        |inputs| inputs.repair_checksum = true,
        |inputs| inputs.any_explicit_n64_transform = true,
    ] {
        let mut inputs = disc_inputs(&sheet, &context);
        mutate(&mut inputs);
        let report = app
            .resolve_patch_apply_disc(inputs)
            .err()
            .expect("a disc apply rejects ROM header and N64 transforms");
        assert_eq!(report.status, OperationStatus::Failed);
        assert!(
            report.label.contains("disc patch apply"),
            "{}",
            report.label
        );
    }
}

#[test]
fn a_disc_apply_rejects_expect_out_because_it_writes_several_files() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let sheet = cue_fixture(temp.path());
    let context = test_context(temp.path().join("disc-expect-out-temp"));
    let mut inputs = disc_inputs(&sheet, &context);
    inputs.has_expected_output_checksums = true;

    let report = app()
        .resolve_patch_apply_disc(inputs)
        .err()
        .expect("a disc apply cannot honour --expect-out");

    assert_eq!(report.status, OperationStatus::Failed);
    assert!(report.label.contains("--expect-out"), "{}", report.label);
}

#[test]
fn an_explicit_output_path_is_used_exactly_as_given() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let requested = temp.path().join("chosen.bin");

    let (output, was_inferred) = app()
        .resolve_patch_apply_output_path(
            Some(requested.clone()),
            &input,
            &input,
            false,
            Some("zip"),
        )
        .expect("an explicit output is kept");

    assert_eq!(output, requested);
    assert!(!was_inferred);
}

#[test]
fn an_inferred_output_path_follows_the_requested_container_extension() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");
    let app = app();

    let (raw, was_inferred) = app
        .resolve_patch_apply_output_path(None, &input, &input, true, Some("zip"))
        .expect("--no-compress keeps the ROM extension");
    assert_eq!(raw, temp.path().join("game-patched.sfc"));
    assert!(was_inferred);

    let (without_format, _) = app
        .resolve_patch_apply_output_path(None, &input, &input, false, None)
        .expect("no requested format keeps the ROM extension");
    assert_eq!(without_format, temp.path().join("game-patched.sfc"));

    let (zipped, was_inferred) = app
        .resolve_patch_apply_output_path(None, &input, &input, false, Some("zip"))
        .expect("a requested container renames the inferred output");
    assert_eq!(zipped, temp.path().join("game-patched.zip"));
    assert!(was_inferred);
}

#[test]
fn an_inferred_output_path_rejects_an_unregistered_container_format() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, b"rom bytes").expect("rom fixture");

    let error = app()
        .resolve_patch_apply_output_path(
            None,
            &input,
            &input,
            false,
            Some("definitely-not-a-format"),
        )
        .expect_err("an unregistered format cannot name an output");

    assert!(
        error
            .to_string()
            .contains("requested output format is not registered")
    );
}

#[test]
fn the_staged_output_path_follows_what_the_run_still_has_to_do() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let resolved_input = temp.path().join("game.sfc");
    fs::write(&resolved_input, b"rom bytes").expect("rom fixture");
    let output = temp.path().join("out.sfc");
    let context = test_context(temp.path().join("staged-temp"));
    let mut temp_paths = Vec::new();

    let direct = CliApp::patch_apply_staged_output(
        &output,
        &resolved_input,
        false,
        false,
        false,
        &context,
        &mut temp_paths,
    )
    .expect("nothing to finalize writes straight to the output");
    assert_eq!(direct, output);
    assert!(temp_paths.is_empty());

    let staged = CliApp::patch_apply_staged_output(
        &output,
        &resolved_input,
        false,
        true,
        false,
        &context,
        &mut temp_paths,
    )
    .expect("a finalize step needs a stage");
    assert_ne!(staged, output);
    assert_eq!(temp_paths, vec![staged.clone()]);

    let inferred = CliApp::patch_apply_staged_output(
        &output,
        &resolved_input,
        true,
        false,
        false,
        &context,
        &mut temp_paths,
    )
    .expect("an inferred output is always staged");
    // The staged file keeps the archive entry name, so its private directory is
    // what gets cleaned up.
    assert_eq!(inferred.file_name(), output.file_name());
    assert_ne!(inferred, output);
    let entry_dir = inferred.parent().expect("staged entry directory");
    assert!(temp_paths.iter().any(|path| path == entry_dir));
}

#[test]
fn auto_header_stripping_keeps_an_input_that_carries_no_header() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let context = test_context(temp.path().join("auto-header-temp"));
    let mut temp_paths = Vec::new();

    let (strip, note) = app().auto_header_strip_decision(
        &input,
        None,
        &BTreeMap::new(),
        &BTreeMap::new(),
        &context,
        &mut temp_paths,
    );

    assert!(!strip);
    assert!(note.is_none());
    assert!(temp_paths.is_empty());
}

#[test]
fn auto_header_stripping_keeps_a_header_no_checksum_argues_against() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.smc");
    let mut bytes = vec![0_u8; ROM_HEADER_BYTES];
    bytes.extend(std::iter::repeat_n(0x5a_u8, 32 * 1024));
    fs::write(&input, bytes).expect("headered fixture");
    let context = test_context(temp.path().join("auto-header-headered-temp"));
    let mut temp_paths = Vec::new();

    // The declared checksum matches the raw headered bytes, so the header stays.
    let raw_crc32 = checksum_file_values(&input, &["crc32"], &context)
        .expect("raw checksum")
        .remove("crc32")
        .expect("crc32 value");
    let expected = BTreeMap::from([("crc32".to_string(), raw_crc32)]);

    let (strip, note) = app().auto_header_strip_decision(
        &input,
        None,
        &expected,
        &BTreeMap::new(),
        &context,
        &mut temp_paths,
    );

    assert!(!strip);
    assert!(note.is_none());
}

#[test]
fn auto_header_stripping_strips_when_the_headerless_bytes_are_the_proven_basis() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.smc");
    let mut bytes = vec![0_u8; ROM_HEADER_BYTES];
    bytes.extend(std::iter::repeat_n(0x5a_u8, 32 * 1024));
    fs::write(&input, &bytes).expect("headered fixture");
    let headerless = temp.path().join("headerless.sfc");
    fs::write(&headerless, &bytes[ROM_HEADER_BYTES..]).expect("headerless fixture");
    let context = test_context(temp.path().join("auto-header-strip-temp"));
    let mut temp_paths = Vec::new();

    let headerless_crc32 = checksum_file_values(&headerless, &["crc32"], &context)
        .expect("headerless checksum")
        .remove("crc32")
        .expect("crc32 value");
    let expected = BTreeMap::from([("crc32".to_string(), headerless_crc32)]);

    let (strip, note) = app().auto_header_strip_decision(
        &input,
        None,
        &expected,
        &BTreeMap::new(),
        &context,
        &mut temp_paths,
    );

    assert!(strip);
    // Proof carries no report note; only structural evidence does.
    assert!(note.is_none());
}

#[test]
fn a_staged_payload_whose_name_is_not_the_archive_entry_name_is_refused() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let raw_ready = temp.path().join("something-else.sfc");
    fs::write(&raw_ready, b"patched bytes").expect("patched fixture");
    let requested = temp.path().join("out.zip");
    let context = test_context(temp.path().join("entry-name-temp"));
    let mut report = OperationReport::succeeded(
        OperationFamily::Patch,
        Some("IPS".to_string()),
        "apply",
        "applied 1 patch".to_string(),
        None,
        None,
    );
    let mut temp_paths = Vec::new();
    let mut terminal_output_path = requested.clone();
    let mut terminal_output_source = raw_ready.clone();

    let failure = app()
        .compress_patch_apply_output(PatchApplyCompressionInputs {
            report: &mut report,
            compression_options: &compression_options(Some("zip")),
            output: &requested,
            output_was_inferred: false,
            resolved_input: &raw_ready,
            is_disc: false,
            raw_ready_output: &raw_ready,
            disc_track_overrides: &[],
            context: &context,
            temp_paths: &mut temp_paths,
            terminal_output_path: &mut terminal_output_path,
            terminal_output_source: &mut terminal_output_source,
        })
        .expect("a mismatched entry name must fail the compress stage");

    assert_eq!(failure.status, OperationStatus::Failed);
    assert_eq!(failure.stage, "compress");
    assert!(
        failure
            .label
            .contains("does not match archive entry name `out.sfc`"),
        "{}",
        failure.label
    );
    assert!(!requested.exists());
}
