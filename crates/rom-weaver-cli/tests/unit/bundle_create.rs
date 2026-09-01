use std::sync::atomic::{AtomicU32, Ordering};

use rom_weaver_core::{NoninteractivePrompter, NoopProgressSink, RecordingProgressSink};

use super::*;

/// Monotonic suffix so parallel tests in this file never share a scratch dir.
static SCRATCH_COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch_dir(label: &str) -> PathBuf {
    let unique = SCRATCH_COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "rw-bundle-create-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

fn test_app() -> CliApp {
    CliApp::new(
        Arc::new(NoopProgressSink),
        Arc::new(NoninteractivePrompter),
        false,
        false,
        false,
    )
}

fn reporting_app(sink: Arc<RecordingProgressSink>) -> CliApp {
    CliApp::new(sink, Arc::new(NoninteractivePrompter), true, false, false)
}

fn ips_patch_bytes() -> Vec<u8> {
    let mut bytes = b"PATCH".to_vec();
    bytes.extend_from_slice(&[0x00, 0x00, 0x00]);
    bytes.extend_from_slice(&[0x00, 0x01]);
    bytes.push(0x42);
    bytes.extend_from_slice(b"EOF");
    bytes
}

fn write_fixture(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("fixture write");
    path
}

/// A minimal command whose only output is `dir/rom-weaver-bundle.json`.
fn base_args(dir: &Path) -> BundleCreateCommand {
    BundleCreateCommand {
        output: dir.join("rom-weaver-bundle.json"),
        ..Default::default()
    }
}

fn checks(pairs: &[(&str, &str)], size: Option<u64>) -> BundleChecks {
    BundleChecks {
        checksums: pairs
            .iter()
            .map(|(algorithm, value)| ((*algorithm).to_string(), (*value).to_string()))
            .collect(),
        size,
    }
}

#[test]
fn aligned_metadata_fills_missing_values_with_none() {
    let values: Vec<String> = Vec::new();
    assert_eq!(
        aligned_metadata(&values, 3, "--patch-name").expect("empty is always aligned"),
        vec![None, None, None]
    );
}

#[test]
fn aligned_metadata_wraps_a_matching_length_run() {
    let values = vec!["a".to_string(), "b".to_string()];
    assert_eq!(
        aligned_metadata(&values, 2, "--patch-name").expect("aligned"),
        vec![Some("a".to_string()), Some("b".to_string())]
    );
}

#[test]
fn aligned_metadata_names_the_patches_left_without_a_value() {
    let values = vec!["only".to_string()];
    let error = aligned_metadata(&values, 3, "--patch-name").expect_err("too few values");
    let message = error.to_string();
    assert!(message.contains("no value for --patch #2, #3"), "{message}");
    assert!(
        message.contains("got 1 value(s) for 3 patch(es)"),
        "{message}"
    );
}

#[test]
fn aligned_metadata_names_the_values_without_a_patch() {
    let values = vec!["a".to_string(), "b".to_string(), "c".to_string()];
    let error = aligned_metadata(&values, 1, "--patch-id").expect_err("too many values");
    let message = error.to_string();
    assert!(
        message.contains("value(s) #2, #3 have no matching --patch"),
        "{message}"
    );
}

#[test]
fn required_base_name_reports_a_path_without_a_file_name() {
    assert_eq!(
        required_base_name(Path::new("/games/rom.nes"), "rom").expect("base name"),
        "rom.nes"
    );
    let error = required_base_name(Path::new(".."), "rom").expect_err("no file name");
    assert!(
        error
            .to_string()
            .contains("rom path has no usable file name"),
        "{error}"
    );
}

#[test]
fn checks_implied_by_needs_a_baseline() {
    let entry = checks(&[("crc32", "deadbeef")], None);
    assert!(!checks_implied_by(&entry, None));
}

#[test]
fn empty_checks_are_implied_by_any_baseline() {
    let baseline = checks(&[("crc32", "deadbeef")], Some(16));
    assert!(checks_implied_by(&BundleChecks::default(), Some(&baseline)));
}

#[test]
fn checks_are_implied_when_every_digest_matches_case_insensitively() {
    let baseline = checks(&[("crc32", "deadbeef"), ("md5", "abcd")], Some(16));
    let entry = checks(&[("crc32", "DEADBEEF")], Some(16));
    assert!(checks_implied_by(&entry, Some(&baseline)));
}

#[test]
fn checks_are_not_implied_when_a_digest_differs_or_is_absent() {
    let baseline = checks(&[("crc32", "deadbeef")], None);
    assert!(!checks_implied_by(
        &checks(&[("crc32", "0badf00d")], None),
        Some(&baseline)
    ));
    assert!(!checks_implied_by(
        &checks(&[("sha1", "deadbeef")], None),
        Some(&baseline)
    ));
}

#[test]
fn checks_are_not_implied_when_the_size_differs() {
    let baseline = checks(&[("crc32", "deadbeef")], Some(16));
    assert!(!checks_implied_by(
        &checks(&[("crc32", "deadbeef")], Some(32)),
        Some(&baseline)
    ));
}

#[test]
fn checks_tokens_render_algo_equals_hex_and_drop_the_size() {
    let tokens = checks_tokens(&checks(&[("crc32", "deadbeef"), ("md5", "abcd")], Some(16)));
    assert_eq!(tokens, vec!["crc32=deadbeef", "md5=abcd"]);
}

#[test]
fn bundle_entry_checks_splits_commas_and_trims_blank_tokens() {
    let values = vec![
        " crc32=DEADBEEF , ".to_string(),
        "md5=d41d8cd98f00b204e9800998ecf8427e".to_string(),
    ];
    let parsed = bundle_entry_checks(&values, "--expect-out")
        .expect("valid tokens")
        .expect("some checks");
    assert_eq!(
        parsed.checksums.get("crc32").map(String::as_str),
        Some("deadbeef")
    );
    assert_eq!(
        parsed.checksums.get("md5").map(String::as_str),
        Some("d41d8cd98f00b204e9800998ecf8427e")
    );
    assert_eq!(parsed.size, None);
}

#[test]
fn bundle_entry_checks_is_none_without_tokens() {
    assert!(
        bundle_entry_checks(&[" ".to_string(), ",".to_string()], "--expect-out")
            .expect("blank tokens parse")
            .is_none()
    );
}

#[test]
fn bundle_entry_checks_rejects_a_token_without_an_algorithm() {
    let error = bundle_entry_checks(&["deadbeef".to_string()], "--patch-expect-in")
        .expect_err("missing ALGO=");
    assert!(error.to_string().contains("expected ALGO=HEX"), "{error}");
}

#[test]
fn patch_specs_pass_through_untouched_when_already_built() {
    let args = BundleCreateCommand {
        patch_specs: vec![BundleCreatePatchSpec {
            path: PathBuf::from("a.ips"),
            name: Some("Spec".to_string()),
            ..Default::default()
        }],
        patch: vec![PathBuf::from("ignored.ips")],
        ..Default::default()
    };
    let specs = bundle_create_patch_specs(&args).expect("specs");
    assert_eq!(specs.len(), 1);
    assert_eq!(specs[0].path, PathBuf::from("a.ips"));
    assert_eq!(specs[0].name.as_deref(), Some("Spec"));
}

#[test]
fn patch_specs_zip_flag_vectors_index_by_index() {
    let args = BundleCreateCommand {
        patch: vec![PathBuf::from("a.ips"), PathBuf::from("b.ips")],
        patch_id: vec!["one".to_string(), "two".to_string()],
        patch_optional: vec![false, true],
        patch_basis: vec![PatchBasisMode::Auto, PatchBasisMode::Base],
        patch_input_check: vec!["crc32=deadbeef".to_string(), "crc32=0badf00d".to_string()],
        ..Default::default()
    };
    let specs = bundle_create_patch_specs(&args).expect("specs");
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[0].id.as_deref(), Some("one"));
    assert_eq!(specs[0].optional, Some(false));
    assert_eq!(specs[0].basis, None, "auto declares no basis");
    assert_eq!(specs[1].basis, Some(PatchInputBasis::Base));
    assert_eq!(specs[1].optional, Some(true));
    assert_eq!(specs[1].input_checks, vec!["crc32=0badf00d".to_string()]);
    assert!(specs[0].output_checks.is_empty());
}

