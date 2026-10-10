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
pub(super) fn write_two_track_cd(dir: &TempDir) -> (Vec<u8>, Vec<u8>) {
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
            temp.child("out/out.cue").path().to_str().expect("path"),
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
    temp.child("rom-weaver-weave.json")
        .write_str(
            r#"{
  "version": 1,
  "rom": { "name": "expected-track.bin" },
  "patches": [{ "path": "update.dcp" }]
}"#,
        )
        .expect("weave");

    let out_dir = temp.child("out");
    fs::create_dir_all(out_dir.path()).expect("output dir");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--log-level",
            "warn",
            "patch",
            "apply",
            "--input",
            temp.child("disc.gdi").path().to_str().expect("path"),
            "--weave",
            temp.child("rom-weaver-weave.json")
                .path()
                .to_str()
                .expect("path"),
            "--no-compress",
            "--output",
            out_dir.child("disc.gdi").path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();
    let events = parse_json_lines(&output.stdout);
    let terminal = events.last().expect("terminal event");
    assert_patch_envelope(terminal, "patch-apply", "dcp", "succeeded");
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("weave ROM name mismatch")
            && stderr.contains("expected-track.bin")
            && stderr.contains("track03.bin"),
        "expected advisory name warning, got: {stderr}"
    );

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

#[test]
fn patch_apply_disc_preserves_existing_companion_without_force() {
    let temp = setup_temp_dir();
    write_two_track_cd(&temp);
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
    let output = temp.child("out/disc.cue");
    fs::create_dir_all(temp.child("out").path()).expect("output directory");
    fs::write(temp.child("out/track02.bin").path(), b"existing companion").expect("sentinel");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().unwrap(),
            "--patch",
            temp.child("update.ips").path().to_str().unwrap(),
            "--target",
            "*track02*",
            "--no-compress",
            "--output",
            output.path().to_str().unwrap(),
            "--json",
        ],
        1,
    );
    assert_eq!(
        fs::read(temp.child("out/track02.bin").path()).unwrap(),
        b"existing companion"
    );
    assert!(
        !output.path().exists(),
        "a conflict must not publish the primary sheet"
    );
    assert!(
        !temp.child("out/track01.bin").path().exists(),
        "preflight must check every companion"
    );
}

#[test]
fn patch_apply_disc_force_preserves_source_tracks() {
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
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().unwrap(),
            "--patch",
            temp.child("update.ips").path().to_str().unwrap(),
            "--target",
            "*track02*",
            "--no-compress",
            "--force",
            "--output",
            temp.child("patched.cue").path().to_str().unwrap(),
            "--json",
        ],
        1,
    );
    assert_eq!(fs::read(temp.child("track01.bin").path()).unwrap(), track01);
    assert_eq!(fs::read(temp.child("track02.bin").path()).unwrap(), track02);
    assert!(!temp.child("patched.cue").path().exists());
}

#[test]
fn patch_apply_disc_force_replaces_unrelated_companions() {
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
    fs::create_dir_all(temp.child("out").path()).expect("output directory");
    fs::write(
        temp.child("out/track02.bin").path(),
        b"replace this companion",
    )
    .expect("sentinel");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().unwrap(),
            "--patch",
            temp.child("update.ips").path().to_str().unwrap(),
            "--target",
            "*track02*",
            "--no-compress",
            "--force",
            "--output",
            temp.child("out/disc.cue").path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(temp.child("out/track01.bin").path()).unwrap(),
        track01
    );
    assert_eq!(
        fs::read(temp.child("out/track02.bin").path()).unwrap(),
        apply_ips_literal(track02.clone(), DISC_PATCH_OFFSET, &disc_patch_payload())
    );
    assert_eq!(fs::read(temp.child("track02.bin").path()).unwrap(), track02);
}

#[test]
fn patch_apply_disc_force_preserves_hard_linked_source_track() {
    let temp = setup_temp_dir();
    let (_, track02) = write_two_track_cd(&temp);
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
    fs::create_dir_all(temp.child("out").path()).expect("output directory");
    fs::hard_link(
        temp.child("track02.bin").path(),
        temp.child("out/track02.bin").path(),
    )
    .expect("source alias");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().unwrap(),
            "--patch",
            temp.child("update.ips").path().to_str().unwrap(),
            "--target",
            "*track02*",
            "--no-compress",
            "--force",
            "--output",
            temp.child("out/disc.cue").path().to_str().unwrap(),
            "--json",
        ],
        1,
    );
    assert_eq!(fs::read(temp.child("track02.bin").path()).unwrap(), track02);
    assert!(!temp.child("out/disc.cue").path().exists());
    assert!(!temp.child("out/track01.bin").path().exists());
}

