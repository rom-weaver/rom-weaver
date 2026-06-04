#[test]
fn patch_flat_commands_are_rejected() {
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["patch-apply", "--help"])
        .assert()
        .code(2);
}

#[test]
fn patch_apply_succeeds_for_valid_ips_patch() {
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    let emitted = json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    assert_eq!(emitted.len(), 1);
    assert_emitted_file(&json, temp.child("output.bin").path(), Some("bin"));
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abXYZfg!!!!"
    );
}

#[test]
fn patch_apply_reports_pds_as_explicitly_unsupported() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(temp.child("update.pds").path(), b"not-a-supported-pds").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.pds").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "PDS");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("explicitly not supported"));
}

#[test]
fn patch_apply_defaults_to_compressed_output_and_appends_extension() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output_base = temp.child("patched-output");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as 7z"));
    assert!(apply_label.contains("auto format=7z reason=fallback-7z-lzma2"));

    let compressed_path = temp.child("patched-output.7z");
    let emitted = apply_json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    assert_eq!(emitted.len(), 1);
    assert_emitted_file(&apply_json, compressed_path.path(), Some("archive"));
    assert!(compressed_path.path().exists());
    assert!(!output_base.path().exists());

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            compressed_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
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

        Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args([
                "patch", "create",
                "--original",
                original.path().to_str().expect("path"),
                "--modified",
                modified.path().to_str().expect("path"),
                "--format",
                "bps",
                "--output",
                patch.path().to_str().expect("path"),
                "--json",
            ])
            .assert()
            .code(0);

        let apply_output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args([
                "patch", "apply",
                "--input",
                original.path().to_str().expect("path"),
                "--patch",
                patch.path().to_str().expect("path"),
                "--output",
                output_base.path().to_str().expect("path"),
                "--compress-format",
                "z3ds",
                "--json",
            ])
            .assert()
            .code(0)
            .get_output()
            .stdout
            .clone();
        let apply_json = parse_single_json_line(&apply_output);
        assert_eq!(apply_json["command"], "patch-apply");
        assert_eq!(apply_json["family"], "patch");
        assert_eq!(apply_json["format"], "BPS");
        assert_eq!(apply_json["status"], "succeeded");
        let apply_label = apply_json["label"].as_str().expect("label");
        assert!(apply_label.contains("patch output compressed as z3ds"));

        let compressed_path =
            temp.child(format!("patched-{input_extension}.{compressed_extension}"));
        assert!(compressed_path.path().exists());
        assert_emitted_file(&apply_json, compressed_path.path(), Some("archive"));
    }
}

#[test]
fn patch_apply_auto_prefers_outer_input_container_format() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let input_zip = temp.child("input.zip");
    let output_base = temp.child("patched-out");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            input_zip.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            input_zip.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output_base.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    let apply_label = apply_json["label"].as_str().expect("label");
    assert!(apply_label.contains("patch output compressed as zip"));
    assert!(apply_label.contains("auto format=zip reason=outer-input-container"));

    let compressed_path = temp.child("patched-out.zip");
    assert!(compressed_path.path().exists());
    assert!(!output_base.path().exists());

    let out_dir = temp.child("extract");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            compressed_path.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    assert_eq!(
        read_single_file_bytes(out_dir.path()),
        fs::read(modified.path()).expect("modified")
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["status"], "failed");
    assert!(apply_json["label"]
        .as_str()
        .expect("label")
        .contains("--no-compress cannot be combined with --compress-format"));
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            intermediate.path().to_str().expect("path"),
            "--modified",
            expected.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            second_patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("applied 2 patches sequentially"));
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["status"], "succeeded");

    let output_bytes = fs::read(temp.child("output.bin").path()).expect("output");
    assert_eq!(output_bytes.len(), 0x0100_0002);
    assert_eq!(output_bytes[0x0100_0000], b'a');
    assert_eq!(output_bytes[0x0100_0001], b'Z');
}

#[test]
fn patch_create_succeeds_for_ips_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ips");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!!").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "IPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "IPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_reports_pds_as_explicitly_unsupported() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!!").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "pds",
            "--output",
            temp.child("output.pds").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "pds");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("explicitly not supported"));
}

