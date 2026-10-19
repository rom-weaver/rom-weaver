//! WBFS end-to-end coverage: split sets (`.wbfs` + `.wbf1`, `.wbf2`), RVZ/ZIP/7z
//! round trips, checksums, and probe fields, all from synthetic GameCube images.

use super::shared::*;

fn path_str(path: &Path) -> &str {
    path.to_str().expect("path")
}

/// Writes `disc.wbfs` split into `parts` files (`disc.wbfs`, `disc.wbf1`, ...)
/// and returns the original ISO bytes.
fn write_split_wbfs(temp: &TempDir, payload_len: usize, parts: usize) -> Vec<u8> {
    let iso_bytes = build_test_gamecube_iso(payload_len);
    let iso = temp.child("disc.iso");
    fs::write(iso.path(), &iso_bytes).expect("iso fixture");
    let whole = temp.child("whole.wbfs");
    write_wbfs_fixture_from_iso(iso.path(), whole.path());
    let wbfs = fs::read(whole.path()).expect("wbfs bytes");
    fs::remove_file(whole.path()).expect("remove whole wbfs");
    let chunk = wbfs.len().div_ceil(parts);
    for (index, bytes) in wbfs.chunks(chunk).enumerate() {
        let name = if index == 0 {
            "disc.wbfs".to_string()
        } else {
            format!("disc.wbf{index}")
        };
        fs::write(temp.child(name).path(), bytes).expect("write wbfs part");
    }
    iso_bytes
}

fn extract_to(temp: &TempDir, input: &Path, dir: &str) -> std::path::PathBuf {
    let out_dir = temp.child(dir);
    command_stdout(
        &[
            "extract",
            "--input",
            path_str(input),
            "--output",
            path_str(out_dir.path()),
            "--jsonl",
        ],
        0,
    );
    out_dir.path().to_path_buf()
}

#[test]
fn split_wbfs_sets_extract_byte_exactly() {
    for parts in [2, 3] {
        let temp = setup_temp_dir();
        let iso = write_split_wbfs(&temp, 0x20000, parts);
        assert!(temp.child(format!("disc.wbf{}", parts - 1)).path().exists());
        let out = extract_to(&temp, temp.child("disc.wbfs").path(), "extract");
        assert_eq!(
            fs::read(out.join("disc.iso")).expect("iso"),
            iso,
            "{parts} parts"
        );
    }
}

#[test]
fn split_wbfs_checksum_matches_the_iso_and_the_unsplit_wbfs() {
    let temp = setup_temp_dir();
    let iso = write_split_wbfs(&temp, 0x20000, 3);
    let split = checksum_value(temp.child("disc.wbfs").path(), "sha1");
    let raw = temp.child("raw.iso");
    fs::write(raw.path(), &iso).expect("raw iso");
    assert_eq!(split, checksum_value(raw.path(), "sha1"));
}

fn compress_args<'a>(inputs: &[&'a str], format: &'a str, output: &'a str) -> Vec<&'a str> {
    let mut args = vec!["compress"];
    for input in inputs {
        args.extend(["--input", input]);
    }
    args.extend(["--format", format, "--output", output, "--jsonl"]);
    args
}

#[test]
fn split_wbfs_converts_to_rvz_that_extracts_to_the_same_iso() {
    let temp = setup_temp_dir();
    let iso = write_split_wbfs(&temp, 0x20000, 2);
    let archive = temp.child("out.rvz");
    let first = path_str(temp.child("disc.wbfs").path()).to_string();
    let output = command_stdout(
        &compress_args(&[&first], "rvz", path_str(archive.path())),
        0,
    );
    let last = parse_json_lines(&output).pop().expect("terminal event");
    assert_eq!(last["status"], "succeeded", "{last}");
    let out = extract_to(&temp, archive.path(), "roundtrip");
    assert_eq!(fs::read(out.join("out.iso")).expect("iso"), iso);
}

#[test]
fn split_wbfs_converts_to_rvz_with_any_format_spelling() {
    let temp = setup_temp_dir();
    write_split_wbfs(&temp, 0x20000, 2);
    let archive = temp.child("out.rvz");
    let first = path_str(temp.child("disc.wbfs").path()).to_string();
    let output = command_stdout(
        &compress_args(&[&first], "RVZ", path_str(archive.path())),
        0,
    );
    let last = parse_json_lines(&output).pop().expect("terminal event");
    assert_eq!(last["status"], "succeeded", "{last}");
}

/// A part passed under a different spelling of its path still counts as passed.
#[test]
fn split_wbfs_parts_match_inputs_by_file_not_spelling() {
    let temp = setup_temp_dir();
    write_split_wbfs(&temp, 0x20000, 2);
    fs::create_dir(temp.child("sub").path()).expect("subdir");
    let first = path_str(temp.child("disc.wbfs").path()).to_string();
    let second = path_str(&temp.path().join("sub/../disc.wbf1")).to_string();
    let archive = temp.child("out.zip");
    let output = command_stdout(
        &compress_args(&[&first, &second], "zip", path_str(archive.path())),
        0,
    );
    let last = parse_json_lines(&output).pop().expect("terminal event");
    assert_eq!(last["status"], "succeeded", "{last}");
}

