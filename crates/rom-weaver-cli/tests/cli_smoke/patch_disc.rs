use super::shared::*;
use rom_weaver_app::gdrom::{
    GD_HIGH_DENSITY_START_LBA, GdRomFs, IsoFile, IsoTimestamp, USER_DATA_SIZE, build_iso,
    encode_mode1_sector,
};

// ====================================================================
// Disc patch apply: a multi-track CD/GD disc (many .bin + .cue/.gdi) is a
// single logical ROM. `--target <glob>` selects one referenced track to
// patch; the full disc is reassembled (patched track + untouched tracks +
// sheet) and usually compressed to CHD.
// ====================================================================

/// Apply a single IPS literal record to `data` at `offset`, returning the
/// patched copy. Mirrors what `build_ips_patch` with one `Literal` produces.
fn apply_ips_literal(mut data: Vec<u8>, offset: usize, patch: &[u8]) -> Vec<u8> {
    data[offset..offset + patch.len()].copy_from_slice(patch);
    data
}

/// Write a two-track CD disc (`track01.bin` MODE1 + `track02.bin` AUDIO) plus
/// `disc.cue` into `dir`, returning the two tracks' original bytes.
fn write_two_track_cd(dir: &TempDir) -> (Vec<u8>, Vec<u8>) {
    let track01 = (0..(8 * 2352)).map(|i| (i % 211) as u8).collect::<Vec<_>>();
    let track02 = (0..(8 * 2352)).map(|i| (i % 173) as u8).collect::<Vec<_>>();
    fs::write(dir.child("track01.bin").path(), &track01).expect("track01");
    fs::write(dir.child("track02.bin").path(), &track02).expect("track02");
    dir.child("disc.cue")
        .write_str(
            "FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n",
        )
        .expect("cue fixture");
    (track01, track02)
}

const DISC_PATCH_OFFSET: usize = 100;
fn disc_patch_payload() -> Vec<u8> {
    vec![0xC3; 32]
}

#[test]
fn patch_apply_disc_cue_target_patches_one_track_and_matches_manual_chd() {
    let temp = setup_temp_dir();
    let (_track01, track02) = write_two_track_cd(&temp);
    let patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: DISC_PATCH_OFFSET as u32,
            data: disc_patch_payload(),
        }],
        None,
    );
    fs::write(temp.child("update.ips").path(), &patch).expect("patch fixture");

    let patched_chd = temp.child("disc.chd");
    let apply = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--target",
            "*track02*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--compress-format",
            "chd",
            "--compress-codec",
            "zstd",
            "--threads",
            "1",
            "--output",
            patched_chd.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let apply_json = parse_json_lines(&apply);
    let terminal = apply_json.last().expect("apply terminal event");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("compressed as chd"),
        "label was: {}",
        terminal["label"]
    );

    // Byte-parity: building the same disc by hand (track02 patched, track01
    // untouched) and compressing it with identical flags must produce a
    // byte-identical CHD. This proves the reassembled disc fed to the
    // compressor is exactly correct.
    let expected_dir = temp.child("expected");
    fs::create_dir_all(expected_dir.path()).expect("expected dir");
    fs::copy(
        temp.child("track01.bin").path(),
        expected_dir.child("track01.bin").path(),
    )
    .expect("copy track01");
    fs::write(
        expected_dir.child("track02.bin").path(),
        apply_ips_literal(track02, DISC_PATCH_OFFSET, &disc_patch_payload()),
    )
    .expect("patched track02");
    fs::copy(
        temp.child("disc.cue").path(),
        expected_dir.child("disc.cue").path(),
    )
    .expect("copy cue");
    let expected_chd = temp.child("expected.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            expected_dir
                .child("disc.cue")
                .path()
                .to_str()
                .expect("path"),
            "--format",
            "chd",
            "--codec",
            "zstd",
            "--threads",
            "1",
            "--output",
            expected_chd.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    assert_eq!(
        fs::read(patched_chd.path()).expect("patched chd"),
        fs::read(expected_chd.path()).expect("expected chd"),
        "disc-patch CHD must equal a manual patch+compress CHD"
    );
}

#[test]
fn patch_apply_disc_in_memory_and_on_disk_track_produce_identical_chd() {
    // The patched track is read in place for untouched tracks and sourced from
    // the freshly produced track: buffered in memory under the cap by default,
    // streamed from a temp file when forced over it
    // (ROM_WEAVER_DISC_TRACK_IN_MEMORY_LIMIT=0). Both must yield a
    // byte-identical CHD, proving the in-memory track source is byte-for-byte
    // equivalent to the on-disk one.
    let temp = setup_temp_dir();
    let (_track01, _track02) = write_two_track_cd(&temp);
    let patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: DISC_PATCH_OFFSET as u32,
            data: disc_patch_payload(),
        }],
        None,
    );
    fs::write(temp.child("update.ips").path(), &patch).expect("patch fixture");

    let run = |out_name: &str, force_on_disk: bool| -> Vec<u8> {
        let chd = temp.child(out_name);
        let mut command = Command::cargo_bin("rom-weaver").expect("binary");
        command.args([
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--target",
            "*track02*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--compress-format",
            "chd",
            "--compress-codec",
            "zstd",
            "--threads",
            "1",
            "--output",
            chd.path().to_str().expect("path"),
            "--json",
        ]);
        if force_on_disk {
            command.env("ROM_WEAVER_DISC_TRACK_IN_MEMORY_LIMIT", "0");
        }
        command.assert().code(0);
        fs::read(chd.path()).expect("chd output")
    };

    let in_memory = run("in_memory.chd", false);
    let on_disk = run("on_disk.chd", true);
    assert_eq!(
        in_memory, on_disk,
        "in-memory and on-disk patched-track sources must produce byte-identical CHD"
    );
}

