use super::pokemon_gen3::{Family, SIGNATURE, checksum};
use crate::save::{
    SaveDetectionInput, SaveEdit, SaveGameRegistry, SaveIntegrityState, SaveRecognitionOutcome,
    SaveValue,
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

pub(super) fn fixture(family: Family, counter_a: u32, counter_b: u32) -> Vec<u8> {
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
        let coins_offset = logical_offset(slot, money_offset + 4);
        bytes[coins_offset..coins_offset + 2].copy_from_slice(&(100u16 ^ key as u16).to_le_bytes());

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

fn error_code(error: crate::RomWeaverError) -> String {
    match error {
        crate::RomWeaverError::ValidationCode(error) => error.code().to_owned(),
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
            "pokemon-diamond",
            "pokemon-pearl",
            "pokemon-platinum",
            "pokemon-heartgold",
            "pokemon-soulsilver",
            "zelda-a-link-to-the-past",
            "pokemon-red",
            "pokemon-blue",
            "pokemon-yellow",
            "pokemon-black",
            "pokemon-white",
            "pokemon-black-2",
            "pokemon-white-2",
            "super-mario-world",
            "donkey-kong-country-2-diddy-s-kong-quest-slot-1",
            "donkey-kong-country-2-diddy-s-kong-quest-slot-2",
            "donkey-kong-country-2-diddy-s-kong-quest-slot-3",
            "donkey-kong-country-3-dixie-kong-s-double-trouble-slot-1",
            "donkey-kong-country-3-dixie-kong-s-double-trouble-slot-2",
            "donkey-kong-country-3-dixie-kong-s-double-trouble-slot-3",
            "donkey-kong-country-slot-1-player-1",
            "donkey-kong-country-slot-1-player-2",
            "donkey-kong-country-slot-2-player-1",
            "donkey-kong-country-slot-2-player-2",
            "donkey-kong-country-slot-3-player-1",
            "donkey-kong-country-slot-3-player-2",
            "final-fantasy-nes",
            "mario-party-2-canonical-eeprom",
            "mario-party-canonical-eeprom",
            "pokemon-red-schema",
            "pokemon-blue-schema",
            "pokemon-yellow-schema",
            "pokemon-gold-schema",
            "pokemon-silver-schema",
            "pokemon-crystal-schema",
            "secret-of-mana-slot-1",
            "secret-of-mana-slot-2",
            "secret-of-mana-slot-3",
            "secret-of-mana-slot-4",
            "solatorobo-red-the-hunter-desmume",
            "super-mario-64-canonical-eeprom-mario-a",
            "super-mario-64-canonical-eeprom-mario-b",
            "super-mario-64-canonical-eeprom-mario-c",
            "super-mario-64-canonical-eeprom-mario-d",
            "super-mario-kart-schema",
            "super-mario-rpg-slot-1",
            "super-mario-rpg-slot-2",
            "super-mario-rpg-slot-3",
            "super-mario-rpg-slot-4",
            "super-mario-world-schema",
            "super-mario-world-file-2-schema",
            "super-mario-world-file-3-schema",
            "super-metroid-samus-a",
            "super-metroid-samus-b",
            "super-metroid-samus-c",
            "super-metroid-samus-a-supermetroid",
            "super-metroid-samus-b-supermetroid",
            "super-metroid-samus-c-supermetroid",
            "wario-land-super-mario-land-3",
            "zelda-a-link-to-the-past-file-1-schema",
            "zelda-a-link-to-the-past-file-2-schema",
            "zelda-a-link-to-the-past-file-3-schema",
            "kirbys-adventure-europe-usa-rev1-france-germany-slot-1",
            "kirbys-adventure-europe-usa-rev1-france-germany-slot-2",
            "kirbys-adventure-europe-usa-rev1-france-germany-slot-3",
            "kirbys-adventure-usa-japan-slot-1",
            "kirbys-adventure-usa-japan-slot-2",
            "kirbys-adventure-usa-japan-slot-3",
            "kirbys-adventure-canada-slot-1",
            "kirbys-adventure-canada-slot-2",
            "kirbys-adventure-canada-slot-3",
            "f-zero",
            "game-and-watch-gallery-3",
            "final-fight-one",
            "super-street-fighter-ii-turbo-revival",
            "f-zero-x",
            "diddy-kong-racing",
            "lylat-wars",
            "mission-impossible",
            "final-fantasy-vi-slot-1",
            "final-fantasy-vi-slot-2",
            "final-fantasy-vi-slot-3",
            "mystic-quest-legend-slot-1",
            "mystic-quest-legend-slot-2",
            "mystic-quest-legend-slot-3",
            "donkey-kong-land",
            "f-zero-maximum-velocity",
            "pokemon-trading-card-game",
            "wario-land-3",
            "zelda-oracle-of-ages-slot-1",
            "zelda-oracle-of-ages-slot-2",
            "zelda-oracle-of-ages-slot-3",
            "zelda-oracle-of-seasons-slot-1",
            "zelda-oracle-of-seasons-slot-2",
            "zelda-oracle-of-seasons-slot-3",
            "mario-kart-64",
            "actraiser-europe",
            "actraiser-usa",
            "actraiser-japan",
            "chrono-trigger-slot-1",
            "chrono-trigger-slot-2",
            "chrono-trigger-slot-3",
            "super-punch-out-slot-1",
            "super-punch-out-slot-2",
            "super-punch-out-slot-3",
            "super-punch-out-slot-4",
            "super-punch-out-slot-5",
            "super-punch-out-slot-6",
            "super-punch-out-slot-7",
            "super-punch-out-slot-8",
            "sonic-3-604",
            "sonic-3-980",
            "sonic-3-65536",
            "shining-force-16381",
            "shining-force-16382",
            "shining-force-65536",
            "soleil-512",
            "soleil-4608",
            "soleil-8704",
            "soleil-12800",
            "soleil-65536",
            "castlevania-aria-of-sorrow",
            "castlevania-circle-of-the-moon",
            "1080-snowboarding",
            "yoshis-story-canonical-eeprom-europe",
            "yoshis-story-canonical-eeprom-usa",
            "yoshis-story-canonical-eeprom-japan",
            "wario-land-ii",
            "zelda-links-awakening-gb-international",
            "zelda-links-awakening-gb-japan-alternate",
            "zelda-links-awakening-gbc-international",
            "zelda-links-awakening-gbc-japan-alternate",
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
    assert!(definitions[8..13].iter().all(|definition| {
        definition.platform == "nds"
            && definition.save_format == "nintendo_ds_512k"
            && definition.supported_save_sizes == [524_288]
    }));
    assert_eq!(definitions[13].platform, "snes");
    assert_eq!(definitions[13].save_format, "snes_sram_8k");
    assert_eq!(definitions[13].supported_save_sizes, [8_192]);
    assert!(definitions[14..17].iter().all(|definition| {
        definition.platform == "game-boy"
            && definition.save_format == "game_boy_sram_32k"
            && definition.supported_save_sizes == [32_768]
    }));
}

#[test]
fn registry_requires_a_game_made_template_for_pokemon_creation() {
    let registry = SaveGameRegistry::default();
    let fresh_ids = registry
        .generation_definitions()
        .into_iter()
        .map(|definition| definition.identity.id)
        .collect::<Vec<_>>();
    assert_eq!(
        fresh_ids,
        [
            "zelda-a-link-to-the-past",
            "super-mario-world",
            "super-mario-world-schema",
            "zelda-a-link-to-the-past-file-1-schema"
        ]
    );
    assert_eq!(
        error_code(registry.generate("pokemon-emerald").unwrap_err()),
        "save_generation_unsupported"
    );
}

#[test]
fn registry_accepts_new_handlers_without_generic_dispatch_changes() {
    let registry = SaveGameRegistry::default().with_handler(
        super::schema::catalog::builtin_pokemon_gen3::schemas()
            .into_iter()
            .find(|handler| handler.definitions()[0].identity.id == "pokemon-emerald")
            .unwrap(),
    );
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
    let document = SaveGameRegistry::default()
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
    let result = SaveGameRegistry::default()
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
        SaveGameRegistry::default()
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
        SaveGameRegistry::default()
            .parse(&wide_gap, &identity)
            .unwrap()
            .active_slot,
        0
    );

    let tied = input(fixture(Family::Emerald, 4, 4), Some("pokemon-emerald"));
    assert_eq!(
        error_code(
            SaveGameRegistry::default()
                .parse(&tied, &identity)
                .unwrap_err()
        ),
        "save_slot_counter"
    );
}

#[test]
fn multi_field_edit_reparses_and_preserves_the_backup_slot() {
    let bytes = fixture(Family::Emerald, 9, 8);
    let original = bytes.clone();
    let input = input(bytes, Some("pokemon-emerald"));
    let result = SaveGameRegistry::default()
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
        let result = SaveGameRegistry::default()
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
    let dry_run = SaveGameRegistry::default()
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

    let no_op = SaveGameRegistry::default()
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
                field: "trainer.security_key".into(),
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
        let error = SaveGameRegistry::default()
            .apply(&input, &identity, &[edit], true)
            .unwrap_err();
        assert_eq!(error_code(error), code);
    }

    let duplicate = SaveGameRegistry::default()
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
    let document = SaveGameRegistry::default()
        .parse(&input, &identity)
        .unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::PartiallyRecoverable
    );
    let error = SaveGameRegistry::default()
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
    let document = SaveGameRegistry::default()
        .parse(&input, &identity)
        .unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::ValidWithWarnings
    );
    assert!(document.fields.iter().any(|field| field.editable));

    let result = SaveGameRegistry::default()
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
fn section_ids_with_high_bytes_cannot_alias_valid_sections() {
    let identity = game(Family::Emerald, "pokemon-emerald");
    for id in [0, 13] {
        for high_byte in [1, 255] {
            let mut bytes = fixture(Family::Emerald, 5, 4);
            bytes[section_offset(0, id) + 0xFF5] = high_byte;
            let source = input(bytes.clone(), Some(&identity.id));
            let document = SaveGameRegistry::default()
                .parse(&source, &identity)
                .unwrap();
            assert_eq!(document.active_slot, 1);
            assert_eq!(document.counter, 4);
            assert_eq!(
                document.integrity.state,
                SaveIntegrityState::PartiallyRecoverable
            );
            let edit = [SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(1),
            }];
            assert_eq!(
                error_code(
                    SaveGameRegistry::default()
                        .apply(&source, &identity, &edit, false)
                        .unwrap_err()
                ),
                "save_integrity_partial"
            );

            bytes[section_offset(1, id) + 0xFF5] = high_byte;
            let source = input(bytes, Some(&identity.id));
            assert!(matches!(
                SaveGameRegistry::default().detect(&source).outcome,
                SaveRecognitionOutcome::Unsupported { .. }
            ));
            assert!(
                SaveGameRegistry::default()
                    .parse(&source, &identity)
                    .is_err()
            );
            assert!(
                SaveGameRegistry::default()
                    .apply(&source, &identity, &edit, false)
                    .is_err()
            );
        }
    }
}