#[test]
fn patch_create_succeeds_for_ips32_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("output.ips32");
    let output = temp.child("output.bin");
    write_sparse_bytes(original.path(), 0x0100_0002, 0x0100_0000, b"ab");
    write_sparse_bytes(modified.path(), 0x0100_0002, 0x0100_0000, b"aZ");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "IPS32");
    assert_eq!(create_json["requested_threads"], 8);
    let effective_threads = create_json["effective_threads"]
        .as_u64()
        .expect("effective_threads");
    assert!((1..=8).contains(&effective_threads));
    assert_eq!(create_json["used_parallelism"], effective_threads > 1);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert!(patch_bytes.starts_with(b"IPS32"));
    assert!(patch_bytes.ends_with(b"EEOF"));

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--ignore-checksum-validation",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "IPS32");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output")[0x0100_0000], b'a');
    assert_eq!(fs::read(output.path()).expect("output")[0x0100_0001], b'Z');
}

#[test]
fn patch_apply_succeeds_for_valid_ebp_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.ebp").path(),
        build_ebp_patch(
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
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ebp").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--ignore-checksum-validation",
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
    assert_eq!(json["format"], "EBP");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abXYZfg!!"
    );
}

#[test]
fn patch_create_succeeds_for_ebp_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.ebp");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ebp",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "EBP");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert!(patch_bytes.ends_with(
        br#"{"patcher":"EBPatcher","Author":"Unknown","Description":"No description","Title":"Untitled"}"#
    ));

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "EBP");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_supports_strip_and_add_header_flags() {
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

    let stripped_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-stripped.bin")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let stripped_json = parse_single_json_line(&stripped_output);
    assert_eq!(stripped_json["command"], "patch-apply");
    assert_eq!(stripped_json["family"], "patch");
    assert_eq!(stripped_json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output-stripped.bin").path()).expect("output"),
        b"Zbcdefgh".to_vec()
    );

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-headered.bin")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--add-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
fn patch_apply_supports_nes_header_strip_and_add_flags() {
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

    let stripped_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-stripped.nes")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let stripped_json = parse_single_json_line(&stripped_output);
    assert_eq!(stripped_json["command"], "patch-apply");
    assert_eq!(stripped_json["family"], "patch");
    assert_eq!(stripped_json["status"], "succeeded");
    assert!(stripped_json["label"]
        .as_str()
        .expect("label")
        .contains("input header stripped (16 bytes, No-Intro_NES.xml)"));
    assert_eq!(
        fs::read(temp.child("output-stripped.nes").path()).expect("output"),
        b"Zbcdefgh".to_vec()
    );

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.nes").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output-headered.nes")
                .path()
                .to_str()
                .expect("path"),
            "--strip-header",
            "--add-header",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--repair-checksum",
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
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("repaired checksum (sega-genesis)"));

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.gba").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.gba").path().to_str().expect("path"),
            "--repair-checksum",
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
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("repaired checksum (gba)"));

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.nds").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.nds").path().to_str().expect("path"),
            "--repair-checksum",
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--repair-checksum",
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
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("warning=no supported header repair profile matched; output left unchanged"));
}

