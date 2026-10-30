use super::shared::*;

#[test]
fn inspect_aliases_probe() {
    command_stdout(&["inspect", "--help"], 0);
}

#[test]
fn probe_rejects_list_flag() {
    command_stdout(&["probe", "--input", "input.bin", "--list", "--json"], 2);
}

#[test]
fn probe_reports_known_container_as_supported() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder payload")
        .expect("fixture");
    let archive = temp.child("sample.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--no-extract",
            "--jsonl",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        json["details"]["container"]["recommended_compress_format"],
        "7z"
    );
    assert_eq!(json["details"]["container"]["reason"], "fallback-7z-lzma2");
    // probe is a strict superset of the former `list`: it enumerates the container's selectable
    // entries with no decompression.
    assert_eq!(json["details"]["container"]["entry_count"], 1);
    assert_eq!(json["details"]["container"]["entries"][0], "sample.bin");
    assert!(
        !json["label"]
            .as_str()
            .expect("label")
            .contains("recommended_compress_format")
    );
}

#[test]
fn probe_lists_selectable_zip_entries() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"payload").expect("fixture");
    let archive = temp.child("sample.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entry_count"], 1);
    assert_eq!(json["details"]["container"]["entries"][0], "sample.bin");
    assert_eq!(
        json["details"]["container"]["recommended_compress_format"],
        "7z"
    );
    assert_eq!(json["details"]["container"]["reason"], "fallback-7z-lzma2");
}

#[test]
fn probe_auto_extracts_single_payload() {
    let temp = setup_temp_dir();
    let payload = b"header-aware probe payload".to_vec();
    fs::write(temp.child("game.nes").path(), with_nes_header(&payload)).expect("fixture");
    let archive = temp.child("game.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "command");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("detected ROM header No-Intro_NES.xml"));
    assert!(label.contains("probe source resolved via 1 container extract step(s)"));
}

/// A cartridge ROM whose extension says nothing still reports its platform, so a
/// host can pick one identify database instead of loading every pack.
#[test]
fn probe_reports_the_platform_of_a_headered_rom_with_a_generic_extension() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("mystery.bin").path(),
        with_nes_header(b"payload"),
    )
    .expect("rom fixture");

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            temp.child("mystery.bin").path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );

    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["platform"], "Nintendo Entertainment System");
}

#[test]
fn probe_auto_extracts_nested_payload() {
    let temp = setup_temp_dir();
    let payload = b"nested header-aware probe payload".to_vec();
    fs::write(temp.child("game.nes").path(), with_nes_header(&payload)).expect("fixture");

    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let outer = temp.child("outer.7z");
    command_stdout(
        &[
            "compress",
            "--input",
            inner.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            outer.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "command");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("detected ROM header No-Intro_NES.xml"));
    assert!(label.contains("probe source resolved via 2 container extract step(s)"));
}

#[test]
fn probe_no_extract_reports_container_bytes() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.nes").path(), with_nes_header(b"payload")).expect("fixture");
    let archive = temp.child("game.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert!(
        !json["label"]
            .as_str()
            .expect("label")
            .contains("probe source resolved via")
    );
}

#[test]
fn probe_auto_extract_ambiguity_requires_select() {
    let temp = setup_temp_dir();
    fs::write(temp.child("alpha.nes").path(), with_nes_header(b"alpha")).expect("alpha fixture");
    fs::write(temp.child("beta.nes").path(), with_nes_header(b"beta")).expect("beta fixture");

    let archive = temp.child("dupe.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("alpha.nes").path().to_str().expect("path"),
            "--input",
            temp.child("beta.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let label = json["label"].as_str().expect("label");
    assert_eq!(json["command"], "probe");
    assert_eq!(json["status"], "failed");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("alpha.nes"));
    assert!(label.contains("beta.nes"));
    assert!(label.contains("--select"));
}

#[test]
fn probe_auto_extract_ignores_sidecars_unless_no_ignore() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("__MACOSX").path()).expect("__MACOSX dir");
    fs::write(temp.child("game.nes").path(), with_nes_header(b"payload")).expect("payload fixture");
    fs::write(temp.child("notes.txt").path(), b"notes").expect("txt sidecar");
    fs::write(temp.child("meta.json").path(), b"{}").expect("json sidecar");
    fs::write(temp.child("maxcso-report.bin").path(), b"skip me").expect("maxcso sidecar");
    fs::write(temp.child("__MACOSX/ghost.bin").path(), b"ghost").expect("macosx sidecar");

    let archive = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("notes.txt").path().to_str().expect("path"),
            "--input",
            temp.child("meta.json").path().to_str().expect("path"),
            "--input",
            temp.child("maxcso-report.bin")
                .path()
                .to_str()
                .expect("path"),
            "--input",
            temp.child("__MACOSX").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");

    let no_ignore_json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--no-ignore",
            "--json",
        ],
        1,
    );
    let no_ignore_label = no_ignore_json["label"].as_str().expect("label");
    assert_eq!(no_ignore_json["command"], "probe");
    assert_eq!(no_ignore_json["status"], "failed");
    assert!(no_ignore_label.contains("ambiguous"));
    assert!(no_ignore_label.contains("--select"));
}

#[test]
fn probe_auto_extract_patch_filter_selects_patch_payload() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified = temp.child("game-modified.bin");
    let patch = temp.child("update.bps");
    fs::write(original.path(), b"game payload").expect("original fixture");
    fs::write(modified.path(), b"game payload patched").expect("modified fixture");
    fs::write(temp.child("game.nes").path(), with_nes_header(b"rom")).expect("rom fixture");
    fs::write(temp.child("notes.txt").path(), b"notes").expect("notes fixture");

    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let archive = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            patch.path().to_str().expect("path"),
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("notes.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            archive.path().to_str().expect("path"),
            "--filter",
            "patch",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("probe source resolved via 1 container extract step(s)")
    );
}

#[test]
fn probe_auto_extract_rom_filter_prefers_rom_payload_over_archive() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("__MACOSX").path()).expect("__MACOSX dir");
    fs::write(temp.child("game.nes").path(), with_nes_header(b"rom")).expect("rom fixture");
    fs::write(temp.child("nested.nes").path(), with_nes_header(b"nested")).expect("nested fixture");
    fs::write(temp.child("._game.nes").path(), b"resource fork").expect("resource fork");
    fs::write(temp.child("maxcso-report.bin").path(), b"skip me").expect("maxcso sidecar");
    fs::write(temp.child("__MACOSX/ghost.nes").path(), b"ghost").expect("macosx sidecar");

    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let outer = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("._game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("maxcso-report.bin")
                .path()
                .to_str()
                .expect("path"),
            "--input",
            temp.child("__MACOSX").path().to_str().expect("path"),
            "--input",
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            outer.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("probe source resolved via 1 container extract step(s)"));
    assert!(!label.contains("2 container extract step"));
}

