use super::shared::*;

// ====================================================================
// Table-driven per-format smoke tests.
//
// Four families of per-format tests (create round-trip, apply, probe,
// ignore-checksum) shared an identical CLI-orchestration + JSON-envelope
// skeleton repeated once per patch format. These runners capture that
// skeleton; each format supplies only its inputs, patch bytes, and
// expected output. Formats with genuinely unique behaviour (reverse
// patching, generated multi-megabyte inputs, parallel apply, multi-
// extension probing, rich structural assertions) remain standalone tests
// further down this file.
// ====================================================================

/// One `patch create` -> `patch apply` round-trip for a single format.
struct RoundTrip {
    /// `--format` flag passed to `patch create`.
    format: &'static str,
    /// Expected JSON `format` value (uppercased; some formats normalise,
    /// e.g. "vcdiff" -> "xdelta").
    expect_format: &'static str,
    /// Extension for the generated patch file.
    patch_ext: &'static str,
    original: &'static [u8],
    modified: &'static [u8],
    /// Extra flags appended to the `patch apply` command (before `--json`).
    apply_extra: &'static [&'static str],
    /// Optional assertion over the created patch bytes.
    patch_assert: Option<fn(&[u8])>,
}

fn run_round_trip(rt: &RoundTrip) {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child(format!("update.{}", rt.patch_ext));
    let output = temp.child("output.bin");
    fs::write(original.path(), rt.original).expect("fixture");
    fs::write(modified.path(), rt.modified).expect("fixture");

    let original_s = original.path().to_str().expect("path").to_owned();
    let patch_s = patch.path().to_str().expect("path").to_owned();
    let modified_s = modified.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    let create = run_single_json_event(
        &[
            "patch",
            "create",
            "--original",
            &original_s,
            "--modified",
            &modified_s,
            "--format",
            rt.format,
            "--output",
            &patch_s,
            "--threads",
            "8",
            "--json",
        ],
        0,
    );
    assert_eq!(create["command"], "patch-create");
    assert_eq!(create["family"], "patch");
    assert_eq!(create["format"], rt.expect_format);
    assert_eq!(create["requested_threads"], 8);
    assert_eq!(create["effective_threads"], 1);
    assert_eq!(create["used_parallelism"], false);
    assert_eq!(create["status"], "succeeded");

    if let Some(check) = rt.patch_assert {
        check(&fs::read(patch.path()).expect("patch bytes"));
    }

    let mut apply_args = vec![
        "patch",
        "apply",
        "--input",
        &original_s,
        "--patch",
        &patch_s,
        "--output",
        &output_s,
        "--no-compress",
    ];
    apply_args.extend_from_slice(rt.apply_extra);
    apply_args.push("--json");
    let apply = run_single_json_event(&apply_args, 0);
    assert_patch_envelope(&apply, "patch-apply", rt.expect_format, "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output").as_slice(),
        rt.modified
    );
}

macro_rules! round_trip_test {
    ($name:ident, $spec:expr) => {
        #[test]
        fn $name() {
            run_round_trip(&$spec);
        }
    };
}

round_trip_test!(
    patch_create_succeeds_for_ips_and_round_trips,
    RoundTrip {
        format: "ips",
        expect_format: "IPS",
        patch_ext: "ips",
        original: b"abcdefgh",
        modified: b"a1XYZf!!!",
        apply_extra: &["--ignore-checksum-validation"],
        patch_assert: None,
    }
);
round_trip_test!(
    patch_create_succeeds_for_ebp_and_round_trips,
    RoundTrip {
        format: "ebp",
        expect_format: "EBP",
        patch_ext: "ebp",
        original: b"abcdefgh",
        modified: b"a1XYZf!!",
        apply_extra: &[],
        patch_assert: Some(|bytes| {
            assert!(bytes.ends_with(
            br#"{"patcher":"EBPatcher","Author":"Unknown","Description":"No description","Title":"Untitled"}"#
        ));
        }),
    }
);
round_trip_test!(
    patch_create_succeeds_for_solid_and_round_trips,
    RoundTrip {
        format: "solid",
        expect_format: "SOLID",
        patch_ext: "solid",
        original: b"1234567890abcdef",
        modified: b"1234XY7890abc!",
        apply_extra: &[],
        patch_assert: None,
    }
);
round_trip_test!(
    patch_create_treats_vcdiff_as_xdelta_and_round_trips,
    RoundTrip {
        format: "vcdiff",
        expect_format: "xdelta",
        patch_ext: "xdelta",
        original: b"hello old world",
        modified: b"hello new world",
        apply_extra: &[],
        patch_assert: None,
    }
);
round_trip_test!(
    patch_create_succeeds_for_bps_and_round_trips,
    RoundTrip {
        format: "bps",
        expect_format: "BPS",
        patch_ext: "bps",
        original: b"hello old world",
        modified: b"hello new world",
        apply_extra: &[],
        patch_assert: None,
    }
);
round_trip_test!(
    patch_create_succeeds_for_bdf_and_round_trips,
    RoundTrip {
        format: "bdf",
        expect_format: "BDF/BSDIFF40",
        patch_ext: "bdf",
        original: b"The quick brown fox jumps over the lazy dog.",
        modified: b"The quick brown cat jumps over two lazy dogs!",
        apply_extra: &[],
        patch_assert: Some(|bytes| {
            assert_eq!(&bytes[..8], b"BSDIFF40");
        }),
    }
);
round_trip_test!(
    patch_create_succeeds_for_ups_and_round_trips,
    RoundTrip {
        format: "ups",
        expect_format: "UPS",
        patch_ext: "ups",
        original: b"hello old world",
        modified: b"hello new world",
        apply_extra: &[],
        patch_assert: None,
    }
);
round_trip_test!(
    patch_create_succeeds_for_ppf_and_round_trips,
    RoundTrip {
        format: "ppf",
        expect_format: "PPF",
        patch_ext: "ppf",
        original: b"hello old world",
        modified: b"hello new world\0\0",
        apply_extra: &[],
        patch_assert: None,
    }
);
round_trip_test!(
    patch_create_succeeds_for_mod_and_round_trips,
    RoundTrip {
        format: "mod",
        expect_format: "MOD",
        patch_ext: "mod",
        original: &[0x01, 0x02],
        modified: &[0x01, 0x02, 0x00, 0x00],
        apply_extra: &["--ignore-checksum-validation"],
        patch_assert: None,
    }
);
round_trip_test!(
    patch_create_succeeds_for_dps_and_round_trips,
    RoundTrip {
        format: "dps",
        expect_format: "DPS",
        patch_ext: "dps",
        original: b"hello old world",
        modified: b"hello new world + dps",
        apply_extra: &[],
        patch_assert: Some(|bytes| {
            assert!(bytes.len() >= 198);
            assert_eq!(bytes[193], 1);
            assert_ne!(&bytes[..2], b"PK");
            assert_eq!(
                u32::from_le_bytes([bytes[194], bytes[195], bytes[196], bytes[197]]),
                15
            );
        }),
    }
);
round_trip_test!(
    patch_create_succeeds_for_pat_and_round_trips,
    RoundTrip {
        format: "pat",
        expect_format: "PAT",
        patch_ext: "pat",
        original: b"hello old world",
        modified: b"HELlo old worlD",
        apply_extra: &[],
        patch_assert: Some(|bytes| {
            assert!(String::from_utf8_lossy(bytes).contains("00000000 68 48"));
        }),
    }
);

/// Thread-mode assertion for `patch apply` (always invoked with `--threads 8`).
enum ApplyThreads {
    /// Single-threaded format: effective=1, used_parallelism=false.
    Single,
    /// Opportunistically parallel: effective in 1..=8, used = effective>1.
    Range,
}

/// Apply `patch`, asserting the standard envelope, thread mode, and output bytes.
fn run_patch_apply(
    input: &[u8],
    patch_name: &str,
    patch: &[u8],
    expect_format: &str,
    threads: ApplyThreads,
    extra: &[&str],
    expected: &[u8],
) {
    let temp = setup_temp_dir();
    let in_child = temp.child("input.bin");
    let patch_child = temp.child(patch_name);
    let out_child = temp.child("output.bin");
    fs::write(in_child.path(), input).expect("fixture");
    fs::write(patch_child.path(), patch).expect("fixture");
    let in_s = in_child.path().to_str().expect("path").to_owned();
    let patch_s = patch_child.path().to_str().expect("path").to_owned();
    let out_s = out_child.path().to_str().expect("path").to_owned();

    let mut args = vec![
        "patch",
        "apply",
        "--input",
        &in_s,
        "--patch",
        &patch_s,
        "--output",
        &out_s,
        "--threads",
        "8",
    ];
    args.extend_from_slice(extra);
    args.push("--no-compress");
    args.push("--json");
    let json = run_single_json_event(&args, 0);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], expect_format);
    assert_eq!(json["requested_threads"], 8);
    match threads {
        ApplyThreads::Single => {
            assert_eq!(json["effective_threads"], 1);
            assert_eq!(json["used_parallelism"], false);
        }
        ApplyThreads::Range => {
            let effective = json["effective_threads"]
                .as_u64()
                .expect("effective_threads");
            assert!((1..=8).contains(&effective));
            assert_eq!(json["used_parallelism"], effective > 1);
        }
    }
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_child.path()).expect("output").as_slice(),
        expected
    );
}

/// Create a patch via the CLI (from `original`/`modified`) and return its bytes.
fn create_patch_bytes(format: &str, patch_ext: &str, original: &[u8], modified: &[u8]) -> Vec<u8> {
    let temp = setup_temp_dir();
    let original_child = temp.child("create-old.bin");
    let modified_child = temp.child("create-new.bin");
    let patch_child = temp.child(format!("create.{patch_ext}"));
    fs::write(original_child.path(), original).expect("fixture");
    fs::write(modified_child.path(), modified).expect("fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original_child.path().to_str().expect("path"),
            "--modified",
            modified_child.path().to_str().expect("path"),
            "--format",
            format,
            "--output",
            patch_child.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    fs::read(patch_child.path()).expect("patch bytes")
}

#[test]
fn patch_apply_succeeds_for_valid_ips_patch() {
    run_patch_apply(
        b"abcdefgh",
        "update.ips",
        &build_ips_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                TestIpsRecord::Rle {
                    offset: 7,
                    len: 4,
                    value: b'!',
                },
            ],
            Some(11),
        ),
        "IPS",
        ApplyThreads::Single,
        &[],
        b"abXYZfg!!!!",
    );
}

#[test]
fn patch_apply_rejects_output_aliases_without_modifying_sources() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let patch = temp.child("update.ips");
    let original = b"abcdefgh";
    fs::write(input.path(), original).expect("input fixture");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 0,
            data: b"Z".to_vec(),
        }],
        None,
    );
    fs::write(patch.path(), &patch_bytes).expect("patch fixture");

    let apply = |output: &Path| {
        run_single_json_event(
            &[
                "patch",
                "apply",
                "--input",
                input.path().to_str().expect("input path"),
                "--patch",
                patch.path().to_str().expect("patch path"),
                "--output",
                output.to_str().expect("output path"),
                "--no-compress",
                "--json",
            ],
            1,
        )
    };

    let nested = temp.child("nested");
    fs::create_dir_all(nested.path()).expect("nested directory");
    let canonical_alias = nested.path().join("..").join("input.bin");
    let hardlink_alias = temp.child("input-hardlink.bin");
    fs::hard_link(input.path(), hardlink_alias.path()).expect("hard link");

    for output in [
        input.path(),
        canonical_alias.as_path(),
        hardlink_alias.path(),
    ] {
        let json = apply(output);
        assert_eq!(json["status"], "failed");
        assert_eq!(json["stage"], "validate");
        assert!(
            json["label"]
                .as_str()
                .expect("label")
                .contains("input and output resolve to the same file")
        );
        assert_eq!(fs::read(input.path()).expect("input remains"), original);
    }

    let canonical_patch_alias = nested.path().join("..").join("update.ips");
    let patch_hardlink = temp.child("patch-hardlink.ips");
    fs::hard_link(patch.path(), patch_hardlink.path()).expect("patch hard link");
    let mut patch_aliases = vec![
        patch.path().to_path_buf(),
        canonical_patch_alias,
        patch_hardlink.path().to_path_buf(),
    ];
    #[cfg(unix)]
    {
        let patch_symlink = temp.child("patch-symlink.ips");
        std::os::unix::fs::symlink(patch.path(), patch_symlink.path()).expect("patch symlink");
        patch_aliases.push(patch_symlink.path().to_path_buf());
    }

    for output in patch_aliases {
        let json = apply(&output);
        assert_eq!(json["status"], "failed");
        assert_eq!(json["stage"], "validate");
        assert!(
            json["label"]
                .as_str()
                .expect("label")
                .contains("output and patch file")
        );
        assert_eq!(fs::read(patch.path()).expect("patch remains"), patch_bytes);
    }
}

#[test]
fn patch_apply_succeeds_for_valid_ebp_patch() {
    run_patch_apply(
        b"abcdefgh",
        "update.ebp",
        &build_ebp_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                TestIpsRecord::Rle {
                    offset: 7,
                    len: 2,
                    value: b'!',
                },
            ],
            r#"{"patcher":"EBPatcher","Title":"Smoke"}"#,
        ),
        "EBP",
        ApplyThreads::Single,
        &["--ignore-checksum-validation"],
        b"abXYZfg!!",
    );
}

#[test]
fn patch_apply_succeeds_for_valid_solid_patch() {
    let patch = create_patch_bytes("solid", "solid", b"abcdefghij", b"abCDfgh");
    run_patch_apply(
        b"abcdefghij",
        "update.solid",
        &patch,
        "SOLID",
        ApplyThreads::Single,
        &["--ignore-checksum-validation"],
        b"abCDfgh",
    );
}