#[test]
fn patch_apply_succeeds_for_valid_solid_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"abcdefghij").expect("fixture");
    fs::write(modified.path(), b"abCDfgh").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "solid",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output_bytes = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--ignore-checksum-validation",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output_bytes);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "SOLID");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_solid_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.solid");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"1234567890abcdef").expect("fixture");
    fs::write(modified.path(), b"1234XY7890abc!").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "solid",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "SOLID");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "SOLID");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_vcdiff_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.vcdiff");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "vcdiff",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "VCDIFF");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "VCDIFF");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_create_succeeds_for_bps_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "BPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert!(apply_json["label"]
        .as_str()
        .expect("label")
        .contains("patch apply input source resolved via 1 container extract step(s)"));
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-extract",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "failed");
    assert!(!apply_json["label"]
        .as_str()
        .expect("label")
        .contains("patch apply input source resolved via"));
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            alpha.path().to_str().expect("path"),
            "--modified",
            alpha_modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            alpha.path().to_str().expect("path"),
            beta.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            patch_source.path().to_str().expect("path"),
            "--modified",
            patch_target.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = temp.child("output.bin");
    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            source.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            alpha.path().to_str().expect("path"),
            "--modified",
            alpha_modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            alpha.path().to_str().expect("path"),
            beta.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert!(apply_json["label"]
        .as_str()
        .expect("label")
        .contains("patch apply input source resolved via 1 container extract step(s)"));
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            patch.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            input_archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            patch.path().to_str().expect("path"),
            temp.child("decoy.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            patch_archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            input_archive.path().to_str().expect("path"),
            "--patch",
            patch_archive.path().to_str().expect("path"),
            "--rom-filter",
            "--patch-filter",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_a.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_a.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_b.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_b.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            patch_a.path().to_str().expect("path"),
            patch_b.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            patch_archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch_archive.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_a.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_a.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified_b.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch_b.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            patch_a.path().to_str().expect("path"),
            patch_b.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            patch_archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert!(apply_json["label"]
        .as_str()
        .expect("label")
        .contains("patch apply patch source resolved via 1 container extract step(s)"));
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            original.path().to_str().expect("path"),
            sidecar_txt.path().to_str().expect("path"),
            sidecar_json.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let default_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let default_json = parse_single_json_line(&default_output);
    assert_eq!(default_json["command"], "patch-apply");
    assert_eq!(default_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    let no_ignore_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            archive.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-ignore",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let no_ignore_json = parse_single_json_line(&no_ignore_output);
    assert_eq!(no_ignore_json["command"], "patch-apply");
    assert_eq!(no_ignore_json["status"], "failed");
    let no_ignore_label = no_ignore_json["label"].as_str().expect("label");
    assert!(no_ignore_label.contains("ambiguous"));
    assert!(no_ignore_label.contains("--select"));
}

#[test]
fn patch_apply_can_ignore_checksum_validation_for_bps() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let mismatched_input = temp.child("old-mismatch.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");
    fs::write(mismatched_input.path(), b"hello zld world").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let strict_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            mismatched_input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let strict_json = parse_single_json_line(&strict_output);
    assert_eq!(strict_json["command"], "patch-apply");
    assert_eq!(strict_json["family"], "patch");
    assert_eq!(strict_json["format"], "BPS");
    assert_eq!(strict_json["status"], "failed");
    assert!(strict_json["label"]
        .as_str()
        .expect("label")
        .contains("Input checksum invalid"));

    let ignored_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            mismatched_input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let ignored_json = parse_single_json_line(&ignored_output);
    assert_eq!(ignored_json["command"], "patch-apply");
    assert_eq!(ignored_json["family"], "patch");
    assert_eq!(ignored_json["format"], "BPS");
    assert_eq!(ignored_json["status"], "succeeded");
    assert!(ignored_json["label"]
        .as_str()
        .expect("label")
        .contains("checksum validation skipped"));
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let input_crc32 = checksum_value(original.path(), "crc32");
    let input_sha1 = checksum_value(original.path(), "sha1");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--validate-with-checksum",
            &format!("crc32={input_crc32}"),
            "--validate-with-checksum",
            &format!("sha1={input_sha1}"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--validate-with-checksum",
            "crc32=00000000",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["status"], "failed");
    assert!(apply_json["label"]
        .as_str()
        .expect("label")
        .contains("input checksum mismatch for crc32"));
}

