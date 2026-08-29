use std::collections::BTreeMap;

use super::shared::*;

/// Build a real BPS patch (with embedded source/target CRC32 + size footer) by diffing two inputs.
fn create_bps_patch(
    temp: &TempDir,
    original_bytes: &[u8],
    modified_bytes: &[u8],
    name: &str,
) -> PathBuf {
    let original = temp.child("bps-original.bin");
    let modified = temp.child("bps-modified.bin");
    fs::write(original.path(), original_bytes).expect("bps original fixture");
    fs::write(modified.path(), modified_bytes).expect("bps modified fixture");
    let patch = temp.child(name);
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
    patch.path().to_path_buf()
}

fn ingest_terminal(args: &[&str]) -> Value {
    run_single_json_event(args, 0)
}

/// Ingest a two-track CD CHD against a per-track (Redump-shaped) pack: the
/// single-blob lookup cannot match track_file components, so the disc-group
/// fingerprint built from the streamed track checksums must. A first ingest
/// without a database supplies the split tracks' checksums for the pack.
#[test]
fn ingest_identifies_a_chd_disc_from_per_track_pack_components() {
    let temp = setup_temp_dir();
    let chd_path = create_two_track_cd_chd(&temp);
    let probe_out = temp.child("ingest-probe-out");
    let probe = ingest_terminal(&[
        "ingest",
        "--input",
        chd_path.to_str().expect("chd path"),
        "--output",
        probe_out.path().to_str().expect("output path"),
        "--json",
    ]);
    let track_components: Vec<Value> = probe["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets")
        .iter()
        .filter(|asset| asset["file_name"].as_str().unwrap_or("").ends_with(".bin"))
        .enumerate()
        .map(|(index, asset)| {
            serde_json::json!({
                "role": "data_track",
                "ordinal": index,
                "hashScope": "track_file",
                "track": index + 1,
                "size": asset["size_bytes"],
                "crc32": asset["checksums"]["crc32"],
                "required": true,
                "discriminating": index == 0,
            })
        })
        .collect();
    assert_eq!(
        track_components.len(),
        2,
        "expected two split tracks: {probe:?}"
    );
    let pack_bytes = super::identify_database::pack_v2(
        "Sony - PlayStation",
        "redump-cd-track-v1",
        &[("Two Track Quest (USA)", track_components)],
    );
    let pack = temp.child("psx.pack");
    fs::write(pack.path(), pack_bytes).expect("pack fixture");
    let out_dir = temp.child("ingest-chd-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        chd_path.to_str().expect("chd path"),
        "--output",
        out_dir.path().to_str().expect("output path"),
        "--database",
        pack.path().to_str().expect("pack path"),
        "--json",
    ]);
    let assets = terminal["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets");
    let tracks: Vec<&Value> = assets
        .iter()
        .filter(|asset| asset["file_name"].as_str().unwrap_or("").ends_with(".bin"))
        .collect();
    assert_eq!(tracks.len(), 2, "expected two track assets: {assets:?}");
    for track in tracks {
        let identification = &track["identification"];
        assert_eq!(
            identification["status"], "matched",
            "track should carry the disc-group match: {identification:?}"
        );
        assert_eq!(
            identification["matches"][0]["name"],
            "Two Track Quest (USA)"
        );
        assert_eq!(identification["matches"][0]["variant"], "disc-tracks");
    }
}

/// A bare `.cue` with its track files beside it (no container at all): ingest
/// groups the sheet with each referenced file, checksums them in place, and the
/// disc-group fingerprint matches the per-track pack entries.
#[test]
fn ingest_identifies_a_bare_cue_with_sibling_tracks() {
    let temp = setup_temp_dir();
    let track1 = (0..2352_usize * 4)
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    let track2 = (0..2352_usize * 3)
        .map(|index| (index % 91) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("Raw Quest (USA) (Track 1).bin").path(), &track1).expect("track fixture");
    fs::write(temp.child("Raw Quest (USA) (Track 2).bin").path(), &track2).expect("track fixture");
    temp.child("Raw Quest (USA).cue")
        .write_str(
            "FILE \"Raw Quest (USA) (Track 1).bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\nFILE \"Raw Quest (USA) (Track 2).bin\" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n",
        )
        .expect("cue fixture");
    let cue_path = temp.child("Raw Quest (USA).cue");
    let out_dir = temp.child("bare-cue-out");
    let probe = ingest_terminal(&[
        "ingest",
        "--input",
        cue_path.path().to_str().expect("cue path"),
        "--output",
        out_dir.path().to_str().expect("output path"),
        "--json",
    ]);
    let track_components: Vec<Value> = probe["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets")
        .iter()
        .filter(|asset| asset["file_name"].as_str().unwrap_or("").ends_with(".bin"))
        .enumerate()
        .map(|(index, asset)| {
            serde_json::json!({
                "role": "data_track",
                "ordinal": index,
                "hashScope": "track_file",
                "track": index + 1,
                "size": asset["size_bytes"],
                "crc32": asset["checksums"]["crc32"],
                "required": true,
                "discriminating": index == 0,
            })
        })
        .collect();
    assert_eq!(
        track_components.len(),
        2,
        "expected two bare tracks: {probe:?}"
    );
    let pack_bytes = super::identify_database::pack_v2(
        "Sony - PlayStation",
        "redump-cd-track-v1",
        &[("Raw Quest (USA)", track_components)],
    );
    let pack = temp.child("psx.pack");
    fs::write(pack.path(), pack_bytes).expect("pack fixture");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        cue_path.path().to_str().expect("cue path"),
        "--output",
        out_dir.path().to_str().expect("output path"),
        "--database",
        pack.path().to_str().expect("pack path"),
        "--json",
    ]);
    let assets = terminal["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets");
    assert_eq!(assets.len(), 3, "sheet plus two tracks: {assets:?}");
    for asset in assets {
        assert_eq!(
            asset["identification"]["status"], "matched",
            "every group member should carry the disc-group match: {asset:?}"
        );
        assert_eq!(
            asset["identification"]["matches"][0]["name"],
            "Raw Quest (USA)"
        );
    }
}

