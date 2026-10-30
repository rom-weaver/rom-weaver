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

#[test]
fn ingest_lz4_payload_completes_create_and_apply() {
    let temp = setup_temp_dir();
    let home = temp.child("home");
    fs::create_dir_all(home.path()).unwrap();
    let envs = [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
    ]
    .map(|key| (key, home.path().to_str().unwrap()));
    let run = |args: &[&str]| command_stdout_with_env(args, &envs, 0);
    let original: Vec<u8> = (0..4096).map(|i| (i * 31 + (i >> 4)) as u8).collect();
    let mut modified = original.clone();
    modified[7] ^= 0x5a;
    let mut frame = vec![0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82];
    frame.extend_from_slice(&(0x8000_0000 | original.len() as u32).to_le_bytes());
    frame.extend_from_slice(&original);
    frame.extend_from_slice(&[0; 4]);
    let source = temp.child("original.bin.lz4");
    fs::write(source.path(), frame).unwrap();
    let output = temp.child("ingested");
    let terminal = parse_single_json_line(&run(&[
        "ingest",
        "--input",
        source.path().to_str().unwrap(),
        "--output",
        output.path().to_str().unwrap(),
        "--json",
    ]));
    let assets = terminal["details"]["ingest"]["assets"].as_array().unwrap();
    assert_eq!(assets.len(), 1, "LZ4 ingest must produce one ROM payload");
    assert_eq!(assets[0]["file_name"], "original.bin");
    let extracted = assets[0]["path"].as_str().unwrap();
    assert_eq!(fs::read(extracted).unwrap(), original);
    let modified_path = temp.child("modified.bin");
    fs::write(modified_path.path(), &modified).unwrap();
    let patch = temp.child("change.bps");
    run(&[
        "patch",
        "create",
        "--original",
        extracted,
        "--modified",
        modified_path.path().to_str().unwrap(),
        "--format",
        "bps",
        "--output",
        patch.path().to_str().unwrap(),
    ]);
    let applied = temp.child("applied.bin");
    run(&[
        "patch",
        "apply",
        "--input",
        extracted,
        "--patch",
        patch.path().to_str().unwrap(),
        "--output",
        applied.path().to_str().unwrap(),
        "--no-compress",
    ]);
    assert_eq!(fs::read(applied.path()).unwrap(), modified);
}

