use crate::RomWeaverError;
use crate::save::{
    SaveDetectionInput, SaveDocument, SaveEdit, SaveGameDefinition, SaveIntegrityState, SaveValue,
    SchemaSaveHandler,
};

const ALTT_P_SRAM_SIZE: usize = 0x2000;
const FILE_SIZE: usize = 0x500;
const FILE_COUNT: usize = 3;
const BACKUP_OFFSET: usize = 0xF00;
const CHECKSUM_OFFSET: usize = 0x4FE;
const CHECKSUM_TARGET: u16 = 0x5A5A;
const FILE_MARKER_OFFSET: usize = 0x3E5;
const FILE_MARKER: u16 = 0x55AA;
const DIED_COUNTER_OFFSET: usize = 0x405;
const NAME_OFFSET: usize = 0x3D9;
const NAME_LENGTH: usize = 6;

fn handler() -> SchemaSaveHandler {
    super::schema::catalog::builtin_zelda_alttp::schemas().remove(0)
}
fn definition() -> SaveGameDefinition {
    handler().definitions().remove(0)
}

fn primary_offset(slot: u8) -> usize {
    usize::from(slot) * FILE_SIZE
}

fn backup_offset(slot: u8) -> usize {
    BACKUP_OFFSET + primary_offset(slot)
}

fn is_valid_copy(data: &[u8]) -> bool {
    data.len() == FILE_SIZE
        && word_at(data, FILE_MARKER_OFFSET) == FILE_MARKER
        && checksum_word(data) == CHECKSUM_TARGET
}

fn checksum_word(data: &[u8]) -> u16 {
    data.chunks_exact(2).fold(0u16, |sum, word| {
        sum.wrapping_add(u16::from_le_bytes([word[0], word[1]]))
    })
}

fn required_checksum(data: &[u8]) -> u16 {
    data[..CHECKSUM_OFFSET]
        .chunks_exact(2)
        .fold(CHECKSUM_TARGET, |sum, word| {
            sum.wrapping_sub(u16::from_le_bytes([word[0], word[1]]))
        })
}

fn repair_checksum(data: &mut [u8]) {
    let checksum = required_checksum(data);
    data[CHECKSUM_OFFSET..CHECKSUM_OFFSET + 2].copy_from_slice(&checksum.to_le_bytes());
}

fn word_at(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn write_word(data: &mut [u8], offset: usize, value: u16) {
    data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn field_value<'a>(document: &'a SaveDocument, id: &str) -> Option<&'a SaveValue> {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| &field.value)
}

use crate::save::SaveGameRegistry;

fn fixture() -> Vec<u8> {
    let mut bytes = vec![0; ALTT_P_SRAM_SIZE];
    for slot in 0..FILE_COUNT as u8 {
        let offset = primary_offset(slot);
        {
            let data = &mut bytes[offset..offset + FILE_SIZE];
            write_word(data, FILE_MARKER_OFFSET, FILE_MARKER);
            for (index, letter) in b"LINK".iter().copied().enumerate() {
                let code = letter - b'A';
                write_word(data, NAME_OFFSET + index * 2, code as u16);
            }
            for index in 4..NAME_LENGTH {
                write_word(data, NAME_OFFSET + index * 2, 0x00A9);
            }
            write_word(data, 0x360, 123);
            write_word(data, 0x362, 123);
            data[0x343] = 10;
            data[0x377] = 30;
            data[0x36C] = 24;
            data[0x36D] = 24;
            data[0x359] = 1;
            repair_checksum(data);
        }
        let backup = backup_offset(slot);
        let copy = bytes[offset..offset + FILE_SIZE].to_vec();
        bytes[backup..backup + FILE_SIZE].copy_from_slice(&copy);
    }
    bytes
}

fn input(bytes: Vec<u8>) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(definition().identity.id),
        rom_sha1: None,
    }
}

#[test]
fn parses_three_valid_files_and_decodes_english_names() {
    let document = handler()
        .parse(&input(fixture()), &definition().identity)
        .unwrap();
    assert_eq!(document.sections.len(), 3);
    for field in &document.fields {
        let slot = field
            .id
            .strip_prefix("slot_")
            .unwrap()
            .split('.')
            .next()
            .unwrap()
            .parse::<u8>()
            .unwrap();
        assert_eq!(field.section_id, slot - 1, "{}", field.id);
    }
    assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
    assert_eq!(
        field_value(&document, "slot_1.player.name"),
        Some(&SaveValue::Text("LINK".into()))
    );
    assert_eq!(
        field_value(&document, "slot_1.resources.rupees"),
        Some(&SaveValue::U32(123))
    );
}

