use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

fn checksum(bytes: &[u8], start: usize, length: usize) -> u16 {
    bytes[start..start + length]
        .iter()
        .fold(5u16, |sum, byte| sum.wrapping_add(u16::from(*byte)))
}

fn check(start: usize, length: usize, offset: usize) -> Check {
    Check {
        when: Some(Condition::new(move |bytes| {
            Ok(bytes[offset..offset + 2] != [0xff, 0xff])
        })),
        assert: Condition::new(move |bytes| {
            Ok(u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
                == checksum(bytes, start, length))
        }),
        code: "diddy_kong_racing_checksum".into(),
        message: "a Diddy Kong Racing record checksum is invalid".into(),
        section_id: None,
        warning: None,
    }
}

// Layout and checksum rules: https://github.com/DavidSM64/Diddy-Kong-Racing/blob/1339ad6304118207b342fe8669c500efb91969df/src/save_data.c
// Editor offsets: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/diddy-kong-racing/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for slot in 0..3 {
        let base = slot * 0x28;
        let occupied = Condition::new(move |bytes| Ok(bytes[base..base + 2] != [0xff, 0xff]));
        fields.push(
            FieldDefinition::new(
                format!("slot_{}.mode", slot + 1),
                format!("Slot {} Adventure Two", slot + 1),
                base + 0x24,
                Storage::Bit,
            )
            .bit(2)
            .behavior(field::FieldBehavior {
                editable_when: Some(occupied.clone()),
                ..Default::default()
            }),
        );
        fields.push(
            FieldDefinition::new(
                format!("slot_{}.wizpig_amulet", slot + 1),
                format!("Slot {} Wizpig amulet pieces", slot + 1),
                base + 0x13,
                Storage::U8,
            )
            .mask(0x07)
            .max(4)
            .behavior(field::FieldBehavior {
                editable_when: Some(occupied.clone()),
                ..Default::default()
            }),
        );
        fields.push(
            FieldDefinition::new(
                format!("slot_{}.balloons", slot + 1),
                format!("Slot {} balloons", slot + 1),
                base + 0xe,
                Storage::U8,
            )
            .mask(0xfe)
            .max(47)
            .behavior(field::FieldBehavior {
                editable_when: Some(occupied),
                ..Default::default()
            }),
        );
    }
    let ranges = [
        (2, 0x26, 0),
        (0x2a, 0x26, 0x28),
        (0x52, 0x26, 0x50),
        (0x82, 0xbe, 0x80),
        (0x142, 0xbe, 0x140),
    ];
    let checks: Vec<_> = ranges
        .iter()
        .map(|&(start, length, offset)| check(start, length, offset))
        .collect();
    let stores = ranges[..3]
        .iter()
        .map(|&(start, length, offset)| Store {
            when: Some(Condition::new(move |bytes| {
                Ok(bytes[offset..offset + 2] != [0xff, 0xff])
            })),
            destination: Scalar {
                offset,
                storage: Storage::U16Be,
                mask: None,
            },
            value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, start, length)))),
        })
        .collect();
    let game = GameDefinition {
        fields,
        description:
            "Edits Adventure slots in normalized 16 Kbit EEPROM. Requires a game-made template."
                .into(),
        runtime: runtime::Runtime {
            require_selection: true,
            recognition: Some(runtime::Recognition {
                checks: checks.clone(),
                reasons: vec![SaveRecognitionReason::ChecksumValid],
                confidence: SaveRecognitionConfidence::High,
                incomplete_confidence: None,
                selected_reason: true,
                empty_top_level_reasons: false,
            }),
            checks,
            after_edit: stores,
            save_format: Some("n64_eeprom_16k".into()),
            save_format_name: Some("Nintendo 64 EEPROM 16 Kbit".into()),
            ..Default::default()
        },
        ..GameDefinition::new(
            "diddy-kong-racing".into(),
            "Diddy Kong Racing".into(),
            "nintendo-64".into(),
            2048,
        )
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(bytes: &mut [u8]) {
        for (start, length, offset) in [
            (2, 0x26, 0),
            (0x2a, 0x26, 0x28),
            (0x52, 0x26, 0x50),
            (0x82, 0xbe, 0x80),
            (0x142, 0xbe, 0x140),
        ] {
            let sum = bytes[start..start + length]
                .iter()
                .fold(5u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
            bytes[offset..offset + 2].copy_from_slice(&sum.to_be_bytes());
        }
    }
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x24; 2048];
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("diddy-kong-racing".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn edit_repairs_slot_checksum_and_preserves_records() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "slot_1.wizpig_amulet".into(),
                    value: SaveValue::U32(3),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[0x13] & 7, 3);
        assert_ne!(&bytes[..2], &original.bytes[..2]);
        assert_eq!(&bytes[0x80..], &original.bytes[0x80..]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[4] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    #[test]
    fn empty_slots_skip_checksum_validation_and_stay_unchanged() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut original = input();
        original.bytes[0x28..0x50].fill(0xff);
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "slot_1.wizpig_amulet".into(),
                    value: SaveValue::U32(3),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&bytes[0x28..0x50], &original.bytes[0x28..0x50]);
    }
}