/// Ingest a two-track CD CHD against a per-track (Redump-shaped) pack: every
/// track resolves to the disc's title, through its own single-blob lookup or
/// the disc-group fingerprint built from the streamed track checksums. A first
/// ingest without a database supplies the split tracks' checksums for the pack.
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
    let pack_bytes = super::identify_database::pack_v1(
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
        // The discriminating data track now also matches through its own
        // single-blob lookup ("raw"); the non-discriminating track can only be
        // resolved by the disc-group fingerprint ("disc-tracks").
        let variant = identification["matches"][0]["variant"]
            .as_str()
            .expect("variant");
        assert!(
            variant == "disc-tracks" || variant == "raw",
            "unexpected variant {variant}"
        );
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
    let pack_bytes = super::identify_database::pack_v1(
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
    let pack_bytes = super::identify_database::pack_v1(
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
        super::identify::identify_pack_with_crc_size(
            crc32,
            b"ingest identify fixture".len() as u64,
            "Ingest Identify Test [!]",
        ),
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
fn nested_rom_archive(
    temp: &TempDir,
    payloads: &[(&str, &[u8])],
) -> (PathBuf, Vec<([u8; 4], u64)>) {
    let mut sources = Vec::new();
    let mut fingerprints = Vec::new();
    for (member_path, payload) in payloads {
        let file_name = member_path.rsplit('/').next().expect("member file name");
        let rom = temp.child(file_name);
        fs::write(rom.path(), with_nes_header(payload)).expect("ROM fixture");
        fingerprints.push((
            u32::from_str_radix(&checksum_value(rom.path(), "crc32"), 16)
                .expect("CRC32")
                .to_be_bytes(),
            fs::metadata(rom.path()).expect("ROM metadata").len(),
        ));
        sources.push((rom.path().to_path_buf(), (*member_path).to_string()));
    }
    let archive = temp.child("collection.tar.gz");
    let entries = sources
        .iter()
        .map(|(path, name)| (path.as_path(), name.as_str()))
        .collect::<Vec<_>>();
    write_tar_gz_fixture(&entries, archive.path());
    (archive.path().to_path_buf(), fingerprints)
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
    let (archive, fingerprints) =
        nested_rom_archive(&temp, &[("Games/GBA/solo.nes", b"solo payload")]);
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_sized_entries(&[(
            fingerprints[0].0,
            fingerprints[0].1,
            "Solo Game (USA)",
        )]),
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
    let (archive, fingerprints) = nested_rom_archive(
        &temp,
        &[
            ("Games/NES/first.nes", b"first payload"),
            ("Games/NES/deeper/second.nes", b"second payload"),
        ],
    );
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_sized_entries(&[
            (fingerprints[0].0, fingerprints[0].1, "First Game (USA)"),
            (fingerprints[1].0, fingerprints[1].1, "Second Game (Europe)"),
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
    let (archive, fingerprints) = nested_rom_archive(
        &temp,
        &[
            ("Games/NES/known.nes", b"known payload"),
            ("Games/NES/unknown.nes", b"unknown payload"),
        ],
    );
    let pack = temp.child("test.pack");
    fs::write(
        pack.path(),
        super::identify::identify_pack_with_sized_entries(&[(
            fingerprints[0].0,
            fingerprints[0].1,
            "Known Game (USA)",
        )]),
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
    let archive = temp.child("weave.zip");
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
            "--jsonl",
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
fn ingest_reports_small_rom_checksums_as_single_threaded() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"small rom payload")).expect("rom fixture");
    let out_dir = temp.child("ingest-out");

    let events = run_json_events(
        &[
            "ingest",
            "--input",
            rom.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--threads",
            "4",
            "--jsonl",
        ],
        0,
    );

    let checksum_events = events
        .iter()
        .filter(|event| event["stage"] == "checksum" && event["status"] == "running")
        .collect::<Vec<_>>();
    assert!(
        !checksum_events.is_empty(),
        "expected checksum progress events"
    );
    for event in checksum_events {
        assert_eq!(event["effective_threads"], 1, "event: {event}");
        assert_eq!(event["used_parallelism"], false, "event: {event}");
    }
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
    // route the whole weave as a patch source instead of erroring with "no entries matched --filter rom".
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
        "a nested patch weave surfaces no ROM assets"
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
    // Same nested-patch-only weave as above, but ingested WITH a ROM keep-one `--select` glob.
    // The fallback patch enumeration must ignore that glob (it enumerates with `&[]`): a ROM select
    // that filters the descent must NOT also filter the weave's patch leaves, or a select-present
    // drop of a nested patch weave regresses to "no ROM". Reverting the fallback to `raw_selections`
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
        "a nested patch weave surfaces no ROM assets"
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
fn ingest_patch_reads_filename_requirements_from_input_name() {
    let temp = setup_temp_dir();
    // The browser stages files under sanitized names, so `:` arrives as `_`.
    let patch = temp.child("hack [crc32_1a2b3c4d].ips");
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
    let out_dir = temp.child("ingest-input-name-out");

    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        patch.path().to_str().expect("path"),
        "--input-name",
        "hack [crc32:1a2b3c4d] [md5:00112233445566778899aabbccddeeff].ips",
        "--output",
        out_dir.path().to_str().expect("path"),
        "--json",
    ]);
    let descriptor = &terminal["details"]["ingest"]["patches"][0];
    assert_eq!(descriptor["filename_checksums"]["crc32"], "1a2b3c4d");
    assert_eq!(
        descriptor["filename_checksums"]["md5"],
        "00112233445566778899aabbccddeeff"
    );
    assert_eq!(
        descriptor["file_name"], "hack [crc32_1a2b3c4d].ips",
        "the descriptor keeps naming the staged leaf"
    );
}

// `:` is not a legal Windows file name character, so this layout only exists on Unix hosts.
#[cfg(not(windows))]
#[test]
fn ingest_patch_reads_md5_and_size_tokens_from_the_input_file_name() {
    // The browser mounts INPUT under its original name (`:` kept), so these tokens are read from the
    // path like every other command.
    let temp = setup_temp_dir();
    let patch = temp.child("hack [md5:0123456789abcdef0123456789abcdef] [size:524288].ips");
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
    let out_dir = temp.child("ingest-filename-token-out");

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
        descriptor["filename_checksums"]["md5"],
        "0123456789abcdef0123456789abcdef"
    );
    assert_eq!(descriptor["filename_size"], 524_288);
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
    // A weave carrying a ROM routes to the ROM bucket, but still surfaces the bundled patch.
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
    // A keep-one ROM `--select` pins which ROM is extracted, but it must NOT suppress the weave's
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
    // The host MUST receive all sidecar descriptors before the terminal report.
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
            "--jsonl",
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
    let report: Value =
        serde_json::from_slice(&assert.get_output().stdout).expect("JSON argument error");
    assert_eq!(report["exit_code"], 2);
    let message = report["error"]["message"].as_str().expect("error message");
    assert!(
        message.contains("invalid value 'not-a-real-algo'"),
        "{message}"
    );
    assert!(message.contains("crc32"), "{message}");
    assert!(assert.get_output().stderr.is_empty());
}

/// A cooked image of `sectors` 2048-byte sectors with a UDF `NSR02` descriptor at LBA 19.
fn udf_cooked_image(sectors: usize) -> Vec<u8> {
    let mut bytes = vec![0_u8; sectors * 2048];
    bytes[16 * 2048 + 1..16 * 2048 + 6].copy_from_slice(b"CD001");
    bytes[19 * 2048 + 1..19 * 2048 + 6].copy_from_slice(b"NSR02");
    bytes
}

#[test]
fn ingest_reports_the_chd_create_mode_for_loose_images() {
    // Hosts read the native `chd` auto-inference verdict instead of re-deriving it from bytes.
    let temp = setup_temp_dir();
    let cases: [(&str, Vec<u8>, &str); 3] = [
        ("udf.iso", udf_cooked_image(40), "dvd"),
        (
            "plain.bin",
            {
                let mut bytes = udf_cooked_image(40);
                bytes[19 * 2048 + 1..19 * 2048 + 6].fill(0);
                bytes
            },
            "cd",
        ),
        ("blob.bin", vec![7_u8; 4096], "raw"),
    ];
    for (name, bytes, expected) in cases {
        let rom = temp.child(name);
        fs::write(rom.path(), bytes).expect("image fixture");
        let out_dir = temp.child(format!("ingest-chd-mode-{name}"));
        let terminal = ingest_terminal(&[
            "ingest",
            "--input",
            rom.path().to_str().expect("path"),
            "--output",
            out_dir.path().to_str().expect("path"),
            "--json",
        ]);
        assert_eq!(terminal["status"], "succeeded", "{name}");
        let asset = &terminal["details"]["ingest"]["assets"][0];
        assert_eq!(asset["chd_create_mode"], expected, "{name}");
    }
    // Other extensions carry no verdict.
    let nes = temp.child("game.nes");
    fs::write(nes.path(), vec![0_u8; 4096]).expect("nes fixture");
    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        nes.path().to_str().expect("path"),
        "--output",
        temp.child("ingest-chd-mode-nes")
            .path()
            .to_str()
            .expect("path"),
        "--json",
    ]);
    assert!(
        terminal["details"]["ingest"]["assets"][0]
            .get("chd_create_mode")
            .is_none()
    );
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
            "--jsonl",
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
            "--jsonl",
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

#[test]
fn ingest_missing_input_uses_the_shared_wording() {
    let temp = setup_temp_dir();
    let missing = temp.child("missing.bin");
    let json = run_single_json_event(
        &[
            "ingest",
            "-i",
            missing.path().to_str().expect("path"),
            "-o",
            temp.child("out").path().to_str().expect("path"),
            "--json",
        ],
        1,
    );
    let label = json["label"].as_str().expect("label");
    assert!(label.starts_with("input path does not exist: `"), "{label}");
}

/// PSP homebrew `EBOOT.PBP` files have an empty DATA.PSAR (its offset equals the file size): the
/// PBP is itself the ROM, so ingest keeps it in place as a PSP ROM instead of rejecting it.
#[test]
fn ingest_treats_a_pbp_with_an_empty_psar_as_a_bare_psp_rom() {
    let temp = setup_temp_dir();
    let pbp = build_test_empty_psar_pbp();
    let source = temp.child("EBOOT.PBP");
    fs::write(source.path(), &pbp).expect("pbp fixture");
    let out_dir = temp.child("ingest-out");

    let ingest = ingest_terminal(&[
        "ingest",
        "--input",
        source.path().to_str().expect("pbp path"),
        "--output",
        out_dir.path().to_str().expect("output path"),
        "--json",
    ]);

    let assets = ingest["details"]["ingest"]["assets"]
        .as_array()
        .expect("assets");
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0]["file_name"], "EBOOT.PBP");
    assert_eq!(assets[0]["platform"], "Sony Playstation Portable");
    assert_eq!(assets[0]["copied_in_place"], true);
}

