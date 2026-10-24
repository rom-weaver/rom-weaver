use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

const SLOT_SIZE: usize = 0x38c;

fn checksum(bytes: &[u8], base: usize) -> u16 {
    (base + 6..base + SLOT_SIZE)
        .step_by(2)
        .fold(0u32, |sum, offset| {
            (sum + u32::from(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))) % 0xffff
        }) as u16
}

// Layout, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/mystic-quest-legend/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3).map(|slot| {
        let base = slot * SLOT_SIZE;
        let check = Check { when: None, assert: Condition::new(move |bytes| Ok(u16::from_le_bytes([bytes[base + 4], bytes[base + 5]]) == checksum(bytes, base))), code: "mystic_quest_checksum".into(), message: "the Mystic Quest slot checksum is invalid".into(), section_id: None, warning: None };
        GameDefinition {
            fields: vec![
                catalog_field("money", "Money", base + 0xa6, Storage::U24Le).min(0).max(9_999_999),
                catalog_field("location", "Location code", base + 0xb3, Storage::U8),
                catalog_field("party.hero.level", "Hero level", base + 0x16, Storage::U8).min(1).max(41),
            ],
            description: format!("Edits independent scalar fields in slot {}. Equipment, spell, and inventory changes with coupled rules are omitted.", slot + 1),
            signatures: vec![SignatureDefinition { offset: base, bytes: b"FF0!".to_vec() }],
            runtime: runtime::Runtime { recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: base + 4, storage: Storage::U16Le, mask: None }, value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))) }], ..Default::default() },
            ..GameDefinition::new(format!("mystic-quest-legend-slot-{}", slot + 1), format!("Mystic Quest Legend (Slot {})", slot + 1), "snes".into(), 8192)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edit_repairs_modulo_checksum_and_preserves_other_slots() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0xa5; 8192];
        bytes[..4].copy_from_slice(b"FF0!");
        let sum = checksum(&bytes, 0);
        bytes[4..6].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0xa6..0xa9].copy_from_slice(&[0x56, 0x34, 0x12]);
        let sum = checksum(&expected, 0);
        expected[4..6].copy_from_slice(&sum.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "money".into(),
                    value: SaveValue::U32(0x123456),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(output, expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[6] ^= 1;
        assert!(matches!(
            handler.recognize(&bad).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
