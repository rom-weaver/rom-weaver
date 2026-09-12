use std::fs;

use assert_cmd::Command;
use assert_fs::{TempDir, fixture::PathChild};

fn command() -> Command {
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command
        .env_remove("ROM_WEAVER_LOG")
        .env_remove("RUST_LOG")
        .env_remove("NO_COLOR")
        .env_remove("CLICOLOR_FORCE")
        .env("TERM", "xterm-256color");
    command
}

#[test]
fn redirected_checksum_contains_only_the_result() {
    let temp = TempDir::new().expect("temp dir");
    let source = temp.child("hello.bin");
    fs::write(source.path(), b"hello world").expect("fixture");

    for flags in [vec![], vec!["--quiet"], vec!["--no-progress"]] {
        let output = command()
            .arg("checksum")
            .arg(source.path())
            .args(["--algo", "crc32"])
            .args(flags)
            .assert()
            .success()
            .get_output()
            .clone();
        assert_eq!(output.stdout, b"CRC32  0d4a1185\n");
        assert!(output.stderr.is_empty(), "{output:?}");
    }
}

#[test]
fn quiet_suppresses_forced_human_progress() {
    let temp = TempDir::new().expect("temp dir");
    let source = temp.child("hello.bin");
    fs::write(source.path(), vec![42; 2 * 1024 * 1024]).expect("fixture");
    let output = command()
        .arg("checksum")
        .arg(source.path())
        .args(["--algo", "crc32", "--quiet", "--progress"])
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(!output.stdout.is_empty());
    assert!(output.stderr.is_empty(), "{output:?}");
}

#[test]
fn explicit_help_and_error_colors_work_before_dispatch() {
    for args in [
        vec!["--color", "--help"],
        vec!["checksum", "--color", "--help"],
        vec!["checksum", "--color", "--not-an-option"],
    ] {
        let output = command()
            .args(&args)
            .env("NO_COLOR", "1")
            .output()
            .expect("run CLI");
        assert!(
            output.stdout.contains(&0x1b) || output.stderr.contains(&0x1b),
            "{args:?}: {output:?}"
        );
    }
    for args in [
        vec!["--no-color", "--help"],
        vec!["checksum", "--no-color", "--help"],
        vec!["checksum", "--no-color", "--not-an-option"],
    ] {
        let output = command()
            .args(&args)
            .env("CLICOLOR_FORCE", "1")
            .output()
            .expect("run CLI");
        assert!(!output.stdout.contains(&0x1b), "{args:?}: {output:?}");
        assert!(!output.stderr.contains(&0x1b), "{args:?}: {output:?}");
    }
}

#[test]
fn quiet_man_install_writes_files_without_a_summary() {
    let temp = TempDir::new().expect("temp dir");
    let output = command()
        .args(["man", "checksum", "--install", "--quiet", "--man-dir"])
        .arg(temp.path())
        .assert()
        .success()
        .get_output()
        .clone();
    assert!(output.stdout.is_empty(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    assert!(temp.path().join("rom-weaver-checksum.1").is_file());
}

#[test]
fn native_command_diagnostics_keep_machine_output_intact() {
    let output = command()
        .args(["formats", "--verbose", "--json"])
        .assert()
        .success()
        .get_output()
        .clone();
    let formats: serde_json::Value = serde_json::from_slice(&output.stdout).expect("formats JSON");
    assert!(formats["containers"].is_array());
    let log: serde_json::Value = serde_json::from_slice(&output.stderr).expect("diagnostic JSON");
    assert_eq!(log["fields"]["command"], "formats");
}

#[test]
fn quiet_patch_plan_keeps_the_requested_format_candidates() {
    let temp = TempDir::new().expect("temp dir");
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    fs::write(original.path(), b"hello world").expect("fixture");
    fs::write(modified.path(), b"hello there").expect("fixture");
    let output = command()
        .args(["patch", "create", "--original"])
        .arg(original.path())
        .arg("--modified")
        .arg(modified.path())
        .args(["--plan", "--quiet"])
        .assert()
        .success()
        .get_output()
        .clone();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("bps"), "{stdout}");
    assert!(!stdout.contains("elapsed"), "{stdout}");
}

#[cfg(unix)]
#[test]
fn human_errors_escape_terminal_controls_from_paths() {
    let temp = TempDir::new().expect("temp dir");
    let missing = temp.child("missing\u{1b}[31m.bin");
    let output = command()
        .arg("checksum")
        .arg(missing.path())
        .arg("--no-color")
        .assert()
        .failure()
        .get_output()
        .clone();
    assert!(output.stdout.is_empty());
    assert!(!output.stderr.contains(&0x1b), "{output:?}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.starts_with("error:"), "{stderr}");
    assert!(stderr.contains("missing"), "{stderr}");
}

#[cfg(unix)]
#[test]
fn closed_stderr_preserves_operation_status_without_panicking() {
    use std::os::{fd::OwnedFd, unix::net::UnixStream};

    let temp = TempDir::new().expect("temp dir");
    let source = temp.child("hello.bin");
    fs::write(source.path(), b"hello world").expect("fixture");
    let source = source.path().to_str().expect("path");
    let missing = temp.child("missing.bin");
    let missing = missing.path().to_str().expect("path");
    for (args, code) in [
        (vec!["checksum", source, "--progress"], 0),
        (vec!["checksum", missing], 1),
        (vec!["checksum", missing, "--digest", "--algo", "crc32"], 1),
        (vec!["compress", source, "-o", "-"], 2),
        (vec!["man", "missing"], 2),
    ] {
        let (reader, writer) = UnixStream::pair().expect("stderr pair");
        drop(reader);
        let writer: OwnedFd = writer.into();
        let output = std::process::Command::new(assert_cmd::cargo::cargo_bin("rom-weaver"))
            .args(&args)
            .env_remove("ROM_WEAVER_LOG")
            .env_remove("RUST_LOG")
            .stderr(writer)
            .output()
            .expect("run command");
        assert_eq!(output.status.code(), Some(code), "{args:?}: {output:?}");
    }
}

#[cfg(unix)]
#[test]
fn filenames_cannot_inject_extra_summary_lines() {
    let temp = TempDir::new().expect("temp dir");
    let source = temp.child("hello.bin");
    let archive = temp.child("source\nFORGED SUCCESS.zip");
    let destination = temp.child("extracted");
    fs::write(source.path(), b"hello world").expect("fixture");
    command()
        .args(["compress", "--input"])
        .arg(source.path())
        .arg("--output")
        .arg(archive.path())
        .args(["--format", "zip", "--quiet"])
        .assert()
        .success();
    let output = command()
        .args(["extract", "--input"])
        .arg(archive.path())
        .arg("--output")
        .arg(destination.path())
        .assert()
        .success()
        .get_output()
        .clone();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("\nFORGED SUCCESS"), "{stdout}");
    assert!(stdout.contains("source\\nFORGED SUCCESS.zip"), "{stdout}");
    assert_eq!(
        fs::read(destination.path().join("hello.bin")).expect("extracted ROM"),
        b"hello world"
    );

    let output = command()
        .args(["man", "unknown\nFORGED ERROR"])
        .assert()
        .code(2)
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains("\nFORGED ERROR"), "{stderr}");
    assert!(stderr.contains("unknown\\nFORGED ERROR"), "{stderr}");
}
