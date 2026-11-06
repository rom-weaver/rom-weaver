use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;
use tracing::trace;

fn checksum(bytes: &[u8]) -> u32 {
    let (sum, xor) = sum_and_xor(bytes, 0..0x1fec);
    trace!(xor, sum, "computed ActRaiser checksum");
    (u32::from(xor) << 16) | u32::from(sum)
}

// Layout, regional offsets, write rules, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/actraiser/saveEditor
// Current layout and write rules: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/actraiser/saveEditor
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

const CITIES: [(&str, &str); 6] = [
    ("fillmore", "Fillmore"),
    ("bloodpool", "Bloodpool"),
    ("kasandora", "Kasandora"),
    ("aitos", "Aitos"),
    ("marahna", "Marahna"),
    ("northwall", "Northwall"),
];

// Offsets in this range move by the region shift; the rest of the save keeps one layout.
fn regional(offset: usize, shift: usize) -> usize {
    if (0x13b7..0x14b0).contains(&offset) {
        offset - shift
    } else {
        offset
    }
}

fn scalar(offset: usize, storage: Storage, mask: Option<u32>) -> Scalar {
    Scalar {
        offset,
        storage,
        mask,
    }
}

fn store(
    destination: Scalar,
    value: impl Fn(&[u8]) -> Result<i64> + Send + Sync + 'static,
) -> Store {
    Store {
        when: None,
        destination,
        value: ReadValue::new(value),
    }
}

fn on_edit(on_edit: Vec<Store>) -> field::FieldBehavior {
    field::FieldBehavior {
        on_edit,
        ..Default::default()
    }
}

// An act's cleared state is split between a byte counting cleared acts and the low bit of a separate flag byte; the field exposes the combined value the editor shows.
fn area_progression(id: &str, label: &str, byte: usize, flag: usize) -> FieldDefinition {
    catalog_field(id, label, byte, Storage::U8)
        .choices(choices(&[
            ("Act 1", 0),
            ("Act 1 cleared", 2),
            ("Act 2", 3),
            ("Act 2 cleared", 4),
        ]))
        .behavior(field::FieldBehavior {
            read: Some(ReadValue::new(move |bytes| {
                Ok(i64::from(bytes[byte]) * 2 + i64::from(bytes[flag] & 1))
            })),
            on_edit: vec![
                store(scalar(flag, Storage::U8, Some(1)), move |bytes| {
                    Ok(i64::from(bytes[byte] & 1))
                }),
                store(scalar(byte, Storage::U8, None), move |bytes| {
                    Ok(i64::from(bytes[byte] / 2))
                }),
            ],
            ..Default::default()
        })
}

