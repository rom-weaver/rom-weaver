use super::shared::*;

/// Build a minimal PPF3 patch (no blockcheck, no file_id trailer) with one
/// record per `(offset, data, undo)` tuple. `data` and `undo` must be the same
/// length. Mirrors the on-disk layout `rom_weaver_patches::ppf` parses:
/// `"PPF30"` + method byte + 50-byte description + imagetype/blockcheck/undo/
/// reserved flag bytes, then `offset:u64 LE, len:u8, data[len], undo[len]` per
/// record.
fn build_ppf3_undo_patch(records: &[(u64, Vec<u8>, Vec<u8>)]) -> Vec<u8> {
    build_ppf3_patch(records, true)
}

/// Same layout as [`build_ppf3_undo_patch`], but with the undo flag cleared and
/// no undo bytes written per record - the shape `undo_ppf` rejects.
fn build_ppf3_patch_without_undo(records: &[(u64, Vec<u8>)]) -> Vec<u8> {
    let with_empty_undo: Vec<(u64, Vec<u8>, Vec<u8>)> = records
        .iter()
        .map(|(offset, data)| (*offset, data.clone(), Vec::new()))
        .collect();
    build_ppf3_patch(&with_empty_undo, false)
}

fn build_ppf3_patch(records: &[(u64, Vec<u8>, Vec<u8>)], undo_enabled: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PPF30");
    bytes.push(2); // encoding method: PPF3
    let mut description = [0u8; 50];
    let text = b"cli-smoke ppf-undo fixture";
    description[..text.len()].copy_from_slice(text);
    bytes.extend_from_slice(&description);
    bytes.push(0); // imagetype
    bytes.push(0); // blockcheck disabled
    bytes.push(u8::from(undo_enabled));
    bytes.push(0); // reserved
    for (offset, data, undo) in records {
        bytes.extend_from_slice(&offset.to_le_bytes());
        bytes.push(data.len() as u8);
        bytes.extend_from_slice(data);
        if undo_enabled {
            assert_eq!(data.len(), undo.len(), "undo data must match record length");
            bytes.extend_from_slice(undo);
        }
    }
    bytes
}

#[test]
fn tools_ppf_undo_restores_the_original_rom() {
    let temp = setup_temp_dir();
    let original = b"AAAAAAAAAAAAAAAA".to_vec();
    let mut patched = original.clone();
    patched[4] = b'X';
    patched[5] = b'Y';
    patched[6] = b'Z';

    let patch_bytes = build_ppf3_undo_patch(&[(
        4,
        vec![b'X', b'Y', b'Z'],
        vec![original[4], original[5], original[6]],
    )]);

    let rom_path = temp.child("patched.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(rom_path.path(), &patched).expect("patched fixture");
    fs::write(patch_path.path(), &patch_bytes).expect("patch fixture");

    let json = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "-i",
            rom_path.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "-o",
            output_path.path().to_str().expect("output path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "tools-ppf-undo");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "PPF");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("restored ROM written to")
    );

    assert_eq!(
        fs::read(output_path.path()).expect("restored output"),
        original
    );
}

#[test]
fn tools_ppf_undo_stdout_matches_file_output_and_keeps_sources() {
    let temp = setup_temp_dir();
    let original = b"AAAAAAAAAAAAAAAA".to_vec();
    let mut patched = original.clone();
    patched[4..7].copy_from_slice(b"XYZ");
    let patch_bytes = build_ppf3_undo_patch(&[(
        4,
        vec![b'X', b'Y', b'Z'],
        vec![original[4], original[5], original[6]],
    )]);
    let rom_path = temp.child("patched.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(rom_path.path(), &patched).expect("rom fixture");
    fs::write(patch_path.path(), &patch_bytes).expect("patch fixture");

    command_stdout(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "--input",
            rom_path.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "--output",
            output_path.path().to_str().expect("output path"),
        ],
        0,
    );
    let stdout = command_stdout(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "--input",
            rom_path.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "--output",
            "-",
        ],
        0,
    );

    assert_eq!(stdout, fs::read(output_path.path()).expect("file output"));
    assert_eq!(fs::read(rom_path.path()).expect("ROM source"), patched);
    assert_eq!(
        fs::read(patch_path.path()).expect("PPF source"),
        patch_bytes
    );
}

