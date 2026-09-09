use super::shared::*;

/// A 2-PRG-bank (32 KiB) iNES ROM whose payload bytes are all zero.
fn nes_rom() -> Vec<u8> {
    with_nes_header(&vec![0u8; 0x8000])
}

fn gba_rom() -> Vec<u8> {
    let mut rom = vec![0u8; 0x200];
    rom[4..8].copy_from_slice(&[0x24, 0xFF, 0xAE, 0x51]);
    rom
}

fn psx_exe() -> Vec<u8> {
    let mut exe = vec![0u8; 0x800 + 16];
    exe[..8].copy_from_slice(b"PS-X EXE");
    exe[0x18..0x1C].copy_from_slice(&0x8001_0000u32.to_le_bytes());
    exe[0x1C..0x20].copy_from_slice(&16u32.to_le_bytes());
    exe
}

#[test]
fn nes_game_genie_apply_bakes_byte() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nes");
    let output = temp.child("patched.nes");
    fs::write(input.path(), nes_rom()).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--code",
            "AKE-LVS",
            "--output",
            &output_s,
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(apply["command"], "patch-apply");
    assert_eq!(apply["status"], "succeeded");
    assert!(
        apply["label"].as_str().unwrap().contains("cheat code"),
        "label should mention cheat codes: {}",
        apply["label"]
    );

    // AKE-LVS decodes to $BD86:48; for a header (16) + bank-0 mapping the file
    // offset is 16 + (0xBD86 - 0x8000) = 0x3D96.
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x3D96], 0x48);
}

#[test]
fn cheat_create_ips_round_trips_to_apply() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nes");
    let patch = temp.child("cheat.ips");
    let direct = temp.child("direct.nes");
    let via_patch = temp.child("via-patch.nes");
    fs::write(input.path(), nes_rom()).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();
    let patch_s = patch.path().to_str().expect("path").to_owned();

    // patch create --code -> IPS patch file.
    let create = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "create",
            "--original",
            &input_s,
            "--code",
            "AKE-LVS",
            "--output",
            &patch_s,
            "--json",
        ],
        0,
    ));
    assert_eq!(create["command"], "patch-create");
    assert_eq!(create["status"], "succeeded");
    assert_eq!(create["format"], "IPS");

    // Direct cheat apply.
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--code",
            "AKE-LVS",
            "--output",
            direct.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );
    // Apply the generated IPS.
    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--patch",
            &patch_s,
            "--output",
            via_patch.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    );

    let direct_bytes = fs::read(direct.path()).expect("direct");
    let via_patch_bytes = fs::read(via_patch.path()).expect("via patch");
    assert_eq!(
        direct_bytes, via_patch_bytes,
        "created IPS must reproduce the direct cheat apply byte-for-byte"
    );
}

#[test]
fn nes_action_replay_ram_code_is_rejected() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nes");
    let output = temp.child("patched.nes");
    fs::write(input.path(), nes_rom()).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    // $0010 is work RAM, not addressable in the ROM file.
    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--code",
            "0010AB",
            "--code-kind",
            "par",
            "--output",
            &output_s,
            "--no-compress",
            "--json",
        ],
        1,
    ));
    assert_eq!(apply["status"], "failed");
    assert!(
        apply["label"]
            .as_str()
            .unwrap()
            .contains("cheat_ram_address"),
        "label should report the RAM-address code: {}",
        apply["label"]
    );
}

#[test]
fn snes_game_genie_apply_bakes_byte() {
    let temp = setup_temp_dir();
    let input = temp.child("game.sfc");
    let output = temp.child("patched.sfc");
    // 4 MiB headerless LoROM image (no internal header -> LoROM fallback). The
    // system is forced via --code-system since a zeroed ROM has no header.
    fs::write(input.path(), vec![0u8; 0x40_0000]).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--code",
            "ABCD-EFFF",
            "--code-system",
            "snes",
            "--output",
            &output_s,
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(apply["status"], "succeeded");
    // ABCD-EFFF decodes to $C4A704:C9; LoROM offset =
    // ((0xC4 & 0x7F) << 15) | (0xA704 & 0x7FFF) = 0x222704.
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x22_2704], 0xC9);
}

#[test]
fn game_boy_game_genie_apply_bakes_byte() {
    let temp = setup_temp_dir();
    let input = temp.child("game.gb");
    let output = temp.child("patched.gb");
    fs::write(input.path(), build_test_game_boy_rom(0x8000)).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    // AB100F decodes to value 0xAB at address $0100 (bank 0, file offset 0x100).
    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--code",
            "AB100F",
            "--output",
            &output_s,
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(apply["status"], "succeeded");
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x0100], 0xAB);
}