#[test]
fn probe_rom_filter_prefers_payload_entries_over_archive_fallback() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("__MACOSX").path()).expect("__MACOSX dir");
    fs::write(temp.child("game.nes").path(), with_nes_header(b"rom")).expect("rom fixture");
    fs::write(temp.child("nested.nes").path(), with_nes_header(b"nested")).expect("nested fixture");
    fs::write(temp.child("._game.nes").path(), b"resource fork").expect("resource fork");
    fs::write(temp.child("maxcso-report.bin").path(), b"skip me").expect("maxcso sidecar");
    fs::write(temp.child("__MACOSX/ghost.nes").path(), b"ghost").expect("macosx sidecar");

    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let outer = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("._game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("maxcso-report.bin")
                .path()
                .to_str()
                .expect("path"),
            "--input",
            temp.child("__MACOSX").path().to_str().expect("path"),
            "--input",
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            outer.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entries"][0], "game.nes");
    assert_eq!(json["details"]["container"]["entry_count"], 1);

    let no_ignore_json = run_single_json_event(
        &[
            "probe",
            "--input",
            outer.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--no-ignore",
            "--no-extract",
            "--json",
        ],
        0,
    );
    let entries = no_ignore_json["details"]["container"]["entries"]
        .as_array()
        .expect("entries");
    let entry_names = entries
        .iter()
        .map(|value| value.as_str().expect("entry"))
        .collect::<Vec<_>>();
    assert_eq!(no_ignore_json["details"]["container"]["entry_count"], 4);
    assert!(entry_names.contains(&"game.nes"));
    assert!(entry_names.contains(&"._game.nes"));
    assert!(entry_names.contains(&"maxcso-report.bin"));
    assert!(entry_names.contains(&"__MACOSX/ghost.nes"));
}

#[test]
fn probe_rom_filter_lists_archive_fallback_when_no_payload_matches() {
    let temp = setup_temp_dir();
    fs::write(temp.child("nested.nes").path(), with_nes_header(b"nested")).expect("nested fixture");

    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let outer = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            outer.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entries"][0], "inner.zip");
    assert_eq!(json["details"]["container"]["entry_count"], 1);
}

#[test]
fn extract_rom_filter_extracts_rom_entries_only() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.nes").path(), with_nes_header(b"rom")).expect("rom fixture");
    fs::write(temp.child("update.bps").path(), SIMPLE_BPS_PATCH).expect("patch fixture");
    fs::write(temp.child("notes.txt").path(), b"notes").expect("notes fixture");
    fs::write(temp.child("nested.nes").path(), with_nes_header(b"nested")).expect("nested fixture");

    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let archive = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("update.bps").path().to_str().expect("path"),
            "--input",
            temp.child("notes.txt").path().to_str().expect("path"),
            "--input",
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract-rom-filter");
    let json = run_single_json_event(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "extract");
    assert_eq!(json["status"], "succeeded");
    assert!(out_dir.child("game.nes").path().exists());
    assert!(!out_dir.child("update.bps").path().exists());
    assert!(!out_dir.child("notes.txt").path().exists());
    assert!(!out_dir.child("inner.zip").path().exists());
    assert!(!out_dir.child("nested.nes").path().exists());
}

#[test]
fn extract_multi_track_disc_is_one_rom_no_select_needed() {
    // A bin+cue disc carries several `.bin` tracks alongside a `.cue` sheet. The tracks would
    // each look like a competing payload, but the sheet marks them as one logical disc, so a
    // non-interactive extract pulls every member without an ambiguity/`--select` error.
    let temp = setup_temp_dir();
    fs::write(temp.child("track01.bin").path(), vec![0x11u8; 64]).expect("track01 fixture");
    fs::write(temp.child("track02.bin").path(), vec![0x22u8; 64]).expect("track02 fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n",
        )
        .expect("cue fixture");

    let archive = temp.child("disc.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--input",
            temp.child("track01.bin").path().to_str().expect("path"),
            "--input",
            temp.child("track02.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract-disc");
    let json = run_single_json_event(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "extract");
    assert_eq!(json["status"], "succeeded");
    // The whole disc lands: sheet plus every track, none dropped, none prompted for.
    assert!(out_dir.child("disc.cue").path().exists());
    assert!(out_dir.child("track01.bin").path().exists());
    assert!(out_dir.child("track02.bin").path().exists());
}

#[test]
fn probe_reports_rar_container_as_supported() {
    let temp = setup_temp_dir();
    let source = temp.child("version.rar");
    fs::copy(rar_fixture_path("version.rar"), source.path()).expect("copy fixture");

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            source.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rar");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn probe_reports_known_rom_header_as_supported() {
    let temp = setup_temp_dir();
    let payload = b"header-aware probe payload".to_vec();
    fs::write(temp.child("headered.nes").path(), with_nes_header(&payload)).expect("fixture");

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            temp.child("headered.nes").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "command");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("detected ROM header No-Intro_NES.xml"));
    assert!(label.contains("stripped_bytes=16"));
    assert!(label.contains("headered_extension=.nes"));
    assert!(label.contains("headerless_extension=.nes"));
}

#[test]
fn probe_reports_gba_header_profile() {
    let temp = setup_temp_dir();
    let rom = build_test_gba_rom(0x2000);
    fs::write(temp.child("test.gba").path(), rom).expect("fixture");

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            temp.child("test.gba").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "command");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("detected ROM header Game Boy Advance")
    );
}

#[test]
fn probe_reports_pbp_multi_disc_selectable_outputs() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 13);
    let disc2 = build_test_pbp_iso(80, 29);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let json = run_single_json_event(
        &[
            "probe",
            "--input",
            source.path().to_str().expect("path"),
            "--no-extract",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entry_count"], 4);
    let entries = json["details"]["container"]["entries"]
        .as_array()
        .expect("entries");
    let as_strings = entries
        .iter()
        .map(|value| value.as_str().expect("entry string"))
        .collect::<Vec<_>>();
    assert!(as_strings.contains(&"multi.disc01.cue"));
    assert!(as_strings.contains(&"multi.disc01.bin"));
    assert!(as_strings.contains(&"multi.disc02.cue"));
    assert!(as_strings.contains(&"multi.disc02.bin"));
}

#[test]
fn extract_ignores_common_sidecars_unless_no_ignore() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("__MACOSX").path()).expect("metadata dir");
    fs::write(temp.child("game.bin").path(), b"game payload").expect("game fixture");
    fs::write(temp.child("notes.txt").path(), b"notes").expect("txt sidecar");
    fs::write(temp.child("meta.json").path(), b"{}").expect("json sidecar");
    fs::write(temp.child("cover.jpg").path(), b"cover").expect("image sidecar");
    fs::write(temp.child("._game.bin").path(), b"resource fork").expect("resource fork");
    fs::write(temp.child("__MACOSX/ghost.bin").path(), b"ghost").expect("mac metadata");

    let archive = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
            "--input",
            temp.child("notes.txt").path().to_str().expect("path"),
            "--input",
            temp.child("meta.json").path().to_str().expect("path"),
            "--input",
            temp.child("cover.jpg").path().to_str().expect("path"),
            "--input",
            temp.child("._game.bin").path().to_str().expect("path"),
            "--input",
            temp.child("__MACOSX").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let default_out = temp.child("default-out");
    let default_output = command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            default_out.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let default_json = parse_single_json_line(&default_output);
    assert_eq!(default_json["command"], "extract");
    assert_eq!(default_json["status"], "succeeded");
    assert!(
        default_json["label"]
            .as_str()
            .expect("label")
            .contains("1 file(s)")
    );
    assert!(default_out.child("game.bin").path().exists());
    assert!(!default_out.child("notes.txt").path().exists());
    assert!(!default_out.child("meta.json").path().exists());
    assert!(!default_out.child("cover.jpg").path().exists());
    assert!(!default_out.child("._game.bin").path().exists());
    assert!(!default_out.child("__MACOSX/ghost.bin").path().exists());

    let no_ignore_out = temp.child("no-ignore-out");
    command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            no_ignore_out.path().to_str().expect("path"),
            "--no-ignore",
            "--json",
        ],
        0,
    );
    assert!(no_ignore_out.child("game.bin").path().exists());
    assert!(no_ignore_out.child("notes.txt").path().exists());
    assert!(no_ignore_out.child("meta.json").path().exists());
    assert!(no_ignore_out.child("cover.jpg").path().exists());
    assert!(no_ignore_out.child("._game.bin").path().exists());
    assert!(no_ignore_out.child("__MACOSX/ghost.bin").path().exists());
}