#[test]
fn tools_ppf_undo_failure_to_stdout_writes_no_bytes_and_keeps_sources() {
    let temp = setup_temp_dir();
    let rom_path = temp.child("patched.bin");
    let patch_path = temp.child("update.ppf");
    let patched = b"AAAAAAAAAAAAAAAA".to_vec();
    let patch_bytes = build_ppf3_patch_without_undo(&[(4, vec![b'X', b'Y', b'Z'])]);
    fs::write(rom_path.path(), &patched).expect("rom fixture");
    fs::write(patch_path.path(), &patch_bytes).expect("patch fixture");

    let stdout = command_stdout(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "--input",
            rom_path.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "--output",
            "-",
        ],
        1,
    );

    assert!(stdout.is_empty(), "a failed undo must not write stdout");
    assert_eq!(fs::read(rom_path.path()).expect("ROM source"), patched);
    assert_eq!(
        fs::read(patch_path.path()).expect("PPF source"),
        patch_bytes
    );
}

#[test]
fn tools_ppf_undo_rejects_a_patch_without_undo_data() {
    let temp = setup_temp_dir();
    let rom_path = temp.child("patched.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(rom_path.path(), b"AAAAAAAAAAAAAAAA").expect("rom fixture");
    fs::write(
        patch_path.path(),
        build_ppf3_patch_without_undo(&[(4, vec![b'X', b'Y', b'Z'])]),
    )
    .expect("patch fixture");

    let json = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "-i",
            rom_path.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "-o",
            output_path.path().to_str().expect("output path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["command"], "tools-ppf-undo");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "PPF");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("does not contain complete undo data")
    );
    assert!(
        !output_path.path().exists(),
        "a failed undo must not leave a restored output behind"
    );
}

#[test]
fn tools_ppf_undo_reports_a_missing_rom_as_a_validation_failure() {
    let temp = setup_temp_dir();
    let missing_rom = temp.child("missing.bin");
    let patch_path = temp.child("update.ppf");
    let output_path = temp.child("restored.bin");
    fs::write(
        patch_path.path(),
        build_ppf3_undo_patch(&[(0, vec![b'X'], vec![b'A'])]),
    )
    .expect("patch fixture");

    let json = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "-i",
            missing_rom.path().to_str().expect("rom path"),
            "--patch",
            patch_path.path().to_str().expect("patch path"),
            "-o",
            output_path.path().to_str().expect("output path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["command"], "tools-ppf-undo");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("input path does not exist")
    );
}

#[test]
fn tools_ppf_undo_rejects_output_aliases_without_changing_sources() {
    let temp = setup_temp_dir();
    let rom = temp.child("patched.bin");
    let patch = temp.child("update.ppf");
    let rom_bytes = b"AXAA";
    let patch_bytes = build_ppf3_undo_patch(&[(1, b"X".to_vec(), b"A".to_vec())]);
    for output in [rom.path(), patch.path()] {
        fs::write(rom.path(), rom_bytes).expect("ROM fixture");
        fs::write(patch.path(), &patch_bytes).expect("patch fixture");
        let json = run_single_json_event(
            &[
                "tools",
                "ppf-undo",
                "--no-compress",
                "--input",
                rom.path().to_str().expect("ROM path"),
                "--patch",
                patch.path().to_str().expect("patch path"),
                "--output",
                output.to_str().expect("output path"),
                "--json",
            ],
            1,
        );
        assert_eq!(json["status"], "failed");
        assert_eq!(fs::read(rom.path()).expect("ROM bytes"), rom_bytes);
        assert_eq!(fs::read(patch.path()).expect("patch bytes"), patch_bytes);
    }
}

#[cfg(unix)]
#[test]
fn tools_ppf_undo_rejects_hardlink_output_without_changing_rom() {
    let temp = setup_temp_dir();
    let rom = temp.child("patched.bin");
    let patch = temp.child("update.ppf");
    let output = temp.child("alias.bin");
    let rom_bytes = b"AXAA";
    let patch_bytes = build_ppf3_undo_patch(&[(1, b"X".to_vec(), b"A".to_vec())]);
    fs::write(rom.path(), rom_bytes).expect("ROM fixture");
    fs::write(patch.path(), &patch_bytes).expect("patch fixture");
    fs::hard_link(rom.path(), output.path()).expect("hardlink fixture");
    let json = run_single_json_event(
        &[
            "tools",
            "ppf-undo",
            "--no-compress",
            "--input",
            rom.path().to_str().expect("ROM path"),
            "--patch",
            patch.path().to_str().expect("patch path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["status"], "failed");
    assert_eq!(fs::read(rom.path()).expect("ROM bytes"), rom_bytes);
    assert_eq!(fs::read(patch.path()).expect("patch bytes"), patch_bytes);
    assert_eq!(fs::read(output.path()).expect("alias bytes"), rom_bytes);
}

fn undo_fixture(temp: &TempDir) -> (PathBuf, PathBuf, Vec<u8>, Vec<u8>) {
    let rom = temp.child("patched.gba").path().to_path_buf();
    let patch = temp.child("undo.ppf").path().to_path_buf();
    let original = b"AAAAAAAAAAAAAAAA".to_vec();
    let mut modified = original.clone();
    modified[4..7].copy_from_slice(b"XYZ");
    fs::write(&rom, &modified).expect("ROM fixture");
    fs::write(
        &patch,
        build_ppf3_undo_patch(&[(4, b"XYZ".to_vec(), b"AAA".to_vec())]),
    )
    .expect("patch fixture");
    (rom, patch, original, modified)
}

fn undo_report(input: &Path, patch: &Path, output: &Path, options: &[&str], code: i32) -> Value {
    let mut args = vec![
        "tools",
        "ppf-undo",
        "--input",
        input.to_str().expect("input path"),
        "--patch",
        patch.to_str().expect("patch path"),
        "--output",
        output.to_str().expect("output path"),
        "--json",
    ];
    args.extend_from_slice(options);
    run_single_json_event(&args, code)
}

#[test]
fn tools_ppf_undo_extracts_rom_and_patch_archives_and_compresses_output() {
    let temp = setup_temp_dir();
    let (rom, patch, original, modified) = undo_fixture(&temp);
    let rom_archive = temp.child("rom.tar.gz");
    let patch_archive = temp.child("patch.tar.gz");
    write_tar_gz_fixture(&[(&rom, "nested/patched.gba")], rom_archive.path());
    write_tar_gz_fixture(&[(&patch, "nested/undo.ppf")], patch_archive.path());
    let output = temp.child("restored.zip");
    let report = undo_report(
        rom_archive.path(),
        patch_archive.path(),
        output.path(),
        &["--compress-codec", "store", "--threads", "1"],
        0,
    );
    assert_eq!(report["status"], "succeeded");
    let label = report["label"].as_str().expect("label");
    assert!(
        label.contains("PPF undo ROM source resolved via"),
        "{label}"
    );
    assert!(
        label.contains("PPF undo patch source resolved via"),
        "{label}"
    );
    assert!(
        label.contains("restored output compressed as zip"),
        "{label}"
    );
    assert_eq!(report["details"]["emitted_files"][0]["kind"], "archive");
    let unpacked = temp.child("unpacked");
    command_stdout(
        &[
            "extract",
            "--input",
            output.path().to_str().expect("output path"),
            "--output",
            unpacked.path().to_str().expect("unpacked path"),
        ],
        0,
    );
    assert_eq!(
        fs::read(unpacked.path().join("restored.gba")).expect("restored ROM"),
        original
    );
    assert_eq!(fs::read(&rom).expect("ROM source"), modified);
    assert_eq!(
        fs::read(&patch).expect("patch source"),
        build_ppf3_undo_patch(&[(4, b"XYZ".to_vec(), b"AAA".to_vec())])
    );
}

#[test]
fn tools_ppf_undo_matching_rom_extension_writes_raw_and_no_extract_is_optional() {
    let temp = setup_temp_dir();
    let (rom, patch, original, _) = undo_fixture(&temp);
    let output = temp.child("restored.gba");
    let report = undo_report(&rom, &patch, output.path(), &["--no-extract"], 0);
    assert_eq!(report["status"], "succeeded");
    assert_eq!(report["stage"], "undo");
    assert_eq!(fs::read(output.path()).expect("restored ROM"), original);
}

#[test]
fn tools_ppf_undo_explicit_format_warns_when_output_extension_disagrees() {
    let temp = setup_temp_dir();
    let (rom, patch, original, _) = undo_fixture(&temp);
    let output = temp.child("restored.7z");
    let report = undo_report(
        &rom,
        &patch,
        output.path(),
        &["--compress-format", "zip", "--compress-codec", "store"],
        0,
    );
    let warnings = report["warnings"].as_array().expect("warnings");
    assert_eq!(warnings.len(), 1);
    let warning = warnings[0].as_str().expect("warning");
    assert!(
        warning.contains("zip") && warning.contains("7z"),
        "{warning}"
    );
    assert!(fs::read(output.path()).expect("archive").starts_with(b"PK"));
    let unpacked = temp.child("unpacked");
    command_stdout(
        &[
            "extract",
            "--input",
            output.path().to_str().expect("output"),
            "--output",
            unpacked.path().to_str().expect("unpacked"),
        ],
        0,
    );
    assert_eq!(
        fs::read(unpacked.path().join("restored.gba")).expect("ROM"),
        original
    );
}

#[test]
fn tools_ppf_undo_invalid_compression_options_preserve_existing_output() {
    let temp = setup_temp_dir();
    let (rom, patch, _, modified) = undo_fixture(&temp);
    let cases: &[(&str, &[&str], &str)] = &[
        ("restored", &[], "output has no file extension"),
        ("restored.bin", &[], "neither a registered container"),
        ("restored.unknown", &[], "neither a registered container"),
        (
            "restored.zip",
            &["--no-compress", "--compress-format", "zip"],
            "cannot be combined",
        ),
        (
            "restored.zip",
            &["--no-compress", "--compress-codec", "store"],
            "cannot be combined",
        ),
        (
            "restored.zip",
            &["--compress-codec", "lzma2"],
            "unsupported zip codec",
        ),
        (
            "restored.zip",
            &["--compress-codec", "deflate:100"],
            "compression level 100 is invalid",
        ),
        (
            "restored.zip",
            &["--compress-codec", "store", "--compress-level", "max"],
            "does not accept --compress-level",
        ),
    ];
    for (name, options, expected) in cases {
        let output = temp.child(name);
        fs::write(output.path(), b"keep existing output").expect("output fixture");
        let report = undo_report(&rom, &patch, output.path(), options, 1);
        let label = report["label"].as_str().expect("label");
        assert!(label.contains(expected), "{name}: {label}");
        assert_eq!(
            fs::read(output.path()).expect("output"),
            b"keep existing output"
        );
        assert_eq!(fs::read(&rom).expect("ROM"), modified);
    }
}

#[test]
fn tools_ppf_undo_rejects_ambiguous_archives_and_accepts_payload_selectors() {
    let temp = setup_temp_dir();
    let (rom, patch, original, _) = undo_fixture(&temp);
    let alternative_rom = temp.child("another.gba");
    let alternative_patch = temp.child("another.ppf");
    fs::write(alternative_rom.path(), b"WRONG ROM").expect("alternative ROM");
    fs::write(alternative_patch.path(), b"WRONG PATCH").expect("alternative patch");
    let rom_archive = temp.child("roms.tar.gz");
    let patch_archive = temp.child("patches.tar.gz");
    write_tar_gz_fixture(
        &[
            (&rom, "nested/patched.gba"),
            (alternative_rom.path(), "another.gba"),
        ],
        rom_archive.path(),
    );
    write_tar_gz_fixture(
        &[
            (&patch, "nested/undo.ppf"),
            (alternative_patch.path(), "another.ppf"),
        ],
        patch_archive.path(),
    );
    let output = temp.child("restored.gba");
    fs::write(output.path(), b"keep output").expect("output fixture");
    for (input, patch_input) in [
        (rom_archive.path(), patch.as_path()),
        (rom.as_path(), patch_archive.path()),
    ] {
        let report = undo_report(input, patch_input, output.path(), &[], 1);
        assert!(
            report["label"]
                .as_str()
                .expect("label")
                .contains("payload resolution is ambiguous")
        );
        assert_eq!(fs::read(output.path()).expect("output"), b"keep output");
    }
    // The selector success case uses a fresh destination; the earlier failure
    // fixture remains user-owned and must never be overwritten.
    let selected_output = temp.child("selected.gba");
    let report = undo_report(
        rom_archive.path(),
        patch_archive.path(),
        selected_output.path(),
        &[
            "--select",
            "nested/patched.gba",
            "--patch-select",
            "nested/undo.ppf",
        ],
        0,
    );
    assert_eq!(report["status"], "succeeded");
    assert_eq!(fs::read(selected_output.path()).expect("output"), original);
    assert_eq!(
        fs::read(output.path()).expect("preserved output"),
        b"keep output"
    );
}

#[test]
fn tools_ppf_undo_compression_failure_preserves_existing_output() {
    let temp = setup_temp_dir();
    let (rom, patch, _, _) = undo_fixture(&temp);
    let output = temp.child("restored.rvz");
    fs::write(output.path(), b"keep existing output").expect("output fixture");
    let report = undo_report(&rom, &patch, output.path(), &[], 1);
    assert_eq!(report["stage"], "compress");
    assert_eq!(
        fs::read(output.path()).expect("output"),
        b"keep existing output"
    );
}

#[test]
fn tools_ppf_undo_checks_alias_after_appending_compressed_output_extension() {
    let temp = setup_temp_dir();
    let (rom, patch, _, _) = undo_fixture(&temp);
    let archive = temp.child("source.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            rom.to_str().expect("ROM"),
            "--output",
            archive.path().to_str().expect("archive"),
            "--codec",
            "store",
        ],
        0,
    );
    let archive_bytes = fs::read(archive.path()).expect("archive fixture");
    let report = undo_report(
        archive.path(),
        &patch,
        temp.child("source").path(),
        &["--compress-format", "zip"],
        1,
    );
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("resolve to the same file")
    );
    assert_eq!(fs::read(archive.path()).expect("archive"), archive_bytes);
}

#[test]
fn tools_ppf_undo_no_extract_rejects_a_packed_patch() {
    let temp = setup_temp_dir();
    let (rom, patch, _, _) = undo_fixture(&temp);
    let patch_archive = temp.child("patch.tar.gz");
    write_tar_gz_fixture(&[(&patch, "undo.ppf")], patch_archive.path());
    let output = temp.child("restored.gba");
    let report = undo_report(
        &rom,
        patch_archive.path(),
        output.path(),
        &["--no-extract"],
        1,
    );
    assert_eq!(report["status"], "failed");
    assert!(!output.path().exists());
}

#[test]
fn tools_ppf_undo_compressed_stdout_is_a_complete_archive() {
    let temp = setup_temp_dir();
    let (rom, patch, original, _) = undo_fixture(&temp);
    let stdout = command_stdout(
        &[
            "tools",
            "ppf-undo",
            "--input",
            rom.to_str().expect("ROM"),
            "--patch",
            patch.to_str().expect("patch"),
            "--output",
            "-",
            "--compress-format",
            "zip",
            "--compress-codec",
            "store",
        ],
        0,
    );
    assert!(stdout.starts_with(b"PK"));
    let archive = temp.child("stdout.zip");
    fs::write(archive.path(), stdout).expect("stdout archive");
    let unpacked = temp.child("unpacked");
    command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("archive"),
            "--output",
            unpacked.path().to_str().expect("unpacked"),
        ],
        0,
    );
    assert_eq!(
        fs::read(unpacked.path().join("payload.gba")).expect("restored ROM"),
        original
    );
}

