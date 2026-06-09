/* jscpd:ignore-start */
#[test]
fn old_inspect_command_is_removed() {
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["inspect", "--help"])
        .assert()
        .code(2);
}

#[test]
fn probe_rejects_list_flag() {
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args(["probe", "input.bin", "--list", "--json"])
        .assert()
        .code(2);
}

#[test]
fn probe_reports_known_container_as_supported() {
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
        &[
            "probe",
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
    assert_eq!(
        json["details"]["container"]["recommended_compress_format"],
        "7z"
    );
    assert_eq!(
        json["details"]["container"]["reason"],
        "fallback-7z-lzma2"
    );
    assert!(json["details"]["container"]["entry_count"].is_null());
    assert!(!json["label"]
        .as_str()
        .expect("label")
        .contains("recommended_compress_format"));
}

#[test]
fn list_reports_selectable_zip_entries() {
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
            "list",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "list");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entry_count"], 1);
    assert_eq!(json["details"]["container"]["entries"][0], "sample.bin");
    assert_eq!(
        json["details"]["container"]["recommended_compress_format"],
        "7z"
    );
    assert_eq!(
        json["details"]["container"]["reason"],
        "fallback-7z-lzma2"
    );
    assert!(!json["label"]
        .as_str()
        .expect("label")
        .contains("selectable entries"));
}

#[test]
fn probe_auto_extracts_single_payload() {
    let temp = setup_temp_dir();
    let payload = b"header-aware probe payload".to_vec();
    fs::write(temp.child("game.nes").path(), with_nes_header(&payload)).expect("fixture");
    let archive = temp.child("game.zip");

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &["probe", archive.path().to_str().expect("path"), "--json"],
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

#[test]
fn probe_auto_extracts_nested_payload() {
    let temp = setup_temp_dir();
    let payload = b"nested header-aware probe payload".to_vec();
    fs::write(temp.child("game.nes").path(), with_nes_header(&payload)).expect("fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("outer.7z");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner.path().to_str().expect("path"),
            "--format",
            "7z",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &["probe", outer.path().to_str().expect("path"), "--json"],
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.nes").path().to_str().expect("path"),
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
            "probe",
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
    assert!(!json["label"]
        .as_str()
        .expect("label")
        .contains("probe source resolved via"));
}

#[test]
fn list_with_select_reports_selected_nested_container_entries() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"payload").expect("payload fixture");
    fs::write(temp.child("notes.txt").path(), b"ignore me").expect("note fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("outer.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner.path().to_str().expect("path"),
            temp.child("notes.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &[
            "list",
            outer.path().to_str().expect("path"),
            "--select",
            "inner.zip",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "list");
    assert_eq!(json["family"], "container");
    assert_eq!(json["format"], "zip");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entry_count"], 1);
    assert_eq!(json["details"]["container"]["entries"][0], "sample.bin");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("list source resolved via 1 container extract step(s)"));
}