#[test]
#[cfg(unix)]
fn patch_apply_disc_preserves_dangling_companion_link() {
    let temp = setup_temp_dir();
    write_two_track_cd(&temp);
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
    fs::create_dir_all(temp.child("out").path()).expect("output directory");
    let missing = temp.child("missing.bin");
    std::os::unix::fs::symlink(missing.path(), temp.child("out/track02.bin").path())
        .expect("dangling link");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().unwrap(),
            "--patch",
            temp.child("update.ips").path().to_str().unwrap(),
            "--target",
            "*track02*",
            "--no-compress",
            "--output",
            temp.child("out/disc.cue").path().to_str().unwrap(),
            "--json",
        ],
        1,
    );
    assert!(!missing.path().exists());
    assert_eq!(
        fs::read_link(temp.child("out/track02.bin").path()).unwrap(),
        missing.path()
    );
    assert!(!temp.child("out/disc.cue").path().exists());
    assert!(!temp.child("out/track01.bin").path().exists());
}

#[test]
fn patch_apply_dcp_obeys_companion_overwrite_policy() {
    for (force, beside_source, expected_code) in
        [(false, false, 1), (true, false, 0), (true, true, 1)]
    {
        let temp = setup_temp_dir();
        let cooked = build_iso(
            &[IsoFile {
                path: "KEEP.DAT".to_string(),
                data: b"source file".to_vec(),
            }],
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
                    sector.try_into().expect("sector"),
                )
            })
            .collect::<Vec<_>>();
        fs::write(temp.child("track03.bin").path(), &raw).expect("source track");
        temp.child("disc.gdi")
            .write_str("1\n3 45000 4 2352 track03.bin 0\n")
            .expect("source GDI");
        temp.child("NEW.DAT")
            .write_str("added file")
            .expect("patch payload");
        command_stdout(
            &[
                "compress",
                "--input",
                temp.child("NEW.DAT").path().to_str().unwrap(),
                "--format",
                "zip",
                "--output",
                temp.child("update.dcp").path().to_str().unwrap(),
                "--json",
            ],
            0,
        );
        let output = temp.child(if beside_source {
            "patched.gdi"
        } else {
            "out/patched.gdi"
        });
        if !beside_source {
            fs::create_dir_all(temp.child("out").path()).expect("output directory");
            fs::write(temp.child("out/track03.bin").path(), b"existing companion")
                .expect("sentinel");
        }
        let input = temp.child("disc.gdi");
        let patch = temp.child("update.dcp");
        let mut args = vec![
            "patch",
            "apply",
            "--input",
            input.path().to_str().unwrap(),
            "--patch",
            patch.path().to_str().unwrap(),
            "--no-compress",
            "--output",
            output.path().to_str().unwrap(),
            "--json",
        ];
        if force {
            args.push("--force");
        }
        command_stdout(&args, expected_code);
        assert_eq!(
            fs::read(temp.child("track03.bin").path()).unwrap(),
            raw,
            "source track must never change"
        );
        if expected_code != 0 {
            assert!(
                !output.path().exists(),
                "a conflict must not publish a primary sheet"
            );
            if !beside_source {
                assert_eq!(
                    fs::read(temp.child("out/track03.bin").path()).unwrap(),
                    b"existing companion"
                );
            }
        } else {
            let mut rebuilt = GdRomFs::open(
                File::open(temp.child("out/track03.bin").path()).unwrap(),
                GD_HIGH_DENSITY_START_LBA,
            )
            .unwrap();
            let entry = rebuilt.file("NEW.DAT").unwrap().clone();
            assert_eq!(rebuilt.read_file(&entry).unwrap(), b"added file");
        }
    }
}