/// ZIP and 7z store the files they are given; a split set is archived by
/// passing every part, and the extracted parts still extract to the ISO.
#[test]
fn split_wbfs_parts_archive_to_zip_and_7z_and_still_extract() {
    for format in ["zip", "7z"] {
        let temp = setup_temp_dir();
        let iso = write_split_wbfs(&temp, 0x20000, 2);
        let first = path_str(temp.child("disc.wbfs").path()).to_string();
        let second = path_str(temp.child("disc.wbf1").path()).to_string();
        let archive = temp.child(format!("out.{format}"));
        let output = command_stdout(
            &compress_args(&[&first, &second], format, path_str(archive.path())),
            0,
        );
        let last = parse_json_lines(&output).pop().expect("terminal event");
        assert_eq!(last["status"], "succeeded", "{format}: {last}");
        let out = extract_to(&temp, archive.path(), "roundtrip");
        for part in ["disc.wbfs", "disc.wbf1"] {
            assert_eq!(
                fs::read(out.join(part)).unwrap_or_else(|_| panic!("{format}: missing {part}")),
                fs::read(temp.child(part).path()).expect("source part"),
                "{format} {part}"
            );
        }
        let iso_out = extract_to(&temp, &out.join("disc.wbfs"), "from-archive");
        assert_eq!(
            fs::read(iso_out.join("disc.iso")).expect("iso"),
            iso,
            "{format}"
        );
    }
}

#[test]
fn wbfs_rvz_output_matches_the_rvz_made_from_the_iso() {
    let temp = setup_temp_dir();
    let iso = write_split_wbfs(&temp, 0x20000, 2);
    let raw = temp.child("disc.iso");
    fs::write(raw.path(), &iso).expect("raw iso");
    let from_wbfs = temp.child("from-wbfs.rvz");
    let from_iso = temp.child("from-iso.rvz");
    for (input, output) in [(temp.child("disc.wbfs"), &from_wbfs), (raw, &from_iso)] {
        command_stdout(
            &[
                "compress",
                "--input",
                path_str(input.path()),
                "--format",
                "rvz",
                "--output",
                path_str(output.path()),
                "--jsonl",
            ],
            0,
        );
    }
    assert_eq!(
        fs::read(from_wbfs.path()).expect("rvz from wbfs"),
        fs::read(from_iso.path()).expect("rvz from iso")
    );
}

#[test]
fn split_wbfs_probe_reports_the_container() {
    let temp = setup_temp_dir();
    write_split_wbfs(&temp, 0x20000, 2);
    let output = command_stdout(
        &[
            "probe",
            "--input",
            path_str(temp.child("disc.wbfs").path()),
            "--no-extract",
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    assert_eq!(json["format"], "wbfs");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["platform"], "Nintendo GameCube");
    assert_eq!(json["details"]["container"]["entries"][0], "disc.iso");
    assert_eq!(
        json["details"]["container"]["recommended_compress_format"],
        "rvz"
    );
    assert_eq!(json["details"]["container"]["reason"], "wii-gc-disc");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("lossless=true"), "{label}");
}

/// Archiving only the first part of a split set would silently drop the rest.
#[test]
fn split_wbfs_first_part_alone_is_refused_for_generic_archives() {
    for format in ["zip", "7z", "chd"] {
        let temp = setup_temp_dir();
        write_split_wbfs(&temp, 0x20000, 3);
        let first = path_str(temp.child("disc.wbfs").path()).to_string();
        let second = path_str(temp.child("disc.wbf1").path()).to_string();
        let archive = temp.child(format!("out.{format}"));
        for inputs in [vec![first.as_str()], vec![first.as_str(), second.as_str()]] {
            let output =
                command_stdout(&compress_args(&inputs, format, path_str(archive.path())), 1);
            let last = parse_json_lines(&output).pop().expect("terminal event");
            assert_eq!(last["status"], "failed", "{format}: {last}");
            let label = last["label"].as_str().expect("label");
            assert!(label.contains("disc.wbf2"), "{format}: {label}");
            assert!(!archive.path().exists(), "{format}: archive was written");
        }
    }
}

#[test]
fn split_wbfs_identifies_by_the_extracted_iso_hash() {
    let temp = setup_temp_dir();
    let iso = write_split_wbfs(&temp, 0x20000, 2);
    let raw = temp.child("raw.iso");
    fs::write(raw.path(), &iso).expect("raw iso");
    let hex = |algorithm: &str| -> Vec<u8> {
        let digest = checksum_value(raw.path(), algorithm);
        (0..digest.len() / 2)
            .map(|index| u8::from_str_radix(&digest[index * 2..index * 2 + 2], 16).expect("hex"))
            .collect()
    };
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_for_disc(
            "Nintendo GameCube",
            iso.len() as u64,
            hex("crc32").try_into().expect("crc32"),
            hex("md5").try_into().expect("md5"),
            hex("sha1").try_into().expect("sha1"),
            "RW Test Disc",
        ),
    )
    .expect("pack");
    let output = command_stdout(
        &[
            "identify",
            "--input",
            path_str(temp.child("disc.wbfs").path()),
            "--database",
            path_str(pack.path()),
            "--json",
        ],
        0,
    );
    let json = parse_single_json_line(&output);
    let identify = &json["details"]["identify"];
    assert_eq!(identify["status"], "matched", "{json}");
    assert_eq!(identify["matches"][0]["name"], "RW Test Disc");
}
