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

/// The IDs the loader derives for the synthetic shard's four records: the
/// first 24 hex digits of SHA-256 over
/// `nes NUL game_test NUL NUL {"code":<code>,"desc":<description>}`, as
/// `cheatIdSource` in the webapp's `shard-format.mjs` computes them.
const CHEAT_ROM: &str = "cheat_5dab2c1d036a60f251b61b60";
const CHEAT_RAM: &str = "cheat_41671ecff0dd0821b913536d";
const CHEAT_C1: &str = "cheat_e96f1cb6d8e0208c8abcca11";
const CHEAT_C2: &str = "cheat_06d5d82fb0b3c7efe0e1cfb5";

/// A cheat-database directory holding one synthetic NES shard in the stored
/// form the data build writes. `crc32` is the checksum of [`nes_rom`], so the
/// checksum path can be exercised without a real dump.
fn write_cheat_database(temp: &TempDir, rom: &[u8]) -> String {
    let directory = temp.child("cheatdb");
    fs::create_dir_all(directory.path()).expect("cheat database directory");
    let mut crc = flate2::Crc::new();
    crc.update(rom);
    let shard = serde_json::json!({
        "schemaVersion": 1,
        "system": "nes",
        "sourceRevision": "testrevision",
        "games": [{
            "id": "game_test",
            "title": "Test Game",
            "normalizedTitle": "test game",
            "sourceFiles": ["test.cht"],
            "checksums": [{ "crc32": format!("{:08x}", crc.sum()) }],
            "cheats": [
                cheat_entry("Team runs faster", "AKE-LVS", 0),
                cheat_entry("High score", "0025:63", 1),
                cheat_entry("Conflict one", "BD86:49", 2),
                cheat_entry("Conflict two", "BD86:4A", 3),
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

fn cheat_entry(description: &str, code: &str, index: usize) -> Value {
    serde_json::json!({
        "description": description,
        "rawCode": code,
        "sourceFile": 0,
        "sourceIndex": index,
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
    assert_eq!(entries[0]["id"], CHEAT_ROM);
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
            CHEAT_ROM,
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
            CHEAT_RAM,
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
            CHEAT_ROM,
            "--cheat",
            CHEAT_RAM,
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
            CHEAT_C1,
            "--cheat",
            CHEAT_C2,
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
        label.contains(CHEAT_C1) && label.contains(CHEAT_C2),
        "{label}"
    );

    let allowed = parse_single_json_line(&command_stdout(&args(&["--allow-cheat-conflicts"]), 0));
    assert_eq!(allowed["status"], "succeeded");
    // Last selector wins: BD86:4A.
    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x3D96], 0x4A);
}

#[test]
fn an_unknown_cheat_system_names_the_flag_that_set_it() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nes");
    fs::write(input.path(), nes_rom()).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "cheat",
            "list",
            "--input",
            &input_s,
            "--cheat-system",
            "bogus",
            "--json",
        ],
        1,
    ));
    let label = report["label"].as_str().expect("label");
    assert!(label.contains("--cheat-system"), "{label}");
    assert!(!label.contains("--code-system"), "{label}");
    assert!(label.contains("gameboy-color"), "{label}");
}

/// `bundle create --cheat` for [`nes_rom`], recording one bakeable cheat and
/// one the ROM's bytes cannot bake. Returns `(bundle path, database path)`.
fn write_cheat_bundle(temp: &TempDir, rom: &[u8]) -> (String, String) {
    let database = write_cheat_database(temp, rom);
    let input = temp.child("game.nes");
    fs::write(input.path(), rom).expect("fixture");
    let bundle = temp.child("rom-weaver-bundle.json");
    let bundle_s = bundle.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "bundle",
            "create",
            "--input",
            input.path().to_str().expect("path"),
            "--cheat-database",
            &database,
            "--cheat",
            CHEAT_ROM,
            "--output",
            &bundle_s,
            "--json",
        ],
        0,
    ));
    assert_eq!(report["status"], "succeeded");
    let cheats = &report["details"]["bundle_create"]["bundle"]["cheats"];
    assert_eq!(cheats[0]["id"], CHEAT_ROM);
    assert_eq!(cheats[0]["code"], "AKE-LVS");
    assert_eq!(cheats[0]["revision"], "testrevision");

    // A cheat the ROM cannot bake is refused, not recorded.
    let refused = parse_single_json_line(&command_stdout(
        &[
            "bundle",
            "create",
            "--input",
            input.path().to_str().expect("path"),
            "--cheat-database",
            &database,
            "--cheat",
            CHEAT_RAM,
            "--output",
            temp.child("refused.json").path().to_str().expect("path"),
            "--json",
        ],
        1,
    ));
    let label = refused["label"].as_str().expect("label");
    assert!(label.contains("High score"), "{label}");
    (bundle_s, database)
}

