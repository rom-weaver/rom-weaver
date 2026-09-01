use super::*;

/// Applies to `abcabcabcabc` and produces `abcabcZZabcabc`; against any other
/// ROM its embedded source CRC32 fails, which is what makes it usable as both
/// the passing and the failing fixture here.
const SIMPLE_BPS_PATCH: [u8; 25] = [
    0x42, 0x50, 0x53, 0x31, 0x8C, 0x8E, 0x80, 0x94, 0x85, 0x5A, 0x5A, 0x96, 0x8C, 0x34, 0x2A, 0x6E,
    0x5A, 0xB9, 0x87, 0x43, 0x50, 0xB0, 0xFC, 0x51, 0xA7,
];
const BPS_SOURCE: &[u8] = b"abcabcabcabc";

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

fn z64_rom() -> Vec<u8> {
    let mut bytes = vec![0x80, 0x37, 0x12, 0x40];
    bytes.extend((0..1020_u32).map(|index| (index % 251) as u8));
    bytes
}

/// A SNES copier header is size-and-name based: `.smc` whose length is a
/// 32 KiB multiple plus the 512-byte header.
fn headered_snes_rom() -> Vec<u8> {
    let mut bytes = vec![0_u8; ROM_HEADER_BYTES];
    bytes.extend(std::iter::repeat_n(0x5a_u8, 32 * 1024));
    bytes
}

fn validate_command(input: &Path, patches: Vec<PathBuf>) -> PatchValidateCommand {
    PatchValidateCommand {
        input: input.to_path_buf(),
        select: Vec::new(),
        filter: Vec::new(),
        no_extract: true,
        no_ignore: false,
        patches,
        assume_in: Vec::new(),
        expect_in: Vec::new(),
        strip_header: false,
        n64_byte_order: None,
        ignore_checksum_validation: false,
        independent: false,
        plan: false,
        patch_basis: Vec::new(),
        patch_input_check: Vec::new(),
        patch_output_check: Vec::new(),
        threads: ThreadBudget::Fixed(1),
    }
}

/// Run a full `patch validate` and hand back the command's own terminal report
/// event, so a verdict can be asserted by reason rather than by status alone.
fn run_validate(args: PatchValidateCommand) -> (AppRunOutcome, ProgressEvent) {
    let recorder = Arc::new(rom_weaver_core::RecordingProgressSink::default());
    let app = CliApp::new(
        recorder.clone(),
        Arc::new(rom_weaver_core::NoninteractivePrompter),
        true,
        false,
        false,
    );
    let outcome = app.run_patch_validate(args);
    let terminal = recorder
        .snapshot()
        .into_iter()
        .rfind(|event| {
            event.command == "patch-validate" && event.status != OperationStatus::Running
        })
        .expect("a terminal patch-validate event");
    (outcome, terminal)
}

fn validation_details(event: &ProgressEvent) -> Value {
    event
        .details
        .as_ref()
        .and_then(|details| details.get("patch_validation"))
        .cloned()
        .unwrap_or_else(|| panic!("no patch_validation details on {}", event.label))
}

#[test]
fn validating_one_ips_patch_reports_its_format_and_source_values() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.sfc");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");

    let (outcome, terminal) = run_validate(validate_command(&input, vec![patch]));

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert_eq!(terminal.format.as_deref(), Some("IPS"));
    assert!(
        terminal
            .label
            .contains("patch validation passed for 1 patch(es) (IPS)"),
        "{}",
        terminal.label
    );
    let details = validation_details(&terminal);
    assert_eq!(details["status"], json!("passed"));
    assert_eq!(details["patch_count"], json!(1));
    assert_eq!(details["formats"], json!(["IPS"]));
    assert_eq!(details["preflight"], json!(true));
}

