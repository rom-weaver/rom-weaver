use super::pokemon_gen3::{Family, PokemonGen3Handler, SIGNATURE, checksum};
use crate::save::{
    SaveDetectionInput, SaveEdit, SaveGameHandler, SaveGameRegistry, SaveIntegrityState,
    SaveRecognitionOutcome, SaveValue,
};

const SECTION_SIZE: usize = 0x1000;
const SLOT_SIZE: usize = 0xE000;
const SECTION_DATA_SIZE: usize = 0xF80;

fn section_offset(slot: u8, id: u8) -> usize {
    usize::from(slot) * SLOT_SIZE + ((usize::from(id) + 1) % 14) * SECTION_SIZE
}

fn logical_offset(slot: u8, offset: usize) -> usize {
    section_offset(slot, (1 + offset / SECTION_DATA_SIZE) as u8) + offset % SECTION_DATA_SIZE
}

fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn refresh_checksums(bytes: &mut [u8], family: Family) {
    for slot in 0..2u8 {
        for id in 0..14u8 {
            let offset = section_offset(slot, id);
            let sum = checksum(&bytes[offset..offset + family.checksum_size(id)]);
            bytes[offset + 0xFF6..offset + 0xFF8].copy_from_slice(&sum.to_le_bytes());
        }
    }
}

fn fixture(family: Family, counter_a: u32, counter_b: u32) -> Vec<u8> {
    let mut bytes = vec![0u8; 0x20_000];
    for (slot, counter) in [(0u8, counter_a), (1, counter_b)] {
        for id in 0..14u8 {
            let offset = section_offset(slot, id);
            bytes[offset + 0xFF4..offset + 0xFF6].copy_from_slice(&u16::from(id).to_le_bytes());
            bytes[offset + 0xFF8..offset + 0xFFC].copy_from_slice(&SIGNATURE.to_le_bytes());
            bytes[offset + 0xFFC..offset + 0x1000].copy_from_slice(&counter.to_le_bytes());
        }

        let small = section_offset(slot, 0);
        bytes[small..small + 7].copy_from_slice(&[0xCC, 0xBF, 0xBE, 0xFF, 0xFF, 0xFF, 0xFF]);
        bytes[small + 10..small + 14].copy_from_slice(&[0x39, 0x30, 0x31, 0xD4]);
        bytes[small + 14..small + 19].copy_from_slice(&[32, 0, 14, 22, 3]);

        let key = match family {
            Family::Rs => 0,
            Family::Emerald => {
                put_u32(&mut bytes, small + 0xAC, 0x1234_5678);
                0x1234_5678
            }
            Family::Frlg => {
                put_u32(&mut bytes, small + 0xF20, 0x8765_4321);
                0x8765_4321
            }
        };
        let money_offset = if family == Family::Frlg { 0x290 } else { 0x490 };
        put_u32(&mut bytes, logical_offset(slot, money_offset), 5_000 ^ key);

        match family {
            Family::Rs => bytes[small + 0x900] = 0x41,
            Family::Emerald => bytes[section_offset(slot, 4) + 0xEF0] = 0x42,
            Family::Frlg => {
                bytes[small + 0xF28] = 0x43;
                bytes[section_offset(slot, 4) + 0xD00] = 0x44;
            }
        }
    }
    refresh_checksums(&mut bytes, family);
    bytes
}

fn input(bytes: Vec<u8>, game: Option<&str>) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: game.map(str::to_owned),
        rom_sha1: None,
    }
}

fn game(family: Family, id: &str) -> crate::save::SaveGameIdentity {
    family.identity(id)
}

fn value(document: &crate::save::SaveDocument, id: &str) -> SaveValue {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .unwrap()
        .value
        .clone()
}

fn error_code(error: crate::RomWeaverError) -> &'static str {
    match error {
        crate::RomWeaverError::ValidationCode(error) => error.code(),
        other => panic!("expected a coded validation error, got {other:?}"),
    }
}