#[test]
fn field_schema_json_has_stable_generic_fields_without_offsets() {
    let input = input(fixture(Family::Emerald, 5, 4), Some("pokemon-emerald"));
    let document = SaveGameRegistry::default()
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

fn shark_port_fixture(save: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&13u32.to_le_bytes());
    bytes.extend_from_slice(b"SharkPortSave");
    bytes.extend_from_slice(&0x000f_0000u32.to_le_bytes());
    for text in ["POKEMON EMER", "2026-08-27", "notes"] {
        bytes.extend_from_slice(&(text.len() as u32).to_le_bytes());
        bytes.extend_from_slice(text.as_bytes());
    }
    let mut payload = vec![0u8; 0x1c];
    payload[..12].copy_from_slice(b"POKEMON EMER");
    payload[0x14] = 1;
    payload.extend_from_slice(save);
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    let crc = crate::save::container::shark_port_checksum(&payload);
    bytes.extend_from_slice(&payload);
    bytes.extend_from_slice(&crc.to_le_bytes());
    bytes
}

fn gsv_fixture(save: &[u8]) -> Vec<u8> {
    assert_eq!(save.len(), 0x20_000);
    let mut bytes = vec![0u8; 0x430];
    bytes[0x0c..0x18].copy_from_slice(b"POKEMON EMER");
    bytes[0x42c..0x430].copy_from_slice(b"xV4\x12");
    bytes.extend_from_slice(save);
    bytes
}