#[test]
fn patch_apply_disc_force_preserves_companion_aliasing_patch() {
    let temp = setup_temp_dir();
    write_two_track_cd(&temp);
    let patch = build_ips_patch(
        vec![TestIpsRecord::Literal {
            offset: DISC_PATCH_OFFSET as u32,
            data: disc_patch_payload(),
        }],
        None,
    );
    fs::write(temp.child("update.ips").path(), &patch).expect("patch");
    fs::create_dir_all(temp.child("out").path()).expect("output directory");
    fs::hard_link(
        temp.child("update.ips").path(),
        temp.child("out/track02.bin").path(),
    )
    .expect("patch alias");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("disc.cue").path().to_str().unwrap(),
            "--patch",
            temp.child("update.ips").path().to_str().unwrap(),
            "--target",
            "*track02*",
            "--no-compress",
            "--force",
            "--output",
            temp.child("out/disc.cue").path().to_str().unwrap(),
            "--json",
        ],
        1,
    );
    assert_eq!(fs::read(temp.child("update.ips").path()).unwrap(), patch);
    assert!(!temp.child("out/disc.cue").path().exists());
    assert!(!temp.child("out/track01.bin").path().exists());
}

#[test]
fn patch_apply_disc_force_rejects_primary_companion_name_collision() {
    for (sheet_name, sibling_name, output_name) in [
        ("disc.cue", "disc.gdi", "out/disc.gdi"),
        ("disc.cue", "disc.gdi", "out/DISC.GDI"),
        ("Ä.cue", "Ä.gdi", "out/ä.gdi"),
        ("Ä.cue", "Ä.gdi", "out/A\u{0308}.gdi"),
    ] {
        let temp = setup_temp_dir();
        write_two_track_cd(&temp);
        if sheet_name != "disc.cue" {
            fs::rename(temp.child("disc.cue").path(), temp.child(sheet_name).path())
                .expect("sheet name");
        }
        temp.child(sibling_name)
            .write_str("2\n1 0 4 2352 track01.bin 0\n2 8 0 2352 track02.bin 0\n")
            .expect("sibling GDI");
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
        let result = command_stdout(
            &[
                "patch",
                "apply",
                "--input",
                temp.child(sheet_name).path().to_str().unwrap(),
                "--patch",
                temp.child("update.ips").path().to_str().unwrap(),
                "--target",
                "*track02*",
                "--no-compress",
                "--force",
                "--output",
                temp.child(output_name).path().to_str().unwrap(),
                "--json",
            ],
            1,
        );
        assert!(
            parse_single_json_line(&result)["label"]
                .as_str()
                .unwrap()
                .contains("conflicts with another disc output")
        );
        assert!(
            !temp.child(output_name).path().exists(),
            "collision preflight must not publish {output_name}"
        );
        assert!(!temp.child("out/track01.bin").path().exists());
        assert!(!temp.child("out/track02.bin").path().exists());
    }
}

#[test]
fn patch_apply_disc_preserves_distinct_unicode_sheet_extensions() {
    let temp = setup_temp_dir();
    let (track01, track02) = write_two_track_cd(&temp);
    fs::rename(temp.child("disc.cue").path(), temp.child("Ä.cue").path()).expect("Unicode primary");
    temp.child("Ä.gdi")
        .write_str("2\n1 0 4 2352 track01.bin 0\n2 8 0 2352 track02.bin 0\n")
        .expect("Unicode sibling");
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
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            temp.child("Ä.cue").path().to_str().unwrap(),
            "--patch",
            temp.child("update.ips").path().to_str().unwrap(),
            "--target",
            "*track02*",
            "--no-compress",
            "--output",
            temp.child("out/Ä.cue").path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(temp.child("out/Ä.cue").path()).unwrap(),
        fs::read(temp.child("Ä.cue").path()).unwrap()
    );
    assert_eq!(
        fs::read(temp.child("out/Ä.gdi").path()).unwrap(),
        fs::read(temp.child("Ä.gdi").path()).unwrap()
    );
    assert_eq!(
        fs::read(temp.child("out/track01.bin").path()).unwrap(),
        track01
    );
    assert_eq!(
        fs::read(temp.child("out/track02.bin").path()).unwrap(),
        apply_ips_literal(track02, DISC_PATCH_OFFSET, &disc_patch_payload())
    );
}