/// Same disc and pack as the split test above, but extracted as one merged bin
/// (`--split-bin false`): no per-track files exist, so the disc-group
/// fingerprint must come from the merged bin's streamed `track_checksums` rows.
#[test]
fn ingest_identifies_a_merged_bin_chd_disc_from_per_track_pack_components() {
    let temp = setup_temp_dir();
    let chd_path = create_two_track_cd_chd(&temp);
    let probe_out = temp.child("ingest-probe-out");
    let probe = ingest_terminal(&[
        "ingest",
        "--input",
        chd_path.to_str().expect("chd path"),
        "--output",
        probe_out.path().to_str().expect("output path"),
        "--json",
    ]);
    let track_components: Vec<Value> = probe["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets")
        .iter()
        .filter(|asset| asset["file_name"].as_str().unwrap_or("").ends_with(".bin"))
        .enumerate()
        .map(|(index, asset)| {
            serde_json::json!({
                "role": "data_track",
                "ordinal": index,
                "hashScope": "track_file",
                "track": index + 1,
                "size": asset["size_bytes"],
                "crc32": asset["checksums"]["crc32"],
                "required": true,
                "discriminating": index == 0,
            })
        })
        .collect();
    assert_eq!(track_components.len(), 2, "expected two split tracks");
    let pack_bytes = super::identify_database::pack_v2(
        "Sony - PlayStation",
        "redump-cd-track-v1",
        &[("Two Track Quest (USA)", track_components)],
    );
    let pack = temp.child("psx.pack");
    fs::write(pack.path(), pack_bytes).expect("pack fixture");
    let out_dir = temp.child("ingest-merged-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        chd_path.to_str().expect("chd path"),
        "--output",
        out_dir.path().to_str().expect("output path"),
        "--split-bin",
        "false",
        "--database",
        pack.path().to_str().expect("pack path"),
        "--json",
    ]);
    let assets = terminal["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets");
    let bins: Vec<&Value> = assets
        .iter()
        .filter(|asset| asset["file_name"].as_str().unwrap_or("").ends_with(".bin"))
        .collect();
    assert_eq!(bins.len(), 1, "expected one merged bin: {assets:?}");
    let identification = &bins[0]["identification"];
    assert_eq!(
        identification["status"], "matched",
        "merged bin should carry the disc-group match: {identification:?}"
    );
    assert_eq!(
        identification["matches"][0]["name"],
        "Two Track Quest (USA)"
    );
    assert_eq!(identification["matches"][0]["variant"], "disc-tracks");
}

fn create_ingest_patch(
    temp: &TempDir,
    format: &str,
    extension: &str,
    source: &[u8],
    target: &[u8],
    file_name: &str,
) -> PathBuf {
    let source_path = temp.child("patch-source.bin");
    let target_path = temp.child("patch-target.bin");
    let patch_path = temp.child(file_name);
    fs::write(source_path.path(), source).expect("patch source fixture");
    fs::write(target_path.path(), target).expect("patch target fixture");
    command_stdout(
        &[
            "patch",
            "create",
            "--original",
            source_path.path().to_str().expect("source path"),
            "--modified",
            target_path.path().to_str().expect("target path"),
            "--format",
            format,
            "--output",
            patch_path.path().to_str().expect("patch path"),
            "--json",
        ],
        0,
    );
    assert!(
        patch_path
            .path()
            .extension()
            .and_then(|value| value.to_str())
            == Some(extension),
        "created patch has the expected extension"
    );
    patch_path.path().to_path_buf()
}

fn parse_md5_hex(value: &str) -> [u8; 16] {
    let bytes = value.as_bytes();
    assert_eq!(bytes.len(), 32, "MD5 hex length");
    let mut output = [0_u8; 16];
    for (index, slot) in output.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).expect("MD5 hex");
    }
    output
}

#[test]
fn ingest_identifies_asset_from_existing_checksum_variants() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"ingest identify fixture").expect("ROM fixture");
    let crc32 = u32::from_str_radix(&checksum_value(rom.path(), "crc32"), 16)
        .expect("CRC32")
        .to_be_bytes();
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_crc(crc32, "Ingest Identify Test [!]"),
    )
    .expect("identify pack");
    let out_dir = temp.child("ingest-identify-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        rom.path().to_str().expect("ROM path"),
        "--output",
        out_dir.path().to_str().expect("output path"),
        "--database",
        pack.path().to_str().expect("pack path"),
        "--json",
    ]);
    let identification = &terminal["details"]["ingest"]["assets"][0]["identification"];
    assert_eq!(identification["status"], "matched");
    assert_eq!(
        identification["matches"][0]["name"],
        "Ingest Identify Test [!]"
    );
    assert_eq!(identification["matches"][0]["variant"], "raw");
}