#[test]
fn shark_port_checksum_sign_extends_high_bytes_like_vba() {
    // 0x80 sign-extends to 0xffffff80 before the first shift (crc % 24 == 0).
    assert_eq!(
        crate::save::container::shark_port_checksum(&[0x80]),
        0xffff_ff80
    );
    assert_eq!(
        crate::save::container::shark_port_checksum(&[0x01, 0x02]),
        {
            let crc = 1u32;
            crc.wrapping_add(2u32.wrapping_shl(crc % 0x18))
        }
    );
}

#[test]
fn shark_port_save_is_recognized_and_parsed_with_a_wrapper_warning() {
    let wrapped = shark_port_fixture(&fixture(Family::Emerald, 5, 4));
    let registry = SaveGameRegistry::default();
    let recognition = registry.detect(&input(wrapped.clone(), None));
    assert!(matches!(
        recognition.outcome,
        SaveRecognitionOutcome::Recognized { .. }
    ));
    let document = registry
        .parse(
            &input(wrapped, Some("pokemon-emerald")),
            &game(Family::Emerald, "pokemon-emerald"),
        )
        .unwrap();
    assert_eq!(document.save_size, 0x20_000);
    assert!(
        document
            .warnings
            .iter()
            .any(|warning| warning.contains("SharkPortSave"))
    );
}

