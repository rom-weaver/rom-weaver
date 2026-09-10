use super::*;
use rom_weaver_core::RomWeaverError;
use std::collections::BTreeMap;

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

#[test]
fn gba_xploder_ram_write_is_decoded_and_rejected_for_baking() {
    let decoded = decode(
        "32024542 00FF",
        CheatSystem::GameBoyAdvance,
        CheatKind::Xploder,
    )
    .unwrap();
    assert_eq!(decoded.address, 0x0202_4542);
    assert_eq!(decoded.value, 0xFF);
    assert_eq!(decoded.width, 1);

    let rom = vec![0u8; 0x100];
    let layout = RomLayout::detect(&rom, CheatSystem::GameBoyAdvance);
    let err = resolve_writes(&rom, &layout, &decoded).unwrap_err();
    assert_eq!(err_code(&err), "cheat_ram_address");
}

#[test]
fn gba_xploder_rom_patch_maps_halfword_offset() {
    let code = "00000000 18000004 0000ABCD 00000000";
    let decoded = decode(code, CheatSystem::GameBoyAdvance, CheatKind::Xploder).unwrap();
    assert_eq!(decoded.address, 0x0800_0008);
    assert_eq!(decoded.value, 0xABCD);
    assert_eq!(decoded.width, 2);

    let rom = vec![0u8; 0x20];
    let layout = RomLayout::detect(&rom, CheatSystem::GameBoyAdvance);
    assert_eq!(
        resolve_writes(&rom, &layout, &decoded).unwrap(),
        vec![CheatWrite {
            offset: 8,
            value: 0xABCD,
            width: 2,
        }]
    );
}

#[test]
fn playstation_xploder_writes_map_into_psx_exe_payload() {
    let mut rom = vec![0u8; 0x800 + 16];
    rom[..8].copy_from_slice(b"PS-X EXE");
    rom[0x18..0x1C].copy_from_slice(&0x8001_0000u32.to_le_bytes());
    rom[0x1C..0x20].copy_from_slice(&16u32.to_le_bytes());
    let layout = RomLayout::detect(&rom, CheatSystem::PlayStation);

    let byte = decode(
        "30010000 00FF",
        CheatSystem::PlayStation,
        CheatKind::Xploder,
    )
    .unwrap();
    assert_eq!(
        resolve_writes(&rom, &layout, &byte).unwrap(),
        vec![CheatWrite {
            offset: 0x800,
            value: 0xFF,
            width: 1,
        }]
    );

    let word = decode(
        "88010002 1234",
        CheatSystem::PlayStation,
        CheatKind::Xploder,
    )
    .unwrap();
    assert_eq!(
        resolve_writes(&rom, &layout, &word).unwrap(),
        vec![CheatWrite {
            offset: 0x802,
            value: 0x1234,
            width: 2,
        }]
    );

    let long = decode(
        "00010004 1234",
        CheatSystem::PlayStation,
        CheatKind::Xploder,
    )
    .unwrap();
    assert_eq!(long.width, 4);
    assert_eq!(long.value, 0x1234);
}

#[test]
fn xploder_split_keeps_words_and_gba_rom_patch_lines_together() {
    assert_eq!(
        split_xploder_codes("30010000 00FF + 88010002 1234"),
        vec!["3001000000FF", "880100021234"]
    );
    assert_eq!(
        split_xploder_codes("00000000 18000004 0000ABCD 00000000"),
        vec!["00000000180000040000ABCD00000000"]
    );
    assert_eq!(
        split_xploder_codes("00000000+18019F12+00002006+00000000"),
        vec!["0000000018019F120000200600000000"]
    );
    assert_eq!(
        split_xploder_codes("3200E924+0096+330034B8+0096"),
        vec!["3200E9240096", "330034B80096"]
    );
}

#[test]
fn plus_separated_gba_rom_patch_is_bakeable() {
    let mut entry = record(
        CheatSystem::GameBoyAdvance,
        "00000000+18000004+0000ABCD+00000000",
    );
    entry.code_kind = Some(CheatKind::Xploder);
    assert!(matches!(
        classify_record(&[0; 0x20], &entry).resolution,
        CheatResolution::RomBakeable { .. }
    ));
}

