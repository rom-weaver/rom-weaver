use assert_cmd::Command;
use assert_fs::{
    TempDir,
    fixture::{FileWriteStr, PathChild},
};
use serde_json::Value;

fn parse_single_json_line(output: &[u8]) -> Value {
    let text = String::from_utf8(output.to_vec()).expect("utf8 stdout");
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .expect("json line");
    serde_json::from_str(line).expect("valid json")
}

fn setup_temp_dir() -> TempDir {
    TempDir::new().expect("temp dir")
}

#[test]
fn inspect_reports_known_container_as_unsupported() {
    let temp = setup_temp_dir();
    temp.child("sample.zip")
        .write_str("placeholder")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("sample.zip").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "unsupported");
}

#[test]
fn extract_reports_thread_fallback_in_json() {
    let temp = setup_temp_dir();
    temp.child("sample.zip")
        .write_str("placeholder")
        .expect("fixture");
    let out_dir = temp.child("out");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            temp.child("sample.zip").path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["status"], "unsupported");
}

#[test]
fn checksum_reports_auto_thread_mode() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--threads",
            "auto",
            "--json",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["family"], "checksum");
    assert_eq!(json["format"], "native");
    assert_eq!(json["thread_mode"], "auto");
    assert!(
        json["requested_threads"]
            .as_u64()
            .expect("requested threads")
            >= 1
    );
    assert_eq!(json["status"], "unsupported");
}

#[test]
fn compress_routes_through_registered_container_format() {
    let temp = setup_temp_dir();
    temp.child("file.bin")
        .write_str("payload")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("file.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            temp.child("out.zip").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "compress");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "unsupported");
}

#[test]
fn patch_apply_routes_through_registered_patch_format() {
    let temp = setup_temp_dir();
    temp.child("input.bin").write_str("old").expect("fixture");
    temp.child("update.ips")
        .write_str("patch")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--output",
            temp.child("output.bin").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-apply");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["status"], "unsupported");
}

#[test]
fn patch_create_routes_through_registered_patch_format() {
    let temp = setup_temp_dir();
    temp.child("old.bin").write_str("old").expect("fixture");
    temp.child("new.bin").write_str("new").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "patch-create",
            "--original",
            temp.child("old.bin").path().to_str().expect("path"),
            "--modified",
            temp.child("new.bin").path().to_str().expect("path"),
            "--format",
            "ips",
            "--output",
            temp.child("output.ips").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "patch-create");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "IPS");
    assert_eq!(json["status"], "unsupported");
}

#[test]
fn inspect_reports_unknown_formats_cleanly() {
    let temp = setup_temp_dir();
    temp.child("unknown.bin")
        .write_str("payload")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "inspect",
            temp.child("unknown.bin").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "command");
    assert!(json["format"].is_null());
    assert_eq!(json["stage"], "probe");
    assert_eq!(json["status"], "failed");
}