#[test]
fn shark_port_edit_round_trips_and_updates_only_the_save_and_checksum() {
    let raw = fixture(Family::Emerald, 5, 4);
    let wrapped = shark_port_fixture(&raw);
    let registry = SaveGameRegistry::default();
    let identity = game(Family::Emerald, "pokemon-emerald");
    let result = registry
        .apply(
            &input(wrapped.clone(), Some("pokemon-emerald")),
            &identity,
            &[SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(777),
            }],
            false,
        )
        .unwrap();
    let output = result.bytes.unwrap();
    assert_eq!(output.len(), wrapped.len());
    // Every byte before the payload (magic, version, strings, game info)
    // survives verbatim.
    let payload_start = wrapped.len() - 4 - 0x20_000 - 0x1c;
    assert_eq!(
        output[..payload_start + 0x1c],
        wrapped[..payload_start + 0x1c]
    );
    assert_ne!(
        output[payload_start + 0x1c..],
        wrapped[payload_start + 0x1c..]
    );
    let stored = u32::from_le_bytes(output[output.len() - 4..].try_into().unwrap());
    let computed =
        crate::save::container::shark_port_checksum(&output[payload_start..output.len() - 4]);
    assert_eq!(stored, computed);
    // The edited wrapper reparses through the same path.
    let document = registry
        .parse(&input(output, Some("pokemon-emerald")), &identity)
        .unwrap();
    assert_eq!(value(&document, "trainer.money"), SaveValue::U32(777));
    assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
}

#[test]
fn shark_port_checksum_mismatch_warns_but_still_parses() {
    let mut wrapped = shark_port_fixture(&fixture(Family::Emerald, 5, 4));
    let end = wrapped.len();
    wrapped[end - 1] ^= 0xff;
    let document = SaveGameRegistry::default()
        .parse(
            &input(wrapped, Some("pokemon-emerald")),
            &game(Family::Emerald, "pokemon-emerald"),
        )
        .unwrap();
    assert!(
        document
            .warnings
            .iter()
            .any(|warning| warning.contains("checksum does not match"))
    );
}