#[test]
fn extract_checksum_rom_only_hashes_rom_outputs_only() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("game.nes").path(),
        with_nes_header(b"checksum rom payload"),
    )
    .expect("rom fixture");
    fs::write(temp.child("readme.txt").path(), b"not a rom").expect("sidecar fixture");

    let archive = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("readme.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    let events = run_json_events(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--no-ignore",
            "--checksum-rom",
            "crc32",
            "--jsonl",
        ],
        0,
    );
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["status"], "succeeded");
    // ROM output is hashed and identified inline.
    let rom = emitted_file_entry(json, "game.nes");
    assert!(rom["checksums"]["crc32"].as_str().is_some());
    assert_eq!(rom["platform"], "Nintendo Entertainment System");
    // The non-ROM sidecar is extracted but never hashed.
    let sidecar = emitted_file_entry(json, "readme.txt");
    assert!(sidecar["checksums"].is_null());
}

#[test]
fn extract_emits_early_probe_manifest_for_rom_archive() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("game.nes").path(),
        with_nes_header(b"rom payload"),
    )
    .expect("rom fixture");
    fs::write(temp.child("readme.txt").path(), b"not a rom").expect("sidecar fixture");

    let archive = temp.child("weave.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--input",
            temp.child("readme.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract");
    let events = run_json_events(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    // The manifest streams before the terminal report so the host can route + render immediately.
    let manifest_index = events
        .iter()
        .position(|event| event["stage"] == "probe-manifest")
        .expect("expected an early probe-manifest event");
    let terminal_index = events
        .iter()
        .rposition(|event| event["status"] == "succeeded")
        .expect("expected a terminal succeeded event");
    assert!(
        manifest_index < terminal_index,
        "probe-manifest must precede the terminal report"
    );
    let manifest = &events[manifest_index]["details"]["probe_manifest"];
    assert_eq!(
        manifest["is_rom"], true,
        "ROM archive routes to the input bucket"
    );
    assert_eq!(events[manifest_index]["format"], "zip");
    let entries = manifest["entries"]
        .as_array()
        .expect("manifest entries array");
    let rom_entry = entries
        .iter()
        .find(|entry| entry["file_name"] == "game.nes")
        .expect("rom entry present in manifest");
    assert_eq!(rom_entry["kind"], "rom");
    // The early manifest classifies type + lists entries cheaply (no inner-payload decode); the
    // archived ROM's platform is filled at completion (emitted_files), not in the early manifest.
    assert!(manifest.get("platform").is_none());
}

#[test]
fn extract_streams_payload_identity_before_completion() {
    let temp = setup_temp_dir();
    // A payload larger than the 2 MiB identity-detect prefix, so the identity becomes determinable
    // mid-stream (before the whole file is extracted) and is surfaced in its own event.
    fs::write(
        temp.child("game.nes").path(),
        with_nes_header(&vec![0x42u8; 3 * 1024 * 1024]),
    )
    .expect("rom fixture");

    let archive = temp.child("big.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract-stream-identity");
    let events = run_json_events(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--checksum-rom",
            "crc32",
            "--jsonl",
        ],
        0,
    );
    // The platform is surfaced in a streaming `probe-identity` event that precedes the terminal report.
    let identity_index = events
        .iter()
        .position(|event| event["stage"] == "probe-identity")
        .expect("expected a streaming probe-identity event");
    let terminal_index = events
        .iter()
        .rposition(|event| event["status"] == "succeeded")
        .expect("expected a terminal succeeded event");
    assert!(
        identity_index < terminal_index,
        "identity must stream before completion"
    );
    assert_eq!(
        events[identity_index]["details"]["probe_manifest"]["platform"],
        "Nintendo Entertainment System"
    );
}