#[test]
fn patch_apply_disc_target_matching_zero_tracks_fails() {
    let temp = setup_temp_dir();
    write_two_track_cd(&temp);
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![1],
            }],
            None,
        ),
    )
    .expect("patch");
    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--target",
            "*track99*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            temp.child("out.cue").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&out);
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("matched none"),
        "label was: {}",
        json["label"]
    );
}

#[test]
fn patch_apply_disc_target_matching_multiple_tracks_fails() {
    let temp = setup_temp_dir();
    write_two_track_cd(&temp);
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![1],
            }],
            None,
        ),
    )
    .expect("patch");
    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--target",
            "*track*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            temp.child("out.cue").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&out);
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("matched 2 tracks"),
        "label was: {}",
        json["label"]
    );
}

#[test]
fn patch_apply_disc_multi_track_requires_target() {
    let temp = setup_temp_dir();
    write_two_track_cd(&temp);
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![1],
            }],
            None,
        ),
    )
    .expect("patch");
    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            temp.child("out.cue").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&out);
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"].as_str().expect("label").contains("--target"),
        "label was: {}",
        json["label"]
    );
}

#[test]
fn patch_apply_disc_auto_targets_track_by_patch_source_crc32() {
    let temp = setup_temp_dir();
    let (_track01, track02) = write_two_track_cd(&temp);
    fs::write(
        temp.child("update[crc32:590df36b].ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");

    let out_dir = temp.child("out");
    fs::create_dir_all(out_dir.path()).expect("out dir");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--patch",
            temp.child("update[crc32:590df36b].ips")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--output",
            out_dir.child("disc.cue").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("track01.bin").path()).expect("track01"),
        (0..(8 * 2352)).map(|i| (i % 211) as u8).collect::<Vec<_>>()
    );
    assert_eq!(
        fs::read(out_dir.child("track02.bin").path()).expect("track02"),
        apply_ips_literal(track02, DISC_PATCH_OFFSET, &disc_patch_payload())
    );
}

#[test]
fn patch_apply_disc_auto_target_errors_when_checksum_matches_no_track() {
    let temp = setup_temp_dir();
    write_two_track_cd(&temp);
    fs::write(
        temp.child("update[crc32:00000000].ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");

    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--patch",
            temp.child("update[crc32:00000000].ips")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--output",
            temp.child("out.cue").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    assert!(
        parse_single_json_line(&out)["label"]
            .as_str()
            .expect("label")
            .contains("matched none")
    );
}

#[test]
fn patch_apply_disc_auto_target_errors_when_checksum_matches_multiple_tracks() {
    let temp = setup_temp_dir();
    let (track01, _) = write_two_track_cd(&temp);
    fs::write(temp.child("track02.bin").path(), &track01).expect("duplicate track");
    fs::write(
        temp.child("update[crc32:87987248].ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");

    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--patch",
            temp.child("update[crc32:87987248].ips")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--output",
            temp.child("out.cue").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    assert!(
        parse_single_json_line(&out)["label"]
            .as_str()
            .expect("label")
            .contains("matched 2 tracks")
    );
}

#[test]
fn patch_apply_disc_single_track_targets_implicitly() {
    let temp = setup_temp_dir();
    let track = (0..(8 * 2352)).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &track).expect("track");
    temp.child("disc.cue")
        .write_str("FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n")
        .expect("cue");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");

    let out_dir = temp.child("out");
    fs::create_dir_all(out_dir.path()).expect("out dir");
    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            out_dir.child("out.cue").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(
        parse_json_lines(&out).last().expect("terminal")["status"],
        "succeeded"
    );
    // The track is written beside the output sheet under its cue-referenced
    // name (`disc.bin`), and the renamed sheet is written too.
    assert_eq!(
        fs::read(out_dir.child("disc.bin").path()).expect("out track"),
        apply_ips_literal(track, DISC_PATCH_OFFSET, &disc_patch_payload())
    );
    assert!(out_dir.child("out.cue").path().is_file());
}

#[test]
fn patch_apply_target_requires_disc_sheet_input() {
    let temp = setup_temp_dir();
    fs::write(temp.child("input.bin").path(), b"abcdefgh").expect("input");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![1],
            }],
            None,
        ),
    )
    .expect("patch");
    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("input.bin").path().to_str().expect("path"),
            "--target",
            "*track02*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            temp.child("out.bin").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let json = parse_single_json_line(&out);
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requires a disc-sheet"),
        "label was: {}",
        json["label"]
    );
}