#[test]
fn ingest_nested_empty_psar_pbp_is_a_rom_leaf() {
    let temp = setup_temp_dir();
    let pbp = build_test_empty_psar_pbp();
    let source = temp.child("EBOOT.PBP");
    fs::write(source.path(), &pbp).expect("pbp fixture");
    let checksum = isolated_json_event(
        &temp,
        &[
            "checksum",
            "--input",
            source.path().to_str().expect("path"),
            "--algo",
            "sha1",
            "--no-extract",
            "--json",
        ],
        0,
    );
    let inner = temp.child("homebrew.zip");
    isolated_json_event(
        &temp,
        &[
            "compress",
            "--input",
            source.path().to_str().expect("path"),
            "--format",
            "zip",
            "--output",
            inner.path().to_str().expect("path"),
            "--json",
        ],
        0,
    );
    let outer = temp.child("outer.tar.gz");
    write_tar_gz_fixture(&[(inner.path(), "homebrew.zip")], outer.path());
    for (depth, archive) in [inner.path(), outer.path()].into_iter().enumerate() {
        let output = temp.child(format!("ingest-{depth}"));
        let terminal = isolated_json_event(
            &temp,
            &[
                "ingest",
                "--input",
                archive.to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--json",
            ],
            0,
        );
        let ingest = &terminal["details"]["ingest"];
        assert_eq!(ingest["kind"], "rom");
        let assets = ingest["assets"].as_array().expect("assets");
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0]["file_name"], "EBOOT.PBP");
        assert_eq!(assets[0]["platform"], "Sony Playstation Portable");
        assert_eq!(assets[0]["copied_in_place"], false);
        assert_eq!(
            assets[0]["checksums"]["sha1"],
            checksum["details"]["checksums"]["sha1"]
        );
        let extracted = assets[0]["path"].as_str().expect("asset path");
        assert_eq!(fs::read(extracted).expect("extracted PBP"), pbp);
    }
}

/// Zip `members` (flat entry names taken from each path's file name) into `archive`.
fn zip_members(temp: &TempDir, archive: &Path, members: &[&Path]) {
    let mut args = vec!["compress", "--format", "zip"];
    for member in members {
        args.push("--input");
        args.push(member.to_str().expect("member path"));
    }
    args.extend([
        "--output",
        archive.to_str().expect("archive path"),
        "--json",
    ]);
    isolated_json_event(temp, &args, 0);
}

/// A real-shaped DCP: a modified file stored as `PATH.xdelta`, a `.DAT` data file, and the bootstrap.
fn write_dcp(temp: &TempDir, name: &str) -> PathBuf {
    let dir = temp.child(format!("{name}-members"));
    fs::create_dir_all(dir.path()).expect("dcp member dir");
    let members: Vec<PathBuf> = [
        ("IP.BIN", vec![1u8; 2048]),
        ("1ST_READ.BIN.xdelta", vec![2u8; 64]),
        ("SOUND.DAT", vec![3u8; 1024]),
    ]
    .into_iter()
    .map(|(entry, bytes)| {
        let path = dir.path().join(entry);
        fs::write(&path, bytes).expect("dcp member");
        path
    })
    .collect();
    let dcp = temp.child(name);
    let member_refs: Vec<&Path> = members.iter().map(PathBuf::as_path).collect();
    zip_members(temp, dcp.path(), &member_refs);
    dcp.path().to_path_buf()
}

fn ingest_json(temp: &TempDir, source: &Path, output: &str) -> Value {
    let output = temp.child(output);
    isolated_json_event(
        temp,
        &[
            "ingest",
            "--input",
            source.to_str().expect("source path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--json",
        ],
        0,
    )
}

fn patch_file_names(ingest: &Value) -> Vec<(String, String)> {
    ingest["patches"]
        .as_array()
        .expect("patches")
        .iter()
        .map(|patch| {
            (
                patch["file_name"].as_str().expect("file_name").to_string(),
                patch["format"].as_str().expect("format").to_string(),
            )
        })
        .collect()
}

/// A `.dcp` stores modified files as `PATH.xdelta` (and `.DAT` data), both patch-filter extensions.
/// Ingest must report the `.dcp` as one patch leaf, never descend and surface its inner entries.
#[test]
fn ingest_reports_a_zipped_dcp_as_one_patch_leaf() {
    let temp = setup_temp_dir();
    let dcp = write_dcp(&temp, "game.dcp");
    let bare = ingest_json(&temp, &dcp, "bare-out");
    assert_eq!(
        patch_file_names(&bare["details"]["ingest"]),
        [("game.dcp".to_string(), "dcp".to_string())]
    );
    let zipped = temp.child("translation.zip");
    zip_members(&temp, zipped.path(), &[dcp.as_path()]);
    let terminal = ingest_json(&temp, zipped.path(), "zipped-out");
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch");
    assert_eq!(
        patch_file_names(ingest),
        [("game.dcp".to_string(), "dcp".to_string())]
    );
}

/// A ROM bundle zip holding a disc plus a `.dcp` ingests its ROM and reports the `.dcp` as a patch
/// instead of failing the whole ingest while descending into the `.dcp`.
#[test]
fn ingest_rom_bundle_with_a_dcp_reports_the_rom_and_the_dcp_patch() {
    let temp = setup_temp_dir();
    let dcp = write_dcp(&temp, "game.dcp");
    let iso = temp.child("game.iso");
    fs::write(iso.path(), vec![7u8; 4096]).expect("iso fixture");
    let bundle = temp.child("bundle.zip");
    zip_members(&temp, bundle.path(), &[iso.path(), dcp.as_path()]);
    let terminal = ingest_json(&temp, bundle.path(), "bundle-out");
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "rom");
    let assets = ingest["assets"].as_array().expect("assets");
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0]["file_name"], "game.iso");
    assert_eq!(
        patch_file_names(ingest),
        [("game.dcp".to_string(), "dcp".to_string())]
    );
}

/// Build a tiny GameCube-shaped NFS head (`hif_000000.nfs`) encrypted with `key`, as the real
/// format lays it out: a 0x200-byte `EGGS` header then AES-128-CBC sectors keyed by sector number.
fn synthetic_nfs_head(key: [u8; 16]) -> Vec<u8> {
    use aes::cipher::{BlockModeEncrypt, KeyIvInit, block_padding::NoPadding};
    const SECTOR: usize = 0x8000;
    const SECTORS: usize = 4;
    let mut plain = (0..SECTOR * SECTORS)
        .map(|index| ((index * 7 + 19) & 0xff) as u8)
        .collect::<Vec<_>>();
    plain[..0x440].fill(0);
    plain[..6].copy_from_slice(b"GAUE01");
    plain[0x1c..0x20].copy_from_slice(&[0xc2, 0x33, 0x9f, 0x3d]);
    let mut nfs = vec![0u8; 0x200];
    nfs[..4].copy_from_slice(b"EGGS");
    nfs[4..8].copy_from_slice(&1u32.to_be_bytes());
    nfs[16..20].copy_from_slice(&1u32.to_be_bytes());
    nfs[24..28].copy_from_slice(&(SECTORS as u32).to_be_bytes());
    nfs[0x1fc..0x200].copy_from_slice(b"SGGE");
    for (sector, chunk) in plain.chunks_mut(SECTOR).enumerate() {
        let mut iv = [0u8; 16];
        iv[12..].copy_from_slice(&(sector as u32).to_be_bytes());
        let length = chunk.len();
        <cbc::Encryptor<aes::Aes128>>::new(&key.into(), &iv.into())
            .encrypt_padded::<NoPadding>(chunk, length)
            .expect("encrypt NFS sector");
    }
    nfs.extend_from_slice(&plain);
    nfs
}

