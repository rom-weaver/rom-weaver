use super::*;

fn snes() -> Vec<(SchemaSaveHandler, usize, usize)> {
    vec![
        (
            catalog::builtin_super_mario_world::schemas().remove(0),
            143,
            429,
        ),
        (
            catalog::builtin_zelda_alttp::schemas().remove(0),
            0x500,
            0xf00,
        ),
    ]
}

fn alternate(field: &SaveField) -> Option<SaveValue> {
    Some(match &field.value {
        SaveValue::U32(value) => {
            let min = field.constraints.min.unwrap_or(0) as u32;
            SaveValue::U32(if *value == min {
                value + field.step.unwrap_or(1)
            } else {
                min
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

fn input(bytes: Vec<u8>, id: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(id.into()),
        rom_sha1: None,
    }
}

#[test]
fn snes_fields_round_trip_with_valid_checksums_and_preserve_other_slots() {
    for (schema, length, backup) in snes() {
        let game = schema.definitions().remove(0).identity;
        let initial = schema.generate(&game).unwrap();
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
            let source = input(bytes, &game.id);
            assert!(matches!(
                schema.recognize(&source).outcome,
                SaveRecognitionOutcome::Recognized { .. }
            ));
            let document = schema.parse(&source, &game).unwrap();
            for field in document.fields.iter().filter(|field| field.editable) {
                let Some(value) = alternate(field) else {
                    continue;
                };
                let result = schema.apply(
                    &source,
                    &game,
                    &[SaveEdit {
                        field: field.id.clone(),
                        value: value.clone(),
                    }],
                    false,
                );
                let result = match result {
                    Ok(result) => result,
                    Err(RomWeaverError::ValidationCode(error)) => {
                        let expected = if field.id.ends_with(".hearts.capacity_eighths") {
                            "save_current_health"
                        } else if field.id.ends_with(".side_quests.smith_tempering") {
                            "save_equipment"
                        } else {
                            panic!("{}: {error}", field.id);
                        };
                        assert_eq!(error.code(), expected, "{}", field.id);
                        continue;
                    }
                    Err(error) => panic!("{}: {error}", field.id),
                };
                assert_eq!(
                    result
                        .document
                        .fields
                        .iter()
                        .find(|actual| actual.id == field.id)
                        .unwrap()
                        .value,
                    value
                );
                let Some(output) = result.bytes else { continue };
                let slot = usize::from(field.section_id);
                let primary = slot * length;
                let mirror = backup + primary;
                assert_eq!(
                    &output[primary..primary + length],
                    &output[mirror..mirror + length],
                    "{}",
                    field.id
                );
                let checksum = if length == 143 {
                    output[primary..primary + length - 2].iter().fold(
                        u16::from_le_bytes(
                            output[primary + length - 2..primary + length]
                                .try_into()
                                .unwrap(),
                        ),
                        |sum, byte| sum.wrapping_add(u16::from(*byte)),
                    )
                } else {
                    output[primary..primary + length]
                        .chunks_exact(2)
                        .fold(0u16, |sum, word| {
                            sum.wrapping_add(u16::from_le_bytes(word.try_into().unwrap()))
                        })
                };
                assert_eq!(checksum, 0x5a5a, "{}", field.id);
                for (offset, byte) in output.iter().enumerate() {
                    if !(primary..primary + length).contains(&offset)
                        && !(mirror..mirror + length).contains(&offset)
                    {
                        assert_eq!(*byte, source.bytes[offset], "{} byte {offset}", field.id);
                    }
                }
            }
        }
    }
}

#[test]
fn snes_uses_primary_for_differing_valid_copies_and_repairs_mixed_noop_edits() {
    for (schema, length, backup) in snes() {
        let game = schema.definitions().remove(0).identity;
        let initial = schema.generate(&game).unwrap();
        let mut bytes = initial.clone();
        bytes[length..length * 2].copy_from_slice(&initial[..length]);
        bytes[backup + length..backup + length * 2].copy_from_slice(&initial[..length]);
        let source = input(bytes, &game.id);
        let document = schema.parse(&source, &game).unwrap();
        let boolean = |slot| {
            document
                .fields
                .iter()
                .find(|field| {
                    field.section_id == slot
                        && field.editable
                        && matches!(field.value, SaveValue::Bool(_))
                })
                .unwrap()
        };
        let first = boolean(0);
        let second = boolean(1);
        let first_edit = SaveEdit {
            field: first.id.clone(),
            value: alternate(first).unwrap(),
        };
        let changed = schema
            .apply(&source, &game, std::slice::from_ref(&first_edit), false)
            .unwrap()
            .bytes
            .unwrap();
        let mut differing = source.clone();
        differing.bytes[backup..backup + length].copy_from_slice(&changed[backup..backup + length]);
        let actual = schema.parse(&differing, &game).unwrap();
        assert_eq!(
            actual
                .fields
                .iter()
                .find(|field| field.id == first.id)
                .unwrap()
                .value,
            first.value
        );
        assert!(
            actual
                .integrity
                .issues
                .iter()
                .any(|issue| issue.code == "duplicate_copy_mismatch")
        );
        let mut damaged = source.clone();
        damaged.bytes[backup + length] ^= 1;
        let noop = SaveEdit {
            field: second.id.clone(),
            value: second.value.clone(),
        };
        let result = schema
            .apply(&damaged, &game, &[first_edit, noop.clone()], false)
            .unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(
            &output[length..length * 2],
            &output[backup + length..backup + length * 2]
        );
        assert_eq!(
            &output[length..length * 2],
            &source.bytes[length..length * 2]
        );
        let preview = schema.apply(&damaged, &game, &[noop], true).unwrap();
        assert!(!preview.preview.changed);
        assert!(preview.bytes.is_none());
    }
}