#[test]
fn patch_apply_succeeds_for_valid_gdiff_patch() {
    run_patch_apply(
        b"abcdefgh",
        "update.gdiff",
        &build_gdiff_patch(vec![
            TestGdiffCommand::Copy { offset: 0, len: 2 },
            TestGdiffCommand::Data(b"XY".to_vec()),
            TestGdiffCommand::Copy { offset: 4, len: 4 },
        ]),
        "GDIFF",
        ApplyThreads::Range,
        &[],
        b"abXYefgh",
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ffp_patch() {
    run_patch_apply(
        b"abcdefgh",
        "update.ffp",
        b"comment line\n00000000 61 41\n00000001 62 42\n",
        "PAT",
        ApplyThreads::Range,
        &[],
        b"ABcdefgh",
    );
}

#[test]
fn patch_apply_succeeds_for_valid_xdelta_patch() {
    let expected = b"abcabcZZabcabc";
    let patch = build_patch(
        Some(b"xdelta-cli"),
        vec![TestWindow {
            win_indicator: 0x01 | 0x04,
            source_segment_size: Some(12),
            source_segment_position: Some(0),
            target_window_size: expected.len() as u64,
            checksum: Some(adler32(expected)),
            data: b"ZZ".to_vec(),
            inst: vec![22, 3, 22],
            addr: encode_all_varints(&[0, 6]),
        }],
    );
    run_patch_apply(
        b"abcabcabcabc",
        "update.xdelta",
        &patch,
        "xdelta",
        ApplyThreads::Single,
        &[],
        expected,
    );
}

#[test]
fn patch_apply_succeeds_for_valid_bps_patch() {
    run_patch_apply(
        b"abcabcabcabc",
        "update.bps",
        &SIMPLE_BPS_PATCH,
        "BPS",
        ApplyThreads::Range,
        &[],
        b"abcabcZZabcabc",
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ppf_patch() {
    run_patch_apply(
        b"abcabcabcabc",
        "update.ppf",
        &build_ppf1_patch(
            "cli test patch",
            vec![TestPpfRecord {
                offset: 6,
                data: b"ZZ".to_vec(),
            }],
        ),
        "PPF",
        ApplyThreads::Single,
        &[],
        b"abcabcZZcabc",
    );
}

#[test]
fn patch_apply_succeeds_for_valid_aps_patch() {
    let mut source = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    let mut target = source.clone();
    target[0x0123] ^= 0x3f;
    target[0x8000] = 0x5a;
    run_patch_apply(
        &source,
        "update.aps",
        &build_apsgba_patch(&source, &target),
        // Signature-based probing routes APS1 payloads to APSGBA even with a .aps name.
        "APSGBA",
        ApplyThreads::Single,
        &[],
        &target,
    );
}

#[test]
fn patch_apply_succeeds_for_valid_mod_patch() {
    run_patch_apply(
        b"ORIGINAL",
        "update.mod",
        &build_mod_patch(vec![(1, b"X".to_vec())]),
        "MOD",
        ApplyThreads::Single,
        &["--ignore-checksum-validation"],
        b"OXIGINAL",
    );
}

/// Probe `patch`, asserting the standard probe envelope.
fn run_probe_success(patch_name: &str, patch: &[u8], expect_format: &str) {
    let temp = setup_temp_dir();
    let patch_child = temp.child(patch_name);
    fs::write(patch_child.path(), patch).expect("fixture");
    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            patch_child.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_patch_envelope(&json, "probe", expect_format, "succeeded");
}

#[test]
fn probe_succeeds_for_valid_mod_patch() {
    run_probe_success(
        "update.mod",
        &build_mod_patch(vec![(1, b"X".to_vec())]),
        "MOD",
    );
}

#[test]
fn probe_succeeds_for_valid_dldi_patch() {
    run_probe_success(
        "update.dldi",
        &build_dldi_driver(8, 0xBF80_0000u32 as i32, "Probe driver"),
        "DLDI",
    );
}

#[test]
fn probe_succeeds_for_valid_gdiff_patch() {
    run_probe_success(
        "update.gdiff",
        &build_gdiff_patch(vec![
            TestGdiffCommand::Copy { offset: 0, len: 2 },
            TestGdiffCommand::Data(b"XY".to_vec()),
            TestGdiffCommand::Copy { offset: 2, len: 2 },
        ]),
        "GDIFF",
    );
}

#[test]
fn probe_succeeds_for_valid_hdiffpatch_patch() {
    run_probe_success(
        "update.hpatchz",
        &build_hdiff13_nocomp_patch(b"source bytes", b"target bytes for hdiffpatch"),
        "HDiffPatch/HPatchZ",
    );
}

#[test]
fn probe_succeeds_for_valid_ebp_patch() {
    run_probe_success(
        "update.ebp",
        &build_ebp_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"A".to_vec(),
            }],
            r#"{"patcher":"EBPatcher","Title":"Probe"}"#,
        ),
        "EBP",
    );
}

#[test]
fn probe_succeeds_for_valid_ips32_patch() {
    run_probe_success(
        "update.ips32",
        &build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"A".to_vec(),
        }]),
        "IPS32",
    );
}

#[test]
fn probe_succeeds_for_ips32_patch_with_ips_extension() {
    run_probe_success(
        "update.ips",
        &build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"A".to_vec(),
        }]),
        "IPS32",
    );
}

#[test]
fn probe_succeeds_for_valid_dps_patch() {
    let patch = create_patch_bytes("dps", "dps", b"01234567", b"0123ZZ67");
    run_probe_success("update.dps", &patch, "DPS");
}

#[test]
fn probe_succeeds_for_valid_solid_patch() {
    let patch = create_patch_bytes("solid", "solid", b"abcdefgh", b"abcZefgh");
    run_probe_success("update.solid", &patch, "SOLID");
}

/// Strict apply fails on a checksum/size mismatch; `--ignore-checksum-validation`
/// succeeds and produces `expected`.
fn run_can_ignore_checksum(
    input_name: &str,
    input: &[u8],
    patch_name: &str,
    patch: &[u8],
    expect_format: &str,
    strict_label: &str,
    expected: &[u8],
) {
    let temp = setup_temp_dir();
    let in_child = temp.child(input_name);
    let patch_child = temp.child(patch_name);
    let strict_out = temp.child("strict-output.bin");
    let out_child = temp.child("output.bin");
    fs::write(in_child.path(), input).expect("fixture");
    fs::write(patch_child.path(), patch).expect("fixture");
    let in_s = in_child.path().to_str().expect("path").to_owned();
    let patch_s = patch_child.path().to_str().expect("path").to_owned();

    let strict = run_single_json_event(
        &[
            "patch",
            "apply",
            "--input",
            &in_s,
            "--patch",
            &patch_s,
            "--output",
            strict_out.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    assert_patch_envelope(&strict, "patch-apply", expect_format, "failed");
    assert!(
        strict["label"]
            .as_str()
            .expect("label")
            .contains(strict_label)
    );

    let ignored = run_single_json_event(
        &[
            "patch",
            "apply",
            "--input",
            &in_s,
            "--patch",
            &patch_s,
            "--output",
            out_child.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_patch_envelope(&ignored, "patch-apply", expect_format, "succeeded");
    assert!(
        ignored["label"]
            .as_str()
            .expect("label")
            .contains("checksum validation skipped")
    );
    assert_eq!(
        fs::read(out_child.path()).expect("output").as_slice(),
        expected
    );
}

#[test]
fn patch_apply_can_ignore_checksum_validation_for_bps() {
    let patch = create_patch_bytes("bps", "bps", b"hello old world", b"hello new world");
    run_can_ignore_checksum(
        "old-mismatch.bin",
        b"hello zld world",
        "update.bps",
        &patch,
        "BPS",
        "Input checksum invalid",
        b"hello new world",
    );
}

#[test]
fn patch_apply_can_ignore_checksum_validation_for_dps() {
    let patch = create_patch_bytes("dps", "dps", b"hello old world", b"hello new world + dps");
    run_can_ignore_checksum(
        "old-mismatch.bin",
        b"hello old world!",
        "update.dps",
        &patch,
        "DPS",
        "source size mismatch",
        b"hello new world + dps",
    );
}

#[test]
fn patch_apply_can_ignore_checksum_validation_for_xdelta() {
    let expected = b"abcabcZZabcabc";
    let patch = build_patch(
        Some(b"xdelta-cli"),
        vec![TestWindow {
            win_indicator: 0x01 | 0x04,
            source_segment_size: Some(12),
            source_segment_position: Some(0),
            target_window_size: expected.len() as u64,
            checksum: Some(adler32(expected) ^ 0x0000_0001),
            data: b"ZZ".to_vec(),
            inst: vec![22, 3, 22],
            addr: encode_all_varints(&[0, 6]),
        }],
    );
    run_can_ignore_checksum(
        "input.bin",
        b"abcabcabcabc",
        "update.xdelta",
        &patch,
        "xdelta",
        "checksum mismatch",
        expected,
    );
}

#[test]
fn patch_flat_commands_are_rejected() {
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["patch-apply", "--help"])
        .assert()
        .code(2);
}

#[test]
fn patch_apply_validates_output_checksum() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![
                TestIpsRecord::Literal {
                    offset: 2,
                    data: b"XYZ".to_vec(),
                },
                TestIpsRecord::Rle {
                    offset: 7,
                    len: 4,
                    value: b'!',
                },
            ],
            Some(11),
        ),
    )
    .expect("fixture");

    // Correct output checksums (crc32 + sha1) succeed and are reported in the label.
    let ok_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--expect-out",
            "crc32=3fc13708",
            "--expect-out",
            "sha1=10c54c25716315070c5c7336ae9fcd483991f6e7",
            "--json",
        ],
        0,
    );
    let ok_json = parse_single_json_line(&ok_output);
    assert_eq!(ok_json["status"], "succeeded");
    assert!(
        ok_json["label"]
            .as_str()
            .expect("label")
            .contains("output checksum(s) verified")
    );

    // A wrong output checksum fails the apply.
    let bad_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("bad-output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--expect-out",
            "crc32=deadbeef",
            "--json",
        ],
        1,
    );
    let bad_json = parse_single_json_line(&bad_output);
    assert_eq!(bad_json["status"], "failed");
    assert!(
        bad_json["label"]
            .as_str()
            .expect("label")
            .contains("output checksum mismatch for crc32")
    );
}

#[test]
fn patch_apply_can_ignore_recoverable_ips_validation() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Rle {
                offset: 0,
                len: 0,
                value: 0xFF,
            }],
            None,
        ),
    )
    .expect("fixture");

    let strict_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("strict-output.bin")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    let strict_json = parse_single_json_line(&strict_output);
    assert_eq!(strict_json["command"], "patch-apply");
    assert_eq!(strict_json["format"], "IPS");
    assert_eq!(strict_json["status"], "failed");
    assert!(
        strict_json["label"]
            .as_str()
            .expect("label")
            .contains("invalid zero-length IPS RLE record")
    );

    let ignored_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("ignored-output.bin")
                .path()
                .to_str()
                .expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ],
        0,
    );
    let ignored_json = parse_single_json_line(&ignored_output);
    assert_eq!(ignored_json["command"], "patch-apply");
    assert_eq!(ignored_json["format"], "IPS");
    assert_eq!(ignored_json["status"], "succeeded");
    assert!(
        ignored_json["label"]
            .as_str()
            .expect("label")
            .contains("warning=ignored zero-length IPS RLE record at offset 0")
    );
    assert_eq!(
        fs::read(temp.child("ignored-output.bin").path()).expect("output"),
        b"abcdefgh"
    );
}

#[test]
fn patch_apply_warns_when_ips_does_not_change_output() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 2,
                data: b"c".to_vec(),
            }],
            None,
        ),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("warning=IPS patch did not change output")
    );
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abcdefgh"
    );
}

#[test]
fn patch_apply_reports_pds_as_explicitly_unsupported() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(temp.child("update.pds").path(), b"not-a-supported-pds").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.pds").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-apply", "PDS", "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("explicitly not supported")
    );
}

#[test]
fn patch_apply_compresses_with_explicit_format_and_appends_extension() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output_base = temp.child("patched-output");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    // Extensionless output requires an explicit --compress-format; the container extension is then
    // appended to the output name.
    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--compress-format",
            "7z",
            "--json",
        ],
        0,
    );
    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as 7z"));
    assert!(apply_label.contains("explicit format=7z"));

    let compressed_path = temp.child("patched-output.7z");
    let emitted = apply_json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    assert_eq!(emitted.len(), 1);
    assert_emitted_file(&apply_json, compressed_path.path(), Some("archive"));
    assert!(compressed_path.path().exists());
    assert!(!output_base.path().exists());

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            compressed_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.child("patched-output.bin").path()).expect("archive entry"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_z3ds_compression_uses_matching_container_suffix() {
    let temp = setup_temp_dir();
    let cases = [
        ("3ds", "z3ds"),
        ("cci", "zcci"),
        ("cia", "zcia"),
        ("cxi", "zcxi"),
        ("3dsx", "z3dsx"),
    ];

    for (input_extension, compressed_extension) in cases {
        let original = temp.child(format!("old-{input_extension}.{input_extension}"));
        let modified = temp.child(format!("new-{input_extension}.{input_extension}"));
        let patch = temp.child(format!("update-{input_extension}.bps"));
        let output_base = temp.child(format!("patched-{input_extension}"));

        fs::write(original.path(), b"hello old world").expect("fixture");
        fs::write(modified.path(), b"hello new world").expect("fixture");

        command_stdout(
            &[
                "patch",
                "create",
                "--original",
                original.path().to_str().expect("path"),
                "--modified",
                modified.path().to_str().expect("path"),
                "--format",
                "bps",
                "--output",
                patch.path().to_str().expect("path"),
                "--json",
            ],
            0,
        );

        let apply_output = command_stdout(
            &[
                "patch",
                "apply",
                "--input",
                original.path().to_str().expect("path"),
                "--patch",
                patch.path().to_str().expect("path"),
                "--output",
                output_base.path().to_str().expect("path"),
                "--compress-format",
                "z3ds",
                "--json",
            ],
            0,
        );
        let apply_json = parse_single_json_line(&apply_output);
        assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
        let apply_label = apply_json["label"].as_str().expect("label");
        assert!(apply_label.contains("patch output compressed as z3ds"));

        let compressed_path =
            temp.child(format!("patched-{input_extension}.{compressed_extension}"));
        assert!(compressed_path.path().exists());
        assert_emitted_file(&apply_json, compressed_path.path(), Some("archive"));
    }
}

#[test]
fn patch_apply_infers_zip_from_output_extension() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let input_zip = temp.child("input.zip");
    let output_base = temp.child("patched-out.zip");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            input_zip.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input_zip.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as zip"));
    assert!(apply_label.contains("format=zip from output extension"));

    let compressed_path = temp.child("patched-out.zip");
    assert!(compressed_path.path().exists());

    let out_dir = temp.child("extract");
    command_stdout(
        &[
            "extract",
            "--input",
            compressed_path.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(
        read_single_file_bytes(out_dir.path()),
        fs::read(modified.path()).expect("modified")
    );
}

fn make_bps_patch_fixture(
    temp: &assert_fs::TempDir,
) -> (assert_fs::fixture::ChildPath, assert_fs::fixture::ChildPath) {
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    (original, patch)
}

#[test]
fn patch_apply_rejects_extensionless_output_without_format() {
    let temp = setup_temp_dir();
    let (original, patch) = make_bps_patch_fixture(&temp);
    let output_base = temp.child("patched-output");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "failed");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("output has no file extension"));
    assert!(label.contains("--no-compress"));
}

#[test]
fn patch_apply_compress_format_overrides_mismatched_extension_with_warning() {
    let temp = setup_temp_dir();
    let (original, patch) = make_bps_patch_fixture(&temp);
    // Name the output `.zip` but force 7z: the flag wins, the file keeps its exact name, and the
    // mismatch is warned about.
    let output_base = temp.child("patched.zip");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--compress-format",
            "7z",
            "--json",
        ],
        0,
    );
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "succeeded");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("patch output compressed as 7z"));
    assert!(label.contains("warning"));
    assert!(label.contains("does not match"));
    // Output keeps the exact requested name; no extension is appended.
    assert!(output_base.path().exists());
    assert!(!temp.child("patched.zip.7z").path().exists());
}

#[test]
fn patch_apply_rejects_extract_only_output_extension() {
    let temp = setup_temp_dir();
    let (original, patch) = make_bps_patch_fixture(&temp);
    let output_base = temp.child("patched.cso");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "failed");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("extract-only")
    );
}

#[test]
fn patch_apply_accepts_explicit_compress_format_and_codec() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output_base = temp.child("patched");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--compress-format",
            "zip",
            "--compress-codec",
            "deflate",
            "--compress-level",
            "very-high",
            "--json",
        ],
        0,
    );
    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as zip"));
    assert!(apply_label.contains("codec=deflate"));
    assert!(apply_label.contains("explicit format=zip"));

    let compressed_path = temp.child("patched.zip");
    assert!(compressed_path.path().exists());
    assert!(!output_base.path().exists());
}

#[test]
fn patch_apply_rejects_no_compress_with_compress_flags() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--compress-format",
            "zip",
            "--json",
        ],
        1,
    );
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "failed");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("--no-compress cannot be combined with --compress-format")
    );
}

#[test]
fn patch_apply_applies_multiple_patches_in_order() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let intermediate = temp.child("intermediate.bin");
    let expected = temp.child("expected.bin");
    let first_patch = temp.child("update-step-1.bps");
    let second_patch = temp.child("update-step-2.ips");
    let output = temp.child("output.bin");

    fs::write(input.path(), b"abcabcabcabc").expect("fixture");
    fs::write(intermediate.path(), b"abcabcZZabcabc").expect("fixture");
    fs::write(expected.path(), b"abcabcYYabcabc").expect("fixture");
    fs::write(first_patch.path(), SIMPLE_BPS_PATCH).expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            intermediate.path().to_str().expect("path"),
            "--modified",
            expected.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            second_patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            first_patch.path().to_str().expect("path"),
            "--patch",
            second_patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let events = parse_json_lines(&apply_output);
    assert_running_percent_event_in_range(&events, "patch-apply", "BPS", 0.0, 50.1);
    assert!(events.iter().any(|event| {
        event["command"] == "patch-apply"
            && event["status"] == "running"
            && event["stage"] == "apply"
            && event["format"] == "IPS"
            && event["percent"].is_null()
    }));
    let json = events.last().expect("json line");
    assert_patch_envelope(json, "patch-apply", "IPS", "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("applied 2 patches sequentially")
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(expected.path()).expect("expected")
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ips32_patch() {
    let temp = setup_temp_dir();
    write_sparse_bytes(
        temp.child("input.bin").path(),
        0x0100_0002,
        0x0100_0000,
        b"ab",
    );
    fs::write(
        temp.child("update.ips32").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0001,
            data: b"Z".to_vec(),
        }]),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips32").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 8);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), 0x0100_0002);
    assert_eq!(output_bytes[0x0100_0000], b'a');
    assert_eq!(output_bytes[0x0100_0001], b'Z');
}