#[test]
fn tools_ppf_undo_stdout_requires_an_explicit_output_mode() {
    let temp = setup_temp_dir();
    let (rom, patch, _, _) = undo_fixture(&temp);
    let stdout = command_stdout(
        &[
            "tools",
            "ppf-undo",
            "--input",
            rom.to_str().expect("ROM"),
            "--patch",
            patch.to_str().expect("patch"),
            "--output",
            "-",
        ],
        2,
    );
    assert!(stdout.is_empty());
}

#[test]
fn tools_ppf_undo_matching_bin_extension_requires_explicit_raw_output() {
    let temp = setup_temp_dir();
    let (rom, patch, original, _) = undo_fixture(&temp);
    let bin = temp.child("patched.bin");
    fs::copy(&rom, bin.path()).expect("BIN fixture");
    let output = temp.child("restored.bin");
    fs::write(output.path(), b"keep output").expect("output fixture");
    let report = undo_report(bin.path(), &patch, output.path(), &[], 1);
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("ambiguous between a raw ROM and a disc image")
    );
    assert_eq!(fs::read(output.path()).expect("output"), b"keep output");
    let raw_output = temp.child("restored-raw.bin");
    undo_report(bin.path(), &patch, raw_output.path(), &["--no-compress"], 0);
    assert_eq!(fs::read(raw_output.path()).expect("output"), original);
    assert_eq!(
        fs::read(output.path()).expect("preserved output"),
        b"keep output"
    );
}

