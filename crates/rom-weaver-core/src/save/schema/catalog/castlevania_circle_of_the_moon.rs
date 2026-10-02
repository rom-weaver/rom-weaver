use super::*;

const SAVE_SIZE: usize = 0x8000;
const SLOT_SIZE: usize = 0x3d0;
const SLOT_COUNT: usize = 8;

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/castlevania-circle-of-the-moon/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let fields = (0..SLOT_COUNT).flat_map(slot_fields).collect();
    let mut game = GameDefinition {
        fields,
        description: concat!(
            "Edits documented scalar fields in all eight slots of a raw 32 KiB GBA save. ",
            "Repairs each slot byte-sum checksum. Collection containers and header-shifted ",
            "variants are rejected."
        )
        .into(),
        signatures: vec![SignatureDefinition {
            offset: 0,
            bytes: b"DRACULA AGB".to_vec(),
        }],
        ..GameDefinition::new(
            "castlevania-circle-of-the-moon".into(),
            "Castlevania: Circle of the Moon".into(),
            "gba".into(),
            SAVE_SIZE,
        )
    };
    game.runtime.layout = Some(layout::Layout {
        groups: (0..SLOT_COUNT).map(slot_group).collect(),
    });
    build(vec![game], BTreeMap::new(), true)
}

fn slot_checksum(base: usize) -> ChecksumDefinition {
    ChecksumDefinition {
        start: Some(base + 0x10),
        length: Some(SLOT_SIZE),
        exclude: vec![ChecksumExclusion {
            offset: base + 0x19,
            length: 1,
        }],
        ..ChecksumDefinition::new(ChecksumAlgorithm::Add8, base + 0x19)
    }
}

fn slot_group(slot: usize) -> layout::Group {
    let base = slot * SLOT_SIZE;
    let signatures = if slot == 0 {
        vec![layout::Signature {
            offset: 0,
            bytes: b"DRACULA AGB".to_vec(),
        }]
    } else {
        Vec::new()
    };
    let span = layout::Span {
        logical_offset: base + 0x10,
        physical_offset: base + 0x10,
        length: SLOT_SIZE,
    };
    let inactive = layout::Candidate {
        spans: vec![span],
        signatures: signatures.clone(),
        predicates: vec![rules::Condition::new(move |bytes| {
            Ok(bytes[base + 0x10] == 0)
        })],
        ..Default::default()
    };
    let checksum = slot_checksum(base);
    let active = layout::Candidate {
        spans: vec![span],
        signatures,
        predicates: vec![rules::Condition::new(move |bytes| {
            Ok(bytes[base + 0x10] != 0)
        })],
        checksums: vec![checksum.clone()],
        repairs: vec![layout::Repair::Checksum { checksum }],
        ..Default::default()
    };
    layout::Group {
        id: format!("slot_{}", slot + 1),
        logical_offset: base + 0x10,
        logical_length: SLOT_SIZE,
        copies: layout::Copies::Fixed {
            candidates: vec![inactive, active],
        },
        selection: layout::Selection::FirstValid,
        write: layout::WritePolicy::Selected,
        empty: Vec::new(),
        empty_if_no_signature: false,
    }
}