#[test]
fn extract_probe_manifest_marks_patch_only_archive_as_not_rom() {
    let temp = setup_temp_dir();
    let original = temp.child("game.bin");
    let modified = temp.child("game-modified.bin");
    let patch = temp.child("update.bps");
    fs::write(original.path(), b"game payload").expect("original fixture");
    fs::write(modified.path(), b"game payload patched").expect("modified fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().expect("path"),
            "--modified",
            modified.path().to_str().expect("path"),
            "--format",
            "bps",
            "--output",
            patch.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    fs::write(temp.child("notes.txt").path(), b"notes").expect("notes fixture");

    let archive = temp.child("patches.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            patch.path().to_str().expect("path"),
            "--input",
            temp.child("notes.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract-patch");
    let events = run_json_events(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let manifest = events
        .iter()
        .find(|event| event["stage"] == "probe-manifest")
        .map(|event| &event["details"]["probe_manifest"])
        .expect("expected an early probe-manifest event");
    // A weave that carries a patch and no ROM payload routes to the patch bucket.
    assert_eq!(manifest["is_rom"], false);
    let entries = manifest["entries"]
        .as_array()
        .expect("manifest entries array");
    let patch_entry = entries
        .iter()
        .find(|entry| entry["file_name"] == "update.bps")
        .expect("patch entry present in manifest");
    assert_eq!(patch_entry["kind"], "patch");
}

#[test]
fn extract_checksum_rom_skips_disc_sheet_but_hashes_tracks() {
    let temp = setup_temp_dir();
    fs::write(temp.child("track01.bin").path(), vec![0x11u8; 64]).expect("track01 fixture");
    fs::write(temp.child("track02.bin").path(), vec![0x22u8; 64]).expect("track02 fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n",
        )
        .expect("cue fixture");

    let archive = temp.child("disc.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--input",
            temp.child("track01.bin").path().to_str().expect("path"),
            "--input",
            temp.child("track02.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract-disc");
    let json = run_single_json_event(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--filter",
            "rom",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--checksum-rom",
            "crc32",
            "--json",
        ],
        0,
    );
    assert_eq!(json["status"], "succeeded");
    // Data tracks are hashed.
    assert!(
        emitted_file_entry(&json, "track01.bin")["checksums"]["crc32"]
            .as_str()
            .is_some()
    );
    assert!(
        emitted_file_entry(&json, "track02.bin")["checksums"]["crc32"]
            .as_str()
            .is_some()
    );
    // The `.cue` sheet still lands with the disc (counts as ROM) but is never hashed.
    assert!(out_dir.child("disc.cue").path().exists());
    assert!(emitted_file_entry(&json, "disc.cue")["checksums"].is_null());
}

#[test]
fn extract_emits_disc_group_structure_in_emitted_files() {
    let temp = setup_temp_dir();
    fs::write(temp.child("track01.bin").path(), vec![0x11u8; 64]).expect("track01 fixture");
    fs::write(temp.child("track02.bin").path(), vec![0x22u8; 64]).expect("track02 fixture");
    let cue_text = "FILE \"track01.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"track02.bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n";
    temp.child("disc.cue")
        .write_str(cue_text)
        .expect("cue fixture");

    let archive = temp.child("disc.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--input",
            temp.child("track01.bin").path().to_str().expect("path"),
            "--input",
            temp.child("track02.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("extract-disc-group");
    let json = run_single_json_event(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["status"], "succeeded");
    // The sheet carries its full text + a disc group id so the host renders one disc card without
    // re-parsing the cue itself.
    let sheet = emitted_file_entry(&json, "disc.cue");
    assert_eq!(sheet["cue_text"].as_str(), Some(cue_text));
    let group_id = sheet["disc_group_id"]
        .as_str()
        .expect("sheet disc_group_id");
    // Each referenced track shares the sheet's group id and gets its 1-based track number.
    let track01 = emitted_file_entry(&json, "track01.bin");
    let track02 = emitted_file_entry(&json, "track02.bin");
    assert_eq!(track01["disc_group_id"].as_str(), Some(group_id));
    assert_eq!(track02["disc_group_id"].as_str(), Some(group_id));
    assert_eq!(track01["track_number"], 1);
    assert_eq!(track02["track_number"], 2);
}

#[test]
fn extract_pbp_without_select_emits_all_discs() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 7);
    let disc2 = build_test_pbp_iso(80, 23);
    let pbp = build_test_pbp_fixture(vec![
        ("SLUS00001", disc1.clone()),
        ("SLUS00002", disc2.clone()),
    ]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");
    let out_dir = temp.child("all");

    let events = run_json_events(
        &[
            "extract",
            "--input",
            source.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    assert_running_percent_event(&events, "extract", "pbp");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "succeeded");
    let emitted = json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    assert_eq!(emitted.len(), 4);
    assert_emitted_file(json, out_dir.child("multi.disc01.cue").path(), Some("cue"));
    assert_emitted_file(json, out_dir.child("multi.disc01.bin").path(), Some("bin"));
    assert_emitted_file(json, out_dir.child("multi.disc02.cue").path(), Some("cue"));
    assert_emitted_file(json, out_dir.child("multi.disc02.bin").path(), Some("bin"));
    assert_eq!(
        fs::read(out_dir.child("multi.disc01.bin").path()).expect("disc01"),
        disc1
    );
    assert_eq!(
        fs::read(out_dir.child("multi.disc02.bin").path()).expect("disc02"),
        disc2
    );
    assert!(out_dir.child("multi.disc01.cue").path().exists());
    assert!(out_dir.child("multi.disc02.cue").path().exists());
}

#[test]
fn extract_reports_thread_fallback_in_json() {
    let temp = setup_temp_dir();
    let expected = b"zip payload for extract test".to_vec();
    fs::write(temp.child("disc.iso").path(), &expected).expect("fixture");
    let archive = temp.child("sample.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("out");

    let events = run_json_events(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--jsonl",
        ],
        0,
    );
    assert_running_percent_event(&events, "extract", "zip");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["thread_fallback"], false);
    assert!(json["thread_fallback_reason"].is_null());
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extract"),
        expected
    );
}

#[test]
fn extract_checksum_emits_requested_output_digests() {
    let temp = setup_temp_dir();
    let expected = b"zip payload for extract checksum test".to_vec();
    fs::write(temp.child("disc.iso").path(), &expected).expect("fixture");
    let archive = temp.child("sample.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("out");
    let events = run_json_events(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--checksum",
            "crc32",
            "--checksum",
            "md5",
            "--checksum",
            "sha1",
            "--jsonl",
        ],
        0,
    );
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("disc.iso").path()).expect("extract"),
        expected
    );

    let emitted = emitted_file_entry(json, "disc.iso");
    assert_eq!(emitted["checksums"]["crc32"], "7464f267");
    assert_eq!(
        emitted["checksums"]["md5"],
        "47144f4d72878e5b7802e5f736afab21"
    );
    assert_eq!(
        emitted["checksums"]["sha1"],
        "5ac04f8f0d78f0a446e07ced19af260a36bf3a28"
    );
}

#[test]
fn extract_select_supports_glob_patterns() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("content").path()).expect("content dir");
    let payload = (0..8192)
        .map(|index| (index % 239) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("content/disc.iso").path(), &payload).expect("iso fixture");
    fs::write(temp.child("content/readme.txt").path(), b"notes").expect("sidecar fixture");

    let archive = temp.child("sample.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("content").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("selected");
    command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--select",
            "content/*.iso",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(out_dir.child("content/disc.iso").path()).expect("iso extract"),
        payload
    );
    assert!(!out_dir.child("content/readme.txt").path().exists());
}

#[test]
fn extract_repeated_select_recurses_into_multiple_nested_archives() {
    let temp = setup_temp_dir();
    fs::write(temp.child("first.bin").path(), b"first payload").expect("first fixture");
    fs::write(temp.child("second.bin").path(), b"second payload").expect("second fixture");
    fs::write(temp.child("decoy.bin").path(), b"decoy payload").expect("decoy fixture");

    let inner_first = temp.child("inner-first.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("first.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner_first.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let inner_second = temp.child("inner-second.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("second.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner_second.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let inner_decoy = temp.child("inner-decoy.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("decoy.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner_decoy.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let outer = temp.child("outer.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            inner_first.path().to_str().expect("path"),
            "--input",
            inner_second.path().to_str().expect("path"),
            "--input",
            inner_decoy.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("selected-nested");
    let events = run_json_events(
        &[
            "extract",
            "--input",
            outer.path().to_str().expect("path"),
            "--select",
            "inner-first.zip",
            "--select",
            "inner-second.zip",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("recursively extracted 2 nested container(s)")
    );

    let first_output = out_dir.child("inner-first/first.bin");
    let second_output = out_dir.child("inner-second/second.bin");
    assert_eq!(
        fs::read(first_output.path()).expect("first output"),
        b"first payload"
    );
    assert_eq!(
        fs::read(second_output.path()).expect("second output"),
        b"second payload"
    );
    assert!(!out_dir.child("inner-decoy.zip").path().exists());
    assert!(!out_dir.child("inner-decoy/decoy.bin").path().exists());

    assert_emitted_file(json, first_output.path(), Some("bin"));
    assert_emitted_file(json, second_output.path(), Some("bin"));
    let emitted = json["details"]["emitted_files"]
        .as_array()
        .expect("emitted_files array");
    assert!(
        !emitted
            .iter()
            .any(|entry| entry["file_name"].as_str() == Some("inner-first.zip"))
    );
    assert!(
        !emitted
            .iter()
            .any(|entry| entry["file_name"].as_str() == Some("inner-second.zip"))
    );
}

#[test]
fn extract_select_glob_reports_missing_match() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("content").path()).expect("content dir");
    fs::write(temp.child("content/disc.iso").path(), b"iso").expect("iso fixture");

    let archive = temp.child("sample.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("content").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let out_dir = temp.child("selected");
    let json = run_single_json_event(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--select",
            "content/*.cue",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn extract_pbp_select_cue_emits_matching_bin_pair() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 41);
    let disc2 = build_test_pbp_iso(80, 73);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2.clone())]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");
    let out_dir = temp.child("selected");

    let json = run_single_json_event(
        &[
            "extract",
            "--input",
            source.path().to_str().expect("path"),
            "--select",
            "multi.disc02.cue",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "succeeded");
    assert!(out_dir.child("multi.disc02.cue").path().exists());
    assert!(out_dir.child("multi.disc02.bin").path().exists());
    assert!(!out_dir.child("multi.disc01.cue").path().exists());
    assert!(!out_dir.child("multi.disc01.bin").path().exists());
    assert_eq!(
        fs::read(out_dir.child("multi.disc02.bin").path()).expect("disc2 bin"),
        disc2
    );
}

#[test]
fn extract_pbp_select_missing_target_reports_not_found() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 5);
    let disc2 = build_test_pbp_iso(80, 9);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");
    let out_dir = temp.child("selected");

    let json = run_single_json_event(
        &[
            "extract",
            "--input",
            source.path().to_str().expect("path"),
            "--select",
            "multi.disc09.bin",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("requested selections were not found")
    );
}

#[test]
fn extract_rar_reports_thread_fallback_in_json() {
    let temp = setup_temp_dir();
    let archive = temp.child("version.rar");
    fs::copy(rar_fixture_path("version.rar"), archive.path()).expect("copy fixture");
    let out_dir = temp.child("out");

    let events = run_json_events(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--select",
            "VERSION",
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--jsonl",
        ],
        0,
    );
    assert_running_percent_event(&events, "extract", "rar");
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rar");
    assert_eq!(json["requested_threads"], 8);
    assert_eq!(json["effective_threads"], 1);
    assert_eq!(json["thread_mode"], "fixed");
    assert_eq!(json["used_parallelism"], false);
    assert_eq!(json["thread_fallback"], false);
    assert!(json["thread_fallback_reason"].is_null());
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        fs::read(out_dir.child("VERSION").path()).expect("extract"),
        b"unrar-0.4.0".to_vec()
    );
}