#[test]
fn gba_xploder_rom_patch_bakes_halfword() {
    let temp = setup_temp_dir();
    let input = temp.child("game.gba");
    let output = temp.child("patched.gba");
    fs::write(input.path(), gba_rom()).expect("fixture");

    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--code",
            "00000000 18000004 0000ABCD 00000000",
            "--code-kind",
            "xploder",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(apply["status"], "succeeded");
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(&patched[8..10], &[0xCD, 0xAB]);
}

#[test]
fn playstation_xploder_write_bakes_into_psx_exe() {
    let temp = setup_temp_dir();
    let input = temp.child("game.exe");
    let output = temp.child("patched.exe");
    fs::write(input.path(), psx_exe()).expect("fixture");

    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--code",
            "30010000 00FF",
            "--code-kind",
            "xploder",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(apply["status"], "succeeded");
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x800], 0xFF);
}

/// A 32 KiB Master System image whose `TMR SEGA` header lets the CLI detect the
/// system without `--code-system`.
fn master_system_rom() -> Vec<u8> {
    let mut rom = vec![0u8; 0x8000];
    rom[0x7FF0..0x7FF8].copy_from_slice(b"TMR SEGA");
    rom
}

#[test]
fn master_system_game_genie_apply_bakes_byte() {
    let temp = setup_temp_dir();
    let input = temp.child("game.sms");
    let output = temp.child("patched.sms");
    fs::write(input.path(), master_system_rom()).expect("fixture");

    // 11A-C3B decodes to value 0x11 at address $4AC3, which is a headerless
    // file offset.
    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--code",
            "11A-C3B",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(apply["status"], "succeeded");
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x4AC3], 0x11);
}

#[test]
fn master_system_action_replay_ram_code_is_rejected() {
    let temp = setup_temp_dir();
    let input = temp.child("game.sms");
    let output = temp.child("patched.sms");
    fs::write(input.path(), master_system_rom()).expect("fixture");

    // $C012 is work RAM, not addressable in the ROM file.
    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--code",
            "00C0-12AB",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    ));
    assert_eq!(apply["status"], "failed");
    assert!(
        apply["label"]
            .as_str()
            .unwrap()
            .contains("cheat_ram_address"),
        "label should report the RAM-address code: {}",
        apply["label"]
    );
}

/// A cheat-database directory holding one synthetic NES shard. `crc32` is the
/// checksum of [`nes_rom`], so the checksum path can be exercised without a
/// real dump.
fn write_cheat_database(temp: &TempDir, rom: &[u8]) -> String {
    let directory = temp.child("cheatdb");
    fs::create_dir_all(directory.path()).expect("cheat database directory");
    let mut crc = flate2::Crc::new();
    crc.update(rom);
    let shard = serde_json::json!({
        "schemaVersion": 1,
        "system": "nes",
        "games": [{
            "id": "game_test",
            "title": "Test Game",
            "normalizedTitle": "test game",
            "checksums": [{ "crc32": format!("{:08x}", crc.sum()) }],
            "cheats": [
                cheat_entry("cheat_rom", "Team runs faster", "AKE-LVS", 0),
                cheat_entry("cheat_ram", "High score", "0025:63", 1),
                cheat_entry("cheat_c1", "Conflict one", "BD86:49", 2),
                cheat_entry("cheat_c2", "Conflict two", "BD86:4A", 3),
            ],
        }],
    });
    fs::write(
        directory
            .child("nintendo-nintendo-entertainment-system.json")
            .path(),
        serde_json::to_vec(&shard).expect("shard json"),
    )
    .expect("shard");
    let manifest = serde_json::json!({
        "schemaVersion": 1,
        "source": "libretro/libretro-database",
        "sourceRevision": "testrevision",
        "sourceUrl": "https://github.com/libretro/libretro-database",
        "license": "CC-BY-SA-4.0",
        "systems": {},
    });
    fs::write(
        directory.child("manifest.json").path(),
        serde_json::to_vec(&manifest).expect("manifest json"),
    )
    .expect("manifest");
    directory.path().to_str().expect("path").to_owned()
}

fn cheat_entry(id: &str, description: &str, code: &str, index: usize) -> Value {
    serde_json::json!({
        "id": id,
        "system": "nes",
        "gameId": "game_test",
        "description": description,
        "rawCode": code,
        "rawFields": { "desc": description, "code": code },
        "sourceFile": "test.cht",
        "sourceIndex": index,
        "sourceRevision": "testrevision",
    })
}