/// Ingest `entries` as one archive and return the asset file names plus the raw terminal event.
fn ingest_nfs_archive(
    temp: &TempDir,
    entries: &[(&Path, &str)],
    expected_code: i32,
) -> (Vec<String>, Value) {
    let archive = temp.child("dump.tar.gz");
    write_tar_gz_fixture(entries, archive.path());
    let output = temp.child("ingest-out");
    let terminal = run_single_json_event(
        &[
            "ingest",
            "--input",
            archive.path().to_str().expect("archive path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--json",
        ],
        expected_code,
    );
    let names = terminal["details"]["ingest"]["assets"]
        .as_array()
        .map(|assets| {
            assets
                .iter()
                .filter_map(|asset| asset["path"].as_str())
                .map(|path| path.rsplit('/').next().unwrap_or(path).to_string())
                .collect()
        })
        .unwrap_or_default();
    (names, terminal)
}

/// The supplied `code/htk.bin` decodes the NFS dump and is consumed with it, never emitted as a
/// second ROM output.
#[test]
fn ingest_consumes_the_htk_key_of_an_nfs_archive() {
    let temp = setup_temp_dir();
    let key = [0x11u8; 16];
    let head = temp.child("hif_000000.nfs");
    fs::write(head.path(), synthetic_nfs_head(key)).expect("NFS fixture");
    let key_file = temp.child("htk.bin");
    fs::write(key_file.path(), key).expect("key fixture");

    let (names, terminal) = ingest_nfs_archive(
        &temp,
        &[
            (head.path(), "content/hif_000000.nfs"),
            (key_file.path(), "code/htk.bin"),
        ],
        0,
    );

    assert_eq!(terminal["status"], "succeeded", "{terminal}");
    assert_eq!(names.len(), 1, "exactly the decoded disc: {names:?}");
    assert!(!names.iter().any(|name| name == "htk.bin"), "{names:?}");
    assert!(
        !names.iter().any(|name| name.ends_with(".nfs")),
        "{names:?}"
    );
}

/// A keyless NFS is the only payload Apply needs, so ingest fails with the key error; the same dump
/// next to another ROM keeps ingesting that ROM.
#[test]
fn ingest_reports_a_keyless_nfs_but_keeps_other_archive_roms() {
    let temp = setup_temp_dir();
    let head = temp.child("hif_000000.nfs");
    fs::write(head.path(), synthetic_nfs_head([0x11u8; 16])).expect("NFS fixture");

    let (_, failed) = ingest_nfs_archive(&temp, &[(head.path(), "content/hif_000000.nfs")], 1);
    let message = failed.to_string();
    assert!(message.contains("Failed to locate"), "{message}");

    let other = temp.child("other.nes");
    fs::write(other.path(), with_nes_header(b"other rom")).expect("ROM fixture");
    let (names, terminal) = ingest_nfs_archive(
        &temp,
        &[
            (head.path(), "content/hif_000000.nfs"),
            (other.path(), "other.nes"),
        ],
        0,
    );
    assert_eq!(terminal["status"], "succeeded", "{terminal}");
    assert!(names.iter().any(|name| name == "other.nes"), "{names:?}");
}

/// `extract` only unpacks: a keyless NFS archive still succeeds and emits the raw parts.
#[test]
fn extract_keeps_raw_files_of_a_keyless_nfs_archive() {
    let temp = setup_temp_dir();
    let head = temp.child("hif_000000.nfs");
    fs::write(head.path(), synthetic_nfs_head([0x11u8; 16])).expect("NFS fixture");
    let archive = temp.child("dump.tar.gz");
    write_tar_gz_fixture(&[(head.path(), "content/hif_000000.nfs")], archive.path());
    let output = temp.child("extract-out");

    command_stdout(
        &[
            "extract",
            "--input",
            archive.path().to_str().expect("archive path"),
            "--output",
            output.path().to_str().expect("output path"),
            "--json",
        ],
        0,
    );

    assert!(output.path().join("content/hif_000000.nfs").is_file());
}

/// Stream wrappers whose payload name is the wrapper name minus its suffix, so `rom.gz` holds `rom`.
const STREAM_CODECS: [&str; 5] = ["gz", "xz", "bz2", "zst", "lz4"];

/// A 1 KiB banded dump with no recognisable header (an extension-less raw ROM).
fn banded_rom() -> Vec<u8> {
    (0..1024u32).map(|i| ((i / 16) * 37 + 5) as u8).collect()
}

/// `banded_rom` with byte 100 flipped: the BPS below patches `banded_rom` into this.
fn banded_rom_patched() -> Vec<u8> {
    let mut bytes = banded_rom();
    bytes[100] ^= 0x5a;
    bytes
}

const BANDED_BPS_HEX: &str = "4250533100870087800c8281b9689bdc1420ebbd6966b0fe580177";
/// `bz2` of `banded_rom` / `BANDED_BPS_HEX` (no bzip2 encoder is linked into the test build).
const BANDED_ROM_BZ2_HEX: &str = "425a6839314159265359e7eb25ee0000007fff824d2492401249249000924924800492492400249249200124924900092492483000d581dfe950340d3268d1918462683106f4a1a609ea1993400099310601304c0011a3025fff95553002626040c00269a64c7ffaaa82607ea8208023802201df3ee9fbfebb6fc228a0926a74556eabb0cf6efe3cb4db8ebcfc10fa8a39259bac92cddbbf8f339a3d7bf947da6aaecb7f26709304608c11823049048048050c30c30c30c30c30c30c30c30c30c30c30c30c30c30c30c30c30c30c30c30c30e070381c0e070381c0e07e05dc914e142439fac97b80";
const BANDED_BPS_BZ2_HEX: &str = "425a683931415926535946c4c088000003ffebe00404004000200010004840016000807080000840220004000800012000314000d03264140000d1932402baf4efbbe103c7ac100284490cd3e2ee48a70a1208d8981100";

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).expect("hex byte"))
        .collect()
}

fn banded_bps() -> Vec<u8> {
    hex_bytes(BANDED_BPS_HEX)
}

/// Wrap `payload` (`banded_rom` or `banded_bps`) in `codec` without storing any payload name.
fn wrap_stream(codec: &str, payload: &[u8]) -> Vec<u8> {
    match codec {
        "gz" => {
            let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::new(6));
            encoder.write_all(payload).expect("gzip payload");
            encoder.finish().expect("gzip finish")
        }
        "xz" => rom_weaver_core::codecs::encode_xz_preset(payload, 6).expect("xz payload"),
        "zst" => zstd::stream::encode_all(payload, 0).expect("zstd payload"),
        "lz4" => {
            let mut encoder = lz4_flex::frame::FrameEncoder::new(Vec::new());
            encoder.write_all(payload).expect("lz4 payload");
            encoder.finish().expect("lz4 finish")
        }
        "bz2" if payload == banded_rom().as_slice() => hex_bytes(BANDED_ROM_BZ2_HEX),
        "bz2" if payload == banded_bps().as_slice() => hex_bytes(BANDED_BPS_BZ2_HEX),
        other => panic!("no fixture encoder for `{other}`"),
    }
}

fn write_wrapped(temp: &TempDir, name: &str, codec: &str, payload: &[u8]) -> PathBuf {
    let path = temp.child(name);
    fs::write(path.path(), wrap_stream(codec, payload)).expect("wrapped fixture");
    path.path().to_path_buf()
}

