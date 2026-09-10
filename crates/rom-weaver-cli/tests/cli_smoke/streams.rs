use super::shared::*;
use std::{
    io::Write,
    process::{Command as ProcessCommand, Stdio},
    thread,
    time::{Duration, Instant},
};

fn binary() -> ProcessCommand {
    let mut command = ProcessCommand::new(assert_cmd::cargo::cargo_bin!("rom-weaver"));
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

fn compress_stdin_to_file(temp: &TempDir, format: &str, name: &str, bytes: &[u8]) -> PathBuf {
    let archive = temp.child(format!("archive.{format}"));
    let output = binary()
        .args([
            "compress",
            "--input",
            "-",
            "--stdin-name",
            name,
            "--format",
            format,
            "--output",
            archive.path().to_str().expect("archive path"),
        ])
        .stdin(Stdio::piped())
        .output_with_stdin(bytes);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    archive.path().to_path_buf()
}

trait OutputWithStdin {
    fn output_with_stdin(self, stdin: &[u8]) -> std::process::Output;
}

impl OutputWithStdin for &mut ProcessCommand {
    fn output_with_stdin(self, stdin: &[u8]) -> std::process::Output {
        let mut child = self.spawn().expect("start CLI");
        child
            .stdin
            .take()
            .expect("child stdin")
            .write_all(stdin)
            .expect("write child stdin");
        child.wait_with_output().expect("wait for CLI")
    }
}

#[test]
fn streams_round_trip_zip_gzip_and_7z_bytes() {
    let temp = setup_temp_dir();
    let payload = (0..32_768)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();

    let gzip = temp.child("payload.bin.gz");
    let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
    encoder.write_all(&payload).unwrap();
    fs::write(gzip.path(), encoder.finish().unwrap()).unwrap();
    assert_eq!(
        command_stdout(&["extract", gzip.path().to_str().unwrap(), "-o", "-"], 0),
        payload
    );

    for format in ["zip", "7z"] {
        let archive = compress_stdin_to_file(&temp, format, "payload.bin", &payload);
        let output = command_stdout(
            &[
                "extract",
                "--input",
                archive.to_str().expect("archive path"),
                "--output",
                "-",
            ],
            0,
        );
        assert_eq!(output, payload, "{format} stream round trip");
    }
}

#[test]
fn compress_stdin_name_is_the_archive_entry_name() {
    let temp = setup_temp_dir();
    let archive = compress_stdin_to_file(&temp, "zip", "game name.nes", b"named payload");
    let output_dir = temp.child("output");

    command_stdout(
        &[
            "extract",
            "--input",
            archive.to_str().expect("archive path"),
            "--output",
            output_dir.path().to_str().expect("output path"),
        ],
        0,
    );

    assert_eq!(
        fs::read(output_dir.child("game name.nes").path()).expect("named output"),
        b"named payload"
    );
}

#[test]
fn compress_can_mix_one_stdin_input_with_disk_inputs() {
    let temp = setup_temp_dir();
    let disk_input = temp.child("disk.bin");
    let archive = temp.child("mixed.zip");
    let output_dir = temp.child("output");
    fs::write(disk_input.path(), b"disk payload").expect("fixture");
    let output = binary()
        .args([
            "compress",
            "--input",
            "-",
            "--stdin-name",
            "stream.bin",
            "--input",
            disk_input.path().to_str().expect("disk path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("archive path"),
        ])
        .stdin(Stdio::piped())
        .output_with_stdin(b"stream payload");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("archive path"),
            "--output",
            output_dir.path().to_str().expect("output path"),
            "--no-nested-extract",
        ],
        0,
    );
    assert_eq!(
        fs::read(output_dir.child("stream.bin").path()).expect("stdin output"),
        b"stream payload"
    );
    assert_eq!(
        fs::read(output_dir.child("disk.bin").path()).expect("disk output"),
        b"disk payload"
    );
}