/// Build a tar.gz holding several NES ROMs at nested member paths and return
/// their CRC32 bytes in the same order.
fn nested_rom_archive(temp: &TempDir, payloads: &[(&str, &[u8])]) -> (PathBuf, Vec<[u8; 4]>) {
    let mut sources = Vec::new();
    let mut crc32s = Vec::new();
    for (member_path, payload) in payloads {
        let file_name = member_path.rsplit('/').next().expect("member file name");
        let rom = temp.child(file_name);
        fs::write(rom.path(), with_nes_header(payload)).expect("ROM fixture");
        crc32s.push(
            u32::from_str_radix(&checksum_value(rom.path(), "crc32"), 16)
                .expect("CRC32")
                .to_be_bytes(),
        );
        sources.push((rom.path().to_path_buf(), (*member_path).to_string()));
    }
    let archive = temp.child("collection.tar.gz");
    let entries = sources
        .iter()
        .map(|(path, name)| (path.as_path(), name.as_str()))
        .collect::<Vec<_>>();
    write_tar_gz_fixture(&entries, archive.path());
    (archive.path().to_path_buf(), crc32s)
}

fn archive_identification_by_file_name(
    temp: &TempDir,
    archive: &Path,
    pack: &Path,
) -> BTreeMap<String, Value> {
    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        archive.to_str().expect("archive path"),
        "--output",
        temp.child("ingest-archive-identify-out")
            .path()
            .to_str()
            .expect("output path"),
        "--database",
        pack.to_str().expect("pack path"),
        "--json",
    ]);
    terminal["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets array")
        .iter()
        .map(|asset| {
            (
                asset["file_name"].as_str().expect("file name").to_string(),
                asset["identification"].clone(),
            )
        })
        .collect()
}

#[test]
fn ingest_identifies_a_single_rom_archive_member() {
    let temp = setup_temp_dir();
    let (archive, crc32s) = nested_rom_archive(&temp, &[("Games/GBA/solo.nes", b"solo payload")]);
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_entries(&[(crc32s[0], "Solo Game (USA)")]),
    )
    .expect("identify pack");

    let identifications = archive_identification_by_file_name(&temp, &archive, pack.path());

    assert_eq!(identifications.len(), 1);
    let solo = &identifications["solo.nes"];
    assert_eq!(solo["status"], "matched");
    assert_eq!(solo["matches"][0]["name"], "Solo Game (USA)");
}

#[test]
fn ingest_identifies_every_rom_in_a_multi_rom_archive() {
    let temp = setup_temp_dir();
    let (archive, crc32s) = nested_rom_archive(
        &temp,
        &[
            ("Games/NES/first.nes", b"first payload"),
            ("Games/NES/deeper/second.nes", b"second payload"),
        ],
    );
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_entries(&[
            (crc32s[0], "First Game (USA)"),
            (crc32s[1], "Second Game (Europe)"),
        ]),
    )
    .expect("identify pack");

    let identifications = archive_identification_by_file_name(&temp, &archive, pack.path());

    // Every member gets its own verdict; none is dropped in favour of a single winner.
    assert_eq!(identifications.len(), 2);
    assert_eq!(identifications["first.nes"]["status"], "matched");
    assert_eq!(
        identifications["first.nes"]["matches"][0]["name"],
        "First Game (USA)"
    );
    assert_eq!(identifications["second.nes"]["status"], "matched");
    assert_eq!(
        identifications["second.nes"]["matches"][0]["name"],
        "Second Game (Europe)"
    );
}

#[test]
fn ingest_identifies_only_the_matching_archive_member() {
    let temp = setup_temp_dir();
    let (archive, crc32s) = nested_rom_archive(
        &temp,
        &[
            ("Games/NES/known.nes", b"known payload"),
            ("Games/NES/unknown.nes", b"unknown payload"),
        ],
    );
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_entries(&[(crc32s[0], "Known Game (USA)")]),
    )
    .expect("identify pack");

    let identifications = archive_identification_by_file_name(&temp, &archive, pack.path());

    assert_eq!(identifications["known.nes"]["status"], "matched");
    // The unmatched member reports `unknown`, not the matched member's title.
    assert_eq!(identifications["unknown.nes"]["status"], "unknown");
    assert_eq!(
        identifications["unknown.nes"]["matches"],
        serde_json::json!([])
    );
}

#[test]
fn ingest_reports_unknown_for_an_archive_with_no_matching_member() {
    let temp = setup_temp_dir();
    let (archive, _) = nested_rom_archive(
        &temp,
        &[
            ("Games/NES/one.nes", b"one payload"),
            ("Games/NES/two.nes", b"two payload"),
        ],
    );
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_entries(&[([0xff, 0xff, 0xff, 0xff], "Absent Game")]),
    )
    .expect("identify pack");

    let identifications = archive_identification_by_file_name(&temp, &archive, pack.path());

    assert!(
        identifications
            .values()
            .all(|identification| identification["status"] == "unknown"),
        "a database that answered with no record MUST read as unknown: {identifications:?}"
    );
}

#[test]
fn ingest_rejects_an_invalid_identify_pack() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"ingest identify fixture").expect("ROM fixture");
    let pack = temp.child("broken.pack");
    fs::write(pack.path(), b"not an RWFP1 pack").expect("invalid identify pack");

    let output = command_stdout(
        &[
            "ingest",
            "--input",
            rom.path().to_str().expect("ROM path"),
            "--output",
            temp.child("ingest-invalid-pack-out")
                .path()
                .to_str()
                .expect("output path"),
            "--database",
            pack.path().to_str().expect("pack path"),
            "--json",
        ],
        1,
    );
    let terminal = parse_single_json_line(&output);
    assert_eq!(terminal["command"], "ingest");
    assert_eq!(terminal["status"], "failed");
    assert_eq!(terminal["stage"], "identify");
}

