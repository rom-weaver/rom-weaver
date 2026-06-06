#[test]
fn checksum_reports_auto_thread_mode() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--threads",
            "auto",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["family"], "checksum");
    assert_eq!(json["format"], "native");
    assert_eq!(json["thread_mode"], "auto");
    assert!(
        json["requested_threads"]
            .as_u64()
            .expect("requested threads")
            >= 1
    );
    assert!(
        json["effective_threads"]
            .as_u64()
            .expect("effective threads")
            <= 2
    );
    assert_eq!(
        json["used_parallelism"]
            .as_bool()
            .expect("parallelism flag"),
        json["effective_threads"]
            .as_u64()
            .expect("effective threads")
            > 1
    );
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("crc32="));
    assert!(label.contains("sha1="));
}

#[test]
fn checksum_supports_sha256_blake3_and_crc32c() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("hello world")
        .expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--algo",
            "blake3",
            "--algo",
            "crc32c",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["family"], "checksum");
    assert_eq!(json["format"], "native");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(
        label.contains("sha256=b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
    );
    assert!(
        label.contains("blake3=d74981efa70a0c880b8d8c1985d075dbcbf679b99a5f9914e5aaf96b831a9e24")
    );
    assert!(label.contains("crc32c=c99465aa"));
}

#[test]
fn checksum_auto_extract_resolves_nested_container_payload() {
    let temp = setup_temp_dir();
    let payload = (0..32_768)
        .map(|index| (index % 211) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
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

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual, expected);
    assert!(label.contains("checksum source resolved via 2 container extract step(s)"));
}