#[test]
fn extract_rar5_preserves_unicode_names_under_both_locales() {
    for locale in ["C", "C.UTF-8"] {
        let temp = setup_temp_dir();
        let out = temp.child("out");
        let output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .env("HOME", temp.path())
            .env("XDG_CONFIG_HOME", temp.child("config").path())
            .env("XDG_CACHE_HOME", temp.child("cache").path())
            .env("XDG_STATE_HOME", temp.child("state").path())
            .env("LC_ALL", locale)
            .args(["extract", "--input"])
            .arg(rar_fixture_path("rar5-unicode.rar"))
            .arg("--output")
            .arg(out.path())
            .args(["--no-ignore", "--json"])
            .assert()
            .success()
            .get_output()
            .clone();
        assert_eq!(
            fs::read(out.child("👋🌎.txt").path()).expect("exact Unicode filename"),
            b"Hello, world!",
            "locale {locale}"
        );
        assert_eq!(fs::read_dir(out.path()).expect("output entries").count(), 1);
        let stderr = String::from_utf8(output.stderr).expect("UTF-8 diagnostics");
        for link in ["Ⓗⓐⓡⓓ Ⓛⓘⓝⓚ.txt", "𝒮𝓎𝓂𝒷𝑜𝓁𝒾𝒸 𝐿𝒾𝓃𝓀.txt"]
        {
            assert!(stderr.contains(link), "locale {locale}: {stderr}");
        }
    }
}

#[test]
fn extract_rar5_rejects_truncated_archive() {
    assert_rar5_truncated_lengths(&[828, 600]);
}

#[test]
fn extract_rar5_requires_complete_end_marker() {
    assert_rar5_truncated_lengths(&[1648, 1649, 1652, 1653, 1655]);
}

fn assert_rar5_truncated_lengths(lengths: &[usize]) {
    let temp = setup_temp_dir();
    let complete = fs::read(rar_fixture_path("rar5-multiple-files.rar")).expect("fixture");
    for &length in lengths {
        let name = format!("truncated-{length}.rar");
        let bytes = &complete[..length];
        let archive = temp.child(&name);
        fs::write(archive.path(), bytes).expect("fixture");
        let out = temp.child(format!("out-{name}"));
        rar5_extract(archive.path(), out.path(), 1);
        assert!(
            !out.path().exists(),
            "failed extract left output for {name}"
        );
    }
}

#[test]
fn extract_rar5_rejects_multivolume_archive() {
    let temp = setup_temp_dir();
    let out = temp.child("out");
    let error = rar5_extract(&rar_fixture_path("rar5-part01.rar"), out.path(), 1);
    assert!(
        error.contains("Multivolume RAR5 archives are not supported"),
        "{error}"
    );
    assert!(!out.path().exists(), "failed extract left output");
}

#[test]
fn extract_rar5_stored_entries_validate_size_and_crc() {
    let temp = setup_temp_dir();
    let out = temp.child("out");
    rar5_extract(&rar_fixture_path("rar5-stored.rar"), out.path(), 0);
    assert_eq!(fs::read(out.child("empty").path()).expect("empty"), b"");
    assert_eq!(
        fs::read(out.child("payload").path()).expect("payload"),
        b"RAR5 stored payload"
    );
    let mut corrupt = fs::read(rar_fixture_path("rar5-stored.rar")).expect("fixture");
    let payload = corrupt
        .windows(19)
        .position(|w| w == b"RAR5 stored payload")
        .expect("payload offset");
    corrupt[payload] ^= 1;
    let archive = temp.child("corrupt.rar");
    fs::write(archive.path(), corrupt).expect("corrupt fixture");
    let failed_out = temp.child("failed");
    rar5_extract(archive.path(), failed_out.path(), 1);
    assert!(!failed_out.path().exists());
    for declared_size in [18, 20] {
        let mut wrong_size = fs::read(rar_fixture_path("rar5-stored.rar")).expect("fixture");
        wrong_size[48] = declared_size;
        let crc = crc32fast::hash(&wrong_size[43..64]);
        wrong_size[39..43].copy_from_slice(&crc.to_le_bytes());
        fs::write(archive.path(), wrong_size).expect("wrong size fixture");
        rar5_extract(archive.path(), failed_out.path(), 1);
        assert!(!failed_out.path().exists());
    }
}

#[test]
fn extract_rar5_complete_archive_succeeds() {
    let temp = setup_temp_dir();
    let out = temp.child("out");
    rar5_extract(&rar_fixture_path("rar5-multiple-files.rar"), out.path(), 0);
    for number in 0..4_u32 {
        let name = format!("test{}.bin", number + 1);
        let expected = (0..1024_u32)
            .flat_map(|index| (index * index.saturating_sub(1) + number).to_le_bytes())
            .collect::<Vec<_>>();
        assert_eq!(fs::read(out.child(name).path()).expect("entry"), expected);
    }
}

