use std::fs;

use assert_cmd::Command;
use assert_fs::{TempDir, fixture::PathChild};
use serde_json::Value;

fn command() -> Command {
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command
        .env_remove("ROM_WEAVER_LOG")
        .env_remove("RUST_LOG")
        .env_remove("CLICOLOR_FORCE")
        .env("TERM", "dumb");
    command
}

#[test]
fn json_is_one_complete_document_with_optional_stderr_progress() {
    let temp = TempDir::new().expect("temp directory");
    let input = temp.child("game.bin");
    fs::write(input.path(), b"hello world").expect("fixture");
    for flags in [vec![], vec!["--progress"], vec!["--progress", "--quiet"]] {
        let output = command()
            .arg("checksum")
            .arg(input.path())
            .args(["-a", "crc32", "--json"])
            .args(&flags)
            .assert()
            .success()
            .get_output()
            .clone();
        let report: Value = serde_json::from_slice(&output.stdout).expect("one JSON document");
        assert_eq!(report["details"]["checksums"]["crc32"], "0d4a1185");
        assert_eq!(report["details"]["size"], 11);
        assert!(report["details"]["checksum_variants"].is_array());
        assert_eq!(report["status"], "succeeded");
        assert_eq!(report["exit_code"], 0);
        assert_eq!(report["schema_version"], 1);
        if flags == ["--progress"] {
            let events: Vec<Value> = String::from_utf8_lossy(&output.stderr)
                .lines()
                .map(|line| serde_json::from_str(line).expect("JSON progress"))
                .collect();
            assert!(!events.is_empty());
            assert!(events.iter().all(|event| event["status"] == "running"));
            assert!(!output.stderr.contains(&0x1b));
            assert!(!output.stderr.contains(&b'\r'));
        } else {
            assert!(output.stderr.is_empty(), "{output:?}");
        }
    }
}

#[test]
fn jsonl_keeps_the_explicit_event_stream() {
    let temp = TempDir::new().expect("temp directory");
    let input = temp.child("game.bin");
    fs::write(input.path(), b"hello world").expect("fixture");
    let output = command()
        .arg("checksum")
        .arg(input.path())
        .args(["-a", "crc32", "--jsonl"])
        .assert()
        .success()
        .get_output()
        .clone();
    let events: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).expect("JSON event"))
        .collect();
    assert!(events.iter().any(|event| event["status"] == "running"));
    assert_eq!(events.last().expect("result")["status"], "succeeded");
    assert!(output.stderr.is_empty());
}

#[test]
fn every_native_error_path_honors_json() {
    for args in [
        vec!["--json", "checksum", "--bad-option"],
        vec!["checksum", "--bad-option", "--json"],
        vec!["man", "missing", "--json"],
        vec!["compress", "missing.bin", "-o", "-", "--json"],
        vec![
            "compress",
            "-",
            "-o",
            "out.zip",
            "--stdin-name",
            "../bad",
            "--json",
        ],
        vec!["checksum", "-", "--digest", "--jsonl"],
        vec!["--json", "--jsonl", "formats"],
    ] {
        let output = command().args(&args).assert().code(2).get_output().clone();
        let report: Value = serde_json::from_slice(&output.stdout).expect("JSON usage error");
        assert_eq!(report["status"], "failed", "{args:?}: {report}");
        let error = report
            .get("error")
            .or_else(|| report["details"].get("error"))
            .expect("error");
        assert!(error["code"].is_string());
        assert_eq!(error["exit_code"], 2);
        assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
    }
}

#[test]
fn missing_file_has_a_structured_failure_without_progress() {
    let temp = TempDir::new().expect("temp directory");
    let output = command()
        .arg("checksum")
        .arg(temp.child("missing.bin").path())
        .arg("--json")
        .assert()
        .code(1)
        .get_output()
        .clone();
    let report: Value = serde_json::from_slice(&output.stdout).expect("JSON failure");
    assert_eq!(report["status"], "failed");
    assert_eq!(report["exit_code"], 1);
    assert!(
        report["error"]["message"]
            .as_str()
            .expect("message")
            .contains("missing.bin")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn generated_assets_and_early_exits_honor_json() {
    for (args, field) in [
        (vec!["completions", "bash", "--json"], "content"),
        (vec!["man", "checksum", "--json"], "content"),
        (vec!["bundle", "schema", "--json"], "schema"),
        (vec!["--json", "--help"], "content"),
        (vec!["checksum", "--help", "--json"], "content"),
        (vec!["--json", "--version"], "version"),
    ] {
        let output = command()
            .args(&args)
            .assert()
            .success()
            .get_output()
            .clone();
        let report: Value = serde_json::from_slice(&output.stdout).expect("JSON asset");
        assert!(!report["details"][field].is_null(), "{args:?}: {report}");
        assert_eq!(report["exit_code"], 0);
        assert!(output.stderr.is_empty());
    }
}
