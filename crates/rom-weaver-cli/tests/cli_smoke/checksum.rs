use super::shared::*;

fn checksum_variant_rows(json: &Value) -> &Vec<Value> {
    json["details"]["checksum_variants"]
        .as_array()
        .unwrap_or_else(|| panic!("checksum variant rows in {json}"))
}

fn checksum_variant_row<'a>(json: &'a Value, id: &str) -> &'a Value {
    checksum_variant_rows(json)
        .iter()
        .find(|row| row["id"] == id)
        .unwrap_or_else(|| panic!("missing checksum variant row {id}"))
}

fn checksum_variant_ids(json: &Value) -> Vec<&str> {
    checksum_variant_rows(json)
        .iter()
        .map(|row| row["id"].as_str().expect("variant id"))
        .collect()
}

fn assert_no_checksum_variants(json: &Value) {
    assert!(
        json["details"]["checksum_variants"].is_null(),
        "legacy checksum path should not include variants: {json}"
    );
}

fn checksum_value_no_trim_fix(path: &std::path::Path, algorithm: &str) -> String {
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            path.to_str().expect("path"),
            "--algo",
            algorithm,
            "--no-trim-fix",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    let label = json["label"].as_str().expect("label");
    label_digest_value(label, algorithm)
        .expect("checksum value in label")
        .to_string()
}

fn checksum_test_n64_byte_swapped(bytes: &[u8]) -> Vec<u8> {
    let mut swapped = bytes.to_vec();
    for word in swapped.chunks_exact_mut(4) {
        word.swap(0, 1);
        word.swap(2, 3);
    }
    swapped
}

fn checksum_test_n64_little_endian(bytes: &[u8]) -> Vec<u8> {
    let mut little_endian = bytes.to_vec();
    for word in little_endian.chunks_exact_mut(4) {
        word.reverse();
    }
    little_endian
}

fn checksum_test_n64_header_crc(bytes: &[u8]) -> (u32, u32) {
    let seed = 0xF8CA4DDCu32;
    let mut t1 = seed;
    let mut t2 = seed;
    let mut t3 = seed;
    let mut t4 = seed;
    let mut t5 = seed;
    let mut t6 = seed;

    for offset in (0x1000usize..0x101000usize).step_by(4) {
        let d = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
        if t6.wrapping_add(d) < t6 {
            t4 = t4.wrapping_add(1);
        }
        t6 = t6.wrapping_add(d);
        t3 ^= d;

        let shift = d & 0x1F;
        let rotated = if shift == 0 { d } else { d.rotate_left(shift) };

        t5 = t5.wrapping_add(rotated);
        if t2 > d {
            t2 ^= rotated;
        } else {
            t2 ^= t6 ^ d;
        }
        t1 = t1.wrapping_add(t5 ^ d);
    }

    (t6 ^ t4 ^ t3, t5 ^ t2 ^ t1)
}