#[test]
fn generates_the_original_fresh_file_initializer() {
    let bytes = handler().generate(&definition().identity).unwrap();
    let identity = definition().identity;
    let document = handler().parse(&input(bytes.clone()), &identity).unwrap();
    assert_eq!(bytes.len(), ALTT_P_SRAM_SIZE);
    assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
    assert_eq!(document.sections.len(), 1);
    assert_eq!(document.active_slot, 0);
    assert_eq!(
        field_value(&document, "slot_1.player.name"),
        Some(&SaveValue::Text("LINK".into()))
    );
    assert_eq!(
        field_value(&document, "slot_1.hearts.capacity_eighths"),
        Some(&SaveValue::U32(24))
    );
    assert_eq!(
        field_value(&document, "slot_1.hearts.current_eighths"),
        Some(&SaveValue::U32(24))
    );
    assert_eq!(word_at(&bytes[..FILE_SIZE], 0x20C), 0xF000);
    assert_eq!(word_at(&bytes[..FILE_SIZE], 0x20E), 0xF000);
    assert_eq!(word_at(&bytes[..FILE_SIZE], DIED_COUNTER_OFFSET), 0xFFFF);
    assert_eq!(
        &bytes[..FILE_SIZE],
        &bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]
    );
    assert!(is_valid_copy(&bytes[..FILE_SIZE]));
    assert!(
        bytes[FILE_SIZE..BACKUP_OFFSET]
            .iter()
            .all(|byte| *byte == 0)
    );
    assert!(
        bytes[BACKUP_OFFSET + FILE_SIZE..]
            .iter()
            .all(|byte| *byte == 0)
    );
}

#[test]
fn registry_generation_uses_the_checked_initializer() {
    let input = SaveGameRegistry::default()
        .generate("zelda-a-link-to-the-past")
        .unwrap();
    assert_eq!(
        input.selected_game.as_deref(),
        Some(definition().identity.id.as_str())
    );
    assert_eq!(
        input.bytes,
        handler().generate(&definition().identity).unwrap()
    );
}

#[test]
fn edits_verified_inventory_magic_dungeon_and_progression_fields() {
    let original = fixture();
    let result = handler()
        .apply(
            &input(original.clone()),
            &definition().identity,
            &[
                SaveEdit {
                    field: "slot_1.player.name".into(),
                    value: SaveValue::Text("Zelda".into()),
                },
                SaveEdit {
                    field: "slot_1.inventory.bow".into(),
                    value: SaveValue::Enum("silver_bow_and_arrows".into()),
                },
                SaveEdit {
                    field: "slot_1.inventory.bottle_1".into(),
                    value: SaveValue::Enum("blue_potion".into()),
                },
                SaveEdit {
                    field: "slot_1.magic.current".into(),
                    value: SaveValue::U32(128),
                },
                SaveEdit {
                    field: "slot_1.magic.consumption".into(),
                    value: SaveValue::Enum("half".into()),
                },
                SaveEdit {
                    field: "slot_1.progress.dungeons.sewers.compass".into(),
                    value: SaveValue::Bool(true),
                },
                SaveEdit {
                    field: "slot_1.progress.dungeons.ganons_tower.map".into(),
                    value: SaveValue::Bool(true),
                },
                SaveEdit {
                    field: "slot_1.progress.dungeons.eastern_palace.keys_earned".into(),
                    value: SaveValue::U32(6),
                },
                SaveEdit {
                    field: "slot_1.progress.game_state".into(),
                    value: SaveValue::Enum("zelda_rescued".into()),
                },
                SaveEdit {
                    field: "slot_1.progress.side_quests.purple_chest_opened".into(),
                    value: SaveValue::Bool(true),
                },
            ],
            false,
        )
        .unwrap();
    let bytes = result.bytes.unwrap();
    let data = &bytes[..FILE_SIZE];
    assert_eq!(
        &data[NAME_OFFSET..NAME_OFFSET + 12],
        &[0x29, 0, 0x2e, 0, 0x45, 0, 0x2d, 0, 0x2a, 0, 0xa9, 0]
    );
    assert_eq!(data[0x340], 4);
    assert_eq!(data[0x35C], 5);
    assert_eq!(data[0x36E], 128);
    assert_eq!(data[0x37B], 1);
    assert_eq!(data[0x364] & 0x80, 0x80);
    assert_eq!(data[0x369] & 0x04, 0x04);
    assert_eq!(data[0x37E], 6);
    assert_eq!(data[0x3C5], 2);
    assert_eq!(data[0x3C9] & 0x10, 0x10);
    assert!(is_valid_copy(data));
    assert_eq!(&bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE], data);
    assert_eq!(&bytes[0x500..0x520], &original[0x500..0x520]);
    assert_eq!(&bytes[0xA00..0xA20], &original[0xA00..0xA20]);
}