#[test]
fn a_two_patch_chain_validates_each_step_against_the_previous_output() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let first = temp.path().join("step-1.bps");
    fs::write(&first, SIMPLE_BPS_PATCH).expect("bps fixture");
    // The second patch only fits the 14-byte BPS output, so it can pass only if
    // the chain fed it the intermediate rather than the original input.
    let second = temp.path().join("step-2.ips");
    fs::write(&second, ips_patch(&[(12, b"QQ")])).expect("ips fixture");

    let (outcome, terminal) = run_validate(validate_command(&input, vec![first, second]));

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert!(terminal.label.contains("2 patch(es)"), "{}", terminal.label);
    let details = validation_details(&terminal);
    assert_eq!(details["formats"], json!(["BPS", "IPS"]));
    assert_eq!(details["format"], json!("IPS"));
}

#[test]
fn a_patch_whose_source_checksum_misses_fails_validation() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("other.bin");
    fs::write(&input, b"not the authored source").expect("rom fixture");
    let patch = temp.path().join("update.bps");
    fs::write(&patch, SIMPLE_BPS_PATCH).expect("bps fixture");

    let (outcome, terminal) = run_validate(validate_command(&input, vec![patch]));

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "validate");
    assert_eq!(terminal.format.as_deref(), Some("BPS"));
}

#[test]
fn a_format_without_preflight_support_is_reported_unsupported() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("hack.rup");
    fs::write(&patch, b"NINJA1 payload that never parses").expect("ninja fixture");

    let (outcome, terminal) = run_validate(validate_command(&input, vec![patch]));

    assert_eq!(outcome.status, OperationStatus::Unsupported);
    assert_eq!(terminal.format.as_deref(), Some("NINJA1"));
    assert!(
        terminal.label.contains("does not support patch preflight"),
        "{}",
        terminal.label
    );
}

#[test]
fn a_file_no_patch_handler_claims_fails_the_probe() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("notes.bin");
    fs::write(&patch, b"just bytes").expect("fixture");

    let (outcome, terminal) = run_validate(validate_command(&input, vec![patch]));

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "probe");
    assert!(
        terminal
            .label
            .contains("no registered patch handler matched"),
        "{}",
        terminal.label
    );
}

#[test]
fn validation_requires_at_least_one_patch() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");

    let (outcome, terminal) = run_validate(validate_command(&input, Vec::new()));

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(
        terminal.label.contains("at least one --patch value"),
        "{}",
        terminal.label
    );
}

#[test]
fn an_unreadable_input_stops_before_any_patch_is_opened() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");

    let (outcome, terminal) = run_validate(validate_command(
        &temp.path().join("absent.bin"),
        vec![patch],
    ));

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("absent.bin"), "{}", terminal.label);
}

#[test]
fn an_unreadable_patch_stops_the_run() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");

    let (outcome, terminal) = run_validate(validate_command(
        &input,
        vec![temp.path().join("absent.ips")],
    ));

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("absent.ips"), "{}", terminal.label);
}

#[test]
fn a_malformed_assume_in_token_is_rejected_before_anything_is_hashed() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.assume_in = vec!["crc32=not-hex".to_string()];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "validate");
    assert!(terminal.label.contains("--assume-in"), "{}", terminal.label);
}

#[test]
fn a_malformed_expect_in_token_is_rejected_before_anything_is_hashed() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.expect_in = vec!["nonsense".to_string()];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(terminal.label.contains("--expect-in"), "{}", terminal.label);
}

#[test]
fn stripping_a_header_that_is_not_there_fails_the_compat_stage() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.strip_header = true;

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "compat");
    assert!(
        terminal
            .label
            .contains("could not detect a supported removable ROM header"),
        "{}",
        terminal.label
    );
}

#[test]
fn stripping_a_copier_header_validates_the_headerless_bytes() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.smc");
    fs::write(&input, headered_snes_rom()).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.strip_header = true;

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert_eq!(terminal.format.as_deref(), Some("IPS"));
}

#[test]
fn an_explicit_n64_order_rewrites_the_input_before_validating() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.z64");
    fs::write(&input, z64_rom()).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(4, b"ZZZZ")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.n64_byte_order = Some(PatchN64ByteOrderMode::LittleEndian);

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    assert!(
        terminal.label.contains("n64_byte_order=little-endian"),
        "{}",
        terminal.label
    );
    // The transform is applied to a temp copy only.
    assert_eq!(fs::read(&input).expect("input untouched"), z64_rom());
}

