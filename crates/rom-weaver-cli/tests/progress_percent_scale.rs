use std::fs;

use assert_cmd::Command;
use assert_fs::{TempDir, fixture::PathChild};
use serde_json::Value;

fn setup_temp_dir() -> TempDir {
    TempDir::new().expect("temp dir")
}

fn parse_terminal_json(output: &[u8]) -> Value {
    let text = String::from_utf8(output.to_vec()).expect("utf8 stdout");
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .expect("json line");
    serde_json::from_str(line).expect("valid json")
}

#[test]
fn patch_create_and_apply_report_percent_100() {
    let temp = setup_temp_dir();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("update.ips");
    let applied = temp.child("applied.bin");

    fs::write(original.path(), b"abcdefgh").expect("fixture");
    fs::write(modified.path(), b"a1XYZf!!!").expect("fixture");

    let patch_create_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let patch_create_terminal = parse_terminal_json(&patch_create_output);
    assert_eq!(patch_create_terminal["command"], "patch-create");
    assert_eq!(patch_create_terminal["status"], "succeeded");
    assert_eq!(patch_create_terminal["percent"], 100.0);

    let patch_apply_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            original.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "--output",
            applied.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let patch_apply_terminal = parse_terminal_json(&patch_apply_output);
    assert_eq!(patch_apply_terminal["command"], "patch-apply");
    assert_eq!(patch_apply_terminal["status"], "succeeded");
    assert_eq!(patch_apply_terminal["percent"], 100.0);
}