/// B1: a single-file compressed ROM whose payload name has no extension (`rom.gz` -> `rom`) is a
/// ROM candidate, not "no ROM found".
#[test]
fn ingest_extensionless_compressed_rom_is_a_rom_candidate() {
    for codec in STREAM_CODECS {
        let temp = setup_temp_dir();
        let source = write_wrapped(&temp, &format!("rom.{codec}"), codec, &banded_rom());
        let output = temp.child("ingested");
        let terminal = ingest_terminal(&[
            "ingest",
            "--input",
            source.to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ]);
        assert_eq!(terminal["status"], "succeeded", "{codec}: {terminal}");
        let ingest = &terminal["details"]["ingest"];
        assert_eq!(ingest["kind"], "rom", "{codec}");
        assert_eq!(ingest["is_rom"], true, "{codec}");
        let assets = ingest["assets"].as_array().expect("assets");
        assert_eq!(assets.len(), 1, "{codec}: {ingest}");
        assert_eq!(assets[0]["file_name"], "rom", "{codec}");
        let extracted = assets[0]["path"].as_str().expect("asset path");
        assert_eq!(
            fs::read(extracted).expect("payload"),
            banded_rom(),
            "{codec}"
        );
        assert!(ingest["patches"].as_array().expect("patches").is_empty());
    }
}

/// B2: an extension-less compressed patch (`patch.gz` -> `patch`) is recognised by its magic bytes.
#[test]
fn ingest_extensionless_compressed_patch_is_classified_by_signature() {
    for codec in STREAM_CODECS {
        let temp = setup_temp_dir();
        let source = write_wrapped(&temp, &format!("patch.{codec}"), codec, &banded_bps());
        let output = temp.child("ingested");
        let terminal = ingest_terminal(&[
            "ingest",
            "--input",
            source.to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--json",
        ]);
        assert_eq!(terminal["status"], "succeeded", "{codec}: {terminal}");
        let ingest = &terminal["details"]["ingest"];
        assert_eq!(ingest["kind"], "patch", "{codec}: {ingest}");
        assert_eq!(ingest["is_rom"], false, "{codec}");
        assert!(ingest["assets"].as_array().expect("assets").is_empty());
        let patches = ingest["patches"].as_array().expect("patches");
        assert_eq!(patches.len(), 1, "{codec}: {ingest}");
        assert_eq!(patches[0]["format"], "BPS", "{codec}");
    }
}

/// A nested archive holding a named patch beside an extension-less compressed patch reports both.
#[test]
fn ingest_nested_named_and_extensionless_patches_are_both_reported() {
    let temp = setup_temp_dir();
    let members = temp.child("members");
    fs::create_dir_all(members.path()).expect("members dir");
    let named = members.path().join("hack.bps");
    fs::write(&named, banded_bps()).expect("named patch");
    let wrapped = write_wrapped(&temp, "members/hack.gz", "gz", &banded_bps());
    let inner = temp.child("inner.zip");
    zip_members(&temp, inner.path(), &[named.as_path(), wrapped.as_path()]);
    let outer = temp.child("outer.zip");
    zip_members(&temp, outer.path(), &[inner.path()]);
    let terminal = ingest_json(&temp, outer.path(), "nested-out");
    assert_eq!(terminal["status"], "succeeded", "{terminal}");
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch", "{ingest}");
    let mut names: Vec<String> = patch_file_names(ingest)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    names.sort();
    assert_eq!(names, ["hack", "hack.bps"], "{ingest}");
}

/// Two named patches beside an extension-less compressed patch reach the host in ONE
/// `patch-manifest` event: the webapp opens its dialog on the first manifest and ignores later ones.
#[test]
fn ingest_nested_named_and_extensionless_patches_share_one_manifest() {
    let temp = setup_temp_dir();
    let members = temp.child("members");
    fs::create_dir_all(members.path()).expect("members dir");
    let first = members.path().join("a.bps");
    let second = members.path().join("b.bps");
    fs::write(&first, banded_bps()).expect("first patch");
    fs::write(&second, banded_bps()).expect("second patch");
    let wrapped = write_wrapped(&temp, "members/hack.gz", "gz", &banded_bps());
    let inner = temp.child("inner.zip");
    zip_members(
        &temp,
        inner.path(),
        &[first.as_path(), second.as_path(), wrapped.as_path()],
    );
    let outer = temp.child("outer.zip");
    zip_members(&temp, outer.path(), &[inner.path()]);
    let output = temp.child("nested-out");
    let events = run_json_events(
        &[
            "ingest",
            "--input",
            outer.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--jsonl",
        ],
        0,
    );
    let manifests: Vec<Vec<String>> = events
        .iter()
        .filter(|event| event["stage"] == "patch-manifest")
        .map(|event| {
            let mut names: Vec<String> = event["details"]["patch_manifest"]["patches"]
                .as_array()
                .expect("manifest patches")
                .iter()
                .map(|patch| patch["file_name"].as_str().expect("file_name").to_string())
                .collect();
            names.sort();
            names
        })
        .collect();
    assert_eq!(manifests, [["a.bps", "b.bps", "hack"]], "{events:?}");
}

/// An extension-less compressed dump ingested with `--output` set to its own directory would
/// extract onto the source path; ingest must refuse and leave the source untouched, for payloads
/// below and above the 8 MiB mark.
#[test]
fn ingest_refuses_to_extract_an_extensionless_dump_over_its_own_source() {
    for payload_len in [4 * 1024, 9 * 1024 * 1024] {
        let temp = setup_temp_dir();
        let mut state = 0x9E37_79B9_u32;
        let payload: Vec<u8> = (0..payload_len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state >> 8) as u8
            })
            .collect();
        let source = write_wrapped(&temp, "dump", "gz", &payload);
        let before = fs::read(&source).expect("source bytes");
        let dir = source.parent().expect("source dir");
        let terminal = isolated_json_event(
            &temp,
            &[
                "ingest",
                "--input",
                source.to_str().expect("path"),
                "--output",
                dir.to_str().expect("path"),
                "--json",
            ],
            1,
        );
        assert_eq!(terminal["status"], "failed", "{payload_len}: {terminal}");
        let message = terminal.to_string();
        assert!(
            message.contains("refusing to write the extracted payload over its own source file"),
            "{payload_len}: {message}"
        );
        assert_eq!(
            fs::read(&source).expect("source after"),
            before,
            "{payload_len}: the source file must be left untouched"
        );
    }
}