fn rar5_extract(input: &Path, out: &Path, expected_code: i32) -> String {
    let home = setup_temp_dir();
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .env("HOME", home.path())
        .env("XDG_CONFIG_HOME", home.child("config").path())
        .env("XDG_CACHE_HOME", home.child("cache").path())
        .env("XDG_STATE_HOME", home.child("state").path())
        .args([
            "extract",
            input.to_str().expect("path"),
            "-o",
            out.to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(expected_code)
        .get_output()
        .stdout
        .clone();
    String::from_utf8(output).expect("UTF-8 JSON")
}

fn rar_fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/rar")
        .join(name)
}

#[test]
fn extract_progress_text_keeps_diagnostics_separate_from_files() {
    let temp = setup_temp_dir();
    let input = temp.child("sample.bin");
    let archive = temp.child("sample.zip");
    let extract_dir = temp.child("extract");
    fs::write(input.path(), b"extract-progress-check").expect("fixture");

    command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ],
        0,
    );

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "--progress",
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--no-nested-extract",
        ])
        .assert()
        .code(0)
        .get_output()
        .clone();

    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    // `--progress` draws running progress on stderr...
    assert!(
        stderr.contains('%'),
        "expected extract progress on stderr, got: {stderr}"
    );
    // ...and stdout carries only the extracted file's absolute path, in the
    // emitted-path shape: forward slashes and no Windows verbatim prefix, so a
    // script can pipe the line straight into another tool.
    let printed = stdout
        .strip_suffix('\n')
        .expect("trailing newline on stdout");
    assert!(
        !printed.contains('\n'),
        "expected a single path on stdout, got: {stdout}"
    );
    assert!(
        printed.ends_with("/sample.bin") && !printed.contains('\\'),
        "expected a forward-slash path to the extracted file, got: {printed}"
    );
    assert!(
        !printed.starts_with("//?/"),
        "expected no Windows verbatim prefix, got: {printed}"
    );
    assert!(
        Path::new(printed).is_file(),
        "expected the printed path to name the extracted file, got: {printed}"
    );
    assert!(
        !stdout.contains("elapsed:"),
        "elapsed timing belongs in diagnostic logs, got: {stdout}"
    );
}

#[test]
fn extract_no_overwrite_fails_when_output_exists() {
    let temp = setup_temp_dir();
    let input = temp.child("sample.bin");
    let archive = temp.child("sample.zip");
    let extract_dir = temp.child("extract");
    fs::write(input.path(), b"overwrite-check").expect("fixture");

    command_stdout(
        &[
            "compress",
            "--input",
            input.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
        ],
        0,
    );

    fs::create_dir_all(extract_dir.path()).expect("extract dir");
    fs::write(extract_dir.child("sample.bin").path(), b"existing").expect("existing output");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            extract_dir.path().to_str().expect("path"),
            "--no-nested-extract",
        ])
        .assert()
        .code(1)
        .get_output()
        .stderr
        .clone();

    let text = String::from_utf8(output).expect("utf8 stderr");
    assert!(
        text.contains("refusing to overwrite existing output"),
        "expected overwrite error on stderr, got: {text}"
    );
}

#[test]
fn probe_reads_stdin_for_dash_input() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder payload")
        .expect("fixture");
    let archive = temp.child("sample.zip");

    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let bytes = fs::read(archive.path()).expect("read archive");
    let stdin_output = command_stdout_with_stdin(
        &["probe", "--input", "-", "--no-extract", "--json"],
        &bytes,
        0,
    );
    let json = parse_single_json_line(&stdin_output);
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entry_count"], 1);
    assert_eq!(json["details"]["container"]["entries"][0], "sample.bin");
}

#[test]
fn extract_probe_names_the_unrecognised_payload() {
    let temp = setup_temp_dir();
    fs::write(temp.child("blob.3ds").path(), vec![0x5A_u8; 4096]).expect("fixture");
    command_stdout(
        &[
            "compress",
            "-i",
            temp.child("blob.3ds").path().to_str().expect("path"),
            "-o",
            temp.child("blob.z3ds").path().to_str().expect("path"),
            "--format",
            "z3ds",
            "--json",
        ],
        0,
    );
    let json = run_single_json_event(
        &[
            "extract",
            "-i",
            temp.child("blob.z3ds").path().to_str().expect("path"),
            "-o",
            temp.child("out").path().to_str().expect("path"),
            "--probe",
            "--json",
        ],
        1,
    );
    assert_eq!(
        json["label"],
        "probe: `blob.3ds` did not resolve to a known platform"
    );
}

#[test]
fn probe_unidentified_file_error_omits_compress_recommendation() {
    let temp = setup_temp_dir();
    let unknown = temp.child("unknown.bin");
    unknown.write_str("payload").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["probe", "--input", unknown.path().to_str().expect("path")])
        .assert()
        .code(1)
        .get_output()
        .clone();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("no registered handler matched"), "{stderr}");
    assert!(!stderr.contains("recommended_compress_format"), "{stderr}");
    assert!(!stderr.contains("reason="), "{stderr}");
}

fn failed_extract(input: &Path, out: &Path) {
    command_stdout(
        &[
            "extract",
            input.to_str().expect("path"),
            "-o",
            out.to_str().expect("path"),
            "--json",
        ],
        1,
    );
}

#[test]
fn extract_truncated_gzip_leaves_no_output_dir() {
    let temp = setup_temp_dir();
    let raw = temp.child("r.bin");
    fs::write(raw.path(), pseudo_random_bytes(50_000, 7)).expect("raw fixture");
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    std::io::Write::write_all(&mut encoder, &fs::read(raw.path()).expect("raw bytes"))
        .expect("gzip write");
    let bytes = encoder.finish().expect("gzip finish");
    let truncated = temp.child("tr.bin.gz");
    fs::write(truncated.path(), &bytes[..bytes.len() / 2]).expect("truncated fixture");
    let out = temp.child("nested/out");

    failed_extract(truncated.path(), out.path());

    assert!(!out.path().exists(), "failed extract left the output dir");
    assert!(
        !temp.child("nested").path().exists(),
        "failed extract left a created parent dir"
    );
}

#[test]
fn extract_unsupported_input_leaves_no_output_dir() {
    let temp = setup_temp_dir();
    let input = temp.child("foo.xyz");
    fs::write(input.path(), b"not a known container").expect("input fixture");
    let out = temp.child("ux");

    failed_extract(input.path(), out.path());

    assert!(!out.path().exists(), "failed extract left the output dir");
}

#[test]
fn extract_failure_preserves_preexisting_output_dir() {
    let temp = setup_temp_dir();
    let input = temp.child("foo.xyz");
    fs::write(input.path(), b"not a known container").expect("input fixture");
    let out = temp.child("existing");
    fs::create_dir(out.path()).expect("existing dir");

    failed_extract(input.path(), out.path());

    assert!(out.path().is_dir(), "pre-existing output dir was removed");
}