#[test]
fn rejects_out_of_range_expanded_fields() {
    for (field, value, code) in [
        (
            "slot_1.magic.current",
            SaveValue::U32(129),
            "save_value_range",
        ),
        (
            "slot_1.progress.heart_pieces",
            SaveValue::U32(4),
            "save_value_range",
        ),
        (
            "slot_1.inventory.bottle_1",
            SaveValue::Enum("invalid".into()),
            "save_value_choice",
        ),
    ] {
        let error = handler()
            .apply(
                &input(fixture()),
                &definition().identity,
                &[SaveEdit {
                    field: field.into(),
                    value,
                }],
                false,
            )
            .unwrap_err();
        match error {
            RomWeaverError::ValidationCode(error) => assert_eq!(error.code(), code),
            other => panic!("expected a validation error, got {other:?}"),
        }
    }
}

#[test]
fn writes_progress_bitfields_in_source_bit_order() {
    let edits = [
        "uncle_secret_passage",
        "sanctuary_priest",
        "zelda_sanctuary",
        "uncle_left_house",
        "book_progress",
        "fortune_teller_variant",
    ]
    .into_iter()
    .map(|name| SaveEdit {
        field: format!("slot_1.progress.early_story.{name}"),
        value: SaveValue::Bool(true),
    })
    .chain(
        [
            "swordsmith_rescued",
            "purple_chest_opened",
            "stumpy_stumped",
            "bottle_purchased",
            "hobo_bottle",
        ]
        .into_iter()
        .map(|name| SaveEdit {
            field: format!("slot_1.progress.side_quests.{name}"),
            value: SaveValue::Bool(true),
        }),
    )
    .collect::<Vec<_>>();
    let result = handler()
        .apply(&input(fixture()), &definition().identity, &edits, false)
        .unwrap();
    let data = &result.bytes.unwrap()[..FILE_SIZE];
    assert_eq!(data[0x3C6], 0x77);
    assert_eq!(data[0x3C9], 0x3B);
}

#[test]
fn edits_both_copies_and_repairs_the_checksum() {
    let original = fixture();
    let result = handler()
        .apply(
            &input(original.clone()),
            &definition().identity,
            &[
                SaveEdit {
                    field: "slot_2.resources.rupees".into(),
                    value: SaveValue::U32(999),
                },
                SaveEdit {
                    field: "slot_2.progress.crystal_7".into(),
                    value: SaveValue::Bool(true),
                },
            ],
            false,
        )
        .unwrap();
    let bytes = result.bytes.unwrap();
    let primary = primary_offset(1);
    let backup = backup_offset(1);
    assert_eq!(
        &bytes[primary..primary + FILE_SIZE],
        &bytes[backup..backup + FILE_SIZE]
    );
    assert!(is_valid_copy(&bytes[primary..primary + FILE_SIZE]));
    assert_eq!(
        field_value(&result.document, "slot_2.resources.rupees"),
        Some(&SaveValue::U32(999))
    );
    assert_eq!(&bytes[..FILE_SIZE], &original[..FILE_SIZE]);
}