/// An extension-less raw dump with no patch magic stays a ROM candidate, bare or compressed - even
/// when it starts with the two bytes of the weakest patch magic (`SP`, SOLID), which is excluded.
#[test]
fn ingest_extensionless_raw_dump_without_patch_signature_stays_a_rom() {
    for prefix in [&b"\x00\x01"[..], &b"SP"[..]] {
        let mut dump = banded_rom();
        dump[..prefix.len()].copy_from_slice(prefix);
        let temp = setup_temp_dir();
        let bare = temp.child("dump");
        fs::write(bare.path(), &dump).expect("bare dump");
        let wrapped = temp.child("dump.gz");
        let mut encoder = GzEncoder::new(Vec::new(), DeflateCompression::new(6));
        encoder.write_all(&dump).expect("gzip payload");
        fs::write(wrapped.path(), encoder.finish().expect("gzip finish")).expect("wrapped dump");
        for source in [bare.path(), wrapped.path()] {
            let output = temp.child(format!(
                "ingested-{}",
                source
                    .file_name()
                    .and_then(|name| name.to_str())
                    .expect("name")
            ));
            let terminal = ingest_terminal(&[
                "ingest",
                "--input",
                source.to_str().expect("path"),
                "--output",
                output.path().to_str().expect("path"),
                "--json",
            ]);
            let ingest = &terminal["details"]["ingest"];
            assert_eq!(ingest["kind"], "rom", "{}: {ingest}", source.display());
            assert_eq!(ingest["assets"].as_array().expect("assets").len(), 1);
            assert!(ingest["patches"].as_array().expect("patches").is_empty());
        }
    }
}

/// A bare extension-less file carrying patch magic is a patch, not a ROM.
#[test]
fn ingest_bare_extensionless_patch_is_classified_by_signature() {
    let temp = setup_temp_dir();
    let bare = temp.child("patch");
    fs::write(bare.path(), banded_bps()).expect("bare patch");
    let output = temp.child("ingested");
    let terminal = ingest_terminal(&[
        "ingest",
        "--input",
        bare.path().to_str().expect("path"),
        "--output",
        output.path().to_str().expect("path"),
        "--json",
    ]);
    let ingest = &terminal["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch", "{ingest}");
    assert_eq!(ingest["patches"][0]["format"], "BPS", "{ingest}");
}

/// `patch apply` with a compressed extension-less ROM and a compressed extension-less patch.
#[test]
fn patch_apply_accepts_extensionless_compressed_rom_and_patch() {
    for codec in STREAM_CODECS {
        let temp = setup_temp_dir();
        let rom = write_wrapped(&temp, &format!("rom.{codec}"), codec, &banded_rom());
        let patch = write_wrapped(&temp, &format!("patch.{codec}"), codec, &banded_bps());
        let applied = temp.child("applied.bin");
        let terminal = run_single_json_event(
            &[
                "patch",
                "apply",
                "--input",
                rom.to_str().expect("path"),
                "--patch",
                patch.to_str().expect("path"),
                "--output",
                applied.path().to_str().expect("path"),
                "--no-compress",
                "--jsonl",
            ],
            0,
        );
        assert_eq!(terminal["status"], "succeeded", "{codec}: {terminal}");
        assert_eq!(
            fs::read(applied.path()).expect("applied output"),
            banded_rom_patched(),
            "{codec}"
        );
    }
}

fn assert_ingest_unnamed_archive_leaves(format: &str) {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    let raw = temp.child("dump");
    let patch = temp.child("patch");
    fs::write(rom.path(), banded_rom()).unwrap();
    let mut raw_bytes = banded_rom();
    raw_bytes[..2].copy_from_slice(b"SP");
    fs::write(raw.path(), &raw_bytes).unwrap();
    fs::write(patch.path(), banded_bps()).unwrap();
    let archive = temp.child(format!("bundle.{format}"));
    if format == "tar" {
        let mut builder = tar::Builder::new(File::create(archive.path()).unwrap());
        for path in [rom.path(), raw.path(), patch.path()] {
            builder
                .append_path_with_name(path, path.file_name().unwrap())
                .unwrap();
        }
        builder.finish().unwrap();
    } else {
        isolated_json_event(
            &temp,
            &[
                "compress",
                "--format",
                format,
                "--input",
                rom.path().to_str().unwrap(),
                "--input",
                raw.path().to_str().unwrap(),
                "--input",
                patch.path().to_str().unwrap(),
                "--output",
                archive.path().to_str().unwrap(),
                "--json",
            ],
            0,
        );
    }
    let result = ingest_json(&temp, archive.path(), "out");
    let ingest = &result["details"]["ingest"];
    let assets = ingest["assets"].as_array().unwrap();
    assert_eq!(assets.len(), 2, "{format}: {ingest}");
    assert!(assets.iter().any(|asset| asset["file_name"] == "dump"));
    let patches = ingest["patches"].as_array().unwrap();
    assert_eq!(patches.len(), 1, "{format}: {ingest}");
    assert_eq!(patches[0]["file_name"], "patch");
    assert_eq!(patches[0]["format"], "BPS");
    assert_eq!(
        fs::read(patches[0]["leaf_path"].as_str().unwrap()).unwrap(),
        banded_bps()
    );
}

#[test]
fn ingest_classification_extensionless_zip_patch_and_raw_dump() {
    assert_ingest_unnamed_archive_leaves("zip");
}

#[test]
fn ingest_classification_extensionless_tar_patch_and_raw_dump() {
    assert_ingest_unnamed_archive_leaves("tar");
}

#[test]
fn ingest_classification_extensionless_7z_patch_and_raw_dump() {
    assert_ingest_unnamed_archive_leaves("7z");
}

#[test]
fn ingest_classification_patch_only_zip_keeps_extensionless_compressed_patch() {
    let temp = setup_temp_dir();
    let named = temp.child("a.bps");
    fs::write(named.path(), banded_bps()).unwrap();
    let wrapped = write_wrapped(&temp, "b.gz", "gz", &banded_bps());
    let archive = temp.child("patches.zip");
    zip_members(&temp, archive.path(), &[named.path(), &wrapped]);
    let result = ingest_json(&temp, archive.path(), "out");
    let ingest = &result["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch");
    let mut names: Vec<_> = patch_file_names(ingest)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    names.sort();
    assert_eq!(names, ["a.bps", "b"], "{ingest}");
}