#[test]
fn patch_apply_succeeds_for_ips32_patch_with_ips_extension() {
    let temp = setup_temp_dir();
    write_sparse_bytes(
        temp.child("input.bin").path(),
        0x0100_0002,
        0x0100_0000,
        b"ab",
    );
    fs::write(
        temp.child("update.ips").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0001,
            data: b"Z".to_vec(),
        }]),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-apply", "IPS32", "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), 0x0100_0002);
    assert_eq!(output_bytes[0x0100_0000], b'a');
    assert_eq!(output_bytes[0x0100_0001], b'Z');
}

#[test]
fn patch_create_warns_for_identical_ips_inputs() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ips");
    fs::write(original.path(), b"unchanged-input").expect("fixture");
    fs::write(modified.path(), b"unchanged-input").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("warning=IPS patch will not change output")
    );
    assert_eq!(fs::read(patch.path()).expect("patch"), b"PATCHEOF");
}

#[test]
fn patch_create_candidates_default_to_bps_for_small_inputs() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--plan",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-create", "bps", "succeeded");
    let candidates = &json["details"]["patch_create_format_candidates"];
    assert_eq!(candidates["default"], "bps");
    let formats = candidates["formats"].as_array().expect("formats array");
    assert_eq!(
        formats
            .iter()
            .map(|value| value.as_str().expect("format"))
            .collect::<Vec<_>>(),
        vec![
            "bps", "xdelta", "aps", "bdf", "ebp", "ips", "pmsr", "ppf", "rup", "ups",
        ]
    );
    assert_eq!(candidates["source_values"]["original"]["size"], 15);
    assert_eq!(candidates["source_values"]["modified"]["size"], 15);
}

#[test]
fn patch_create_candidates_default_to_xdelta_for_special_compression_inputs() {
    let temp = setup_temp_dir();
    let original = temp.child("old.chd");
    let modified = temp.child("new.bin");
    fs::write(original.path(), b"compressed disc").expect("fixture");
    fs::write(modified.path(), b"raw disc").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--plan",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["status"], "succeeded");
    let candidates = &json["details"]["patch_create_format_candidates"];
    assert_eq!(candidates["default"], "xdelta");
    assert_eq!(
        candidates["source_values"]["original"]["special_compression"],
        true
    );
    assert_eq!(
        candidates["source_values"]["modified"]["special_compression"],
        false
    );
}

#[test]
fn patch_create_candidates_default_to_xdelta_for_archives_above_64_mib() {
    let temp = setup_temp_dir();
    let original = temp.child("old.zip");
    let modified = temp.child("new.bin");
    let len = 64 * 1024 * 1024 + 1;
    write_sparse_bytes(original.path(), len, 0, &[0]);
    fs::write(modified.path(), b"raw rom").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--plan",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["status"], "succeeded");
    let candidates = &json["details"]["patch_create_format_candidates"];
    assert_eq!(candidates["default"], "xdelta");
    assert_eq!(
        candidates["limits"]["archive_default_size_bytes"],
        64 * 1024 * 1024
    );
    assert_eq!(candidates["source_values"]["original"]["archive"], true);
    assert_eq!(candidates["source_values"]["original"]["size"], len);
}

#[test]
fn patch_create_candidates_default_to_xdelta_from_128_mib() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let len = 128 * 1024 * 1024;
    write_sparse_bytes(original.path(), len, 0, &[0]);
    write_sparse_bytes(modified.path(), len, 0, &[1]);

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--plan",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["status"], "succeeded");
    let candidates = &json["details"]["patch_create_format_candidates"];
    assert_eq!(candidates["default"], "xdelta");
    assert_eq!(
        candidates["formats"]
            .as_array()
            .expect("formats array")
            .iter()
            .map(|value| value.as_str().expect("format"))
            .collect::<Vec<_>>(),
        vec!["xdelta", "bps", "aps", "bdf", "pmsr", "ppf", "rup", "ups"]
    );
}

#[test]
fn patch_create_candidates_default_to_xdelta_above_256_mib_while_allowing_ppf() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let len = 256 * 1024 * 1024 + 1;
    write_sparse_bytes(original.path(), len, 0, &[0]);
    write_sparse_bytes(modified.path(), len, 0, &[1]);

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--plan",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["status"], "succeeded");
    let candidates = &json["details"]["patch_create_format_candidates"];
    assert_eq!(candidates["default"], "xdelta");
    assert_eq!(
        candidates["formats"]
            .as_array()
            .expect("formats array")
            .iter()
            .map(|value| value.as_str().expect("format"))
            .collect::<Vec<_>>(),
        vec!["xdelta", "ppf"]
    );
    assert_eq!(
        candidates["limits"]["legacy_size_limit_bytes"],
        256 * 1024 * 1024
    );
}

#[test]
fn patch_create_allows_ppf_above_256_mib_when_requested() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ppf");
    let len = 256 * 1024 * 1024 + 1;
    write_sparse_bytes(original.path(), len, len - 1, &[0]);
    write_sparse_bytes(modified.path(), len, len - 1, &[1]);

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ppf",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "1",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "PPF");
    assert_eq!(json["status"], "succeeded");
    assert!(fs::read(patch.path()).expect("patch").starts_with(b"PPF30"));
}

#[test]
fn patch_create_rejects_non_xdelta_ppf_formats_above_256_mib() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.bps");
    let len = 256 * 1024 * 1024 + 1;
    write_sparse_bytes(original.path(), len, 0, &[0]);
    write_sparse_bytes(modified.path(), len, 0, &[1]);

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("above 268.44 MB")
    );
}

#[test]
fn patch_create_rejects_classic_ips_at_size_limit_even_when_validation_ignored() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ips");
    let len = 0x0100_0001;
    write_sparse_bytes(original.path(), len, 0, &[0]);
    write_sparse_bytes(modified.path(), len, 0, &[0x5A]);

    let strict_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let strict_json = parse_single_json_line(&strict_output);
    assert_eq!(strict_json["command"], "patch-create");
    assert_eq!(strict_json["format"], "IPS");
    assert_eq!(strict_json["status"], "failed");
    assert!(
        strict_json["label"]
            .as_str()
            .expect("label")
            .contains("at or above 16.78 MB")
    );

    let ignored_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            patch.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--json",
        ],
        1,
    );

    let ignored_json = parse_single_json_line(&ignored_output);
    assert_eq!(ignored_json["command"], "patch-create");
    assert_eq!(ignored_json["format"], "IPS");
    assert_eq!(ignored_json["status"], "failed");
    assert!(
        ignored_json["label"]
            .as_str()
            .expect("label")
            .contains("at or above 16.78 MB")
    );
}

#[test]
fn patch_create_reports_pds_as_explicitly_unsupported() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!!").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "pds",
            "--output",
            temp.child("output.pds").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-create", "pds", "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("explicitly not supported")
    );
}

#[test]
fn patch_create_rejects_ips32_at_large_size() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ips32");
    write_sparse_bytes(original.path(), 0x0100_0002, 0x0100_0000, b"ab");
    write_sparse_bytes(modified.path(), 0x0100_0002, 0x0100_0000, b"aZ");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips32",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        1,
    );

    let create_json = parse_single_json_line(&create_output);
    assert_patch_envelope(&create_json, "patch-create", "IPS32", "failed");
    assert!(
        create_json["label"]
            .as_str()
            .expect("label")
            .contains("at or above 16.78 MB")
    );
}

#[test]
fn patch_apply_supports_patch_header_strip_with_output_modes() {
    let temp = setup_temp_dir();
    let base = b"abcdefgh".to_vec();
    let headered = with_header(&base);
    fs::write(temp.child("input.bin").path(), &headered).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"Z".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");

    let stripped_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-stripped.bin")
                .path()
                .to_str()
                .expect("path"),
            "--patch-header",
            "strip",
            "--output-header",
            "strip",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let stripped_json = parse_single_json_line(&stripped_output);
    assert_eq!(stripped_json["command"], "patch-apply");
    assert_eq!(stripped_json["family"], "patch");
    assert_eq!(stripped_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-stripped.bin").path()).expect("output"),
        b"Zbcdefgh".to_vec()
    );

    let headered_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-headered.bin")
                .path()
                .to_str()
                .expect("path"),
            "--patch-header",
            "strip",
            "--output-header",
            "keep",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(headered_json["command"], "patch-apply");
    assert_eq!(headered_json["family"], "patch");
    assert_eq!(headered_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-headered.bin").path()).expect("output"),
        with_header(b"Zbcdefgh")
    );
}

#[test]
fn patch_apply_supports_nes_patch_header_strip_with_output_modes() {
    let temp = setup_temp_dir();
    let base = b"abcdefgh".to_vec();
    let headered = with_nes_header(&base);
    fs::write(temp.child("input.nes").path(), &headered).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"Z".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");

    let stripped_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-stripped.nes")
                .path()
                .to_str()
                .expect("path"),
            "--patch-header",
            "strip",
            "--output-header",
            "strip",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let stripped_json = parse_single_json_line(&stripped_output);
    assert_eq!(stripped_json["command"], "patch-apply");
    assert_eq!(stripped_json["family"], "patch");
    assert_eq!(stripped_json["status"], "succeeded");
    assert!(
        stripped_json["label"]
            .as_str()
            .expect("label")
            .contains("input header stripped (16 bytes, No-Intro_NES.xml)")
    );
    assert_eq!(
        fs::read(temp.child("output-stripped.nes").path()).expect("output"),
        b"Zbcdefgh".to_vec()
    );

    let headered_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-headered.nes")
                .path()
                .to_str()
                .expect("path"),
            "--patch-header",
            "strip",
            "--output-header",
            "keep",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(headered_json["command"], "patch-apply");
    assert_eq!(headered_json["family"], "patch");
    assert_eq!(headered_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-headered.nes").path()).expect("output"),
        with_nes_header(b"Zbcdefgh")
    );
}

#[test]
fn patch_apply_patch_header_strip_readds_nes_header_via_output_auto() {
    let temp = setup_temp_dir();
    let base = b"abcdefgh".to_vec();
    fs::write(temp.child("input.nes").path(), with_nes_header(&base)).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"Z".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-remove.nes")
                .path()
                .to_str()
                .expect("path"),
            "--patch-header",
            "strip",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["status"], "succeeded");
    // `--patch-header strip` patches the headerless bytes; the default output-header
    // auto re-adds the emulator-required iNES header.
    assert_eq!(
        fs::read(temp.child("output-remove.nes").path()).expect("output"),
        with_nes_header(b"Zbcdefgh")
    );
}

#[test]
fn patch_apply_positional_patch_header_binds_to_preceding_patch() {
    let temp = setup_temp_dir();
    let base = b"hello old world".to_vec();
    let headered = with_nes_header(&base);
    fs::write(temp.child("input.nes").path(), &headered).expect("fixture");
    // `headered.ips` targets the HEADERED layout (offset 16 = payload byte 0);
    // `headerless.ips` targets the stripped layout (offset 1 = payload byte 1).
    fs::write(
        temp.child("headered.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 16,
                data: b"A".to_vec(),
            }],
            Some(headered.len() as u32),
        ),
    )
    .expect("fixture");
    fs::write(
        temp.child("headerless-first.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"A".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");
    fs::write(
        temp.child("headerless-second.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 1,
                data: b"B".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");
    let expected = with_nes_header(b"ABllo old world");

    // `--patch a --patch b --patch-header strip`: the occurrence binds to the
    // SECOND patch only - the first applies to the headered bytes, the header is
    // stripped between the steps, and output auto re-adds the iNES header.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("headered.ips").path().to_str().expect("path"),
            "--patch",
            temp.child("headerless-second.ips")
                .path()
                .to_str()
                .expect("path"),
            "--patch-header",
            "strip",
            "--output",
            temp.child("output-second.nes")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-second.nes").path()).expect("output"),
        expected
    );

    // `--patch a --patch-header strip --patch b`: the occurrence binds to the
    // first patch and CARRIES FORWARD to the second - both apply headerless.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("headerless-first.ips")
                .path()
                .to_str()
                .expect("path"),
            "--patch-header",
            "strip",
            "--patch",
            temp.child("headerless-second.ips")
                .path()
                .to_str()
                .expect("path"),
            "--output",
            temp.child("output-carry.nes")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-carry.nes").path()).expect("output"),
        expected
    );
}

/// `weave` and `patch weave` are aliases of `patch apply`. Top-level `weave`
/// nests the apply args one level shallower, so cover the positional
/// `--patch-header` alignment (which reads raw argv matches) on both spellings.
#[test]
fn weave_aliases_match_patch_apply() {
    let temp = setup_temp_dir();
    let base = b"hello old world".to_vec();
    let headered = with_nes_header(&base);
    fs::write(temp.child("input.nes").path(), &headered).expect("fixture");
    fs::write(
        temp.child("headered.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 16,
                data: b"A".to_vec(),
            }],
            Some(headered.len() as u32),
        ),
    )
    .expect("fixture");
    fs::write(
        temp.child("headerless-second.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 1,
                data: b"B".to_vec(),
            }],
            Some(base.len() as u32),
        ),
    )
    .expect("fixture");
    let expected = with_nes_header(b"ABllo old world");

    let input = temp.child("input.nes");
    let input = input.path().to_str().expect("path").to_string();
    let headered = temp.child("headered.ips");
    let headered = headered.path().to_str().expect("path").to_string();
    let second = temp.child("headerless-second.ips");
    let second = second.path().to_str().expect("path").to_string();

    for (index, spelling) in [vec!["weave"], vec!["patch", "weave"]].iter().enumerate() {
        let output_name = format!("output-weave-{index}.nes");
        let output_child = temp.child(&output_name);
        let output_path = output_child.path().to_str().expect("path").to_string();
        let mut args = spelling.clone();
        args.extend_from_slice(&[
            "--input",
            &input,
            "--patch",
            &headered,
            "--patch",
            &second,
            // Binds to the SECOND patch only - same argv-order semantics as apply.
            "--patch-header",
            "strip",
            "--output",
            &output_path,
            "--no-compress",
            "--json",
        ]);

        let output = command_stdout(&args, 0);
        let json = parse_single_json_line(&output);
        // The alias normalizes to the canonical command before dispatch.
        assert_eq!(json["command"], "patch-apply");
        assert_eq!(json["status"], "succeeded");
        assert_eq!(
            fs::read(temp.child(&output_name).path()).expect("output"),
            expected
        );
    }
}

#[test]
fn patch_apply_auto_header_strips_when_patch_targets_headerless_bytes() {
    let temp = setup_temp_dir();
    let base = b"hello old world".to_vec();
    let modified = temp.child("new.bin");
    fs::write(temp.child("base.bin").path(), &base).expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");
    // BPS authored against the HEADERLESS bytes embeds their crc32 as the required
    // source checksum - the evidence default-auto strips on.
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            temp.child("base.bin").path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            temp.child("update.bps").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    fs::write(temp.child("input.nes").path(), with_nes_header(&base)).expect("fixture");

    // No header flags at all: `auto` is the default.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.nes").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("input header stripped (16 bytes, No-Intro_NES.xml)")
    );
    // The header is re-added after apply, so the output stays a playable .nes.
    assert_eq!(
        fs::read(temp.child("output.nes").path()).expect("output"),
        with_nes_header(b"hello new world")
    );
}

