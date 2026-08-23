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