#[test]
fn an_explicit_n64_order_on_a_non_n64_input_fails_the_compat_stage() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.n64_byte_order = Some(PatchN64ByteOrderMode::BigEndian);

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "compat");
    assert!(
        terminal.label.contains("could not detect N64 byte order"),
        "{}",
        terminal.label
    );
}

#[test]
fn an_expected_input_size_that_disagrees_fails_validation() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.expect_in = vec!["size=128".to_string()];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "validate");
    assert!(terminal.label.contains("128"), "{}", terminal.label);
}

#[test]
fn an_expected_input_size_that_agrees_is_reported() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.expect_in = vec!["size=64".to_string()];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    assert_eq!(details["source_values"]["size"], json!(64));
}

#[test]
fn an_expected_input_checksum_that_disagrees_fails_validation() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, vec![0x11_u8; 64]).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.expect_in = vec!["crc32=deadbeef".to_string()];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert_eq!(terminal.stage, "validate");
    assert!(terminal.label.contains("crc32"), "{}", terminal.label);
}

#[test]
fn an_expected_input_checksum_that_agrees_is_reported_in_the_source_values() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let context = test_context(temp.path().join("hash-temp"));
    let crc32 = checksum_file_values(&input, &["crc32"], &context)
        .expect("crc32")
        .remove("crc32")
        .expect("crc32 value");
    let mut args = validate_command(&input, vec![patch]);
    args.expect_in = vec![format!("crc32={crc32}")];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    assert_eq!(details["source_values"]["checksums"]["crc32"], json!(crc32));
}

#[test]
fn independent_validation_keeps_a_verdict_for_every_patch() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let good = temp.path().join("good.bps");
    fs::write(&good, SIMPLE_BPS_PATCH).expect("bps fixture");
    // Probes as BPS on its magic, then fails its own integrity checks.
    let bad = temp.path().join("bad.bps");
    let mut corrupt = b"BPS1".to_vec();
    corrupt.extend(std::iter::repeat_n(0xFF_u8, 20));
    fs::write(&bad, corrupt).expect("bps fixture");
    let unsupported = temp.path().join("hack.rup");
    fs::write(&unsupported, b"NINJA1 payload").expect("ninja fixture");
    let unknown = temp.path().join("notes.bin");
    fs::write(&unknown, b"just bytes").expect("fixture");
    let mut args = validate_command(
        &input,
        vec![good, bad, unsupported.clone(), unknown.clone()],
    );
    args.independent = true;

    let (outcome, terminal) = run_validate(args);

    // Mixed results still exit 0 so every per-patch verdict survives.
    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    assert_eq!(details["independent"], json!(true));
    assert_eq!(details["patch_count"], json!(4));
    let per_patch = details["per_patch"]
        .as_array()
        .expect("per-patch verdicts")
        .clone();
    assert_eq!(per_patch.len(), 4);
    assert_eq!(per_patch[0]["status"], json!("passed"));
    assert_eq!(per_patch[0]["format"], json!("BPS"));
    assert_eq!(per_patch[1]["status"], json!("failed"));
    assert_eq!(per_patch[1]["format"], json!("BPS"));
    assert_eq!(per_patch[2]["status"], json!("failed"));
    assert!(
        per_patch[2]["message"]
            .as_str()
            .expect("message")
            .contains("does not support patch preflight")
    );
    assert_eq!(per_patch[3]["status"], json!("failed"));
    assert_eq!(per_patch[3]["format"], json!(null));
    assert_eq!(details["passed_count"], json!(1));
    assert!(
        terminal.label.contains("independent patch validation"),
        "{}",
        terminal.label
    );
}

#[test]
fn independent_validation_of_one_good_patch_reports_all_passed() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let good = temp.path().join("good.bps");
    fs::write(&good, SIMPLE_BPS_PATCH).expect("bps fixture");
    let mut args = validate_command(&input, vec![good]);
    args.independent = true;

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    assert_eq!(details["status"], json!("passed"));
    assert_eq!(details["failed_count"], json!(0));
    assert!(terminal.label.contains("1/1 passed"), "{}", terminal.label);
}