#[test]
fn patch_apply_auto_n64_byte_order_matches_patch_and_restores_input_order() {
    fn byte_swap(words: &[u8]) -> Vec<u8> {
        let mut swapped = words.to_vec();
        for pair in swapped.chunks_exact_mut(2) {
            pair.swap(0, 1);
        }
        swapped
    }

    let temp = setup_temp_dir();
    let z64 = [
        0x80, 0x37, 0x12, 0x40, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
        0x0b,
    ];
    let mut modified_z64 = z64;
    modified_z64[12..].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
    fs::write(temp.child("original.z64").path(), z64).expect("fixture");
    fs::write(temp.child("modified.z64").path(), modified_z64).expect("fixture");
    fs::write(temp.child("input.v64").path(), byte_swap(&z64)).expect("fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            temp.child("original.z64").path().to_str().expect("path"),
            "--modified",
            temp.child("modified.z64").path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            temp.child("update.bps").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let validate = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            temp.child("input.v64").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(parse_single_json_line(&validate)["status"], "succeeded");

    let auto = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.v64").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.v64").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let auto_json = parse_single_json_line(&auto);
    assert_eq!(auto_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.v64").path()).expect("output"),
        byte_swap(&modified_z64)
    );

    let keep = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.v64").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--n64-byte-order",
            "keep",
            "--output",
            temp.child("keep.v64").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    assert_eq!(parse_single_json_line(&keep)["status"], "failed");
}

#[test]
fn patch_apply_auto_output_header_drops_snes_copier_header() {
    let temp = setup_temp_dir();
    // 512-byte copier header + 32 KiB payload: SNES copier size rule (len % 1024 == 512).
    let base = vec![0xA5_u8; 32768];
    let mut modified = base.clone();
    modified[0] = b'Z';
    fs::write(temp.child("base.sfc").path(), &base).expect("fixture");
    fs::write(temp.child("modified.sfc").path(), &modified).expect("fixture");
    fs::write(temp.child("input.smc").path(), with_header(&base)).expect("fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            temp.child("base.sfc").path().to_str().expect("path"),
            "--modified",
            temp.child("modified.sfc").path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            temp.child("update.bps").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    // Default auto everywhere: strip proven by the BPS source checksum, and the SNES
    // copier header is junk - the output stays headerless (.sfc convention).
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.smc").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output-auto.sfc").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-auto.sfc").path()).expect("output"),
        modified
    );

    // Explicit keep re-adds the captured copier header bytes.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.smc").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output-keep.smc").path().to_str().expect("path"),
            "--output-header",
            "keep",
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-keep.smc").path()).expect("output"),
        with_header(&modified)
    );
}

#[test]
fn patch_apply_auto_output_header_retains_nsrt_snes_copier_header() {
    let temp = setup_temp_dir();
    // 512-byte NSRT-signed copier header + 32 KiB payload: still matches the SNES
    // copier size rule, but the NSRT signature marks it as real dump metadata.
    let base = vec![0xA5_u8; 32768];
    let mut modified = base.clone();
    modified[0] = b'Z';
    fs::write(temp.child("base.sfc").path(), &base).expect("fixture");
    fs::write(temp.child("modified.sfc").path(), &modified).expect("fixture");
    fs::write(temp.child("input.smc").path(), with_nsrt_header(&base)).expect("fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            temp.child("base.sfc").path().to_str().expect("path"),
            "--modified",
            temp.child("modified.sfc").path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            temp.child("update.bps").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    // Default auto everywhere: strip proven by the BPS source checksum, but the
    // NSRT header comes back on the output - it carries dump metadata, matching
    // the RUP handler's own normalization rules.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.smc").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output-auto.smc").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-auto.smc").path()).expect("output"),
        with_nsrt_header(&modified)
    );

    // Explicit `--output-header strip` still overrides NSRT retention.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.smc").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output-strip.sfc")
                .path()
                .to_str()
                .expect("path"),
            "--output-header",
            "strip",
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-strip.sfc").path()).expect("output"),
        modified
    );
}

#[test]
fn patch_apply_output_header_strip_removes_kept_header() {
    let temp = setup_temp_dir();
    let base = b"abcdefgh".to_vec();
    let headered = with_nes_header(&base);
    fs::write(temp.child("input.nes").path(), &headered).expect("fixture");
    // IPS with no requirements: auto keeps the header for the apply; the explicit
    // output strip then removes it from the patched output.
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 16,
                data: b"Z".to_vec(),
            }],
            Some(headered.len() as u32),
        ),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.nes").path().to_str().expect("path"),
            "--output-header",
            "strip",
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.nes").path()).expect("output"),
        b"Zbcdefgh".to_vec()
    );
}

#[test]
fn patch_apply_adjusts_smc_extension_for_headerless_output() {
    let temp = setup_temp_dir();
    // 512-byte copier header + 32 KiB payload: SNES copier size rule (len % 1024 == 512).
    let base = vec![0xA5_u8; 32768];
    let mut modified = base.clone();
    modified[0] = b'Z';
    fs::write(temp.child("base.sfc").path(), &base).expect("fixture");
    fs::write(temp.child("modified.sfc").path(), &modified).expect("fixture");
    fs::write(temp.child("input.smc").path(), with_header(&base)).expect("fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            temp.child("base.sfc").path().to_str().expect("path"),
            "--modified",
            temp.child("modified.sfc").path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            temp.child("update.bps").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    // Auto strips (BPS source checksum proof) and auto drops the junk copier
    // header - the requested `.smc` output lands as `.sfc` to match.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.smc").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.smc").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("output extension adjusted (.smc -> .sfc) to match headerless output")
    );
    assert!(!temp.child("output.smc").path().exists());
    assert_eq!(
        fs::read(temp.child("output.sfc").path()).expect("output"),
        modified
    );

    // The reverse: keeping the header on a `.sfc`-named output moves it to `.smc`.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.smc").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("kept.sfc").path().to_str().expect("path"),
            "--output-header",
            "keep",
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("output extension adjusted (.sfc -> .smc) to match headered output")
    );
    assert!(!temp.child("kept.sfc").path().exists());
    assert_eq!(
        fs::read(temp.child("kept.smc").path()).expect("output"),
        with_header(&modified)
    );

    // Unrelated extensions are never touched.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.smc").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.rom").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert!(
        !json["label"]
            .as_str()
            .expect("label")
            .contains("output extension adjusted")
    );
    assert_eq!(
        fs::read(temp.child("output.rom").path()).expect("output"),
        modified
    );
}

#[test]
fn patch_apply_auto_header_keeps_header_when_patch_targets_raw_bytes() {
    let temp = setup_temp_dir();
    let base = b"hello old world".to_vec();
    let headered = with_nes_header(&base);
    let mut modified_headered = headered.clone();
    modified_headered[16] = b'H';
    fs::write(temp.child("input.nes").path(), &headered).expect("fixture");
    fs::write(temp.child("modified.nes").path(), &modified_headered).expect("fixture");
    // BPS authored against the FULL headered bytes: auto must keep the header, or the
    // handler's source-checksum validation would reject the stripped input.
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            temp.child("input.nes").path().to_str().expect("path"),
            "--modified",
            temp.child("modified.nes").path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            temp.child("update.bps").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.nes").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["status"], "succeeded");
    assert!(
        !json["label"]
            .as_str()
            .expect("label")
            .contains("input header stripped")
    );
    assert_eq!(
        fs::read(temp.child("output.nes").path()).expect("output"),
        modified_headered
    );
}

/// Helper for the chain tests: `patch create --format bps` from `original` to
/// `modified`, writing the patch at `output`.
fn create_bps_patch(
    original: &std::path::Path,
    modified: &std::path::Path,
    output: &std::path::Path,
) {
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.to_str().expect("path"),
            "--modified",
            modified.to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            output.to_str().expect("path"),
            "--json",
        ],
        0,
    );
}

/// IPS carries no source checksum, so a patch built this way gives the planner
/// zero evidence about what its input state is - the `default`-source case.
fn create_ips_patch(
    original: &std::path::Path,
    modified: &std::path::Path,
    output: &std::path::Path,
) {
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.to_str().expect("path"),
            "--modified",
            modified.to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            output.to_str().expect("path"),
            "--json",
        ],
        0,
    );
}

#[test]
fn patch_apply_auto_strips_mid_chain_on_embedded_checksum() {
    let temp = setup_temp_dir();
    let base = b"hello old world".to_vec();
    let headered = with_nes_header(&base);
    fs::write(temp.child("input.nes").path(), &headered).expect("fixture");
    // Patch 1 targets the HEADERED bytes; patch 2 targets the HEADERLESS bytes of
    // patch 1's result - auto must strip the header between the two steps.
    let modified1 = b"Xello old world".to_vec();
    let modified1_headered = with_nes_header(&modified1);
    let modified2 = b"XYllo old world".to_vec();
    fs::write(temp.child("m1.nes").path(), &modified1_headered).expect("fixture");
    fs::write(temp.child("m1.bin").path(), &modified1).expect("fixture");
    fs::write(temp.child("m2.bin").path(), &modified2).expect("fixture");
    create_bps_patch(
        temp.child("input.nes").path(),
        temp.child("m1.nes").path(),
        temp.child("first.bps").path(),
    );
    create_bps_patch(
        temp.child("m1.bin").path(),
        temp.child("m2.bin").path(),
        temp.child("second.bps").path(),
    );

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("first.bps").path().to_str().expect("path"),
            "--patch",
            temp.child("second.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.nes").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("input header stripped (16 bytes, No-Intro_NES.xml)")
    );
    // Output auto re-adds the emulator-required iNES header after the chain.
    assert_eq!(
        fs::read(temp.child("output.nes").path()).expect("output"),
        with_nes_header(&modified2)
    );
}

#[test]
fn patch_apply_auto_restores_header_mid_chain_on_embedded_checksum() {
    let temp = setup_temp_dir();
    let base = b"hello old world".to_vec();
    fs::write(temp.child("input.nes").path(), with_nes_header(&base)).expect("fixture");
    // Patch 1 targets the HEADERLESS bytes (auto strips up front); patch 2 targets
    // the RE-HEADERED bytes of patch 1's result - auto must restore the captured
    // header between the two steps.
    let modified1 = b"Aello old world".to_vec();
    let modified1_headered = with_nes_header(&modified1);
    let modified2_headered = with_nes_header(b"ABllo old world");
    fs::write(temp.child("base.bin").path(), &base).expect("fixture");
    fs::write(temp.child("m1.bin").path(), &modified1).expect("fixture");
    fs::write(temp.child("m1.nes").path(), &modified1_headered).expect("fixture");
    fs::write(temp.child("m2.nes").path(), &modified2_headered).expect("fixture");
    create_bps_patch(
        temp.child("base.bin").path(),
        temp.child("m1.bin").path(),
        temp.child("first.bps").path(),
    );
    create_bps_patch(
        temp.child("m1.nes").path(),
        temp.child("m2.nes").path(),
        temp.child("second.bps").path(),
    );

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("first.bps").path().to_str().expect("path"),
            "--patch",
            temp.child("second.bps").path().to_str().expect("path"),
            "--output",
            temp.child("output.nes").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    // The chain ends headered (patch 2 ran on the restored bytes), so the output
    // is exactly patch 2's result - no extra re-add.
    assert_eq!(
        fs::read(temp.child("output.nes").path()).expect("output"),
        modified2_headered
    );
}

#[test]
fn patch_apply_repair_checksum_repairs_genesis_header() {
    let temp = setup_temp_dir();
    let mut input = vec![0_u8; 0x260];
    input[0x100..0x104].copy_from_slice(b"SEGA");
    fs::write(temp.child("input.bin").path(), &input).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0x200,
                data: vec![0x12, 0x34, 0x56],
            }],
            Some(input.len() as u32),
        ),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--repair-checksum",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("repaired checksum (sega-genesis)")
    );

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    let expected = sega_genesis_checksum(&output_bytes);
    let actual = u16::from_be_bytes([output_bytes[0x18E], output_bytes[0x18F]]);
    assert_eq!(actual, expected);
}

#[test]
fn patch_apply_repair_checksum_repairs_gba_header() {
    let temp = setup_temp_dir();
    let mut input = build_test_gba_rom(0x4000);
    input[0x1BD] ^= 0x7F;
    fs::write(temp.child("input.gba").path(), &input).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0x200,
                data: vec![0xFE],
            }],
            Some(input.len() as u32),
        ),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.gba").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.gba").path().to_str().expect("path"),
            "--repair-checksum",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("repaired checksum (gba)")
    );

    let output_bytes = fs::read(temp.child("output.gba").path()).expect("output");
    assert_eq!(output_bytes[0x1BD], gba_header_checksum(&output_bytes));
}

#[test]
fn patch_apply_repair_checksum_repairs_nds_header_crc() {
    let temp = setup_temp_dir();
    let mut input = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, false);
    input[0xC0..0xC4].copy_from_slice(&[0x24, 0xFF, 0xAE, 0x51]);
    input[0x15E] = 0;
    input[0x15F] = 0;
    fs::write(temp.child("input.nds").path(), &input).expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0x2000,
                data: vec![0xAB],
            }],
            Some(input.len() as u32),
        ),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.nds").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.nds").path().to_str().expect("path"),
            "--repair-checksum",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(
        label.contains("repaired checksum (nds)")
            || (label.contains("repaired headers (") && label.contains("nds")),
        "unexpected label: {label}"
    );

    let output_bytes = fs::read(temp.child("output.nds").path()).expect("output");
    let crc = nds_crc16(&output_bytes[..0x15E]);
    assert_eq!(
        u16::from_le_bytes([output_bytes[0x15E], output_bytes[0x15F]]),
        crc
    );
}

#[test]
fn patch_apply_repair_checksum_warns_for_unsupported_targets() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"plain-bytes").expect("fixture");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![0x41],
            }],
            Some(10),
        ),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--repair-checksum",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("warning=no supported header repair profile matched; output left unchanged")
    );
}

#[test]
fn patch_apply_auto_extracts_single_payload_by_default() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("input.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("patch apply input source resolved via 1 container extract step(s)")
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_discovers_libretro_sidecar_patches_inside_input_archive() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified = temp.child("game-modified.bin");
    let patch = temp.child("game [Hack].bps");
    let archive = temp.child("softpatch.tar.gz");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    write_tar_gz_fixture(
        &[
            (original.path(), "bundle/game.bin"),
            (patch.path(), "bundle/game [Hack].bps"),
            (patch.path(), "bundle/other.bps"),
        ],
        archive.path(),
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_no_extract_uses_raw_container_bytes() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("input.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-extract",
            "--no-compress",
            "--json",
        ],
        1,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "failed");
    assert!(
        !apply_json["label"]
            .as_str()
            .expect("label")
            .contains("patch apply input source resolved via")
    );
}