#[test]
fn checksum_no_extract_hashes_container_bytes() {
    let temp = setup_temp_dir();
    let payload = (0..24_576)
        .map(|index| (index % 199) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
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

    let expected_payload = checksum_value(temp.child("game.bin").path(), "sha1");

    let auto_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let auto_label = parse_single_json_line(&auto_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let auto_digest = label_digest_value(&auto_label, "sha1")
        .expect("auto digest")
        .to_string();

    let raw_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let raw_label = parse_single_json_line(&raw_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let raw_digest = label_digest_value(&raw_label, "sha1")
        .expect("raw digest")
        .to_string();

    assert_eq!(auto_digest, expected_payload);
    assert_ne!(raw_digest, auto_digest);
}

#[test]
fn checksum_auto_extract_stream_container_uses_streamed_hashing() {
    let temp = setup_temp_dir();
    let payload = (0..28_672)
        .map(|index| (index % 181) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let compressed = temp.child("game.bin.gz");
    write_gzip_fixture(temp.child("game.bin").path(), compressed.path());

    let expected_payload = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            compressed.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual, expected_payload);
    assert!(label.contains("checksum source streamed from gz container"));
    assert!(!label.contains("checksum source resolved via"));
}

#[test]
fn checksum_stream_container_falls_back_when_nested_extract_is_required() {
    let temp = setup_temp_dir();
    let payload = (0..19_456)
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let outer = temp.child("inner.zip.gz");
    write_gzip_fixture(inner.path(), outer.path());

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual, expected);
    assert!(label.contains("checksum source resolved via 2 container extract step(s)"));
    assert!(!label.contains("checksum source streamed from gz container"));
}

#[test]
fn checksum_auto_extract_tar_stream_uses_streamed_hashing() {
    let temp = setup_temp_dir();
    let payload = (0..31_744)
        .map(|index| (index % 167) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let archive = temp.child("game.tar.gz");
    write_tar_gz_fixture(&[(temp.child("game.bin").path(), "game.bin")], archive.path());

    let expected_payload = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual, expected_payload);
    assert!(label.contains("checksum source streamed from tar.gz container entry"));
    assert!(!label.contains("checksum source resolved via"));
}

#[test]
fn checksum_tar_stream_rom_filter_selects_rom_payload() {
    let temp = setup_temp_dir();
    let payload = (0..19_456)
        .map(|index| (index % 151) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");
    fs::write(temp.child("update.bps").path(), SIMPLE_BPS_PATCH).expect("patch fixture");

    let archive = temp.child("mixed.tar.gz");
    write_tar_gz_fixture(
        &[
            (temp.child("game.bin").path(), "game.bin"),
            (temp.child("update.bps").path(), "update.bps"),
        ],
        archive.path(),
    );

    let expected_payload = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--rom-filter",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual, expected_payload);
    assert!(label.contains("checksum source streamed from tar.gz container entry `game.bin`"));
}

#[test]
fn checksum_tar_stream_falls_back_when_nested_extract_is_required() {
    let temp = setup_temp_dir();
    let payload = (0..22_912)
        .map(|index| (index % 149) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");

    let inner = temp.child("inner.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let archive = temp.child("inner.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "inner.zip")], archive.path());

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    let actual = label_digest_value(label, "sha1").expect("sha1 digest");
    assert_eq!(actual, expected);
    assert!(label.contains("checksum source resolved via 2 container extract step(s)"));
    assert!(!label.contains("checksum source streamed from tar.gz container entry"));
}

#[test]
fn checksum_auto_extract_ambiguity_requires_select() {
    let temp = setup_temp_dir();
    fs::write(temp.child("alpha.bin").path(), b"alpha").expect("alpha fixture");
    fs::write(temp.child("beta.bin").path(), b"beta").expect("beta fixture");

    let archive = temp.child("dupe.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("alpha.bin").path().to_str().expect("path"),
            temp.child("beta.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let json = parse_single_json_line(&output);
    let label = json["label"].as_str().expect("label");
    assert_eq!(json["status"], "failed");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("alpha.bin"));
    assert!(label.contains("beta.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn checksum_auto_extract_pbp_multi_disc_requires_select() {
    let temp = setup_temp_dir();
    let disc1 = build_test_pbp_iso(72, 31);
    let disc2 = build_test_pbp_iso(80, 47);
    let pbp = build_test_pbp_fixture(vec![("SLUS00001", disc1), ("SLUS00002", disc2)]);
    let source = temp.child("multi.pbp");
    fs::write(source.path(), pbp).expect("pbp fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "failed");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("ambiguous"));
    assert!(label.contains("multi.disc01.bin"));
    assert!(label.contains("--select"));
}

#[test]
fn checksum_auto_extract_ignores_sidecars_unless_no_ignore() {
    let temp = setup_temp_dir();
    fs::create_dir_all(temp.child("__MACOSX").path()).expect("__MACOSX dir");

    let payload = (0..16_384)
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.bin").path(), &payload).expect("payload fixture");
    fs::write(temp.child("notes.txt").path(), b"notes").expect("txt sidecar");
    fs::write(temp.child("meta.json").path(), b"{}").expect("json sidecar");
    fs::write(temp.child("maxcso-report.bin").path(), b"skip me").expect("maxcso sidecar");
    fs::write(temp.child("__MACOSX/ghost.bin").path(), b"ghost").expect("macosx sidecar");

    let archive = temp.child("bundle.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
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

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let label = parse_single_json_line(&output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let digest = label_digest_value(&label, "sha1")
        .expect("digest")
        .to_string();
    assert_eq!(digest, expected);

    let no_ignore_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-ignore",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let no_ignore_json = parse_single_json_line(&no_ignore_output);
    let no_ignore_label = no_ignore_json["label"].as_str().expect("label");
    assert_eq!(no_ignore_json["status"], "failed");
    assert!(no_ignore_label.contains("ambiguous"));
    assert!(no_ignore_label.contains("--select"));
}

#[test]
fn checksum_select_patterns_apply_at_each_recursion_depth() {
    let temp = setup_temp_dir();
    fs::write(temp.child("game.bin").path(), b"final payload").expect("payload fixture");
    fs::write(temp.child("decoy.rom").path(), b"decoy payload").expect("decoy fixture");

    let inner = temp.child("inner.bin");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            temp.child("game.bin").path().to_str().expect("path"),
            temp.child("decoy.rom").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);
    fs::write(temp.child("note.txt").path(), b"ignore me").expect("note fixture");

    let outer = temp.child("outer.zip");
    Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "compress",
            inner.path().to_str().expect("path"),
            temp.child("note.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ])
        .assert()
        .code(0);

    let failed_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let failed_json = parse_single_json_line(&failed_output);
    assert!(
        failed_json["label"]
            .as_str()
            .expect("label")
            .contains("ambiguous")
    );

    let selected_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--select",
            "*.bin",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let selected_json = parse_single_json_line(&selected_output);
    let selected_label = selected_json["label"].as_str().expect("label");
    let selected_digest = label_digest_value(selected_label, "sha1")
        .expect("selected digest")
        .to_string();
    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    assert_eq!(selected_digest, expected);
}

#[test]
fn checksum_xiso_does_not_auto_extract_payload() {
    let temp = setup_temp_dir();
    let source_tree = temp.child("xiso-source");
    let xiso = temp.child("disc.xiso");
    write_xiso_fixture_from_directory(source_tree.path(), xiso.path());

    let auto_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            xiso.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let auto_label = parse_single_json_line(&auto_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let auto_digest = label_digest_value(&auto_label, "sha1")
        .expect("auto digest")
        .to_string();

    let raw_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            xiso.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-extract",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let raw_label = parse_single_json_line(&raw_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let raw_digest = label_digest_value(&raw_label, "sha1")
        .expect("raw digest")
        .to_string();

    let payload_digest = checksum_value(source_tree.child("default.xbe").path(), "sha1");
    assert_eq!(auto_digest, raw_digest);
    assert_ne!(auto_digest, payload_digest);
}

#[test]
fn checksum_strip_header_matches_unheadered_digests() {
    let temp = setup_temp_dir();
    let payload = (0..1024)
        .map(|index| ((index * 11) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("plain.bin").path(), &payload).expect("fixture");
    fs::write(temp.child("headered.bin").path(), with_header(&payload)).expect("fixture");

    let plain_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("plain.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("headered.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let plain_json = parse_single_json_line(&plain_output);
    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(plain_json["command"], "checksum");
    assert_eq!(headered_json["command"], "checksum");
    assert_eq!(plain_json["status"], "succeeded");
    assert_eq!(headered_json["status"], "succeeded");

    let plain_label = plain_json["label"].as_str().expect("plain label");
    let headered_label = headered_json["label"].as_str().expect("headered label");
    assert_eq!(
        label_digest_value(plain_label, "crc32"),
        label_digest_value(headered_label, "crc32")
    );
    assert_eq!(
        label_digest_value(plain_label, "sha1"),
        label_digest_value(headered_label, "sha1")
    );
    assert!(headered_label.contains("input header stripped (512 bytes"));
}

#[test]
fn checksum_strip_header_supports_igir_header_profiles() {
    let temp = setup_temp_dir();
    let payload = (0..1536)
        .map(|index| ((index * 13) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("plain.bin").path(), &payload).expect("fixture");

    let plain_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("plain.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let plain_json = parse_single_json_line(&plain_output);
    let plain_label = plain_json["label"].as_str().expect("plain label");

    let cases = vec![
        (
            "headered.a78",
            with_a78_header(&payload),
            128,
            "No-Intro_A7800.xml",
        ),
        (
            "headered.lnx",
            with_lnx_header(&payload),
            64,
            "No-Intro_LNX.xml",
        ),
        (
            "headered.nes",
            with_nes_header(&payload),
            16,
            "No-Intro_NES.xml",
        ),
        (
            "headered.fds",
            with_fds_header(&payload),
            16,
            "No-Intro_FDS.xml",
        ),
        ("headered.smc", with_header(&payload), 512, "SMC"),
    ];

    for (name, bytes, stripped_len, profile_name) in cases {
        fs::write(temp.child(name).path(), bytes).expect("headered fixture");
        let output = Command::cargo_bin("rom-weaver")
            .expect("binary")
            .args([
                "checksum",
                temp.child(name).path().to_str().expect("path"),
                "--algo",
                "crc32",
                "--algo",
                "sha1",
                "--strip-header",
                "--json",
            ])
            .assert()
            .code(0)
            .get_output()
            .stdout
            .clone();

        let json = parse_single_json_line(&output);
        assert_eq!(json["status"], "succeeded");
        let label = json["label"].as_str().expect("headered label");
        assert_eq!(
            label_digest_value(plain_label, "crc32"),
            label_digest_value(label, "crc32")
        );
        assert_eq!(
            label_digest_value(plain_label, "sha1"),
            label_digest_value(label, "sha1")
        );
        assert!(label.contains(&format!(
            "input header stripped ({stripped_len} bytes, {profile_name})"
        )));
    }
}

#[test]
fn checksum_strip_header_supports_size_rule_copier_profiles() {
    let temp = setup_temp_dir();
    let payload = (0..16_384)
        .map(|index| ((index * 7) % 251) as u8)
        .collect::<Vec<_>>();

    fs::write(temp.child("plain.smc").path(), &payload).expect("snes fixture");
    fs::write(temp.child("plain.pce").path(), &payload).expect("pce fixture");

    let mut snes_headered = vec![0xA5; 512];
    snes_headered.extend_from_slice(&payload);
    fs::write(temp.child("headered.smc").path(), snes_headered).expect("snes headered");

    let mut pce_headered = vec![0x5A; 512];
    pce_headered.extend_from_slice(&payload);
    fs::write(temp.child("headered.pce").path(), pce_headered).expect("pce headered");

    let plain_snes_sha1 = checksum_value(temp.child("plain.smc").path(), "sha1");
    let plain_pce_sha1 = checksum_value(temp.child("plain.pce").path(), "sha1");

    let snes_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("headered.smc").path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let snes_json = parse_single_json_line(&snes_output);
    let snes_label = snes_json["label"].as_str().expect("snes label");
    assert_eq!(
        label_digest_value(snes_label, "sha1").expect("snes digest"),
        plain_snes_sha1
    );
    assert!(snes_label.contains("input header stripped (512 bytes, SNES_COPIER_HEADER)"));

    let pce_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("headered.pce").path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();
    let pce_json = parse_single_json_line(&pce_output);
    let pce_label = pce_json["label"].as_str().expect("pce label");
    assert_eq!(
        label_digest_value(pce_label, "sha1").expect("pce digest"),
        plain_pce_sha1
    );
    assert!(pce_label.contains("input header stripped (512 bytes, PCE_COPIER_HEADER)"));
}

#[test]
fn checksum_strip_header_rejects_small_input() {
    let temp = setup_temp_dir();
    fs::write(temp.child("tiny.bin").path(), b"small").expect("fixture");

    let output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("tiny.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();

    let json = parse_single_json_line(&output);
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["family"], "checksum");
    assert_eq!(json["status"], "failed");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("could not detect a supported removable ROM header")
    );
}

#[test]
fn checksum_auto_trim_fix_nds_matches_explicitly_trimmed_output() {
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let trimmed = temp.child("downloadplay-trimmed.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");
    fs::write(trimmed.path(), &rom[..0x3200 + 0x88]).expect("trimmed fixture");

    let trimmed_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let explicit_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            trimmed.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let trimmed_json = parse_single_json_line(&trimmed_output);
    let explicit_json = parse_single_json_line(&explicit_output);
    assert_eq!(trimmed_json["status"], "succeeded");
    assert_eq!(explicit_json["status"], "succeeded");

    let trimmed_label = trimmed_json["label"].as_str().expect("trimmed label");
    let explicit_label = explicit_json["label"].as_str().expect("explicit label");
    assert_eq!(
        label_digest_value(trimmed_label, "crc32"),
        label_digest_value(explicit_label, "crc32")
    );
    assert_eq!(
        label_digest_value(trimmed_label, "sha1"),
        label_digest_value(explicit_label, "sha1")
    );
    assert!(trimmed_label.contains("range=0..12936"));
    assert!(trimmed_label.contains("trimmed_input_bytes=12936"));
    assert!(trimmed_label.contains("mode=ds"));
    assert!(trimmed_label.contains("preserved_download_play_cert=true"));
}

#[test]
fn checksum_auto_trim_fix_supports_strip_header() {
    let temp = setup_temp_dir();
    let source = temp.child("base.nds");
    let headered = temp.child("base-headered.nds");
    let rom = build_test_nds_rom(0x02, 0x2800, 0x3A00, 0x7000, false);
    fs::write(source.path(), &rom).expect("fixture");
    fs::write(headered.path(), with_header(&rom)).expect("fixture");

    let source_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let headered_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            headered.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--strip-header",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let source_json = parse_single_json_line(&source_output);
    let headered_json = parse_single_json_line(&headered_output);
    assert_eq!(source_json["status"], "succeeded");
    assert_eq!(headered_json["status"], "succeeded");

    let source_label = source_json["label"].as_str().expect("source label");
    let headered_label = headered_json["label"].as_str().expect("headered label");
    assert_eq!(
        label_digest_value(source_label, "crc32"),
        label_digest_value(headered_label, "crc32")
    );
    assert!(headered_label.contains("input header stripped (512 bytes"));
    assert!(headered_label.contains("trimmed_input_bytes=14848"));
    assert!(headered_label.contains("mode=dsi"));
}

#[test]
fn checksum_no_trim_fix_disables_trimmed_boundary_fix() {
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");

    let auto_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let no_fix_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-trim-fix",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let auto_json = parse_single_json_line(&auto_output);
    let no_fix_json = parse_single_json_line(&no_fix_output);
    assert_eq!(auto_json["status"], "succeeded");
    assert_eq!(no_fix_json["status"], "succeeded");

    let auto_label = auto_json["label"].as_str().expect("auto label");
    let no_fix_label = no_fix_json["label"].as_str().expect("no-fix label");
    assert!(auto_label.contains("trimmed_input_bytes=12936"));
    assert!(!no_fix_label.contains("trimmed_input_bytes="));
    assert_ne!(
        label_digest_value(auto_label, "crc32"),
        label_digest_value(no_fix_label, "crc32")
    );
}

#[test]
fn checksum_auto_trim_fix_ignores_non_trim_eligible_extensions() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"hello").expect("fixture");

    let auto_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let no_fix_output = Command::cargo_bin("rom-weaver")
        .expect("binary")
        .args([
            "checksum",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-trim-fix",
            "--json",
        ])
        .assert()
        .code(0)
        .get_output()
        .stdout
        .clone();

    let auto_json = parse_single_json_line(&auto_output);
    let no_fix_json = parse_single_json_line(&no_fix_output);
    assert_eq!(auto_json["command"], "checksum");
    assert_eq!(auto_json["family"], "checksum");
    assert_eq!(auto_json["status"], "succeeded");
    assert_eq!(no_fix_json["status"], "succeeded");
    let auto_label = auto_json["label"].as_str().expect("auto label");
    let no_fix_label = no_fix_json["label"].as_str().expect("no-fix label");
    assert!(!auto_label.contains("trimmed_input_bytes="));
    assert_eq!(
        label_digest_value(auto_label, "crc32"),
        label_digest_value(no_fix_label, "crc32")
    );
}