fn extra_fields(shift: usize) -> Vec<FieldDefinition> {
    let japan = shift == 3;
    let at = |offset| regional(offset, shift);
    let magic = choices(&[
        ("None", 0),
        ("Magical Fire", 1),
        ("Magical Stardust", 2),
        ("Magical Aura", 3),
        ("Magical Light", 4),
    ]);
    let equipped_magic = at(0x145f);
    let magic_bytes: Vec<usize> = (0..4).map(|index| at(0x144c + index)).collect();
    let mut fields = vec![
        catalog_field(
            "master.lives",
            if japan {
                "Lives"
            } else {
                "Lives (stored 0-8, shown +1)"
            },
            at(0x145e),
            Storage::U8,
        )
        .min(i64::from(japan))
        .max(if japan { 9 } else { 8 }),
        catalog_field(
            "options.message_speed",
            "Message speed",
            0x13b1,
            Storage::U8,
        )
        .min(0)
        .max(if japan { 7 } else { 9 }),
        catalog_field(
            "master.equipped_magic",
            "Equipped magic slot",
            equipped_magic,
            Storage::U8,
        )
        .choices(choices(&[
            ("None", 0),
            ("Magic 1", 1),
            ("Magic 2", 2),
            ("Magic 3", 3),
            ("Magic 4", 4),
        ]))
        .behavior(on_edit(
            magic_bytes
                .iter()
                .enumerate()
                .map(|(index, offset)| {
                    store(scalar(*offset, Storage::U8, Some(0x80)), move |bytes| {
                        Ok(i64::from(usize::from(bytes[equipped_magic]) == index + 1))
                    })
                })
                .collect(),
        )),
        catalog_field("angel.hp", "Angel HP", at(0x1439), Storage::U8)
            .min(0)
            .max(24),
        catalog_field("angel.max_hp", "Angel maximum HP", at(0x143a), Storage::U8)
            .min(1)
            .max(24),
        catalog_field("angel.sp", "Angel SP", at(0x1435), Storage::U16Le)
            .min(0)
            .max(999),
        catalog_field(
            "angel.max_sp",
            "Angel maximum SP",
            at(0x1437),
            Storage::U16Le,
        )
        .min(0)
        .max(999),
    ];
    if shift != 0 {
        fields.push(
            catalog_field(
                "options.professional_mode",
                "Professional mode",
                0x1ff0,
                Storage::U24Be,
            )
            .choices(choices(&[("Locked", 0xff_ffff), ("Unlocked", 0x41_4354)])),
        );
    } else {
        fields.push(
            catalog_field("options.difficulty", "Difficulty", 0x13b6, Storage::U8).choices(
                choices(&[("None", 0), ("Beginner", 1), ("Normal", 2), ("Expert", 3)]),
            ),
        );
    }
    for (index, offset) in magic_bytes.iter().enumerate() {
        fields.push(
            catalog_field(
                &format!("master.magic_{}", index + 1),
                &format!("Magic {}", index + 1),
                *offset,
                Storage::U8,
            )
            .mask(0x7f)
            .choices(magic.clone()),
        );
    }
    for index in 0..8 {
        fields.push(
            catalog_field(
                &format!("items.item_{}", index + 1),
                &format!("Item {}", index + 1),
                at(0x1455 + index),
                Storage::U8,
            )
            .choices(choices(&[
                ("None", 0),
                ("Source of Life", 0x05),
                ("Source of Magic", 0x06),
                ("Loaf of Bread", 0x07),
                ("Wheat", 0x08),
                ("Herb", 0x09),
                ("Bridge", 0x0a),
                ("Harmonious Music", 0x0b),
                ("Ancient Tablet", 0x0d),
                ("Magic Skull", 0x0e),
                ("Sheep's Fleece", 0x0f),
                ("Bomb", 0x12),
                ("Compass", 0x13),
                ("Strength of Angel", 0x14),
            ])),
        );
    }
    // A non-decimal score digit hides every score instead of failing the whole document; upstream also opens such
    // saves because it decodes scores leniently.
    let scores = at(0x1466);
    let scores_decimal = Condition::new(move |bytes| {
        Ok(bytes[scores..scores + CITIES.len() * 4]
            .iter()
            .all(|byte| byte >> 4 <= 9 && byte & 15 <= 9))
    });
    for (index, (id, name)) in CITIES.iter().enumerate() {
        fields.push(area_progression(
            &format!("progression.{id}"),
            &format!("{name} progression"),
            0x1200 + index * 2,
            at(0x13b8 + index * 2),
        ));
        for (act, offset) in [(1, 0x1466), (2, 0x1468)] {
            fields.push(
                FieldDefinition {
                    length: Some(2),
                    ..catalog_field(
                        &format!("scores.{id}.act_{act}"),
                        &format!("{name} act {act} score (tens)"),
                        at(offset + index * 4),
                        Storage::BcdLe,
                    )
                }
                .min(0)
                .max(9999)
                .behavior(field::FieldBehavior {
                    present_when: Some(scores_decimal.clone()),
                    ..Default::default()
                }),
            );
        }
    }
    fields.push(
        catalog_field("progression.death_heim", "Death Heim", 0x120c, Storage::U8)
            .choices(choices(&[("Locked", 0), ("Unlocked", 1), ("Cleared", 4)]))
            .behavior(field::FieldBehavior {
                read: Some(ReadValue::new(|bytes| {
                    Ok(i64::from(bytes[0x120c]) + i64::from(bytes[0x1240] & 1))
                })),
                on_edit: vec![
                    store(scalar(0x1240, Storage::U8, Some(1)), |bytes| {
                        Ok(i64::from(bytes[0x120c] != 0))
                    }),
                    store(scalar(0x120c, Storage::U8, None), |bytes| {
                        Ok(if bytes[0x120c] == 4 { 3 } else { 0 })
                    }),
                ],
                ..Default::default()
            }),
    );
    fields
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
    let mut fields = vec![
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
    ];
    fields.extend(extra_fields(shift));
    GameDefinition {
        fields,
        description: format!(
            "Edits Master HP, level, MP, lives, magic, items, Angel HP and SP, area progression, scores, and options for {region}. Level edits update the regional next-level experience value; equipped magic, area progression, and Death Heim edits update their linked flag bytes. Angel HP and SP cannot exceed their stored maximums. Scores are absent when any score byte is not decimal. Names and city statistics are omitted. Select the save's region explicitly."
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
            edit_checks: vec![capacity_check(
                "Angel HP or SP exceeds its stored maximum".into(),
                [
                    (0x1439, 0x143a, Storage::U8),
                    (0x1435, 0x1437, Storage::U16Le),
                ]
                .into_iter()
                .map(|(current, maximum, storage)| {
                    (
                        scalar(regional(current, shift), storage, None),
                        scalar(regional(maximum, shift), storage, None),
                    )
                })
                .collect(),
            )],
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

    fn repair(bytes: &mut [u8]) {
        let sum = checksum(bytes);
        bytes[0x1fec..0x1ff0].copy_from_slice(&sum.to_le_bytes());
    }

    fn apply(handler: &SchemaSaveHandler, bytes: Vec<u8>, edits: &[SaveEdit]) -> Result<Vec<u8>> {
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        Ok(handler
            .apply(&input, &identity, edits, false)?
            .bytes
            .expect("edited bytes"))
    }

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    fn choice(name: &str) -> SaveValue {
        SaveValue::Enum(name.into())
    }

    #[test]
    fn regional_fields_write_their_shifted_bytes_and_linked_flags() {
        for (handler, shift) in schemas().into_iter().zip([0usize, 2, 3]) {
            let at = |offset: usize| {
                if (0x13b7..0x14b0).contains(&offset) {
                    offset - shift
                } else {
                    offset
                }
            };
            let mut bytes = vec![0; 8192];
            // Equipped-magic markers start on slots 1 and 3 so the edit has to clear them.
            bytes[at(0x144c)] = 0x81;
            bytes[at(0x144e)] = 0x83;
            repair(&mut bytes);
            let japan = shift == 3;
            let mut edits = vec![
                edit("master.lives", SaveValue::U32(if japan { 9 } else { 8 })),
                edit(
                    "options.message_speed",
                    SaveValue::U32(if japan { 7 } else { 9 }),
                ),
                edit("angel.hp", SaveValue::U32(20)),
                edit("angel.max_hp", SaveValue::U32(24)),
                edit("angel.sp", SaveValue::U32(500)),
                edit("angel.max_sp", SaveValue::U32(999)),
                edit("master.magic_1", choice("Magical Aura")),
                edit("master.equipped_magic", choice("Magic 2")),
                edit("items.item_3", choice("Herb")),
                edit("scores.aitos.act_2", SaveValue::U32(1234)),
                edit("progression.marahna", choice("Act 2")),
                edit("progression.northwall", choice("Act 2 cleared")),
                edit("progression.death_heim", choice("Cleared")),
            ];
            if shift == 0 {
                edits.push(edit("options.difficulty", choice("Expert")));
            } else {
                edits.push(edit("options.professional_mode", choice("Unlocked")));
            }
            let mut expected = bytes.clone();
            expected[at(0x145e)] = if japan { 9 } else { 8 };
            expected[0x13b1] = if japan { 7 } else { 9 };
            expected[at(0x1439)] = 20;
            expected[at(0x143a)] = 24;
            expected[at(0x1435)..at(0x1435) + 2].copy_from_slice(&500u16.to_le_bytes());
            expected[at(0x1437)..at(0x1437) + 2].copy_from_slice(&999u16.to_le_bytes());
            expected[at(0x144c)] = 0x03; // Equipping Magic 2 moves the marker off slots 1 and 3
            expected[at(0x144d)] = 0x80;
            expected[at(0x144e)] = 0x03;
            expected[at(0x145f)] = 2;
            expected[at(0x1457)] = 9;
            expected[at(0x1468 + 3 * 4)..at(0x1468 + 3 * 4) + 2].copy_from_slice(&[0x34, 0x12]);
            expected[0x1208] = 1;
            expected[at(0x13c0)] = 1;
            expected[0x120a] = 2;
            expected[at(0x13c2)] = 0;
            expected[0x120c] = 3;
            expected[0x1240] = 1;
            if shift == 0 {
                expected[0x13b6] = 3;
            } else {
                expected[0x1ff0..0x1ff3].copy_from_slice(b"ACT");
            }
            repair(&mut expected);
            assert_eq!(
                apply(&handler, bytes.clone(), &edits).unwrap(),
                expected,
                "shift {shift}"
            );
        }
    }

    #[test]
    fn angel_hp_and_sp_cannot_exceed_their_maximums() {
        let capacity_error = |result: Result<Vec<u8>>| {
            matches!(
                result,
                Err(crate::RomWeaverError::ValidationCode(error))
                    if error.code() == "save_resource_capacity"
            )
        };
        for (handler, shift) in schemas().into_iter().zip([0usize, 2, 3]) {
            let mut bytes = vec![0; 8192];
            bytes[0x1439 - shift] = 10;
            bytes[0x143a - shift] = 10;
            bytes[0x1435 - shift..0x1437 - shift].copy_from_slice(&500u16.to_le_bytes());
            bytes[0x1437 - shift..0x1439 - shift].copy_from_slice(&500u16.to_le_bytes());
            repair(&mut bytes);
            for edits in [
                vec![edit("angel.hp", SaveValue::U32(11))],
                vec![edit("angel.max_hp", SaveValue::U32(9))],
                vec![edit("angel.sp", SaveValue::U32(501))],
                vec![edit("angel.max_sp", SaveValue::U32(499))],
            ] {
                assert!(
                    capacity_error(apply(&handler, bytes.clone(), &edits)),
                    "shift {shift}: {}",
                    edits[0].field
                );
            }
            let raised = apply(
                &handler,
                bytes.clone(),
                &[
                    edit("angel.max_hp", SaveValue::U32(24)),
                    edit("angel.hp", SaveValue::U32(24)),
                ],
            )
            .unwrap();
            assert_eq!(raised[0x1439 - shift..0x143b - shift], [24, 24]);
            let mut over = bytes.clone();
            over[0x1439 - shift] = 11;
            repair(&mut over);
            assert!(capacity_error(apply(
                &handler,
                over,
                &[edit("master.hp", SaveValue::U32(5))]
            )));
        }
    }

    #[test]
    fn region_offsets_are_anchored_to_the_usa_layout() {
        let handler = schemas().remove(1);
        let mut bytes = vec![0; 8192];
        repair(&mut bytes);
        let mut expected = bytes.clone();
        expected[0x145c] = 3;
        expected[0x1464..0x1466].copy_from_slice(&[0x99, 0x09]);
        repair(&mut expected);
        let edits = [
            edit("master.lives", SaveValue::U32(3)),
            edit("scores.fillmore.act_1", SaveValue::U32(999)),
        ];
        assert_eq!(apply(&handler, bytes, &edits).unwrap(), expected);
    }

    #[test]
    fn area_and_death_heim_states_split_into_their_flag_bytes() {
        let handler = schemas().remove(0);
        let mut bytes = vec![0; 8192];
        bytes[0x1200] = 1;
        bytes[0x13b8] = 1;
        bytes[0x120c] = 3;
        bytes[0x1240] = 1;
        repair(&mut bytes);
        let document = handler
            .apply(
                &SaveDetectionInput {
                    bytes: bytes.clone(),
                    selected_game: Some(handler.definitions().remove(0).identity.id),
                    rom_sha1: None,
                },
                &handler.definitions().remove(0).identity,
                &[],
                false,
            )
            .unwrap()
            .document;
        let value = |id: &str| {
            document
                .fields
                .iter()
                .find(|field| field.id == id)
                .map(|field| field.value.clone())
        };
        assert_eq!(value("progression.fillmore"), Some(choice("Act 2")));
        assert_eq!(value("progression.death_heim"), Some(choice("Cleared")));
        let output = apply(
            &handler,
            bytes,
            &[
                edit("progression.fillmore", choice("Act 1")),
                edit("progression.death_heim", choice("Locked")),
            ],
        )
        .unwrap();
        let mut expected = vec![0; 8192];
        repair(&mut expected);
        assert_eq!(output, expected);
    }

    #[test]
    fn scores_and_ranges_reject_invalid_values() {
        let handler = schemas().remove(0);
        let mut bytes = vec![0; 8192];
        repair(&mut bytes);
        for (field, value) in [
            ("master.lives", SaveValue::U32(9)),
            ("options.message_speed", SaveValue::U32(10)),
            ("angel.hp", SaveValue::U32(25)),
            ("scores.fillmore.act_1", SaveValue::U32(10_000)),
            ("master.magic_1", choice("Magical Wind")),
        ] {
            assert!(
                apply(&handler, bytes.clone(), &[edit(field, value)]).is_err(),
                "{field}"
            );
        }
        let mut japan = vec![0; 8192];
        repair(&mut japan);
        assert!(
            apply(
                &schemas().remove(2),
                japan,
                &[edit("master.lives", SaveValue::U32(0))]
            )
            .is_err()
        );
    }

    #[test]
    fn decimal_scores_read_and_edit_and_a_non_decimal_score_hides_only_the_scores() {
        for (handler, shift) in schemas().into_iter().zip([0usize, 2, 3]) {
            let identity = handler.definitions().remove(0).identity;
            let document = |bytes: &[u8]| {
                let input = SaveDetectionInput {
                    bytes: bytes.to_vec(),
                    selected_game: Some(identity.id.clone()),
                    rom_sha1: None,
                };
                handler
                    .apply(&input, &identity, &[], false)
                    .unwrap()
                    .document
            };
            let score = |document: &SaveDocument| {
                document
                    .fields
                    .iter()
                    .find(|field| field.id == "scores.fillmore.act_1")
                    .map(|field| field.value.clone())
            };
            let mut bytes = vec![0; 8192];
            bytes[0x1466 - shift..0x1468 - shift].copy_from_slice(&[0x34, 0x12]);
            repair(&mut bytes);
            assert_eq!(score(&document(&bytes)), Some(SaveValue::U32(1234)));
            let output = apply(
                &handler,
                bytes.clone(),
                &[edit("scores.fillmore.act_1", SaveValue::U32(999))],
            )
            .unwrap();
            assert_eq!(output[0x1466 - shift..0x1468 - shift], [0x99, 0x09]);
            // The last score byte of the last city is the end of the checked range.
            bytes[0x147d - shift] = 0x0a;
            repair(&mut bytes);
            let hidden = document(&bytes);
            assert!(
                hidden
                    .fields
                    .iter()
                    .all(|field| !field.id.starts_with("scores."))
            );
            assert!(hidden.fields.iter().any(|field| field.id == "master.hp"));
            let mut expected = bytes.clone();
            expected[0x1246] = 20;
            repair(&mut expected);
            assert_eq!(
                apply(
                    &handler,
                    bytes.clone(),
                    &[edit("master.hp", SaveValue::U32(20))]
                )
                .unwrap(),
                expected
            );
            assert!(
                apply(
                    &handler,
                    bytes,
                    &[edit("scores.fillmore.act_1", SaveValue::U32(1))]
                )
                .is_err()
            );
        }
    }
}