#[test]
fn patch_apply_auto_extract_ambiguity_requires_select() {
    let temp = setup_temp_dir();
    let alpha = temp.child("alpha.bin");
    let alpha_modified = temp.child("alpha-modified.bin");
    let beta = temp.child("beta.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("bundle.zip");
    let output = temp.child("output.bin");
    fs::write(alpha.path(), b"alpha payload").expect("alpha fixture");
    fs::write(alpha_modified.path(), b"alpha payload patched").expect("alpha modified fixture");
    fs::write(beta.path(), b"beta payload").expect("beta fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            alpha.path().to_str().expect("path"),
            "--modified",
            alpha_modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            alpha.path().to_str().expect("path"),
            "--input",
            beta.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["status"], "failed");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("alpha.bin"));
    assert!(label.contains("beta.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn patch_apply_auto_extract_pbp_multi_disc_requires_select() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 53);
    let mut disc1_modified = disc1.clone();
    disc1_modified[2048..2065].copy_from_slice(b"patched-disc1-rom");
    let disc2 = build_test_pbp_iso(80, 71);
    let patch_source = temp.child("disc1.bin");
    let patch_target = temp.child("disc1-modified.bin");
    fs::write(patch_source.path(), &disc1).expect("disc1");
    fs::write(patch_target.path(), &disc1_modified).expect("disc1 modified");

    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let patch = temp.child("update.bps");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            patch_source.path().to_str().expect("path"),
            "--modified",
            patch_target.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let output = temp.child("output.bin");
    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            source.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "failed");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("multi.disc01.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn patch_apply_auto_extract_select_resolves_ambiguity() {
    let temp = setup_temp_dir();
    let alpha = temp.child("alpha.bin");
    let alpha_modified = temp.child("alpha-modified.bin");
    let beta = temp.child("beta.bin");
    let patch = temp.child("update.bps");
    let archive = temp.child("bundle.zip");
    let output = temp.child("output.bin");
    fs::write(alpha.path(), b"alpha payload").expect("alpha fixture");
    fs::write(alpha_modified.path(), b"alpha payload patched").expect("alpha modified fixture");
    fs::write(beta.path(), b"beta payload").expect("beta fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            alpha.path().to_str().expect("path"),
            "--modified",
            alpha_modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            alpha.path().to_str().expect("path"),
            "--input",
            beta.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--select",
            "alpha.bin",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("patch apply input source resolved via 1 container extract step(s)")
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(alpha_modified.path()).expect("alpha modified")
    );
}

#[test]
fn patch_apply_auto_extract_filters_input_and_patch_roles() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified = temp.child("game-modified.bin");
    let patch = temp.child("update.bps");
    let input_archive = temp.child("input-bundle.zip");
    let patch_archive = temp.child("patch-bundle.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"game payload").expect("original fixture");
    fs::write(modified.path(), b"game payload patched").expect("modified fixture");
    fs::write(temp.child("decoy.bin").path(), b"decoy payload").expect("decoy fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            original.path().to_str().expect("path"),
            "--input",
            patch.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            input_archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            patch.path().to_str().expect("path"),
            "--input",
            temp.child("decoy.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            patch_archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input_archive.path().to_str().expect("path"),
            "--patch",
            patch_archive.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--filter",
            "patch",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("patch apply input source resolved via 1 container extract step(s)"));
    assert!(label.contains("patch apply patch source resolved via 1 container extract step(s)"));
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_auto_extract_patch_archive_ambiguity_requires_select() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified_a = temp.child("game-mod-a.bin");
    let modified_b = temp.child("game-mod-b.bin");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    let patch_archive = temp.child("patches.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"game payload").expect("fixture");
    fs::write(modified_a.path(), b"game payload patched A").expect("fixture");
    fs::write(modified_b.path(), b"game payload patched B").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_a.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_a.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_b.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_b.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            patch_a.path().to_str().expect("path"),
            "--input",
            patch_b.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            patch_archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch_archive.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["status"], "failed");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("update-a.bps"));
    assert!(label.contains("update-b.bps"));
    assert!(label.contains("--select"));
}

#[test]
fn patch_apply_auto_extract_patch_archive_select_resolves_ambiguity() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified_a = temp.child("game-mod-a.bin");
    let modified_b = temp.child("game-mod-b.bin");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    let patch_archive = temp.child("patches.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"game payload").expect("fixture");
    fs::write(modified_a.path(), b"game payload patched A").expect("fixture");
    fs::write(modified_b.path(), b"game payload patched B").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_a.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_a.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_b.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_b.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            patch_a.path().to_str().expect("path"),
            "--input",
            patch_b.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            patch_archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch_archive.path().to_str().expect("path"),
            "--select",
            "update-a.bps",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("patch apply patch source resolved via 1 container extract step(s)")
    );
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified_a.path()).expect("modified")
    );
}

#[test]
fn patch_apply_auto_extract_ignores_sidecars_unless_no_ignore() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified = temp.child("game-modified.bin");
    let sidecar_txt = temp.child("notes.txt");
    let sidecar_json = temp.child("meta.json");
    let patch = temp.child("update.bps");
    let archive = temp.child("bundle.zip");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"game payload").expect("fixture");
    fs::write(modified.path(), b"game payload patched").expect("fixture");
    fs::write(sidecar_txt.path(), b"ignore txt").expect("fixture");
    fs::write(sidecar_json.path(), b"{}").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    command_stdout(
        &[
            "compress",
            "--input",
            original.path().to_str().expect("path"),
            "--input",
            sidecar_txt.path().to_str().expect("path"),
            "--input",
            sidecar_json.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let default_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let default_json = parse_single_json_line(&default_output);
    assert_eq!(default_json["command"], "patch-apply");
    assert_eq!(default_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    let no_ignore_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-ignore",
            "--no-compress",
            "--json",
        ],
        1,
    );
    let no_ignore_json = parse_single_json_line(&no_ignore_output);
    assert_eq!(no_ignore_json["command"], "patch-apply");
    assert_eq!(no_ignore_json["status"], "failed");
    let no_ignore_label = no_ignore_json["label"].as_str().expect("label");
    assert!(no_ignore_label.contains("ambiguous"));
    assert!(no_ignore_label.contains("--select"));
}

#[test]
fn patch_apply_accepts_multiple_validate_with_checksum_values() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let input_crc32 = checksum_value(original.path(), "crc32");
    let input_sha1 = checksum_value(original.path(), "sha1");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--expect-in",
            &format!("crc32={input_crc32}"),
            "--expect-in",
            &format!("sha1={input_sha1}"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("input checksum(s) verified"));
    assert!(label.contains("crc32="));
    assert!(label.contains("sha1="));
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_fails_on_mismatched_validate_with_checksum_value() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--expect-in",
            "crc32=00000000",
            "--no-compress",
            "--json",
        ],
        1,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["status"], "failed");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("input checksum mismatch for crc32")
    );
}

#[test]
fn patch_apply_uses_checksum_cache_hint_for_validation() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--assume-in",
            "sha1=0000000000000000000000000000000000000000",
            "--expect-in",
            "sha1=0000000000000000000000000000000000000000",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "BPS", "succeeded");
    let label = apply_json["label"].as_str().expect("label");
    assert!(label.contains("input checksum(s) verified"));
    assert!(label.contains("sha1=0000000000000000000000000000000000000000"));
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn probe_patch_reports_expected_checksums_for_bps() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let probe_json = parse_single_json_line(&probe_output);
    assert_patch_envelope(&probe_json, "probe", "BPS", "succeeded");
    assert_eq!(probe_json["details"]["patch"]["format"], "BPS");
    assert_eq!(probe_json["details"]["patch"]["source_size"], 15);
    assert_eq!(probe_json["details"]["patch"]["target_size"], 15);
    assert!(probe_json["details"]["patch"]["source_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["target_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["patch_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["record_count"].is_number());
}

#[test]
fn probe_patch_reports_structured_summary_for_ups() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.ups");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ups",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let probe_output = command_stdout(
        &[
            "probe",
            "--input",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let probe_json = parse_single_json_line(&probe_output);
    assert_patch_envelope(&probe_json, "probe", "UPS", "succeeded");
    assert_eq!(probe_json["details"]["patch"]["format"], "UPS");
    assert_eq!(probe_json["details"]["patch"]["source_size"], 15);
    assert_eq!(probe_json["details"]["patch"]["target_size"], 15);
    assert!(probe_json["details"]["patch"]["source_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["target_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["patch_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["record_count"].is_number());
}

#[test]
fn patch_apply_succeeds_for_valid_bsp_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    fs::write(original.path(), [0x01, 0x02, 0x03]).expect("fixture");

    for extension in ["bsp", "bspatch"] {
        let patch = temp.child(format!("update.{extension}"));
        let output = temp.child(format!("output-{extension}.bin"));
        fs::write(patch.path(), [0x18, 0xFF, 0x06, 0x00, 0x00, 0x00, 0x00]).expect("fixture");

        let apply_output = command_stdout(
            &[
                "patch",
                "apply",
                "--input",
                original.path().to_str().expect("path"),
                "--patch",
                patch.path().to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--no-compress",
                "--json",
            ],
            0,
        );

        let apply_json = parse_single_json_line(&apply_output);
        assert_eq!(apply_json["command"], "patch-apply");
        assert_eq!(apply_json["format"], "BSP");
        assert_eq!(apply_json["status"], "succeeded");
        assert_eq!(
            fs::read(output.path()).expect("output"),
            vec![0xFF, 0x02, 0x03]
        );
    }
}

#[test]
fn patch_create_succeeds_for_rup_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.rup");
    let output = temp.child("output.bin");
    let reverse = temp.child("reverse.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world + tail").expect("fixture");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "rup",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "RUP");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "RUP");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    let reverse_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            output.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            reverse.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let reverse_json = parse_single_json_line(&reverse_output);
    assert_eq!(reverse_json["command"], "patch-apply");
    assert_eq!(reverse_json["format"], "RUP");
    assert_eq!(reverse_json["status"], "succeeded");
    assert_eq!(
        fs::read(reverse.path()).expect("reverse"),
        fs::read(original.path()).expect("original")
    );
}

#[test]
fn patch_create_succeeds_for_aps_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.gba");
    let modified = temp.child("new.gba");
    let patch = temp.child("update.aps");
    let output = temp.child("output.gba");

    let mut source = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    let mut target = source.clone();
    target[0x1234] ^= 0xff;
    target[0x8000] = 0x5a;

    fs::write(original.path(), &source).expect("fixture");
    fs::write(modified.path(), &target).expect("fixture");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "aps",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "APS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "APS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target);
}

#[test]
fn patch_create_succeeds_for_dldi_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.nds");
    let seed_patch = temp.child("seed.dldi");
    let modified = temp.child("new.nds");
    let patch = temp.child("update.dldi");
    let output = temp.child("output.nds");

    fs::write(
        original.path(),
        build_nds_with_dldi_slot(0x300, 12, 0x0200_0000, "Default driver"),
    )
    .expect("fixture");
    fs::write(
        seed_patch.path(),
        build_dldi_driver(8, 0xBF80_0000u32 as i32, "Roundtrip driver"),
    )
    .expect("fixture");

    let seed_apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            seed_patch.path().to_str().expect("path"),
            "--output",
            modified.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );
    let seed_apply_json = parse_single_json_line(&seed_apply_output);
    assert_eq!(seed_apply_json["command"], "patch-apply");
    assert_eq!(seed_apply_json["family"], "patch");
    assert_eq!(seed_apply_json["format"], "DLDI");
    assert_eq!(seed_apply_json["requested_threads"], 8);
    assert_eq!(seed_apply_json["effective_threads"], 1);
    assert_eq!(seed_apply_json["used_parallelism"], false);
    assert_eq!(seed_apply_json["status"], "succeeded");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "dldi",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "DLDI");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "DLDI");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_warns_and_succeeds_for_oversized_dldi_driver() {
    let temp = setup_temp_dir();
    let original = temp.child("old.nds");
    let patch = temp.child("oversized.dldi");
    let output = temp.child("output.nds");

    fs::write(
        original.path(),
        build_nds_with_dldi_slot(0x500, 8, 0x0220_0000, "Default driver"),
    )
    .expect("fixture");
    fs::write(
        patch.path(),
        build_dldi_driver(12, 0xBF82_0000u32 as i32, "Oversized driver"),
    )
    .expect("fixture");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "DLDI", "succeeded");
    let label = apply_json["label"].as_str().expect("label");
    assert!(
        label.contains(
            "warning=not enough space for DLDI patch (available 256 byte(s), need 4096 byte(s))"
        ),
        "expected oversize warning in label: {label}"
    );

    let output_bytes = fs::read(output.path()).expect("output");
    assert_eq!(output_bytes.len(), 0x500 + (1 << 12));
    assert_eq!(output_bytes[0x500 + DLDI_DO_ALLOCATED_SPACE], 8);
    assert_eq!(output_bytes[0x500 + DLDI_DO_DRIVER_SIZE], 12);
}

#[test]
fn patch_apply_reports_unsupported_for_misaligned_dldi_slot() {
    let temp = setup_temp_dir();
    let input = temp.child("misaligned.nds");
    let patch = temp.child("patch.dldi");
    let output = temp.child("output.nds");

    let aligned = build_nds_with_dldi_slot(0x300, 12, 0x0200_0000, "Default driver");
    let mut misaligned = Vec::with_capacity(aligned.len() + 1);
    misaligned.push(0);
    misaligned.extend_from_slice(&aligned);

    fs::write(input.path(), misaligned).expect("fixture");
    fs::write(
        patch.path(),
        build_dldi_driver(8, 0xBF80_0000u32 as i32, "Patch driver"),
    )
    .expect("fixture");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        2,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(&apply_json, "patch-apply", "DLDI", "unsupported");
    assert_eq!(
        apply_json["label"],
        "input does not contain a patchable DLDI section"
    );
}

#[test]
fn patch_create_succeeds_for_gdiff_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.gdiff");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), vec![0x42; 700]).expect("fixture");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "gdiff",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        0,
    );

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "GDIFF");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert_eq!(&patch_bytes[..5], &[0xD1, 0xFF, 0xD1, 0xFF, 4]);
    assert_eq!(patch_bytes[5], 247);

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "GDIFF");
    assert_eq!(apply_json["requested_threads"], 8);
    assert_eq!(apply_json["effective_threads"], 1);
    assert_eq!(apply_json["used_parallelism"], false);
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_reports_unsupported_for_hdiffpatch() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.hdiff");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), vec![0x5a; 1024]).expect("fixture");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "hdiffpatch",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ],
        2,
    );

    let create_json = parse_single_json_line(&create_output);
    assert_patch_envelope(
        &create_json,
        "patch-create",
        "HDiffPatch/HPatchZ",
        "unsupported",
    );
    assert!(
        create_json["label"]
            .as_str()
            .unwrap_or_default()
            .contains("patch creation is disabled")
    );
}

#[test]
fn patch_apply_hdiffpatch_reports_parallel_execution_for_multi_chunk_patch() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let patch = temp.child("update.hdiff");
    let output = temp.child("output.bin");
    let source = vec![0x5au8; 1024];
    fs::write(input.path(), &source).expect("fixture");
    fs::write(
        patch.path(),
        build_hdiff13_identity_patch_with_cover_and_rle(&source),
    )
    .expect("fixture");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "HDiffPatch/HPatchZ");
    assert_eq!(apply_json["requested_threads"], 8);
    let effective_threads = apply_json["effective_threads"]
        .as_u64()
        .expect("effective_threads");
    assert!(effective_threads > 1);
    assert_eq!(apply_json["used_parallelism"], true);
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), source);
}

#[test]
fn patch_apply_hpatchz_sf20_reports_parallel_execution_for_multi_step_payload() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let patch = temp.child("update.hpatchz");
    let output = temp.child("output.bin");
    let source = vec![0x6bu8; 1024];
    fs::write(input.path(), &source).expect("fixture");
    fs::write(
        patch.path(),
        build_hdiffsf20_nocomp_identity_two_steps(&source),
    )
    .expect("fixture");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "HDiffPatch/HPatchZ");
    assert_eq!(apply_json["requested_threads"], 8);
    let effective_threads = apply_json["effective_threads"]
        .as_u64()
        .expect("effective_threads");
    assert!(effective_threads > 1);
    assert_eq!(apply_json["used_parallelism"], true);
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), source);
}

#[test]
fn patch_apply_hpatchz_sf20_reports_parallel_fallback_for_single_step_payload() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let patch = temp.child("update.hpatchz");
    let output = temp.child("output.bin");
    let source = vec![0x33u8; 1024];
    fs::write(input.path(), &source).expect("fixture");
    fs::write(
        patch.path(),
        build_hdiffsf20_nocomp_identity_single_step_two_covers(&source),
    )
    .expect("fixture");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "HDiffPatch/HPatchZ");
    assert_eq!(apply_json["requested_threads"], 8);
    assert_eq!(apply_json["effective_threads"], 1);
    assert_eq!(apply_json["used_parallelism"], false);
    assert_eq!(apply_json["thread_fallback"], true);
    assert!(
        apply_json["thread_fallback_reason"]
            .as_str()
            .expect("thread fallback reason")
            .contains("no independent step-level parallel work")
    );
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), source);
}

