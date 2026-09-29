use super::super::rules::{ReadValue, Scalar, Store};
use super::*;

// Layout and write rules: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/f-zero/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for (league, name) in ["Knight", "Queen", "King"].into_iter().enumerate() {
        fields.push(
            FieldDefinition::new(
                format!("master_class.{}", name.to_lowercase()),
                format!("{name} League Master Class unlocked"),
                0x1fa,
                Storage::Bit,
            )
            .bit(league as u8)
            .behavior(field::FieldBehavior {
                on_edit: vec![Store {
                    when: None,
                    destination: Scalar {
                        offset: 0x1fa,
                        storage: Storage::U8,
                        mask: Some(0xf0),
                    },
                    value: ReadValue::new(|bytes| Ok(i64::from(bytes[0x1fa] & 0xf))),
                }],
                ..Default::default()
            }),
        );
        for course in 0..5 {
            let course_base = league * 0xa7 + course * 0x21;
            let records = std::iter::once(("best_lap".to_owned(), 0x23 + course_base)).chain(
                (0..10).map(|rank| (format!("rank_{}", rank + 1), 0x5 + course_base + rank * 3)),
            );
            for (record, offset) in records {
                let prefix = format!("league_{}.course_{}.{record}", league + 1, course + 1);
                let label = format!("{name} course {} {record}", course + 1);
                for (part, delta, storage, max) in [
                    ("minutes", 0, Storage::U8, 9),
                    ("seconds", 1, Storage::BcdBe, 59),
                    ("hundredths", 2, Storage::BcdBe, 99),
                ] {
                    let mut field = FieldDefinition::new(
                        format!("{prefix}.{part}"),
                        format!("{label} {part}"),
                        offset + delta,
                        storage,
                    )
                    .min(0)
                    .max(max);
                    if delta == 0 {
                        field = field.mask(0xf);
                    } else {
                        field = field.length(1);
                    }
                    field = field.behavior(field::FieldBehavior {
                        on_edit: vec![Store {
                            when: None,
                            destination: Scalar {
                                offset,
                                storage: Storage::U8,
                                mask: Some(0x80),
                            },
                            value: ReadValue::new(move |bytes| {
                                let time = (u32::from(bytes[offset] & 0xf) << 16)
                                    | (u32::from(bytes[offset + 1]) << 8)
                                    | u32::from(bytes[offset + 2]);
                                Ok(i64::from(time != 0x95999))
                            }),
                        }],
                        ..Default::default()
                    });
                    fields.push(field);
                }
                fields.push(
                    FieldDefinition::new(
                        format!("{prefix}.car"),
                        format!("{label} car"),
                        offset,
                        Storage::U8,
                    )
                    .mask(0x30)
                    .choices(choices(&[
                        ("Blue Falcon", 0),
                        ("Wild Goose", 1),
                        ("Golden Fox", 2),
                        ("Fire Stingray", 3),
                    ]))
                    .behavior(field::FieldBehavior {
                        editable_when: Some(rules::Condition::new(move |bytes| {
                            Ok(bytes[offset] & 0x80 != 0)
                        })),
                        ..Default::default()
                    }),
                );
            }
        }
    }
    let game = GameDefinition {
        fields,
        description: "Edits league unlocks and course records in raw 2 KiB SRAM. Requires a game-made template.".into(),
        signatures: vec![SignatureDefinition { offset: 0, bytes: b"FZERO".to_vec() }],
        checksums: (0..3).map(|league| ChecksumDefinition {
            start: Some(0x5 + league * 0xa7), length: Some(0xa5),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 0xaa + league * 0xa7)
        }).collect(),
        ..GameDefinition::new("f-zero".into(), "F-Zero".into(), "snes".into(), 2048)
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        for league in 0..3 {
            let start = 5 + league * 0xa7;
            let sum = bytes[start..start + 0xa5]
                .iter()
                .map(|byte| u16::from(*byte))
                .sum::<u16>();
            bytes[start + 0xa5..start + 0xa7].copy_from_slice(&sum.to_le_bytes());
        }
    }

    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0; 2048];
        bytes[..5].copy_from_slice(b"FZERO");
        bytes[0x1fa] = 0x88;
        bytes[512..].fill(0xa5);
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("f-zero".into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn edits_records_and_unlocks_with_source_write_rules() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let mut expected = original.bytes.clone();
        expected[5] = 0x80 | 2;
        expected[6] = 0x45;
        expected[7] = 0x67;
        expected[0x1fa] = 0x99;
        repair(&mut expected);
        let result = handler
            .apply(
                &original,
                &identity,
                &[
                    SaveEdit {
                        field: "league_1.course_1.rank_1.minutes".into(),
                        value: SaveValue::U32(2),
                    },
                    SaveEdit {
                        field: "league_1.course_1.rank_1.seconds".into(),
                        value: SaveValue::U32(45),
                    },
                    SaveEdit {
                        field: "league_1.course_1.rank_1.hundredths".into(),
                        value: SaveValue::U32(67),
                    },
                    SaveEdit {
                        field: "master_class.knight".into(),
                        value: SaveValue::Bool(true),
                    },
                ],
                false,
            )
            .unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[SaveEdit {
                        field: "league_1.course_1.rank_1.seconds".into(),
                        value: SaveValue::U32(60)
                    },],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn sentinel_clears_record_and_preserves_car_and_other_bits() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut original = input();
        original.bytes[5..8].copy_from_slice(&[0xf2, 0x34, 0x56]);
        repair(&mut original.bytes);
        let mut expected = original.bytes.clone();
        expected[5..8].copy_from_slice(&[0x79, 0x59, 0x99]);
        repair(&mut expected);
        let result = handler
            .apply(
                &original,
                &identity,
                &[
                    SaveEdit {
                        field: "league_1.course_1.rank_1.minutes".into(),
                        value: SaveValue::U32(9),
                    },
                    SaveEdit {
                        field: "league_1.course_1.rank_1.seconds".into(),
                        value: SaveValue::U32(59),
                    },
                    SaveEdit {
                        field: "league_1.course_1.rank_1.hundredths".into(),
                        value: SaveValue::U32(99),
                    },
                ],
                false,
            )
            .unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
        let mut bad = original.clone();
        bad.bytes[0xaa] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = original.clone();
        bad.bytes[0] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        let dry = handler.apply(&original, &identity, &[], true).unwrap();
        assert!(dry.bytes.is_none());
        assert!(handler.generate(&identity).is_err());
    }
}