#[test]
fn extract_stdin_detects_archive_magic() {
    let temp = setup_temp_dir();
    let source = temp.child("source.bin");
    let archive = temp.child("source.zip");
    fs::write(source.path(), b"magic payload").expect("fixture");
    command_stdout(
        &[
            "compress",
            "--input",
            source.path().to_str().expect("source path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("archive path"),
        ],
        0,
    );

    let archive_bytes = fs::read(archive.path()).expect("archive bytes");
    let output = binary()
        .args(["extract", "--input", "-", "--output", "-"])
        .stdin(Stdio::piped())
        .output_with_stdin(&archive_bytes);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"magic payload");
}

#[test]
fn extract_stdout_requires_one_leaf_and_select_can_narrow_it() {
    let temp = setup_temp_dir();
    let first = temp.child("first.bin");
    let second = temp.child("second.bin");
    let archive = temp.child("two.zip");
    fs::write(first.path(), b"first").expect("first fixture");
    fs::write(second.path(), b"second").expect("second fixture");
    command_stdout(
        &[
            "compress",
            "--input",
            first.path().to_str().expect("first path"),
            "--input",
            second.path().to_str().expect("second path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("archive path"),
        ],
        0,
    );

    let ambiguous = binary()
        .args([
            "extract",
            "--input",
            archive.path().to_str().expect("archive path"),
            "--output",
            "-",
        ])
        .output()
        .expect("run ambiguous extract");
    assert!(!ambiguous.status.success());
    assert!(
        ambiguous.stdout.is_empty(),
        "ambiguous extraction wrote stdout"
    );

    let selected = command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("archive path"),
            "--select",
            "second.bin",
            "--output",
            "-",
        ],
        0,
    );
    assert_eq!(selected, b"second");
}