#[test]
fn bundle_apply_reproduces_a_cheat_apply_byte_for_byte() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let (bundle, database) = write_cheat_bundle(&temp, &rom);
    let input = temp.child("game.nes");
    let input_s = input.path().to_str().expect("path").to_owned();
    let via_bundle = temp.child("via-bundle.nes");
    let via_bundle_s = via_bundle.path().to_str().expect("path").to_owned();
    let direct = temp.child("direct.nes");
    let direct_s = direct.path().to_str().expect("path").to_owned();

    let report = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--bundle",
            &bundle,
            "--cheat-database",
            &database,
            "--output",
            &via_bundle_s,
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(report["status"], "succeeded");
    // AKE-LVS -> $BD86:48; header (16) + (0xBD86 - 0x8000) = 0x3D96.
    assert_eq!(fs::read(via_bundle.path()).expect("output")[0x3D96], 0x48);

    command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &input_s,
            "--cheat-database",
            &database,
            "--cheat",
            CHEAT_ROM,
            "--output",
            &direct_s,
            "--no-compress",
            "--json",
        ],
        0,
    );
    assert_eq!(
        fs::read(via_bundle.path()).expect("bundle output"),
        fs::read(direct.path()).expect("direct output"),
        "a bundle apply must reproduce the direct cheat apply byte-for-byte"
    );
}

#[test]
fn bundle_apply_without_the_database_bakes_from_the_snapshot() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let (bundle, _) = write_cheat_bundle(&temp, &rom);
    let empty = temp.child("no-database");
    fs::create_dir_all(empty.path()).expect("directory");
    let empty_s = empty.path().to_str().expect("path").to_owned();
    let input_s = temp
        .child("game.nes")
        .path()
        .to_str()
        .expect("path")
        .to_owned();
    let output = temp.child("patched.nes");
    let output_s = output.path().to_str().expect("path").to_owned();
    let args = |bundle: &str| {
        vec![
            "patch".to_owned(),
            "apply".to_owned(),
            "--input".to_owned(),
            input_s.clone(),
            "--bundle".to_owned(),
            bundle.to_owned(),
            "--cheat-database".to_owned(),
            empty_s.clone(),
            "--output".to_owned(),
            output_s.clone(),
            "--no-compress".to_owned(),
            "--force".to_owned(),
            "--json".to_owned(),
        ]
    };
    fn borrowed(args: &[String]) -> Vec<&str> {
        args.iter().map(String::as_str).collect()
    }

    // The recorded entry bakes from its own code snapshot with no database.
    let report = parse_single_json_line(&command_stdout(&borrowed(&args(&bundle)), 0));
    assert_eq!(report["status"], "succeeded");
    assert_eq!(fs::read(output.path()).expect("output")[0x3D96], 0x48);

    // An entry with no snapshot and no database fails, unless it is optional.
    let stripped = temp.child("stripped-bundle.json");
    let mut parsed: Value =
        serde_json::from_str(&fs::read_to_string(&bundle).expect("bundle")).expect("bundle json");
    parsed["cheats"][0]["code"] = Value::Null;
    parsed["cheats"][0]["id"] = Value::String("cheat_missing".to_owned());
    fs::write(
        stripped.path(),
        serde_json::to_vec(&parsed).expect("bundle json"),
    )
    .expect("bundle");
    let failed = parse_single_json_line(&command_stdout(
        &borrowed(&args(stripped.path().to_str().expect("path"))),
        1,
    ));
    let label = failed["label"].as_str().expect("label");
    assert!(label.contains("cheat_missing"), "{label}");
    assert!(label.contains("rom-weaver setup"), "{label}");
}

#[test]
fn bundle_parse_lists_the_cheats_a_bundle_carries() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let (bundle, _) = write_cheat_bundle(&temp, &rom);

    let report = parse_single_json_line(&command_stdout(
        &["bundle", "parse", "--input", &bundle, "--json"],
        0,
    ));
    assert_eq!(report["status"], "succeeded");
    let label = report["label"].as_str().expect("label");
    assert!(label.contains("1 cheat entry"), "{label}");
    assert!(label.contains("Team runs faster"), "{label}");
    let cheats = report["details"]["bundle"]["bundle"]["cheats"]
        .as_array()
        .expect("cheats");
    assert_eq!(cheats.len(), 1);
    assert_eq!(cheats[0]["description"], "Team runs faster");
}