#[test]
fn registry_lists_every_game_with_format_metadata() {
    let definitions = SaveGameRegistry::default().definitions();
    let ids = definitions
        .iter()
        .map(|definition| definition.identity.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "pokemon-gold",
            "pokemon-silver",
            "pokemon-crystal",
            "pokemon-ruby",
            "pokemon-sapphire",
            "pokemon-emerald",
            "pokemon-firered",
            "pokemon-leafgreen",
            "pokemon-heartgold",
            "pokemon-soulsilver",
            "zelda-a-link-to-the-past",
        ]
    );
    assert!(definitions[3..8].iter().all(|definition| {
        definition.platform == "gba"
            && definition.save_format == "gba_flash_128k"
            && definition.save_format_name == "Flash 128 KiB"
            && definition.supported_save_sizes == [131_072]
    }));
    assert!(definitions[..3].iter().all(|definition| {
        definition.platform == "game-boy-color"
            && definition.save_format == "game_boy_sram_32k"
            && definition.supported_save_sizes == [32_768]
    }));
    assert!(definitions[8..10].iter().all(|definition| {
        definition.platform == "nds"
            && definition.save_format == "nintendo_ds_512k"
            && definition.supported_save_sizes == [524_288]
    }));
    assert_eq!(definitions[10].platform, "snes");
    assert_eq!(definitions[10].save_format, "snes_sram_8k");
    assert_eq!(definitions[10].supported_save_sizes, [8_192]);
}

#[test]
fn registry_accepts_new_handlers_without_generic_dispatch_changes() {
    let registry = SaveGameRegistry::default().with_handler(PokemonGen3Handler);
    let recognition = registry.detect(&input(fixture(Family::Emerald, 7, 6), None));
    assert!(matches!(
        recognition.outcome,
        SaveRecognitionOutcome::Ambiguous { ref candidates } if candidates.len() == 2
    ));
}

#[test]
fn recognition_is_safe_for_wrong_sizes_and_shared_title_layouts() {
    for size in [4, 8_192, 32_768, 524_288] {
        assert!(matches!(
            SaveGameRegistry::default()
                .detect(&input(vec![0xA5; size], None))
                .outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
    }
    assert!(matches!(
        SaveGameRegistry::default()
            .detect(&input(fixture(Family::Rs, 7, 6), None))
            .outcome,
        SaveRecognitionOutcome::Ambiguous { ref candidates } if candidates.len() == 2
    ));
    assert!(matches!(
        SaveGameRegistry::default()
            .detect(&input(fixture(Family::Frlg, 7, 6), None))
            .outcome,
        SaveRecognitionOutcome::Ambiguous { ref candidates } if candidates.len() == 2
    ));
}

#[test]
fn emerald_is_recognized_from_its_valid_layout() {
    let recognition =
        SaveGameRegistry::default().detect(&input(fixture(Family::Emerald, 7, 6), None));
    assert!(matches!(
        recognition.outcome,
        SaveRecognitionOutcome::Recognized { ref candidate }
            if candidate.identity.id == "pokemon-emerald"
    ));
}

#[test]
fn manual_selection_keeps_the_exact_title_identity() {
    for (family, id, name) in [
        (Family::Rs, "pokemon-ruby", "Pokémon Ruby"),
        (Family::Rs, "pokemon-sapphire", "Pokémon Sapphire"),
        (Family::Frlg, "pokemon-firered", "Pokémon FireRed"),
        (Family::Frlg, "pokemon-leafgreen", "Pokémon LeafGreen"),
    ] {
        let recognition =
            SaveGameRegistry::default().detect(&input(fixture(family, 2, 1), Some(id)));
        assert!(matches!(
            recognition.outcome,
            SaveRecognitionOutcome::Recognized { ref candidate }
                if candidate.identity.id == id && candidate.identity.name == name
        ));
    }
}

#[test]
fn parser_reconstructs_sections_and_decodes_trainer_fields() {
    let input = input(fixture(Family::Emerald, 7, 6), Some("pokemon-emerald"));
    let document = PokemonGen3Handler
        .parse(&input, &game(Family::Emerald, "pokemon-emerald"))
        .unwrap();
    assert_eq!(document.active_slot, 0);
    assert_eq!(document.counter, 7);
    assert_eq!(document.sections.len(), 14);
    assert!(
        document.sections.iter().all(|section| {
            section.valid && section.checksum_expected == section.checksum_actual
        })
    );
    assert_eq!(
        value(&document, "trainer.name"),
        SaveValue::Text("RED".into())
    );
    assert_eq!(value(&document, "trainer.money"), SaveValue::U32(5_000));
    assert_eq!(value(&document, "trainer.id"), SaveValue::U32(12_345));
    assert_eq!(
        value(&document, "trainer.secret_id"),
        SaveValue::U32(54_321)
    );
    assert_eq!(
        value(&document, "trainer.play_time"),
        SaveValue::Text("32:14:22:03".into())
    );
}

#[test]
fn trainer_name_codec_accepts_every_english_keyboard_symbol() {
    let input = input(fixture(Family::Emerald, 7, 6), Some("pokemon-emerald"));
    let identity = game(Family::Emerald, "pokemon-emerald");
    let result = PokemonGen3Handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "trainer.name".into(),
                value: SaveValue::Text("A/B♂♀…".into()),
            }],
            false,
        )
        .unwrap();
    assert_eq!(
        value(&result.document, "trainer.name"),
        SaveValue::Text("A/B♂♀…".into())
    );
}