#[test]
fn ingest_classification_dotted_gzip_payload_names() {
    for (name, bytes, kind) in [
        ("Dr. Mario (Japan, USA)", banded_rom(), "rom"),
        ("Hack v1.1", banded_bps(), "patch"),
    ] {
        let temp = setup_temp_dir();
        let source = write_wrapped(&temp, &format!("{name}.gz"), "gz", &bytes);
        let result = ingest_json(&temp, &source, "out");
        let ingest = &result["details"]["ingest"];
        assert_eq!(ingest["kind"], kind, "{ingest}");
        let leaves = ingest[if kind == "rom" { "assets" } else { "patches" }]
            .as_array()
            .unwrap();
        assert_eq!(leaves.len(), 1, "{ingest}");
        assert_eq!(leaves[0]["file_name"], name);
        assert_eq!(
            fs::read(
                leaves[0][if kind == "rom" { "path" } else { "leaf_path" }]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            bytes
        );
    }
}

#[test]
fn ingest_classification_dotted_and_extensionless_gzip_non_ingest_commands() {
    for (rom_name, patch_name) in [("rom", "patch"), ("Dr. Mario (Japan, USA)", "Hack v1.1")] {
        let temp = setup_temp_dir();
        let rom = write_wrapped(&temp, &format!("{rom_name}.gz"), "gz", &banded_rom());
        let patch = write_wrapped(&temp, &format!("{patch_name}.gz"), "gz", &banded_bps());
        let applied = temp.child("applied.bin");
        isolated_json_event(
            &temp,
            &[
                "checksum",
                "--input",
                rom.to_str().unwrap(),
                "--filter",
                "rom",
                "--jsonl",
            ],
            0,
        );
        isolated_json_event(
            &temp,
            &[
                "patch",
                "apply",
                "--input",
                rom.to_str().unwrap(),
                "--patch",
                patch.to_str().unwrap(),
                "--output",
                applied.path().to_str().unwrap(),
                "--no-compress",
                "--filter",
                "rom",
                "--filter",
                "patch",
                "--jsonl",
            ],
            0,
        );
        isolated_json_event(
            &temp,
            &[
                "patch",
                "validate",
                "--input",
                rom.to_str().unwrap(),
                "--patch",
                patch.to_str().unwrap(),
                "--filter",
                "rom",
                "--filter",
                "patch",
                "--jsonl",
            ],
            0,
        );
        assert_eq!(fs::read(applied.path()).unwrap(), banded_rom_patched());
    }
}

#[test]
fn ingest_classification_named_and_unnamed_patches_are_unique() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.bin");
    let named = temp.child("a.bps");
    let unnamed = temp.child("patch");
    fs::write(rom.path(), banded_rom()).unwrap();
    fs::write(named.path(), banded_bps()).unwrap();
    fs::write(unnamed.path(), banded_bps()).unwrap();
    let wrapped = write_wrapped(&temp, "compressed.gz", "gz", &banded_bps());
    let archive = temp.child("mixed.zip");
    zip_members(
        &temp,
        archive.path(),
        &[rom.path(), named.path(), unnamed.path(), &wrapped],
    );
    let result = ingest_json(&temp, archive.path(), "out");
    let ingest = &result["details"]["ingest"];
    assert_eq!(ingest["assets"].as_array().unwrap().len(), 1, "{ingest}");
    let mut names: Vec<_> = patch_file_names(ingest)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    names.sort();
    assert_eq!(names, ["a.bps", "compressed", "patch"], "{ingest}");
}

#[test]
fn ingest_classification_unnamed_raw_dump_beside_named_patch_stays_rom() {
    let temp = setup_temp_dir();
    let raw = temp.child("dump");
    let named = temp.child("a.bps");
    fs::write(raw.path(), banded_rom()).unwrap();
    fs::write(named.path(), banded_bps()).unwrap();
    let archive = temp.child("mixed.zip");
    zip_members(&temp, archive.path(), &[raw.path(), named.path()]);
    let result = ingest_json(&temp, archive.path(), "out");
    let ingest = &result["details"]["ingest"];
    assert_eq!(ingest["kind"], "rom", "{ingest}");
    assert_eq!(ingest["assets"].as_array().unwrap().len(), 1, "{ingest}");
    assert_eq!(ingest["patches"].as_array().unwrap().len(), 1, "{ingest}");
}

#[test]
fn ingest_classification_wrong_kind_uses_consistent_filter_error() {
    let temp = setup_temp_dir();
    for name in ["patch.gz", "Hack v1.1.gz", "patch.bps.gz"] {
        let source = write_wrapped(&temp, name, "gz", &banded_bps());
        let result = isolated_json_event(
            &temp,
            &[
                "checksum",
                "--input",
                source.to_str().unwrap(),
                "--filter",
                "rom",
                "--json",
            ],
            1,
        );
        let error = result["error"]["message"].as_str().unwrap();
        assert!(
            error.starts_with(&format!(
                "validation failed: no extract entries from `{}` matched --filter rom",
                source.display()
            )),
            "{result}"
        );
    }
}

fn review_ingest_events(temp: &TempDir, archive: &Path) -> Vec<Value> {
    let home = temp.child("review-home");
    fs::create_dir_all(home.path()).unwrap();
    let home = home.path().to_str().unwrap();
    let out = temp.child("review-out");
    run_json_events_with_env(
        &[
            "ingest",
            "--input",
            archive.to_str().unwrap(),
            "--output",
            out.path().to_str().unwrap(),
            "--jsonl",
        ],
        &[
            ("HOME", home),
            ("XDG_CACHE_HOME", home),
            ("XDG_CONFIG_HOME", home),
            ("XDG_STATE_HOME", home),
            ("XDG_DATA_HOME", home),
            ("TMPDIR", home),
        ],
        0,
    )
}

#[test]
fn ingest_review_complete_sidecar_manifest() {
    for named_count in [1, 2] {
        let temp = setup_temp_dir();
        let mut members = Vec::new();
        for (name, bytes) in [
            ("game.bin", banded_rom()),
            ("a.bps", banded_bps()),
            ("patch", banded_bps()),
        ] {
            let member = temp.child(name);
            fs::write(member.path(), bytes).unwrap();
            members.push(member.path().to_path_buf());
        }
        if named_count == 2 {
            let member = temp.child("b.bps");
            fs::write(member.path(), banded_bps()).unwrap();
            members.push(member.path().to_path_buf());
        }
        members.push(write_wrapped(&temp, "compressed.gz", "gz", &banded_bps()));
        let archive = temp.child("mixed.zip");
        zip_members(
            &temp,
            archive.path(),
            &members.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
        );
        let events = review_ingest_events(&temp, archive.path());
        let manifests: Vec<_> = events
            .iter()
            .filter(|event| event["stage"] == "patch-manifest")
            .collect();
        assert_eq!(manifests.len(), 1, "manifests: {manifests:?}");
        let patches = manifests[0]["details"]["patch_manifest"]["patches"]
            .as_array()
            .unwrap();
        let mut names: Vec<_> = patches
            .iter()
            .map(|patch| patch["file_name"].as_str().unwrap())
            .collect();
        names.sort();
        let expected = if named_count == 1 {
            vec!["a.bps", "compressed", "patch"]
        } else {
            vec!["a.bps", "b.bps", "compressed", "patch"]
        };
        assert_eq!(names, expected);
        let terminal = events.last().unwrap();
        let terminal_patches = terminal["details"]["ingest"]["patches"].as_array().unwrap();
        assert_eq!(terminal_patches.len(), patches.len());
        for (announced, final_patch) in patches.iter().zip(terminal_patches) {
            assert_eq!(announced["file_name"], final_patch["file_name"]);
            assert_eq!(announced["leaf_path"], final_patch["leaf_path"]);
            assert_eq!(announced["is_valid_patch"], true);
            assert_eq!(
                fs::read(announced["leaf_path"].as_str().unwrap()).unwrap(),
                banded_bps()
            );
        }
        let manifest_index = events
            .iter()
            .position(|event| event["stage"] == "patch-manifest")
            .unwrap();
        assert!(manifest_index < events.len() - 1);
    }
}