/// Build a 2-track CD CHD (MODE1 data + AUDIO, uniform 2352-byte sectors) so it offers the
/// merged-vs-split choice (merged → one .bin, split → per-track .bin).
fn create_two_track_cd_chd(temp: &TempDir) -> PathBuf {
    let frames = 8_u32;
    let source = (0..(frames as usize * 2352))
        .map(|index| (index % 173) as u8)
        .collect::<Vec<_>>();
    fs::write(temp.child("disc.bin").path(), &source).expect("bin fixture");
    temp.child("disc.cue")
        .write_str(
            "FILE \"disc.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 00 00:00:04\n    INDEX 01 00:00:06\n",
        )
        .expect("cue fixture");
    let chd_path = temp.child("disc.chd");
    command_stdout(
        &[
            "compress",
            "--input",
            temp.child("disc.cue").path().to_str().expect("path"),
            "--format",
            "chd",
            "--output",
            chd_path.path().to_str().expect("path"),
            "--codec",
            "zstd",
            "--json",
        ],
        0,
    );
    chd_path.path().to_path_buf()
}

fn ingest_bin_asset_count(terminal: &Value) -> usize {
    terminal["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets array")
        .iter()
        .filter(|asset| {
            asset["file_name"]
                .as_str()
                .map(|name| name.to_ascii_lowercase().ends_with(".bin"))
                .unwrap_or(false)
        })
        .count()
}

#[test]
fn ingest_sidecar_preflight_matches_loose_siblings() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    fs::write(rom.path(), b"rom").expect("rom fixture");
    let out_dir = temp.child("sidecar-preflight");
    let rom_path = rom.path().to_str().expect("rom path");
    let first_patch = temp.child("game.ips");
    let second_patch = temp.child("game.ips1");
    let unrelated = temp.child("other.ips");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        rom_path,
        "--output",
        out_dir.path().to_str().expect("out dir"),
        "--sidecar-only",
        "--sidecar-name",
        first_patch.path().to_str().expect("first patch path"),
        "--sidecar-name",
        second_patch.path().to_str().expect("second patch path"),
        "--sidecar-name",
        unrelated.path().to_str().expect("unrelated patch path"),
        "--json",
    ]);
    let matches = terminal["details"]["sidecar_matches"]
        .as_array()
        .expect("sidecar matches");
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0]["name"], first_patch.path().to_str().unwrap());
    assert_eq!(matches[0]["order"], 0);
    assert_eq!(matches[1]["name"], second_patch.path().to_str().unwrap());
    assert_eq!(matches[1]["order"], 1);
}

#[test]
fn ingest_chd_split_bin_false_merges_to_single_bin() {
    let temp = setup_temp_dir();
    let chd = create_two_track_cd_chd(&temp);
    let out_dir = temp.child("ingest-chd-merged");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        chd.to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--split-bin",
        "false",
        "--json",
    ]);
    assert_eq!(terminal["details"]["ingest"]["kind"], "rom");
    assert_eq!(
        ingest_bin_asset_count(&terminal),
        1,
        "merged extraction yields a single .bin"
    );
}

#[test]
fn ingest_chd_split_bin_true_fans_out_per_track() {
    let temp = setup_temp_dir();
    let chd = create_two_track_cd_chd(&temp);
    let out_dir = temp.child("ingest-chd-split");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        chd.to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--split-bin",
        "true",
        "--json",
    ]);
    assert_eq!(terminal["details"]["ingest"]["kind"], "rom");
    assert_eq!(
        ingest_bin_asset_count(&terminal),
        2,
        "forced split extraction yields a .bin per track"
    );
}

#[test]
fn ingest_chd_default_splits_per_track_without_a_host_prompt() {
    let temp = setup_temp_dir();
    let chd = create_two_track_cd_chd(&temp);
    let out_dir = temp.child("ingest-chd-default");

    // No --split-bin and no interactive host: the eligible multi-track CD defaults to per-track split.
    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        chd.to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    assert_eq!(
        ingest_bin_asset_count(&terminal),
        2,
        "an eligible CD defaults to per-track split when the host cannot be asked"
    );
}

#[test]
fn ingest_bare_rom_checksums_in_place() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"bare rom payload")).expect("rom fixture");
    let out_dir = temp.child("ingest-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        rom.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    assert_eq!(terminal["command"], "ingest");
    assert_eq!(terminal["status"], "succeeded");

    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "rom");
    assert_eq!(ingest["is_rom"], true);
    assert_eq!(ingest["source_file_name"], "game.nes");
    assert!(
        ingest["patches"]
            .as_array()
            .expect("patches array")
            .is_empty(),
        "a bare ROM surfaces no patches"
    );

    let assets = ingest["assets"].as_array().expect("assets array");
    assert_eq!(assets.len(), 1, "a bare ROM is a single asset");
    let asset = &assets[0];
    assert_eq!(asset["file_name"], "game.nes");
    assert_eq!(
        asset["copied_in_place"], true,
        "a bare ROM is checksummed in place, never copied"
    );
    assert_eq!(
        asset["platform"], "Nintendo Entertainment System",
        "the iNES header resolves the platform identity"
    );
    // The raw checksums match an independent checksum of the same bytes.
    assert_eq!(
        asset["checksums"]["sha1"].as_str().expect("sha1"),
        checksum_value(rom.path(), "sha1")
    );
    assert_eq!(
        asset["checksums"]["crc32"].as_str().expect("crc32"),
        checksum_value(rom.path(), "crc32")
    );
    assert!(
        !asset["checksum_variants"]
            .as_array()
            .expect("variants array")
            .is_empty(),
        "checksum variants are computed"
    );
}