#[test]
fn truncated_shark_port_wrapper_stays_unsupported() {
    let mut wrapped = shark_port_fixture(&fixture(Family::Emerald, 5, 4));
    wrapped.truncate(0x40);
    let recognition = SaveGameRegistry::default().detect(&input(wrapped, None));
    assert!(matches!(
        recognition.outcome,
        SaveRecognitionOutcome::Unsupported { .. }
    ));
}

#[test]
fn gsv_snapshot_is_recognized_and_round_trips_its_header() {
    let raw = fixture(Family::Emerald, 5, 4);
    let wrapped = gsv_fixture(&raw);
    let registry = SaveGameRegistry::default();
    let recognition = registry.detect(&input(wrapped.clone(), None));
    assert!(matches!(
        recognition.outcome,
        SaveRecognitionOutcome::Recognized { .. }
    ));
    let identity = game(Family::Emerald, "pokemon-emerald");
    let result = registry
        .apply(
            &input(wrapped.clone(), Some("pokemon-emerald")),
            &identity,
            &[SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(4242),
            }],
            false,
        )
        .unwrap();
    let output = result.bytes.unwrap();
    assert_eq!(output[..0x430], wrapped[..0x430]);
    let document = registry
        .parse(&input(output, Some("pokemon-emerald")), &identity)
        .unwrap();
    assert_eq!(value(&document, "trainer.money"), SaveValue::U32(4242));
    assert!(
        document
            .warnings
            .iter()
            .any(|warning| warning.contains("GameShark SP snapshot"))
    );
}

#[test]
fn gen3_inventory_can_fill_clear_and_replace_every_pocket_slot() {
    for family in [Family::Rs, Family::Emerald, Family::Frlg] {
        let identity = family.identity(match family {
            Family::Rs => "pokemon-ruby",
            Family::Emerald => "pokemon-emerald",
            Family::Frlg => "pokemon-firered",
        });
        let source = input(fixture(family, 2, 3), Some(&identity.id));
        let document = SaveGameRegistry::default()
            .parse(&source, &identity)
            .unwrap();
        let item_fields = document
            .fields
            .iter()
            .filter(|field| field.id.ends_with(".item_id"))
            .collect::<Vec<_>>();
        assert_eq!(
            item_fields.len(),
            match family {
                Family::Rs => 216,
                Family::Emerald => 236,
                Family::Frlg => 216,
            }
        );
        let mut edits = Vec::new();
        for field in item_fields {
            let quantity = field.id.replace(".item_id", ".quantity");
            let max = document
                .fields
                .iter()
                .find(|field| field.id == quantity)
                .unwrap()
                .constraints
                .max
                .unwrap();
            edits.push(SaveEdit {
                field: field.id.clone(),
                value: SaveValue::U32(1),
            });
            edits.push(SaveEdit {
                field: quantity,
                value: SaveValue::U32(max as u32),
            });
        }
        edits.push(SaveEdit {
            field: "trainer.id".into(),
            value: SaveValue::U32(65535),
        });
        edits.push(SaveEdit {
            field: "trainer.secret_id".into(),
            value: SaveValue::U32(0),
        });
        edits.push(SaveEdit {
            field: "trainer.play_time_frames".into(),
            value: SaveValue::U32(59),
        });
        let result = SaveGameRegistry::default()
            .apply(&source, &identity, &edits, false)
            .unwrap();
        for edit in &edits {
            assert_eq!(value(&result.document, &edit.field), edit.value);
        }
        let output = result.bytes.unwrap();
        assert_eq!(&output[..SLOT_SIZE], &source.bytes[..SLOT_SIZE]);
        assert_eq!(&output[2 * SLOT_SIZE..], &source.bytes[2 * SLOT_SIZE..]);
        let active = result.document.active_slot;
        let section = result
            .document
            .sections
            .iter()
            .find(|section| section.id == 1)
            .unwrap()
            .physical_offset as usize;
        let pc = if family == Family::Frlg { 0x298 } else { 0x498 };
        assert_eq!(
            &output[section + pc + 2..section + pc + 4],
            &999u16.to_le_bytes()
        );
        assert_eq!(active, 1);
        let filled = input(output, Some(&identity.id));
        let clear = edits
            .iter()
            .filter(|edit| edit.field.starts_with("inventory."))
            .map(|edit| SaveEdit {
                field: edit.field.clone(),
                value: SaveValue::U32(0),
            })
            .collect::<Vec<_>>();
        let cleared = SaveGameRegistry::default()
            .apply(&filled, &identity, &clear, false)
            .unwrap();
        assert!(
            cleared
                .document
                .fields
                .iter()
                .filter(|field| field.id.starts_with("inventory."))
                .all(|field| field.value == SaveValue::U32(0))
        );
        for (field, value) in [
            ("trainer.id", 65536),
            ("trainer.secret_id", 65536),
            ("trainer.play_time_frames", 60),
            ("inventory.items_1.item_id", 65535),
        ] {
            assert!(
                SaveGameRegistry::default()
                    .apply(
                        &source,
                        &identity,
                        &[SaveEdit {
                            field: field.into(),
                            value: SaveValue::U32(value)
                        }],
                        false
                    )
                    .is_err()
            );
        }
    }
}

