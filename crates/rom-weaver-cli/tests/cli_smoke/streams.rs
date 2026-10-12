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

#[cfg(unix)]
#[test]
fn stdin_read_failures_preserve_context_and_io_kind() {
    let temp = setup_temp_dir();
    for command in ["probe", "checksum"] {
        let output = binary()
            .args([command, "--input", "-", "--json"])
            .stdin(File::open(temp.path()).expect("open directory as unreadable stdin"))
            .output()
            .expect("run CLI with unreadable stdin");
        assert_eq!(output.status.code(), Some(1));
        let report: serde_json::Value =
            serde_json::from_slice(&output.stdout).expect("JSON failure report");
        assert_eq!(report["error_kind"], "io", "{report}");
        assert!(
            report["label"]
                .as_str()
                .expect("failure label")
                .starts_with("failed to read stdin input: i/o error:"),
            "{report}"
        );
    }
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
fn corrupt_archive_stdout_is_empty_and_staging_is_clean_before_retry() {
    let temp = setup_temp_dir();
    let payload = pseudo_random_bytes(32_768, 0xface);
    let staging = temp.child("staging");
    fs::create_dir(staging.path()).unwrap();
    let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
    encoder.write_all(&payload).unwrap();
    let gzip = encoder.finish().unwrap();
    for format in ["gz", "zip", "7z"] {
        let valid = if format == "gz" {
            gzip.clone()
        } else {
            fs::read(compress_stdin_to_file(
                &temp,
                format,
                "payload.bin",
                &payload,
            ))
            .unwrap()
        };
        let mut corrupt = valid.clone();
        if format == "gz" {
            let crc_offset = corrupt.len() - 8;
            corrupt[crc_offset] ^= 1;
        } else {
            corrupt.truncate(10);
        }
        let source = temp.child(format!("damaged.{format}"));
        fs::write(source.path(), &corrupt).unwrap();
        let output = binary()
            .args(["extract", source.to_str().unwrap(), "--output", "-"])
            .env("TMPDIR", staging.path())
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(1),
            "{format}: stdout bytes={}, stderr={}",
            output.stdout.len(),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty(), "{format}: partial binary output");
        assert_eq!(fs::read(source.path()).unwrap(), corrupt);
        assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
        fs::write(source.path(), &valid).unwrap();
        let retried = binary()
            .args(["extract", source.to_str().unwrap(), "--output", "-"])
            .env("TMPDIR", staging.path())
            .output()
            .unwrap();
        assert!(
            retried.status.success(),
            "{format}: {}",
            String::from_utf8_lossy(&retried.stderr)
        );
        assert_eq!(retried.stdout, payload, "{format}: retry byte integrity");
        assert_eq!(fs::read(source.path()).unwrap(), valid);
        assert_eq!(fs::read_dir(staging.path()).unwrap().count(), 0);
    }
}

#[test]
fn gzip_concatenated_members_validate_each_crc_and_size() {
    let temp = setup_temp_dir();
    let first = pseudo_random_bytes(131_073, 0x1234);
    let second = pseudo_random_bytes(65_537, 0x5678);
    let encode = |bytes: &[u8]| {
        let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    };
    let first_member = encode(&first);
    let mut valid = first_member.clone();
    valid.extend(encode(&[]));
    valid.extend(encode(&second));
    let source = temp.child("members.bin.gz");
    let expected = [first, second].concat();
    fs::write(source.path(), &valid).unwrap();
    let output = command_stdout(&["extract", source.to_str().unwrap(), "--output", "-"], 0);
    assert_eq!(output, expected);
    for (offset, label) in [
        (first_member.len() - 8, "gzip CRC32 mismatch"),
        (first_member.len() - 4, "gzip uncompressed size mismatch"),
        (valid.len() - 8, "gzip CRC32 mismatch"),
        (valid.len() - 4, "gzip uncompressed size mismatch"),
    ] {
        let mut damaged = valid.clone();
        damaged[offset] ^= 1;
        fs::write(source.path(), &damaged).unwrap();
        let result = command_output_with_env(
            &["extract", source.to_str().unwrap(), "--output", "-"],
            &[],
            1,
        );
        assert!(result.stdout.is_empty());
        assert!(String::from_utf8_lossy(&result.stderr).contains(label));
        assert_eq!(fs::read(source.path()).unwrap(), damaged);
    }
    fs::write(source.path(), &valid).unwrap();
    assert_eq!(
        command_stdout(&["extract", source.to_str().unwrap(), "--output", "-"], 0),
        expected
    );
    assert_eq!(fs::read(source.path()).unwrap(), valid);
}

