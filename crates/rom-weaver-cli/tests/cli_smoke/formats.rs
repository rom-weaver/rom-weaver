//! `rom-weaver formats`, plus the usability guarantees that live on the
//! top-level command surface: bare invocation prints help, `--quiet` drops the
//! success summary, and `--force`/`--dry-run` guard writes.

use super::shared::*;

fn setup_temp_dir() -> TempDir {
    TempDir::new().expect("temp dir")
}

#[test]
fn formats_lists_container_patch_and_checksum_support() {
    let stdout = command_stdout(&["formats"], 0);
    let text = String::from_utf8(stdout).expect("utf8 stdout");
    assert!(text.contains("Container formats"), "{text}");
    assert!(text.contains("Patch formats"), "{text}");
    assert!(text.contains("Checksum algorithms"), "{text}");
    // A create-capable format, an extract-only one, and a codec list.
    assert!(text.contains("chd"), "{text}");
    assert!(text.contains("rar"), "{text}");
    assert!(text.contains("cdlz"), "{text}");
    assert!(text.contains("blake3"), "{text}");
}

#[test]
fn formats_json_reports_capabilities_from_the_registries() {
    let stdout = command_stdout(&["formats", "--json"], 0);
    let report: Value = serde_json::from_slice(&stdout).expect("json report");
    let containers = report["containers"].as_array().expect("containers");
    let chd = containers
        .iter()
        .find(|format| format["name"] == "chd")
        .expect("chd is registered");
    assert_eq!(chd["create"], true);
    assert_eq!(chd["extract"], true);
    let rar = containers
        .iter()
        .find(|format| format["name"] == "rar")
        .expect("rar is registered");
    assert_eq!(rar["create"], false);
    assert!(!report["patches"].as_array().expect("patches").is_empty());
    assert!(
        report["checksumAlgorithms"]
            .as_array()
            .expect("algorithms")
            .contains(&Value::from("crc32"))
    );
}

#[test]
fn bare_invocation_prints_full_help() {
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    let assert = command.assert().code(2);
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr).into_owned();
    // Full help, not the one-line usage error: the subcommand list is present.
    assert!(stderr.contains("Commands:"), "{stderr}");
    assert!(stderr.contains("compress"), "{stderr}");
}

#[test]
fn compress_refuses_to_overwrite_without_force() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    fs::write(input.path(), b"rom bytes").expect("input fixture");
    let output = temp.child("game.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let refused = command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let terminal = parse_single_json_line(&refused);
    assert_eq!(terminal["status"], "failed");
    let label = terminal["label"].as_str().expect("label");
    assert!(
        label.contains("refusing to overwrite existing output"),
        "{label}"
    );
    assert!(label.contains("--force"), "{label}");

    // --force goes through.
    command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--force",
            "--json",
        ],
        0,
    );
}

#[test]
fn compress_dry_run_reports_the_plan_and_writes_nothing() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    fs::write(input.path(), b"rom bytes").expect("input fixture");
    let output = temp.child("game.zip");

    let stdout = command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--dry-run",
            "--json",
        ],
        0,
    );
    let terminal = parse_single_json_line(&stdout);
    assert_eq!(terminal["status"], "succeeded");
    assert_eq!(terminal["details"]["dry_run"], true);
    assert_eq!(terminal["details"]["format"], "zip");
    assert!(!output.path().exists(), "dry run must not write the output");
}

#[test]
fn quiet_drops_the_write_summary_but_keeps_query_output() {
    let temp = setup_temp_dir();
    let input = temp.child("game.bin");
    fs::write(input.path(), b"rom bytes").expect("input fixture");
    let output = temp.child("game.zip");

    let stdout = command_stdout(
        &[
            "--quiet",
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
        ],
        0,
    );
    assert!(
        String::from_utf8_lossy(&stdout).trim().is_empty(),
        "--quiet should print no compress summary"
    );
    assert!(output.path().exists());

    // A checksum's result is the answer, not a summary, so it survives --quiet.
    let stdout = command_stdout(
        &[
            "--quiet",
            "checksum",
            "--input",
            input.path().to_str().expect("path"),
            "--algo",
            "crc32",
        ],
        0,
    );
    assert!(
        !String::from_utf8_lossy(&stdout).trim().is_empty(),
        "--quiet must not hide checksum output"
    );
}

#[test]
fn trim_accepts_filter_like_its_siblings() {
    let temp = setup_temp_dir();
    let input = temp.child("game.gba");
    fs::write(input.path(), vec![0u8; 64]).expect("input fixture");

    // Both the new --filter and the retired --no-filter spelling parse.
    command_stdout(
        &[
            "trim",
            "--input",
            input.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--dry-run",
            "--json",
        ],
        0,
    );
    command_stdout(
        &[
            "trim",
            "--input",
            input.path().to_str().expect("path"),
            "--no-filter",
            "--dry-run",
            "--json",
        ],
        0,
    );
}

#[test]
fn checksum_rom_conflicts_with_checksum() {
    let temp = setup_temp_dir();
    let input = temp.child("game.zip");
    fs::write(input.path(), b"not really a zip").expect("input fixture");
    let out_dir = temp.child("out");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    let assert = command
        .args([
            "extract",
            "--input",
            input.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--checksum",
            "crc32",
            "--checksum-rom",
            "sha1",
        ])
        .assert()
        .code(2);
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr).into_owned();
    assert!(stderr.contains("cannot be used with"), "{stderr}");
}