#[test]
fn cheat_list_matches_by_checksum_and_reports_delivery() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let database = write_cheat_database(&temp, &rom);
    // A file name that matches no title, so only the checksum can match.
    let input = temp.child("unrelated-dump.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "cheat",
            "list",
            "--input",
            &input_s,
            "--cheat-database",
            &database,
            "--json",
        ],
        0,
    ));
    assert_eq!(report["status"], "succeeded");
    let list = &report["details"]["cheat_list"];
    assert_eq!(list["match_kind"], "exact");
    assert_eq!(list["game_id"], "game_test");
    assert_eq!(list["system"], "nes");
    assert!(
        list["attribution"]
            .as_str()
            .unwrap()
            .contains("CC-BY-SA-4.0"),
        "attribution should name the license: {}",
        list["attribution"]
    );
    let entries = list["entries"].as_array().expect("entries");
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0]["id"], "cheat_rom");
    assert_eq!(entries[0]["delivery"], "rom");
    assert_eq!(entries[0]["code"], "AKE-LVS");
    assert_eq!(entries[1]["delivery"], "unsupported");
}

#[test]
fn cheat_list_falls_back_to_the_title() {
    let temp = setup_temp_dir();
    let database = write_cheat_database(&temp, &nes_rom());
    // Different bytes, so no checksum matches; the file name carries the title.
    let mut rom = nes_rom();
    rom[0x20] = 0x55;
    let input = temp.child("Test Game (USA).nes");
    fs::write(input.path(), &rom).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "cheat",
            "list",
            "--input",
            &input_s,
            "--cheat-database",
            &database,
            "--json",
        ],
        0,
    ));
    assert_eq!(report["details"]["cheat_list"]["match_kind"], "title");
}

#[test]
fn cheat_list_names_the_missing_shard() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nes");
    fs::write(input.path(), nes_rom()).expect("fixture");
    let empty = temp.child("empty-db");
    fs::create_dir_all(empty.path()).expect("directory");
    let input_s = input.path().to_str().expect("path").to_owned();
    let empty_s = empty.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "cheat",
            "list",
            "--input",
            &input_s,
            "--cheat-database",
            &empty_s,
            "--json",
        ],
        1,
    ));
    let label = report["label"].as_str().expect("label");
    assert!(
        label.contains("nintendo-nintendo-entertainment-system.json.br"),
        "{label}"
    );
    assert!(label.contains("rom-weaver setup"), "{label}");
}

#[test]
fn patch_apply_bakes_database_cheats_and_refuses_unbakeable_ones() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let database = write_cheat_database(&temp, &rom);
    let input = temp.child("game.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let output = temp.child("patched.nes");
    let input_s = input.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--cheat-database",
            &database,
            "--cheat",
            "cheat_rom",
            "--output",
            &output_s,
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(report["status"], "succeeded");
    // AKE-LVS -> $BD86:48; header (16) + (0xBD86 - 0x8000) = 0x3D96.
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x3D96], 0x48);

    let refused = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--cheat-database",
            &database,
            "--cheat",
            "cheat_ram",
            "--output",
            &output_s,
            "--no-compress",
            "--force",
            "--json",
        ],
        1,
    ));
    let label = refused["label"].as_str().expect("label");
    assert!(label.contains("High score"), "{label}");
}

#[test]
fn patch_create_lists_the_cheats_it_skipped() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let database = write_cheat_database(&temp, &rom);
    let input = temp.child("game.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let output = temp.child("cheat.ips");
    let input_s = input.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "create",
            "--original",
            &input_s,
            "--cheat-database",
            &database,
            "--cheat",
            "cheat_rom",
            "--cheat",
            "cheat_ram",
            "--output",
            &output_s,
            "--json",
        ],
        0,
    ));
    assert_eq!(report["status"], "succeeded");
    let skipped = &report["details"]["skipped_cheats"];
    assert_eq!(skipped["descriptions"][0], "High score");
}

#[test]
fn conflicting_rom_cheats_fail_until_allowed() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let database = write_cheat_database(&temp, &rom);
    let input = temp.child("game.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let output = temp.child("patched.nes");
    let input_s = input.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();
    let args = |extra: &'static [&'static str]| {
        let mut args = vec![
            "patch",
            "apply",
            "--input",
            &input_s,
            "--cheat-database",
            &database,
            "--cheat",
            "cheat_c1",
            "--cheat",
            "cheat_c2",
            "--output",
            &output_s,
            "--no-compress",
            "--json",
        ];
        args.extend_from_slice(extra);
        args
    };

    let failed = parse_single_json_line(&command_stdout(&args(&[]), 1));
    let label = failed["label"].as_str().expect("label");
    assert!(label.contains("cheat_write_conflict"), "{label}");
    assert!(
        label.contains("cheat_c1") && label.contains("cheat_c2"),
        "{label}"
    );

    let allowed = parse_single_json_line(&command_stdout(&args(&["--allow-cheat-conflicts"]), 0));
    assert_eq!(allowed["status"], "succeeded");
    // Last selector wins: BD86:4A.
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x3D96], 0x4A);
}