#[test]
fn ingest_gamecube_iso_recommends_rvz() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.iso");
    fs::write(rom.path(), build_test_gamecube_iso(0x8000)).expect("gamecube iso fixture");
    let out_dir = temp.child("ingest-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        rom.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    assert_eq!(terminal["status"], "succeeded");

    let assets = terminal["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets array");
    let asset = assets
        .iter()
        .find(|asset| asset["platform"] == "Nintendo GameCube")
        .expect("a GameCube asset is detected from the bare .iso disc magic");
    assert_eq!(
        asset["recommended_format"], "rvz",
        "a GameCube disc auto-recommends RVZ from content, even though the extension is a bare .iso"
    );
}

#[test]
fn ingest_rom_archive_extracts_and_checksums() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"archived rom payload")).expect("rom fixture");
    let archive = temp.child("bundle.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            rom.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let out_dir = temp.child("ingest-archive-out");

    let events = run_json_events(
        &[
            "ingest",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    // The early manifest still streams so the host can route + render immediately.
    let manifest = events
        .iter()
        .find(|event| event["stage"] == "probe-manifest")
        .map(|event| &event["details"]["probe_manifest"])
        .expect("expected an early probe-manifest event");
    assert_eq!(manifest["is_rom"], true);

    let terminal = events.last().expect("terminal event");
    assert_eq!(terminal["command"], "ingest");
    assert_eq!(terminal["status"], "succeeded");
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "rom");
    let assets = ingest["assets"].as_array().expect("assets array");
    assert_eq!(assets.len(), 1);
    let asset = &assets[0];
    assert_eq!(asset["file_name"], "game.nes");
    assert_eq!(
        asset["copied_in_place"], false,
        "an archived ROM is extracted, not checksummed in place"
    );
    // The extracted leaf hashes identically to the original entry bytes.
    assert_eq!(
        asset["checksums"]["sha1"].as_str().expect("sha1"),
        checksum_value(rom.path(), "sha1")
    );
    assert_eq!(asset["platform"], "Nintendo Entertainment System");
}

#[test]
fn ingest_nested_rom_archive_descends_to_leaf() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"nested rom payload")).expect("rom fixture");
    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            rom.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let outer = temp.child("outer.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "inner.zip")], outer.path());
    let out_dir = temp.child("ingest-nested-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        outer.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "rom");
    let assets = ingest["assets"].as_array().expect("assets array");
    let leaf = assets
        .iter()
        .find(|asset| asset["file_name"] == "game.nes")
        .expect("nested ROM leaf surfaced");
    assert_eq!(
        leaf["checksums"]["sha1"].as_str().expect("sha1"),
        checksum_value(rom.path(), "sha1")
    );
}

#[test]
fn ingest_nested_patch_archive_routes_as_patch_source() {
    // A patch bundled inside a nested archive: the OUTER archive's only entry is the inner container,
    // so the top-level classify sees no patch name and defaults to `is_rom = true`. The rom-filtered
    // descent then finds no ROM in the inner archive - ingest must fall back to patch ingestion and
    // route the whole bundle as a patch source instead of erroring with "no entries matched --filter rom".
    let temp = setup_temp_dir();
    let patch = temp.child("hack.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"patched".to_vec(),
            }],
            None,
        ),
    )
    .expect("ips fixture");
    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            patch.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let outer = temp.child("outer.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "inner.zip")], outer.path());
    let out_dir = temp.child("ingest-nested-patch-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        outer.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch");
    assert_eq!(ingest["is_rom"], false);
    assert!(
        ingest["assets"]
            .as_array()
            .expect("assets array")
            .is_empty(),
        "a nested patch bundle surfaces no ROM assets"
    );
    let patches = ingest["patches"].as_array().expect("patches array");
    assert_eq!(patches.len(), 1, "the nested patch leaf is surfaced");
    assert_eq!(
        patches[0]["is_valid_patch"], true,
        "the nested IPS leaf parses, so it is marked valid"
    );
}

#[test]
fn ingest_nested_patch_archive_routes_as_patch_source_with_rom_select() {
    // Same nested-patch-only bundle as above, but ingested WITH a ROM keep-one `--select` glob.
    // The fallback patch enumeration must ignore that glob (it enumerates with `&[]`): a ROM select
    // that filters the descent must NOT also filter the bundle's patch leaves, or a select-present
    // drop of a nested patch bundle regresses to "no ROM". Reverting the fallback to `raw_selections`
    // makes the `*.nes` glob drop the `.ips` leaf, leaving no patches and surfacing the ROM error.
    let temp = setup_temp_dir();
    let patch = temp.child("hack.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"patched".to_vec(),
            }],
            None,
        ),
    )
    .expect("ips fixture");
    let inner = temp.child("inner.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            patch.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let outer = temp.child("outer.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "inner.zip")], outer.path());
    let out_dir = temp.child("ingest-nested-patch-select-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        outer.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--select",
        "*.nes",
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch");
    assert_eq!(ingest["is_rom"], false);
    assert!(
        ingest["assets"]
            .as_array()
            .expect("assets array")
            .is_empty(),
        "a nested patch bundle surfaces no ROM assets"
    );
    let patches = ingest["patches"].as_array().expect("patches array");
    assert_eq!(
        patches.len(),
        1,
        "the nested patch leaf is surfaced despite the ROM `--select`"
    );
    assert_eq!(
        patches[0]["is_valid_patch"], true,
        "the nested IPS leaf parses, so it is marked valid"
    );
}