#[test]
fn ingest_review_disc_sidecar_manifest_precedes_rom_extraction() {
    for extension in ["chd", "rvz", "cso"] {
        let temp = setup_temp_dir();
        let disc = temp.child(format!("game.{extension}"));
        fs::write(disc.path(), banded_rom()).unwrap();
        let patch = temp.child("hack.bps");
        fs::write(patch.path(), banded_bps()).unwrap();
        let archive = temp.child("disc.zip");
        zip_members(&temp, archive.path(), &[disc.path(), patch.path()]);
        let out = temp.child("out");
        let events = run_json_events(
            &[
                "ingest",
                "--input",
                archive.path().to_str().unwrap(),
                "--output",
                out.path().to_str().unwrap(),
                "--no-nested-extract",
                "--jsonl",
            ],
            0,
        );
        let manifest_index = events
            .iter()
            .position(|event| event["stage"] == "patch-manifest")
            .unwrap();
        let extraction_starts: Vec<_> = events
            .iter()
            .enumerate()
            .filter(|(_, event)| event["command"] == "ingest" && event["stage"] == "extract")
            .map(|(index, _)| index)
            .collect();
        assert_eq!(extraction_starts.len(), 2, "{events:?}");
        assert!(
            manifest_index < extraction_starts[1],
            "{extension}: patch dialog must be available before ROM extraction: {events:?}"
        );
        assert_eq!(
            events.last().unwrap()["details"]["ingest"]["patches"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn ingest_review_named_stream_patch_beside_rom() {
    for codec in STREAM_CODECS {
        let temp = setup_temp_dir();
        let rom = temp.child("game.sfc");
        fs::write(rom.path(), banded_rom()).unwrap();
        let patch = write_wrapped(&temp, &format!("hack.bps.{codec}"), codec, &banded_bps());
        let archive = temp.child("mixed.zip");
        zip_members(&temp, archive.path(), &[rom.path(), &patch]);
        let events = review_ingest_events(&temp, archive.path());
        let ingest = &events.last().unwrap()["details"]["ingest"];
        assert_eq!(
            ingest["assets"].as_array().unwrap().len(),
            1,
            "{codec}: {ingest}"
        );
        let patches = ingest["patches"].as_array().unwrap();
        assert_eq!(patches.len(), 1, "{codec}: {ingest}");
        assert_eq!(patches[0]["file_name"], "hack.bps");
        assert_eq!(
            fs::read(patches[0]["leaf_path"].as_str().unwrap()).unwrap(),
            banded_bps()
        );
    }
}

#[test]
fn ingest_review_patch_zip_ignores_executable() {
    let temp = setup_temp_dir();
    let original = temp.child("original.bin");
    let modified = temp.child("modified.bin");
    let patch = temp.child("Game.xdelta");
    fs::write(original.path(), banded_rom()).unwrap();
    fs::write(modified.path(), banded_rom_patched()).unwrap();
    isolated_json_event(
        &temp,
        &[
            "patch",
            "create",
            "--original",
            original.path().to_str().unwrap(),
            "--modified",
            modified.path().to_str().unwrap(),
            "--format",
            "xdelta",
            "--output",
            patch.path().to_str().unwrap(),
            "--json",
        ],
        0,
    );
    let tool = temp.child("xdelta3.exe");
    fs::write(tool.path(), b"MZpatcher executable").unwrap();
    let archive = temp.child("patch.zip");
    zip_members(&temp, archive.path(), &[patch.path(), tool.path()]);
    let events = review_ingest_events(&temp, archive.path());
    let ingest = &events.last().unwrap()["details"]["ingest"];
    assert_eq!(ingest["kind"], "patch", "{ingest}");
    assert!(ingest["assets"].as_array().unwrap().is_empty());
    assert_eq!(ingest["patches"].as_array().unwrap().len(), 1);
    assert_eq!(ingest["patches"][0]["file_name"], "Game.xdelta");
}

fn assert_review_sidecars_do_not_ambiguate(embedded_patch: bool) {
    let temp = setup_temp_dir();
    let rom = temp.child(if embedded_patch {
        "Game.sfc"
    } else {
        "game.sfc"
    });
    let patch = temp.child("Game.bps");
    fs::write(rom.path(), banded_rom()).unwrap();
    fs::write(patch.path(), banded_bps()).unwrap();
    let mut members = vec![rom.path().to_path_buf()];
    for name in if embedded_patch {
        vec!["Game.srm"]
    } else {
        vec!["game.msu", "game-1.pcm"]
    } {
        let file = temp.child(name);
        fs::write(file.path(), b"sidecar data").unwrap();
        members.push(file.path().to_path_buf());
    }
    if embedded_patch {
        members.push(patch.path().to_path_buf());
    }
    let archive = temp.child("rom.zip");
    zip_members(
        &temp,
        archive.path(),
        &members.iter().map(PathBuf::as_path).collect::<Vec<_>>(),
    );
    let checksum = isolated_json_event(
        &temp,
        &[
            "checksum",
            "--input",
            archive.path().to_str().unwrap(),
            "--filter",
            "rom",
            "--json",
        ],
        0,
    );
    assert_eq!(checksum["status"], "succeeded", "{checksum}");
    let output = temp.child("patched.sfc");
    let mut args = vec![
        "patch",
        "apply",
        "--input",
        archive.path().to_str().unwrap(),
        "--output",
        output.path().to_str().unwrap(),
        "--no-compress",
        "--filter",
        "rom",
        "--jsonl",
    ];
    if !embedded_patch {
        args.extend(["--patch", patch.path().to_str().unwrap()]);
    }
    isolated_json_event(&temp, &args, 0);
    assert_eq!(fs::read(output.path()).unwrap(), banded_rom_patched());
}

#[test]
fn ingest_review_msu_sidecars_do_not_ambiguate() {
    assert_review_sidecars_do_not_ambiguate(false);
}

#[test]
fn ingest_review_save_sidecar_does_not_ambiguate() {
    assert_review_sidecars_do_not_ambiguate(true);
}

#[test]
fn ingest_review_zip_directories_are_not_payloads() {
    for (folder, name, bytes, kind) in [
        ("Game", "Game.sfc", banded_rom(), "rom"),
        ("Hack", "Hack.bps", banded_bps(), "patch"),
    ] {
        let temp = setup_temp_dir();
        let directory = temp.child(folder);
        fs::create_dir(directory.path()).unwrap();
        fs::write(directory.path().join(name), &bytes).unwrap();
        let archive = temp.child("folder.zip");
        zip_members(&temp, archive.path(), &[directory.path()]);
        let events = review_ingest_events(&temp, archive.path());
        let probe = events
            .iter()
            .find_map(|event| event["details"].get("probe_manifest"))
            .unwrap();
        assert_eq!(probe["is_rom"], kind == "rom", "{probe}");
        let ingest = &events.last().unwrap()["details"]["ingest"];
        assert_eq!(ingest["kind"], kind, "{ingest}");
        let leaves = ingest[if kind == "rom" { "assets" } else { "patches" }]
            .as_array()
            .unwrap();
        assert_eq!(leaves.len(), 1, "{ingest}");
        assert_eq!(
            fs::read(
                leaves[0][if kind == "rom" { "path" } else { "leaf_path" }]
                    .as_str()
                    .unwrap()
            )
            .unwrap(),
            bytes
        );
        if kind == "rom" {
            isolated_json_event(
                &temp,
                &[
                    "checksum",
                    "--input",
                    archive.path().to_str().unwrap(),
                    "--filter",
                    "rom",
                    "--json",
                ],
                0,
            );
        }
    }
}
