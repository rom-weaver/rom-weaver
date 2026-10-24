use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

const SLOT_SIZE: usize = 0xa00;

fn checksum(bytes: &[u8], base: usize) -> u16 {
    (base..base + SLOT_SIZE)
        .step_by(2)
        .fold(0u32, |sum, offset| {
            (sum + u32::from(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]))) % 0xffff
        }) as u16
}

// Layout, slot markers, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/chrono-trigger/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3).map(|slot| {
        let base = slot * SLOT_SIZE;
        let checksum_offset = 0x1ff0 + slot * 2;
        let check = Check { when: None, assert: Condition::new(move |bytes| Ok(u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]) == checksum(bytes, base))), code: "chrono_trigger_checksum".into(), message: "the Chrono Trigger slot checksum is invalid".into(), section_id: None, warning: None };
        GameDefinition {
            fields: vec![
                catalog_field("gold", "Gold", base + 0x5e0, Storage::U24Le).min(0).max(9_999_999),
                catalog_field("inventory.first_item", "First inventory item code", base + 0x2c5, Storage::U8).editable(false),
            ],
            description: format!("Edits independent scalar fields in slot {}. Character levels, locations, inventory pairs, and progression are omitted because they have coupled write rules.", slot + 1),
            signatures: vec![SignatureDefinition { offset: 0x1ff8 + slot * 2, bytes: vec![0x1b, 0xe4] }],
            runtime: runtime::Runtime { recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: checksum_offset, storage: Storage::U16Le, mask: None }, value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))) }], ..Default::default() },
            ..GameDefinition::new(format!("chrono-trigger-slot-{}", slot + 1), format!("Chrono Trigger (Slot {})", slot + 1), "snes".into(), 8192)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_matches_reference_vector_and_end_around_carry() {
        let bytes: Vec<u8> = (0..8192).map(|offset| offset as u8).collect();
        assert_eq!(checksum(&bytes, 0), 0x7d82);
        assert_eq!(checksum(&bytes, 0x1400), 0x7d82);
        assert_eq!(checksum(&vec![0xff; 8192], 0), 0);
    }
    #[test]
    fn edit_repairs_slot_checksum_and_preserves_system_area() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x33; 8192];
        bytes[0x1ff8..0x1ffa].copy_from_slice(&[0x1b, 0xe4]);
        let sum = checksum(&bytes, 0);
        bytes[0x1ff0..0x1ff2].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x5e0..0x5e3].copy_from_slice(&[0x56, 0x34, 0x12]);
        let sum = checksum(&expected, 0);
        expected[0x1ff0..0x1ff2].copy_from_slice(&sum.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "gold".into(),
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
        bad.bytes[9] ^= 1;
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
