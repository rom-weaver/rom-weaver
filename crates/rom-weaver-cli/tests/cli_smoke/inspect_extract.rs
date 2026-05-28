/* jscpd:ignore-start */
#[test]
fn inspect_reports_known_container_as_supported() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder payload")
        .expect("fixture");
    let archive = temp.child("sample.zip");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &["inspect", archive.path().to_str().expect("path"), "--json"],
        0,
    );
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(
        json["details"]["container"]["recommended_compress_format"],
        "chd"
    );
    assert_eq!(
        json["details"]["container"]["reason"],
        "not-wii-gc-or-unrecognized"
    );
    assert!(json["details"]["container"]["entry_count"].is_null());
    assert!(!json["label"]
        .as_str()
        .expect("label")
        .contains("recommended_compress_format"));
}

#[test]
fn inspect_list_reports_selectable_zip_entries() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"payload").expect("fixture");
    let archive = temp.child("sample.zip");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &[
            "inspect",
            archive.path().to_str().expect("path"),
            "--list",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entry_count"], 1);
    assert_eq!(json["details"]["container"]["entries"][0], "sample.bin");
    assert_eq!(
        json["details"]["container"]["recommended_compress_format"],
        "chd"
    );
    assert_eq!(
        json["details"]["container"]["reason"],
        "not-wii-gc-or-unrecognized"
    );
    assert!(!json["label"]
        .as_str()
        .expect("label")
        .contains("selectable entries"));
}

#[test]
fn inspect_reports_rar_container_as_supported() {
    let temp = setup_temp_dir();
    let source = temp.child("version.rar");
    fs::copy(rar_fixture_path("version.rar"), source.path()).expect("copy fixture");

    let json = run_single_json_event(
        &["inspect", source.path().to_str().expect("path"), "--json"],
        0,
    );
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "rar");
    assert_eq!(json["status"], "succeeded");
}

#[test]
fn inspect_reports_known_rom_header_as_supported() {
    let temp = setup_temp_dir();
    let payload = b"header-aware inspect payload".to_vec();
    fs::write(temp.child("headered.nes").path(), with_nes_header(&payload)).expect("fixture");

    let json = run_single_json_event(
        &[
            "inspect",
            temp.child("headered.nes").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "inspect");
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
fn inspect_reports_gba_header_profile() {
    let temp = setup_temp_dir();
    let rom = build_test_gba_rom(0x2000);
    fs::write(temp.child("test.gba").path(), rom).expect("fixture");

    let json = run_single_json_event(
        &[
            "inspect",
            temp.child("test.gba").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "command");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("detected ROM header Game Boy Advance"));
}

#[test]
fn inspect_list_rejects_patch_inputs() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("update.ips").path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: vec![0xAA],
            }],
            None,
        ),
    )
    .expect("fixture");

    let json = run_single_json_event(
        &[
            "inspect",
            temp.child("update.ips").path().to_str().expect("path"),
            "--list",
            "--json",
        ],
        1,
    );
    assert_eq!(json["command"], "inspect");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("only supported for container formats"));
}

#[test]
fn inspect_list_reports_pbp_multi_disc_selectable_outputs() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 13);
    let disc2 = build_test_pbp_iso(80, 29);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let json = run_single_json_event(
        &[
            "inspect",
            source.path().to_str().expect("path"),
            "--list",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "inspect");
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

    let archive = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            temp.child("notes.txt").path().to_str().expect("path"),
            temp.child("meta.json").path().to_str().expect("path"),
            temp.child("cover.jpg").path().to_str().expect("path"),
            temp.child("._game.bin").path().to_str().expect("path"),
            temp.child("__MACOSX").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let default_out = temp.child("default-out");
    let default_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--out-dir",
            default_out.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let default_json = parse_single_json_line(&default_output);
    assert_eq!(default_json["command"], "extract");
    assert_eq!(default_json["status"], "succeeded");
    assert!(default_json["label"]
        .as_str()
        .expect("label")
        .contains("1 file(s)"));
    assert!(default_out.child("game.bin").path().exists());
    assert!(!default_out.child("notes.txt").path().exists());
    assert!(!default_out.child("meta.json").path().exists());
    assert!(!default_out.child("cover.jpg").path().exists());
    assert!(!default_out.child("._game.bin").path().exists());
    assert!(!default_out.child("__MACOSX/ghost.bin").path().exists());

    let no_ignore_out = temp.child("no-ignore-out");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--out-dir",
            no_ignore_out.path().to_str().expect("path"),
            "--no-ignore",
            "--json",
        ])
        .assert()
        .code(0);
    assert!(no_ignore_out.child("game.bin").path().exists());
    assert!(no_ignore_out.child("notes.txt").path().exists());
    assert!(no_ignore_out.child("meta.json").path().exists());
    assert!(no_ignore_out.child("cover.jpg").path().exists());
    assert!(no_ignore_out.child("._game.bin").path().exists());
    assert!(no_ignore_out.child("__MACOSX/ghost.bin").path().exists());
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
            source.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
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
    assert_emitted_file(&json, out_dir.child("multi.disc01.cue").path(), Some("cue"));
    assert_emitted_file(&json, out_dir.child("multi.disc01.bin").path(), Some("bin"));
    assert_emitted_file(&json, out_dir.child("multi.disc02.cue").path(), Some("cue"));
    assert_emitted_file(&json, out_dir.child("multi.disc02.bin").path(), Some("bin"));
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("out");

    let events = run_json_events(
        &[
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("disc.iso").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("out");
    let events = run_json_events(
        &[
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "disc.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--checksum",
            "crc32",
            "--checksum",
            "md5",
            "--checksum",
            "sha1",
            "--json",
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
    assert_eq!(emitted["checksums"]["md5"], "47144f4d72878e5b7802e5f736afab21");
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("content").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("selected");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "content/*.iso",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    assert_eq!(
        fs::read(out_dir.child("content/disc.iso").path()).expect("iso extract"),
        payload
    );
    assert!(!out_dir.child("content/readme.txt").path().exists());
}

#[test]
fn extract_select_glob_reports_missing_match() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("content").path()).expect("content dir");
    fs::write(temp.child("content/disc.iso").path(), b"iso").expect("iso fixture");

    let archive = temp.child("sample.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("content").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("selected");
    let json = run_single_json_event(
        &[
            "extract",
            archive.path().to_str().expect("path"),
            "--select",
            "content/*.cue",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("requested selections were not found"));
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
            source.path().to_str().expect("path"),
            "--select",
            "multi.disc02.cue",
            "--out-dir",
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
            source.path().to_str().expect("path"),
            "--select",
            "multi.disc09.bin",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["format"], "pbp");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("requested selections were not found"));
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
            archive.path().to_str().expect("path"),
            "--select",
            "VERSION",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "8",
            "--json",
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
/* jscpd:ignore-end */