fn stderr_of_failed(args: &[&str]) -> String {
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(args)
        .assert()
        .code(1)
        .get_output()
        .clone();
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn extract_rejects_empty_zip_and_7z_without_leaving_output() {
    for name in ["empty.zip", "empty.7z"] {
        let temp = setup_temp_dir();
        let input = temp.child(name);
        input.write_str("").expect("empty fixture");
        let out = temp.child("out");
        let stderr = stderr_of_failed(&[
            "extract",
            input.path().to_str().expect("path"),
            "-o",
            out.path().to_str().expect("path"),
        ]);
        assert!(stderr.contains("is empty"), "{name}: {stderr}");
        assert!(!out.path().exists(), "{name}: empty output dir left behind");
    }
}

// The 7z reader decodes into a 64 KiB buffer. A folder that unpacks to a multiple of that fills
// the buffer with its last byte, before the decoder has read the LZMA2 end marker, so reading
// the next folder first decodes that marker alone and gets no data.
#[test]
fn extract_7z_reads_the_folder_after_one_that_ends_on_a_full_buffer() {
    let temp = setup_temp_dir();
    let payloads: Vec<Vec<u8>> = (0..3)
        .map(|seed| pseudo_random_bytes(1 << 20, seed))
        .collect();
    let names = ["a.bin", "b.bin", "c.bin"];
    let files: Vec<(&str, &[u8])> = names
        .iter()
        .zip(&payloads)
        .map(|(name, payload)| (*name, payload.as_slice()))
        .collect();
    let archive = temp.child("roms.7z");
    write_7z_lzma2_folders_fixture(archive.path(), &files, 22);

    for threads in ["1", "2"] {
        let out_dir = temp.child(format!("out-{threads}"));
        run_json_events(
            &[
                "extract",
                "--input",
                archive.path().to_str().expect("path"),
                "--output",
                out_dir.path().to_str().expect("path"),
                "--threads",
                threads,
                "--jsonl",
            ],
            0,
        );
        for (name, payload) in names.iter().zip(&payloads) {
            assert_eq!(
                &fs::read(out_dir.child(name).path()).expect("read extracted"),
                payload,
                "{name} with {threads} threads"
            );
        }
    }
}

#[test]
fn checksum_fails_on_truncated_zip_instead_of_hashing_the_container() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("payload.bin").path(),
        pseudo_random_bytes(200_000, 7),
    )
    .expect("payload");
    let zip = temp.child("full.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("payload.bin").path().to_str().expect("path"),
            "--output",
            zip.path().to_str().expect("path"),
            "--quiet",
        ],
        0,
    );
    let bytes = fs::read(zip.path()).expect("zip bytes");
    let truncated = temp.child("truncated.zip");
    fs::write(truncated.path(), &bytes[..bytes.len() / 2]).expect("truncated zip");
    let stderr = stderr_of_failed(&[
        "checksum",
        "--input",
        truncated.path().to_str().expect("path"),
    ]);
    assert!(stderr.contains("decompression failed"), "{stderr}");
}

#[test]
fn probe_select_of_unrecognised_archive_member_names_the_member() {
    let temp = setup_temp_dir();
    fs::write(temp.child("a.bin").path(), b"aaaa").expect("a");
    fs::write(temp.child("b.bin").path(), b"bbbb").expect("b");
    let zip = temp.child("multi.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("a.bin").path().to_str().expect("path"),
            "--input",
            temp.child("b.bin").path().to_str().expect("path"),
            "--output",
            zip.path().to_str().expect("path"),
            "--quiet",
        ],
        0,
    );
    let stderr = stderr_of_failed(&[
        "probe",
        "--input",
        zip.path().to_str().expect("path"),
        "--select",
        "b.bin",
    ]);
    assert!(stderr.contains("archive member `b.bin`"), "{stderr}");
    assert!(
        !stderr.contains("no registered handler matched"),
        "{stderr}"
    );
}

#[test]
fn raw_file_with_stream_signature_is_not_decoded_as_itself() {
    let temp = setup_temp_dir();
    for (name, magic, stream) in [
        ("gz-lookalike.bin", &b"\x1f\x8b"[..], "gzip"),
        ("bz2-lookalike.bin", &b"BZh"[..], "bzip2"),
    ] {
        let mut bytes = vec![0_u8; 4096];
        bytes[..magic.len()].copy_from_slice(magic);
        let source = temp.child(name);
        fs::write(source.path(), &bytes).expect("lookalike fixture");
        let source_arg = source.path().to_str().expect("path");

        let stderr = stderr_of_failed(&["probe", "--input", source_arg]);
        assert!(
            stderr.contains(&format!("is not a valid {stream} stream")),
            "{stderr}"
        );

        let out = temp.child(format!("{name}.out"));
        let stderr = stderr_of_failed(&[
            "extract",
            "--input",
            source_arg,
            "--output",
            out.path().to_str().expect("path"),
        ]);
        assert!(
            stderr.contains(&format!("is not a valid {stream} stream")),
            "{stderr}"
        );
        assert!(!out.path().exists(), "extract left output for {name}");

        let raw = command_stdout(
            &["checksum", "--input", source_arg, "--no-extract", "--json"],
            0,
        );
        let resolved = command_stdout(&["checksum", "--input", source_arg, "--json"], 0);
        assert_eq!(
            parse_single_json_line(&resolved)["label"],
            parse_single_json_line(&raw)["label"],
            "{name} must hash as a raw file"
        );
    }
}

