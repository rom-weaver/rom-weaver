use super::shared::*;

const HELLO_WORLD_SHA256: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

fn digest(args: &[&str], expected_code: i32) -> Vec<u8> {
    command_stdout(args, expected_code)
}

#[test]
fn checksum_digest_prints_only_the_requested_lowercase_digest() {
    let temp = setup_temp_dir();
    let source = temp.child("hello.bin");
    source.write_str("hello world").expect("fixture");

    let output = digest(
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--digest",
        ],
        0,
    );

    assert_eq!(output, format!("{HELLO_WORLD_SHA256}\n").as_bytes());
}

#[test]
fn checksum_digest_auto_extracts_unless_no_extract_is_set() {
    let temp = setup_temp_dir();
    let source = temp.child("hello.bin");
    source.write_str("hello world").expect("fixture");
    let archive = temp.child("hello.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            source.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let extracted = digest(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--digest",
        ],
        0,
    );
    let raw = digest(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--no-extract",
            "--digest",
        ],
        0,
    );

    assert_eq!(extracted, format!("{HELLO_WORLD_SHA256}\n").as_bytes());
    assert_ne!(raw, extracted);
}

#[test]
fn checksum_digest_reads_stdin_and_honors_ranges() {
    let stdin = command_stdout_with_stdin(
        &["checksum", "--input", "-", "--algo", "sha256", "--digest"],
        b"hello world",
        0,
    );
    assert_eq!(stdin, format!("{HELLO_WORLD_SHA256}\n").as_bytes());

    let temp = setup_temp_dir();
    let source = temp.child("range.bin");
    source.write_str("hello world").expect("fixture");
    let expected = command_stdout(
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--start",
            "6",
            "--length",
            "5",
            "--json",
        ],
        0,
    );
    let expected = parse_single_json_line(&expected)["details"]["checksums"]["sha256"]
        .as_str()
        .expect("range checksum")
        .to_string();
    let actual = digest(
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--start",
            "6",
            "--length",
            "5",
            "--digest",
        ],
        0,
    );
    assert_eq!(actual, format!("{expected}\n").as_bytes());
}

#[test]
fn checksum_digest_keeps_stdout_clean_when_quiet_or_failed() {
    let temp = setup_temp_dir();
    let source = temp.child("hello.bin");
    source.write_str("hello world").expect("fixture");
    let quiet = digest(
        &[
            "--quiet",
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--digest",
        ],
        0,
    );
    assert_eq!(quiet, format!("{HELLO_WORLD_SHA256}\n").as_bytes());

    let missing = temp.child("missing.bin");
    assert!(
        digest(
            &[
                "checksum",
                "--input",
                missing.path().to_str().expect("path"),
                "--algo",
                "sha256",
                "--digest",
            ],
            1,
        )
        .is_empty()
    );
}

#[test]
fn checksum_digest_rejects_invalid_output_combinations() {
    let temp = setup_temp_dir();
    let source = temp.child("hello.bin");
    source.write_str("hello world").expect("fixture");
    let source = source.path().to_string_lossy().into_owned();

    for args in [
        vec!["checksum", source.as_str(), "--digest"],
        vec![
            "--json",
            "checksum",
            source.as_str(),
            "--algo",
            "sha256",
            "--digest",
        ],
        vec![
            "checksum",
            source.as_str(),
            "--algo",
            "sha256",
            "--digest",
            "--dry-run",
        ],
        vec![
            "checksum",
            "--input",
            source.as_str(),
            "--algo",
            "sha1",
            "--algo",
            "sha256",
            "--digest",
        ],
        vec![
            "checksum",
            "--input",
            source.as_str(),
            "--algo",
            "sha256",
            "--digest",
            "--json",
        ],
        vec![
            "--dry-run",
            "checksum",
            "--input",
            source.as_str(),
            "--algo",
            "sha256",
            "--digest",
        ],
    ] {
        let output = digest(&args, 2);
        if args.contains(&"--json") {
            let report: Value = serde_json::from_slice(&output).expect("JSON argument error");
            assert_eq!(report["error"]["code"], "cli.invalid_arguments");
            assert_eq!(report["exit_code"], 2);
        } else {
            assert!(
                output.is_empty(),
                "invalid plain args must not write stdout"
            );
        }
    }
}

#[test]
fn checksum_digest_positional_input_ignores_color() {
    let output = command_stdout_with_stdin(
        &["checksum", "-", "--algo", "sha256", "--digest", "--color"],
        b"hello world",
        0,
    );
    assert_eq!(output, format!("{HELLO_WORLD_SHA256}\n").as_bytes());
}

#[test]
fn human_results_checksum_shows_probe_identity_and_variant_digests() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nes");
    let mut bytes = vec![0_u8; 16 + 16_384];
    bytes[..4].copy_from_slice(b"NES\x1a");
    bytes[4] = 1;
    fs::write(input.path(), bytes).expect("NES fixture");
    let path = input.path().to_str().expect("path");
    let report: Value = serde_json::from_slice(&command_stdout(
        &[
            "checksum", "-i", path, "--algo", "crc32", "--probe", "--json",
        ],
        0,
    ))
    .expect("JSON report");
    let output = String::from_utf8(command_stdout(
        &["checksum", "-i", path, "--algo", "crc32", "--probe"],
        0,
    ))
    .expect("UTF-8");
    assert!(
        output.contains("Platform")
            && output.contains(report["details"]["platform"].as_str().expect("platform")),
        "{output}"
    );
    let variants = report["details"]["checksum_variants"]
        .as_array()
        .expect("variants");
    assert!(variants.len() > 1);
    for variant in variants {
        assert!(
            output.contains(variant["checksums"]["crc32"].as_str().expect("digest")),
            "{output}"
        );
    }
}