#[test]
fn patch_apply_disc_no_compress_writes_full_disc() {
    let temp = setup_temp_dir();
    let (track01, track02) = write_two_track_cd(&temp);
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");
    let out_dir = temp.child("out");
    fs::create_dir_all(out_dir.path()).expect("out dir");

    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--target",
            "*track02*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            out_dir.child("disc.cue").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    assert!(out_dir.child("disc.cue").path().is_file());
    assert_eq!(
        fs::read(out_dir.child("track01.bin").path()).expect("track01"),
        track01,
        "untouched track copied through unchanged"
    );
    assert_eq!(
        fs::read(out_dir.child("track02.bin").path()).expect("track02"),
        apply_ips_literal(track02, DISC_PATCH_OFFSET, &disc_patch_payload()),
        "target track patched"
    );
}

#[test]
fn patch_apply_disc_unreferenced_bin_warns_non_interactive() {
    let temp = setup_temp_dir();
    let (_t1, _t2) = write_two_track_cd(&temp);
    // A stray data file the cue does not reference.
    fs::write(temp.child("bonus.bin").path(), vec![0u8; 16]).expect("stray");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");

    let out = command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--target",
            "*track02*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            temp.child("out.cue").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let terminal = parse_json_lines(&out).last().cloned().expect("terminal");
    assert_eq!(terminal["status"], "succeeded");
    assert!(
        terminal["label"]
            .as_str()
            .expect("label")
            .contains("unreferenced data file"),
        "label was: {}",
        terminal["label"]
    );
}

#[test]
fn patch_apply_disc_gdi_target_patches_one_track() {
    let temp = setup_temp_dir();
    let track01 = (0..(4 * 2352)).map(|i| (i % 101) as u8).collect::<Vec<_>>();
    let track02 = (0..(8 * 2048)).map(|i| (i % 89) as u8).collect::<Vec<_>>();
    fs::write(temp.child("track01.bin").path(), &track01).expect("track01");
    fs::write(temp.child("track02.bin").path(), &track02).expect("track02");
    temp.child("disc.gdi")
        .write_str("2\n1 0 4 2352 track01.bin 0\n2 4 4 2048 track02.bin 0\n")
        .expect("gdi");
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");

    let out_dir = temp.child("out");
    fs::create_dir_all(out_dir.path()).expect("out dir");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--target",
            "*track02*",
            "--patch",
            temp.child("update.ips").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            out_dir.child("disc.gdi").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    assert_eq!(
        fs::read(out_dir.child("track01.bin").path()).expect("track01"),
        track01
    );
    assert_eq!(
        fs::read(out_dir.child("track02.bin").path()).expect("track02"),
        apply_ips_literal(track02, DISC_PATCH_OFFSET, &disc_patch_payload())
    );
}

#[test]
fn patch_apply_dcp_rebuilds_gdrom_through_cli() {
    let temp = setup_temp_dir();
    let source_files = [IsoFile {
        path: "KEEP.DAT".to_string(),
        data: b"source file".to_vec(),
    }];
    let cooked = build_iso(
        &source_files,
        GD_HIGH_DENSITY_START_LBA,
        IsoTimestamp::default(),
    )
    .expect("source ISO");
    let raw = cooked
        .chunks_exact(USER_DATA_SIZE)
        .enumerate()
        .flat_map(|(index, sector)| {
            encode_mode1_sector(
                GD_HIGH_DENSITY_START_LBA + index as u32,
                sector.try_into().expect("cooked sector"),
            )
        })
        .collect::<Vec<_>>();
    fs::write(temp.child("track03.bin").path(), raw).expect("source track");
    temp.child("disc.gdi")
        .write_str("1\n3 45000 4 2352 track03.bin 0\n")
        .expect("source GDI");

    let added = b"added by the DCP";
    fs::write(temp.child("NEW.DAT").path(), added).expect("DCP payload");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("NEW.DAT").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            temp.child("update.dcp").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("out");
    fs::create_dir_all(out_dir.path()).expect("output dir");
    let events = parse_json_lines(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--patch",
            temp.child("update.dcp").path().to_str().expect("path"),
            "--no-compress",
            "--output",
            out_dir.child("disc.gdi").path().to_str().expect("path"),
            "--json",
        ],
        0,
    ));
    let terminal = events.last().expect("terminal event");
    assert_patch_envelope(terminal, "patch-apply", "dcp", "succeeded");

    let mut rebuilt = GdRomFs::open(
        File::open(out_dir.child("track03.bin").path()).expect("rebuilt track"),
        GD_HIGH_DENSITY_START_LBA,
    )
    .expect("rebuilt filesystem");
    let added_entry = rebuilt.file("NEW.DAT").expect("added DCP file").clone();
    assert_eq!(rebuilt.read_file(&added_entry).expect("added bytes"), added);
    let kept_entry = rebuilt.file("KEEP.DAT").expect("kept source file").clone();
    assert_eq!(
        rebuilt.read_file(&kept_entry).expect("kept bytes"),
        b"source file"
    );
}