#[test]
fn tools_ppf_undo_disc_target_restores_one_track_and_keeps_other_tracks() {
    let temp = setup_temp_dir();
    let (track01, original_track02) = super::patch_disc::write_two_track_cd(&temp);
    let mut modified_track02 = original_track02.clone();
    modified_track02[100..103].copy_from_slice(b"XYZ");
    fs::write(temp.child("track02.bin").path(), &modified_track02).expect("patched track");
    let patch = temp.child("undo.ppf");
    fs::write(
        patch.path(),
        build_ppf3_undo_patch(&[(100, b"XYZ".to_vec(), original_track02[100..103].to_vec())]),
    )
    .expect("patch");
    let sheet = temp.child("disc.cue");
    let output = temp.child("restored/disc.cue");
    let report = undo_report(
        sheet.path(),
        patch.path(),
        output.path(),
        &["--no-compress"],
        1,
    );
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("pass --target")
    );
    assert!(!output.path().exists());
    let report = undo_report(
        sheet.path(),
        patch.path(),
        output.path(),
        &["--no-extract", "--no-compress", "--target", "track02.bin"],
        0,
    );
    assert_eq!(report["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("restored/track01.bin").path()).expect("track01"),
        track01
    );
    assert_eq!(
        fs::read(temp.child("restored/track02.bin").path()).expect("track02"),
        original_track02
    );
    assert_eq!(
        fs::read(temp.child("track02.bin").path()).expect("source track02"),
        modified_track02
    );
    assert_eq!(
        report["details"]["emitted_files"]
            .as_array()
            .expect("files")
            .len(),
        3
    );
    let alias_output = temp.child("another.cue");
    let report = undo_report(
        sheet.path(),
        patch.path(),
        alias_output.path(),
        &["--no-compress", "--target", "track02.bin"],
        1,
    );
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("resolve to the same file")
    );
    assert!(!alias_output.path().exists());
    assert_eq!(
        fs::read(temp.child("track02.bin").path()).expect("source track02"),
        modified_track02
    );
}

