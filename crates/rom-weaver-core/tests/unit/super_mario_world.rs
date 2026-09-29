use crate::save::{
    SaveDetectionInput, SaveDocument, SaveEdit, SaveGameDefinition, SaveGameIdentity,
    SaveIntegrityState, SaveRecognitionOutcome, SaveValue, SchemaSaveHandler,
};

const SUPER_MARIO_WORLD_SRAM_SIZE: usize = 0x800;
const FILE_SIZE: usize = 143;
const DATA_SIZE: usize = FILE_SIZE - 2;
const FILE_COUNT: usize = 3;
const BACKUP_OFFSET: usize = FILE_COUNT * FILE_SIZE;
const CHECKSUM_OFFSET: usize = DATA_SIZE;
const CHECKSUM_TARGET: u16 = 0x5A5A;
const EVENTS_OFFSET: usize = 96;
const SUBMAP_OFFSET: usize = 111;
const ANIMATION_OFFSET: usize = 113;
const POSITION_OFFSET: usize = 117;
const SWITCHES_OFFSET: usize = 133;
const EXIT_COUNT_OFFSET: usize = 140;

fn handler() -> SchemaSaveHandler {
    super::schema::catalog::builtin_super_mario_world::schemas().remove(0)
}
fn definition() -> SaveGameDefinition {
    handler().definitions().remove(0)
}

fn checksum_word(data: &[u8]) -> u16 {
    data[..DATA_SIZE]
        .iter()
        .fold(word_at(data, CHECKSUM_OFFSET), |sum, byte| {
            sum.wrapping_add(u16::from(*byte))
        })
}

fn word_at(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn field_value<'a>(document: &'a SaveDocument, id: &str) -> Option<&'a SaveValue> {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| &field.value)
}

fn identity() -> SaveGameIdentity {
    definition().identity
}

fn input(bytes: Vec<u8>) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some("super-mario-world".into()),
        rom_sha1: None,
    }
}

#[test]
fn generation_matches_the_original_initialization() {
    let bytes = handler().generate(&definition().identity).unwrap();
    assert_eq!(bytes.len(), SUPER_MARIO_WORLD_SRAM_SIZE);
    let file = &bytes[..FILE_SIZE];
    assert_eq!(file[0x28], 0x03);
    assert_eq!(file[0x4D], 0x01);
    assert_eq!(&file[SUBMAP_OFFSET..SUBMAP_OFFSET + 2], &[1, 1]);
    assert_eq!(word_at(file, ANIMATION_OFFSET), 2);
    assert_eq!(word_at(file, POSITION_OFFSET), 0x68);
    assert_eq!(word_at(file, POSITION_OFFSET + 2), 0x78);
    assert_eq!(checksum_word(file), CHECKSUM_TARGET);
    assert_eq!(word_at(file, CHECKSUM_OFFSET), 0x5865);
    assert_eq!(file, &bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]);
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
fn exposes_every_documented_persistent_byte() {
    let document = handler()
        .parse(
            &input(handler().generate(&definition().identity).unwrap()),
            &identity(),
        )
        .unwrap();
    assert_eq!(document.fields.len(), 96 + 120 + 2 * 6 + 4 + 1);
    assert!(document.fields.iter().any(|field| {
        field.id == "slot_1.players.player_2.y_tile" && field.value == SaveValue::U32(7)
    }));
    assert!(document.fields.iter().any(|field| {
        field.id == "slot_1.events.event_119" && field.value == SaveValue::Bool(false)
    }));
}

#[test]
fn edits_full_ranges_repairs_both_copies_and_preserves_other_bytes() {
    let original = handler().generate(&definition().identity).unwrap();
    let edits = vec![
        SaveEdit {
            field: "slot_1.levels.level_5f.flags".into(),
            value: SaveValue::U32(0xFF),
        },
        SaveEdit {
            field: "slot_1.events.event_119".into(),
            value: SaveValue::Bool(true),
        },
        SaveEdit {
            field: "slot_1.players.player_2.y".into(),
            value: SaveValue::U32(0xFFFF),
        },
        SaveEdit {
            field: "slot_1.progress.switch_palaces.blue".into(),
            value: SaveValue::Bool(true),
        },
        SaveEdit {
            field: "slot_1.progress.exits_completed".into(),
            value: SaveValue::U32(0xFF),
        },
    ];
    let result = handler()
        .apply(&input(original.clone()), &identity(), &edits, false)
        .unwrap();
    let bytes = result.bytes.unwrap();
    assert_eq!(bytes[0x5F], 0xFF);
    assert_eq!(bytes[EVENTS_OFFSET + 14] & 0x01, 0x01);
    assert_eq!(word_at(&bytes, POSITION_OFFSET + 6), 0xFFFF);
    assert_eq!(bytes[SWITCHES_OFFSET + 3], 1);
    assert_eq!(bytes[EXIT_COUNT_OFFSET], 0xFF);
    assert_eq!(checksum_word(&bytes[..FILE_SIZE]), CHECKSUM_TARGET);
    assert_eq!(
        &bytes[..FILE_SIZE],
        &bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]
    );
    assert_eq!(
        &bytes[FILE_SIZE..BACKUP_OFFSET],
        &original[FILE_SIZE..BACKUP_OFFSET]
    );
    assert_eq!(
        &bytes[BACKUP_OFFSET + FILE_SIZE..],
        &original[BACKUP_OFFSET + FILE_SIZE..]
    );
}