#[test]
fn patch_apply_emit_bundle_records_the_cheat_selection() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let database = write_cheat_database(&temp, &rom);
    let input = temp.child("game.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let output = temp.child("patched.nes");
    let emitted = temp.child("emitted-bundle.json");

    // The bundle is written after the terminal apply event, so the last JSON
    // line is not the one that reports the apply.
    let events = parse_json_lines(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--cheat-database",
            &database,
            "--cheat",
            CHEAT_ROM,
            "--output",
            output.path().to_str().expect("path"),
            "--emit-bundle",
            emitted.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert!(
        events
            .iter()
            .any(|event| event["command"] == "patch-apply" && event["status"] == "succeeded"),
        "{events:?}"
    );
    let parsed: Value =
        serde_json::from_str(&fs::read_to_string(emitted.path()).expect("emitted bundle"))
            .expect("bundle json");
    assert_eq!(parsed["cheats"][0]["id"], CHEAT_ROM);
    assert_eq!(parsed["cheats"][0]["code"], "AKE-LVS");
    assert!(parsed["patches"].as_array().expect("patches").is_empty());
}

/// Write a hand-authored cheats-only bundle beside [`nes_rom`], so the shapes
/// `bundle create` never emits can be applied too.
fn write_cheats_only_bundle(temp: &TempDir, name: &str, cheats: Value) -> String {
    let bundle = temp.child(name);
    let document = serde_json::json!({
        "version": 1,
        "rom": { "path": "game.nes" },
        "patches": [],
        "cheats": cheats,
    });
    fs::write(
        bundle.path(),
        serde_json::to_vec(&document).expect("bundle json"),
    )
    .expect("bundle");
    bundle.path().to_str().expect("path").to_owned()
}

#[test]
fn an_all_skipped_optional_bundle_names_what_it_dropped() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let input = temp.child("game.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let empty = temp.child("no-database");
    fs::create_dir_all(empty.path()).expect("directory");
    let bundle = write_cheats_only_bundle(
        &temp,
        "optional-only-bundle.json",
        serde_json::json!([{ "id": CHEAT_RAM, "optional": true }]),
    );
    let output = temp.child("patched.nes");

    let report = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--bundle",
            &bundle,
            "--cheat-database",
            empty.path().to_str().expect("path"),
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    ));
    let label = report["label"].as_str().expect("label");
    assert!(
        label.contains("every cheat this bundle records was skipped"),
        "{label}"
    );
    assert!(label.contains(CHEAT_RAM), "{label}");
    assert!(!label.contains("was not executed"), "{label}");
    assert!(!output.path().exists());
}

#[test]
fn emit_bundle_keeps_an_applied_cheat_that_shares_an_id_with_a_skipped_one() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let input = temp.child("game.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let empty = temp.child("no-database");
    fs::create_dir_all(empty.path()).expect("directory");
    let database = empty.path().to_str().expect("path").to_owned();
    // Both entries name `cheat_rom`. With no database the second has no code
    // to fall back on, so it is skipped while the first applies from its
    // snapshot - the skip is tracked by index, not by id.
    let bundle = write_cheats_only_bundle(
        &temp,
        "twin-bundle.json",
        serde_json::json!([
            { "id": CHEAT_ROM, "code": "AKE-LVS" },
            { "id": CHEAT_ROM, "optional": true },
        ]),
    );
    let output = temp.child("patched.nes");
    let emitted = temp.child("emitted-bundle.json");

    let events = parse_json_lines(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--bundle",
            &bundle,
            "--cheat-database",
            &database,
            "--output",
            output.path().to_str().expect("path"),
            "--emit-bundle",
            emitted.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert!(
        events
            .iter()
            .any(|event| event["command"] == "patch-apply" && event["status"] == "succeeded"),
        "{events:?}"
    );
    let parsed: Value =
        serde_json::from_str(&fs::read_to_string(emitted.path()).expect("emitted bundle"))
            .expect("bundle json");
    let cheats = parsed["cheats"].as_array().expect("cheats");
    assert_eq!(cheats.len(), 1, "{cheats:?}");
    assert_eq!(cheats[0]["id"], CHEAT_ROM);
}

#[test]
fn bundle_create_from_a_spec_lets_an_explicit_cheat_replace_its_cheats() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let database = write_cheat_database(&temp, &rom);
    let input = temp.child("game.nes");
    fs::write(input.path(), &rom).expect("fixture");
    let spec = temp.child("spec.json");
    fs::write(
        spec.path(),
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "rom": { "path": "game.nes" },
            "patches": [],
            "cheats": [{ "id": CHEAT_ROM }],
        }))
        .expect("spec json"),
    )
    .expect("spec");
    let output = temp.child("rom-weaver-bundle.json");
    let spec_s = spec.path().to_str().expect("path").to_owned();
    let output_s = output.path().to_str().expect("path").to_owned();

    // Without --cheat the spec's own entries carry through.
    let kept = parse_single_json_line(&command_stdout(
        &[
            "bundle", "create", "--from", &spec_s, "--output", &output_s, "--json",
        ],
        0,
    ));
    let cheats = kept["details"]["bundle_create"]["bundle"]["cheats"]
        .as_array()
        .expect("cheats");
    assert_eq!(cheats.len(), 1);
    assert_eq!(cheats[0]["id"], CHEAT_ROM);

    // With --cheat the selection replaces them rather than appending.
    let replaced = parse_single_json_line(&command_stdout(
        &[
            "bundle",
            "create",
            "--from",
            &spec_s,
            "--cheat-database",
            &database,
            "--cheat",
            CHEAT_ROM,
            "--output",
            &output_s,
            "--force",
            "--json",
        ],
        0,
    ));
    let cheats = replaced["details"]["bundle_create"]["bundle"]["cheats"]
        .as_array()
        .expect("cheats");
    assert_eq!(cheats.len(), 1, "{cheats:?}");
    assert_eq!(cheats[0]["id"], CHEAT_ROM);
    assert_eq!(cheats[0]["code"], "AKE-LVS");
}