#[test]
fn plan_mode_emits_a_per_patch_verification_plan() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let good = temp.path().join("good.bps");
    fs::write(&good, SIMPLE_BPS_PATCH).expect("bps fixture");
    let follow_up = temp.path().join("after.ips");
    fs::write(&follow_up, ips_patch(&[(12, b"QQ")])).expect("ips fixture");
    let mut args = validate_command(&input, vec![good, follow_up]);
    args.plan = true;

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    assert_eq!(details["plan"], json!(true));
    assert_eq!(details["patch_count"], json!(2));
    let per_patch = details["per_patch"].as_array().expect("per-patch entries");
    assert_eq!(per_patch.len(), 2);
    assert_eq!(per_patch[0]["basis"], json!("base"));
    assert!(
        terminal.label.contains("patch verification plan"),
        "{}",
        terminal.label
    );
}

#[test]
fn plan_mode_folds_per_patch_check_flags_into_the_declarations() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let patch = temp.path().join("good.bps");
    fs::write(&patch, SIMPLE_BPS_PATCH).expect("bps fixture");
    let context = test_context(temp.path().join("plan-hash-temp"));
    let input_crc32 = checksum_file_values(&input, &["crc32"], &context)
        .expect("crc32")
        .remove("crc32")
        .expect("crc32 value");
    let mut args = validate_command(&input, vec![patch]);
    args.plan = true;
    args.patch_basis = vec![PatchBasisMode::Base];
    args.patch_input_check = vec![format!("crc32={input_crc32}")];
    args.patch_output_check = vec!["crc32=deadbeef".to_string()];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    let entry = &details["per_patch"][0];
    assert_eq!(entry["basis"], json!("base"));
    assert_eq!(entry["basis_source"], json!("declared"));
    assert_eq!(entry["input_verdict"], json!("passed"));
}

#[test]
fn plan_mode_rejects_a_malformed_check_flag() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let patch = temp.path().join("good.bps");
    fs::write(&patch, SIMPLE_BPS_PATCH).expect("bps fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.plan = true;
    args.patch_input_check = vec!["crc32=not-hex".to_string()];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(
        terminal.label.contains("--patch-input-check"),
        "{}",
        terminal.label
    );
}

#[test]
fn plan_mode_rejects_check_flags_that_do_not_align_with_the_patches() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let patch = temp.path().join("good.bps");
    fs::write(&patch, SIMPLE_BPS_PATCH).expect("bps fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.plan = true;
    args.patch_basis = vec![PatchBasisMode::Base, PatchBasisMode::Previous];

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Failed);
    assert!(
        terminal.label.contains("--patch-basis"),
        "{}",
        terminal.label
    );
}

#[test]
fn plan_mode_records_a_failed_verdict_for_a_patch_that_cannot_apply() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("other.bin");
    fs::write(&input, b"not the authored source").expect("rom fixture");
    let patch = temp.path().join("update.bps");
    fs::write(&patch, SIMPLE_BPS_PATCH).expect("bps fixture");
    let mut args = validate_command(&input, vec![patch]);
    args.plan = true;

    let (outcome, terminal) = run_validate(args);

    // A failed plan verdict is still a successful command: the plan is the answer.
    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    assert_eq!(details["status"], json!("mixed"));
    assert_eq!(details["failed_count"], json!(1));
    assert_eq!(details["per_patch"][0]["input_verdict"], json!("failed"));
}

#[test]
fn plan_mode_reports_a_probe_failure_as_the_patch_verdict() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let unknown = temp.path().join("notes.bin");
    fs::write(&unknown, b"just bytes").expect("fixture");
    let mut args = validate_command(&input, vec![unknown]);
    args.plan = true;

    let (outcome, terminal) = run_validate(args);

    assert_eq!(outcome.status, OperationStatus::Succeeded);
    let details = validation_details(&terminal);
    assert_eq!(details["per_patch"][0]["input_verdict"], json!("failed"));
    assert!(
        details["per_patch"][0]["message"]
            .as_str()
            .expect("message")
            .contains("no registered patch handler matched")
    );
}