#[test]
fn dry_run_reports_changes_without_returning_bytes() {
    let bytes = handler().generate(&definition().identity).unwrap();
    let result = handler()
        .apply(
            &input(bytes),
            &identity(),
            &[SaveEdit {
                field: "slot_1.progress.exits_completed".into(),
                value: SaveValue::U32(1),
            }],
            true,
        )
        .unwrap();
    assert!(result.preview.changed);
    assert!(result.bytes.is_none());
    assert_eq!(
        field_value(&result.document, "slot_1.progress.exits_completed"),
        Some(&SaveValue::U32(1))
    );
}

#[test]
fn uses_a_valid_backup_and_repairs_it_after_an_edit() {
    let mut bytes = handler().generate(&definition().identity).unwrap();
    bytes[0] ^= 0x80;
    let document = handler().parse(&input(bytes.clone()), &identity()).unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::ValidWithWarnings
    );
    let result = handler()
        .apply(
            &input(bytes),
            &identity(),
            &[SaveEdit {
                field: "slot_1.progress.exits_completed".into(),
                value: SaveValue::U32(1),
            }],
            false,
        )
        .unwrap();
    let repaired = result.bytes.unwrap();
    assert_eq!(
        &repaired[..FILE_SIZE],
        &repaired[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]
    );
}

#[test]
fn rejects_a_nonempty_slot_when_both_copies_are_corrupt() {
    let mut bytes = handler().generate(&definition().identity).unwrap();
    bytes[FILE_SIZE] = 1;
    bytes[BACKUP_OFFSET + FILE_SIZE] = 1;
    let document = handler().parse(&input(bytes.clone()), &identity()).unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::PartiallyRecoverable
    );
    assert!(document.fields.iter().all(|field| !field.editable));
    assert!(
        handler()
            .apply(
                &input(bytes),
                &identity(),
                &[SaveEdit {
                    field: "slot_1.progress.exits_completed".into(),
                    value: SaveValue::U32(1),
                }],
                false,
            )
            .is_err()
    );
}

#[test]
fn edits_each_slot_and_accepts_erased_unused_slots() {
    let fresh = handler().generate(&definition().identity).unwrap();
    for slot in 0..FILE_COUNT {
        let mut bytes = vec![0xff; SUPER_MARIO_WORLD_SRAM_SIZE];
        let primary = slot * FILE_SIZE;
        let backup = BACKUP_OFFSET + primary;
        bytes[primary..primary + FILE_SIZE].copy_from_slice(&fresh[..FILE_SIZE]);
        bytes[backup..backup + FILE_SIZE].copy_from_slice(&fresh[..FILE_SIZE]);
        let field = format!("slot_{}.events.event_000", slot + 1);
        let source = input(bytes.clone());
        let result = handler()
            .apply(
                &source,
                &identity(),
                &[SaveEdit {
                    field,
                    value: SaveValue::Bool(true),
                }],
                false,
            )
            .unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(output[primary + EVENTS_OFFSET], 0x80);
        assert_eq!(
            &output[primary..primary + FILE_SIZE],
            &output[backup..backup + FILE_SIZE]
        );
        for offset in 0..SUPER_MARIO_WORLD_SRAM_SIZE {
            if !(primary..primary + FILE_SIZE).contains(&offset)
                && !(backup..backup + FILE_SIZE).contains(&offset)
            {
                assert_eq!(output[offset], bytes[offset]);
            }
        }
    }
}

#[test]
fn rejects_blank_wrong_size_wrong_game_and_out_of_range_values() {
    for bytes in [
        vec![0; SUPER_MARIO_WORLD_SRAM_SIZE],
        vec![0xff; SUPER_MARIO_WORLD_SRAM_SIZE],
        vec![0; 100],
    ] {
        assert!(matches!(
            handler().recognize(&input(bytes)).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
    }
    let mut source = input(handler().generate(&definition().identity).unwrap());
    for (field, value) in [
        ("slot_1.levels.level_00.flags", 256),
        ("slot_1.players.player_1.x", 65536),
    ] {
        assert!(
            handler()
                .apply(
                    &source,
                    &identity(),
                    &[SaveEdit {
                        field: field.into(),
                        value: SaveValue::U32(value)
                    }],
                    false
                )
                .is_err()
        );
    }
    source.selected_game = Some("pokemon-red".into());
    assert!(matches!(
        handler().recognize(&source).outcome,
        SaveRecognitionOutcome::Unsupported { .. }
    ));
}
