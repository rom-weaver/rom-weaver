use super::shared::*;

fn report(args: &[&str]) -> Value {
    serde_json::from_slice(&command_stdout(args, 0)).expect("one complete JSON report")
}

/// The emitted `path` strings as written. Comparing these against a bare
/// `fs::canonicalize` result cannot work on Windows, where canonicalize returns
/// a verbatim path; pair them with `expected_event_path` instead.
fn emitted_paths(report: &Value) -> Vec<String> {
    report["details"]["emitted_files"]
        .as_array()
        .expect("emitted files")
        .iter()
        .map(|entry| entry["path"].as_str().expect("output path").to_string())
        .collect()
}

#[test]
fn report_output_extract_preserves_warnings_and_emitted_files() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    let archive = temp.child("game.zip");
    let output = temp.child("out");
    fs::write(input.path(), b"hello world").expect("input fixture");
    command_stdout(
        &[
            "compress",
            input.path().to_str().expect("input path"),
            "-o",
            archive.path().to_str().expect("archive path"),
        ],
        0,
    );
    let result = report(&[
        "extract",
        archive.path().to_str().expect("archive path"),
        "-o",
        output.path().to_str().expect("output path"),
        "--split-bin",
        "--checksum",
        "crc32",
        "--quiet",
        "--json",
    ]);
    assert!(
        result["details"]["warnings"][0]
            .as_str()
            .expect("split-bin warning")
            .contains("ignored --split-bin for non-CHD input")
    );
    let files = emitted_paths(&result);
    assert_eq!(
        files,
        [expected_event_path(output.child("game.bin").path())]
    );
    assert_eq!(
        fs::read(&files[0]).expect("extracted bytes"),
        b"hello world"
    );
    assert_eq!(
        result["details"]["emitted_files"][0]["checksums"]["crc32"],
        "0d4a1185"
    );
}

#[test]
fn report_output_format_warning_is_visible_with_quiet() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    let output = temp.child("game.7z");
    fs::write(input.path(), b"hello world").expect("input fixture");
    let result = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            input.path().to_str().expect("input path"),
            "-o",
            output.path().to_str().expect("output path"),
            "--format",
            "zip",
            "--quiet",
        ])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(result.stdout.is_empty());
    let stderr = String::from_utf8(result.stderr).expect("stderr");
    assert!(stderr.contains("warning"), "{stderr}");
    assert!(stderr.contains("zip"), "{stderr}");
    assert!(stderr.contains("7z"), "{stderr}");
    assert!(fs::read(output.path()).expect("archive").starts_with(b"PK"));
}

#[test]
fn report_output_patch_create_names_output_without_checksum_name() {
    let temp = setup_temp_dir();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("change.ips");
    fs::write(original.path(), b"hello world").expect("original fixture");
    fs::write(modified.path(), b"Hello world").expect("modified fixture");
    let result = report(&[
        "patch",
        "create",
        "--original",
        original.path().to_str().expect("original path"),
        "--modified",
        modified.path().to_str().expect("modified path"),
        "-o",
        patch.path().to_str().expect("patch path"),
        "--json",
    ]);
    assert_eq!(emitted_paths(&result), [expected_event_path(patch.path())]);
}

#[test]
fn report_output_apply_reports_failed_bundle_sidecar_before_terminal_success() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    let patch = temp.child("change.ips");
    let output = temp.child("patched.bin");
    let blocked_bundle = temp.child("bundle-directory");
    fs::write(input.path(), b"hello world").expect("input fixture");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![b'H'],
            }],
            None,
        ),
    )
    .expect("patch fixture");
    fs::create_dir(blocked_bundle.path()).expect("blocked bundle destination");
    let result = report(&[
        "patch",
        "apply",
        "-i",
        input.path().to_str().expect("input path"),
        "--patch",
        patch.path().to_str().expect("patch path"),
        "-o",
        output.path().to_str().expect("output path"),
        "--no-compress",
        "--emit-bundle",
        blocked_bundle.path().to_str().expect("bundle path"),
        "--json",
    ]);
    assert_eq!(result["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("patched bytes"),
        b"Hello world"
    );
    assert!(
        result["details"]["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|warning| warning.as_str().is_some_and(|warning| {
                warning.contains("--emit-bundle") && warning.contains("failed")
            }))
    );
    assert_eq!(emitted_paths(&result), [expected_event_path(output.path())]);
}