#[test]
fn gen3_pokedex_keeps_seen_mirrors_and_reports_implicit_changes() {
    for family in [Family::Rs, Family::Emerald, Family::Frlg] {
        let identity = family.identity(match family {
            Family::Rs => "pokemon-ruby",
            Family::Emerald => "pokemon-emerald",
            Family::Frlg => "pokemon-firered",
        });
        let source = input(fixture(family, 2, 3), Some(&identity.id));
        let edits = (1..=386)
            .map(|number| SaveEdit {
                field: format!("pokedex.owned_{number:03}"),
                value: SaveValue::Bool(true),
            })
            .collect::<Vec<_>>();
        let result = SaveGameRegistry::default()
            .apply(&source, &identity, &edits, false)
            .unwrap();
        assert_eq!(result.preview.changes.len(), 772);
        assert_eq!(result.preview.touched_sections, [0, 1, 4]);
        let bytes = result.bytes.unwrap();
        let small = result
            .document
            .sections
            .iter()
            .find(|section| section.id == 0)
            .unwrap()
            .physical_offset as usize;
        let mirrors = match family {
            Family::Rs => [0x938, 0x3a8c],
            Family::Emerald => [0x988, 0x3b24],
            Family::Frlg => [0x5f8, 0x3a18],
        };
        for mirror in mirrors {
            let section_id = (1 + mirror / SECTION_DATA_SIZE) as u8;
            let base = result
                .document
                .sections
                .iter()
                .find(|section| section.id == section_id)
                .unwrap()
                .physical_offset as usize
                + mirror % SECTION_DATA_SIZE;
            assert_eq!(
                &bytes[base..base + 49],
                &bytes[small + 0x5c..small + 0x5c + 49]
            );
            assert_eq!(bytes[base], 255);
            assert_eq!(bytes[base + 48], 3);
        }
        assert_eq!(&bytes[..SLOT_SIZE], &source.bytes[..SLOT_SIZE]);
        let filled = input(bytes.clone(), Some(&identity.id));
        let clear = SaveEdit {
            field: "pokedex.seen_386".into(),
            value: SaveValue::Bool(false),
        };
        let dry = SaveGameRegistry::default()
            .apply(&filled, &identity, &[clear], true)
            .unwrap();
        assert!(dry.bytes.is_none());
        assert_eq!(
            value(&dry.document, "pokedex.owned_386"),
            SaveValue::Bool(false)
        );
        assert_eq!(filled.bytes, bytes);
        assert!(
            SaveGameRegistry::default()
                .apply(
                    &source,
                    &identity,
                    &[
                        SaveEdit {
                            field: "pokedex.owned_001".into(),
                            value: SaveValue::Bool(true)
                        },
                        SaveEdit {
                            field: "pokedex.seen_001".into(),
                            value: SaveValue::Bool(false)
                        },
                    ],
                    false
                )
                .is_err()
        );
    }
}