#[test]
fn gzip_filtered_tar_rejects_corrupt_trailers_without_binary_output() {
    let temp = setup_temp_dir();
    let payload = pseudo_random_bytes(131_073, 0xabc);
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(payload.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "payload.bin", payload.as_slice())
        .unwrap();
    let tar_bytes = tar.into_inner().unwrap();
    let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
    encoder.write_all(&tar_bytes).unwrap();
    let valid = encoder.finish().unwrap();
    let archive = temp.child("filtered.tar.gz");
    for offset in [valid.len() - 8, valid.len() - 4] {
        let mut corrupt = valid.clone();
        corrupt[offset] ^= 1;
        fs::write(archive.path(), &corrupt).unwrap();
        let output = command_output_with_env(
            &["extract", archive.to_str().unwrap(), "--output", "-"],
            &[],
            1,
        );
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains("tar.gz list failed"),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fs::read(archive.path()).unwrap(), corrupt);
    }
    fs::write(archive.path(), &valid).unwrap();
    assert_eq!(
        command_stdout(&["extract", archive.to_str().unwrap(), "--output", "-"], 0),
        payload
    );
    assert_eq!(fs::read(archive.path()).unwrap(), valid);
}

#[test]
fn padded_gzip_tar_validates_unread_members_before_emitting_output() {
    let temp = setup_temp_dir();
    let encode_tar = |payload: &[u8]| {
        let mut tar = tar::Builder::new(Vec::new());
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, "payload.bin", payload)
            .unwrap();
        let mut bytes = tar.into_inner().unwrap();
        bytes.resize(131_072, 0);
        let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
        encoder.write_all(&bytes).unwrap();
        encoder.finish().unwrap()
    };
    let valid = encode_tar(b"abc");
    let mut altered_payload = encode_tar(b"abd");
    let trailer = altered_payload.len() - 8;
    altered_payload[trailer..].copy_from_slice(&valid[valid.len() - 8..]);
    let mut wrong_size = valid.clone();
    let size_offset = wrong_size.len() - 4;
    wrong_size[size_offset] ^= 1;
    let mut corrupt_later_member = valid.clone();
    corrupt_later_member.extend_from_slice(&altered_payload);
    let archive = temp.child("padded.tar.gz");
    for corrupt in [
        altered_payload,
        wrong_size,
        valid[..valid.len() - 1].to_vec(),
        corrupt_later_member,
    ] {
        fs::write(archive.path(), &corrupt).unwrap();
        let output = command_output_with_env(
            &["extract", archive.to_str().unwrap(), "--output", "-"],
            &[],
            1,
        );
        assert!(output.stdout.is_empty());
        assert_eq!(fs::read(archive.path()).unwrap(), corrupt);
    }
    fs::write(archive.path(), &valid).unwrap();
    assert_eq!(
        command_stdout(&["extract", archive.to_str().unwrap(), "--output", "-"], 0),
        b"abc"
    );
    assert_eq!(fs::read(archive.path()).unwrap(), valid);
}