#[test]
fn extract_nested_empty_psar_pbp_preserves_rom_and_extracts_disc_pbp() {
    let temp = setup_temp_dir();
    let homebrew = build_test_empty_psar_pbp();
    let disc = build_test_pbp_iso(72, 37);
    let payloads = temp.child("payloads");
    fs::create_dir_all(payloads.path()).expect("payload directory");
    fs::write(payloads.child("EBOOT.PBP").path(), &homebrew).expect("homebrew fixture");
    fs::write(
        payloads.child("disc.pbp").path(),
        build_test_pbp_fixture(vec![("SLUS00001", disc.clone())]),
    )
    .expect("disc fixture");
    let inner = temp.child("mixed.zip");
    isolated_json_event(
        &temp,
        &[
            "compress",
            "--input",
            payloads.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let outer = temp.child("outer.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "mixed.zip")], outer.path());
    for (depth, archive) in [inner.path(), outer.path()].into_iter().enumerate() {
        let output = temp.child(format!("extract-{depth}"));
        let terminal = isolated_json_event(
            &temp,
            &[
                "extract",
                "--input",
                archive.to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--json",
            ],
            0,
        );
        let leaf = emitted_file_entry(&terminal, "EBOOT.PBP");
        assert_eq!(
            fs::read(leaf["path"].as_str().expect("homebrew path")).expect("homebrew bytes"),
            homebrew
        );
        let bin = emitted_file_entry(&terminal, "disc.bin");
        assert_eq!(
            fs::read(bin["path"].as_str().expect("disc path")).expect("disc bytes"),
            disc
        );
        let files = terminal["details"]["emitted_files"]
            .as_array()
            .expect("emitted files");
        assert_eq!(files.len(), 3, "only the PSP ROM and PS1 cue/bin leaves");
    }
}

// A 7z folder may declare a dictionary far larger than the data it holds. A 4 GiB - 1 dictionary
// cannot be reserved under a 2 GiB address-space limit, the same wall a 1 GiB browser memory puts
// in front of a 1.5 GiB one, so this extract only succeeds when the decoder sizes its dictionary
// from the folder's output.
#[cfg(target_os = "linux")]
#[test]
fn extract_7z_with_a_dictionary_larger_than_the_address_space_limit() {
    use std::os::unix::process::CommandExt;

    const ADDRESS_SPACE_LIMIT_BYTES: libc::rlim_t = 2 << 30;
    let temp = setup_temp_dir();
    let payload = pseudo_random_bytes(300_000, 0x5eed);
    let archive = temp.child("rom.7z");
    write_7z_lzma2_folders_fixture(archive.path(), &[("rom.bin", &payload)], 40);

    let out_dir = temp.child("out");
    let mut command = std::process::Command::new(assert_cmd::cargo::cargo_bin!("rom-weaver"));
    command.args([
        "extract",
        "--input",
        archive.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--threads",
        "1",
        "--json",
    ]);
    // SAFETY: the closure runs in the forked child before exec and only calls setrlimit, which
    // is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            let limit = libc::rlimit {
                rlim_cur: ADDRESS_SPACE_LIMIT_BYTES,
                rlim_max: ADDRESS_SPACE_LIMIT_BYTES,
            };
            if libc::setrlimit(libc::RLIMIT_AS, &limit) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
    let output = command.output().expect("run extract");
    assert!(
        output.status.success(),
        "extract under a 2 GiB address-space limit failed: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        fs::read(out_dir.child("rom.bin").path()).expect("read extracted"),
        payload
    );
}

// Every worker opens its own reader, so concurrent solid blocks each allocate their dictionary.
// A 2,000,000-byte folder needs a dictionary that size, pricing a worker just under 6 MiB; three
// quarters of a 25 MiB limit fits three. Pricing the declared 4 GiB - 1 would cap extraction at
// one decoder, which reports the two-thread floor instead.
#[test]
fn extract_7z_runs_only_as_many_folder_decoders_as_the_memory_limit_fits() {
    let temp = setup_temp_dir();
    let payloads: Vec<Vec<u8>> = (0..4)
        .map(|seed| pseudo_random_bytes(2_000_000, seed))
        .collect();
    let names = ["a.bin", "b.bin", "c.bin", "d.bin"];
    let files: Vec<(&str, &[u8])> = names
        .iter()
        .zip(&payloads)
        .map(|(name, payload)| (*name, payload.as_slice()))
        .collect();
    let archive = temp.child("roms.7z");
    write_7z_lzma2_folders_fixture(archive.path(), &files, 40);

    for (limit, expected_threads) in [(None, 4), (Some("26214400"), 3)] {
        let out_dir = temp.child(format!("out-{expected_threads}"));
        let envs: Vec<(&str, &str)> = limit
            .map(|bytes| ("ROM_WEAVER_MEMORY_LIMIT_BYTES", bytes))
            .into_iter()
            .collect();
        let events = run_json_events_with_env(
            &[
                "extract",
                "--input",
                archive.path().to_str().expect("path"),
                "--output",
                out_dir.path().to_str().expect("path"),
                "--threads",
                "4",
                "--jsonl",
            ],
            &envs,
            0,
        );
        let json = events.last().expect("extract terminal event");
        assert_eq!(
            json["effective_threads"], expected_threads,
            "memory limit {limit:?}"
        );
        for (name, payload) in names.iter().zip(&payloads) {
            assert_eq!(
                &fs::read(out_dir.child(name).path()).expect("read extracted"),
                payload
            );
        }
    }
}

#[test]
fn patch_apply_rejects_split_7z_volumes() {
    let temp = setup_temp_dir();
    let full = temp.child("full.7z");
    let payload = pseudo_random_bytes(64 * 1024, 19);
    write_7z_lzma2_folders_fixture(full.path(), &[("game.bin", &payload)], 16);
    let bytes = fs::read(full.path()).expect("7z bytes");
    assert!(bytes.len() > 32 * 1024);
    let patch = temp.child("change.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 100,
                data: vec![42],
            }],
            None,
        ),
    )
    .expect("patch");
    for name in [
        "split.7z.001",
        "split.7z.002",
        "split.7Z.001",
        "split.7z.1000",
    ] {
        let volume = temp.child(name);
        let start = if name.ends_with("002") { 16 * 1024 } else { 0 };
        let original = &bytes[start..start + 16 * 1024];
        fs::write(volume.path(), original).expect("volume");
        let output = temp.child(format!("{name}.out.bin"));
        let stderr = stderr_of_failed(&[
            "patch",
            "apply",
            "-i",
            volume.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "-o",
            output.path().to_str().expect("path"),
            "--no-compress",
        ]);
        assert!(
            stderr.contains("7z") && stderr.contains("payload extraction failed"),
            "{stderr}"
        );
        assert!(!output.path().exists(), "left output for {name}");
        assert_eq!(fs::read(volume.path()).expect("unchanged volume"), original);
    }
}

#[test]
fn extract_7z_deflate64_solid_and_separate_folders() {
    for solid in ["on", "off"] {
        let archive = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../rom-weaver-containers/tests/fixtures/7z/deflate64-solid-{solid}.7z"
        ));
        let temp = setup_temp_dir();
        for threads in ["1", "2"] {
            let out = temp.child(format!("out-{threads}"));
            command_stdout(
                &[
                    "extract",
                    "-i",
                    archive.to_str().expect("path"),
                    "-o",
                    out.path().to_str().expect("path"),
                    "-j",
                    threads,
                ],
                0,
            );
            assert_eq!(
                fs::read(out.child("first.bin").path()).expect("first"),
                (0..131072).map(|i| (i % 251) as u8).collect::<Vec<_>>()
            );
            assert_eq!(
                fs::read(out.child("second.bin").path()).expect("second"),
                vec![b'x'; 196609]
            );
            assert!(
                fs::read(out.child("empty.bin").path())
                    .expect("empty")
                    .is_empty()
            );
        }
    }
}

#[test]
fn extract_7z_deflate64_rejects_corrupt_payload() {
    let temp = setup_temp_dir();
    let mut bytes =
        include_bytes!("../../../rom-weaver-containers/tests/fixtures/7z/deflate64-solid-on.7z")
            .to_vec();
    bytes[32] = 0x07;
    let archive = temp.child("corrupt.7z");
    fs::write(archive.path(), &bytes).expect("corrupt archive");
    let out = temp.child("out");
    let stderr = stderr_of_failed(&[
        "extract",
        "-i",
        archive.path().to_str().expect("path"),
        "-o",
        out.path().to_str().expect("path"),
    ]);
    assert!(
        stderr.contains("Deflate64 decompression failed"),
        "{stderr}"
    );
    assert!(!out.path().exists(), "corrupt extraction left output");
    assert_eq!(fs::read(archive.path()).expect("unchanged archive"), bytes);
}

#[test]
fn patch_apply_extracts_complete_7z_with_volume_name() {
    let temp = setup_temp_dir();
    let payload = pseudo_random_bytes(1024, 19);
    let input = temp.child("complete.7z.001");
    write_7z_lzma2_folders_fixture(input.path(), &[("game.bin", &payload)], 16);
    let patch = temp.child("change.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 100,
                data: vec![42],
            }],
            None,
        ),
    )
    .expect("patch");
    let out = temp.child("out.bin");
    command_stdout(
        &[
            "patch",
            "apply",
            "-i",
            input.path().to_str().expect("path"),
            "--patch",
            patch.path().to_str().expect("path"),
            "-o",
            out.path().to_str().expect("path"),
            "--no-compress",
        ],
        0,
    );
    let mut expected = payload;
    expected[100] = 42;
    assert_eq!(fs::read(out.path()).expect("patched payload"), expected);
}