#[test]
fn patch_apply_uses_checksum_cache_for_validation() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--checksum-cache",
            "sha1=0000000000000000000000000000000000000000",
            "--validate-with-checksum",
            "sha1=0000000000000000000000000000000000000000",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "BPS");
    assert_eq!(apply_json["status"], "succeeded");
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let probe_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["probe", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let probe_json = parse_single_json_line(&probe_output);
    assert_eq!(probe_json["command"], "probe");
    assert_eq!(probe_json["family"], "patch");
    assert_eq!(probe_json["format"], "BPS");
    assert_eq!(probe_json["status"], "succeeded");
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ups",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let probe_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["probe", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let probe_json = parse_single_json_line(&probe_output);
    assert_eq!(probe_json["command"], "probe");
    assert_eq!(probe_json["family"], "patch");
    assert_eq!(probe_json["format"], "UPS");
    assert_eq!(probe_json["status"], "succeeded");
    assert_eq!(probe_json["details"]["patch"]["format"], "UPS");
    assert_eq!(probe_json["details"]["patch"]["source_size"], 15);
    assert_eq!(probe_json["details"]["patch"]["target_size"], 15);
    assert!(probe_json["details"]["patch"]["source_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["target_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["patch_crc32"].is_number());
    assert!(probe_json["details"]["patch"]["record_count"].is_number());
}

#[test]
fn patch_create_succeeds_for_bdf_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bdf");
    let output = temp.child("output.bin");
    fs::write(
        original.path(),
        b"The quick brown fox jumps over the lazy dog.",
    )
    .expect("fixture");
    fs::write(
        modified.path(),
        b"The quick brown cat jumps over two lazy dogs!",
    )
    .expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bdf",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "BDF/BSDIFF40");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert_eq!(&patch_bytes[..8], b"BSDIFF40");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "BDF/BSDIFF40");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_succeeds_for_valid_bsp_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let patch = temp.child("update.bsp");
    let output = temp.child("output.bin");
    fs::write(original.path(), [0x01, 0x02, 0x03]).expect("fixture");
    fs::write(patch.path(), [0x18, 0xFF, 0x06, 0x00, 0x00, 0x00, 0x00]).expect("fixture");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "BSP");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        vec![0xFF, 0x02, 0x03]
    );
}

#[test]
fn patch_create_succeeds_for_ups_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.ups");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ups",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "UPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "UPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
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

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "RUP");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "RUP");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );

    let reverse_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            output.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            reverse.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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
fn patch_create_succeeds_for_ppf_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.ppf");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world\0\0").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ppf",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "PPF");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "PPF");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
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

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "APS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "APS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output"), target);
}

#[test]
fn patch_create_succeeds_for_mod_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.mod");
    let output = temp.child("output.bin");
    fs::write(original.path(), [0x01, 0x02]).expect("fixture");
    fs::write(modified.path(), [0x01, 0x02, 0x00, 0x00]).expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "mod",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "MOD");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--ignore-checksum-validation",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["format"], "MOD");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
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

    let seed_apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let seed_apply_json = parse_single_json_line(&seed_apply_output);
    assert_eq!(seed_apply_json["command"], "patch-apply");
    assert_eq!(seed_apply_json["family"], "patch");
    assert_eq!(seed_apply_json["format"], "DLDI");
    assert_eq!(seed_apply_json["requested_threads"], 8);
    assert_eq!(seed_apply_json["effective_threads"], 1);
    assert_eq!(seed_apply_json["used_parallelism"], false);
    assert_eq!(seed_apply_json["status"], "succeeded");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "DLDI");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "DLDI");
    assert_eq!(apply_json["status"], "succeeded");
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

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "DLDI");
    assert_eq!(apply_json["status"], "unsupported");
    assert_eq!(
        apply_json["label"],
        "input does not contain a patchable DLDI section"
    );
}

#[test]
fn patch_create_succeeds_for_dps_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.dps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world + dps").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "dps",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "DPS");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");
    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert!(patch_bytes.len() >= 198);
    assert_eq!(patch_bytes[193], 1);
    assert_ne!(&patch_bytes[..2], b"PK");
    assert_eq!(
        u32::from_le_bytes([
            patch_bytes[194],
            patch_bytes[195],
            patch_bytes[196],
            patch_bytes[197],
        ]),
        15
    );

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "DPS");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
    );
}