#[test]
fn a_check_token_list_parses_into_one_map() {
    let parsed = CliApp::parse_plan_check_tokens(
        "crc32=A684C7C6, md5=00112233445566778899aabbccddeeff",
        "--patch-input-check",
    )
    .expect("two tokens");

    assert_eq!(parsed.get("crc32").map(String::as_str), Some("a684c7c6"));
    assert_eq!(parsed.len(), 2);

    assert!(
        CliApp::parse_plan_check_tokens(" , ,", "--patch-input-check")
            .expect("only separators")
            .is_empty()
    );

    let error = CliApp::parse_plan_check_tokens("crc32=not-hex", "--patch-input-check")
        .expect_err("a non-hex value is rejected");
    assert!(error.to_string().contains("--patch-input-check"));
}

#[test]
fn a_patch_file_name_can_declare_its_own_input_state() {
    let declared = CliApp::filename_plan_state(Path::new("/p/MyHack [crc32:1a2b3c4d].ips"));
    assert_eq!(
        declared.checksums.get("crc32").map(String::as_str),
        Some("1a2b3c4d")
    );

    let plain = CliApp::filename_plan_state(Path::new("/p/plain.ips"));
    assert!(plain.checksums.is_empty());
    assert_eq!(plain.size, None);
}

#[test]
fn plan_metadata_aligns_one_value_per_patch_or_none_at_all() {
    let none = CliApp::align_plan_metadata(
        &PlanFlagInputs {
            basis: Vec::new(),
            input_checks: Vec::new(),
            output_checks: Vec::new(),
        },
        2,
    )
    .expect("an empty flag list aligns");
    assert_eq!(none.basis_modes, vec![None, None]);
    assert_eq!(none.input_check_flags, vec![None, None]);

    let aligned = CliApp::align_plan_metadata(
        &PlanFlagInputs {
            basis: vec![PatchBasisMode::Base, PatchBasisMode::Previous],
            input_checks: Vec::new(),
            output_checks: vec!["crc32=deadbeef".to_string(), "crc32=a684c7c6".to_string()],
        },
        2,
    )
    .expect("one value per patch aligns");
    assert_eq!(
        aligned.basis_modes,
        vec![Some(PatchBasisMode::Base), Some(PatchBasisMode::Previous)]
    );
    assert_eq!(
        aligned.output_check_flags[1].as_deref(),
        Some("crc32=a684c7c6")
    );

    let short = CliApp::align_plan_metadata(
        &PlanFlagInputs {
            basis: vec![PatchBasisMode::Base],
            input_checks: Vec::new(),
            output_checks: Vec::new(),
        },
        2,
    );
    let Err(error) = short else {
        panic!("a short flag list is rejected");
    };
    assert!(error.to_string().contains("--patch-basis"));
}

#[test]
fn probing_plan_handlers_keeps_a_slot_for_every_patch() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let good = temp.path().join("good.ips");
    fs::write(&good, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let unknown = temp.path().join("notes.bin");
    fs::write(&unknown, b"just bytes").expect("fixture");
    let resolved = [(good.clone(), good), (unknown.clone(), unknown)];

    let probed = app().probe_plan_handlers(&resolved, 2, None);

    assert_eq!(probed.handlers.len(), 2);
    assert_eq!(
        probed.handlers[0]
            .as_ref()
            .map(|handler| handler.descriptor().name),
        Some("IPS")
    );
    assert!(probed.handlers[1].is_none());
    assert!(probed.failures[0].is_none());
    assert!(
        probed.failures[1]
            .as_deref()
            .expect("a probe failure message")
            .contains("no registered patch handler matched")
    );
}

#[test]
fn a_plan_patch_input_without_a_handler_carries_no_embedded_evidence() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let patch = temp.path().join("fix.ips");
    fs::write(&patch, ips_patch(&[(0, b"A")])).expect("patch fixture");
    let context = test_context(temp.path().join("plan-input-temp"));

    let built = CliApp::build_plan_patch_input(
        &patch,
        &patch,
        None,
        Some(PatchInputBasis::Base),
        patch_plan::PlanState {
            checksums: BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]),
            size: Some(64),
        },
        patch_plan::PlanState::default(),
        &context,
    );

    assert_eq!(built.format, None);
    assert!(built.embedded.is_empty());
    assert_eq!(built.declared_basis, Some(PatchInputBasis::Base));
    assert_eq!(built.declared_input.size, Some(64));
    assert!(built.declared_input_infers_base);
}