#[test]
fn gen4_trainer_ids_cover_full_u16_range_and_preserve_backup() {
    let handler = SaveGameRegistry::default();
    for definition in handler
        .definitions()
        .into_iter()
        .filter(|definition| definition.identity.family.starts_with("pokemon-gen4"))
    {
        let identity = definition.identity;
        let source = input(
            super::pokemon_gen4::fixture_for_id(&identity.id),
            Some(&identity.id),
        );
        for boundary in [0, 65535] {
            let edits = [
                SaveEdit {
                    field: "trainer.id".into(),
                    value: SaveValue::U32(boundary),
                },
                SaveEdit {
                    field: "trainer.secret_id".into(),
                    value: SaveValue::U32(boundary),
                },
            ];
            let result = handler.apply(&source, &identity, &edits, false).unwrap();
            assert_eq!(
                value(&result.document, "trainer.id"),
                SaveValue::U32(boundary)
            );
            assert_eq!(
                value(&result.document, "trainer.secret_id"),
                SaveValue::U32(boundary)
            );
            if let Some(bytes) = result.bytes {
                assert_eq!(&bytes[..0x40000], &source.bytes[..0x40000]);
            }
        }
        assert!(
            handler
                .apply(
                    &source,
                    &identity,
                    &[SaveEdit {
                        field: "trainer.id".into(),
                        value: SaveValue::U32(65536)
                    }],
                    false
                )
                .is_err()
        );
    }
}

#[test]
fn super_mario_world_profiles_share_generation_and_all_field_edit_bytes() {
    let registry = SaveGameRegistry::default();
    let schema = registry.generate("super-mario-world-schema").unwrap();
    let mut builtin = registry.generate("super-mario-world").unwrap();
    assert_eq!(schema.bytes, builtin.bytes);
    builtin.bytes[0x700] = 0xa5;
    let schema = SaveDetectionInput {
        bytes: builtin.bytes.clone(),
        selected_game: Some("super-mario-world-schema".into()),
        rom_sha1: None,
    };
    let definitions = registry.definitions();
    let game = |id: &str| {
        definitions
            .iter()
            .find(|entry| entry.identity.id == id)
            .unwrap()
            .identity
            .clone()
    };
    let builtin_game = game("super-mario-world");
    let schema_game = game("super-mario-world-schema");
    let document = registry.parse(&builtin, &builtin_game).unwrap();
    let schema_document = registry.parse(&schema, &schema_game).unwrap();
    assert_eq!(schema_document.fields.len(), 233);
    for field in &document.fields {
        assert_eq!(value(&schema_document, &field.id), field.value);
    }
    let edits = document
        .fields
        .iter()
        .map(|field| SaveEdit {
            field: field.id.clone(),
            value: match field.value {
                SaveValue::U32(_) => SaveValue::U32(field.constraints.max.unwrap() as u32),
                SaveValue::Bool(_) => SaveValue::Bool(true),
                _ => panic!("unexpected Super Mario World field type"),
            },
        })
        .collect::<Vec<_>>();
    let expected = registry
        .apply(&builtin, &builtin_game, &edits, false)
        .unwrap();
    let actual = registry
        .apply(&schema, &schema_game, &edits, false)
        .unwrap();
    assert_eq!(actual.bytes, expected.bytes);
    let bytes = actual.bytes.unwrap();
    assert_eq!(bytes[0x700], 0xa5);
    assert_eq!(&bytes[143..429], &schema.bytes[143..429]);
    assert_eq!(&bytes[572..858], &schema.bytes[572..858]);
    assert!(
        registry
            .apply(&schema, &schema_game, &edits, true)
            .unwrap()
            .bytes
            .is_none()
    );
}

#[test]
fn compiled_and_custom_handlers_have_unique_registry_ids() {
    let definitions = SaveGameRegistry::default().definitions();
    let mut ids = std::collections::HashSet::new();
    for definition in definitions {
        assert!(
            ids.insert(definition.identity.id.clone()),
            "duplicate save handler ID: {}",
            definition.identity.id
        );
    }
    assert!(ids.contains("super-mario-world"));
    assert!(ids.contains("super-mario-world-schema"));
}