#[test]
fn repairs_a_file_from_its_valid_backup_when_an_edit_targets_it() {
    let mut bytes = fixture();
    bytes[primary_offset(0) + 0x343] ^= 1;
    let result = handler()
        .apply(
            &input(bytes),
            &definition().identity,
            &[SaveEdit {
                field: "slot_1.resources.bombs".into(),
                value: SaveValue::U32(12),
            }],
            false,
        )
        .unwrap();
    let bytes = result.bytes.unwrap();
    assert_eq!(
        &bytes[primary_offset(0)..primary_offset(0) + FILE_SIZE],
        &bytes[backup_offset(0)..backup_offset(0) + FILE_SIZE]
    );
    assert!(is_valid_copy(
        &bytes[primary_offset(0)..primary_offset(0) + FILE_SIZE]
    ));
}

#[test]
fn rejects_invalid_heart_combinations_without_writing() {
    let error = handler()
        .apply(
            &input(fixture()),
            &definition().identity,
            &[SaveEdit {
                field: "slot_1.hearts.current_eighths".into(),
                value: SaveValue::U32(25),
            }],
            false,
        )
        .unwrap_err();
    match error {
        RomWeaverError::ValidationCode(error) => {
            assert_eq!(error.code(), "save_current_health")
        }
        other => panic!("expected a validation error, got {other:?}"),
    }
}

#[test]
fn rejects_all_edits_when_another_file_has_no_valid_copy() {
    let mut bytes = fixture();
    bytes[primary_offset(2) + 0x343] ^= 1;
    bytes[backup_offset(2) + 0x343] ^= 1;
    let input = input(bytes);
    let document = handler().parse(&input, &definition().identity).unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::PartiallyRecoverable
    );
    assert!(document.fields.iter().all(|field| !field.editable));
    assert!(
        handler()
            .apply(
                &input,
                &definition().identity,
                &[SaveEdit {
                    field: "slot_1.resources.rupees".into(),
                    value: SaveValue::U32(999),
                }],
                false,
            )
            .is_err()
    );
}

#[test]
fn rejects_unrelated_edits_when_an_exposed_value_is_invalid() {
    let mut bytes = fixture();
    for offset in [primary_offset(1), backup_offset(1)] {
        bytes[offset + 0x355] = 2;
        repair_checksum(&mut bytes[offset..offset + FILE_SIZE]);
    }
    let input = input(bytes);
    let document = handler().parse(&input, &definition().identity).unwrap();
    assert_eq!(document.integrity.state, SaveIntegrityState::Invalid);
    assert!(document.fields.iter().all(|field| !field.editable));
    assert!(
        handler()
            .apply(
                &input,
                &definition().identity,
                &[SaveEdit {
                    field: "slot_1.resources.rupees".into(),
                    value: SaveValue::U32(999),
                }],
                false,
            )
            .is_err()
    );
}

#[test]
fn preserves_the_temporarily_removed_sword_during_other_edits() {
    let mut bytes = fixture();
    for offset in [primary_offset(0), backup_offset(0)] {
        bytes[offset + 0x359] = 0xff;
        bytes[offset + 0x3C9] |= 0x80;
        repair_checksum(&mut bytes[offset..offset + FILE_SIZE]);
    }
    let input = input(bytes);
    let document = handler().parse(&input, &definition().identity).unwrap();
    let sword = document
        .fields
        .iter()
        .find(|field| field.id == "slot_1.equipment.sword")
        .unwrap();
    assert_eq!(sword.value, SaveValue::Enum("tempering".into()));
    assert!(!sword.editable);

    let output = handler()
        .apply(
            &input,
            &definition().identity,
            &[SaveEdit {
                field: "slot_1.resources.rupees".into(),
                value: SaveValue::U32(999),
            }],
            false,
        )
        .unwrap()
        .bytes
        .unwrap();
    for offset in [primary_offset(0), backup_offset(0)] {
        assert_eq!(output[offset + 0x359], 0xff);
        assert_eq!(output[offset + 0x3C9] & 0x80, 0x80);
    }
}

#[test]
fn rejects_a_smith_flag_without_the_temporarily_removed_sword() {
    let mut bytes = fixture();
    for offset in [primary_offset(0), backup_offset(0)] {
        bytes[offset + 0x3C9] |= 0x80;
        repair_checksum(&mut bytes[offset..offset + FILE_SIZE]);
    }
    let document = handler()
        .parse(&input(bytes), &definition().identity)
        .unwrap();
    assert_eq!(document.integrity.state, SaveIntegrityState::Invalid);
    assert!(document.fields.iter().all(|field| !field.editable));
}