#[test]
fn tools_ppf_undo_extracts_chd_and_recompresses_the_restored_disc() {
    let temp = setup_temp_dir();
    let track = temp.child("disc.bin");
    let cue = temp.child("disc.cue");
    let original = (0..8 * 2352)
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(track.path(), &original).expect("original track");
    cue.write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue");
    let expected = temp.child("expected.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            cue.path().to_str().expect("cue"),
            "--output",
            expected.path().to_str().expect("expected"),
            "--codec",
            "zstd",
            "--threads",
            "1",
        ],
        0,
    );
    let mut modified = original.clone();
    modified[100..103].copy_from_slice(b"XYZ");
    fs::write(track.path(), &modified).expect("patched track");
    let packed = temp.child("patched.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            cue.path().to_str().expect("cue"),
            "--output",
            packed.path().to_str().expect("packed"),
            "--codec",
            "zstd",
            "--threads",
            "1",
        ],
        0,
    );
    let patch = temp.child("undo.ppf");
    fs::write(
        patch.path(),
        build_ppf3_undo_patch(&[(100, b"XYZ".to_vec(), original[100..103].to_vec())]),
    )
    .expect("patch");
    let output = temp.child("restored.chd");
    let report = undo_report(
        packed.path(),
        patch.path(),
        output.path(),
        &["--compress-codec", "zstd", "--threads", "1"],
        0,
    );
    assert_eq!(report["status"], "succeeded");
    assert_eq!(
        fs::read(output.path()).expect("restored CHD"),
        fs::read(expected.path()).expect("expected CHD")
    );
    assert_eq!(fs::read(track.path()).expect("source track"), modified);
}

