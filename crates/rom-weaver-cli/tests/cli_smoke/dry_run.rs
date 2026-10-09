use super::shared::*;

#[test]
fn patch_weave_dry_run_lists_the_remote_source_without_downloading_it() {
    let temp = setup_temp_dir();
    let input = temp.child("source.bin");
    input.write_str("source").expect("fixture");
    let destination = temp.child("output.zip");
    let url = "https://example.invalid/rom-weaver-weave.json";
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--weave",
            url,
            "--output",
            destination.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ],
        0,
    );
    let events = parse_json_lines(&output);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["details"]["downloads"], serde_json::json!([url]));
    assert!(!destination.path().exists());
}

#[test]
fn dry_run_keeps_patch_weave_and_ingest_destinations_untouched() {
    let temp = setup_temp_dir();
    let input = temp.child("source.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("change.ips");
    input.write_str("original").expect("input");
    modified.write_str("modified").expect("modified");
    patch.write_str("PATCHEOF").expect("patch");
    let input_path = input.path().to_str().expect("path");
    let modified_path = modified.path().to_str().expect("path");
    let patch_path = patch.path().to_str().expect("path");
    let cases = [
        (
            vec![
                "patch",
                "create",
                "--original",
                input_path,
                "--modified",
                modified_path,
            ],
            "result.bps",
        ),
        (
            vec![
                "weave", "create", "--input", input_path, "--patch", patch_path,
            ],
            "rom-weaver-weave.json",
        ),
        (
            vec!["weave", "parse", "--input", input_path],
            "weave-members",
        ),
        (vec!["ingest", "--input", input_path], "ingested"),
    ];
    for (mut args, name) in cases {
        let destination = temp.child(name);
        args.extend([
            "--output",
            destination.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ]);
        let report = run_single_json_event(&args, 0);
        assert_eq!(report["details"]["dry_run"], true, "{args:?}");
        assert_eq!(report["details"]["read_only"], false, "{args:?}");
        assert!(!destination.path().exists(), "{args:?}");
    }
    assert_eq!(fs::read(input.path()).expect("input"), b"original");
    assert_eq!(fs::read(modified.path()).expect("modified"), b"modified");
    assert_eq!(fs::read(patch.path()).expect("patch"), b"PATCHEOF");
}

#[test]
fn dry_run_preserves_existing_database_files() {
    let temp = setup_temp_dir();
    let pack = temp.child("nintendo-nes.pack");
    pack.write_str("installed pack").expect("pack fixture");
    let report = run_single_json_event(
        &[
            "identify",
            "database",
            "remove",
            "nes",
            "--database-dir",
            temp.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ],
        0,
    );
    assert_eq!(report["details"]["dry_run"], true);
    assert_eq!(fs::read(pack.path()).expect("pack"), b"installed pack");
}

#[test]
fn quiet_dry_run_prints_the_requested_plan() {
    let temp = setup_temp_dir();
    let input = temp.child("source.bin");
    input.write_str("source").expect("fixture");
    let destination = temp.child("output.zip");
    let output = command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            destination.path().to_str().expect("path"),
            "--dry-run",
            "--quiet",
            "--no-color",
        ],
        0,
    );
    let output = String::from_utf8(output).expect("UTF-8 output");
    assert!(output.contains("dry run:"), "{output}");
    assert!(output.contains("nothing written"), "{output}");
    assert!(!destination.path().exists());
}