#[test]
fn layered_gzip_validates_every_filter_before_emitting_output() {
    let temp = setup_temp_dir();
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(3);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "payload.bin", &b"abc"[..])
        .unwrap();
    let mut tar_bytes = tar.into_inner().unwrap();
    tar_bytes.resize(131_072, 0);
    let gzip = |bytes: &[u8]| {
        let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    };
    let mut uuencoded = b"begin 644 payload.tar\n".to_vec();
    for line in tar_bytes.chunks(45) {
        uuencoded.push(line.len() as u8 + 32);
        for chunk in line.chunks(3) {
            let a = chunk[0];
            let b = chunk.get(1).copied().unwrap_or(0);
            let c = chunk.get(2).copied().unwrap_or(0);
            for value in [
                a >> 2,
                (a << 4 | b >> 4) & 63,
                (b << 2 | c >> 6) & 63,
                c & 63,
            ] {
                uuencoded.push(value + 32);
            }
        }
        uuencoded.push(b'\n');
    }
    uuencoded.extend_from_slice(b"`\nend\n");
    let mut nested = gzip(&tar_bytes);
    nested.resize(nested.len() + 131_072, 0);
    for (label, mut inner) in [
        ("nested", gzip(&tar_bytes)),
        ("uuencoded", uuencoded),
        ("triple", gzip(&nested)),
    ] {
        inner.resize(inner.len() + 131_072, 0);
        let valid = gzip(&inner);
        let archive = temp.child(format!("{label}.tar.gz"));
        let mut wrong_crc = valid.clone();
        wrong_crc[valid.len() - 8] ^= 1;
        let mut wrong_size = valid.clone();
        wrong_size[valid.len() - 4] ^= 1;
        for damaged in [wrong_crc, wrong_size, valid[..valid.len() - 1].to_vec()] {
            fs::write(archive.path(), &damaged).unwrap();
            let output = binary()
                .args(["extract", archive.to_str().unwrap(), "--output", "-"])
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(1),
                "{label}: layered gzip bypassed integrity validation"
            );
            assert!(output.stdout.is_empty(), "{label}: partial binary output");
            assert!(String::from_utf8_lossy(&output.stderr).contains("gzip"));
            assert_eq!(fs::read(archive.path()).unwrap(), damaged);
        }
        fs::write(archive.path(), &valid).unwrap();
        assert_eq!(
            command_stdout(&["extract", archive.to_str().unwrap(), "--output", "-"], 0),
            b"abc"
        );
        assert_eq!(fs::read(archive.path()).unwrap(), valid);
    }
}

#[test]
fn gzip_preserves_inner_xz_validation_before_emitting_output() {
    let temp = setup_temp_dir();
    let mut tar = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(3);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "payload.bin", &b"abc"[..])
        .unwrap();
    let mut tar_bytes = tar.into_inner().unwrap();
    tar_bytes.resize(131_072, 0);
    let valid = rom_weaver_core::codecs::encode_xz_preset(&tar_bytes, 6).unwrap();
    let mut wrong_crc = valid.clone();
    wrong_crc[valid.len() - 12] ^= 1;
    let archive = temp.child("inner-xz.tar.gz");
    for inner in [wrong_crc, valid[..valid.len() - 1].to_vec(), valid.clone()] {
        let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::default());
        encoder.write_all(&inner).unwrap();
        let compressed = encoder.finish().unwrap();
        fs::write(archive.path(), &compressed).unwrap();
        let output = binary()
            .args(["extract", archive.to_str().unwrap(), "--output", "-"])
            .output()
            .unwrap();
        if inner == valid {
            assert!(output.status.success());
            assert_eq!(output.stdout, b"abc");
        } else {
            assert_eq!(
                output.status.code(),
                Some(1),
                "valid outer gzip bypassed inner XZ integrity validation"
            );
            assert!(output.stdout.is_empty(), "partial binary output");
        }
        assert_eq!(fs::read(archive.path()).unwrap(), compressed);
    }
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
            .args(&args)
            .output()
            .expect("run invalid stream command");
        assert!(!output.status.success());
        assert_invalid_stream_output(&args, &output);
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
            .args(&args)
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
        assert_invalid_stream_output(&args, &output);
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
            "--emit-weave",
            "weave.json",
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
        assert_invalid_stream_output(&args, &output);
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

