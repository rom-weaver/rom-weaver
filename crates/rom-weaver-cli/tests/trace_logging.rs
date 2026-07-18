use std::{fs, path::Path};

use assert_cmd::Command;
use assert_fs::{TempDir, fixture::PathChild};
use serde_json::Value;

fn parse_json_lines(output: &[u8]) -> Vec<Value> {
    let text = String::from_utf8(output.to_vec()).expect("utf8 output");
    text.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(serde_json::from_str(trimmed).expect("valid json line"))
            }
        })
        .collect()
}

fn write_fixture_file(temp: &TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let file = temp.child(name);
    fs::write(file.path(), bytes).expect("fixture");
    file.path().to_path_buf()
}

enum TraceMode {
    Flag,
    Env,
    Off,
}

fn run_checksum_json(source: &Path, trace_mode: TraceMode) -> std::process::Output {
    let source = source.to_str().expect("path");
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.env_remove("ROM_WEAVER_LOG").env_remove("RUST_LOG");
    if matches!(trace_mode, TraceMode::Env) {
        command.env("ROM_WEAVER_LOG", "rom_weaver_cli=trace");
    }

    let mut args = vec!["--json"];
    if matches!(trace_mode, TraceMode::Flag) {
        args.extend(["--log-level", "trace"]);
    }
    args.extend(["checksum", "--input", source, "--algo", "crc32", "--no-extract"]);

    command.args(args).assert().code(0).get_output().clone()
}

#[test]
fn json_trace_compress_logs_archive_write_bytes_to_stderr() {
    let temp = TempDir::new().expect("temp dir");
    let input_dir = temp.child("input");
    fs::create_dir_all(input_dir.path()).expect("input dir");
    fs::write(
        input_dir.child("file.bin").path(),
        vec![0_u8; 2 * 1024 * 1024],
    )
    .expect("fixture");
    let output_path = temp.child("out.zip");

    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command
        .env_remove("ROM_WEAVER_LOG")
        .env_remove("RUST_LOG")
        .args([
            "--json",
            "--log-level",
            "trace",
            "compress",
            "--input",
            input_dir.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            output_path.path().to_str().expect("path"),
        ]);
    let output = command.assert().code(0).get_output().clone();

    let stdout_events = parse_json_lines(&output.stdout);
    assert!(
        !stdout_events.iter().any(|event| {
            event["command"] == "compress"
                && event["status"] == "running"
                && event["stage"] == "write"
                && event["details"]["compressedBytesWritten"]
                    .as_u64()
                    .is_some()
        }),
        "expected archive write byte telemetry to stay out of stdout progress events"
    );

    let trace_events = parse_json_lines(&output.stderr);
    assert!(
        trace_events.iter().any(|event| {
            // The emitting code lives in the `libarchive_support` submodule, so its tracing target
            // is the full module path (`rom_weaver_containers::libarchive_support`). Match the crate
            // prefix rather than the bare crate name, which only held while the code was inlined in
            // the crate root.
            event["target"]
                .as_str()
                .is_some_and(|target| target.starts_with("rom_weaver_containers"))
                && event["fields"]["message"] == "wrote compressed archive bytes"
                && event["fields"]["command"] == "compress"
                && event["fields"]["format"] == "zip"
                && event["fields"]["stage"] == "write"
                && event["fields"]["compressed_bytes_written"]
                    .as_u64()
                    .map(|bytes| bytes > 0)
                    .unwrap_or(false)
        }),
        "expected compressed archive byte telemetry in stderr trace output"
    );
}

#[test]
fn json_log_level_trace_emits_trace_json_to_stderr() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"rom-weaver-trace-fixture");
    let output = run_checksum_json(&source, TraceMode::Flag);

    let stdout_events = parse_json_lines(&output.stdout);
    assert!(
        !stdout_events.is_empty(),
        "expected stdout json progress events"
    );
    assert!(
        stdout_events
            .iter()
            .any(|event| event["status"].as_str() == Some("succeeded")),
        "expected a succeeded terminal progress event"
    );

    let trace_events = parse_json_lines(&output.stderr);
    assert!(
        !trace_events.is_empty(),
        "expected stderr json trace events"
    );
    assert!(
        trace_events.iter().any(|event| event["target"]
            .as_str()
            .is_some_and(|target| target.starts_with("rom_weaver"))),
        "expected trace event target to include rom_weaver crate paths"
    );
}

#[test]
fn rom_weaver_log_env_enables_trace_without_explicit_log_level() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"rom-weaver-trace-env");
    let output = run_checksum_json(&source, TraceMode::Env);

    let stdout_events = parse_json_lines(&output.stdout);
    assert!(
        stdout_events
            .iter()
            .any(|event| event["status"].as_str() == Some("succeeded")),
        "expected a succeeded terminal progress event"
    );
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.trim().is_empty(),
        "expected stderr to remain empty without an explicit log level"
    );
}

#[test]
fn json_mode_without_trace_keeps_stderr_clean() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"rom-weaver-no-trace");
    let output = run_checksum_json(&source, TraceMode::Off);

    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(stderr.trim().is_empty(), "expected stderr to remain empty");
}
