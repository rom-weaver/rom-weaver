use super::*;
use rom_weaver_core::RomWeaverError;

fn err_code(err: &RomWeaverError) -> &str {
    match err {
        RomWeaverError::ValidationCode(inner) => inner.code(),
        other => panic!("expected ValidationCode, got {other:?}"),
    }
}

// --- Game Genie decode vectors (canonical worked examples) -----------------

#[test]
fn nes_game_genie_vector() {
    let decoded = decode("AKE-LVS", CheatSystem::Nes, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0xBD86);
    assert_eq!(decoded.value, 0x48);
    assert_eq!(decoded.compare, None);
    assert_eq!(decoded.width, 1);
}

#[test]
fn snes_game_genie_vector() {
    let decoded = decode("ABCD-EFFF", CheatSystem::Snes, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0xC4A704);
    assert_eq!(decoded.value, 0xC9);
    assert_eq!(decoded.width, 1);
}

#[test]
fn genesis_game_genie_vector() {
    let decoded = decode("ABD5-78F7", CheatSystem::Genesis, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0xBE47BD);
    assert_eq!(decoded.value, 0x1F00);
    assert_eq!(decoded.width, 2);
}

#[test]
fn gameboy_game_genie_vector() {
    let decoded = decode("004-BCE-E66", CheatSystem::GameBoy, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0x14BC);
    assert_eq!(decoded.value, 0x00);
    assert_eq!(decoded.compare, Some(0x03));
    assert_eq!(decoded.width, 1);
}

#[test]
fn gameboy_six_digit_has_no_compare() {
    let decoded = decode("004-BCE", CheatSystem::GameBoy, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0x14BC);
    assert_eq!(decoded.value, 0x00);
    assert_eq!(decoded.compare, None);
}

#[test]
fn bad_code_is_rejected() {
    let err = decode("ZZZZZZ", CheatSystem::Snes, CheatKind::GameGenie).unwrap_err();
    assert_eq!(err_code(&err), "cheat_bad_code");
}

// --- Pro Action Replay / GameShark decode ----------------------------------

#[test]
fn nes_par_with_compare() {
    let decoded = decode("C00012FF", CheatSystem::Nes, CheatKind::ProActionReplay).unwrap();
    assert_eq!(decoded.address, 0xC000);
    assert_eq!(decoded.value, 0x12);
    assert_eq!(decoded.compare, Some(0xFF));
}

#[test]
fn gameboy_gameshark_little_endian_address() {
    // type=01, value=12, address bytes 34 56 (little-endian) -> 0x5634
    let decoded = decode("01123456", CheatSystem::GameBoy, CheatKind::ProActionReplay).unwrap();
    assert_eq!(decoded.value, 0x12);
    assert_eq!(decoded.address, 0x5634);
}

// --- kind inference --------------------------------------------------------

#[test]
fn auto_kind_inference() {
    assert_eq!(
        decode_auto("AKE-LVS", CheatSystem::Nes).unwrap().kind,
        CheatKind::GameGenie
    );
    assert_eq!(
        decode_auto("8000FF", CheatSystem::Nes).unwrap().kind,
        CheatKind::ProActionReplay
    );
}

// --- resolve_writes --------------------------------------------------------

#[test]
fn nes_no_compare_flat_offset() {
    let rom = vec![0u8; 0x4000];
    let layout = RomLayout::detect(&rom, CheatSystem::Nes);
    let decoded = decode("AKE-LVS", CheatSystem::Nes, CheatKind::GameGenie).unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    // window offset = (0xBD86 - 0x8000) % 0x4000 = 0x3D86
    assert_eq!(
        writes,
        vec![CheatWrite {
            offset: 0x3D86,
            value: 0x48,
            width: 1
        }]
    );
}

#[test]
fn nes_compare_scan_picks_matching_bank() {
    let mut rom = vec![0u8; 0x8000]; // two 16 KiB banks, no iNES header
    rom[0x4000] = 0xFF; // bank 1, window offset 0
    let layout = RomLayout::detect(&rom, CheatSystem::Nes);
    let decoded = decode("C00012FF", CheatSystem::Nes, CheatKind::ProActionReplay).unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    assert_eq!(
        writes,
        vec![CheatWrite {
            offset: 0x4000,
            value: 0x12,
            width: 1
        }]
    );
}

#[test]
fn nes_compare_no_match_errors() {
    let rom = vec![0u8; 0x8000];
    let layout = RomLayout::detect(&rom, CheatSystem::Nes);
    let decoded = decode("C00012FF", CheatSystem::Nes, CheatKind::ProActionReplay).unwrap();
    let err = resolve_writes(&rom, &layout, &decoded).unwrap_err();
    assert_eq!(err_code(&err), "cheat_no_compare_match");
}

#[test]
fn nes_ines_header_shifts_offset() {
    const INES_HEADER: usize = 16;
    let mut rom = vec![0u8; INES_HEADER + 0x4000];
    rom[..4].copy_from_slice(b"NES\x1A");
    rom[4] = 1; // 1 PRG bank
    let layout = RomLayout::detect(&rom, CheatSystem::Nes);
    let decoded = decode("AKE-LVS", CheatSystem::Nes, CheatKind::GameGenie).unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    assert_eq!(writes[0].offset, INES_HEADER + 0x3D86);
}

#[test]
fn par_ram_address_rejected() {
    let rom = vec![0u8; 0x8000];
    let layout = RomLayout::detect(&rom, CheatSystem::Nes);
    let decoded = decode("0010AB", CheatSystem::Nes, CheatKind::ProActionReplay).unwrap();
    let err = resolve_writes(&rom, &layout, &decoded).unwrap_err();
    assert_eq!(err_code(&err), "cheat_ram_address");
}