#[test]
fn checksum_reports_auto_thread_mode() {
    let temp = setup_temp_dir();
    temp.child("sample.bin")
        .write_str("placeholder")
        .expect("fixture");

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--threads",
            "auto",
            "--json",
        ],
        0,
    );

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

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "sha256",
            "--algo",
            "blake3",
            "--algo",
            "crc32c",
            "--json",
        ],
        0,
    );

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
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
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

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

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
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
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

    let expected_payload = checksum_value(temp.child("game.bin").path(), "sha1");

    let auto_output = command_stdout(
        &[
            "checksum",
            "--input",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );
    let auto_label = parse_single_json_line(&auto_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let auto_digest = label_digest_value(&auto_label, "sha1")
        .expect("auto digest")
        .to_string();

    let raw_output = command_stdout(
        &[
            "checksum",
            "--input",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-extract",
            "--json",
        ],
        0,
    );
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
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            compressed.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

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
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let outer = temp.child("inner.zip.gz");
    write_gzip_fixture(inner.path(), outer.path());

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

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
    write_tar_gz_fixture(
        &[(temp.child("game.bin").path(), "game.bin")],
        archive.path(),
    );

    let expected_payload = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

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
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--filter",
            "rom",
            "--json",
        ],
        0,
    );

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
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let archive = temp.child("inner.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "inner.zip")], archive.path());

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

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
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("alpha.bin").path().to_str().expect("path"),
            "--input",
            temp.child("beta.bin").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        1,
    );
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

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        1,
    );

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

    let expected = checksum_value(temp.child("game.bin").path(), "sha1");
    let output = command_stdout(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );
    let label = parse_single_json_line(&output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let digest = label_digest_value(&label, "sha1")
        .expect("digest")
        .to_string();
    assert_eq!(digest, expected);

    let no_ignore_output = command_stdout(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-ignore",
            "--json",
        ],
        1,
    );
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
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("game.bin").path().to_str().expect("path"),
            "--input",
            temp.child("decoy.rom").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    fs::write(temp.child("note.txt").path(), b"ignore me").expect("note fixture");

    let outer = temp.child("outer.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            inner.path().to_str().expect("path"),
            "--input",
            temp.child("note.txt").path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            outer.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );

    let failed_output = command_stdout(
        &[
            "checksum",
            "--input",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        1,
    );
    let failed_json = parse_single_json_line(&failed_output);
    assert!(
        failed_json["label"]
            .as_str()
            .expect("label")
            .contains("ambiguous")
    );

    let selected_output = command_stdout(
        &[
            "checksum",
            "--input",
            outer.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--select",
            "*.bin",
            "--json",
        ],
        0,
    );
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

    let auto_output = command_stdout(
        &[
            "checksum",
            "--input",
            xiso.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );
    let auto_label = parse_single_json_line(&auto_output)["label"]
        .as_str()
        .expect("label")
        .to_string();
    let auto_digest = label_digest_value(&auto_label, "sha1")
        .expect("auto digest")
        .to_string();

    let raw_output = command_stdout(
        &[
            "checksum",
            "--input",
            xiso.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-extract",
            "--json",
        ],
        0,
    );
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
fn checksum_json_includes_primary_checksums_and_raw_variant_by_default() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"plain checksum payload").expect("fixture");

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "md5",
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    let label = json["label"].as_str().expect("label");
    assert!(label.contains("crc32="));
    assert!(label.contains("md5="));
    assert!(label.contains("sha1="));
    assert!(!label.contains("Raw"));
    assert_eq!(
        json["details"]["checksums"]["crc32"].as_str(),
        label_digest_value(label, "crc32")
    );
    assert_eq!(
        json["details"]["checksums"]["md5"].as_str(),
        label_digest_value(label, "md5")
    );
    assert_eq!(
        json["details"]["checksums"]["sha1"].as_str(),
        label_digest_value(label, "sha1")
    );
    assert_eq!(checksum_variant_rows(&json).len(), 1);
    let raw = checksum_variant_row(&json, "raw");
    assert_eq!(raw["label"], "Raw");
    assert_eq!(raw["checksums"], json["details"]["checksums"]);
    assert_eq!(
        raw["applyCompatibility"]
            .as_object()
            .expect("raw compatibility")
            .len(),
        0
    );
}

#[test]
fn checksum_headered_roms_include_remove_header_variant() {
    let temp = setup_temp_dir();
    let payload = (0..1536)
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    let cases = [
        ("headered.nes", with_nes_header(&payload), 16_u64),
        ("headered.smc", with_header(&payload), 512_u64),
        ("headered.pce", with_header(&payload), 512_u64),
        ("headered.a78", with_a78_header(&payload), 128_u64),
        ("headered.lnx", with_lnx_header(&payload), 64_u64),
        ("headered.fds", with_fds_header(&payload), 16_u64),
    ];
    fs::write(temp.child("plain.bin").path(), &payload).expect("plain fixture");
    let expected_sha1 = checksum_value(temp.child("plain.bin").path(), "sha1");

    for (name, bytes, stripped_bytes) in cases {
        fs::write(temp.child(name).path(), bytes).expect("headered fixture");
        let output = command_stdout(
            &[
                "checksum",
                "--input",
                temp.child(name).path().to_str().expect("path"),
                "--algo",
                "sha1",
                "--no-trim-fix",
                "--json",
            ],
            0,
        );

        let json = parse_single_json_line(&output);
        assert_eq!(json["status"], "succeeded");
        assert!(checksum_variant_ids(&json).contains(&"raw"));
        assert!(checksum_variant_ids(&json).contains(&"remove-header"));
        let label = json["label"].as_str().expect("label");
        assert_eq!(
            json["details"]["checksums"]["sha1"].as_str(),
            label_digest_value(label, "sha1")
        );
        assert!(!label.contains("Remove header"));
        let remove_header = checksum_variant_row(&json, "remove-header");
        assert_eq!(remove_header["checksums"]["sha1"], expected_sha1);
        assert_eq!(remove_header["applyCompatibility"]["removeHeader"], true);
        assert_eq!(remove_header["applyCompatibility"]["strip_header"], true);
        assert_eq!(
            remove_header["transforms"]["removeHeader"]["strippedBytes"],
            stripped_bytes
        );
    }
}