#[test]
fn tools_ppf_undo_disc_warnings_and_invalid_targets_match_apply() {
    let temp = setup_temp_dir();
    let (_, original_track02) = super::patch_disc::write_two_track_cd(&temp);
    let patch = temp.child("undo.ppf");
    fs::write(
        patch.path(),
        build_ppf3_undo_patch(&[(100, original_track02[100..103].to_vec(), b"AAA".to_vec())]),
    )
    .expect("patch");
    let loose = temp.child("unreferenced.bin");
    fs::write(loose.path(), b"unrelated bytes").expect("loose track");
    let output = temp.child("restored/disc.cue");
    let sheet = temp.child("disc.cue");
    for (target, expected) in [
        ("missing.bin", "matched none"),
        ("track*.bin", "matched 2 tracks"),
    ] {
        let report = undo_report(
            sheet.path(),
            patch.path(),
            output.path(),
            &["--no-compress", "--target", target],
            1,
        );
        assert!(report["label"].as_str().expect("label").contains(expected));
        assert!(!output.path().exists());
    }
    let report = undo_report(
        sheet.path(),
        patch.path(),
        output.path(),
        &["--no-compress", "--target", "track02.bin"],
        0,
    );
    assert!(
        report["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|warning| warning
                .as_str()
                .is_some_and(|warning| warning.contains("ignored 1 unreferenced data file")))
    );
    let invalid_output = temp.child("invalid.bin");
    let report = undo_report(
        sheet.path(),
        patch.path(),
        invalid_output.path(),
        &["--no-compress", "--target", "track02.bin"],
        1,
    );
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("must be a .cue/.gdi path")
    );
    assert!(!invalid_output.path().exists());
    let report = undo_report(
        temp.child("track02.bin").path(),
        patch.path(),
        invalid_output.path(),
        &["--no-compress", "--target", "track02.bin"],
        1,
    );
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("--target requires a disc-sheet")
    );
}

