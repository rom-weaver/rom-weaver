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
fn ingest_chd_split_bin_false_merges_to_single_bin() {
    let temp = setup_temp_dir();
    let chd = create_two_track_cd_chd(&temp);
    let out_dir = temp.child("ingest-chd-merged");

    let terminal = ingest_terminal(&[
        "ingest",
        chd.to_str().expect("path"),
        "--out-dir",
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
        chd.to_str().expect("path"),
        "--out-dir",
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
        chd.to_str().expect("path"),
        "--out-dir",
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
        rom.path().to_str().expect("path"),
        "--out-dir",
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
fn ingest_rom_archive_extracts_and_checksums() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"archived rom payload")).expect("rom fixture");
    let archive = temp.child("bundle.zip");
    command_stdout(
        &[
            "compress",
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
            archive.path().to_str().expect("path"),
            "--out-dir",
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
        outer.path().to_str().expect("path"),
        "--out-dir",
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
        patch.path().to_str().expect("path"),
        "--out-dir",
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
        patch.path().to_str().expect("path"),
        "--out-dir",
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
        patch.to_str().expect("path"),
        "--out-dir",
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
        patch.path().to_str().expect("path"),
        "--out-dir",
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
        archive.path().to_str().expect("path"),
        "--out-dir",
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
            rom.path().to_str().expect("path"),
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
        archive.path().to_str().expect("path"),
        "--out-dir",
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
fn ingest_rejects_unsupported_checksum_algorithm() {
    let temp = setup_temp_dir();
    let rom = temp.child("game.nes");
    fs::write(rom.path(), with_nes_header(b"rom")).expect("rom fixture");
    let out_dir = temp.child("ingest-bad-algo-out");

    let terminal = run_single_json_event(
        &[
            "ingest",
            rom.path().to_str().expect("path"),
            "--out-dir",
            out_dir.path().to_str().expect("path"),
            "--checksum",
            "not-a-real-algo",
            "--json",
        ],
        1,
    );
    assert_eq!(terminal["command"], "ingest");
    assert_eq!(terminal["status"], "failed");
}

#[test]
fn ingest_disc_asset_carries_engine_disc_format() {
    // The webapp's CHD output-panel disc label is now driven by this `disc_format`
    // verdict (engine identity), not a TS filename/cue regex — lock the contract.
    let temp = setup_temp_dir();
    let iso = temp.child("game.iso");
    fs::write(iso.path(), build_test_gamecube_iso(0x8000)).expect("iso fixture");
    let out_dir = temp.child("ingest-disc-out");

    let terminal = ingest_terminal(&[
        "ingest",
        iso.path().to_str().expect("path"),
        "--out-dir",
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