#[test]
fn a_plan_patch_input_with_a_handler_reads_the_patch_s_own_endpoints() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let patch = temp.path().join("update.bps");
    fs::write(&patch, SIMPLE_BPS_PATCH).expect("bps fixture");
    let context = test_context(temp.path().join("plan-input-bps-temp"));
    let app = app();
    let handler = app.patches.probe(&patch).expect("BPS handler");

    let built = CliApp::build_plan_patch_input(
        &patch,
        &patch,
        Some(handler.as_ref()),
        None,
        patch_plan::PlanState::default(),
        patch_plan::PlanState::default(),
        &context,
    );

    assert_eq!(built.format.as_deref(), Some("BPS"));
    // BPS stores both endpoint CRC32s, so the planner gets a variant to match.
    assert!(!built.embedded.is_empty());
}

#[test]
fn base_endpoint_resolution_reports_no_evidence_for_a_format_that_has_none() {
    // Only RUP implements handler-normalized endpoint selection; every other
    // format takes the registry default, which offers nothing and never errors.
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let patch = temp.path().join("update.bps");
    fs::write(&patch, SIMPLE_BPS_PATCH).expect("bps fixture");
    let source = temp.path().join("game.bin");
    fs::write(&source, BPS_SOURCE).expect("rom fixture");
    let missing = temp.path().join("absent.bin");
    let context = test_context(temp.path().join("endpoint-temp"));
    let app = app();
    let handler = app.patches.probe(&patch).expect("BPS handler");
    let representation = patch_plan::BaseRepresentation::default();

    for base in [source.as_path(), missing.as_path()] {
        let matches = CliApp::resolve_base_endpoint_selections(
            handler.as_ref(),
            &patch,
            &[(base, "raw", representation)],
            &context,
        )
        .expect("a format without endpoint support never fails the plan");
        assert!(matches.is_empty());
    }
}

#[test]
fn a_base_representation_records_the_header_and_byte_order_it_detects() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let plain = temp.path().join("game.bin");
    fs::write(&plain, vec![0x11_u8; 64]).expect("rom fixture");
    let headered = temp.path().join("game.smc");
    fs::write(&headered, headered_snes_rom()).expect("headered fixture");
    let n64 = temp.path().join("game.z64");
    fs::write(&n64, z64_rom()).expect("n64 fixture");

    let plain_representation =
        CliApp::base_representation(&plain, None, None).expect("plain representation");
    assert_eq!(plain_representation.headerless, None);
    assert_eq!(plain_representation.n64_byte_order, None);

    let headered_representation =
        CliApp::base_representation(&headered, None, None).expect("headered representation");
    assert_eq!(headered_representation.headerless, Some(false));

    let n64_representation =
        CliApp::base_representation(&n64, None, None).expect("n64 representation");
    assert_eq!(
        n64_representation.n64_byte_order,
        Some(N64ByteOrder::BigEndian)
    );

    // Explicit values win over detection.
    let forced =
        CliApp::base_representation(&headered, Some(true), Some(N64ByteOrder::ByteSwapped))
            .expect("forced representation");
    assert_eq!(forced.headerless, Some(true));
    assert_eq!(forced.n64_byte_order, Some(N64ByteOrder::ByteSwapped));
}

#[test]
fn plan_base_variants_offer_both_the_headered_and_headerless_states() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.smc");
    fs::write(&input, headered_snes_rom()).expect("headered fixture");
    let context = test_context(temp.path().join("plan-variants-temp"));
    let plan_inputs = [patch_plan::PlanPatchInput {
        declared_input: patch_plan::PlanState {
            checksums: BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]),
            size: None,
        },
        ..patch_plan::PlanPatchInput::default()
    }];

    let variants = app()
        .plan_base_variants(&input, &plan_inputs, &context)
        .expect("base variants");

    let names: Vec<&str> = variants
        .iter()
        .map(|variant| variant.name.as_str())
        .collect();
    assert_eq!(names, vec!["raw", "headerless"]);
    assert_eq!(
        variants[0].state.size,
        Some(headered_snes_rom().len() as u64)
    );
    assert_eq!(variants[1].state.size, Some(32 * 1024));
    assert_eq!(variants[1].representation.headerless, Some(true));
    assert!(variants[0].state.checksums.contains_key("crc32"));
    assert_ne!(variants[0].state.checksums, variants[1].state.checksums);
}

