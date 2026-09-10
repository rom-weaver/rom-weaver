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
        assert!(
            digest(&args, 2).is_empty(),
            "invalid args must not write stdout"
        );
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
