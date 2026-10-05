use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

fn checksum(bytes: &[u8]) -> u32 {
    let (xor, sum) = (0..0x1fec)
        .step_by(2)
        .fold((0u16, 0u16), |(xor, sum), offset| {
            let word = u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
            (xor ^ word, sum.wrapping_add(word))
        });
    (u32::from(xor) << 16) | u32::from(sum)
}

// Layout, regional offsets, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/actraiser/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(
        [
            ("europe", "Europe/France/Germany", 0usize),
            ("usa", "USA", 2),
            ("japan", "Japan", 3),
        ]
        .into_iter()
        .map(|(id, region, shift)| game(id, region, shift))
        .collect(),
        BTreeMap::new(),
        true,
    )
}

fn game(id: &str, region: &str, shift: usize) -> GameDefinition {
    let level_offset = 0x1444 - shift;
    let experience = if shift == 3 {
        [
            80, 200, 400, 550, 650, 750, 1050, 1400, 1600, 1800, 1900, 2000, 2200, 2400, 2600,
            3000, 0,
        ]
    } else {
        [
            80, 200, 400, 700, 950, 1200, 1500, 1700, 1900, 2200, 2500, 2900, 3300, 3700, 4100,
            4600, 0,
        ]
    };
    let check = Check {
        when: None,
        assert: Condition::new(|bytes| {
            Ok(u32::from_le_bytes(bytes[0x1fec..0x1ff0].try_into().unwrap()) == checksum(bytes))
        }),
        code: "actraiser_checksum".into(),
        message: "the ActRaiser checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    GameDefinition {
        fields: vec![
            catalog_field("master.hp", "Master HP", 0x1246, Storage::U8)
                .min(1)
                .max(24),
            catalog_field("master.level", "Master level", level_offset, Storage::U8)
                .min(1)
                .max(17)
                .behavior(field::FieldBehavior {
                    on_edit: vec![Store {
                        when: None,
                        destination: Scalar {
                            offset: level_offset + 6,
                            storage: Storage::U16Le,
                            mask: None,
                        },
                        value: ReadValue::new(move |bytes| {
                            let index = usize::from(bytes[level_offset])
                                .checked_sub(1)
                                .ok_or_else(|| invalid("ActRaiser level must be from 1 to 17"))?;
                            experience
                                .get(index)
                                .copied()
                                .ok_or_else(|| invalid("ActRaiser level must be from 1 to 17"))
                        }),
                    }],
                    ..Default::default()
                }),
            catalog_field("master.mp", "Master MP", 0x1448 - shift, Storage::U16Le)
                .min(0)
                .max(10),
        ],
        description: format!(
            "Edits Master HP, level, and MP for {region}. Level edits update the regional next-level experience value. Select the save's region explicitly."
        ),
        runtime: runtime::Runtime {
            recognition: Some(runtime::Recognition {
                checks: vec![check.clone()],
                reasons: vec![SaveRecognitionReason::ChecksumValid],
                confidence: SaveRecognitionConfidence::High,
                incomplete_confidence: None,
                selected_reason: true,
                empty_top_level_reasons: true,
            }),
            checks: vec![check],
            after_edit: vec![Store {
                when: None,
                destination: Scalar {
                    offset: 0x1fec,
                    storage: Storage::U32Le,
                    mask: None,
                },
                value: ReadValue::new(|bytes| Ok(i64::from(checksum(bytes)))),
            }],
            ..Default::default()
        },
        ..GameDefinition::new(
            format!("actraiser-{id}"),
            format!("ActRaiser ({region})"),
            "snes".into(),
            8192,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checksum_matches_reference_vector() {
        let bytes: Vec<u8> = (0..8192).map(|offset| offset as u8).collect();
        assert_eq!(checksum(&bytes), 0x0202_4a6e);
    }

    #[test]
    fn levels_update_each_regions_experience_at_the_shifted_offset() {
        for (handler, shift, experience) in schemas()
            .into_iter()
            .zip([0, 2, 3])
            .zip([700u16, 700, 550])
            .map(|((handler, shift), exp)| (handler, shift, exp))
        {
            let identity = handler.definitions().remove(0).identity;
            let mut bytes = vec![0; 8192];
            bytes[0x1444 - shift] = 1;
            let sum = checksum(&bytes);
            bytes[0x1fec..0x1ff0].copy_from_slice(&sum.to_le_bytes());
            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            let result = handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "master.level".into(),
                        value: SaveValue::U32(4),
                    }],
                    false,
                )
                .unwrap()
                .bytes
                .unwrap();
            let mut expected = input.bytes.clone();
            expected[0x1444 - shift] = 4;
            expected[0x144a - shift..0x144c - shift].copy_from_slice(&experience.to_le_bytes());
            let sum = checksum(&expected);
            expected[0x1fec..0x1ff0].copy_from_slice(&sum.to_le_bytes());
            assert_eq!(result, expected);
        }
    }
    #[test]
    fn edits_stable_fields_and_repairs_packed_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x5a; 8192];
        let sum = checksum(&bytes);
        bytes[0x1fec..0x1ff0].copy_from_slice(&sum.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x1246] = 20;
        let sum = checksum(&expected);
        expected[0x1fec..0x1ff0].copy_from_slice(&sum.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "master.hp".into(),
                    value: SaveValue::U32(20),
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
        bad.bytes[0] ^= 1;
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