#[test]
fn base_variants_cover_the_three_n64_byte_orders_when_the_input_is_an_n64_image() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.z64");
    fs::write(&input, z64_rom()).expect("n64 fixture");
    let context = test_context(temp.path().join("n64-variants-temp"));
    let representation = patch_plan::BaseRepresentation {
        headerless: None,
        n64_byte_order: Some(N64ByteOrder::BigEndian),
    };

    let variants = CliApp::base_variants_for_algorithms(
        &input,
        &["crc32".to_string()],
        &context,
        false,
        "",
        representation,
    )
    .expect("n64 base variants");

    assert_eq!(variants.len(), 3);
    let names: Vec<&str> = variants
        .iter()
        .map(|variant| variant.name.as_str())
        .collect();
    assert!(names.contains(&"raw"), "{names:?}");
    assert!(names.contains(&"n64-little-endian"), "{names:?}");
    assert!(names.contains(&"n64-byte-swapped"), "{names:?}");
    for variant in &variants {
        assert_eq!(variant.state.size, Some(1024));
        assert!(variant.state.checksums.contains_key("crc32"));
    }
}

#[test]
fn base_variants_fall_back_to_a_sizeless_state_when_the_input_cannot_be_read() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let missing = temp.path().join("absent.bin");
    let context = test_context(temp.path().join("missing-base-temp"));
    let representation = patch_plan::BaseRepresentation::default();

    let best_effort = CliApp::base_variants_for_algorithms(
        &missing,
        &["crc32".to_string()],
        &context,
        true,
        "prepared-",
        representation,
    )
    .expect("best-effort inference tolerates a missing input");
    assert_eq!(best_effort.len(), 1);
    assert_eq!(best_effort[0].name, "prepared-raw");
    assert_eq!(best_effort[0].state.size, None);
    assert!(best_effort[0].state.checksums.is_empty());

    let strict = CliApp::base_variants_for_algorithms(
        &missing,
        &["crc32".to_string()],
        &context,
        false,
        "",
        representation,
    )
    .expect_err("a strict request propagates the read error");
    assert!(matches!(strict, RomWeaverError::Io(_)));
}

#[test]
fn base_variants_drop_an_n64_variant_set_the_engine_cannot_compute() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.z64");
    fs::write(&input, z64_rom()).expect("n64 fixture");
    let context = test_context(temp.path().join("bad-algorithm-temp"));
    let representation = patch_plan::BaseRepresentation {
        headerless: None,
        n64_byte_order: Some(N64ByteOrder::BigEndian),
    };

    let best_effort = CliApp::base_variants_for_algorithms(
        &input,
        &["fletcher16".to_string()],
        &context,
        true,
        "",
        representation,
    )
    .expect("best-effort inference tolerates an unknown algorithm");
    assert_eq!(best_effort.len(), 1);
    assert_eq!(best_effort[0].name, "raw");
    assert!(best_effort[0].state.checksums.is_empty());
    assert_eq!(best_effort[0].state.size, Some(1024));

    let strict = CliApp::base_variants_for_algorithms(
        &input,
        &["fletcher16".to_string()],
        &context,
        false,
        "",
        representation,
    )
    .expect_err("a strict request propagates the engine error");
    assert!(matches!(strict, RomWeaverError::Validation(_)));
}