#[test]
fn genesis_flat_word_write() {
    let rom = vec![0u8; 0x200];
    let layout = RomLayout::detect(&rom, CheatSystem::Genesis);
    let decoded = decode(
        "0000FF:1234",
        CheatSystem::Genesis,
        CheatKind::ProActionReplay,
    )
    .unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    assert_eq!(
        writes,
        vec![CheatWrite {
            offset: 0xFF,
            value: 0x1234,
            width: 2
        }]
    );
}

#[test]
fn gameboy_bank0_compare() {
    let mut rom = vec![0u8; 0x4000];
    rom[0x14BC] = 0x03;
    let layout = RomLayout::detect(&rom, CheatSystem::GameBoy);
    let decoded = decode("004-BCE-E66", CheatSystem::GameBoy, CheatKind::GameGenie).unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    assert_eq!(
        writes,
        vec![CheatWrite {
            offset: 0x14BC,
            value: 0x00,
            width: 1
        }]
    );

    let clean = vec![0u8; 0x4000];
    let err = resolve_writes(&clean, &layout, &decoded).unwrap_err();
    assert_eq!(err_code(&err), "cheat_no_compare_match");
}

#[test]
fn gameboy_switchable_window_skips_bank0() {
    // "00000B000" -> address 0x4000 (switchable window, offset 0), value 0x00,
    // compare 0xBA. The compare byte matches only in fixed bank 0; bank 1 does
    // not. The switchable-window scan must start at bank 1, so no bank-0 write
    // is emitted and the match fails entirely.
    let decoded = decode("00000B000", CheatSystem::GameBoy, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0x4000);
    assert_eq!(decoded.compare, Some(0xBA));

    let mut rom = vec![0u8; 0x8000]; // two 16 KiB banks
    rom[0x0000] = 0xBA; // bank 0, window offset 0 -- coincidental compare match
    // bank 1 (offset 0x4000) stays 0x00, so it does not match.
    let layout = RomLayout::detect(&rom, CheatSystem::GameBoy);
    let err = resolve_writes(&rom, &layout, &decoded).unwrap_err();
    assert_eq!(err_code(&err), "cheat_no_compare_match");
}

// --- apply_writes ----------------------------------------------------------

#[test]
fn apply_writes_round_trip() {
    let mut rom = vec![0u8; 0x10];
    apply_writes(
        &mut rom,
        &[
            CheatWrite {
                offset: 0x02,
                value: 0xAB,
                width: 1,
            },
            CheatWrite {
                offset: 0x04,
                value: 0x1234,
                width: 2,
            },
        ],
    )
    .unwrap();
    assert_eq!(rom[0x02], 0xAB);
    assert_eq!(rom[0x04], 0x12); // big-endian word
    assert_eq!(rom[0x05], 0x34);
}

// --- layout edge cases -----------------------------------------------------

#[test]
fn nes_trainer_shifts_prg_offset() {
    // iNES header + 512-byte trainer (flags6 bit 2) + one 16 KiB PRG bank.
    let mut rom = vec![0u8; 16 + 512 + 0x4000];
    rom[..4].copy_from_slice(b"NES\x1A");
    rom[4] = 1; // 1 PRG bank
    rom[6] = 0x04; // trainer present
    let layout = RomLayout::detect(&rom, CheatSystem::Nes);
    let decoded = decode("AKE-LVS", CheatSystem::Nes, CheatKind::GameGenie).unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    // PRG starts after the 16-byte header AND the 512-byte trainer.
    assert_eq!(writes[0].offset, 16 + 512 + 0x3D86);
}

#[test]
fn snes_lorom_lower_half_address_rejected() {
    let rom = vec![0u8; 0x8000]; // no valid internal header -> LoROM fallback
    let layout = RomLayout::detect(&rom, CheatSystem::Snes);
    assert_eq!(layout.mapping, Mapping::SnesLoRom);
    // Bank 0xC0, low 0x0000: passes the WRAM/system-RAM checks but is not a
    // LoROM ROM byte (lower half), so it must be rejected, not folded.
    let decoded = DecodedCode {
        system: CheatSystem::Snes,
        kind: CheatKind::GameGenie,
        address: 0xC0_0000,
        value: 0x12,
        compare: None,
        width: 1,
    };
    let err = resolve_writes(&rom, &layout, &decoded).unwrap_err();
    assert_eq!(err_code(&err), "cheat_ram_address");
}

#[test]
fn snes_detects_hirom_via_internal_header() {
    let mut rom = vec![0u8; 0x10000];
    // Valid HiROM internal header at 0xFFC0: complement ^ checksum == 0xFFFF.
    rom[0xFFDC] = 0x34; // complement lo
    rom[0xFFDD] = 0x12; // complement hi -> 0x1234
    rom[0xFFDE] = 0xCB; // checksum lo
    rom[0xFFDF] = 0xED; // checksum hi -> 0xEDCB; 0x1234 ^ 0xEDCB == 0xFFFF
    let layout = RomLayout::detect(&rom, CheatSystem::Snes);
    assert_eq!(layout.mapping, Mapping::SnesHiRom);
    assert_eq!(layout.header_bytes, 0);
}

#[test]
fn split_codes_separates_joined_codes() {
    assert_eq!(
        split_codes("AKE-LVS + SXIOPO\nGOSSIP,YYYYYY"),
        vec!["AKE-LVS", "SXIOPO", "GOSSIP", "YYYYYY"]
    );
    assert_eq!(split_codes("  "), Vec::<&str>::new());
}