#[test]
fn checksum_legacy_range_skips_variants() {
    let temp = setup_temp_dir();
    let payload = (0..2048)
        .map(|index| ((index * 19) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("headered.nes").path(), with_nes_header(&payload)).expect("fixture");

    for extra_args in [vec!["--start", "1"], vec!["--length", "128"]] {
        let headered_path = temp.child("headered.nes");
        let headered_path = headered_path.path().to_str().expect("path");
        let mut args = vec!["checksum", "--input", headered_path, "--algo", "sha1"];
        args.extend(extra_args);
        args.push("--json");
        let output = command_stdout(&args, 0);

        let json = parse_single_json_line(&output);
        assert_eq!(json["status"], "succeeded");
        assert!(json["details"]["checksums"]["sha1"].as_str().is_some());
        assert_no_checksum_variants(&json);
    }
}

#[test]
fn checksum_auto_extract_payload_gets_variants_after_resolution() {
    let temp = setup_temp_dir();
    let payload = (0..1024)
        .map(|index| ((index * 23) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("game.nes").path(), with_nes_header(&payload)).expect("fixture");
    fs::write(temp.child("plain.bin").path(), &payload).expect("plain fixture");
    let expected_sha1 = checksum_value(temp.child("plain.bin").path(), "sha1");

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

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            archive.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("checksum source resolved via")
    );
    assert_eq!(
        checksum_variant_row(&json, "remove-header")["checksums"]["sha1"],
        expected_sha1
    );
}

#[test]
fn checksum_broken_header_checksums_include_fix_header_variant() {
    let temp = setup_temp_dir();

    let mut broken_gba = build_test_gba_rom(0x4000);
    broken_gba[0x1BD] ^= 0x7F;
    let mut repaired_gba = broken_gba.clone();
    repaired_gba[0x1BD] = gba_header_checksum(&repaired_gba);
    fs::write(temp.child("broken.gba").path(), &broken_gba).expect("gba fixture");
    fs::write(temp.child("repaired.gba").path(), &repaired_gba).expect("gba repaired fixture");

    let mut broken_genesis = vec![0_u8; 0x260];
    broken_genesis[0x100..0x104].copy_from_slice(b"SEGA");
    broken_genesis[0x200..0x203].copy_from_slice(&[0x12, 0x34, 0x56]);
    let mut repaired_genesis = broken_genesis.clone();
    let repaired_genesis_checksum = sega_genesis_checksum(&repaired_genesis);
    repaired_genesis[0x18E..0x190].copy_from_slice(&repaired_genesis_checksum.to_be_bytes());
    fs::write(temp.child("broken.md").path(), &broken_genesis).expect("genesis fixture");
    fs::write(temp.child("repaired.md").path(), &repaired_genesis)
        .expect("genesis repaired fixture");

    let mut broken_n64 = vec![0_u8; 0x101000];
    broken_n64[..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
    for (index, value) in broken_n64[0x1000..].iter_mut().enumerate() {
        *value = (index as u8).wrapping_mul(9).wrapping_add(0x11);
    }
    let mut repaired_n64 = broken_n64.clone();
    let (n64_crc1, n64_crc2) = checksum_test_n64_header_crc(&repaired_n64);
    repaired_n64[0x10..0x14].copy_from_slice(&n64_crc1.to_be_bytes());
    repaired_n64[0x14..0x18].copy_from_slice(&n64_crc2.to_be_bytes());
    fs::write(temp.child("broken.z64").path(), &broken_n64).expect("n64 fixture");
    fs::write(temp.child("repaired.z64").path(), &repaired_n64).expect("n64 repaired fixture");

    for (name, repaired_name, profile) in [
        ("broken.gba", "repaired.gba", "gba"),
        ("broken.md", "repaired.md", "sega-genesis"),
        ("broken.z64", "repaired.z64", "n64"),
    ] {
        let expected_sha1 = checksum_value_no_trim_fix(temp.child(repaired_name).path(), "sha1");
        let output = command_stdout(
            &[
                "checksum",
                "--input",
                temp.child(name).path().to_str().expect("path"),
                "--algo",
                "sha1",
                "--no-trim-fix",
                "--json",
            ],
            0,
        );

        let json = parse_single_json_line(&output);
        assert_eq!(json["status"], "succeeded");
        let fix_header = checksum_variant_row(&json, "fix-header");
        assert_eq!(fix_header["checksums"]["sha1"], expected_sha1);
        assert_ne!(json["details"]["checksums"]["sha1"], expected_sha1);
        assert_eq!(fix_header["applyCompatibility"]["fixChecksum"], true);
        assert_eq!(fix_header["applyCompatibility"]["repair_checksum"], true);
        assert!(
            fix_header["transforms"]["fixChecksum"]["repairedProfiles"]
                .as_array()
                .expect("repaired profiles")
                .iter()
                .any(|entry| entry == profile),
            "missing repaired profile {profile}: {fix_header}"
        );
    }
}

#[test]
fn extract_checksum_variants_match_checksum_command() {
    let temp = setup_temp_dir();

    // remove-header (NES signature) + two fix-header families (GBA tiny prefix,
    // Genesis whole-file buffer) cover the variant transforms exercised inline
    // during extract.
    let nes_payload = (0..4096)
        .map(|index| ((index * 17) % 251) as u8)
        .collect::<Vec<_>>();
    fs::write(
        temp.child("headered.nes").path(),
        with_nes_header(&nes_payload),
    )
    .expect("nes fixture");

    let mut broken_gba = build_test_gba_rom(0x4000);
    broken_gba[0x1BD] ^= 0x7F;
    fs::write(temp.child("broken.gba").path(), &broken_gba).expect("gba fixture");

    let mut broken_genesis = vec![0_u8; 0x260];
    broken_genesis[0x100..0x104].copy_from_slice(b"SEGA");
    broken_genesis[0x200..0x203].copy_from_slice(&[0x12, 0x34, 0x56]);
    fs::write(temp.child("broken.md").path(), &broken_genesis).expect("genesis fixture");

    for (name, expected_variant) in [
        ("headered.nes", "remove-header"),
        ("broken.gba", "fix-header"),
        ("broken.md", "fix-header"),
    ] {
        // Variants from the standalone checksum command on the plain file.
        // `--no-trim-fix` keeps it hashing the full file like extract does
        // (extract has no trim step), so the variant sets are comparable.
        let checksum_output = command_stdout(
            &[
                "checksum",
                "--input",
                temp.child(name).path().to_str().expect("path"),
                "--algo",
                "crc32",
                "--algo",
                "sha1",
                "--no-trim-fix",
                "--json",
            ],
            0,
        );
        let checksum_json = parse_single_json_line(&checksum_output);
        let expected_variants = checksum_json["details"]["checksum_variants"]
            .as_array()
            .unwrap_or_else(|| panic!("checksum command variants for {name}: {checksum_json}"))
            .clone();
        assert!(
            expected_variants
                .iter()
                .any(|row| row["id"] == expected_variant),
            "checksum command missing `{expected_variant}` variant for {name}: {checksum_json}"
        );

        // Same file zipped, then extracted with inline checksums.
        let archive = temp.child(format!("{name}.zip"));
        command_stdout(
            &[
                "compress",
                "--input",
                temp.child(name).path().to_str().expect("path"),
                "--format",
                "zip",
                "--output",
                archive.path().to_str().expect("path"),
                "--json",
            ],
            0,
        );

        let out_dir = temp.child(format!("out-{name}"));
        let events = run_json_events(
            &[
                "extract",
                "--input",
                archive.path().to_str().expect("path"),
                "--output",
                out_dir.path().to_str().expect("path"),
                "--checksum",
                "crc32",
                "--checksum",
                "sha1",
                "--json",
            ],
            0,
        );
        let extract_json = events.last().expect("extract terminal event");
        let emitted = emitted_file_entry(extract_json, name);
        let emitted_variants = emitted["checksum_variants"]
            .as_array()
            .unwrap_or_else(|| panic!("extract emitted variants for {name}: {extract_json}"));

        assert_eq!(
            emitted_variants, &expected_variants,
            "extract variant parity mismatch for {name}"
        );
    }
}

#[test]
fn checksum_n64_byte_order_variants_cover_all_target_orders() {
    let temp = setup_temp_dir();
    let z64 = [
        0x80, 0x37, 0x12, 0x40, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A,
        0x0B,
    ];
    let n64 = checksum_test_n64_little_endian(&z64);
    let v64 = checksum_test_n64_byte_swapped(&z64);
    fs::write(temp.child("game.z64").path(), z64).expect("z64 fixture");
    fs::write(temp.child("game.n64").path(), &n64).expect("n64 fixture");
    fs::write(temp.child("game.v64").path(), &v64).expect("v64 fixture");
    let expected_big_endian_sha1 = checksum_value(temp.child("game.z64").path(), "sha1");

    for (name, source_order) in [
        ("game.z64", "big-endian"),
        ("game.n64", "little-endian"),
        ("game.v64", "byte-swapped"),
    ] {
        let output = command_stdout(
            &[
                "checksum",
                "--input",
                temp.child(name).path().to_str().expect("path"),
                "--algo",
                "sha1",
                "--json",
            ],
            0,
        );

        let json = parse_single_json_line(&output);
        assert_eq!(json["status"], "succeeded");
        let ids = checksum_variant_ids(&json);
        assert!(ids.contains(&"raw"));
        for target_order in ["big-endian", "little-endian", "byte-swapped"] {
            let row = checksum_variant_row(&json, &format!("n64-byte-order:{target_order}"));
            assert_eq!(row["applyCompatibility"]["n64ByteOrder"], target_order);
            assert_eq!(row["applyCompatibility"]["n64_byte_order"], target_order);
            assert_eq!(
                row["transforms"]["n64ByteOrder"]["sourceOrder"],
                source_order
            );
            assert_eq!(
                row["transforms"]["n64ByteOrder"]["targetOrder"],
                target_order
            );
        }
        assert_eq!(
            checksum_variant_row(&json, "n64-byte-order:big-endian")["checksums"]["sha1"],
            expected_big_endian_sha1
        );
    }
}

#[test]
fn checksum_nds_hashes_full_file_and_includes_variants() {
    // The checksum command hashes the full file (no auto-trim) so its output matches the inline
    // checksum extract computes; a trim-eligible NDS therefore differs from its explicitly-trimmed
    // counterpart and still gets the streaming variant set (at least `raw`).
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let trimmed = temp.child("downloadplay-trimmed.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");
    fs::write(trimmed.path(), &rom[..0x3200 + 0x88]).expect("trimmed fixture");

    let full_output = command_stdout(
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

    let explicit_output = command_stdout(
        &[
            "checksum",
            "--input",
            trimmed.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

    let full_json = parse_single_json_line(&full_output);
    let explicit_json = parse_single_json_line(&explicit_output);
    assert_eq!(full_json["status"], "succeeded");
    assert_eq!(explicit_json["status"], "succeeded");

    let full_label = full_json["label"].as_str().expect("full label");
    let explicit_label = explicit_json["label"].as_str().expect("explicit label");
    // Full-file hashing: no trim boundary applied, and the value differs from the trimmed file.
    assert!(!full_label.contains("trimmed_input_bytes="));
    assert!(!full_label.contains("range="));
    assert_ne!(
        label_digest_value(full_label, "crc32"),
        label_digest_value(explicit_label, "crc32")
    );
    // The streaming variant engine runs for trim-eligible inputs too (previously suppressed):
    // the `raw` variant is always present and mirrors the primary checksum.
    assert!(checksum_variant_ids(&full_json).contains(&"raw"));
    assert_eq!(
        checksum_variant_row(&full_json, "raw")["checksums"]["crc32"],
        full_json["details"]["checksums"]["crc32"]
    );
}

#[test]
fn checksum_nds_default_matches_no_trim_fix() {
    // `--no-trim-fix` is a no-op for the primary value now that the command never auto-trims, so the
    // default and `--no-trim-fix` outputs are byte-identical.
    let temp = setup_temp_dir();
    let source = temp.child("downloadplay.nds");
    let rom = build_test_nds_rom(0x00, 0x3200, 0x3200, 0x6000, true);
    fs::write(source.path(), &rom).expect("fixture");

    let auto_output = command_stdout(
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ],
        0,
    );

    let no_fix_output = command_stdout(
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-trim-fix",
            "--json",
        ],
        0,
    );

    let auto_json = parse_single_json_line(&auto_output);
    let no_fix_json = parse_single_json_line(&no_fix_output);
    assert_eq!(auto_json["status"], "succeeded");
    assert_eq!(no_fix_json["status"], "succeeded");

    let auto_label = auto_json["label"].as_str().expect("auto label");
    let no_fix_label = no_fix_json["label"].as_str().expect("no-fix label");
    assert!(!auto_label.contains("trimmed_input_bytes="));
    assert!(!no_fix_label.contains("trimmed_input_bytes="));
    assert_eq!(
        label_digest_value(auto_label, "crc32"),
        label_digest_value(no_fix_label, "crc32")
    );
}

#[test]
fn checksum_auto_trim_fix_ignores_non_trim_eligible_extensions() {
    let temp = setup_temp_dir();
    fs::write(temp.child("sample.bin").path(), b"hello").expect("fixture");

    let auto_output = command_stdout(
        &[
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ],
        0,
    );

    let no_fix_output = command_stdout(
        &[
            "checksum",
            "--input",
            temp.child("sample.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--no-trim-fix",
            "--json",
        ],
        0,
    );

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

#[test]
fn checksum_game_boy_rom_has_only_raw_variant() {
    // Game Boy has no copier header (no remove-header variant) and its header
    // checksum repair is not wired into the streaming variant engine (no
    // fix-header variant), so only `raw` is emitted.
    let temp = setup_temp_dir();
    let rom = build_test_game_boy_rom(0x4000);
    fs::write(temp.child("game.gb").path(), &rom).expect("gb fixture");

    let output = command_stdout(
        &[
            "checksum",
            "--input",
            temp.child("game.gb").path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--json",
        ],
        0,
    );

    let json = parse_single_json_line(&output);
    assert_eq!(json["status"], "succeeded");
    let ids = checksum_variant_ids(&json);
    assert_eq!(ids, vec!["raw"], "Game Boy should only have raw variant");
}

#[test]
fn checksum_probe_emits_platform_for_known_rom() {
    let temp = setup_temp_dir();
    fs::write(
        temp.child("game.nes").path(),
        with_nes_header(b"checksum probe payload"),
    )
    .expect("fixture");

    let json = run_single_json_event(
        &[
            "checksum",
            "--input",
            temp.child("game.nes").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--probe",
            "--json",
        ],
        0,
    );
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "succeeded");
    assert_eq!(json["details"]["platform"], "Nintendo Entertainment System");
}

#[test]
fn checksum_probe_fails_unidentified_source() {
    let temp = setup_temp_dir();
    fs::write(temp.child("blob.bin").path(), vec![0x5A_u8; 4096]).expect("fixture");

    let json = run_single_json_event(
        &[
            "checksum",
            "--input",
            temp.child("blob.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--probe",
            "--json",
        ],
        1,
    );
    assert_eq!(json["command"], "checksum");
    assert_eq!(json["status"], "failed");
    assert_eq!(json["stage"], "probe");
    assert!(
        json["label"]
            .as_str()
            .expect("label")
            .contains("did not resolve to a known platform")
    );
}

#[test]
fn checksum_without_probe_succeeds_on_unidentified_source() {
    let temp = setup_temp_dir();
    fs::write(temp.child("blob.bin").path(), vec![0x5A_u8; 4096]).expect("fixture");

    let json = run_single_json_event(
        &[
            "checksum",
            "--input",
            temp.child("blob.bin").path().to_str().expect("path"),
            "--algo",
            "crc32",
            "--json",
        ],
        0,
    );
    assert_eq!(json["status"], "succeeded");
    assert!(json["details"]["platform"].is_null());
}

// ---- relocated from shared.rs (single-module helpers) ----

fn write_gzip_fixture(source_path: &Path, gzip_path: &Path) {
    let source = fs::read(source_path).expect("read gzip source");
    let output = File::create(gzip_path).expect("create gzip fixture");
    let mut encoder = GzEncoder::new(output, DeflateCompression::default());
    encoder.write_all(&source).expect("write gzip fixture");
    encoder.finish().expect("finish gzip fixture");
}