#[test]
fn patch_apply_hdiff19_directory_patch_reports_unsupported() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let patch = temp.child("update.hdiff");
    let output = temp.child("output.bin");
    fs::write(input.path(), b"any source bytes").expect("fixture");
    fs::write(patch.path(), build_hdiff19_nocomp_directory_patch()).expect("fixture");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        2,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_patch_envelope(
        &apply_json,
        "patch-apply",
        "HDiffPatch/HPatchZ",
        "unsupported",
    );
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("directory patches (HDIFF19) are not supported")
    );
}

#[test]
fn patch_create_succeeds_for_xdelta_with_secondary_when_helpful() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.xdelta");
    let output = temp.child("output.bin");
    fs::copy(fixture_path("secondary-source.bin"), original.path()).expect("copy source fixture");
    fs::copy(fixture_path("secondary-target.bin"), modified.path()).expect("copy target fixture");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "xdelta",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--xdelta-secondary",
            "auto",
            "--json",
        ],
        0,
    );

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "xdelta");
    assert_eq!(create_json["requested_threads"], 8);
    assert!(
        (1..=8).contains(
            &create_json["effective_threads"]
                .as_u64()
                .expect("effective_threads")
        )
    );
    assert_eq!(create_json["used_parallelism"], true);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert_eq!(&patch_bytes[..4], &[0xD6, 0xC3, 0xC4, 0x00]);
    assert_ne!(
        patch_bytes[4] & 0x01,
        0,
        "expected secondary-compressed xdelta output"
    );

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "xdelta");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn probe_succeeds_for_valid_vcdiff_patch() {
    let temp = setup_temp_dir();
    let patch = build_patch(
        None,
        vec![TestWindow {
            win_indicator: 1 | 4,
            source_segment_size: Some(5),
            source_segment_position: Some(0),
            target_window_size: 5,
            checksum: Some(0x1234_5678),
            data: Vec::new(),
            inst: vec![21],
            addr: encode_all_varints(&[0]),
        }],
    );
    fs::write(temp.child("update.vcdiff").path(), patch).expect("fixture");

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("update.vcdiff").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "probe", "VCDIFF", "succeeded");
    assert_eq!(json["details"]["patch"]["format"], "VCDIFF");
    assert_eq!(json["details"]["patch"]["minimum_source_size"], 5);
    assert_eq!(json["details"]["patch"]["target_size"], 5);
    assert_eq!(json["details"]["patch"]["record_count"], 1);
    assert_eq!(json["details"]["patch"]["source_window_count"], 1);
    assert_eq!(json["details"]["patch"]["target_window_count"], 0);
    assert_eq!(json["details"]["patch"]["window_checksum_count"], 1);
    assert!(json["details"]["patch"].get("window_adler32").is_none());
    assert!(
        json["details"]["patch"]
            .get("window_adler32_checksums")
            .is_none()
    );
}

#[test]
fn patch_validate_detects_xdelta_window_checksum_mismatch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcabcabcabc").expect("fixture");
    let expected = b"abcabcZZabcabc";
    let patch = build_patch(
        Some(b"xdelta-cli"),
        vec![TestWindow {
            win_indicator: 0x01 | 0x04,
            source_segment_size: Some(12),
            source_segment_position: Some(0),
            target_window_size: expected.len() as u64,
            checksum: Some(adler32(expected) ^ 0x0000_0001),
            data: b"ZZ".to_vec(),
            inst: vec![22, 3, 22],
            addr: encode_all_varints(&[0, 6]),
        }],
    );
    fs::write(temp.child("update.xdelta").path(), patch).expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-validate", "xdelta", "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("checksum mismatch")
    );
}

#[test]
fn patch_validate_succeeds_with_source_values() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let input_crc32 = checksum_value(original.path(), "crc32");
    let input_size = fs::metadata(original.path())
        .expect("metadata")
        .len()
        .to_string();
    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--expect-in",
            &format!("size={input_size}"),
            "--expect-in",
            &format!("crc32={input_crc32}"),
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-validate", "BPS", "succeeded");
    assert_eq!(json["details"]["patch_validation"]["preflight"], true);
    assert_eq!(json["details"]["patch_validation"]["status"], "passed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("patch validation passed"));
    assert!(label.contains("input size verified"));
    assert!(label.contains("input checksum(s) verified"));
}

#[test]
fn patch_validate_succeeds_for_native_validate_formats() {
    let temp = setup_temp_dir();

    fs::write(temp.child("ppf-input.bin").path(), b"abcabcabcabc").expect("fixture");
    fs::write(
        temp.child("update.ppf").path(),
        build_ppf1_patch(
            "cli validate patch",
            vec![TestPpfRecord {
                offset: 6,
                data: b"ZZ".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let mut gba_source = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in gba_source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    let mut gba_target = gba_source.clone();
    gba_target[0x0123] ^= 0x3f;
    gba_target[0x8000] = 0x5a;
    fs::write(temp.child("input.gba").path(), &gba_source).expect("fixture");
    fs::write(
        temp.child("update.aps").path(),
        build_apsgba_patch(&gba_source, &gba_target),
    )
    .expect("fixture");

    fs::write(temp.child("gdiff-input.bin").path(), b"abcd").expect("fixture");
    fs::write(
        temp.child("update.gdiff").path(),
        build_gdiff_patch(vec![
            TestGdiffCommand::Copy { offset: 0, len: 2 },
            TestGdiffCommand::Data(b"XY".to_vec()),
            TestGdiffCommand::Copy { offset: 2, len: 2 },
        ]),
    )
    .expect("fixture");

    let hdiff_source = b"source bytes";
    let hdiff_target = b"target bytes for hdiffpatch";
    fs::write(temp.child("hdiff-input.bin").path(), hdiff_source).expect("fixture");
    fs::write(
        temp.child("update.hpatchz").path(),
        build_hdiff13_nocomp_patch(hdiff_source, hdiff_target),
    )
    .expect("fixture");

    for (input_name, patch_name, expected_format) in [
        ("ppf-input.bin", "update.ppf", "PPF"),
        ("input.gba", "update.aps", "APSGBA"),
        ("gdiff-input.bin", "update.gdiff", "GDIFF"),
        ("hdiff-input.bin", "update.hpatchz", "HDiffPatch/HPatchZ"),
    ] {
        let output = command_stdout(
            &[
                "patch",
                "validate",
                "--input",
                temp.child(input_name).path().to_str().expect("path"),
                "--patch",
                temp.child(patch_name).path().to_str().expect("path"),
                "--threads",
                "8",
                "--json",
            ],
            0,
        );

        let json = parse_single_json_line(&output);
        assert_patch_envelope(&json, "patch-validate", expected_format, "succeeded");
        assert_eq!(json["details"]["patch_validation"]["status"], "passed");
        assert!(
            json["label"]
                .as_str()
                .expect("label")
                .contains("patch validation passed")
        );
    }
}

#[test]
fn patch_validate_rejects_apsgba_checksum_mismatch() {
    let temp = setup_temp_dir();
    let mut source = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    let mut target = source.clone();
    target[0x0123] ^= 0x3f;
    fs::write(temp.child("input.gba").path(), &source).expect("fixture");
    fs::write(
        temp.child("update.aps").path(),
        build_apsgba_patch(&source, &target),
    )
    .expect("fixture");
    source[0x0100] ^= 0xff;
    fs::write(temp.child("wrong-input.gba").path(), &source).expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            temp.child("wrong-input.gba").path().to_str().expect("path"),
            "--patch",
            temp.child("update.aps").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-validate", "APSGBA", "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("Source checksum invalid")
    );
}

#[test]
fn patch_validate_independent_reports_all_passed() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // Two BPS patches built from the SAME source both validate against that source.
    fs::write(temp.child("mod-a.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"hello cool world").expect("fixture");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    create_bps_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_bps_patch(input.path(), temp.child("mod-b.bin").path(), patch_b.path());

    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--independent",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-validate", "BPS", "succeeded");
    let validation = &json["details"]["patch_validation"];
    assert_eq!(validation["independent"], true);
    assert_eq!(validation["status"], "passed");
    assert_eq!(validation["patch_count"], 2);
    assert_eq!(validation["passed_count"], 2);
    assert_eq!(validation["failed_count"], 0);
    let per_patch = validation["per_patch"].as_array().expect("per_patch array");
    assert_eq!(per_patch.len(), 2);
    for (index, entry) in per_patch.iter().enumerate() {
        assert_eq!(entry["index"], index);
        assert_eq!(entry["status"], "passed");
        assert_eq!(entry["format"], "BPS");
    }
}

#[test]
fn patch_validate_independent_reports_mixed_without_aborting() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // A good BPS built from `input` passes; a BPS built from a DIFFERENT source embeds a source
    // checksum that fails against `input` - but it must NOT abort the good patch's verdict.
    fs::write(temp.child("mod-good.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("other.bin").path(), b"totally other src").expect("fixture");
    fs::write(temp.child("mod-other.bin").path(), b"totally other dst").expect("fixture");
    let patch_good = temp.child("good.bps");
    let patch_bad = temp.child("bad.bps");
    create_bps_patch(
        input.path(),
        temp.child("mod-good.bin").path(),
        patch_good.path(),
    );
    create_bps_patch(
        temp.child("other.bin").path(),
        temp.child("mod-other.bin").path(),
        patch_bad.path(),
    );

    // Independent mode exits 0 even though one patch fails, so the caller can read both verdicts.
    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_good.path().to_str().expect("path"),
            "--patch",
            patch_bad.path().to_str().expect("path"),
            "--independent",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-validate");
    assert_eq!(json["status"], "succeeded");
    let validation = &json["details"]["patch_validation"];
    assert_eq!(validation["independent"], true);
    assert_eq!(validation["status"], "mixed");
    assert_eq!(validation["patch_count"], 2);
    assert_eq!(validation["passed_count"], 1);
    assert_eq!(validation["failed_count"], 1);
    let per_patch = validation["per_patch"].as_array().expect("per_patch array");
    assert_eq!(per_patch.len(), 2);
    assert_eq!(per_patch[0]["index"], 0);
    assert_eq!(per_patch[0]["status"], "passed");
    assert_eq!(per_patch[1]["index"], 1);
    assert_eq!(per_patch[1]["status"], "failed");
    assert!(
        !per_patch[1]["message"]
            .as_str()
            .expect("failure message")
            .is_empty()
    );
}

#[test]
fn patch_validate_plan_resolves_same_base_patches() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // Two BPS patches authored against the SAME source: both resolve to the
    // base, verify against it once, and neither is falsely chained.
    fs::write(temp.child("mod-a.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"hello cool world").expect("fixture");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    create_bps_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_bps_patch(input.path(), temp.child("mod-b.bin").path(), patch_b.path());

    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--plan",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-validate", "BPS", "succeeded");
    let validation = &json["details"]["patch_validation"];
    assert_eq!(validation["plan"], true);
    assert_eq!(validation["status"], "passed");
    assert_eq!(validation["patch_count"], 2);
    assert_eq!(validation["passed_count"], 2);
    assert_eq!(validation["failed_count"], 0);
    assert!(validation["suggested_order"].is_null());
    let per_patch = validation["per_patch"].as_array().expect("per_patch array");
    assert_eq!(per_patch.len(), 2);
    for entry in per_patch {
        assert_eq!(entry["basis"], "base");
        assert_eq!(entry["input_verdict"], "passed");
        assert_eq!(entry["matched"]["kind"], "base");
        assert_eq!(entry["matched"]["variant"], "raw");
    }
    assert_eq!(per_patch[1]["basis_source"], "inferred_base");
    // The last patch's embedded target describes patch(base), not the
    // combined result of both patches.
    let outputs = validation["output_verification"]
        .as_array()
        .expect("output_verification array");
    let embedded = outputs
        .iter()
        .find(|entry| entry["source"] == "embedded target checks")
        .expect("embedded target entry");
    assert_eq!(embedded["enforceable"], false);
}

#[test]
fn patch_validate_plan_verifies_checksumless_alternatives_against_base() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"ORIGINAL-ROM\n").expect("fixture");

    // Two IPS patches, each an alternative edit of the SAME base byte. IPS carries no source
    // checksum, so the planner has zero evidence either is chained and can only *default* the
    // second to "previous" basis. Both nonetheless apply cleanly to the ROM, so both must verify
    // green against the base regardless of order - the second must never read "chain_deferred"
    // (an empty "verified during the weave" promise for a checksumless format) purely for being
    // listed second.
    fs::write(temp.child("mod-a.bin").path(), b"ORIGINXL-ROM\n").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"ORIGINYL-ROM\n").expect("fixture");
    let patch_a = temp.child("alt-a.ips");
    let patch_b = temp.child("alt-b.ips");
    create_ips_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_ips_patch(input.path(), temp.child("mod-b.bin").path(), patch_b.path());

    for order in [[&patch_a, &patch_b], [&patch_b, &patch_a]] {
        let output = command_stdout(
            &[
                "patch",
                "validate",
                "--input",
                input.path().to_str().expect("path"),
                "--patch",
                order[0].path().to_str().expect("path"),
                "--patch",
                order[1].path().to_str().expect("path"),
                "--plan",
                "--json",
            ],
            0,
        );

        let json = parse_single_json_line(&output);
        assert_patch_envelope(&json, "patch-validate", "IPS", "succeeded");
        let validation = &json["details"]["patch_validation"];
        assert_eq!(validation["status"], "passed");
        assert_eq!(validation["passed_count"], 2);
        assert_eq!(validation["failed_count"], 0);
        let per_patch = validation["per_patch"].as_array().expect("per_patch array");
        assert_eq!(per_patch.len(), 2);
        for entry in per_patch {
            assert_eq!(entry["basis"], "base");
            assert_eq!(entry["input_verdict"], "passed");
            assert_eq!(entry["matched"]["kind"], "none");
        }
    }
}

#[test]
fn patch_validate_plan_defers_mid_chain_patch() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // A true chain: b was authored against a's output. b must be deferred,
    // never dry-run against the original input (the false "invalid" the
    // independent mode reports today).
    fs::write(temp.child("mod-a.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"hello newer world").expect("fixture");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    create_bps_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_bps_patch(
        temp.child("mod-a.bin").path(),
        temp.child("mod-b.bin").path(),
        patch_b.path(),
    );

    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--plan",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "patch-validate", "BPS", "succeeded");
    let validation = &json["details"]["patch_validation"];
    assert_eq!(validation["status"], "passed");
    assert_eq!(validation["passed_count"], 1);
    assert_eq!(validation["failed_count"], 0);
    let per_patch = validation["per_patch"].as_array().expect("per_patch array");
    assert_eq!(per_patch[0]["basis"], "base");
    assert_eq!(per_patch[0]["input_verdict"], "passed");
    assert_eq!(per_patch[1]["basis"], "previous");
    assert_eq!(per_patch[1]["basis_source"], "inferred_chain");
    assert_eq!(per_patch[1]["input_verdict"], "chain_deferred");
    assert_eq!(per_patch[1]["matched"]["kind"], "patch_output");
    assert_eq!(per_patch[1]["matched"]["index"], 0);
    // An unbroken statically-proven chain makes the last embedded target
    // enforceable for the final output.
    let outputs = validation["output_verification"]
        .as_array()
        .expect("output_verification array");
    let embedded = outputs
        .iter()
        .find(|entry| entry["source"] == "embedded target checks")
        .expect("embedded target entry");
    assert_eq!(embedded["enforceable"], true);
}

#[test]
fn patch_validate_plan_suggests_reorder_for_out_of_order_chain() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // p1: base -> m1, p2: m1 -> m2, p3: m2 -> m3, passed as [p1, p3, p2].
    fs::write(temp.child("m1.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("m2.bin").path(), b"hello newer world").expect("fixture");
    fs::write(temp.child("m3.bin").path(), b"hello newest world").expect("fixture");
    let patch_1 = temp.child("p1.bps");
    let patch_2 = temp.child("p2.bps");
    let patch_3 = temp.child("p3.bps");
    create_bps_patch(input.path(), temp.child("m1.bin").path(), patch_1.path());
    create_bps_patch(
        temp.child("m1.bin").path(),
        temp.child("m2.bin").path(),
        patch_2.path(),
    );
    create_bps_patch(
        temp.child("m2.bin").path(),
        temp.child("m3.bin").path(),
        patch_3.path(),
    );

    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_1.path().to_str().expect("path"),
            "--patch",
            patch_3.path().to_str().expect("path"),
            "--patch",
            patch_2.path().to_str().expect("path"),
            "--plan",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    let validation = &json["details"]["patch_validation"];
    let per_patch = validation["per_patch"].as_array().expect("per_patch array");
    // p3 (at position 1) expects p2's output (at position 2).
    assert_eq!(per_patch[1]["expected_predecessor"], 2);
    assert_eq!(per_patch[1]["input_verdict"], "chain_deferred");
    assert_eq!(validation["suggested_order"], serde_json::json!([0, 2, 1]));
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("suggested patch order: 1, 3, 2")
    );
}

#[test]
fn patch_apply_same_base_bps_chain_succeeds_in_strict_mode() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // Two BPS patches authored against the SAME base stacked in one strict
    // chain: the second's embedded source CRC matches the base, so its basis
    // resolves to base and its base-relative embedded checks skip for the
    // mid-chain step (they used to hard-fail against the intermediate).
    fs::write(temp.child("mod-a.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"hello cool world").expect("fixture");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    create_bps_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_bps_patch(input.path(), temp.child("mod-b.bin").path(), patch_b.path());

    let strict_output = temp.child("output-strict.bin");
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--output",
            strict_output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");

    // Byte parity: the strict run produces exactly what the checks-ignored
    // run always produced.
    let ignore_output = temp.child("output-ignore.bin");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--output",
            ignore_output.path().to_str().expect("path"),
            "--no-compress",
            "--ignore-checksum-validation",
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(strict_output.path()).expect("strict output"),
        fs::read(ignore_output.path()).expect("ignore output")
    );
}

#[test]
fn patch_apply_declared_basis_previous_overrides_base_inference() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    fs::write(temp.child("mod-a.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"hello cool world").expect("fixture");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    create_bps_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_bps_patch(input.path(), temp.child("mod-b.bin").path(), patch_b.path());

    // Forcing the second patch to previous re-enables its embedded source
    // check against the intermediate, which cannot match a base-authored
    // patch - the declaration wins over the base inference.
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--patch-basis",
            "previous",
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("Input checksum invalid")
    );
}

#[test]
fn patch_apply_declared_basis_base_rejects_non_base_patch() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // b was authored against a's output; declaring it base must fail the
    // up-front base verification, before anything is written.
    fs::write(temp.child("mod-a.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"hello newer world").expect("fixture");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    create_bps_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_bps_patch(
        temp.child("mod-a.bin").path(),
        temp.child("mod-b.bin").path(),
        patch_b.path(),
    );

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--patch-basis",
            "base",
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("patch.base.input_mismatch")
    );
}