#[test]
fn trim_stdout_explains_when_no_input_is_eligible() {
    let temp = setup_temp_dir();
    let input = temp.child("plain.txt");
    let source = b"not a ROM";
    fs::write(input.path(), source).unwrap();
    let output = binary()
        .args(["trim", input.path().to_str().unwrap(), "-o", "-"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("output - produced no file"), "{stderr}");
    assert!(stderr.contains("no trim-eligible inputs found"), "{stderr}");
    assert_eq!(fs::read(input.path()).unwrap(), source);
}

fn assert_invalid_stream_output(args: &[&str], output: &std::process::Output) {
    if args.contains(&"--json") || args.contains(&"--jsonl") {
        let report: Value = serde_json::from_slice(&output.stdout).expect("JSON stream error");
        assert_eq!(report["status"], "failed");
        assert_eq!(report["details"]["error"]["exit_code"], 2);
        assert!(output.stderr.is_empty(), "{args:?}: {output:?}");
    } else {
        assert!(output.stdout.is_empty(), "{args:?}");
    }
}

// quality-reason: Linux procfs verifies the handler and blocked stdin before signalling.
#[cfg(target_os = "linux")]
#[test]
fn termination_cancels_open_stdin_and_removes_spools() {
    for signal in [libc::SIGTERM, libc::SIGHUP] {
        for command in ["compress", "checksum", "probe", "identify", "weave"] {
            let temp = setup_temp_dir();
            let output = temp.path().join("output.zip");
            let mut process = binary();
            process.env("TMPDIR", temp.path()).stdin(Stdio::piped());
            match command {
                "compress" => {
                    process
                        .args(["compress", "--input", "-", "--format", "zip", "--output"])
                        .arg(&output);
                }
                "weave" => {
                    process
                        .args(["weave", "create", "--from", "-", "--output"])
                        .arg(&output);
                }
                _ => {
                    process.args([command, "--input", "-"]);
                }
            }
            let mut child = process.spawn().expect("spawn stdin command");
            child
                .stdin
                .as_mut()
                .expect("open stdin")
                .write_all(b"partial")
                .expect("write partial input");
            let deadline = Instant::now() + Duration::from_secs(10);
            let proc = PathBuf::from(format!("/proc/{}", child.id()));
            loop {
                let status = fs::read_to_string(proc.join("status")).expect("child status");
                let caught = status
                    .lines()
                    .find_map(|line| line.strip_prefix("SigCgt:"))
                    .and_then(|mask| u64::from_str_radix(mask.trim(), 16).ok())
                    .unwrap();
                let wait = fs::read_to_string(proc.join("wchan")).expect("child wait state");
                if caught & (1 << (signal - 1)) != 0
                    && (wait.trim() == "pipe_read" || wait.contains("poll"))
                {
                    break;
                }
                if child.try_wait().expect("child status").is_some() || Instant::now() >= deadline {
                    let _ = child.kill();
                    let result = child.wait_with_output().expect("reap stdin command");
                    panic!("{command} never reached stdin: {result:?}");
                }
                thread::sleep(Duration::from_millis(5));
            }
            // SAFETY: the child is alive, and these are valid termination signals.
            assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
            let deadline = Instant::now() + Duration::from_secs(2);
            let status = loop {
                if let Some(status) = child.try_wait().expect("wait for cancellation") {
                    break status;
                }
                if Instant::now() >= deadline {
                    child.kill().expect("stop blocked stdin command");
                    child.wait().expect("reap blocked stdin command");
                    panic!("{command} ignored signal {signal} while stdin remained open");
                }
                thread::sleep(Duration::from_millis(5));
            };
            assert_eq!(status.code(), Some(130), "{command}: {status:?}");
            assert!(!output.exists(), "cancelled command wrote output");
            assert_eq!(
                fs::read_dir(temp.path()).expect("read spool root").count(),
                0,
                "{command} left a stdin spool behind"
            );
        }
    }
}

#[test]
fn probe_stdin_failure_names_stdin_not_the_staging_file() {
    let mut child = binary()
        .args(["probe", "--input", "-", "--json"])
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn probe");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(b"opaque bytes no handler claims")
        .expect("write stdin");
    let output = child.wait_with_output().expect("probe output");
    assert_eq!(output.status.code(), Some(1));
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("JSON failure report");
    let label = report["label"].as_str().expect("label");
    assert!(
        label.contains("no registered handler matched `<stdin>`"),
        "{label}"
    );
    assert!(!label.contains("rom-weaver-stdin"), "{label}");
}