#[test]
fn patch_apply_can_ignore_checksum_validation_for_dps() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let mismatched_input = temp.child("old-mismatch.bin");
    let patch = temp.child("update.dps");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world + dps").expect("fixture");
    fs::write(mismatched_input.path(), b"hello old world!").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "dps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let strict_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            mismatched_input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let strict_json = parse_single_json_line(&strict_output);
    assert_eq!(strict_json["command"], "patch-apply");
    assert_eq!(strict_json["family"], "patch");
    assert_eq!(strict_json["format"], "DPS");
    assert_eq!(strict_json["status"], "failed");
    assert!(strict_json["label"]
        .as_str()
        .expect("label")
        .contains("source size mismatch"));

    let ignored_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            mismatched_input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let ignored_json = parse_single_json_line(&ignored_output);
    assert_eq!(ignored_json["command"], "patch-apply");
    assert_eq!(ignored_json["family"], "patch");
    assert_eq!(ignored_json["format"], "DPS");
    assert_eq!(ignored_json["status"], "succeeded");
    assert!(ignored_json["label"]
        .as_str()
        .expect("label")
        .contains("checksum validation skipped"));
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
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

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
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
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "HDiffPatch/HPatchZ");
    assert_eq!(create_json["status"], "unsupported");
    assert!(create_json["label"]
        .as_str()
        .unwrap_or_default()
        .contains("patch creation is disabled"));
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

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "HDiffPatch/HPatchZ");
    assert_eq!(apply_json["requested_threads"], 8);
    assert_eq!(apply_json["effective_threads"], 1);
    assert_eq!(apply_json["used_parallelism"], false);
    assert_eq!(apply_json["thread_fallback"], true);
    assert!(apply_json["thread_fallback_reason"]
        .as_str()
        .expect("thread fallback reason")
        .contains("no independent step-level parallel work"));
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

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "HDiffPatch/HPatchZ");
    assert_eq!(apply_json["status"], "unsupported");
    assert!(apply_json["label"]
        .as_str()
        .expect("label")
        .contains("directory patches (HDIFF19) are not supported"));
}

#[test]
fn patch_apply_succeeds_for_valid_gdiff_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.gdiff").path(),
        build_gdiff_patch(vec![
            TestGdiffCommand::Copy { offset: 0, len: 2 },
            TestGdiffCommand::Data(b"XY".to_vec()),
            TestGdiffCommand::Copy { offset: 4, len: 4 },
        ]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.gdiff").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "GDIFF");
    assert_eq!(json["requested_threads"], 8);
    let effective_threads = json["effective_threads"]
        .as_u64()
        .expect("effective_threads");
    assert!((1..=8).contains(&effective_threads));
    assert_eq!(json["used_parallelism"], effective_threads > 1);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abXYefgh"
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ffp_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("fixture");
    fs::write(
        temp.child("update.ffp").path(),
        b"comment line\n00000000 61 41\n00000001 62 42\n",
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ffp").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "PAT");
    assert_eq!(json["requested_threads"], 8);
    let effective_threads = json["effective_threads"]
        .as_u64()
        .expect("effective_threads");
    assert!((1..=8).contains(&effective_threads));
    assert_eq!(json["used_parallelism"], effective_threads > 1);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"ABcdefgh"
    );
}