#[test]
fn patch_validate_plan_honors_declared_basis_flag() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    fs::write(input.path(), b"hello old world").expect("fixture");

    // Both patches were authored against the base; forcing the second to
    // `previous` overrides the base inference and defers it.
    fs::write(temp.child("mod-a.bin").path(), b"hello new world").expect("fixture");
    fs::write(temp.child("mod-b.bin").path(), b"hello cool world").expect("fixture");
    let patch_a = temp.child("update-a.bps");
    let patch_b = temp.child("update-b.bps");
    create_bps_patch(input.path(), temp.child("mod-a.bin").path(), patch_a.path());
    create_bps_patch(input.path(), temp.child("mod-b.bin").path(), patch_b.path());

    let output = command_stdout(
        &[
            "patch",
            "validate",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch_a.path().to_str().expect("path"),
            "--patch",
            patch_b.path().to_str().expect("path"),
            "--patch-basis",
            "previous",
            "--plan",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    let validation = &json["details"]["patch_validation"];
    let per_patch = validation["per_patch"].as_array().expect("per_patch array");
    assert_eq!(per_patch[0]["basis"], "base");
    assert_eq!(per_patch[1]["basis"], "previous");
    assert_eq!(per_patch[1]["basis_source"], "declared");
    assert_eq!(per_patch[1]["input_verdict"], "chain_deferred");
}

#[test]
fn patch_apply_uses_parallel_threads_for_large_ips_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), []).expect("fixture");

    let total_len = (2 * 1024 * 1024 + 321) as u32;
    let mut records = Vec::new();
    let mut offset = 0u32;
    while offset < total_len {
        let remaining = total_len - offset;
        let len = remaining.min(u16::MAX as u32) as u16;
        records.push(TestIpsRecord::Rle {
            offset,
            len,
            value: b'Z',
        });
        offset += u32::from(len);
    }

    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(records, Some(total_len)),
    )
    .expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 2);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), total_len as usize);
    assert!(output_bytes.iter().all(|byte| *byte == b'Z'));
}

#[test]
fn patch_apply_falls_back_to_single_thread_when_pool_build_fails() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), []).expect("fixture");

    let total_len = (2 * 1024 * 1024 + 321) as u32;
    let mut records = Vec::new();
    let mut offset = 0u32;
    while offset < total_len {
        let remaining = total_len - offset;
        let len = remaining.min(u16::MAX as u32) as u16;
        records.push(TestIpsRecord::Rle {
            offset,
            len,
            value: b'Z',
        });
        offset += u32::from(len);
    }

    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(records, Some(total_len)),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .env("ROM_WEAVER_TEST_THREAD_POOL_FAIL", "multi")
        .args([
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["thread_fallback"], true);
    assert!(
        json["thread_fallback_reason"]
            .as_str()
            .expect("thread fallback reason")
            .contains("forced thread pool build failure (multi)")
    );
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), total_len as usize);
    assert!(output_bytes.iter().all(|byte| *byte == b'Z'));
}

#[test]
fn patch_apply_succeeds_for_secondary_xdelta_patch_with_parallel_threads() {
    let temp = setup_temp_dir();
    fs::copy(
        fixture_path("secondary-source.bin"),
        temp.child("input.bin").path(),
    )
    .expect("copy source fixture");
    fs::copy(
        fixture_path("secondary-djw.xdelta"),
        temp.child("update.xdelta").path(),
    )
    .expect("copy patch fixture");
    let expected = fs::read(fixture_path("secondary-target.bin")).expect("read target fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        expected
    );
}

#[test]
fn patch_apply_uses_parallel_threads_for_multi_window_xdelta_patch() {
    let temp = setup_temp_dir();
    let input = b"hello old world";
    let expected = b"hello new world";
    fs::write(temp.child("input.bin").path(), input).expect("fixture");
    let patch = build_patch(
        Some(b"xdelta-cli"),
        vec![
            TestWindow {
                win_indicator: 0x01,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 6,
                checksum: None,
                data: Vec::new(),
                inst: vec![22],
                addr: encode_all_varints(&[0]),
            },
            TestWindow {
                win_indicator: 0x01,
                source_segment_size: Some(input.len() as u64),
                source_segment_position: Some(0),
                target_window_size: 9,
                checksum: None,
                data: b"new".to_vec(),
                inst: vec![4, 22],
                addr: encode_all_varints(&[9]),
            },
        ],
    );
    fs::write(temp.child("update.xdelta").path(), patch).expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 2);
    assert_eq!(json["used_parallelism"], true);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        expected
    );
}

#[test]
fn probe_reports_invalid_vcdiff_content_as_failed() {
    let temp = setup_temp_dir();
    temp.child("broken.vcdiff")
        .write_str("not-a-patch")
        .expect("fixture");

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("broken.vcdiff").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "probe", "VCDIFF", "failed");
}

#[test]
fn probe_reports_unknown_formats_cleanly() {
    let temp = setup_temp_dir();
    temp.child("unknown.bin")
        .write_str("payload")
        .expect("fixture");

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("unknown.bin").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "command");
    assert!(json["format"].is_null());
    assert_eq!(json["stage"], "probe");
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("no registered handler matched"));
}

#[test]
fn probe_reports_pds_as_explicitly_unsupported() {
    let temp = setup_temp_dir();
    temp.child("legacy.pds")
        .write_str("obsolete format")
        .expect("fixture");

    let output = command_stdout(
        &[
            "probe",
            "--input",
            temp.child("legacy.pds").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );

    let json = parse_single_json_line(&output);
    assert_patch_envelope(&json, "probe", "PDS", "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("explicitly not supported")
    );
}

#[test]
fn patch_create_infers_format_from_output_extension() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    // No --format: the `.bps` output extension determines the patch format.
    let output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["status"], "succeeded");
    assert!(patch.path().exists());
}

#[test]
fn patch_create_rejects_extensionless_output_without_format() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("output has no file extension")
    );
    assert!(!patch.path().exists());
}

#[test]
fn patch_create_format_flag_overrides_mismatched_extension_with_warning() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    // Name the output `.ips` but force bps: the flag wins and the mismatch is warned about.
    let patch = temp.child("update.ips");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("warning"));
    assert!(label.contains("does not match"));
    assert!(patch.path().exists());
}

#[test]
fn patch_create_checksum_name_embeds_crc32_and_apply_validates_input() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("hack.ips");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!!").expect("fixture");

    let create_output = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            patch.path().to_str().expect("path"),
            "--checksum-name",
            "--json",
        ],
        0,
    );
    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["status"], "succeeded");
    let emitted = create_json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    let file_name = emitted[0]["file_name"].as_str().expect("file_name");
    assert!(
        file_name.starts_with("hack [crc32:") && file_name.ends_with("].ips"),
        "unexpected checksum-name output: {file_name}"
    );
    let token_start = file_name.find("[crc32:").expect("token") + "[crc32:".len();
    let crc = &file_name[token_start..token_start + 8];
    assert!(crc.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let named_patch = temp.child(file_name);
    assert!(named_patch.path().exists());

    // Applying to the correct ROM validates the file-name crc32 and succeeds.
    let ok_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            named_patch.path().to_str().expect("path"),
            "--output",
            temp.child("ok.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let ok_json = parse_single_json_line(&ok_output);
    assert_eq!(ok_json["status"], "succeeded");
    assert!(
        ok_json["label"]
            .as_str()
            .expect("label")
            .contains("input checksum(s) verified")
    );
    assert_eq!(
        fs::read(temp.child("ok.bin").path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    // Applying to the wrong ROM is rejected before patching by the file-name crc32.
    let wrong = temp.child("wrong.bin");
    fs::write(wrong.path(), b"ABCDEFGH").expect("fixture");
    let bad_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            wrong.path().to_str().expect("path"),
            "--patch",
            named_patch.path().to_str().expect("path"),
            "--output",
            temp.child("bad.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    let bad_json = parse_single_json_line(&bad_output);
    assert_eq!(bad_json["status"], "failed");
    assert!(
        bad_json["label"]
            .as_str()
            .expect("label")
            .contains("input checksum mismatch for crc32")
    );

    // `--ignore-checksum-validation` skips the file-name requirement entirely.
    let ignored_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            wrong.path().to_str().expect("path"),
            "--patch",
            named_patch.path().to_str().expect("path"),
            "--output",
            temp.child("ignored.bin").path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ],
        0,
    );
    let ignored_json = parse_single_json_line(&ignored_output);
    assert_eq!(ignored_json["status"], "succeeded");
}

#[test]
fn patch_apply_validates_bare_enclosed_crc32_from_patch_name() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 2,
            data: b"XYZ".to_vec(),
        }],
        Some(8),
    );

    // Learn the input crc32 by letting create embed a labelled token, then reuse
    // the value in a bare, bracket-enclosed patch name (No-Intro style).
    let labeled = command_stdout(
        &[
            "patch",
            "create",
            "--original",
            temp.child("input.bin").path().to_str().expect("path"),
            "--modified",
            temp.child("input.bin").path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            temp.child("probe.ips").path().to_str().expect("path"),
            "--checksum-name",
            "--ignore-checksum-validation",
            "--json",
        ],
        0,
    );
    let labeled_json = parse_single_json_line(&labeled);
    let probe_name = labeled_json["details"]["emitted_files"][0]["file_name"]
        .as_str()
        .expect("file_name");
    let token_start = probe_name.find("[crc32:").expect("token") + "[crc32:".len();
    let crc = probe_name[token_start..token_start + 8].to_string();

    let bare_patch = temp.child(format!("Cool Hack ({crc}).ips"));
    fs::write(bare_patch.path(), &patch_bytes).expect("fixture");

    let apply_output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            bare_patch.path().to_str().expect("path"),
            "--output",
            temp.child("bare-out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["status"], "succeeded");
    assert!(
        apply_json["label"]
            .as_str()
            .expect("label")
            .contains("input checksum(s) verified")
    );
    assert_eq!(
        fs::read(temp.child("bare-out.bin").path()).expect("output"),
        b"abXYZfgh"
    );
}

#[test]
fn patch_apply_validates_size_requirement_from_patch_name() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    let patch_bytes = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: 2,
            data: b"XYZ".to_vec(),
        }],
        Some(8),
    );
    // The input is 8 bytes; encode a mismatching size requirement in the name.
    let patch = temp.child("hack [size:4096].ips");
    fs::write(patch.path(), &patch_bytes).expect("fixture");

    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("input size mismatch")
    );
}

// ---- relocated from shared.rs (single-module helpers) ----

fn read_single_file_bytes(dir: &std::path::Path) -> Vec<u8> {
    let mut files = fs::read_dir(dir)
        .expect("read dir")
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(files.len(), 1, "expected one extracted file");
    fs::read(&files[0]).expect("read extracted file")
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/vcdiff")
        .join(name)
}

fn build_hdiff13_nocomp_patch(old: &[u8], new: &[u8]) -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        u64::try_from(new.len()).expect("new size"),
        u64::try_from(old.len()).expect("old size"),
        0, // cover_count
        0, // cover_buf_size
        0, // compress_cover_buf_size
        0, // rle_ctrl_buf_size
        0, // compress_rle_ctrl_buf_size
        0, // rle_code_buf_size
        0, // compress_rle_code_buf_size
        u64::try_from(new.len()).expect("new diff size"),
        0, // compress_new_data_diff_size
    ]));
    patch.extend_from_slice(new);
    patch
}

fn build_hdiff13_identity_patch_with_cover_and_rle(source: &[u8]) -> Vec<u8> {
    let source_size = u64::try_from(source.len()).expect("source size");
    let mut cover = Vec::new();
    cover.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover, 0); // copy_length
    encode_varint(&mut cover, source_size); // cover_length

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF13&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        source_size, // new_data_size
        source_size, // old_data_size
        1,           // cover_count
        u64::try_from(cover.len()).expect("cover size"),
        0, // compress_cover_buf_size
        1, // rle_ctrl_buf_size
        0, // compress_rle_ctrl_buf_size
        1, // rle_code_buf_size
        0, // compress_rle_code_buf_size
        0, // new_data_diff_size
        0, // compress_new_data_diff_size
    ]));
    patch.extend_from_slice(&cover);
    patch.push(0xC0); // rle_type=copy, length=1
    patch.push(0x00); // add 0 to keep bytes unchanged
    patch
}

fn build_hdiffsf20_nocomp_identity_two_steps(source: &[u8]) -> Vec<u8> {
    assert!(source.len() >= 2, "fixture requires at least two bytes");
    let split = source.len() / 2;
    let tail = source.len() - split;
    assert!(split > 0 && tail > 0, "fixture split invalid");

    let mut payload = Vec::new();

    let mut cover1 = Vec::new();
    cover1.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover1, 0); // new_gap
    encode_varint(&mut cover1, u64::try_from(split).expect("split"));
    let mut rle1 = Vec::new();
    encode_varint(&mut rle1, u64::try_from(split).expect("split"));
    encode_varint(
        &mut payload,
        u64::try_from(cover1.len()).expect("cover1 len"),
    );
    encode_varint(&mut payload, u64::try_from(rle1.len()).expect("rle1 len"));
    payload.extend_from_slice(&cover1);
    payload.extend_from_slice(&rle1);

    let mut cover2 = Vec::new();
    cover2.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover2, 0); // new_gap
    encode_varint(&mut cover2, u64::try_from(tail).expect("tail"));
    let mut rle2 = Vec::new();
    encode_varint(&mut rle2, u64::try_from(tail).expect("tail"));
    encode_varint(
        &mut payload,
        u64::try_from(cover2.len()).expect("cover2 len"),
    );
    encode_varint(&mut payload, u64::try_from(rle2.len()).expect("rle2 len"));
    payload.extend_from_slice(&cover2);
    payload.extend_from_slice(&rle2);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        u64::try_from(source.len()).expect("new size"),
        u64::try_from(source.len()).expect("old size"),
        2,   // cover_count
        256, // step_mem_size
        u64::try_from(payload.len()).expect("payload size"),
        0, // compressed_size
    ]));
    patch.extend_from_slice(&payload);
    patch
}