#[test]
fn patch_specs_reject_a_metadata_vector_that_does_not_line_up() {
    let args = BundleCreateCommand {
        patch: vec![PathBuf::from("a.ips"), PathBuf::from("b.ips")],
        patch_name: vec!["only one".to_string()],
        ..Default::default()
    };
    let error = bundle_create_patch_specs(&args).expect_err("misaligned metadata");
    assert!(error.to_string().contains("--patch-name"), "{error}");
}

#[test]
fn write_bundle_bytes_creates_the_parent_directory() {
    let dir = scratch_dir("write-parent");
    let output = dir.join("nested/deeper/rom-weaver-bundle.json");
    write_bundle_bytes(&output, b"{}\n").expect("write");
    assert_eq!(fs::read(&output).expect("read back"), b"{}\n");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_bundle_bytes_gzips_a_gz_name() {
    let dir = scratch_dir("write-gz");
    let output = dir.join("rom-weaver-bundle.json.gz");
    write_bundle_bytes(&output, b"{\"version\":1}\n").expect("write");
    let raw = fs::read(&output).expect("read back");
    assert_eq!(&raw[..2], &[0x1F, 0x8B], "gzip magic");
    let mut decoded = Vec::new();
    flate2::read::GzDecoder::new(raw.as_slice())
        .read_to_end(&mut decoded)
        .expect("gunzip");
    assert_eq!(decoded, b"{\"version\":1}\n");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_bundle_bytes_zstd_encodes_a_zst_name() {
    let dir = scratch_dir("write-zst");
    let output = dir.join("rom-weaver-bundle.json.zst");
    write_bundle_bytes(&output, b"{\"version\":1}\n").expect("write");
    let raw = fs::read(&output).expect("read back");
    assert_eq!(&raw[..4], &[0x28, 0xB5, 0x2F, 0xFD], "zstd magic");
    let decoded = zstd::stream::decode_all(raw.as_slice()).expect("zstd decode");
    assert_eq!(decoded, b"{\"version\":1}\n");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn write_bundle_bytes_refuses_read_only_codecs() {
    let dir = scratch_dir("write-readonly");
    for extension in ["bz2", "xz"] {
        let output = dir.join(format!("rom-weaver-bundle.json.{extension}"));
        let error = write_bundle_bytes(&output, b"{}\n").expect_err("read-only codec");
        assert!(
            error
                .to_string()
                .contains(&format!("`.{extension}` is read-only")),
            "{error}"
        );
        assert!(!output.exists(), "nothing is written for a rejected codec");
    }
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundle_create_requires_at_least_one_patch() {
    let dir = scratch_dir("no-patch");
    let app = test_app();
    let args = base_args(&dir);
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("no patches");
    assert!(
        error
            .to_string()
            .contains("bundle create requires at least one --patch"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundle_create_rejects_an_unknown_checksum_algorithm() {
    let dir = scratch_dir("bad-algo");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        checksum: vec!["sha3".to_string()],
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("unknown algorithm");
    assert!(
        error.to_string().contains("unsupported checksum algorithm"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundle_rom_without_an_input_rom_is_rejected() {
    let dir = scratch_dir("bundle-rom-no-input");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        bundle_rom: Some(dir.join("rom.nes")),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("--bundle-rom needs --input");
    assert!(
        error.to_string().contains("--bundle-rom requires --input"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundle_create_warns_when_rom_only_flags_have_no_rom() {
    let dir = scratch_dir("rom-flag-warnings");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        no_bundle_rom: true,
        rom_name: Some("Game.nes".to_string()),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");
    assert_eq!(
        result.warnings,
        vec![
            "--no-bundle-rom ignored: no local ROM given with --input".to_string(),
            "--rom-name ignored: no ROM given with --input or --rom-url".to_string(),
        ]
    );
    assert!(result.bundle.rom.is_none());
    assert_eq!(result.bundle.version, BUNDLE_VERSION);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundle_create_rejects_a_missing_rom_or_patch_path() {
    let dir = scratch_dir("missing-paths");
    let app = test_app();
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());

    let args = BundleCreateCommand {
        patch: vec![patch.clone()],
        rom: Some(dir.join("absent.nes")),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("absent rom");
    assert!(
        error.to_string().contains("rom path does not exist"),
        "{error}"
    );

    let args = BundleCreateCommand {
        patch: vec![dir.join("absent.ips")],
        ..base_args(&dir)
    };
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("absent patch");
    assert!(
        error.to_string().contains("patch path does not exist"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundle_create_hashes_the_rom_and_records_a_path_entry() {
    let dir = scratch_dir("rom-entry");
    let rom = write_fixture(&dir, "game.nes", &[0x00; 32]);
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    let bundle_rom = result.bundle.rom.as_ref().expect("rom entry");
    assert_eq!(bundle_rom.path.as_deref(), Some("game.nes"));
    assert_eq!(bundle_rom.name, None, "a distributed rom needs no name");
    let rom_checks = bundle_rom.checks.as_ref().expect("rom checks");
    assert_eq!(rom_checks.size, Some(32));
    let algorithms: Vec<&str> = rom_checks.checksums.keys().map(String::as_str).collect();
    assert_eq!(algorithms, vec!["crc32", "md5", "sha1"]);
    assert!(result.warnings.is_empty());
    assert!(result.archive_path.is_none());
    assert!(
        result.bundle_path.ends_with("rom-weaver-bundle.json"),
        "{}",
        result.bundle_path
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn no_bundle_rom_keeps_checks_and_names_the_rom_the_user_must_supply() {
    let dir = scratch_dir("sourceless-rom");
    let rom = write_fixture(&dir, "game.nes", &[0x11; 8]);
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        no_bundle_rom: true,
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    let bundle_rom = result.bundle.rom.as_ref().expect("rom entry");
    assert_eq!(bundle_rom.path, None);
    assert_eq!(bundle_rom.url, None);
    assert_eq!(bundle_rom.name.as_deref(), Some("game.nes"));
    assert!(bundle_rom.checks.is_some());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn assume_in_tokens_replace_the_rom_hash_and_size() {
    let dir = scratch_dir("assume-in");
    let rom = write_fixture(&dir, "game.nes", &[0x22; 64]);
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        assume_in: vec!["crc32=deadbeef".to_string(), "size=999".to_string()],
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    let rom_checks = result
        .bundle
        .rom
        .as_ref()
        .and_then(|rom| rom.checks.as_ref())
        .expect("rom checks");
    assert_eq!(
        rom_checks.checksums.get("crc32").map(String::as_str),
        Some("deadbeef"),
        "the trusted token wins over hashing the file"
    );
    assert_eq!(rom_checks.size, Some(999));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_url_only_rom_records_the_url_and_no_checks() {
    let dir = scratch_dir("rom-url");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom_url: Some("https://example.invalid/game.nes".to_string()),
        rom_name: Some("  Game.nes  ".to_string()),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    let bundle_rom = result.bundle.rom.as_ref().expect("rom entry");
    assert_eq!(
        bundle_rom.url.as_deref(),
        Some("https://example.invalid/game.nes")
    );
    assert_eq!(
        bundle_rom.name.as_deref(),
        Some("Game.nes"),
        "name is trimmed"
    );
    assert!(bundle_rom.checks.is_none());
    assert!(bundle_rom.path.is_none());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_empty_rom_name_suppresses_the_sourceless_default() {
    let dir = scratch_dir("empty-rom-name");
    let rom = write_fixture(&dir, "game.nes", &[0x33; 8]);
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        no_bundle_rom: true,
        rom_name: Some("   ".to_string()),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");
    assert_eq!(
        result.bundle.rom.as_ref().and_then(|rom| rom.name.clone()),
        None
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_bundle_rom_override_must_exist() {
    let dir = scratch_dir("bundle-rom-missing");
    let rom = write_fixture(&dir, "game.nes", &[0x44; 8]);
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        bundle_rom: Some(dir.join("other.nes")),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("absent bundle rom");
    assert!(
        error.to_string().contains("bundle rom path does not exist"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn duplicate_source_base_names_are_rejected() {
    let dir = scratch_dir("duplicate-names");
    let first = dir.join("one");
    let second = dir.join("two");
    fs::create_dir_all(&first).expect("dir");
    fs::create_dir_all(&second).expect("dir");
    let patch_a = write_fixture(&first, "a.ips", &ips_patch_bytes());
    let patch_b = write_fixture(&second, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch_a, patch_b],
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("aliasing base names");
    assert!(
        error
            .to_string()
            .contains("duplicate source file name `a.ips`"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn entry_checks_equal_to_the_endpoints_are_left_out() {
    let dir = scratch_dir("implied-checks");
    let rom = write_fixture(&dir, "game.nes", &[0x55; 4]);
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let rom_crc = format!(
        "crc32={:08x}",
        rom_weaver_checksum::crc32_bytes(&[0x55_u8; 4])
    );
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        checksum: vec!["crc32".to_string()],
        patch_input_check: vec![rom_crc],
        patch_output_check: vec!["crc32=0badf00d".to_string()],
        output_check: vec!["crc32=0badf00d".to_string()],
        output_name: Some("patched.nes".to_string()),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    let entry = &result.bundle.patches[0];
    assert!(
        entry.input_checks.is_none(),
        "input checks equal to rom.checks are implied"
    );
    assert!(
        entry.output_checks.is_none(),
        "output checks equal to output.checks are implied"
    );
    let output = result.bundle.output.as_ref().expect("output block");
    assert_eq!(output.name.as_deref(), Some("patched.nes"));
    assert_eq!(
        output
            .checks
            .as_ref()
            .and_then(|checks| checks.checksums.get("crc32"))
            .map(String::as_str),
        Some("0badf00d")
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn distinct_entry_checks_are_kept_on_the_entry() {
    let dir = scratch_dir("kept-checks");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        patch_input_check: vec!["crc32=11111111".to_string()],
        patch_output_check: vec!["crc32=22222222".to_string()],
        output_check: vec!["crc32=33333333".to_string()],
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    let entry = &result.bundle.patches[0];
    assert_eq!(
        entry
            .input_checks
            .as_ref()
            .and_then(|checks| checks.checksums.get("crc32"))
            .map(String::as_str),
        Some("11111111")
    );
    assert_eq!(
        entry
            .output_checks
            .as_ref()
            .and_then(|checks| checks.checksums.get("crc32"))
            .map(String::as_str),
        Some("22222222")
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_patch_with_a_source_url_carries_no_path_entry() {
    let dir = scratch_dir("patch-url");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        patch_source_url: vec!["https://example.invalid/a.ips".to_string()],
        patch_optional: vec![true],
        patch_label: vec!["beta".to_string()],
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    let entry = &result.bundle.patches[0];
    assert_eq!(entry.path, None);
    assert_eq!(entry.url.as_deref(), Some("https://example.invalid/a.ips"));
    assert!(entry.optional);
    assert_eq!(entry.label.as_deref(), Some("beta"));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_unrecognized_bundle_file_name_warns_about_auto_detection() {
    let dir = scratch_dir("odd-name");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        output: dir.join("my-bundle.json"),
        ..Default::default()
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");
    assert!(
        result
            .warnings
            .iter()
            .any(|warning| warning.contains("apply auto-detection only recognizes")),
        "{:?}",
        result.warnings
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundle_create_refuses_to_overwrite_an_existing_output() {
    let dir = scratch_dir("overwrite");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let mut args = BundleCreateCommand {
        patch: vec![patch],
        ..base_args(&dir)
    };
    fs::write(&args.output, b"existing").expect("pre-existing output");
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("existing output");
    assert!(
        error.to_string().contains("refusing to overwrite"),
        "{error}"
    );

    args.force = true;
    app.bundle_create_inner(&args, &context)
        .expect("--force overwrites");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_schema_ref_is_stamped_at_the_top_of_the_written_bundle() {
    let dir = scratch_dir("schema-ref");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        schema_ref: Some(BUNDLE_JSON_SCHEMA_URL.to_string()),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");
    assert_eq!(
        result.bundle.schema.as_deref(),
        Some(BUNDLE_JSON_SCHEMA_URL)
    );
    let written = fs::read_to_string(&args.output).expect("read bundle");
    assert!(written.contains("\"$schema\""), "{written}");
    assert!(written.ends_with("}\n"), "bundles end with one newline");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn hash_progress_is_emitted_for_a_rom_larger_than_the_progress_interval() {
    let dir = scratch_dir("hash-progress");
    let rom = write_fixture(
        &dir,
        "game.nes",
        &vec![0x66_u8; (BUNDLE_CREATE_PROGRESS_INTERVAL + 4096) as usize],
    );
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let sink = Arc::new(RecordingProgressSink::default());
    let app = reporting_app(sink.clone());
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        checksum: vec!["crc32".to_string()],
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    app.bundle_create_inner(&args, &context).expect("create");

    let checksum_events: Vec<_> = sink
        .snapshot()
        .into_iter()
        .filter(|event| event.stage == "checksum")
        .collect();
    assert!(
        checksum_events.len() >= 2,
        "the opening event plus at least one interval update: {checksum_events:?}"
    );
    assert!(
        checksum_events
            .iter()
            .all(|event| event.label == "computing checksums for `game.nes`"),
        "{checksum_events:?}"
    );
    assert_eq!(
        checksum_events
            .last()
            .and_then(|event| event.percent)
            .map(|percent| percent as u32),
        Some(100)
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn bundling_packs_the_bundle_rom_and_patches_into_one_archive() {
    let dir = scratch_dir("bundle-archive");
    let rom = write_fixture(&dir, "game.nes", &[0x77; 16]);
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let archive = dir.join("bundle.zip");
    let args = BundleCreateCommand {
        patch: vec![patch],
        rom: Some(rom),
        bundle: Some(archive.clone()),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let result = app.bundle_create_inner(&args, &context).expect("create");

    assert!(archive.is_file(), "the archive is written");
    assert!(
        result
            .archive_path
            .as_deref()
            .is_some_and(|path| path.ends_with("bundle.zip")),
        "{:?}",
        result.archive_path
    );
    let entries = app
        .containers
        .probe(&archive)
        .expect("zip handler")
        .list_entries(
            &ContainerProbeRequest {
                source: archive.clone(),
                split_bin: false,
            },
            &context,
        )
        .expect("list archive")
        .into_iter()
        .collect::<BTreeSet<_>>();
    assert!(entries.contains("rom-weaver-bundle.json"), "{entries:?}");
    assert!(entries.contains("game.nes"), "{entries:?}");
    assert!(entries.contains("a.ips"), "{entries:?}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_bundle_path_without_an_extension_is_rejected() {
    let dir = scratch_dir("bundle-no-extension");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let app = test_app();
    let args = BundleCreateCommand {
        patch: vec![patch],
        bundle: Some(dir.join("bundle")),
        ..base_args(&dir)
    };
    let context = app.context(args.threads);
    let error = app
        .bundle_create_inner(&args, &context)
        .expect_err("no archive extension");
    assert!(
        error.to_string().contains("creatable archive extension"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_from_spec_fills_every_field_the_flags_left_unset() {
    let dir = scratch_dir("from-spec");
    write_fixture(&dir, "game.nes", &[0x88; 8]);
    write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let spec = write_fixture(
        &dir,
        "spec.json",
        br#"{
            "$schema": "https://example.invalid/schema.json",
            "version": 1,
            "rom": { "path": "game.nes", "name": "Game", "checks": { "checksums": { "crc32": "11111111" } } },
            "patches": [
                {
                    "path": "a.ips",
                    "id": "one",
                    "name": "First",
                    "optional": true,
                    "inputChecks": { "checksums": { "crc32": "11111111" } },
                    "outputChecks": { "checksums": { "crc32": "22222222" } }
                }
            ],
            "output": { "name": "patched.nes", "checks": { "checksums": { "crc32": "33333333" } } }
        }"#,
    );
    let app = test_app();
    let mut args = BundleCreateCommand {
        from: Some(spec),
        ..base_args(&dir)
    };
    app.apply_bundle_create_spec(&mut args).expect("hydrate");

    assert_eq!(
        args.schema_ref.as_deref(),
        Some("https://example.invalid/schema.json")
    );
    assert_eq!(args.rom, Some(dir.join("game.nes")));
    assert_eq!(args.rom_name.as_deref(), Some("Game"));
    assert_eq!(args.output_name.as_deref(), Some("patched.nes"));
    assert_eq!(args.output_check, vec!["crc32=33333333".to_string()]);
    assert_eq!(args.patch_specs.len(), 1);
    let spec_entry = &args.patch_specs[0];
    assert_eq!(spec_entry.path, dir.join("a.ips"));
    assert_eq!(spec_entry.id.as_deref(), Some("one"));
    assert_eq!(spec_entry.optional, Some(true));
    assert_eq!(spec_entry.input_checks, vec!["crc32=11111111".to_string()]);
    assert_eq!(spec_entry.output_checks, vec!["crc32=22222222".to_string()]);
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn explicit_flags_win_over_a_from_spec() {
    let dir = scratch_dir("from-spec-override");
    let spec = write_fixture(
        &dir,
        "spec.json",
        br#"{
            "$schema": "https://example.invalid/spec.json",
            "version": 1,
            "rom": { "url": "https://example.invalid/spec.nes", "name": "Spec" },
            "patches": [ { "path": "spec.ips" } ],
            "output": { "name": "spec.nes" }
        }"#,
    );
    let app = test_app();
    let mut args = BundleCreateCommand {
        from: Some(spec),
        schema_ref: Some("https://example.invalid/flag.json".to_string()),
        rom_url: Some("https://example.invalid/flag.nes".to_string()),
        rom_name: Some("Flag".to_string()),
        output_name: Some("flag.nes".to_string()),
        patch: vec![PathBuf::from("flag.ips")],
        ..base_args(&dir)
    };
    app.apply_bundle_create_spec(&mut args).expect("hydrate");

    assert_eq!(
        args.schema_ref.as_deref(),
        Some("https://example.invalid/flag.json")
    );
    assert_eq!(
        args.rom_url.as_deref(),
        Some("https://example.invalid/flag.nes")
    );
    assert_eq!(args.rom_name.as_deref(), Some("Flag"));
    assert_eq!(args.output_name.as_deref(), Some("flag.nes"));
    assert!(
        args.patch_specs.is_empty(),
        "an explicit --patch chain replaces the spec's"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_from_spec_with_an_absolute_patch_path_is_rejected_by_the_schema() {
    let dir = scratch_dir("from-spec-absolute");
    let absolute = dir.join("elsewhere.ips");
    let spec = write_fixture(
        &dir,
        "spec.json",
        format!(
            r#"{{ "version": 1, "patches": [ {{ "path": {} }} ] }}"#,
            serde_json::to_string(&absolute.to_string_lossy()).expect("json string")
        )
        .as_bytes(),
    );
    let app = test_app();
    let mut args = BundleCreateCommand {
        from: Some(spec),
        ..base_args(&dir)
    };
    let error = app
        .apply_bundle_create_spec(&mut args)
        .expect_err("absolute bundle paths are refused on parse");
    assert!(
        error
            .to_string()
            .contains("bundle path entries must be relative"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_from_spec_rejects_sources_bundle_create_cannot_bake() {
    let dir = scratch_dir("from-spec-rejects");
    let app = test_app();

    let checks_only_rom = write_fixture(
        &dir,
        "checks-only.json",
        br#"{ "version": 1, "rom": { "checks": { "checksums": { "crc32": "11111111" } } }, "patches": [ { "path": "a.ips" } ] }"#,
    );
    let mut args = BundleCreateCommand {
        from: Some(checks_only_rom),
        ..base_args(&dir)
    };
    let error = app
        .apply_bundle_create_spec(&mut args)
        .expect_err("checks-only rom");
    assert!(error.to_string().contains("checks-only rom"), "{error}");

    let url_patch = write_fixture(
        &dir,
        "url-patch.json",
        br#"{ "version": 1, "patches": [ { "url": "https://example.invalid/a.ips" } ] }"#,
    );
    let mut args = BundleCreateCommand {
        from: Some(url_patch),
        ..base_args(&dir)
    };
    let error = app
        .apply_bundle_create_spec(&mut args)
        .expect_err("url-only patch");
    assert!(error.to_string().contains("is a url-only entry"), "{error}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_missing_from_spec_reports_the_path_it_could_not_read() {
    let dir = scratch_dir("from-spec-missing");
    let app = test_app();
    let mut args = BundleCreateCommand {
        from: Some(dir.join("absent.json")),
        ..base_args(&dir)
    };
    let error = app
        .apply_bundle_create_spec(&mut args)
        .expect_err("missing spec");
    assert!(
        error.to_string().contains("failed to read bundle spec"),
        "{error}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn run_bundle_create_reports_the_written_bundle_in_its_details() {
    let dir = scratch_dir("run-success");
    let patch = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let sink = Arc::new(RecordingProgressSink::default());
    let app = reporting_app(sink.clone());
    let args = BundleCreateCommand {
        patch: vec![patch],
        ..base_args(&dir)
    };

    let outcome = app.run_bundle_create(args);
    assert_eq!(outcome.exit_code, 0);

    let terminal = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal event");
    assert_eq!(terminal.status, OperationStatus::Succeeded);
    assert!(
        terminal.label.contains("1 patch entry"),
        "singular entry count: {}",
        terminal.label
    );
    let created = terminal
        .details
        .as_ref()
        .and_then(|details| details.get("bundle_create"))
        .expect("bundle_create details");
    assert_eq!(created["bundle"]["version"], json!(BUNDLE_VERSION));
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn run_bundle_create_reports_a_spec_failure_before_anything_is_written() {
    let dir = scratch_dir("run-spec-failure");
    let sink = Arc::new(RecordingProgressSink::default());
    let app = reporting_app(sink.clone());
    let args = BundleCreateCommand {
        from: Some(dir.join("absent.json")),
        ..base_args(&dir)
    };
    let output = args.output.clone();

    let outcome = app.run_bundle_create(args);
    assert_eq!(outcome.exit_code, 1);
    assert!(!output.exists());

    let terminal = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal event");
    assert_eq!(terminal.status, OperationStatus::Failed);
    assert!(
        terminal.label.contains("failed to read bundle spec"),
        "{}",
        terminal.label
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn run_bundle_create_reports_a_create_failure() {
    let dir = scratch_dir("run-failure");
    let sink = Arc::new(RecordingProgressSink::default());
    let app = reporting_app(sink.clone());
    let args = base_args(&dir);

    let outcome = app.run_bundle_create(args);
    assert_eq!(outcome.exit_code, 1);

    let terminal = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal event");
    assert_eq!(terminal.status, OperationStatus::Failed);
    assert!(
        terminal.label.contains("requires at least one --patch"),
        "{}",
        terminal.label
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn plural_patch_entries_are_counted_in_the_success_label() {
    let dir = scratch_dir("run-plural");
    let first = write_fixture(&dir, "a.ips", &ips_patch_bytes());
    let second = write_fixture(&dir, "b.ips", &ips_patch_bytes());
    let sink = Arc::new(RecordingProgressSink::default());
    let app = reporting_app(sink.clone());
    let args = BundleCreateCommand {
        patch: vec![first, second],
        bundle: Some(dir.join("bundle.zip")),
        ..base_args(&dir)
    };

    assert_eq!(app.run_bundle_create(args).exit_code, 0);
    let terminal = sink
        .snapshot()
        .into_iter()
        .next_back()
        .expect("a terminal event");
    assert!(
        terminal.label.contains("2 patch entries"),
        "{}",
        terminal.label
    );
    assert!(
        terminal.label.contains("bundled into"),
        "{}",
        terminal.label
    );
    fs::remove_dir_all(&dir).ok();
}