#[test]
fn patch_create_succeeds_for_pat_and_round_trips() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.pat");
    let output = temp.child("output.bin");
    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"HELlo old worlD").expect("fixture");

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "pat",
            "--output",
            patch.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "PAT");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_text = fs::read_to_string(patch.path()).expect("patch");
    assert!(patch_text.contains("00000000 68 48"));

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let apply_json = parse_single_json_line(&apply_output);
    assert_eq!(apply_json["command"], "patch-apply");
    assert_eq!(apply_json["family"], "patch");
    assert_eq!(apply_json["format"], "PAT");
    assert_eq!(apply_json["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        fs::read(modified.path()).expect("modified")
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

    let create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
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
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let create_json = parse_single_json_line(&create_output);
    assert_eq!(create_json["command"], "patch-create");
    assert_eq!(create_json["family"], "patch");
    assert_eq!(create_json["format"], "xdelta");
    assert_eq!(create_json["requested_threads"], 8);
    assert_eq!(create_json["effective_threads"], 1);
    assert_eq!(create_json["used_parallelism"], false);
    assert_eq!(create_json["status"], "succeeded");

    let patch_bytes = fs::read(patch.path()).expect("patch");
    assert_eq!(&patch_bytes[..4], &[0xD6, 0xC3, 0xC4, 0x00]);
    assert_ne!(
        patch_bytes[4] & 0x01,
        0,
        "expected secondary-compressed xdelta output"
    );

    let apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("update.vcdiff").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "VCDIFF");
    assert_eq!(json["status"], "succeeded");
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
fn probe_succeeds_for_valid_mod_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.mod").path(),
        build_mod_patch(vec![(1, b"X".to_vec())]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("update.mod").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "MOD");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_valid_dldi_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.dldi").path(),
        build_dldi_driver(8, 0xBF80_0000u32 as i32, "Probe driver"),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("update.dldi").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "DLDI");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_valid_dps_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("update.dps");
    fs::write(original.path(), b"01234567").expect("fixture");
    fs::write(modified.path(), b"0123ZZ67").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "dps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["probe", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "DPS");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_valid_gdiff_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.gdiff").path(),
        build_gdiff_patch(vec![
            TestGdiffCommand::Copy { offset: 0, len: 2 },
            TestGdiffCommand::Data(b"XY".to_vec()),
            TestGdiffCommand::Copy { offset: 2, len: 2 },
        ]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("update.gdiff").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "GDIFF");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_valid_hdiffpatch_patch() {
    let temp = setup_temp_dir();
    let patch = temp.child("update.hpatchz");
    let source = b"source bytes";
    let target = b"target bytes for hdiffpatch";
    fs::write(patch.path(), build_hdiff13_nocomp_patch(source, target)).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["probe", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "HDiffPatch/HPatchZ");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_valid_ebp_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ebp").path(),
        build_ebp_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"A".to_vec(),
            }],
            r#"{"patcher":"EBPatcher","Title":"Probe"}"#,
        ),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("update.ebp").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "EBP");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_valid_ips32_patch() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ips32").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"A".to_vec(),
        }]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("update.ips32").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_ips32_patch_with_ips_extension() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ips").path(),
        build_ips32_patch(vec![TestIpsRecord::Literal {
            offset: 0x0100_0000,
            data: b"A".to_vec(),
        }]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("update.ips").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS32");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_succeeds_for_valid_solid_patch() {
    let temp = setup_temp_dir();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("update.solid");
    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"abcZefgh").expect("fixture");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "solid",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["probe", patch.path().to_str().expect("path"), "--json"])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "SOLID");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn patch_apply_succeeds_for_valid_xdelta_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcabcabcabc").expect("fixture");
    let expected = b"abcabcZZabcabc";
    let checksum = adler32(expected);
    let patch = build_patch(
        Some(b"xdelta-cli"),
        vec![TestWindow {
            win_indicator: 0x01 | 0x04,
            source_segment_size: Some(12),
            source_segment_position: Some(0),
            target_window_size: expected.len() as u64,
            checksum: Some(checksum),
            data: b"ZZ".to_vec(),
            inst: vec![22, 3, 22],
            addr: encode_all_varints(&[0, 6]),
        }],
    );
    fs::write(temp.child("update.xdelta").path(), patch).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "xdelta");
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
fn patch_apply_can_ignore_checksum_validation_for_xdelta() {
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

    let strict_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let strict_json = parse_single_json_line(&strict_output);
    assert_eq!(strict_json["command"], "patch-apply");
    assert_eq!(strict_json["family"], "patch");
    assert_eq!(strict_json["format"], "xdelta");
    assert_eq!(strict_json["status"], "failed");
    assert!(strict_json["label"]
        .as_str()
        .expect("label")
        .contains("checksum mismatch"));

    let ignored_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--ignore-checksum-validation",
            "--no-compress",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let ignored_json = parse_single_json_line(&ignored_output);
    assert_eq!(ignored_json["command"], "patch-apply");
    assert_eq!(ignored_json["family"], "patch");
    assert_eq!(ignored_json["format"], "xdelta");
    assert_eq!(ignored_json["status"], "succeeded");
    assert!(ignored_json["label"]
        .as_str()
        .expect("label")
        .contains("checksum validation skipped"));
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        expected
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "validate",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.xdelta").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-validate");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "xdelta");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("checksum mismatch"));
}