#[test]
fn report_output_trim_reports_final_path_and_size() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nds");
    let output = temp.child("trimmed.nds");
    fs::write(
        input.path(),
        build_test_nds_rom(0x00, 0x3000, 0x3000, 0x5000, false),
    )
    .expect("NDS fixture");
    let result = report(&[
        "trim",
        input.path().to_str().expect("input path"),
        "-o",
        output.path().to_str().expect("output path"),
        "--json",
    ]);
    assert_eq!(emitted_paths(&result), [expected_event_path(output.path())]);
    assert_eq!(
        result["details"]["emitted_files"][0]["size_bytes"],
        fs::metadata(output.path()).expect("output metadata").len()
    );
    assert_eq!(result["details"]["changed"], 1);
}

#[test]
fn report_output_bundle_create_reports_definition_and_archive() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    let patch = temp.child("change.ips");
    let definition = temp.child("rom-weaver-bundle.json");
    let archive = temp.child("bundle.zip");
    fs::write(input.path(), b"hello world").expect("input fixture");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![b'H'],
            }],
            None,
        ),
    )
    .expect("patch fixture");
    let result = report(&[
        "bundle",
        "create",
        "-i",
        input.path().to_str().expect("input path"),
        "--patch",
        patch.path().to_str().expect("patch path"),
        "-o",
        definition.path().to_str().expect("definition path"),
        "--bundle",
        archive.path().to_str().expect("archive path"),
        "--json",
    ]);
    assert_eq!(
        emitted_paths(&result),
        [
            expected_event_path(definition.path()),
            expected_event_path(archive.path()),
        ]
    );
}

#[cfg(unix)]
#[test]
fn report_output_bundle_sidecar_preserves_whitespace_in_rom_paths() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    let patch = temp.child("change.ips");
    let output = temp.child("patched.bin ");
    let bundle = temp.child("bundle.json");
    fs::write(input.path(), b"hello world").expect("input fixture");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![b'H'],
            }],
            None,
        ),
    )
    .expect("patch fixture");
    let result = report(&[
        "patch",
        "apply",
        "-i",
        input.path().to_str().unwrap(),
        "--patch",
        patch.path().to_str().unwrap(),
        "-o",
        output.path().to_str().unwrap(),
        "--no-compress",
        "--emit-bundle",
        bundle.path().to_str().unwrap(),
        "--json",
    ]);
    assert_eq!(
        emitted_paths(&result),
        [
            expected_event_path(output.path()),
            expected_event_path(bundle.path()),
        ]
    );
    assert_eq!(fs::read(output.path()).unwrap(), b"Hello world");
    assert!(serde_json::from_slice::<Value>(&fs::read(bundle.path()).unwrap()).is_ok());
}

#[cfg(unix)]
#[test]
fn report_output_sidecar_warning_escapes_controls_and_prints_once() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    let patch = temp.child("change.ips");
    let output = temp.child("patched.bin");
    let blocked = temp.child("bad\n\x1b[31mDIR");
    fs::write(input.path(), b"hello world").expect("input fixture");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![b'H'],
            }],
            None,
        ),
    )
    .expect("patch fixture");
    fs::write(blocked.path(), b"file").expect("blocked parent");
    for flags in [vec![], vec!["--quiet"], vec!["--verbose"], vec!["--debug"]] {
        let _ = fs::remove_file(output.path());
        let result = Command::cargo_bin("rom-weaver")
            .unwrap()
            .env_remove("ROM_WEAVER_LOG")
            .env_remove("RUST_LOG")
            .args([
                "patch",
                "apply",
                "-i",
                input.path().to_str().unwrap(),
                "--patch",
                patch.path().to_str().unwrap(),
                "-o",
                output.path().to_str().unwrap(),
                "--no-compress",
                "--emit-bundle",
            ])
            .arg(blocked.child("bundle.json").path())
            .args(&flags)
            .assert()
            .success()
            .get_output()
            .clone();
        let stderr = String::from_utf8(result.stderr).unwrap();
        assert!(result.stdout.is_empty());
        assert!(!stderr.contains('\x1b'), "{stderr:?}");
        assert!(!stderr.contains("bad\n"), "{stderr:?}");
        assert_eq!(
            stderr
                .lines()
                .filter(|line| line.starts_with("warning:"))
                .count(),
            1
        );
        if flags.is_empty() || flags == ["--quiet"] {
            assert_eq!(stderr.lines().count(), 1, "{stderr}");
        }
    }
}
