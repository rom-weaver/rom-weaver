use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

fn check(slot: usize) -> Check {
    Check {
        when: None,
        assert: Condition::new(move |bytes| {
            Ok(
                u32::from_be_bytes(bytes[slot + 0x1c..slot + 0x20].try_into().unwrap())
                    == crc32(&bytes[slot..slot + 0x1c]),
            )
        }),
        code: "mission_impossible_checksum".into(),
        message: "a Mission: Impossible slot checksum is invalid".into(),
        section_id: None,
        warning: None,
    }
}

// Layout and checksum rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/mission-impossible/saveEditor
// Controller options, unchanged at: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/mission-impossible/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    let mut stores = Vec::new();
    for index in 0..4 {
        let base = index * 0x20;
        for (id, label, offset, max) in [
            ("music", "music level", 0xd, 7),
            ("sfx", "SFX level", 0xc, 7),
            ("audio", "audio mode", 0xb, 2),
            ("ratio", "screen ratio", 0xe, 2),
        ] {
            fields.push(
                FieldDefinition::new(
                    format!("slot_{}.{id}", index + 1),
                    format!("Slot {} {label}", index + 1),
                    base + offset,
                    Storage::U8,
                )
                .max(max),
            );
        }
        // The slot CRC covers the controller bytes, so the existing CRC store repairs them.
        fields.push(
            FieldDefinition::new(
                format!("slot_{}.configuration", index + 1),
                format!("Slot {} controller configuration", index + 1),
                base + 0x11,
                Storage::U8,
            )
            .choices(choices(&[("right_handed", 0), ("left_handed", 1)]))
            .min(0)
            .max(1),
        );
        fields.push(
            FieldDefinition::new(
                format!("slot_{}.aiming_mode", index + 1),
                format!("Slot {} aiming mode", index + 1),
                base + 0x10,
                Storage::U8,
            )
            .choices(choices(&[("normal", 1), ("reverse", 0xff)]))
            .min(1)
            .max(0xff),
        );
        stores.push(Store {
            when: None,
            destination: Scalar {
                offset: base + 0x1c,
                storage: Storage::U32Be,
                mask: None,
            },
            value: ReadValue::new(move |bytes| Ok(i64::from(crc32(&bytes[base..base + 0x1c])))),
        });
    }
    let checks: Vec<_> = (0..4).map(|i| check(i * 0x20)).collect();
    let game = GameDefinition {
        fields,
        description: "Edits audio and display options in normalized 16 Kbit EEPROM. Requires a game-made template.".into(),
        signatures: vec![SignatureDefinition { offset: 0x12, bytes: b"IMF".to_vec() }],
        runtime: runtime::Runtime { require_selection: true, recognition: Some(runtime::Recognition { checks: checks.clone(), reasons: vec![SaveRecognitionReason::ChecksumValid, SaveRecognitionReason::SignatureValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }), checks, after_edit: stores, save_format: Some("n64_eeprom_16k".into()), save_format_name: Some("Nintendo 64 EEPROM 16 Kbit".into()), ..Default::default() },
        ..GameDefinition::new("mission-impossible".into(), "Mission: Impossible".into(), "nintendo-64".into(), 2048)
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0xa5; 2048];
        bytes[0x12..0x15].copy_from_slice(b"IMF");
        for base in (0..4).map(|index| index * 0x20) {
            let crc = crc32(&bytes[base..base + 0x1c]);
            bytes[base + 0x1c..base + 0x20].copy_from_slice(&crc.to_be_bytes());
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some("mission-impossible".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn edit_repairs_crc_and_preserves_tail() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "slot_2.music".into(),
                    value: SaveValue::U32(3),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[0x2d], 3);
        assert_eq!(&bytes[0x3c..0x40], &crc32(&bytes[0x20..0x3c]).to_be_bytes());
        assert_eq!(&bytes[0x80..], &original.bytes[0x80..]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[0x21] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    fn bitwise_crc32(bytes: &[u8]) -> u32 {
        let mut crc = u32::MAX;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn controller_fields_decode_edit_and_repair_every_slot_crc() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut original = input();
        for slot in 0..4 {
            original.bytes[slot * 0x20 + 0x10] = 1;
            original.bytes[slot * 0x20 + 0x11] = 0;
            let base = slot * 0x20;
            let crc = bitwise_crc32(&original.bytes[base..base + 0x1c]);
            original.bytes[base + 0x1c..base + 0x20].copy_from_slice(&crc.to_be_bytes());
        }
        let document = handler.parse(&original, &identity).unwrap();
        let value = |id: &str| {
            document
                .fields
                .iter()
                .find(|field| field.id == id)
                .unwrap()
                .value
                .clone()
        };
        assert_eq!(
            value("slot_3.aiming_mode"),
            SaveValue::Enum("normal".into())
        );
        assert_eq!(
            value("slot_3.configuration"),
            SaveValue::Enum("right_handed".into())
        );
        let edits: Vec<_> = (1..=4)
            .flat_map(|slot| {
                [
                    SaveEdit {
                        field: format!("slot_{slot}.aiming_mode"),
                        value: SaveValue::Enum("reverse".into()),
                    },
                    SaveEdit {
                        field: format!("slot_{slot}.configuration"),
                        value: SaveValue::Enum("left_handed".into()),
                    },
                ]
            })
            .collect();
        let bytes = handler
            .apply(&original, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        for slot in 0..4 {
            let base = slot * 0x20;
            assert_eq!(bytes[base + 0x10], 0xff);
            assert_eq!(bytes[base + 0x11], 1);
            assert_eq!(
                &bytes[base + 0x1c..base + 0x20],
                &bitwise_crc32(&bytes[base..base + 0x1c]).to_be_bytes()
            );
            for offset in (0..0x1c).filter(|offset| !matches!(offset, 0x10 | 0x11)) {
                assert_eq!(bytes[base + offset], original.bytes[base + offset]);
            }
        }
        assert_eq!(&bytes[0x80..], &original.bytes[0x80..]);
        let mut invalid = edits.clone();
        invalid[1].value = SaveValue::Enum("raw:2".into());
        assert!(
            handler
                .apply(&original, &identity, &invalid, false)
                .is_err()
        );
        let mut corrupt = original.clone();
        corrupt.bytes[0x60 + 0x10] ^= 0x80;
        assert!(handler.apply(&corrupt, &identity, &edits, false).is_err());
    }
}
