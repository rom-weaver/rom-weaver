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
        command.env("ROM_WEAVER_LOG", "rom_weaver_app=trace");
    }

    let mut args = vec!["--json"];
    if matches!(trace_mode, TraceMode::Flag) {
        args.extend(["--log-level", "trace"]);
    }
    args.extend([
        "checksum",
        "--input",
        source,
        "--algo",
        "crc32",
        "--no-extract",
    ]);

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
            // Trace targets include the submodule path, so match the owning crate prefix.
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
    let stderr_events = parse_json_lines(&output.stderr);
    assert!(
        stderr_events.iter().any(|event| event["level"] == "TRACE"),
        "expected ROM_WEAVER_LOG to enable application trace events"
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

fn run_checksum_with_options(
    source: &Path,
    args: &[&str],
    env: &[(&str, &str)],
) -> std::process::Output {
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    command.env_remove("ROM_WEAVER_LOG").env_remove("RUST_LOG");
    command.envs(env.iter().copied());
    command.args(args).args([
        "checksum",
        "--input",
        source.to_str().expect("path"),
        "--algo",
        "crc32",
        "--no-extract",
    ]);
    command.assert().code(0).get_output().clone()
}

#[test]
fn verbose_reports_user_diagnostics_without_developer_trace() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"verbose diagnostics");
    let output = run_checksum_with_options(&source, &["--verbose", "--json"], &[]);
    let stdout = parse_json_lines(&output.stdout);
    assert!(stdout.iter().any(|event| event["status"] == "succeeded"));
    let diagnostics = parse_json_lines(&output.stderr);
    assert!(diagnostics.iter().all(|event| event["level"] == "INFO"));
    assert!(diagnostics.iter().any(|event| {
        event["fields"]["message"] == "starting command"
            && event["fields"]["command"] == "checksum"
            && event["fields"]["version"] == env!("CARGO_PKG_VERSION")
    }));
    assert!(diagnostics.iter().any(|event| {
        event["fields"]["option"] == "input"
            && event["fields"]["value"]
                .as_str()
                .is_some_and(|value| value.contains(source.to_str().expect("path")))
    }));
    assert!(diagnostics.iter().any(|event| {
        event["fields"]["message"] == "completed operation"
            && event["fields"]["status"] == "Succeeded"
            && event["fields"]["elapsed_ms"].as_u64().is_some()
    }));
    assert!(
        !diagnostics
            .iter()
            .any(|event| { event["fields"]["message"] == "running rom-weaver command" })
    );
}

#[test]
fn debug_reports_developer_configuration_and_trace_on_stderr() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"developer diagnostics");
    let output = run_checksum_with_options(&source, &["--debug", "--json"], &[]);
    let stdout = parse_json_lines(&output.stdout);
    assert!(stdout.iter().any(|event| event["status"] == "succeeded"));
    let diagnostics = parse_json_lines(&output.stderr);
    assert!(diagnostics.iter().any(|event| event["level"] == "TRACE"));
    assert!(diagnostics.iter().any(|event| {
        event["level"] == "DEBUG"
            && event["fields"]["message"] == "running rom-weaver command"
            && event["fields"]["command"]
                .as_str()
                .is_some_and(|value| value.contains("Checksum") && value.contains("input.bin"))
    }));
}

#[test]
fn verbose_plain_stderr_is_readable_without_terminal_controls() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"plain verbose diagnostics");
    let output = run_checksum_with_options(&source, &["--verbose"], &[]);
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(stderr.contains("INFO starting command"));
    assert!(stderr.contains("completed operation"));
    assert!(!stderr.contains("rom_weaver_app::"));
    assert!(!stderr.contains('\x1b'));
    assert!(!stderr.contains('\r'));
}

#[test]
fn quiet_overrides_environment_logging_without_warning_noise() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"quiet diagnostics");
    let output = run_checksum_with_options(
        &source,
        &["--quiet", "--json"],
        &[("ROM_WEAVER_LOG", "rom_weaver_app=trace")],
    );
    assert!(output.stderr.is_empty());
    assert!(
        parse_json_lines(&output.stdout)
            .iter()
            .any(|event| event["status"] == "succeeded")
    );
}

#[test]
fn invalid_environment_filter_keeps_json_diagnostics_parseable() {
    let temp = TempDir::new().expect("temp dir");
    let source = write_fixture_file(&temp, "input.bin", b"invalid filter diagnostics");
    let output = run_checksum_with_options(
        &source,
        &["--json"],
        &[("ROM_WEAVER_LOG", "rom_weaver_app=invalid")],
    );
    let diagnostics = parse_json_lines(&output.stderr);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0]["level"], "WARN");
    assert!(
        diagnostics[0]["fields"]["message"]
            .as_str()
            .expect("warning message")
            .contains("invalid log filter")
    );
}