#[test]
fn ingest_bare_ips_patch_describes_without_checksumming() {
    let temp = setup_temp_dir();
    let patch = temp.child("hack.ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 0,
                data: b"patched".to_vec(),
            }],
            None,
        ),
    )
    .expect("ips fixture");
    let out_dir = temp.child("ingest-ips-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch");
    assert_eq!(ingest["is_rom"], false);
    assert!(
        ingest["assets"]
            .as_array()
            .expect("assets array")
            .is_empty(),
        "a patch source never produces ROM assets"
    );
    let patches = ingest["patches"].as_array().expect("patches array");
    assert_eq!(patches.len(), 1);
    let descriptor = &patches[0];
    assert_eq!(descriptor["file_name"], "hack.ips");
    assert!(
        !descriptor["format"].as_str().expect("format").is_empty(),
        "the patch format is reported"
    );
    assert_eq!(
        descriptor["is_valid_patch"], true,
        "a real IPS patch parses, so it is marked valid"
    );
    // IPS carries no embedded source/target checksums.
    assert!(descriptor["source_crc32"].is_null());
    assert!(descriptor["target_crc32"].is_null());
}

#[test]
fn ingest_invalid_patch_extension_is_marked_not_valid() {
    let temp = setup_temp_dir();
    // A `.ips` whose bytes are NOT a valid IPS patch (missing the PATCH/EOF framing): recognized by
    // extension but fails to parse, so `is_valid_patch` is false (no re-extraction needed by the host).
    let patch = temp.child("broken.ips");
    fs::write(patch.path(), b"this is not an ips patch at all").expect("fixture");
    let out_dir = temp.child("ingest-invalid-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let descriptor = &terminal["details"]["ingest"]["patches"][0];
    assert_eq!(descriptor["file_name"], "broken.ips");
    assert_eq!(
        descriptor["is_valid_patch"], false,
        "a malformed IPS is recognized by extension but does not parse: {descriptor}"
    );
}

#[test]
fn ingest_bps_patch_surfaces_embedded_metadata() {
    let temp = setup_temp_dir();
    let patch = create_bps_patch(
        &temp,
        b"original payload bytes",
        b"modified payload BYTES",
        "update.bps",
    );
    let out_dir = temp.child("ingest-bps-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let descriptor = &terminal["details"]["ingest"]["patches"][0];
    assert_eq!(descriptor["file_name"], "update.bps");
    // BPS embeds source/target CRC32 + size and a patch CRC32 footer.
    assert!(
        descriptor["source_crc32"].as_u64().is_some(),
        "BPS embeds the source CRC32: {descriptor}"
    );
    assert!(descriptor["target_crc32"].as_u64().is_some());
    assert!(descriptor["patch_crc32"].as_u64().is_some());
    assert!(descriptor["source_size"].as_u64().is_some());
    assert!(descriptor["target_size"].as_u64().is_some());
    assert_eq!(
        descriptor["is_valid_patch"], true,
        "a real BPS patch parses, so it is marked valid"
    );
}

#[test]
fn ingest_identifies_bps_patch_source_from_source_crc32() {
    let temp = setup_temp_dir();
    let patch = create_bps_patch(
        &temp,
        b"identify this BPS source",
        b"identify this BPS target",
        "update.bps",
    );
    let source_crc32 = u32::from_str_radix(
        &checksum_value(temp.child("bps-original.bin").path(), "crc32"),
        16,
    )
    .expect("CRC32")
    .to_be_bytes();
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_crc(source_crc32, "BPS Source Test [!]"),
    )
    .expect("identify pack");
    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.to_str().expect("patch path"),
        "--output",
        temp.child("ingest-patch-identify-out")
            .path()
            .to_str()
            .expect("output path"),
        "--database",
        pack.path().to_str().expect("pack path"),
        "--json",
    ]);
    let identification = &terminal["details"]["ingest"]["patches"][0]["source_identification"];
    assert_eq!(identification["status"], "matched");
    assert_eq!(identification["matches"][0]["name"], "BPS Source Test [!]");
    assert_eq!(identification["matches"][0]["variant"], "source");
}

#[test]
fn ingest_identifies_rup_source_from_endpoint_md5() {
    let temp = setup_temp_dir();
    let source = b"RUP source identity fixture";
    let patch = create_ingest_patch(
        &temp,
        "rup",
        "rup",
        source,
        b"RUP target identity fixture",
        "update.rup",
    );
    let pack = temp.child("rup.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_md5(
            parse_md5_hex(&checksum_value(
                temp.child("patch-source.bin").path(),
                "md5",
            )),
            "RUP Endpoint Test [!]",
        ),
    )
    .expect("identify pack");
    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.to_str().expect("patch path"),
        "--output",
        temp.child("ingest-rup-identify-out")
            .path()
            .to_str()
            .expect("output path"),
        "--database",
        pack.path().to_str().expect("pack path"),
        "--json",
    ]);
    let descriptor = &terminal["details"]["ingest"]["patches"][0];
    assert_eq!(
        descriptor["source_checksum_variants"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        descriptor["source_checksum_variants"][0]["md5"],
        checksum_value(temp.child("patch-source.bin").path(), "md5")
    );
    assert_eq!(descriptor["source_identification"]["status"], "matched");
    assert_eq!(
        descriptor["source_identification"]["matches"][0]["name"],
        "RUP Endpoint Test [!]"
    );
}

#[test]
fn ingest_prefers_solid_endpoint_md5_over_conflicting_filename_md5() {
    let temp = setup_temp_dir();
    let source = b"SOLID source identity fixture";
    let wrong_md5 = "00000000000000000000000000000000";
    let patch = create_ingest_patch(
        &temp,
        "solid",
        "solid",
        source,
        b"SOLID target identity fixture",
        &format!("update [md5:{wrong_md5}].solid"),
    );
    let pack = temp.child("solid.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_md5(
            parse_md5_hex(&checksum_value(
                temp.child("patch-source.bin").path(),
                "md5",
            )),
            "SOLID Endpoint Test [!]",
        ),
    )
    .expect("identify pack");
    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.to_str().expect("patch path"),
        "--output",
        temp.child("ingest-solid-identify-out")
            .path()
            .to_str()
            .expect("output path"),
        "--database",
        pack.path().to_str().expect("pack path"),
        "--json",
    ]);
    let descriptor = &terminal["details"]["ingest"]["patches"][0];
    assert_eq!(descriptor["filename_checksums"]["md5"], wrong_md5);
    assert_eq!(descriptor["source_identification"]["status"], "matched");
    assert_eq!(
        descriptor["source_identification"]["matches"][0]["name"],
        "SOLID Endpoint Test [!]"
    );
}