#[test]
fn patch_apply_disc_rebases_absolute_cue_references() {
    assert_rebased_disc_reference("cue", true, "original.bin");
}

#[test]
fn patch_apply_disc_rebases_parent_cue_references_inside_output_directory() {
    assert_rebased_disc_reference("cue", false, "original.bin");
}

#[test]
fn patch_apply_disc_rebases_absolute_gdi_references() {
    assert_rebased_disc_reference("gdi", true, "original.bin");
}

#[test]
fn patch_apply_disc_rebases_parent_gdi_references_inside_output_directory() {
    assert_rebased_disc_reference("gdi", false, "original.bin");
}

#[test]
fn patch_apply_disc_rebases_unicode_source_names_portably() {
    for name in ["Ä.bin", "ä.bin", "é.bin", "e\u{301}.bin", "日本語.bin"] {
        assert_rebased_disc_reference("cue", false, name);
    }
}

fn assert_rebased_disc_reference(extension: &str, absolute: bool, name: &str) {
    let temp = setup_temp_dir();
    let source = temp.child(format!("input/{name}"));
    fs::create_dir_all(temp.child("input/sheets").path()).expect("input directory");
    let original = vec![0x41; 2352 * 2];
    fs::write(source.path(), &original).expect("source track");
    let sheet = temp.child(format!("input/sheets/disc.{extension}"));
    let reference = if absolute {
        source.path().to_string_lossy().into_owned()
    } else {
        format!("../{name}")
    };
    let text = if extension == "cue" {
        format!(
            "REM preserve this comment\r\nFILE \"{reference}\" BINARY\r\n  TRACK 01 MODE1/2352\r\n    INDEX 01 00:00:00\r\n"
        )
    } else {
        format!("1\r\n1 0 4 2352 \"{reference}\" 0\r\n")
    };
    sheet.write_str(&text).expect("sheet");
    let patch = temp.child("change.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 100,
                data: b"patched".to_vec(),
            }],
            None,
        ),
    )
    .expect("patch");
    let output = temp.child(format!("output/sheets/disc.{extension}"));
    let scratch = temp.child("scratch");
    fs::create_dir(scratch.path()).expect("scratch");
    let result = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .env("TMPDIR", scratch.path())
        .env("TMP", scratch.path())
        .env("TEMP", scratch.path())
        .args([
            "patch",
            "apply",
            "--input",
            sheet.path().to_str().unwrap(),
            "--patch",
            patch.path().to_str().unwrap(),
            "--no-compress",
            "--output",
            output.path().to_str().unwrap(),
            "--json",
        ])
        .output()
        .expect("run patch apply");
    assert_eq!(
        fs::read(source.path()).expect("source"),
        original,
        "source bytes must remain unchanged"
    );
    assert_eq!(
        fs::read_to_string(sheet.path()).expect("source sheet"),
        text
    );
    assert!(
        result.status.success(),
        "valid source references must remain supported: {}",
        String::from_utf8_lossy(&result.stdout)
    );
    assert!(
        !temp.child(format!("output/{name}")).path().exists(),
        "track output must not escape the requested sheet directory"
    );
    let refs = rom_weaver_core::enumerate_disc_sheet_refs(output.path())
        .expect("output refs")
        .referenced_files;
    assert_eq!(refs.len(), 1);
    let output_name = &refs[0];
    assert!(output_name.is_ascii());
    assert_eq!(Path::new(output_name).components().count(), 1);
    if name.is_ascii() {
        assert_eq!(output_name, name);
    }
    assert_eq!(
        fs::read(temp.child("output/sheets").path().join(output_name)).expect("patched track"),
        apply_ips_literal(original, 100, b"patched")
    );
    assert_eq!(
        fs::read_to_string(output.path()).expect("sheet"),
        text.replace(&reference, output_name)
    );
}

