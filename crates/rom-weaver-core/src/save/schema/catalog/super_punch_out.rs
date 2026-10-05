use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

fn checksum(bytes: &[u8], base: usize) -> u16 {
    let start = base + 0x104;
    let sum = (start..base + 0x180).fold(0u32, |sum, offset| {
        sum + u32::from(bytes[offset])
            + if offset > start {
                (offset - 4) as u32
            } else {
                0
            }
    });
    (sum as u16) ^ 0xff
}

// Layout, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/super-punch-out/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..8).map(|slot| {
        let base = slot * 0x80;
        let checksum_offset = base + 0x101;
        let check = Check { when: None, assert: Condition::new(move |bytes| Ok(u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]) == checksum(bytes, base))), code: "super_punch_out_checksum".into(), message: "the Super Punch-Out!! slot checksum is invalid".into(), section_id: None, warning: None };
        GameDefinition {
            fields: vec![
                catalog_field("losses", "Losses", base + 0x17f, Storage::U8),
                catalog_field("wins", "Wins", base + 0x17e, Storage::U8).editable(false).description("Read-only because lowering wins can also change the beaten-opponents mask.".into()),
                catalog_field("championship_progression", "Championship progression code", base + 0x104, Storage::U8).editable(false),
            ],
            description: format!("Edits the independent loss counter in profile {}. Names, wins, opponent flags, and records are omitted because they use coupled or packed write rules.", slot + 1),
            signatures: vec![SignatureDefinition { offset: base + 0x100, bytes: vec![1] }],
            runtime: runtime::Runtime { recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: checksum_offset, storage: Storage::U16Le, mask: None }, value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))) }], ..Default::default() },
            ..GameDefinition::new(format!("super-punch-out-slot-{}", slot + 1), format!("Super Punch-Out!! (Profile {})", slot + 1), "snes".into(), 8192)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_matches_reference_vectors_in_first_and_last_slots() {
        let bytes: Vec<u8> = (0..8192).map(|offset| offset as u8).collect();
        assert_eq!(checksum(&bytes, 0), 0xb87b);
        assert_eq!(checksum(&bytes, 7 * 0x80), 0xa5fb);
    }
    #[test]
    fn edit_repairs_position_weighted_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x22; 8192];
        bytes[0x100] = 1;
        let sum = checksum(&bytes, 0);
        bytes[0x101..0x103].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x17f] = 9;
        let sum = checksum(&expected, 0);
        expected[0x101..0x103].copy_from_slice(&sum.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "losses".into(),
                    value: SaveValue::U32(9),
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
        bad.bytes[0x110] ^= 1;
        assert!(matches!(
            handler.recognize(&bad).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