fn slot_fields(slot: usize) -> Vec<FieldDefinition> {
    let base = slot * SLOT_SIZE;
    let prefix = format!("slot_{}", slot + 1);
    let label = format!("Slot {}", slot + 1);
    let mut fields = vec![
        FieldDefinition::new(
            format!("{prefix}.playtime_frames"),
            format!("{label} playtime frames"),
            base + 0xa0,
            Storage::U32Le,
        )
        .description("The game stores playtime at 60 frames per second.".into()),
        FieldDefinition::new(
            format!("{prefix}.level"),
            format!("{label} level"),
            base + 0x30c,
            Storage::U8,
        )
        .min(1)
        .max(99),
        FieldDefinition::new(
            format!("{prefix}.experience"),
            format!("{label} experience"),
            base + 0x310,
            Storage::U32Le,
        )
        .max(99_999_999),
        FieldDefinition::new(
            format!("{prefix}.hp"),
            format!("{label} HP"),
            base + 0x2d6,
            Storage::U16Le,
        )
        .min(1)
        .max(9_999),
        FieldDefinition::new(
            format!("{prefix}.mp"),
            format!("{label} MP"),
            base + 0x2de,
            Storage::U16Le,
        )
        .max(9_999),
        FieldDefinition::new(
            format!("{prefix}.hearts"),
            format!("{label} hearts"),
            base + 0x2e4,
            Storage::U16Le,
        )
        .max(999),
        FieldDefinition::new(
            format!("{prefix}.bonus_hp_tanks"),
            format!("{label} HP bonus pickups"),
            base + 0x3d5,
            Storage::U8,
        )
        .description("Each stored pickup adds 10 HP.".into()),
        FieldDefinition::new(
            format!("{prefix}.bonus_mp_tanks"),
            format!("{label} MP bonus pickups"),
            base + 0x3d6,
            Storage::U8,
        )
        .description("Each stored pickup adds 10 MP.".into()),
        FieldDefinition::new(
            format!("{prefix}.bonus_heart_tanks"),
            format!("{label} heart bonus pickups"),
            base + 0x3d4,
            Storage::U8,
        )
        .description("Each stored pickup adds 6 hearts.".into()),
        FieldDefinition::new(
            format!("{prefix}.subweapon"),
            format!("{label} subweapon"),
            base + 0x2e8,
            Storage::U8,
        ),
        FieldDefinition::new(
            format!("{prefix}.dss_action"),
            format!("{label} DSS action"),
            base + 0x315,
            Storage::U8,
        ),
        FieldDefinition::new(
            format!("{prefix}.dss_attribute"),
            format!("{label} DSS attribute"),
            base + 0x314,
            Storage::U8,
        ),
    ];
    for field in &mut fields {
        field.behavior.group = Some(prefix.clone());
        field.behavior.present_when = Some(rules::Condition::new(move |bytes| {
            Ok(bytes[base + 0x10] != 0)
        }));
        field.behavior.editable_when = Some(rules::Condition::new(move |bytes| {
            Ok(bytes[base + 0x10] != 0)
        }));
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        for slot in 0..SLOT_COUNT {
            let base = slot * SLOT_SIZE;
            bytes[base + 0x19] = 0;
            bytes[base + 0x19] = bytes[base + 0x10..base + 0x10 + SLOT_SIZE]
                .iter()
                .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
        }
    }

    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0; SAVE_SIZE];
        bytes[..11].copy_from_slice(b"DRACULA AGB");
        bytes[0x10..SLOT_COUNT * SLOT_SIZE].fill(1);
        bytes[..11].copy_from_slice(b"DRACULA AGB");
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("castlevania-circle-of-the-moon".into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn edits_one_slot_repairs_its_checksum_and_preserves_other_slots() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let base = 3 * SLOT_SIZE;
        let result = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "slot_4.experience".into(),
                    value: SaveValue::U32(7_654_321),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(
            &result[base + 0x310..base + 0x314],
            &7_654_321u32.to_le_bytes()
        );
        let mut expected = original.bytes.clone();
        expected[base + 0x310..base + 0x314].copy_from_slice(&7_654_321u32.to_le_bytes());
        repair(&mut expected);
        assert_eq!(result, expected);
        assert_eq!(&result[..base], &original.bytes[..base]);
        assert_eq!(
            &result[base + SLOT_SIZE..],
            &original.bytes[base + SLOT_SIZE..]
        );
    }

    #[test]
    fn rejects_bad_checksum_signature_size_and_range() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bad_checksum = input();
        bad_checksum.bytes[0x30] ^= 1;
        assert!(
            handler
                .apply(
                    &bad_checksum,
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.level".into(),
                        value: SaveValue::U32(2),
                    }],
                    false
                )
                .is_err()
        );
        let mut bad_signature = input();
        bad_signature.bytes[0] ^= 1;
        repair(&mut bad_signature.bytes);
        assert!(
            handler
                .apply(
                    &bad_signature,
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.level".into(),
                        value: SaveValue::U32(2),
                    }],
                    false,
                )
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
    fn preserves_inactive_slot_with_bad_checksum_and_rejects_its_edits() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut original = input();
        let base = 5 * SLOT_SIZE;
        original.bytes[base + 0x10] = 0;
        original.bytes[base + 0x19] = 0xa5;
        let before = original.bytes[base + 0x10..base + 0x10 + SLOT_SIZE].to_vec();
        let result = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "slot_1.level".into(),
                    value: SaveValue::U32(2),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&result[base + 0x10..base + 0x10 + SLOT_SIZE], before);
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[SaveEdit {
                        field: "slot_6.level".into(),
                        value: SaveValue::U32(2),
                    }],
                    false
                )
                .is_err()
        );
    }
}