#[test]
fn patch_apply_disc_rebases_colliding_names_across_cue_and_gdi() {
    let temp = setup_temp_dir();
    for folder in ["left", "right", "input"] {
        fs::create_dir_all(temp.child(folder).path()).expect("track directory");
        fs::write(
            temp.child(format!("{folder}/track.bin")).path(),
            vec![folder.as_bytes()[0]; 2352 * 2],
        )
        .expect("track");
    }
    let cue = temp.child("input/disc.cue");
    cue.write_str("REM ../left/track.bin must remain in this comment\nFILE \"../left/track.bin\" BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00\nFILE track.bin BINARY\n TRACK 02 AUDIO\n INDEX 01 00:00:00\n").expect("cue");
    temp.child("input/disc.gdi").write_str("3\n1 0 4 2352 \"../left/track.bin\" 0\n2 2 0 2352 track.bin 0\n3 45000 4 2352 \"../right/track.bin\" 0\n").expect("gdi");
    let patch = temp.child("change.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 100,
                data: b"patched".to_vec(),
            }],
            None,
        ),
    )
    .expect("patch");
    let output = temp.child("out/disc.cue");
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            cue.path().to_str().unwrap(),
            "--patch",
            patch.path().to_str().unwrap(),
            "--target",
            "../left/track.bin",
            "--no-compress",
            "--output",
            output.path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    let cue_refs = rom_weaver_core::enumerate_disc_sheet_refs(output.path())
        .expect("cue refs")
        .referenced_files;
    let gdi_refs = rom_weaver_core::enumerate_disc_sheet_refs(temp.child("out/disc.gdi").path())
        .expect("gdi refs")
        .referenced_files;
    assert_eq!(cue_refs, gdi_refs[..2]);
    assert_eq!(gdi_refs.len(), 3);
    assert_eq!(
        gdi_refs[1], "track.bin",
        "existing simple names retain priority"
    );
    let unique: std::collections::BTreeSet<_> = gdi_refs.iter().collect();
    assert_eq!(unique.len(), 3, "rebased names must not collide");
    for (index, folder) in ["left", "input", "right"].iter().enumerate() {
        let original = vec![folder.as_bytes()[0]; 2352 * 2];
        assert_eq!(
            fs::read(temp.child(format!("{folder}/track.bin")).path()).expect("source"),
            original
        );
        let expected = if index == 0 {
            apply_ips_literal(original, 100, b"patched")
        } else {
            original
        };
        assert_eq!(
            fs::read(temp.child("out").path().join(&gdi_refs[index])).expect("output track"),
            expected
        );
        assert_eq!(Path::new(&gdi_refs[index]).components().count(), 1);
    }
    assert!(
        fs::read_to_string(output.path())
            .expect("cue")
            .starts_with("REM ../left/track.bin must remain in this comment\n")
    );
}

#[test]
fn patch_apply_disc_rejects_references_that_differ_only_by_case_unless_same_file() {
    let temp = setup_temp_dir();
    fs::write(temp.child("a.bin").path(), vec![1u8; 2352 * 4]).expect("a.bin");
    let case_insensitive = temp.child("A.BIN").path().exists();
    if !case_insensitive {
        fs::write(temp.child("A.BIN").path(), vec![2u8; 2352 * 4]).expect("A.BIN");
    }
    temp.child("disc.cue")
        .write_str(
            "FILE a.bin BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE A.BIN BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n",
        )
        .expect("cue");
    let patch = temp.child("patch.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: DISC_PATCH_OFFSET as u32,
                data: disc_patch_payload(),
            }],
            None,
        ),
    )
    .expect("patch");
    let output = temp.child("out/disc.cue");
    let json = run_single_json_event(
        &[
            "patch",
            "apply",
            "--no-compress",
            "--target",
            "a.bin",
            "-i",
            temp.child("disc.cue").path().to_str().expect("cue path"),
            "--patch",
            patch.path().to_str().expect("patch path"),
            "-o",
            output.path().to_str().expect("output path"),
            "--jsonl",
        ],
        if case_insensitive { 0 } else { 1 },
    );
    assert_eq!(
        fs::read(temp.child("a.bin").path()).expect("original track"),
        vec![1u8; 2352 * 4]
    );
    if case_insensitive {
        assert_eq!(json["status"], "succeeded");
        assert_eq!(
            fs::read(temp.child("out/a.bin").path()).expect("patched track"),
            apply_ips_literal(
                vec![1u8; 2352 * 4],
                DISC_PATCH_OFFSET,
                &disc_patch_payload()
            )
        );
    } else {
        assert_eq!(json["status"], "failed");
        assert!(
            json["label"]
                .as_str()
                .expect("label")
                .contains("differ only by case")
        );
        assert!(!output.path().exists());
    }
}