#[test]
fn tools_ppf_undo_invalid_patch_preserves_existing_compressed_destination() {
    let temp = setup_temp_dir();
    let (rom, patch, _, _) = undo_fixture(&temp);
    let output = temp.child("restored.zip");
    for (patch_bytes, expected) in [
        (
            build_ppf3_patch_without_undo(&[]),
            "does not contain complete undo data",
        ),
        (
            build_ppf3_undo_patch(&[(1000, b"X".to_vec(), b"A".to_vec())]),
            "exceeds ROM bounds",
        ),
        (b"invalid patch".to_vec(), "too small"),
    ] {
        fs::write(&patch, patch_bytes).expect("invalid patch fixture");
        fs::write(output.path(), b"keep output").expect("output fixture");
        let report = undo_report(&rom, &patch, output.path(), &[], 1);
        assert!(report["label"].as_str().expect("label").contains(expected));
        assert_eq!(fs::read(output.path()).expect("output"), b"keep output");
    }
}

#[test]
fn tools_ppf_undo_extracts_rvz_iso_payload_and_compresses_restored_output() {
    let temp = setup_temp_dir();
    let original = build_test_gamecube_iso(512 * 1024);
    let mut modified = original.clone();
    modified[0x500..0x503].copy_from_slice(b"XYZ");
    let iso = temp.child("patched.iso");
    fs::write(iso.path(), &modified).expect("ISO fixture");
    let packed = temp.child("patched.rvz");
    command_stdout(
        &[
            "compress",
            "--input",
            iso.path().to_str().expect("ISO"),
            "--output",
            packed.path().to_str().expect("RVZ"),
            "--threads",
            "1",
        ],
        0,
    );
    let patch = temp.child("undo.ppf");
    fs::write(
        patch.path(),
        build_ppf3_undo_patch(&[(0x500, b"XYZ".to_vec(), original[0x500..0x503].to_vec())]),
    )
    .expect("PPF fixture");
    let output = temp.child("restored.zip");
    let report = undo_report(
        packed.path(),
        patch.path(),
        output.path(),
        &["--compress-codec", "store", "--threads", "1"],
        0,
    );
    assert_eq!(report["status"], "succeeded");
    let unpacked = temp.child("unpacked");
    command_stdout(
        &[
            "extract",
            "--input",
            output.path().to_str().expect("output"),
            "--output",
            unpacked.path().to_str().expect("unpacked"),
        ],
        0,
    );
    assert_eq!(
        fs::read(unpacked.path().join("restored.iso")).expect("restored ISO"),
        original
    );
    assert_eq!(fs::read(iso.path()).expect("source ISO"), modified);
}

#[test]
fn tools_ppf_undo_preserves_existing_outputs_for_valid_patches() {
    let temp = setup_temp_dir();
    let (rom, patch, _, modified) = undo_fixture(&temp);
    let patch_bytes = fs::read(&patch).expect("patch fixture");
    for (name, options, final_name) in [
        ("restored.gba", vec!["--no-compress"], "restored.gba"),
        ("restored.zip", vec![], "restored.zip"),
        ("appended", vec!["--compress-format", "zip"], "appended.zip"),
    ] {
        let output = temp.child(name);
        let destination = temp.child(final_name);
        fs::write(destination.path(), b"existing user output").expect("existing output");
        let report = undo_report(&rom, &patch, output.path(), &options, 1);
        assert!(
            report["label"]
                .as_str()
                .expect("label")
                .contains("refusing to overwrite")
        );
        assert_eq!(
            fs::read(destination.path()).expect("preserved output"),
            b"existing user output"
        );
        assert_eq!(fs::read(&rom).expect("source ROM"), modified);
        assert_eq!(fs::read(&patch).expect("source patch"), patch_bytes);
    }
}

#[test]
fn tools_ppf_undo_disc_collision_preserves_all_existing_outputs() {
    let temp = setup_temp_dir();
    let (track01, track02) = super::patch_disc::write_two_track_cd(&temp);
    let patch = temp.child("undo.ppf");
    fs::write(
        patch.path(),
        build_ppf3_undo_patch(&[(100, track02[100..103].to_vec(), b"AAA".to_vec())]),
    )
    .expect("valid patch");
    let sheet = temp.child("disc.cue");
    let sheet_bytes = fs::read(sheet.path()).expect("source sheet");
    let patch_bytes = fs::read(patch.path()).expect("source patch");
    for (index, name) in ["disc.cue", "track01.bin", "track02.bin"]
        .iter()
        .enumerate()
    {
        let directory = temp.child(format!("restored-{index}"));
        fs::create_dir(directory.path()).expect("output directory");
        let existing = directory.path().join(name);
        fs::write(&existing, b"existing disc output").expect("existing output");
        let report = undo_report(
            sheet.path(),
            patch.path(),
            &directory.path().join("disc.cue"),
            &["--no-compress", "--target", "track02.bin"],
            1,
        );
        assert!(
            report["label"]
                .as_str()
                .expect("label")
                .contains("refusing to overwrite")
        );
        assert_eq!(
            fs::read(&existing).expect("preserved output"),
            b"existing disc output"
        );
        assert_eq!(
            fs::read_dir(directory.path())
                .expect("output directory")
                .count(),
            1,
            "collision must be detected before publishing any disc files"
        );
    }
    assert_eq!(fs::read(sheet.path()).expect("source sheet"), sheet_bytes);
    assert_eq!(fs::read(patch.path()).expect("source patch"), patch_bytes);
    assert_eq!(
        fs::read(temp.child("track01.bin").path()).expect("source track"),
        track01
    );
    assert_eq!(
        fs::read(temp.child("track02.bin").path()).expect("source track"),
        track02
    );
}