#[test]
fn active_slot_uses_wrapping_counters_and_rejects_ties() {
    let wrapped = input(
        fixture(Family::Emerald, 0, u32::MAX),
        Some("pokemon-emerald"),
    );
    let identity = game(Family::Emerald, "pokemon-emerald");
    assert_eq!(
        PokemonGen3Handler
            .parse(&wrapped, &identity)
            .unwrap()
            .active_slot,
        0
    );

    let wide_gap = input(
        fixture(Family::Emerald, 0x8000_0000, 0),
        Some("pokemon-emerald"),
    );
    assert_eq!(
        PokemonGen3Handler
            .parse(&wide_gap, &identity)
            .unwrap()
            .active_slot,
        0
    );

    let tied = input(fixture(Family::Emerald, 4, 4), Some("pokemon-emerald"));
    assert_eq!(
        error_code(PokemonGen3Handler.parse(&tied, &identity).unwrap_err()),
        "save_slot_counter"
    );
}

#[test]
fn multi_field_edit_reparses_and_preserves_the_backup_slot() {
    let bytes = fixture(Family::Emerald, 9, 8);
    let original = bytes.clone();
    let input = input(bytes, Some("pokemon-emerald"));
    let result = PokemonGen3Handler
        .apply(
            &input,
            &game(Family::Emerald, "pokemon-emerald"),
            &[
                SaveEdit {
                    field: "trainer.name".into(),
                    value: SaveValue::Text("ASH".into()),
                },
                SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(999_999),
                },
                SaveEdit {
                    field: "progress.badge_1".into(),
                    value: SaveValue::Bool(true),
                },
            ],
            false,
        )
        .unwrap();
    let output = result.bytes.unwrap();
    assert_eq!(
        value(&result.document, "trainer.name"),
        SaveValue::Text("ASH".into())
    );
    assert_eq!(
        value(&result.document, "trainer.money"),
        SaveValue::U32(999_999)
    );
    assert_eq!(
        value(&result.document, "progress.badge_1"),
        SaveValue::Bool(true)
    );
    assert_eq!(
        &output[SLOT_SIZE..2 * SLOT_SIZE],
        &original[SLOT_SIZE..2 * SLOT_SIZE]
    );
    assert_eq!(
        output[section_offset(0, 12) + 0x700],
        original[section_offset(0, 12) + 0x700]
    );
}

#[test]
fn encrypted_money_uses_each_family_key() {
    for (family, id, key, offset) in [
        (Family::Emerald, "pokemon-emerald", 0x1234_5678, 0x490),
        (Family::Frlg, "pokemon-firered", 0x8765_4321, 0x290),
    ] {
        let input = input(fixture(family, 3, 2), Some(id));
        let result = PokemonGen3Handler
            .apply(
                &input,
                &game(family, id),
                &[SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(42_000),
                }],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        let raw = logical_offset(0, offset);
        assert_eq!(
            u32::from_le_bytes(bytes[raw..raw + 4].try_into().unwrap()),
            42_000 ^ key
        );
    }
}

#[test]
fn dry_run_reparses_and_no_op_avoids_output() {
    let input = input(fixture(Family::Rs, 3, 2), Some("pokemon-ruby"));
    let identity = game(Family::Rs, "pokemon-ruby");
    let dry_run = PokemonGen3Handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "trainer.name".into(),
                value: SaveValue::Text("May".into()),
            }],
            true,
        )
        .unwrap();
    assert!(dry_run.bytes.is_none());
    assert!(dry_run.preview.output_valid);
    assert_eq!(
        value(&dry_run.document, "trainer.name"),
        SaveValue::Text("May".into())
    );

    let no_op = PokemonGen3Handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(5_000),
            }],
            false,
        )
        .unwrap();
    assert!(!no_op.preview.changed);
    assert!(!no_op.preview.integrity_recalculated);
    assert!(no_op.bytes.is_none());
}