#[test]
fn without_cheats_runs_the_bundle_patch_chain_alone() {
    let temp = setup_temp_dir();
    let rom = nes_rom();
    let (bundle, database) = write_cheat_bundle(&temp, &rom);
    let input = temp.child("game.nes");
    let output = temp.child("patched.nes");

    // A cheats-only bundle has nothing left once the cheats are dropped.
    let refused = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            input.path().to_str().expect("path"),
            "--bundle",
            &bundle,
            "--cheat-database",
            &database,
            "--without-cheats",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        1,
    ));
    assert_eq!(refused["status"], "failed");
    assert!(!output.path().exists());
}

/// A cheat lands after the explicit patch chain: the patch's own source
/// checksum still matches, and the cheat wins over a patch that changes the
/// same byte.
#[test]
fn cheat_codes_apply_after_explicit_patches() {
    let temp = setup_temp_dir();
    let original = temp.child("game.nes");
    let modified = temp.child("modified.nes");
    let patch = temp.child("hack.bps");
    let output = temp.child("final.nes");
    let mut hacked = nes_rom();
    hacked[0x100] = 0x22;
    hacked[0x3D96] = 0x11; // the byte AKE-LVS writes
    fs::write(original.path(), nes_rom()).expect("fixture");
    fs::write(modified.path(), hacked).expect("fixture");
    let original_s = original.path().to_str().expect("path").to_owned();
    let patch_s = patch.path().to_str().expect("path").to_owned();

    let create = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "create",
            "--original",
            &original_s,
            "--modified",
            modified.path().to_str().expect("path"),
            "--output",
            &patch_s,
            "--json",
        ],
        0,
    ));
    assert_eq!(create["status"], "succeeded");
    assert_eq!(create["format"], "BPS");

    let apply = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "apply",
            "--input",
            &original_s,
            "--patch",
            &patch_s,
            "--code",
            "AKE-LVS",
            "--output",
            output.path().to_str().expect("path"),
            "--no-compress",
            "--json",
        ],
        0,
    ));
    assert_eq!(apply["status"], "succeeded");

    let patched = fs::read(output.path()).expect("output");
    assert_eq!(patched[0x100], 0x22, "the patch's own change survives");
    assert_eq!(patched[0x3D96], 0x48, "the cheat wins over the patch");
}

/// `--code` with an extended SOLID header records the codes in the comment
/// unless the caller wrote one.
#[test]
fn cheat_create_solid_comment_records_codes() {
    let temp = setup_temp_dir();
    let input = temp.child("game.nes");
    let patch = temp.child("cheat.solid");
    fs::write(input.path(), nes_rom()).expect("fixture");
    let input_s = input.path().to_str().expect("path").to_owned();
    let patch_s = patch.path().to_str().expect("path").to_owned();

    let create = parse_single_json_line(&command_stdout(
        &[
            "patch",
            "create",
            "--original",
            &input_s,
            "--code",
            "AKE-LVS",
            "--solid-extended",
            "--output",
            &patch_s,
            "--json",
        ],
        0,
    ));
    assert_eq!(create["status"], "succeeded");
    assert_eq!(create["format"], "SOLID");
    let bytes = fs::read(patch.path()).expect("patch");
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("cheat codes (nes): AKE-LVS"),
        "SOLID comment should record the codes"
    );
}