#[test]
fn probe_auto_extract_ambiguity_requires_select() {
    let temp = setup_temp_dir();
    fs::write(temp.child("alpha.nes").path(), with_nes_header(b"alpha")).expect("alpha fixture");
    fs::write(temp.child("beta.nes").path(), with_nes_header(b"beta")).expect("beta fixture");

    let archive = temp.child("dupe.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("alpha.nes").path().to_str().expect("path"),
            temp.child("beta.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &["probe", archive.path().to_str().expect("path"), "--json"],
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

    let archive = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.nes").path().to_str().expect("path"),
            temp.child("notes.txt").path().to_str().expect("path"),
            temp.child("meta.json").path().to_str().expect("path"),
            temp.child("maxcso-report.bin")
                .path()
                .to_str()
                .expect("path"),
            temp.child("__MACOSX").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &["probe", archive.path().to_str().expect("path"), "--json"],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");

    let no_ignore_json = run_single_json_event(
        &[
            "probe",
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

    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
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
        ])
        .assert()
        .code(0);

    let archive = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            patch.path().to_str().expect("path"),
            temp.child("game.nes").path().to_str().expect("path"),
            temp.child("notes.txt").path().to_str().expect("path"),
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
            "probe",
            archive.path().to_str().expect("path"),
            "--patch-filter",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["format"], "BPS");
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("probe source resolved via 1 container extract step(s)"));
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.nes").path().to_str().expect("path"),
            temp.child("._game.nes").path().to_str().expect("path"),
            temp.child("maxcso-report.bin")
                .path()
                .to_str()
                .expect("path"),
            temp.child("__MACOSX").path().to_str().expect("path"),
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &[
            "probe",
            outer.path().to_str().expect("path"),
            "--rom-filter",
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
fn list_rom_filter_prefers_payload_entries_over_archive_fallback() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("__MACOSX").path()).expect("__MACOSX dir");
    fs::write(temp.child("game.nes").path(), with_nes_header(b"rom")).expect("rom fixture");
    fs::write(temp.child("nested.nes").path(), with_nes_header(b"nested")).expect("nested fixture");
    fs::write(temp.child("._game.nes").path(), b"resource fork").expect("resource fork");
    fs::write(temp.child("maxcso-report.bin").path(), b"skip me").expect("maxcso sidecar");
    fs::write(temp.child("__MACOSX/ghost.nes").path(), b"ghost").expect("macosx sidecar");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.nes").path().to_str().expect("path"),
            temp.child("._game.nes").path().to_str().expect("path"),
            temp.child("maxcso-report.bin")
                .path()
                .to_str()
                .expect("path"),
            temp.child("__MACOSX").path().to_str().expect("path"),
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &[
            "list",
            outer.path().to_str().expect("path"),
            "--rom-filter",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "list");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["container"]["entries"][0], "game.nes");
    assert_eq!(json["details"]["container"]["entry_count"], 1);

    let no_ignore_json = run_single_json_event(
        &[
            "list",
            outer.path().to_str().expect("path"),
            "--rom-filter",
            "--no-ignore",
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
fn list_rom_filter_lists_archive_fallback_when_no_payload_matches() {
    let temp = setup_temp_dir();
    fs::write(temp.child("nested.nes").path(), with_nes_header(b"nested")).expect("nested fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let json = run_single_json_event(
        &[
            "list",
            outer.path().to_str().expect("path"),
            "--rom-filter",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "list");
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
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("nested.nes").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let archive = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.nes").path().to_str().expect("path"),
            temp.child("update.bps").path().to_str().expect("path"),
            temp.child("notes.txt").path().to_str().expect("path"),
            inner.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("extract-rom-filter");
    let json = run_single_json_event(
        &[
            "extract",
            archive.path().to_str().expect("path"),
            "--rom-filter",
            "--out-dir",
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
fn probe_reports_rar_container_as_supported() {
    let temp = setup_temp_dir();
    let source = temp.child("version.rar");
    fs::copy(rar_fixture_path("version.rar"), source.path()).expect("copy fixture");

    let json = run_single_json_event(
        &[
            "probe",
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
            temp.child("test.gba").path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "probe");
    assert_eq!(json["family"], "command");
    assert_eq!(json["format"], "rom-header");
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("detected ROM header Game Boy Advance"));
}

#[test]
fn list_rejects_patch_inputs() {
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
            "list",
            temp.child("update.ips").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    assert_eq!(json["command"], "list");
    assert_eq!(json["family"], "patch");
    assert_eq!(json["status"], "failed");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("only supported for container formats"));
}

#[test]
fn list_reports_pbp_multi_disc_selectable_outputs() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 13);
    let disc2 = build_test_pbp_iso(80, 29);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let json = run_single_json_event(
        &[
            "list",
            source.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "list");
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
fn extract_repeated_select_recurses_into_multiple_nested_archives() {
    let temp = setup_temp_dir();
    fs::write(temp.child("first.bin").path(), b"first payload").expect("first fixture");
    fs::write(temp.child("second.bin").path(), b"second payload").expect("second fixture");
    fs::write(temp.child("decoy.bin").path(), b"decoy payload").expect("decoy fixture");

    let inner_first = temp.child("inner-first.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("first.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner_first.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let inner_second = temp.child("inner-second.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("second.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner_second.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let inner_decoy = temp.child("inner-decoy.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("decoy.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner_decoy.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("outer.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner_first.path().to_str().expect("path"),
            inner_second.path().to_str().expect("path"),
            inner_decoy.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let out_dir = temp.child("selected-nested");
    let events = run_json_events(
        &[
            "extract",
            outer.path().to_str().expect("path"),
            "--select",
            "inner-first.zip",
            "--select",
            "inner-second.zip",
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let json = events.last().expect("extract terminal event");
    assert_eq!(json["command"], "extract");
    assert_eq!(json["status"], "succeeded");
    assert!(json["label"]
        .as_str()
        .expect("label")
        .contains("recursively extracted 2 nested container(s)"));

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
    assert!(!emitted
        .iter()
        .any(|entry| entry["file_name"].as_str() == Some("inner-first.zip")));
    assert!(!emitted
        .iter()
        .any(|entry| entry["file_name"].as_str() == Some("inner-second.zip")));
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