#[test]
fn patch_validate_succeeds_with_source_values() {
    let temp = setup_temp_dir();
    let original = temp.child("old.bin");
    let modified = temp.child("new.bin");
    let patch = temp.child("update.bps");

    fs::write(original.path(), b"hello old world").expect("fixture");
    fs::write(modified.path(), b"hello new world").expect("fixture");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let input_crc32 = checksum_value(original.path(), "crc32");
    let input_size = fs::metadata(original.path()).expect("metadata").len().to_string();
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "validate",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--validate-with-size",
            &input_size,
            "--validate-with-checksum",
            &format!("crc32={input_crc32}"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-validate");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["patch_validation"]["dry_run"], true);
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
        let output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args([
                "patch", "validate",
                "--input",
                temp.child(input_name).path().to_str().expect("path"),
                "--patch",
                temp.child(patch_name).path().to_str().expect("path"),
                "--threads",
                "8",
                "--json",
            ])
            .assert()
            .code(0)
            .get_output()
            .stdout
            .clone();

        let json = parse_single_json_line(&output);
        assert_eq!(json["command"], "patch-validate");
        assert_eq!(json["family"], "patch");
        assert_eq!(json["format"], expected_format);
        assert_eq!(json["status"], "succeeded");
        assert_eq!(json["details"]["patch_validation"]["status"], "passed");
        assert!(json["label"]
            .as_str()
            .expect("label")
            .contains("patch validation passed"));
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "validate",
            "--input",
            temp.child("wrong-input.gba").path().to_str().expect("path"),
            "--patch",
            temp.child("update.aps").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-validate");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "APSGBA");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("Source checksum invalid"));
}

#[test]
fn patch_apply_succeeds_for_valid_bps_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcabcabcabc").expect("fixture");
    fs::write(temp.child("update.bps").path(), SIMPLE_BPS_PATCH).expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.bps").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["requested_threads"], 8);
    let effective_threads = json["effective_threads"]
        .as_u64()
        .expect("effective_threads");
    assert!((1..=8).contains(&effective_threads));
    assert_eq!(json["used_parallelism"], effective_threads > 1);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abcabcZZabcabc"
    );
}

#[test]
fn patch_apply_succeeds_for_valid_ppf_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcabcabcabc").expect("fixture");
    fs::write(
        temp.child("update.ppf").path(),
        build_ppf1_patch(
            "cli test patch",
            vec![TestPpfRecord {
                offset: 6,
                data: b"ZZ".to_vec(),
            }],
        ),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ppf").path().to_str().expect("path"),
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
    assert_eq!(json["format"], "PPF");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"abcabcZZcabc"
    );
}

#[test]
fn patch_apply_succeeds_for_valid_aps_patch() {
    let temp = setup_temp_dir();
    let mut source = vec![0u8; APS_GBA_BLOCK_SIZE];
    for (index, byte) in source.iter_mut().enumerate() {
        *byte = ((index * 17 + (index >> 5)) & 0xff) as u8;
    }
    let mut target = source.clone();
    target[0x0123] ^= 0x3f;
    target[0x8000] = 0x5a;

    fs::write(temp.child("input.gba").path(), &source).expect("fixture");
    fs::write(
        temp.child("update.aps").path(),
        build_apsgba_patch(&source, &target),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.gba").path().to_str().expect("path"),
            "--patch",
            temp.child("update.aps").path().to_str().expect("path"),
            "--output",
            temp.child("output.gba").path().to_str().expect("path"),
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
    // Signature-based probing routes APS1 payloads to APSGBA even if extension is .aps.
    assert_eq!(json["format"], "APSGBA");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.gba").path()).expect("output"),
        target
    );
}

#[test]
fn patch_apply_succeeds_for_valid_mod_patch() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"ORIGINAL").expect("fixture");
    fs::write(
        temp.child("update.mod").path(),
        build_mod_patch(vec![(1, b"X".to_vec())]),
    )
    .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.mod").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--threads",
            "8",
            "--no-compress",
            "--ignore-checksum-validation",
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
    assert_eq!(json["format"], "MOD");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("output.bin").path()).expect("output"),
        b"OXIGINAL"
    );
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
            "patch", "apply",
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
    assert!(json["thread_fallback_reason"]
        .as_str()
        .expect("thread fallback reason")
        .contains("forced thread pool build failure (multi)"));
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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch", "apply",
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
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("broken.vcdiff").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "VCDIFF");
    assert_eq!(json["status"], "failed");
}

#[test]
fn probe_reports_unknown_formats_cleanly() {
    let temp = setup_temp_dir();
    temp.child("unknown.bin")
        .write_str("payload")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("unknown.bin").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

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

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "probe",
            temp.child("legacy.pds").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "PDS");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("explicitly not supported"));
}