#[test]
fn ingest_patch_parses_filename_requirements() {
    let temp = setup_temp_dir();
    let patch = temp.child("hack [crc32:1a2b3c4d].ips");
    fs::write(
        patch.path(),
        build_ips_patch(
            vec![TestIpsRecord::Literal {
                offset: 4,
                data: b"x".to_vec(),
            }],
            None,
        ),
    )
    .expect("ips fixture");
    let out_dir = temp.child("ingest-fnreq-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let descriptor = &terminal["details"]["ingest"]["patches"][0];
    assert_eq!(
        descriptor["filename_checksums"]["crc32"], "1a2b3c4d",
        "the input CRC32 requirement is parsed from the file name"
    );
}

#[test]
fn ingest_patch_archive_extracts_and_describes_leaves() {
    let temp = setup_temp_dir();
    let patch = create_bps_patch(&temp, b"abcdefgh", b"abXYefgh", "fix.bps");
    let archive = temp.child("patches.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            patch.to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let out_dir = temp.child("ingest-patch-archive-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        archive.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch");
    let patches = ingest["patches"].as_array().expect("patches array");
    let descriptor = patches
        .iter()
        .find(|descriptor| descriptor["file_name"] == "fix.bps")
        .expect("patch leaf surfaced");
    // The leaf was extracted under the requested out_dir.
    let leaf_path = descriptor["leaf_path"].as_str().expect("leaf_path");
    assert!(
        leaf_path.starts_with(&expected_event_path(out_dir.path())),
        "patch leaf extracted under out_dir: {leaf_path}"
    );
    assert!(descriptor["source_crc32"].as_u64().is_some());
}

#[test]
fn ingest_mixed_archive_surfaces_rom_and_sidecar_patch() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"mixed rom payload")).expect("rom fixture");
    // A sidecar patch sharing the ROM stem applies in libretro order 0.
    let patch = create_bps_patch(&temp, b"abcdefgh", b"abZZefgh", "game.bps");
    let archive = temp.child("mixed.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            rom.path().to_str().expect("path"),
            "--input",
            patch.to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let out_dir = temp.child("ingest-mixed-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        archive.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    // A bundle carrying a ROM routes to the ROM bucket, but still surfaces the bundled patch.
    assert_eq!(ingest["kind"], "rom");
    let assets = ingest["assets"].as_array().expect("assets array");
    assert!(
        assets.iter().any(|asset| asset["file_name"] == "game.nes"),
        "the ROM is checksummed"
    );
    let patches = ingest["patches"].as_array().expect("patches array");
    let descriptor = patches
        .iter()
        .find(|descriptor| descriptor["file_name"] == "game.bps")
        .expect("sidecar patch surfaced");
    assert_eq!(
        descriptor["sidecar_order"], 0,
        "the sidecar patch matches the ROM stem at libretro order 0"
    );
}

#[test]
fn ingest_mixed_archive_surfaces_sidecar_patch_independent_of_rom_selection() {
    // A keep-one ROM `--select` pins which ROM is extracted, but it must NOT suppress the bundle's
    // sidecar patches: they are enumerated independently so the host can still offer to apply them.
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"selected rom payload")).expect("rom fixture");
    let other = temp.child("other.nes");
    fs::write(other.path(), with_nes_header(b"other rom payload")).expect("other rom fixture");
    let patch = create_bps_patch(&temp, b"abcdefgh", b"abZZefgh", "game.bps");
    let archive = temp.child("mixed-multi.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            rom.path().to_str().expect("path"),
            "--input",
            other.path().to_str().expect("path"),
            "--input",
            patch.to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let out_dir = temp.child("ingest-mixed-multi-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        archive.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--select",
        "game.nes",
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "rom");
    let assets = ingest["assets"].as_array().expect("assets array");
    assert!(
        assets.iter().any(|asset| asset["file_name"] == "game.nes"),
        "the selected ROM is extracted + checksummed"
    );
    assert!(
        !assets.iter().any(|asset| asset["file_name"] == "other.nes"),
        "the unselected ROM is not extracted"
    );
    let patches = ingest["patches"].as_array().expect("patches array");
    assert!(
        patches
            .iter()
            .any(|descriptor| descriptor["file_name"] == "game.bps"),
        "the sidecar patch is surfaced despite the ROM `--select`"
    );
}