#[test]
fn edit_validation_rejects_each_invalid_request() {
    let input = input(fixture(Family::Emerald, 3, 2), Some("pokemon-emerald"));
    let identity = game(Family::Emerald, "pokemon-emerald");
    let cases = [
        (
            SaveEdit {
                field: "missing".into(),
                value: SaveValue::Bool(true),
            },
            "save_field_unknown",
        ),
        (
            SaveEdit {
                field: "trainer.id".into(),
                value: SaveValue::U32(1),
            },
            "save_field_read_only",
        ),
        (
            SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(1_000_000),
            },
            "save_value_range",
        ),
        (
            SaveEdit {
                field: "trainer.name".into(),
                value: SaveValue::Text("TOO-LONG".into()),
            },
            "save_name_length",
        ),
        (
            SaveEdit {
                field: "trainer.name".into(),
                value: SaveValue::Text("ASH@".into()),
            },
            "save_text_codec",
        ),
        (
            SaveEdit {
                field: "trainer.gender".into(),
                value: SaveValue::Enum("other".into()),
            },
            "save_value_choice",
        ),
        (
            SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::Text("1".into()),
            },
            "save_value_kind",
        ),
    ];
    for (edit, code) in cases {
        let error = PokemonGen3Handler
            .apply(&input, &identity, &[edit], true)
            .unwrap_err();
        assert_eq!(error_code(error), code);
    }

    let duplicate = PokemonGen3Handler
        .apply(
            &input,
            &identity,
            &[
                SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(1),
                },
                SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(2),
                },
            ],
            true,
        )
        .unwrap_err();
    assert_eq!(error_code(duplicate), "save_edit_conflict");
}

#[test]
fn corrupt_slot_is_readable_but_not_editable() {
    let mut bytes = fixture(Family::Emerald, 5, 4);
    bytes[section_offset(1, 3) + 4] ^= 0xFF;
    let input = input(bytes, Some("pokemon-emerald"));
    let identity = game(Family::Emerald, "pokemon-emerald");
    let document = PokemonGen3Handler.parse(&input, &identity).unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::PartiallyRecoverable
    );
    let error = PokemonGen3Handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(1),
            }],
            false,
        )
        .unwrap_err();
    assert_eq!(error_code(error), "save_integrity_partial");
}

#[test]
fn empty_backup_slot_is_editable_and_stays_empty() {
    let mut bytes = fixture(Family::Emerald, 5, 4);
    bytes[SLOT_SIZE..2 * SLOT_SIZE].fill(0xFF);
    let original_backup = bytes[SLOT_SIZE..2 * SLOT_SIZE].to_vec();
    let input = input(bytes, Some("pokemon-emerald"));
    let identity = game(Family::Emerald, "pokemon-emerald");
    let document = PokemonGen3Handler.parse(&input, &identity).unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::ValidWithWarnings
    );
    assert!(document.fields.iter().any(|field| field.editable));

    let result = PokemonGen3Handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(9_000),
            }],
            false,
        )
        .unwrap();
    assert_eq!(
        &result.bytes.unwrap()[SLOT_SIZE..2 * SLOT_SIZE],
        original_backup.as_slice()
    );
}

#[test]
fn corrupt_or_missing_sections_in_both_slots_are_unsupported() {
    let mut corrupt = fixture(Family::Emerald, 5, 4);
    corrupt[section_offset(0, 3) + 4] ^= 0xFF;
    corrupt[section_offset(1, 3) + 4] ^= 0xFF;
    assert!(matches!(
        SaveGameRegistry::default()
            .detect(&input(corrupt, None))
            .outcome,
        SaveRecognitionOutcome::Unsupported { .. }
    ));

    let mut missing = fixture(Family::Emerald, 5, 4);
    for slot in 0..2u8 {
        let section = section_offset(slot, 13);
        missing[section + 0xFF4..section + 0xFF6].copy_from_slice(&12u16.to_le_bytes());
    }
    assert!(matches!(
        SaveGameRegistry::default()
            .detect(&input(missing, None))
            .outcome,
        SaveRecognitionOutcome::Unsupported { .. }
    ));
}

#[test]
fn field_schema_json_has_stable_generic_fields_without_offsets() {
    let input = input(fixture(Family::Emerald, 5, 4), Some("pokemon-emerald"));
    let document = PokemonGen3Handler
        .parse(&input, &game(Family::Emerald, "pokemon-emerald"))
        .unwrap();
    let json = serde_json::to_value(&document).unwrap();
    let money = json["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["id"] == "trainer.money")
        .unwrap();
    assert_eq!(money["kind"], "unsigned_integer");
    assert_eq!(money["constraints"]["max"], 999_999);
    assert!(money.get("offset").is_none());
}