#[test]
fn extract_stdout_uses_nested_final_leaf_not_intermediate_archive() {
    let temp = setup_temp_dir();
    let source = temp.child("payload.bin");
    let inner = temp.child("inner.zip");
    let outer = temp.child("outer.zip");
    fs::write(source.path(), b"nested payload").expect("fixture");
    command_stdout(
        &[
            "compress",
            "--input",
            source.path().to_str().expect("source path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("inner path"),
        ],
        0,
    );
    command_stdout(
        &[
            "compress",
            "--input",
            inner.path().to_str().expect("inner path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("outer path"),
        ],
        0,
    );

    let output = command_stdout(
        &[
            "extract",
            "--input",
            outer.path().to_str().expect("outer path"),
            "--output",
            "-",
        ],
        0,
    );
    assert_eq!(output, b"nested payload");
}

#[test]
fn binary_stdout_rejects_json_and_dry_run_before_or_after_command() {
    let temp = setup_temp_dir();
    let input = temp.child("source.bin");
    let archive = temp.child("source.zip");
    fs::write(input.path(), b"payload").expect("fixture");
    let input = input.path().to_str().expect("input path");
    command_stdout(
        &[
            "compress",
            "--input",
            input,
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("archive path"),
        ],
        0,
    );
    let archive = archive.path().to_str().expect("archive path");

    for args in [
        vec!["compress", "-", "-o", "-"],
        vec!["compress", "-", "-i", "-", "-f", "zip", "-o", "-"],
        vec![
            "--json", "compress", "--input", input, "--format", "zip", "--output", "-",
        ],
        vec![
            "compress", "--input", input, "--format", "zip", "--output", "-", "--json",
        ],
        vec![
            "--dry-run",
            "compress",
            "--input",
            input,
            "--format",
            "zip",
            "--output",
            "-",
        ],
        vec![
            "compress",
            "--input",
            input,
            "--format",
            "zip",
            "--output",
            "-",
            "--dry-run",
        ],
        vec!["--json", "extract", "--input", archive, "--output", "-"],
        vec!["extract", "--input", archive, "--output", "-", "--json"],
        vec!["--dry-run", "extract", "--input", archive, "--output", "-"],
        vec!["extract", "--input", archive, "--output", "-", "--dry-run"],
    ] {
        let output = binary()
            .current_dir(temp.path())
            .args(args)
            .output()
            .expect("run invalid stream command");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty(), "invalid command wrote stdout");
        assert!(
            !temp.child("-").path().exists(),
            "created a literal dash file"
        );
    }
}

#[test]
fn invalid_stdin_configuration_exits_without_reading_stdin() {
    let temp = setup_temp_dir();
    for args in [
        vec![
            "compress", "--input", "-", "--format", "zip", "--output", "-", "--json",
        ],
        vec![
            "compress",
            "--input",
            "-",
            "--format",
            "zip",
            "--output",
            "out.zip",
            "--dry-run",
        ],
    ] {
        let mut child = binary()
            .current_dir(temp.path())
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start invalid stream command");
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().expect("poll child").is_none() {
            if Instant::now() >= deadline {
                child.kill().expect("stop stdin reader");
                child.wait().expect("reap stdin reader");
                panic!("invalid stream configuration read stdin before rejecting it");
            }
            thread::sleep(Duration::from_millis(20));
        }
        let output = child.wait_with_output().expect("collect child output");
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[cfg(target_os = "linux")]
#[test]
fn stream_staging_is_removed_after_input_and_stdout_io_errors() {
    let temp = setup_temp_dir();
    let staging = temp.child("staging");
    fs::create_dir(staging.path()).unwrap();
    let mut command = binary();
    command
        .args(["compress", "-", "-f", "zip", "-o", "-"])
        .env("TMPDIR", staging.path())
        .stdin(File::open(temp.path()).unwrap());
    let output = command.output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(fs::read_dir(staging.path()).unwrap().next().is_none());

    let input = temp.child("input.bin");
    fs::write(input.path(), b"stdout failure fixture").unwrap();
    let output = binary()
        .args([
            "compress",
            input.path().to_str().unwrap(),
            "-f",
            "zip",
            "-o",
            "-",
        ])
        .env("TMPDIR", staging.path())
        .stdout(File::options().write(true).open("/dev/full").unwrap())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(!output.stderr.is_empty());
    assert!(fs::read_dir(staging.path()).unwrap().next().is_none());
}

#[test]
fn stdin_name_rejects_non_basename_values_and_requires_stdin() {
    let temp = setup_temp_dir();
    for name in [
        "/absolute.bin",
        "nested/file.bin",
        "nested\\file.bin",
        "C:file.bin",
        ".",
        "..",
    ] {
        let output = binary()
            .args([
                "compress",
                "--input",
                "-",
                "--stdin-name",
                name,
                "--format",
                "zip",
                "--output",
                temp.child("out.zip").path().to_str().expect("output path"),
            ])
            .stdin(Stdio::piped())
            .output()
            .expect("run invalid stdin name");
        assert_eq!(output.status.code(), Some(2), "{name}");
    }
    let input = temp.child("input.bin");
    fs::write(input.path(), b"payload").expect("fixture");
    let output = binary()
        .args([
            "compress",
            "--input",
            input.path().to_str().expect("input path"),
            "--stdin-name",
            "payload.bin",
            "--format",
            "zip",
            "--output",
            temp.child("out.zip").path().to_str().expect("output path"),
        ])
        .output()
        .expect("run unnecessary stdin name");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn stdin_spool_is_cleaned_from_configured_temp_root() {
    let temp = setup_temp_dir();
    let staging_root = temp.child("staging");
    fs::create_dir_all(staging_root.path()).expect("staging root");
    let archive = temp.child("archive.zip");
    let output = binary()
        .args([
            "compress",
            "--input",
            "-",
            "--stdin-name",
            "payload.bin",
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("archive path"),
        ])
        .env("TMPDIR", staging_root.path())
        .env("TEMP", staging_root.path())
        .env("TMP", staging_root.path())
        .stdin(Stdio::piped())
        .output_with_stdin(b"staged input");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        fs::read_dir(staging_root.path())
            .expect("read staging root")
            .next()
            .is_none(),
        "stdin spool was not cleaned up"
    );
}

#[test]
fn stream_pipeline_extracts_compresses_and_checksums() {
    let temp = setup_temp_dir();
    let source = temp.child("payload.bin");
    let archive = temp.child("payload.zip");
    let expected = temp.child("expected.7z");
    let payload = b"pipeline payload that must survive every stream stage";
    fs::write(source.path(), payload).expect("fixture");
    command_stdout(
        &[
            "compress",
            "--input",
            source.path().to_str().unwrap(),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().unwrap(),
        ],
        0,
    );
    command_stdout(
        &[
            "compress",
            "--input",
            source.path().to_str().unwrap(),
            "--format",
            "7z",
            "--output",
            expected.path().to_str().unwrap(),
        ],
        0,
    );
    let expected_checksum = command_stdout(
        &[
            "checksum",
            "--input",
            expected.path().to_str().unwrap(),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

    let mut extract = binary()
        .args([
            "extract",
            "--input",
            archive.path().to_str().unwrap(),
            "--output",
            "-",
        ])
        .stdout(Stdio::piped())
        .spawn()
        .expect("start extract");
    let mut compress = binary()
        .args([
            "compress",
            "--input",
            "-",
            "--stdin-name",
            "payload.bin",
            "--format",
            "7z",
            "--output",
            "-",
        ])
        .stdin(Stdio::from(extract.stdout.take().expect("extract stdout")))
        .stdout(Stdio::piped())
        .spawn()
        .expect("start compress");
    let checksum = binary()
        .args(["checksum", "--input", "-", "--algo", "sha1", "--json"])
        .stdin(Stdio::from(
            compress.stdout.take().expect("compress stdout"),
        ))
        .output()
        .expect("run checksum");
    assert!(extract.wait().expect("wait extract").success());
    assert!(compress.wait().expect("wait compress").success());
    assert!(
        checksum.status.success(),
        "{}",
        String::from_utf8_lossy(&checksum.stderr)
    );
    assert_eq!(
        parse_single_json_line(&checksum.stdout)["details"]["checksums"],
        parse_single_json_line(&expected_checksum)["details"]["checksums"]
    );
}

#[test]
fn stream_output_stays_empty_when_a_disk_input_fails() {
    let temp = setup_temp_dir();
    let existing = temp.child("existing.bin");
    fs::write(existing.path(), b"existing").expect("fixture");
    let missing = temp.child("missing.bin");
    let output = binary()
        .args([
            "compress",
            "--input",
            existing.path().to_str().expect("existing path"),
            "--input",
            missing.path().to_str().expect("missing path"),
            "--format",
            "zip",
            "--output",
            "-",
        ])
        .output()
        .expect("run failed stream compress");
    assert!(!output.status.success());
    assert!(
        output.stdout.is_empty(),
        "failed compression leaked partial stdout"
    );
}

#[test]
fn broken_stdout_pipe_ends_cleanly_after_staged_work() {
    let temp = setup_temp_dir();
    let source = temp.child("large.bin");
    let bytes = (0..1_048_576)
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(source.path(), bytes).expect("fixture");
    let mut child = binary()
        .args([
            "compress",
            "--input",
            source.path().to_str().expect("source path"),
            "--format",
            "zip",
            "--output",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start stream compression");
    drop(child.stdout.take());
    let output = child.wait_with_output().expect("wait for broken pipe");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty(), "broken pipe emitted an error");
}

#[test]
fn patch_streams_match_file_output_and_preserve_sources() {
    let temp = setup_temp_dir();
    let original = temp.child("original.gba");
    let modified = temp.child("modified.gba");
    let patch = temp.child("change.bps");
    let source = build_test_gba_rom(0x4000);
    let mut target = source.clone();
    target[0x200] ^= 0xff;
    fs::write(original.path(), &source).unwrap();
    fs::write(modified.path(), &target).unwrap();
    let create = [
        "patch",
        "create",
        "--original",
        original.path().to_str().unwrap(),
        "--modified",
        modified.path().to_str().unwrap(),
        "--format",
        "bps",
    ];
    let mut file_args = create.to_vec();
    file_args.extend(["-o", patch.path().to_str().unwrap()]);
    command_stdout(&file_args, 0);
    let mut stream_args = create.to_vec();
    stream_args.extend(["-o", "-", "--progress", "--verbose"]);
    assert_eq!(
        command_stdout(&stream_args, 0),
        fs::read(patch.path()).unwrap()
    );

    for prefix in [
        vec!["patch", "apply"],
        vec!["weave"],
        vec!["patch", "weave"],
    ] {
        let mut args = prefix;
        args.extend([
            "--input",
            original.path().to_str().unwrap(),
            "--patch",
            patch.path().to_str().unwrap(),
            "--no-compress",
            "-o",
            "-",
            "--progress",
            "--verbose",
        ]);
        assert_eq!(command_stdout(&args, 0), target);
    }
    let archive = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            original.path().to_str().unwrap(),
            "--patch",
            patch.path().to_str().unwrap(),
            "--compress-format",
            "zip",
            "-o",
            "-",
        ],
        0,
    );
    let compressed = temp.child("patched.zip");
    fs::write(compressed.path(), archive).unwrap();
    assert_eq!(
        command_stdout(
            &["extract", compressed.path().to_str().unwrap(), "-o", "-"],
            0
        ),
        target
    );
    assert_eq!(fs::read(original.path()).unwrap(), source);
    assert_eq!(fs::read(modified.path()).unwrap(), target);
}

#[test]
fn binary_patch_output_rejects_ambiguous_formats_and_side_effects() {
    let temp = setup_temp_dir();
    for args in [
        vec!["patch", "create", "--original", "missing", "-o", "-"],
        vec![
            "patch",
            "create",
            "--original",
            "missing",
            "-f",
            "bps",
            "-o",
            "-",
            "--plan",
        ],
        vec![
            "patch",
            "create",
            "--original",
            "missing",
            "-f",
            "bps",
            "-o",
            "-",
            "--checksum-name",
        ],
        vec!["patch", "apply", "--input", "missing", "-o", "-"],
        vec![
            "patch",
            "apply",
            "--input",
            "missing",
            "-o",
            "-",
            "--no-compress",
            "--emit-bundle",
            "bundle.json",
        ],
        vec![
            "weave",
            "--input",
            "missing",
            "-o",
            "-",
            "--no-compress",
            "--tui",
        ],
        vec![
            "patch",
            "apply",
            "--input",
            "missing",
            "-o",
            "-",
            "--no-compress",
            "--json",
        ],
        vec![
            "patch",
            "apply",
            "--input",
            "missing",
            "-o",
            "-",
            "--no-compress",
            "--dry-run",
        ],
    ] {
        let output = binary()
            .current_dir(temp.path())
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(2),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty(), "{args:?}");
        assert!(!output.stderr.is_empty());
    }
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn trim_stdout_matches_file_output_and_leaves_source_unchanged() {
    let temp = setup_temp_dir();
    let input = temp.child("input.gba");
    let output = temp.child("trimmed.gba");
    let mut source = build_test_gba_rom(0x3456);
    source.resize(0x8000, 0xff);
    fs::write(input.path(), &source).unwrap();
    command_stdout(
        &[
            "trim",
            input.path().to_str().unwrap(),
            "-o",
            output.path().to_str().unwrap(),
        ],
        0,
    );
    let trimmed = fs::read(output.path()).unwrap();
    assert!(trimmed.len() < source.len());
    assert_eq!(
        command_stdout(&["trim", input.path().to_str().unwrap(), "-o", "-"], 0),
        trimmed
    );
    assert_eq!(
        command_stdout(&["trim", output.path().to_str().unwrap(), "-o", "-"], 0),
        trimmed
    );
    assert_eq!(fs::read(input.path()).unwrap(), source);
}

#[test]
fn failed_patch_stream_leaves_stdout_empty_and_removes_staging() {
    let temp = setup_temp_dir();
    let staging = temp.child("staging");
    fs::create_dir(staging.path()).unwrap();
    let output = binary()
        .args([
            "patch",
            "create",
            "--original",
            "missing",
            "--modified",
            "missing-too",
            "-f",
            "bps",
            "-o",
            "-",
        ])
        .env("TMPDIR", staging.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
}

#[test]
fn trim_stdout_rejects_multiple_results_without_changing_inputs() {
    let temp = setup_temp_dir();
    let first = temp.child("first.gba");
    let second = temp.child("second.gba");
    let bytes = build_test_gba_rom(0x4000);
    fs::write(first.path(), &bytes).unwrap();
    fs::write(second.path(), &bytes).unwrap();
    let output = binary()
        .args([
            "trim",
            first.path().to_str().unwrap(),
            second.path().to_str().unwrap(),
            "-o",
            "-",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(fs::read(first.path()).unwrap(), bytes);
    assert_eq!(fs::read(second.path()).unwrap(), bytes);
}