#[test]
fn ingest_streams_patch_manifest_before_terminal_for_mixed_archive() {
    // The sidecar patch descriptors stream in an early `patch-manifest` event - before the ROM is
    // checksummed and before the terminal report - so the host can open the patch-selection dialog
    // while the (slower) ROM hashing finishes instead of waiting for the whole ingest to return.
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"mixed rom payload")).expect("rom fixture");
    let patch = create_bps_patch(&temp, b"abcdefgh", b"abZZefgh", "game.bps");
    let archive = temp.child("mixed-stream.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            rom.path().to_str().expect("path"),
            "--input",
            patch.to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let out_dir = temp.child("ingest-stream-out");

    let events = run_json_events(
        &[
            "ingest",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let manifest_index = events
        .iter()
        .position(|event| event["stage"] == "patch-manifest")
        .expect("expected an early patch-manifest event");
    let terminal_index = events
        .iter()
        .rposition(|event| event["status"] == "succeeded")
        .expect("expected a terminal succeeded event");
    assert!(
        manifest_index < terminal_index,
        "patch-manifest must precede the terminal report"
    );
    let patches = events[manifest_index]["details"]["patch_manifest"]["patches"]
        .as_array()
        .expect("patch-manifest patches array");
    let descriptor = patches
        .iter()
        .find(|descriptor| descriptor["file_name"] == "game.bps")
        .expect("the streamed patch-manifest carries the sidecar patch descriptor");
    assert_eq!(
        descriptor["is_valid_patch"], true,
        "the streamed descriptor carries the same parsed metadata as the terminal result"
    );
}

#[test]
fn ingest_rejects_unsupported_checksum_algorithm() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"rom")).expect("rom fixture");
    let out_dir = temp.child("ingest-bad-algo-out");

    // --checksum is backed by the checksum registry's possible values, so clap
    // rejects an unknown algorithm before the command runs (exit 2, usage
    // error) and lists the valid ones.
    let mut command = Command::cargo_bin("rom-weaver").expect("binary");
    let assert = command
        .args([
            "ingest",
            "--input",
            rom.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--checksum",
            "not-a-real-algo",
            "--json",
        ])
        .assert()
        .code(2);
    let stderr = String::from_utf8_lossy(&assert.get_output().stderr).into_owned();
    assert!(
        stderr.contains("invalid value 'not-a-real-algo'"),
        "{stderr}"
    );
    assert!(stderr.contains("crc32"), "{stderr}");
}

#[test]
fn ingest_streams_recommended_format_for_bare_disc_before_completion() {
    // The host settles its automatic output format from this event, so it must arrive before the
    // checksum pass rather than with the terminal report - otherwise a multi-GB disc image spends
    // its whole hash showing an extension-guessed format that then snaps to rvz at the end.
    let temp = setup_temp_dir();
    let iso = temp.child("game.iso");
    fs::write(iso.path(), build_test_gamecube_iso(0x8000)).expect("iso fixture");
    let out_dir = temp.child("ingest-bare-identity-out");

    let events = run_json_events(
        &[
            "ingest",
            "--input",
            iso.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let identity_index = events
        .iter()
        .position(|event| event["stage"] == "probe-identity")
        .expect("expected a streaming probe-identity event for a bare source");
    let terminal_index = events
        .iter()
        .rposition(|event| event["status"] == "succeeded")
        .expect("expected a terminal succeeded event");
    assert!(
        identity_index < terminal_index,
        "identity must stream before completion"
    );
    let manifest = &events[identity_index]["details"]["probe_manifest"];
    assert_eq!(manifest["platform"], "Nintendo GameCube");
    assert_eq!(manifest["disc_format"], "DVD");
    assert_eq!(
        manifest["recommended_format"], "rvz",
        "a GameCube disc recommends rvz, and must say so before the checksum pass"
    );
    // A bare source is hashed in place, so this event must not claim an extraction is underway.
    assert!(
        events[identity_index]["details"]
            .get("probe_manifest")
            .and_then(|manifest| manifest.get("is_rom"))
            .is_none(),
        "the bare identity event carries no ROM-vs-patch routing verdict"
    );
}

#[test]
fn ingest_streams_recommended_format_for_archived_disc_before_completion() {
    // An archive's own `probe-manifest` resolves identity from the archive file, which says nothing
    // about the ROM inside; the decoded payload's `probe-identity` is the only early signal it gets.
    // The payload must exceed the 2 MiB identity-detection prefix, since the mid-extract identity
    // only becomes ready once that many bytes have streamed (a smaller one resolves at completion).
    let temp = setup_temp_dir();
    let iso = temp.child("game.iso");
    fs::write(iso.path(), build_test_gamecube_iso(3 * 1024 * 1024)).expect("iso fixture");
    let archive = temp.child("game.zip");
    command_stdout(
        &[
            "compress",
            "--input",
            iso.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            archive.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let out_dir = temp.child("ingest-archived-identity-out");

    let events = run_json_events(
        &[
            "ingest",
            "--input",
            archive.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let identity_index = events
        .iter()
        .position(|event| event["details"]["probe_manifest"]["recommended_format"] == "rvz")
        .expect("expected the decoded payload's recommendation to stream");
    let terminal_index = events
        .iter()
        .rposition(|event| event["status"] == "succeeded")
        .expect("expected a terminal succeeded event");
    assert!(
        identity_index < terminal_index,
        "the recommendation must stream before completion"
    );
}

#[test]
fn ingest_disc_asset_carries_engine_disc_format() {
    // The webapp's CHD output-panel disc label is now driven by this `disc_format`
    // verdict (engine identity), not a TS filename/cue regex - lock the contract.
    let temp = setup_temp_dir();
    let iso = temp.child("game.iso");
    fs::write(iso.path(), build_test_gamecube_iso(0x8000)).expect("iso fixture");
    let out_dir = temp.child("ingest-disc-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        iso.path().to_str().expect("path"),
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    assert_eq!(terminal["command"], "ingest");
    assert_eq!(terminal["status"], "succeeded");

    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "rom");
    let assets = ingest["assets"].as_array().expect("assets array");
    assert_eq!(assets.len(), 1, "a bare disc image is a single asset");
    let asset = &assets[0];
    assert_eq!(
        asset["platform"], "Nintendo GameCube",
        "the GameCube disc magic resolves the platform identity"
    );
    assert_eq!(
        asset["disc_format"], "DVD",
        "a GameCube disc image reports its optical medium as DVD"
    );
}