#[test]
fn apply_base_planning_only_hashes_what_a_later_step_can_use() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let input = temp.path().join("game.bin");
    fs::write(&input, BPS_SOURCE).expect("rom fixture");
    let context = test_context(temp.path().join("apply-base-temp"));
    let representation = patch_plan::BaseRepresentation::default();

    // Every later step declares `previous`, so nothing needs a base hash.
    let previous_only = [
        patch_plan::PlanPatchInput::default(),
        patch_plan::PlanPatchInput {
            declared_basis: Some(PatchInputBasis::Previous),
            declared_input: patch_plan::PlanState {
                checksums: BTreeMap::from([("md5".to_string(), "0".repeat(32))]),
                size: None,
            },
            ..patch_plan::PlanPatchInput::default()
        },
    ];
    let variants = CliApp::plan_apply_base_variants(
        &input,
        representation,
        &input,
        representation,
        &previous_only,
        &context,
    )
    .expect("base variants");
    assert_eq!(variants.len(), 1);
    assert!(variants[0].state.checksums.is_empty());

    // A declared base step names an algorithm, so the base is hashed for real.
    let declared_base = [
        patch_plan::PlanPatchInput::default(),
        patch_plan::PlanPatchInput {
            declared_basis: Some(PatchInputBasis::Base),
            declared_input: patch_plan::PlanState {
                checksums: BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]),
                size: None,
            },
            ..patch_plan::PlanPatchInput::default()
        },
    ];
    let variants = CliApp::plan_apply_base_variants(
        &input,
        representation,
        &input,
        representation,
        &declared_base,
        &context,
    )
    .expect("base variants");
    assert_eq!(variants.len(), 1);
    assert!(variants[0].state.checksums.contains_key("crc32"));
}

#[test]
fn apply_base_planning_adds_the_prepared_input_as_its_own_variant() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let original = temp.path().join("game.bin");
    fs::write(&original, vec![0x11_u8; 64]).expect("rom fixture");
    // A compat transform can leave the prepared bytes unlike every state the
    // original offers; that is exactly when a second variant set is needed.
    let prepared = temp.path().join("game-prepared.bin");
    fs::write(&prepared, vec![0x22_u8; 96]).expect("prepared fixture");
    let context = test_context(temp.path().join("prepared-base-temp"));
    let plan_inputs = [
        patch_plan::PlanPatchInput::default(),
        patch_plan::PlanPatchInput {
            declared_basis: Some(PatchInputBasis::Base),
            declared_input: patch_plan::PlanState {
                checksums: BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]),
                size: None,
            },
            ..patch_plan::PlanPatchInput::default()
        },
    ];

    let variants = CliApp::plan_apply_base_variants(
        &original,
        patch_plan::BaseRepresentation {
            headerless: Some(false),
            n64_byte_order: None,
        },
        &prepared,
        patch_plan::BaseRepresentation {
            headerless: Some(true),
            n64_byte_order: None,
        },
        &plan_inputs,
        &context,
    )
    .expect("base variants");

    let names: Vec<&str> = variants
        .iter()
        .map(|variant| variant.name.as_str())
        .collect();
    assert_eq!(names, vec!["raw", "prepared-raw"]);
    assert_eq!(variants[0].state.size, Some(64));
    assert_eq!(variants[1].state.size, Some(96));
    assert_eq!(variants[1].representation.headerless, Some(true));
}

#[test]
fn apply_base_planning_propagates_a_read_error_a_declared_base_step_needs() {
    let temp = assert_fs::TempDir::new().expect("temp dir");
    let missing = temp.path().join("absent.bin");
    let context = test_context(temp.path().join("strict-base-temp"));
    let representation = patch_plan::BaseRepresentation::default();
    let plan_inputs = [
        patch_plan::PlanPatchInput::default(),
        patch_plan::PlanPatchInput {
            declared_basis: Some(PatchInputBasis::Base),
            declared_input: patch_plan::PlanState {
                checksums: BTreeMap::from([("crc32".to_string(), "deadbeef".to_string())]),
                size: None,
            },
            ..patch_plan::PlanPatchInput::default()
        },
    ];

    let error = CliApp::plan_apply_base_variants(
        &missing,
        representation,
        &missing,
        representation,
        &plan_inputs,
        &context,
    )
    .expect_err("a declared base check is a strict request");

    assert!(matches!(error, RomWeaverError::Io(_)));
}