fn build_hdiffsf20_nocomp_identity_single_step_two_covers(source: &[u8]) -> Vec<u8> {
    assert!(source.len() >= 2, "fixture requires at least two bytes");
    let split = source.len() / 2;
    let tail = source.len() - split;
    assert!(split > 0 && tail > 0, "fixture split invalid");

    let mut cover = Vec::new();
    cover.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover, 0); // new_gap
    encode_varint(&mut cover, u64::try_from(split).expect("split"));
    cover.push(0); // old sign=0, old_delta=0
    encode_varint(&mut cover, 0); // new_gap
    encode_varint(&mut cover, u64::try_from(tail).expect("tail"));

    let mut rle = Vec::new();
    encode_varint(&mut rle, u64::try_from(split).expect("split"));
    encode_varint(&mut rle, 0); // len_value for second cover transition
    encode_varint(&mut rle, u64::try_from(tail).expect("tail"));

    let mut payload = Vec::new();
    encode_varint(&mut payload, u64::try_from(cover.len()).expect("cover len"));
    encode_varint(&mut payload, u64::try_from(rle.len()).expect("rle len"));
    payload.extend_from_slice(&cover);
    payload.extend_from_slice(&rle);

    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFFSF20&nocomp");
    patch.push(0);
    patch.extend_from_slice(&encode_all_varints(&[
        u64::try_from(source.len()).expect("new size"),
        u64::try_from(source.len()).expect("old size"),
        2,   // cover_count
        256, // step_mem_size
        u64::try_from(payload.len()).expect("payload size"),
        0, // compressed_size
    ]));
    patch.extend_from_slice(&payload);
    patch
}

fn build_hdiff19_nocomp_directory_patch() -> Vec<u8> {
    let mut patch = Vec::new();
    patch.extend_from_slice(b"HDIFF19&nocomp");
    patch.push(0);
    patch.push(1); // is_input_dir
    patch.push(1); // is_output_dir
    patch.extend_from_slice(&encode_all_varints(&[
        0, // input_dir_count
        0, // input_sum_size
        0, // output_dir_count
        0, // output_sum_size
    ]));
    patch
}

struct TestWindow {
    pub(crate) win_indicator: u8,
    pub(crate) source_segment_size: Option<u64>,
    pub(crate) source_segment_position: Option<u64>,
    pub(crate) target_window_size: u64,
    pub(crate) checksum: Option<u32>,
    pub(crate) data: Vec<u8>,
    pub(crate) inst: Vec<u8>,
    pub(crate) addr: Vec<u8>,
}

fn build_patch(app_header: Option<&[u8]>, windows: Vec<TestWindow>) -> Vec<u8> {
    const MAGIC: [u8; 4] = [0xD6, 0xC3, 0xC4, 0x00];
    const HDR_APP_HEADER: u8 = 0x04;

    let mut bytes = Vec::new();
    bytes.extend_from_slice(&MAGIC);
    if let Some(header) = app_header {
        bytes.push(HDR_APP_HEADER);
        encode_varint(&mut bytes, header.len() as u64);
        bytes.extend_from_slice(header);
    } else {
        bytes.push(0);
    }

    for window in windows {
        bytes.push(window.win_indicator);
        if let (Some(size), Some(position)) =
            (window.source_segment_size, window.source_segment_position)
        {
            encode_varint(&mut bytes, size);
            encode_varint(&mut bytes, position);
        }

        let mut delta = Vec::new();
        encode_varint(&mut delta, window.target_window_size);
        delta.push(0);
        encode_varint(&mut delta, window.data.len() as u64);
        encode_varint(&mut delta, window.inst.len() as u64);
        encode_varint(&mut delta, window.addr.len() as u64);
        if let Some(checksum) = window.checksum {
            delta.extend_from_slice(&checksum.to_be_bytes());
        }
        delta.extend_from_slice(&window.data);
        delta.extend_from_slice(&window.inst);
        delta.extend_from_slice(&window.addr);

        encode_varint(&mut bytes, delta.len() as u64);
        bytes.extend_from_slice(&delta);
    }

    bytes
}

const APS_GBA_BLOCK_SIZE: usize = 0x01_0000;

const DLDI_VERSION: u8 = 1;

const DLDI_MAGIC: [u8; 12] = [
    0xED, 0xA5, 0x8D, 0xBF, b' ', b'C', b'h', b'i', b's', b'h', b'm', 0x00,
];

const DLDI_FIX_ALL: u8 = 0x01;

const DLDI_FIX_GLUE: u8 = 0x02;

const DLDI_FIX_GOT: u8 = 0x04;

const DLDI_FIX_BSS: u8 = 0x08;

const DLDI_DO_MAGIC_STRING: usize = 0x00;

const DLDI_DO_VERSION: usize = 0x0C;

const DLDI_DO_DRIVER_SIZE: usize = 0x0D;

const DLDI_DO_FIX_SECTIONS: usize = 0x0E;

const DLDI_DO_ALLOCATED_SPACE: usize = 0x0F;

const DLDI_DO_FRIENDLY_NAME: usize = 0x10;

const DLDI_DO_TEXT_START: usize = 0x40;

const DLDI_DO_DATA_END: usize = 0x44;

const DLDI_DO_GLUE_START: usize = 0x48;

const DLDI_DO_GLUE_END: usize = 0x4C;

const DLDI_DO_GOT_START: usize = 0x50;

const DLDI_DO_GOT_END: usize = 0x54;

const DLDI_DO_BSS_START: usize = 0x58;

const DLDI_DO_BSS_END: usize = 0x5C;

const DLDI_DO_STARTUP: usize = 0x68;

const DLDI_DO_READ_SECTORS: usize = 0x70;

const DLDI_DO_WRITE_SECTORS: usize = 0x74;

const DLDI_DO_SHUTDOWN: usize = 0x7C;

const DLDI_DO_CODE: usize = 0x80;

fn build_ips32_patch(records: Vec<TestIpsRecord>) -> Vec<u8> {
    let mut bytes = b"IPS32".to_vec();
    for record in records {
        match record {
            TestIpsRecord::Literal { offset, data } => {
                write_u32(&mut bytes, offset);
                let len = u16::try_from(data.len()).expect("literal len");
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.extend_from_slice(&data);
            }
            TestIpsRecord::Rle { offset, len, value } => {
                write_u32(&mut bytes, offset);
                bytes.extend_from_slice(&0u16.to_be_bytes());
                bytes.extend_from_slice(&len.to_be_bytes());
                bytes.push(value);
            }
        }
    }
    bytes.extend_from_slice(b"EEOF");
    bytes
}

fn build_ebp_patch(records: Vec<TestIpsRecord>, metadata_json: &str) -> Vec<u8> {
    let mut bytes = build_ips_patch(records, None);
    bytes.extend_from_slice(metadata_json.as_bytes());
    bytes
}

fn write_sparse_bytes(path: &std::path::Path, len: u64, offset: u64, bytes: &[u8]) {
    let mut file = File::create(path).expect("create sparse file");
    file.set_len(len).expect("set len");
    file.seek(std::io::SeekFrom::Start(offset)).expect("seek");
    file.write_all(bytes).expect("write bytes");
    file.flush().expect("flush");
}

struct TestPpfRecord {
    pub(crate) offset: u32,
    pub(crate) data: Vec<u8>,
}

fn build_ppf1_patch(description: &str, records: Vec<TestPpfRecord>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PPF10");
    bytes.push(0);

    let mut desc = [0u8; 50];
    let src = description.as_bytes();
    let copy_len = src.len().min(desc.len());
    desc[..copy_len].copy_from_slice(&src[..copy_len]);
    bytes.extend_from_slice(&desc);

    for record in records {
        bytes.extend_from_slice(&record.offset.to_le_bytes());
        bytes.push(record.data.len() as u8);
        bytes.extend_from_slice(&record.data);
    }

    bytes
}

fn build_apsgba_patch(source: &[u8], target: &[u8]) -> Vec<u8> {
    assert_eq!(source.len(), APS_GBA_BLOCK_SIZE);
    assert_eq!(target.len(), APS_GBA_BLOCK_SIZE);

    let mut xor_bytes = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in xor_bytes.iter_mut().enumerate() {
        *byte = source[index] ^ target[index];
    }

    let mut bytes = Vec::with_capacity(12 + 4 + 2 + 2 + APS_GBA_BLOCK_SIZE);
    bytes.extend_from_slice(b"APS1");
    bytes.extend_from_slice(&(source.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&(target.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&crc16(source).to_le_bytes());
    bytes.extend_from_slice(&crc16(target).to_le_bytes());
    bytes.extend_from_slice(&xor_bytes);
    bytes
}

fn build_mod_patch(records: Vec<(u32, Vec<u8>)>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PMSR");
    bytes.extend_from_slice(&(records.len() as u32).to_be_bytes());
    for (offset, data) in records {
        bytes.extend_from_slice(&offset.to_be_bytes());
        bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&data);
    }
    bytes
}

enum TestGdiffCommand {
    Data(Vec<u8>),
    Copy { offset: u64, len: u64 },
}

fn build_gdiff_patch(commands: Vec<TestGdiffCommand>) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&[0xD1, 0xFF, 0xD1, 0xFF, 4]);
    for command in commands {
        match command {
            TestGdiffCommand::Data(data) => {
                if data.len() <= 246 {
                    bytes.push(u8::try_from(data.len()).expect("len <= 246"));
                } else if data.len() <= usize::from(u16::MAX) {
                    bytes.push(247);
                    bytes.extend_from_slice(
                        &u16::try_from(data.len())
                            .expect("len <= u16::MAX")
                            .to_be_bytes(),
                    );
                } else {
                    bytes.push(248);
                    bytes.extend_from_slice(
                        &i32::try_from(data.len())
                            .expect("len <= i32::MAX")
                            .to_be_bytes(),
                    );
                }
                bytes.extend_from_slice(&data);
            }
            TestGdiffCommand::Copy { offset, len } => {
                if offset <= u64::from(u16::MAX) && len <= u64::from(u8::MAX) {
                    bytes.push(249);
                    bytes.extend_from_slice(&(offset as u16).to_be_bytes());
                    bytes.push(len as u8);
                } else if offset <= u64::from(u16::MAX) && len <= u64::from(u16::MAX) {
                    bytes.push(250);
                    bytes.extend_from_slice(&(offset as u16).to_be_bytes());
                    bytes.extend_from_slice(&(len as u16).to_be_bytes());
                } else if offset <= u64::from(i32::MAX as u32) && len <= u64::from(u8::MAX) {
                    bytes.push(252);
                    bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                    bytes.push(len as u8);
                } else if offset <= u64::from(i32::MAX as u32) && len <= u64::from(u16::MAX) {
                    bytes.push(253);
                    bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                    bytes.extend_from_slice(&(len as u16).to_be_bytes());
                } else if offset <= u64::from(i32::MAX as u32) && len <= u64::from(i32::MAX as u32)
                {
                    bytes.push(254);
                    bytes.extend_from_slice(&(offset as u32).to_be_bytes());
                    bytes.extend_from_slice(&(len as u32).to_be_bytes());
                } else {
                    bytes.push(255);
                    bytes.extend_from_slice(
                        &i64::try_from(offset)
                            .expect("offset <= i64::MAX")
                            .to_be_bytes(),
                    );
                    bytes.extend_from_slice(
                        &i32::try_from(len).expect("len <= i32::MAX").to_be_bytes(),
                    );
                }
            }
        }
    }
    bytes.push(0);
    bytes
}

fn build_dldi_driver(driver_log2: u8, base_address: i32, friendly_name: &str) -> Vec<u8> {
    let size = 1usize << driver_log2;
    let mut bytes = vec![0u8; size];

    bytes[DLDI_DO_MAGIC_STRING..DLDI_DO_MAGIC_STRING + DLDI_MAGIC.len()]
        .copy_from_slice(&DLDI_MAGIC);
    bytes[DLDI_DO_VERSION] = DLDI_VERSION;
    bytes[DLDI_DO_DRIVER_SIZE] = driver_log2;
    bytes[DLDI_DO_FIX_SECTIONS] = DLDI_FIX_ALL | DLDI_FIX_GLUE | DLDI_FIX_GOT | DLDI_FIX_BSS;
    bytes[DLDI_DO_ALLOCATED_SPACE] = driver_log2;

    let name_bytes = friendly_name.as_bytes();
    let max_name_len = DLDI_DO_TEXT_START - DLDI_DO_FRIENDLY_NAME;
    let copy_len = name_bytes.len().min(max_name_len.saturating_sub(1));
    bytes[DLDI_DO_FRIENDLY_NAME..DLDI_DO_FRIENDLY_NAME + copy_len]
        .copy_from_slice(&name_bytes[..copy_len]);

    let size_i32 = i32::try_from(size).expect("size fits");
    write_i32_le(&mut bytes, DLDI_DO_TEXT_START, base_address);
    write_i32_le(&mut bytes, DLDI_DO_DATA_END, base_address + size_i32);
    write_i32_le(&mut bytes, DLDI_DO_GLUE_START, base_address + 0xA0);
    write_i32_le(&mut bytes, DLDI_DO_GLUE_END, base_address + 0xA8);
    write_i32_le(&mut bytes, DLDI_DO_GOT_START, base_address + 0xA8);
    write_i32_le(&mut bytes, DLDI_DO_GOT_END, base_address + 0xB0);
    write_i32_le(&mut bytes, DLDI_DO_BSS_START, base_address + 0xB0);
    write_i32_le(&mut bytes, DLDI_DO_BSS_END, base_address + 0xC0);
    write_i32_le(
        &mut bytes,
        DLDI_DO_STARTUP,
        base_address + i32::try_from(DLDI_DO_CODE).expect("fits"),
    );
    write_i32_le(
        &mut bytes,
        DLDI_DO_READ_SECTORS,
        base_address + i32::try_from(DLDI_DO_CODE + 8).expect("fits"),
    );
    write_i32_le(
        &mut bytes,
        DLDI_DO_WRITE_SECTORS,
        base_address + i32::try_from(DLDI_DO_CODE + 12).expect("fits"),
    );
    write_i32_le(
        &mut bytes,
        DLDI_DO_SHUTDOWN,
        base_address + i32::try_from(DLDI_DO_CODE + 16).expect("fits"),
    );

    write_i32_le(&mut bytes, DLDI_DO_CODE + 4, base_address + 0xD0);
    write_i32_le(&mut bytes, DLDI_DO_CODE + 12, base_address + 0xD8);
    write_i32_le(&mut bytes, 0xA0, base_address + 0x80);
    write_i32_le(&mut bytes, 0xA8, base_address + 0x84);
    bytes[0xB0..0xC0].fill(0x7F);
    bytes
}

fn build_nds_with_dldi_slot(
    slot_offset: usize,
    allocated_log2: u8,
    base_address: i32,
    friendly_name: &str,
) -> Vec<u8> {
    let slot_size = 1usize << allocated_log2;
    let mut file = vec![0xCDu8; slot_offset + slot_size + 0x80];
    let mut slot = build_dldi_driver(allocated_log2, base_address, friendly_name);
    slot[DLDI_DO_ALLOCATED_SPACE] = allocated_log2;
    file[slot_offset..slot_offset + slot_size].copy_from_slice(&slot);
    file
}
