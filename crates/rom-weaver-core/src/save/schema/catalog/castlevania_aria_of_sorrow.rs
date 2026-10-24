use super::*;

const SAVE_SIZE: usize = 0x8000;
const SLOT_SIZE: usize = 0x8f8;

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/castlevania-aria-of-sorrow/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for slot in 0..3 {
        fields.extend(slot_fields(slot));
    }
    fields.extend([
        catalog_field("system.language", "Language", 0x1afc, Storage::U8),
        catalog_field(
            "system.unlock_group_1",
            "Hard, Boss Rush, and Sound Test modes unlocked",
            0x1af8,
            Storage::Bit,
        )
        .bit(0),
        catalog_field(
            "system.unlock_group_2",
            "Julius, No Use, and No Soul modes unlocked",
            0x1af8,
            Storage::Bit,
        )
        .bit(1),
    ]);

    let game = GameDefinition {
        fields,
        description: concat!(
            "Edits documented scalar fields in the three slots of a raw 32 KiB GBA save. ",
            "Level and gold edits update their save-preview copies. Collection containers ",
            "and header-shifted variants are rejected."
        )
        .into(),
        signatures: vec![SignatureDefinition {
            offset: 0,
            bytes: b"CASTLEVANIA2-010".to_vec(),
        }],
        ..GameDefinition::new(
            "castlevania-aria-of-sorrow".into(),
            "Castlevania: Aria of Sorrow".into(),
            "gba".into(),
            SAVE_SIZE,
        )
    };
    build(vec![game], BTreeMap::new(), true)
}

fn slot_fields(slot: usize) -> Vec<FieldDefinition> {
    let base = slot * SLOT_SIZE;
    let prefix = format!("slot_{}", slot + 1);
    let label = format!("Slot {}", slot + 1);
    let mut fields = vec![
        FieldDefinition::new(
            format!("{prefix}.level"),
            format!("{label} level"),
            base + 0x2d,
            Storage::U8,
        )
        .min(1)
        .max(99)
        .copies(vec![base + 0x1ac]),
        FieldDefinition::new(
            format!("{prefix}.experience"),
            format!("{label} experience"),
            base + 0x40,
            Storage::U32Le,
        )
        .max(99_999_999),
        FieldDefinition::new(
            format!("{prefix}.hp.current"),
            format!("{label} current HP"),
            base + 0x2e,
            Storage::U16Le,
        )
        .min(1),
        FieldDefinition::new(
            format!("{prefix}.hp.maximum"),
            format!("{label} maximum HP"),
            base + 0x32,
            Storage::U16Le,
        )
        .min(1)
        .max(9_999),
        FieldDefinition::new(
            format!("{prefix}.mp.current"),
            format!("{label} current MP"),
            base + 0x30,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("{prefix}.mp.maximum"),
            format!("{label} maximum MP"),
            base + 0x34,
            Storage::U16Le,
        )
        .max(9_999),
        FieldDefinition::new(
            format!("{prefix}.strength"),
            format!("{label} strength"),
            base + 0x36,
            Storage::U16Le,
        )
        .min(1)
        .max(999),
        FieldDefinition::new(
            format!("{prefix}.constitution"),
            format!("{label} constitution"),
            base + 0x38,
            Storage::U16Le,
        )
        .min(1)
        .max(999),
        FieldDefinition::new(
            format!("{prefix}.intelligence"),
            format!("{label} intelligence"),
            base + 0x3a,
            Storage::U16Le,
        )
        .min(1)
        .max(999),
        FieldDefinition::new(
            format!("{prefix}.luck"),
            format!("{label} luck"),
            base + 0x3c,
            Storage::U16Le,
        )
        .min(1)
        .max(999),
        FieldDefinition::new(
            format!("{prefix}.gold"),
            format!("{label} gold"),
            base + 0x44,
            Storage::U32Le,
        )
        .max(999_999)
        .copies(vec![base + 0x1b4]),
        FieldDefinition::new(
            format!("{prefix}.playtime_frames"),
            format!("{label} playtime frames"),
            base + 0x1b8,
            Storage::U32Le,
        )
        .description("The game stores playtime at 60 frames per second.".into()),
    ];
    for field in &mut fields {
        field.behavior.present_when = Some(rules::Condition::new(move |bytes| {
            Ok(bytes[base + 0x2d] != 0)
        }));
        field.behavior.editable_when = Some(rules::Condition::new(move |bytes| {
            Ok(bytes[base + 0x2d] != 0)
        }));
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0; SAVE_SIZE];
        bytes[..16].copy_from_slice(b"CASTLEVANIA2-010");
        for slot in 0..3 {
            bytes[slot * SLOT_SIZE + 0x2d] = 1;
            bytes[slot * SLOT_SIZE + 0x1ac] = 1;
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some("castlevania-aria-of-sorrow".into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn edits_slot_and_preview_copies_without_touching_other_slots() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let result = handler
            .apply(
                &original,
                &identity,
                &[
                    SaveEdit {
                        field: "slot_2.level".into(),
                        value: SaveValue::U32(42),
                    },
                    SaveEdit {
                        field: "slot_2.gold".into(),
                        value: SaveValue::U32(123_456),
                    },
                ],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        let base = SLOT_SIZE;
        assert_eq!(result[base + 0x2d], 42);
        assert_eq!(result[base + 0x1ac], 42);
        assert_eq!(&result[base + 0x44..base + 0x48], &123_456u32.to_le_bytes());
        assert_eq!(
            &result[base + 0x1b4..base + 0x1b8],
            &123_456u32.to_le_bytes()
        );
        assert_eq!(&result[..base], &original.bytes[..base]);
        assert_eq!(
            &result[base + SLOT_SIZE..],
            &original.bytes[base + SLOT_SIZE..]
        );
    }

    #[test]
    fn rejects_invalid_signature_size_and_range() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bad_signature = input();
        bad_signature.bytes[0] ^= 1;
        assert!(
            handler
                .apply(&bad_signature, &identity, &[], false)
                .is_err()
        );
        let mut bad_size = input();
        bad_size.bytes.pop();
        assert!(handler.apply(&bad_size, &identity, &[], false).is_err());
        assert!(
            handler
                .apply(
                    &input(),
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.level".into(),
                        value: SaveValue::U32(100),
                    }],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn hides_and_rejects_edits_to_empty_slots() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut original = input();
        original.bytes[0x2d] = 0;
        original.bytes[0x1ac] = 0;
        let document = handler.parse(&original, &identity).unwrap();
        assert!(
            !document
                .fields
                .iter()
                .any(|field| field.id == "slot_1.level")
        );
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.level".into(),
                        value: SaveValue::U32(1),
                    }],
                    false
                )
                .is_err()
        );
    }
}