#[test]
fn extract_dry_run_reports_a_plan_without_creating_the_output_directory() {
    let temp = setup_temp_dir();
    let input = temp.child("input.bin");
    let output = temp.child("new-output");
    fs::write(input.path(), b"input").expect("input fixture");

    let report = run_single_json_event(
        &[
            "--dry-run",
            "extract",
            "--input",
            input.path().to_str().expect("input path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--json",
        ],
        0,
    );

    assert_eq!(report["status"], "succeeded");
    assert_eq!(report["details"]["dry_run"], true);
    assert_eq!(
        report["details"]["writes"],
        serde_json::json!([output.path().display().to_string()])
    );
    assert_eq!(report["details"]["downloads"], serde_json::json!([]));
    assert!(
        !output.path().exists(),
        "dry run must not create an output directory"
    );
}

#[test]
fn setup_dry_run_plans_the_download_without_creating_the_database_directory() {
    let temp = setup_temp_dir();
    let database_dir = temp.child("identify-database");

    let report = run_single_json_event(
        &[
            "setup",
            "--database-dir",
            database_dir.path().to_str().expect("database dir"),
            "--dry-run",
            "--json",
        ],
        0,
    );

    assert_eq!(report["status"], "succeeded");
    assert_eq!(report["details"]["dry_run"], true);
    assert_eq!(
        report["details"]["writes"],
        serde_json::json!([database_dir.path().display().to_string()])
    );
    assert_eq!(
        report["details"]["downloads"],
        serde_json::json!(["identify database release assets"])
    );
    assert!(
        !database_dir.path().exists(),
        "dry run must not create the database directory"
    );
}

#[test]
fn ppf_undo_dry_run_does_not_write_the_restored_rom() {
    let temp = setup_temp_dir();
    let rom = temp.child("patched.bin");
    let patch = temp.child("undo.ppf");
    let output = temp.child("restored.bin");
    fs::write(rom.path(), b"patched").expect("rom fixture");
    fs::write(patch.path(), b"PPF30").expect("patch fixture");

    let report = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "--input",
            rom.path().to_str().expect("rom path"),
            "--patch",
            patch.path().to_str().expect("patch path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--dry-run",
            "--json",
        ],
        0,
    );

    assert_eq!(report["status"], "succeeded");
    assert_eq!(
        report["details"]["writes"],
        serde_json::json!([output.path().display().to_string()])
    );
    assert!(
        !output.path().exists(),
        "dry run must not write the restored ROM"
    );
}

#[test]
fn native_read_only_commands_emit_the_standard_dry_run_plan() {
    for args in [
        ["formats", "--dry-run", "--json"].as_slice(),
        ["completions", "bash", "--dry-run", "--json"].as_slice(),
        ["weave", "schema", "--dry-run", "--json"].as_slice(),
    ] {
        let report = run_single_json_event(args, 0);
        assert_eq!(report["status"], "succeeded", "args={args:?}");
        assert_eq!(report["stage"], "plan", "args={args:?}");
        assert_eq!(report["details"]["dry_run"], true, "args={args:?}");
        assert_eq!(report["details"]["read_only"], true, "args={args:?}");
        assert_eq!(
            report["details"]["writes"],
            serde_json::json!([]),
            "args={args:?}"
        );
    }
}

#[test]
fn man_install_dry_run_does_not_create_its_destination() {
    let temp = setup_temp_dir();
    let output = temp.child("man-pages");

    let report = run_single_json_event(
        &[
            "man",
            "--install",
            "--man-dir",
            output.path().to_str().expect("man dir"),
            "--dry-run",
            "--json",
        ],
        0,
    );

    assert_eq!(report["status"], "succeeded");
    assert_eq!(report["details"]["dry_run"], true);
    assert_eq!(
        report["details"]["writes"],
        serde_json::json!([output.path().display().to_string()])
    );
    assert!(
        !output.path().exists(),
        "dry run must not create the man directory"
    );
}