#[test]
fn gba_runtime_only_codes_are_unsupported() {
    for code in ["000084F5 000A", "100193C0 0007", "D0000000 0000"] {
        let mut entry = record(CheatSystem::GameBoyAdvance, code);
        entry.code_kind = Some(CheatKind::Xploder);
        let classified = classify_record(&vec![0; 0x100], &entry);
        assert!(
            matches!(classified.resolution, CheatResolution::Unsupported { .. }),
            "{code}: {:?}",
            classified.resolution
        );
    }
}

#[test]
fn gba_malformed_native_code_stays_unsupported() {
    let mut entry = record(CheatSystem::GameBoyAdvance, "not hex");
    entry.code_kind = Some(CheatKind::Xploder);
    assert!(matches!(
        classify_record(&vec![0; 0x100], &entry).resolution,
        CheatResolution::Unsupported { .. }
    ));
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

#[test]
fn colon_codes_never_decode_as_game_genie() {
    // `AAAAAA:VV` strips to eight hex digits, the Genesis Game Genie length.
    let genesis = decode_auto("E00000:AB", CheatSystem::Genesis).unwrap();
    assert_eq!(genesis.kind, CheatKind::ProActionReplay);
    assert_eq!(genesis.address, 0xE0_0000);
    let sega32x = decode_auto("FFB78E:0000", CheatSystem::Sega32x).unwrap();
    assert_eq!(sega32x.kind, CheatKind::ProActionReplay);
    // `AAAA:VV` strips to six hex digits, the Master System Game Genie length.
    for system in [
        CheatSystem::MasterSystem,
        CheatSystem::GameGear,
        CheatSystem::Sg1000,
    ] {
        let err = decode_auto("1234:56", system).unwrap_err();
        assert_eq!(err_code(&err), "cheat_ram_address");
        let record = record(system, "1234:56");
        let classified = classify_record(&vec![0u8; 0x20000], &record);
        assert!(
            matches!(classified.resolution, CheatResolution::Unsupported { .. }),
            "{:?}",
            classified.resolution
        );
    }
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
        CheatSystem::Genesis,
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

#[test]
fn apply_writes_uses_little_endian_for_xploder() {
    let mut rom = vec![0u8; 8];
    apply_writes(
        &mut rom,
        CheatSystem::GameBoyAdvance,
        &[
            CheatWrite {
                offset: 0,
                value: 0xABCD,
                width: 2,
            },
            CheatWrite {
                offset: 2,
                value: 0x1234_5678,
                width: 4,
            },
        ],
    )
    .unwrap();
    assert_eq!(&rom[..6], &[0xCD, 0xAB, 0x78, 0x56, 0x34, 0x12]);
}

fn record(system: CheatSystem, raw_code: &str) -> CheatRecord {
    CheatRecord {
        id: format!("test-{raw_code}"),
        system,
        game_id: "synthetic".to_string(),
        description: "Synthetic cheat".to_string(),
        raw_code: Some(raw_code.to_string()),
        code_kind: Some(CheatKind::ProActionReplay),
        raw_fields: BTreeMap::from([("code".to_string(), raw_code.to_string())]),
        source_file: "fixture.cht".to_string(),
        source_index: 0,
        source_revision: "test".to_string(),
    }
}

#[test]
fn classifies_runtime_addresses_for_each_family() {
    let cases = [
        (CheatSystem::Nes, "0010AB"),
        (CheatSystem::Snes, "7E1234FF"),
        (CheatSystem::Genesis, "E01234:ABCD"),
        (CheatSystem::GameBoy, "01FF00C0"),
        (CheatSystem::GameBoyColor, "01FF00C0"),
    ];
    for (system, code) in cases {
        let classified = classify_record(&vec![0; 0x10_0000], &record(system, code));
        assert_eq!(
            classified.resolution,
            CheatResolution::Unsupported {
                reason: "the code targets runtime memory".to_string()
            },
            "{system:?} {code}"
        );
    }
}

#[test]
fn classifies_all_rom_all_runtime_and_mixed_groups() {
    let rom = vec![0; 0x10000];
    let all_rom = classify_record(&rom, &record(CheatSystem::Nes, "8000AA+8001BB"));
    assert!(matches!(
        all_rom.resolution,
        CheatResolution::RomBakeable { .. }
    ));
    let all_runtime = classify_record(&rom, &record(CheatSystem::Nes, "0010AA+0020BB"));
    assert_eq!(
        all_runtime.resolution,
        CheatResolution::Unsupported {
            reason: "the code targets runtime memory".to_string()
        }
    );
    let mixed = classify_record(&rom, &record(CheatSystem::Nes, "8000AA+0010BB"));
    assert_eq!(
        mixed.resolution,
        CheatResolution::Unsupported {
            reason: "linked subcodes target runtime memory".to_string()
        }
    );
}

#[test]
fn parameterized_records_are_not_decoded() {
    for placeholder in ["7E1234??", "80309437 XXXX", "0010XX", "0010?"] {
        let classified =
            classify_record(&vec![0; 0x10000], &record(CheatSystem::Snes, placeholder));
        assert_eq!(
            classified.resolution,
            CheatResolution::Unsupported {
                reason: "the entry needs a parameter value".to_string()
            },
            "{placeholder}"
        );
    }
}

#[test]
fn parameter_detection_ignores_descriptions_and_checks_executable_fields() {
    let rom = vec![0; 0x10000];
    let mut concrete = record(CheatSystem::Nes, "8000AA");
    concrete.description = "Use XX lives".to_string();
    concrete
        .raw_fields
        .insert("desc".to_string(), "Use XX lives".to_string());
    assert!(matches!(
        classify_record(&rom, &concrete).resolution,
        CheatResolution::RomBakeable { .. }
    ));

    let mut parameterized = record(CheatSystem::Snes, "7E1234FF");
    parameterized
        .raw_fields
        .insert("value".to_string(), "XX".to_string());
    assert_eq!(
        classify_record(&rom, &parameterized).resolution,
        CheatResolution::Unsupported {
            reason: "the entry needs a parameter value".to_string()
        }
    );
}

#[test]
fn structured_and_conditional_records_are_unsupported() {
    let mut structured = record(CheatSystem::Snes, "7E1234FF");
    structured
        .raw_fields
        .insert("handler".to_string(), "1".to_string());
    structured
        .raw_fields
        .insert("condition_value".to_string(), "12".to_string());
    let classified = classify_record(&vec![0; 0x10000], &structured);
    assert_eq!(
        classified.resolution,
        CheatResolution::Unsupported {
            reason: "the entry is a structured runtime memory entry".to_string()
        }
    );
}

#[test]
fn snes_ambiguous_code_needs_a_device_hint() {
    let rom = vec![0; 0x40_0000];
    let runtime = {
        let mut entry = record(CheatSystem::Snes, "7E1234FF");
        entry.code_kind = None;
        entry
    };
    assert_eq!(
        classify_record(&rom, &runtime).resolution,
        CheatResolution::Unsupported {
            reason: "the code targets runtime memory".to_string()
        }
    );

    let mut ambiguous = record(CheatSystem::Snes, "ABCDEFFF");
    ambiguous.code_kind = None;
    let classified = classify_record(&rom, &ambiguous);
    assert!(matches!(
        classified.resolution,
        CheatResolution::Unsupported { .. }
    ));

    ambiguous.source_file = "Test (Action Replay).cht".to_string();
    let hinted = classify_record(&rom, &ambiguous);
    assert!(matches!(
        hinted.resolution,
        CheatResolution::RomBakeable { .. }
    ));
    assert_eq!(hinted.detected_kind, Some(CheatKind::ProActionReplay));
}

#[test]
fn dashed_snes_code_is_detected_as_game_genie_without_a_hint() {
    let mut entry = record(CheatSystem::Snes, "C24F-74D4");
    entry.code_kind = None;

    let classified = classify_record(&vec![0; 0x40_0000], &entry);

    assert_eq!(
        classified.resolution,
        CheatResolution::Unsupported {
            reason: "the code targets runtime memory".to_string()
        }
    );
    assert_eq!(classified.detected_kind, Some(CheatKind::GameGenie));
}

#[test]
fn conflict_detection_reports_different_values_only() {
    let entries = vec![
        (
            "first".to_string(),
            CheatSystem::Genesis,
            vec![CheatWrite {
                offset: 10,
                value: 0x1234,
                width: 2,
            }],
        ),
        (
            "same".to_string(),
            CheatSystem::Genesis,
            vec![CheatWrite {
                offset: 10,
                value: 0x12,
                width: 1,
            }],
        ),
        (
            "conflict".to_string(),
            CheatSystem::Genesis,
            vec![CheatWrite {
                offset: 11,
                value: 0xff,
                width: 1,
            }],
        ),
    ];
    assert_eq!(
        detect_write_conflicts(&entries),
        vec![CheatWriteConflict {
            first_id: "first".to_string(),
            second_id: "conflict".to_string(),
            offset: 11,
            first_value: 0x34,
            second_value: 0xff,
        }]
    );
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

// --- Sega 8-bit ------------------------------------------------------------
//
// The expected values below are derived from the Genesis Plus GX decode
// formulas (`libretro/libretro.c`, `decode_cheat`), not copied from a
// published code list.

#[test]
fn sega8_game_genie_vector() {
    let decoded = decode("11A-C3B", CheatSystem::MasterSystem, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0x4AC3);
    assert_eq!(decoded.value, 0x11);
    assert_eq!(decoded.compare, None);
    assert_eq!(decoded.width, 1);
}

#[test]
fn sega8_game_genie_compare_vector() {
    let decoded = decode("11A-C3B-0A7", CheatSystem::GameGear, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0x4AC3);
    assert_eq!(decoded.value, 0x11);
    // Digit 8 is a check digit; compare = rotate_right(0x07, 2) ^ 0xBA.
    assert_eq!(decoded.compare, Some(0x7B));
}

#[test]
fn sega8_action_replay_vector() {
    let decoded = decode(
        "0012-34FF",
        CheatSystem::MasterSystem,
        CheatKind::ProActionReplay,
    )
    .unwrap();
    assert_eq!(decoded.address, 0x1234);
    assert_eq!(decoded.value, 0xFF);
    assert_eq!(decoded.width, 1);
}

#[test]
fn sega8_infers_the_kind_from_the_code_shape() {
    let mut par = record(CheatSystem::MasterSystem, "0012-34FF");
    par.code_kind = None;
    par.raw_fields.clear();
    assert_eq!(
        classify_record(&vec![0; 0x8000], &par).detected_kind,
        Some(CheatKind::ProActionReplay)
    );

    let mut genie = record(CheatSystem::MasterSystem, "11A-C3B");
    genie.code_kind = None;
    genie.raw_fields.clear();
    assert_eq!(
        classify_record(&vec![0; 0x8000], &genie).detected_kind,
        Some(CheatKind::GameGenie)
    );
}

#[test]
fn sega8_runtime_address_is_unsupported() {
    let mut entry = record(CheatSystem::MasterSystem, "00C0-12AB");
    entry.raw_fields.clear();
    assert_eq!(
        classify_record(&vec![0; 0x8000], &entry).resolution,
        CheatResolution::Unsupported {
            reason: "the code targets runtime memory".to_string()
        }
    );
}

#[test]
fn sega8_copier_header_shifts_the_offset() {
    let rom = vec![0u8; 512 + 0x8000];
    let layout = RomLayout::detect(&rom, CheatSystem::MasterSystem);
    assert_eq!(layout.header_bytes, 512);
    let decoded = decode("11A-C3B", CheatSystem::MasterSystem, CheatKind::GameGenie).unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    assert_eq!(writes[0].offset, 512 + 0x4AC3);
}

#[test]
fn sega8_compare_byte_scans_every_bank() {
    // Slot offset 0x0AC3 of banks 1 and 3 carry the compare byte, so both are
    // candidates; bank 0 is scanned too and is excluded only by its byte.
    let mut rom = vec![0u8; 0x10000];
    rom[0x4000 + 0x0AC3] = 0x7B;
    rom[0xC000 + 0x0AC3] = 0x7B;
    let layout = RomLayout::detect(&rom, CheatSystem::MasterSystem);
    let decoded = decode(
        "11A-C3B-0A7",
        CheatSystem::MasterSystem,
        CheatKind::GameGenie,
    )
    .unwrap();
    let writes = resolve_writes(&rom, &layout, &decoded).unwrap();
    assert_eq!(
        writes.iter().map(|write| write.offset).collect::<Vec<_>>(),
        vec![0x4AC3, 0xCAC3]
    );
}

#[test]
fn sega32x_uses_the_genesis_decoders_and_layout() {
    let decoded = decode("ABD5-78F7", CheatSystem::Sega32x, CheatKind::GameGenie).unwrap();
    assert_eq!(decoded.address, 0xBE47BD);
    assert_eq!(decoded.value, 0x1F00);
    assert_eq!(decoded.width, 2);

    let mut rom = vec![0u8; 0x20];
    apply_writes(
        &mut rom,
        CheatSystem::Sega32x,
        &[CheatWrite {
            offset: 0,
            value: 0xABCD,
            width: 2,
        }],
    )
    .unwrap();
    assert_eq!(&rom[..2], &[0xAB, 0xCD]);
}

#[test]
fn cheat_system_serde_names_match_the_database_shards() {
    let expected = [
        (CheatSystem::Nes, "nes"),
        (CheatSystem::Snes, "snes"),
        (CheatSystem::Genesis, "genesis"),
        (CheatSystem::GameBoy, "gameboy"),
        (CheatSystem::GameBoyColor, "gameboy-color"),
        (CheatSystem::GameBoyAdvance, "gameboyadvance"),
        (CheatSystem::PlayStation, "playstation"),
        (CheatSystem::MasterSystem, "mastersystem"),
        (CheatSystem::GameGear, "gamegear"),
        (CheatSystem::Sega32x, "sega32x"),
        (CheatSystem::Sg1000, "sg1000"),
    ];
    for (system, name) in expected {
        assert_eq!(
            serde_json::to_string(&system).unwrap(),
            format!("\"{name}\"")
        );
        assert_eq!(
            serde_json::from_str::<CheatSystem>(&format!("\"{name}\"")).unwrap(),
            system
        );
        assert_eq!(CheatSystem::parse(system.id()), Some(system));
    }
}

#[test]
fn conflict_detection_uses_the_system_byte_order() {
    // GBA writes little-endian, so 0x9934 puts 0x34 - not 0x99 - on offset
    // 0x100, where the byte-write of 0x99 lands.
    let entries = vec![
        (
            "word".to_string(),
            CheatSystem::GameBoyAdvance,
            vec![CheatWrite {
                offset: 0x100,
                value: 0x9934,
                width: 2,
            }],
        ),
        (
            "byte".to_string(),
            CheatSystem::GameBoyAdvance,
            vec![CheatWrite {
                offset: 0x100,
                value: 0x99,
                width: 1,
            }],
        ),
    ];
    assert_eq!(
        detect_write_conflicts(&entries),
        vec![CheatWriteConflict {
            first_id: "word".to_string(),
            second_id: "byte".to_string(),
            offset: 0x100,
            first_value: 0x34,
            second_value: 0x99,
        }]
    );
}

#[test]
fn conflict_detection_covers_four_byte_writes() {
    let entries = vec![
        (
            "first".to_string(),
            CheatSystem::PlayStation,
            vec![CheatWrite {
                offset: 0x200,
                value: 0x1111_1111,
                width: 4,
            }],
        ),
        (
            "second".to_string(),
            CheatSystem::PlayStation,
            vec![CheatWrite {
                offset: 0x202,
                value: 0x2222_2222,
                width: 4,
            }],
        ),
    ];
    let conflicts = detect_write_conflicts(&entries);
    assert_eq!(
        conflicts
            .iter()
            .map(|conflict| conflict.offset)
            .collect::<Vec<_>>(),
        vec![0x202, 0x203]
    );
}

#[test]
fn apply_writes_and_conflict_detection_agree_on_the_bytes() {
    // Both paths route through `write_bytes`, so a write that conflict
    // detection reads as byte N is the byte `apply_writes` puts at offset N.
    for system in [CheatSystem::GameBoyAdvance, CheatSystem::Genesis] {
        let write = CheatWrite {
            offset: 4,
            value: 0xABCD,
            width: 2,
        };
        let mut rom = vec![0u8; 8];
        apply_writes(&mut rom, system, &[write]).unwrap();
        assert_eq!(&rom[4..6], write_bytes(&write, system).unwrap().as_slice());
    }
}
