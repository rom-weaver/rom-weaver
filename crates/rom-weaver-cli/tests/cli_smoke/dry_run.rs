use super::shared::*;

#[test]
fn patch_bundle_dry_run_lists_the_remote_source_without_downloading_it() {
    let temp = setup_temp_dir();
    let input = temp.child("source.bin");
    input.write_str("source").expect("fixture");
    let destination = temp.child("output.zip");
    let url = "https://example.invalid/rom-weaver-bundle.json";
    let output = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--bundle",
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
fn dry_run_keeps_patch_bundle_and_ingest_destinations_untouched() {
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
                "bundle", "create", "--input", input_path, "--patch", patch_path,
            ],
            "rom-weaver-bundle.json",
        ),
        (
            vec!["bundle", "parse", "--input", input_path],
            "bundle-members",
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
        ["bundle", "schema", "--dry-run", "--json"].as_slice(),
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