#[test]
fn ppf_undo_dry_run_resolves_compression_path_and_warnings_without_writes() {
    let temp = setup_temp_dir();
    let rom = temp.child("patched.gba");
    let patch = temp.child("undo.ppf");
    fs::write(rom.path(), b"patched").expect("ROM fixture");
    fs::write(patch.path(), b"PPF30").expect("patch fixture");
    let output = temp.child("restored");
    let report = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--input",
            rom.path().to_str().expect("ROM"),
            "--patch",
            patch.path().to_str().expect("patch"),
            "--output",
            output.path().to_str().expect("output"),
            "--compress-format",
            "zip",
            "--compress-codec",
            "store",
            "--dry-run",
            "--json",
        ],
        0,
    );
    assert_eq!(report["details"]["format"], "zip");
    assert_eq!(report["details"]["codec"], "store");
    assert_eq!(
        report["details"]["writes"],
        serde_json::json!([temp.child("restored.zip").path().display().to_string()])
    );
    assert!(!output.path().exists());
    assert!(!temp.child("restored.zip").path().exists());
    let mismatched_output = temp.child("restored.7z");
    let report = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--input",
            rom.path().to_str().expect("ROM"),
            "--patch",
            patch.path().to_str().expect("patch"),
            "--output",
            mismatched_output.path().to_str().expect("output"),
            "--compress-format",
            "zip",
            "--dry-run",
            "--json",
        ],
        0,
    );
    assert_eq!(report["warnings"].as_array().expect("warnings").len(), 1);
    assert!(!mismatched_output.path().exists());
}

#[test]
fn ppf_undo_dry_run_rejects_invalid_compression_without_touching_output() {
    let temp = setup_temp_dir();
    let rom = temp.child("patched.gba");
    let patch = temp.child("undo.ppf");
    let output = temp.child("restored.zip");
    fs::write(rom.path(), b"patched").expect("ROM fixture");
    fs::write(patch.path(), b"PPF30").expect("patch fixture");
    fs::write(output.path(), b"keep output").expect("output fixture");
    let report = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--input",
            rom.path().to_str().expect("ROM"),
            "--patch",
            patch.path().to_str().expect("patch"),
            "--output",
            output.path().to_str().expect("output"),
            "--compress-codec",
            "lzma2",
            "--dry-run",
            "--json",
        ],
        1,
    );
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("unsupported zip codec")
    );
    assert_eq!(fs::read(output.path()).expect("output"), b"keep output");
}

#[test]
fn ppf_undo_dry_run_defers_raw_output_validation_until_archive_selection() {
    let temp = setup_temp_dir();
    let rom = temp.child("patched.gba");
    let packed = temp.child("rom.tar.gz");
    let patch = temp.child("undo.ppf");
    let output = temp.child("restored.gba");
    fs::write(rom.path(), b"patched").expect("ROM fixture");
    fs::write(patch.path(), b"PPF30").expect("patch fixture");
    write_tar_gz_fixture(&[(rom.path(), "patched.gba")], packed.path());
    let report = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--input",
            packed.path().to_str().expect("packed"),
            "--patch",
            patch.path().to_str().expect("patch"),
            "--output",
            output.path().to_str().expect("output"),
            "--dry-run",
            "--json",
        ],
        0,
    );
    assert_eq!(report["details"]["format"], "unresolved");
    assert!(
        report["details"]["notes"][0]
            .as_str()
            .expect("note")
            .contains("awaits archive payload selection")
    );
    assert!(!output.path().exists());
}

#[test]
fn ppf_undo_dry_run_marks_raw_disc_companion_outputs_unknown() {
    let temp = setup_temp_dir();
    let sheet = temp.child("disc.cue");
    let track = temp.child("track.bin");
    let patch = temp.child("undo.ppf");
    fs::write(
        sheet.path(),
        "FILE \"track.bin\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n",
    )
    .expect("disc sheet");
    fs::write(track.path(), [0u8; 2048]).expect("track");
    fs::write(patch.path(), b"PPF30").expect("patch");
    for (name, flags, unknown) in [
        ("out/restored.cue", vec!["--no-compress"], true),
        ("out/restored.zip", Vec::new(), false),
    ] {
        let output = temp.child(name);
        let mut args = vec![
            "tools",
            "ppf-undo",
            "--input",
            sheet.path().to_str().expect("sheet path"),
            "--patch",
            patch.path().to_str().expect("patch path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--dry-run",
            "--json",
        ];
        args.extend(flags);
        let report = run_single_json_event(&args, 0);
        assert_eq!(report["details"]["outputs_unknown"], unknown, "{name}");
        assert!(!output.path().exists());
        assert_eq!(
            fs::read(track.path()).expect("unchanged track"),
            [0u8; 2048]
        );
    }
}
