use super::super::{super_mario_world, zelda_alttp};
use super::*;

fn snes() -> Vec<(Box<dyn SaveGameHandler>, SchemaSaveHandler, usize, usize)> {
    vec![
        (
            Box::new(super_mario_world::SuperMarioWorldHandler) as Box<dyn SaveGameHandler>,
            catalog::builtin_super_mario_world::schemas().remove(0),
            143,
            429,
        ),
        (
            Box::new(zelda_alttp::ZeldaAlttpHandler) as Box<dyn SaveGameHandler>,
            catalog::builtin_zelda_alttp::schemas().remove(0),
            0x500,
            0xf00,
        ),
    ]
}

fn alternate(field: &SaveField) -> Option<SaveValue> {
    Some(match &field.value {
        SaveValue::U32(value) => {
            SaveValue::U32(if *value == field.constraints.min.unwrap_or(0) as u32 {
                value + field.step.unwrap_or(1)
            } else {
                field.constraints.min.unwrap_or(0) as u32
            })
        }
        SaveValue::Bool(value) => SaveValue::Bool(!value),
        SaveValue::Enum(value) => SaveValue::Enum(
            field
                .constraints
                .choices
                .iter()
                .find(|choice| *choice != value)?
                .clone(),
        ),
        SaveValue::Text(_) => SaveValue::Text("ZELDA".into()),
        _ => return None,
    })
}

fn assert_result(a: Result<SaveEditResult>, b: Result<SaveEditResult>, context: &str) {
    match (a, b) {
        (Ok(a), Ok(b)) => assert_eq!(a, b, "{context}"),
        (Err(RomWeaverError::ValidationCode(a)), Err(RomWeaverError::ValidationCode(b))) => {
            assert_eq!(a.code(), b.code(), "{context}")
        }
        (a, b) => panic!("{context}: native {a:?}, schema {b:?}"),
    }
}

#[test]
fn snes_schemas_preserve_documents_edits_and_duplicate_recovery() {
    for (native, schema, length, backup) in snes() {
        assert_eq!(native.definitions(), schema.definitions());
        let game = native.definitions().remove(0).identity;
        let initial = native.generate(&game).unwrap();
        assert_eq!(initial, schema.generate(&game).unwrap());
        let mut all = initial.clone();
        for slot in 1..3 {
            all[slot * length..(slot + 1) * length].copy_from_slice(&initial[..length]);
            all[backup + slot * length..backup + (slot + 1) * length]
                .copy_from_slice(&initial[..length]);
        }
        let mut primary_damaged = all.clone();
        primary_damaged[0] ^= 1;
        let mut backup_damaged = all.clone();
        backup_damaged[backup] ^= 1;
        for bytes in [initial, all, primary_damaged, backup_damaged] {
            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(game.id.clone()),
                rom_sha1: None,
            };
            assert_eq!(native.recognize(&input), schema.recognize(&input));
            let document = native.parse(&input, &game).unwrap();
            assert_eq!(document, schema.parse(&input, &game).unwrap());
            for field in document.fields.iter().filter(|field| field.editable) {
                let Some(value) = alternate(field) else {
                    continue;
                };
                let edits = [SaveEdit {
                    field: field.id.clone(),
                    value,
                }];
                assert_result(
                    native.apply(&input, &game, &edits, false),
                    schema.apply(&input, &game, &edits, false),
                    &field.id,
                );
            }
        }
    }
}

#[test]
fn snes_schemas_preserve_different_valid_copies_and_mixed_noop_repairs() {
    for (native, schema, length, backup) in snes() {
        let game = native.definitions().remove(0).identity;
        let initial = native.generate(&game).unwrap();
        let mut bytes = initial.clone();
        bytes[length..length * 2].copy_from_slice(&initial[..length]);
        bytes[backup + length..backup + length * 2].copy_from_slice(&initial[..length]);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(game.id.clone()),
            rom_sha1: None,
        };
        let document = native.parse(&input, &game).unwrap();
        let first = document
            .fields
            .iter()
            .find(|field| {
                field.section_id == 0 && field.editable && matches!(field.value, SaveValue::Bool(_))
            })
            .unwrap();
        let second = document
            .fields
            .iter()
            .find(|field| {
                field.section_id == 1 && field.editable && matches!(field.value, SaveValue::Bool(_))
            })
            .unwrap();
        let changed = native
            .apply(
                &input,
                &game,
                &[SaveEdit {
                    field: first.id.clone(),
                    value: alternate(first).unwrap(),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        let mut differing = input.clone();
        differing.bytes[backup..backup + length].copy_from_slice(&changed[backup..backup + length]);
        assert_eq!(
            native.parse(&differing, &game).unwrap(),
            schema.parse(&differing, &game).unwrap()
        );
        let mut damaged = input.clone();
        damaged.bytes[backup + length] ^= 1;
        let edits = [
            SaveEdit {
                field: first.id.clone(),
                value: alternate(first).unwrap(),
            },
            SaveEdit {
                field: second.id.clone(),
                value: second.value.clone(),
            },
        ];
        assert_result(
            native.apply(&damaged, &game, &edits, false),
            schema.apply(&damaged, &game, &edits, false),
            "mixed no-op repair",
        );
        assert_result(
            native.apply(&damaged, &game, &edits[1..], true),
            schema.apply(&damaged, &game, &edits[1..], true),
            "no-op preview",
        );
    }
}