#[cfg(unix)]
#[test]
fn tools_ppf_undo_preserves_existing_and_dangling_output_symlinks() {
    let temp = setup_temp_dir();
    let (rom, patch, _, _) = undo_fixture(&temp);
    for present in [true, false] {
        let target = temp.child(format!("target-{present}.gba"));
        if present {
            fs::write(target.path(), b"keep symlink target").expect("target fixture");
        }
        let output = temp.child(format!("output-{present}.gba"));
        std::os::unix::fs::symlink(target.path(), output.path()).expect("output symlink");
        let report = undo_report(&rom, &patch, output.path(), &["--no-compress"], 1);
        assert!(
            report["label"]
                .as_str()
                .expect("label")
                .contains("refusing to overwrite")
        );
        assert_eq!(
            fs::read_link(output.path()).expect("preserved symlink"),
            target.path()
        );
        if present {
            assert_eq!(
                fs::read(target.path()).expect("target"),
                b"keep symlink target"
            );
        } else {
            assert!(!target.path().exists());
        }
    }
}

#[test]
fn tools_ppf_undo_preserves_existing_output_directory() {
    let temp = setup_temp_dir();
    let (rom, patch, _, _) = undo_fixture(&temp);
    let output = temp.child("restored.gba");
    fs::create_dir(output.path()).expect("output directory");
    fs::write(output.path().join("keep.txt"), b"keep directory contents")
        .expect("directory contents");
    let report = undo_report(&rom, &patch, output.path(), &["--no-compress"], 1);
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("refusing to overwrite")
    );
    assert_eq!(
        fs::read(output.path().join("keep.txt")).expect("preserved contents"),
        b"keep directory contents"
    );
}

#[test]
fn tools_ppf_undo_disc_with_parent_reference_checks_real_source_paths() {
    let temp = setup_temp_dir();
    let original = vec![b'A'; 4096];
    let mut modified = original.clone();
    modified[100..103].copy_from_slice(b"XYZ");
    fs::create_dir_all(temp.child("disc").path()).expect("disc dir");
    fs::create_dir_all(temp.child("shared").path()).expect("shared dir");
    fs::write(temp.child("shared/track.bin").path(), &modified).expect("track");
    temp.child("disc/game.cue")
        .write_str(
            "FILE \"../shared/track.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .expect("cue");
    let patch = temp.child("undo.ppf");
    fs::write(
        patch.path(),
        build_ppf3_undo_patch(&[(100, b"XYZ".to_vec(), b"AAA".to_vec())]),
    )
    .expect("patch");
    let sheet = temp.child("disc/game.cue");

    // Rebased output `disc/track.bin` is not the real source: must succeed.
    let output = temp.child("disc/restored.cue");
    let report = undo_report(
        sheet.path(),
        patch.path(),
        output.path(),
        &["--no-compress"],
        0,
    );
    assert_eq!(report["status"], "succeeded");
    assert_eq!(
        fs::read(temp.child("disc/track.bin").path()).expect("restored track"),
        original
    );
    assert_eq!(
        fs::read(temp.child("shared/track.bin").path()).expect("source track"),
        modified
    );

    // Output beside the real source would overwrite it: must be rejected.
    let output = temp.child("shared/restored.cue");
    let report = undo_report(
        sheet.path(),
        patch.path(),
        output.path(),
        &["--no-compress"],
        1,
    );
    assert!(
        report["label"]
            .as_str()
            .expect("label")
            .contains("resolve to the same file")
    );
    assert!(!output.path().exists());
    assert_eq!(
        fs::read(temp.child("shared/track.bin").path()).expect("source track"),
        modified
    );
}
