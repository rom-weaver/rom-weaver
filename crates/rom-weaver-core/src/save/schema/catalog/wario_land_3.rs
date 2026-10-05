use super::super::rules::{Condition, ReadValue, Scalar, Store};
use super::*;

fn power(id: &str, label: &str, level: u8) -> FieldDefinition {
    // Each control uses a distinct request bit, then stores the sequential upgrade level.
    FieldDefinition::new(id.into(), label.into(), 0x3c0, Storage::Bit)
        .bit(level - 1)
        .behavior(field::FieldBehavior {
            read: Some(ReadValue::new(move |bytes| {
                Ok(i64::from(bytes[0x3c0] >= level))
            })),
            on_edit: vec![Store {
                when: None,
                destination: Scalar {
                    offset: 0x3c0,
                    storage: Storage::U8,
                    mask: None,
                },
                value: ReadValue::new(move |bytes| {
                    Ok(i64::from(if bytes[0x3c0] & (1 << (level - 1)) != 0 {
                        level
                    } else {
                        level - 1
                    }))
                }),
            }],
            ..Default::default()
        })
}

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/wario-land-3/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let fields = vec![
        catalog_field("coins_bcd", "Coins (packed BCD)", 0x388, Storage::BcdBe)
            .length(2)
            .min(0)
            .max(999),
        catalog_field("language", "Language", 0x3ca, Storage::U8)
            .min(0)
            .max(4),
        catalog_field(
            "time_of_day",
            "Time of day (0: day, 1: night)",
            0x3bf,
            Storage::U8,
        )
        .min(0)
        .max(1)
        .behavior(field::FieldBehavior {
            editable_when: Some(Condition::new(|bytes| {
                Ok(matches!(bytes[0x3bf], 0 | 0x11 | 0x80 | 0x91 | 0x81 | 0x90))
            })),
            read: Some(ReadValue::new(|bytes| {
                Ok(match bytes[0x3bf] {
                    0 | 0x81 | 0x91 => 0,
                    0x11 | 0x80 | 0x90 => 1,
                    raw => i64::from(raw),
                })
            })),
            // XOR with the family's day code preserves its encoding. Night also toggles bit 4.
            xor: Some(ReadValue::new(|bytes| {
                Ok(match bytes[0x3bf] {
                    0x80 | 0x91 => 0x91,
                    0x81 | 0x90 => 0x81,
                    _ => 0,
                })
            })),
            on_edit: vec![Store {
                when: None,
                destination: Scalar {
                    offset: 0x3bf,
                    storage: Storage::U8,
                    mask: None,
                },
                value: ReadValue::new(|bytes| {
                    Ok(i64::from(match bytes[0x3bf] {
                        raw @ (1 | 0x80 | 0x90) => raw ^ 0x10,
                        raw => raw,
                    }))
                }),
            }],
            ..Default::default()
        }),
        power("power.ground_pound", "Ground Pound acquired", 1),
        power("power.swim", "Swim acquired", 2),
        power("power.head_smash", "Head Smash acquired", 3),
    ];
    build(
        vec![GameDefinition {
            fields,
            description:
                "Edits the World Map save block. Mid-level saves are intentionally rejected.".into(),
            signatures: vec![
                SignatureDefinition {
                    offset: 0,
                    bytes: vec![0; 4],
                },
                SignatureDefinition {
                    offset: 0x380,
                    bytes: b"war3".to_vec(),
                },
            ],
            checksums: vec![ChecksumDefinition {
                start: Some(0x384),
                length: Some(0x6c),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 0x791)
            }],
            ..GameDefinition::new(
                "wario-land-3".into(),
                "Wario Land 3".into(),
                "game-boy-color".into(),
                32768,
            )
        }],
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(bytes: &mut [u8]) {
        let sum = bytes[0x384..0x3f0]
            .iter()
            .fold(0u16, |s, b| s.wrapping_add(u16::from(*b)));
        bytes[0x791..0x793].copy_from_slice(&sum.to_be_bytes());
    }
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x5a; 32768];
        bytes[..4].fill(0);
        bytes[0x380..0x384].copy_from_slice(b"war3");
        bytes[0x388..0x38a].copy_from_slice(&[0x01, 0x23]);
        bytes[0x3bf] = 0x81;
        bytes[0x3c0] = 1;
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("wario-land-3".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn edits_bcd_and_sequential_power_level_and_repairs_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let input = input();
        let out = handler
            .apply(
                &input,
                &identity,
                &[
                    SaveEdit {
                        field: "coins_bcd".into(),
                        value: SaveValue::U32(987),
                    },
                    SaveEdit {
                        field: "power.swim".into(),
                        value: SaveValue::Bool(true),
                    },
                ],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&out[0x388..0x38a], &[0x09, 0x87]);
        assert_eq!(out[0x3c0], 2);
        assert_eq!(&out[0x793..], &input.bytes[0x793..]);
        let sum = out[0x384..0x3f0]
            .iter()
            .fold(0u16, |s, b| s.wrapping_add(u16::from(*b)));
        assert_eq!(&out[0x791..0x793], &sum.to_be_bytes());
        let mut bad = input.clone();
        bad.bytes[0x791] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
    }

    #[test]
    fn day_night_edits_preserve_all_three_encoding_families() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        for (day, night) in [(0, 0x11), (0x91, 0x80), (0x81, 0x90)] {
            for (before, value, expected_code) in [(day, 1, night), (night, 0, day)] {
                let mut input = input();
                input.bytes[0x3bf] = before;
                repair(&mut input.bytes);
                let mut expected = input.bytes.clone();
                expected[0x3bf] = expected_code;
                repair(&mut expected);
                let output = handler
                    .apply(
                        &input,
                        &identity,
                        &[SaveEdit {
                            field: "time_of_day".into(),
                            value: SaveValue::U32(value),
                        }],
                        false,
                    )
                    .unwrap()
                    .bytes
                    .unwrap();
                assert_eq!(output, expected);
            }
        }
        assert!(
            handler
                .apply(
                    &input(),
                    &identity,
                    &[SaveEdit {
                        field: "time_of_day".into(),
                        value: SaveValue::U32(2),
                    }],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn removing_an_upgrade_removes_every_later_upgrade() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        for (field, expected_level) in [
            ("power.ground_pound", 0),
            ("power.swim", 1),
            ("power.head_smash", 2),
        ] {
            let mut input = input();
            input.bytes[0x3c0] = 3;
            repair(&mut input.bytes);
            let mut expected = input.bytes.clone();
            expected[0x3c0] = expected_level;
            repair(&mut expected);
            let output = handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: field.into(),
                        value: SaveValue::Bool(false),
                    }],
                    false,
                )
                .unwrap()
                .bytes
                .unwrap();
            assert_eq!(output, expected);
        }
    }
}
