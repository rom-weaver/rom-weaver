use super::*;

// Layout, byte order, record selection, and checksums:
// https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/final-fight-one/saveEditor
// https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/super-street-fighter-ii-turbo-revival/saveEditor

#[derive(Clone, Copy)]
enum Game {
    FinalFight,
    StreetFighter,
}

impl Game {
    fn checksum(self) -> ChecksumDefinition {
        let (algorithm, offset, unit, target, width) = match self {
            Self::FinalFight => (ChecksumAlgorithm::Sum16Le, 0xfe, ChecksumUnit::U16Le, 0, 2),
            Self::StreetFighter => (ChecksumAlgorithm::Sum8, 0xf6, ChecksumUnit::U8, 255, 1),
        };
        ChecksumDefinition {
            start: Some(0),
            length: Some(256),
            unit,
            target: Some(target),
            exclude: vec![ChecksumExclusion {
                offset,
                length: width,
            }],
            ..ChecksumDefinition::new(algorithm, offset)
        }
    }

    fn signature(self) -> SignatureDefinition {
        match self {
            Self::FinalFight => SignatureDefinition {
                offset: 0x74,
                bytes: vec![0xe5; 4],
            },
            Self::StreetFighter => SignatureDefinition {
                offset: 0,
                bytes: b"SP2X V05".to_vec(),
            },
        }
    }

    fn layout(self) -> layout::Layout {
        layout::Layout {
            groups: vec![layout::Group {
                id: "record".into(),
                logical_offset: 0,
                logical_length: 256,
                copies: layout::Copies::Fixed {
                    candidates: [0, 256]
                        .into_iter()
                        .map(|base| {
                            let (offset, storage) = match self {
                                Self::FinalFight => (base + 6, Storage::U16Be),
                                Self::StreetFighter => (base + 12, Storage::U32Be),
                            };
                            layout::Candidate {
                                spans: (0..256)
                                    .map(|offset| layout::Span {
                                        logical_offset: offset,
                                        physical_offset: base + (offset ^ 7),
                                        length: 1,
                                    })
                                    .collect(),
                                counter: Some(rules::Scalar {
                                    offset,
                                    storage,
                                    mask: None,
                                }),
                                predicates: vec![rules::Condition::new(move |bytes| {
                                    let record: Vec<u8> = bytes[base..base + 256]
                                        .chunks_exact(8)
                                        .flat_map(|chunk| chunk.iter().rev().copied())
                                        .collect();
                                    let signature = self.signature();
                                    let signature_valid = record[signature.offset
                                        ..signature.offset + signature.bytes.len()]
                                        == signature.bytes;
                                    let initialized = !matches!(self, Self::FinalFight)
                                        || record[..2] != [255, 255];
                                    Ok(signature_valid
                                        && initialized
                                        && Checksum::build(self.checksum(), 256)?.valid(&record))
                                })],
                                ..Default::default()
                            }
                        })
                        .collect(),
                },
                selection: layout::Selection::NewestCounter,
                write: layout::WritePolicy::Selected,
                empty: vec![0xff],
                empty_if_no_signature: false,
            }],
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(vec![final_fight(), street_fighter()], BTreeMap::new(), true)
}

fn definition(game: Game, id: &str, name: &str, fields: Vec<FieldDefinition>) -> GameDefinition {
    GameDefinition {
        fields,
        signatures: vec![game.signature()],
        checksums: vec![game.checksum()],
        description: "Edits raw 512-byte EEPROM with reversed eight-byte words. Uses the newest valid record and preserves the other record. Requires a game-made template.".into(),
        runtime: runtime::Runtime {
            logical_size: Some(256),
            layout: Some(game.layout()),
            ..Default::default()
        },
        ..GameDefinition::new(id.into(), name.into(), "game-boy-advance".into(), 512)
    }
}

fn number(id: &str, label: &str, offset: usize, storage: Storage, max: i64) -> FieldDefinition {
    FieldDefinition::new(id.into(), label.into(), offset, storage)
        .min(0)
        .max(max)
}

fn final_fight() -> GameDefinition {
    let mut fields = vec![
        number(
            "opponents_defeated",
            "Opponents defeated",
            2,
            Storage::U16Le,
            9999,
        ),
        number("options.difficulty", "Difficulty", 0x54, Storage::U8, 4).choices(choices(&[
            ("Very Easy", 0),
            ("Easy", 1),
            ("Normal", 2),
            ("Hard", 3),
            ("Very Hard", 4),
        ])),
        number("options.extend", "Extend", 0x55, Storage::U8, 3).choices(choices(&[
            ("100000", 0),
            ("200000", 1),
            ("Every 200000", 2),
            ("None", 3),
        ])),
        number("options.lives", "Starting lives", 0x56, Storage::U8, 9).min(1),
        number(
            "options.stage",
            "Starting stage (zero-based)",
            0x57,
            Storage::U8,
            5,
        ),
        number("options.rapid_punch", "Rapid punch", 0x5d, Storage::U8, 1)
            .choices(choices(&[("Off", 0), ("On", 1)])),
    ];
    for (button, offset) in [("a", 0x59), ("b", 0x5a), ("l", 0x5b), ("r", 0x5c)] {
        fields.push(
            number(
                &format!("options.button_{button}"),
                &format!("Button {}", button.to_uppercase()),
                offset,
                Storage::U8,
                3,
            )
            .choices(choices(&[
                ("Jump", 0),
                ("Attack", 1),
                ("Unused", 2),
                ("Ex Joy", 3),
            ])),
        );
    }
    for (character, offset) in [
        ("guy", 0x5e),
        ("cody", 0x5f),
        ("haggar", 0x60),
        ("alpha_guy", 0x61),
        ("alpha_cody", 0x62),
    ] {
        fields.push(number(
            &format!("colors.{character}"),
            &format!("{character} color (zero-based)"),
            offset,
            Storage::U8,
            3,
        ));
    }
    for rank in 0..5 {
        fields.push(
            number(
                &format!("records.rank_{}.character", rank + 1),
                &format!("Rank {} character", rank + 1),
                0x12 + rank * 0x10,
                Storage::U8,
                8,
            )
            .choices(choices(&[
                ("Guy", 0),
                ("Cody", 2),
                ("Haggar", 4),
                ("Alpha Guy", 6),
                ("Alpha Cody", 8),
            ])),
        );
        fields.push(number(
            &format!("records.rank_{}.color", rank + 1),
            &format!("Rank {} color (zero-based)", rank + 1),
            0x13 + rank * 0x10,
            Storage::U8,
            3,
        ));
    }
    definition(
        Game::FinalFight,
        "final-fight-one",
        "Final Fight One",
        fields,
    )
}

fn street_fighter() -> GameDefinition {
    let mut fields = vec![
        number("vs_points", "VS points", 0x94, Storage::U16Le, 9999),
        number(
            "options.level",
            "Difficulty (zero-based)",
            0x8f,
            Storage::U8,
            7,
        ),
        number("options.match_time", "Match time", 0x90, Storage::U8, 3)
            .choices(choices(&[
                ("30", 0),
                ("60", 1),
                ("99", 2),
                ("Unlimited", 3),
            ]))
            .behavior(field::FieldBehavior {
                on_edit: vec![rules::Store {
                    when: None,
                    destination: rules::Scalar {
                        offset: 0x8e,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: rules::ReadValue::new(|bytes| Ok(i64::from(bytes[0x90] != 3))),
                }],
                ..Default::default()
            }),
        number("options.rounds", "Rounds", 0x91, Storage::U8, 1)
            .choices(choices(&[("1", 0), ("3", 1)])),
        number(
            "options.damage",
            "Damage (zero-based)",
            0x92,
            Storage::U8,
            3,
        ),
        number("options.gauge", "Gauge", 0x96, Storage::U8, 1)
            .choices(choices(&[("Arcade", 0), ("Extra", 1)])),
    ];
    for (index, label) in [
        "Break the car",
        "Break barrels A",
        "Break barrels B",
        "Defeat 5 opponents",
        "Defeat 10 opponents",
        "Defeat 30 opponents",
        "Defeat 50 opponents",
        "Defeat 100 opponents",
        "Defeat 8 opponents",
        "Defeat four bosses",
        "Fight Akuma",
        "Fight Ryu and Ken",
        "Grand Master Challenge",
    ]
    .into_iter()
    .enumerate()
    {
        for (part, delta) in [("minutes", 0), ("seconds", 1), ("hundredths", 2)] {
            fields.push(number(
                &format!("records.challenge_{}.{part}", index + 1),
                &format!("{label}: {part}"),
                0xa9 + index * 4 + delta,
                Storage::U8,
                99,
            ));
        }
    }
    definition(
        Game::StreetFighter,
        "super-street-fighter-ii-turbo-revival",
        "Super Street Fighter II Turbo Revival",
        fields,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(game: Game, record: &mut [u8]) {
        match game {
            Game::FinalFight => {
                let sum = record[..254].chunks_exact(2).fold(0u16, |sum, word| {
                    sum.wrapping_add(u16::from_le_bytes([word[0], word[1]]))
                });
                record[254..].copy_from_slice(&0u16.wrapping_sub(sum).to_le_bytes());
            }
            Game::StreetFighter => {
                record[0xf6] = 0;
                record[0xf6] = !record.iter().fold(0u8, |sum, byte| sum.wrapping_add(*byte));
            }
        }
    }

    fn swap(bytes: &[u8]) -> Vec<u8> {
        bytes
            .chunks_exact(8)
            .flat_map(|word| word.iter().rev().copied())
            .collect()
    }

    fn fixture(game: Game, newest: usize) -> Vec<u8> {
        let mut bytes = vec![0; 512];
        for (index, record) in bytes.chunks_exact_mut(256).enumerate() {
            let signature = game.signature();
            record[signature.offset..signature.offset + signature.bytes.len()]
                .copy_from_slice(&signature.bytes);
            let count = if index == newest { 7u32 } else { 6 };
            match game {
                Game::FinalFight => record[..2].copy_from_slice(&(count as u16).to_le_bytes()),
                Game::StreetFighter => record[8..12].copy_from_slice(&count.to_le_bytes()),
            }
            repair(game, record);
        }
        swap(&bytes)
    }

    #[test]
    fn edits_newest_record_in_either_position_and_preserves_backup() {
        for (game, handler, field, offset) in [
            (
                Game::FinalFight,
                schemas().remove(0),
                "opponents_defeated",
                2,
            ),
            (Game::StreetFighter, schemas().remove(1), "vs_points", 0x94),
        ] {
            let identity = handler.definitions().remove(0).identity;
            for newest in 0..2 {
                let input = SaveDetectionInput {
                    bytes: fixture(game, newest),
                    selected_game: Some(identity.id.clone()),
                    rom_sha1: None,
                };
                let mut expected = swap(&input.bytes);
                let record = &mut expected[newest * 256..(newest + 1) * 256];
                record[offset..offset + 2].copy_from_slice(&4321u16.to_le_bytes());
                repair(game, record);
                let result = handler
                    .apply(
                        &input,
                        &identity,
                        &[SaveEdit {
                            field: field.into(),
                            value: SaveValue::U32(4321),
                        }],
                        false,
                    )
                    .unwrap();
                assert_eq!(result.bytes.unwrap(), swap(&expected));
                assert!(
                    handler
                        .apply(&input, &identity, &[], false)
                        .unwrap()
                        .bytes
                        .is_none()
                );
                assert!(
                    handler
                        .apply(&input, &identity, &[], true)
                        .unwrap()
                        .bytes
                        .is_none()
                );
                assert!(handler.generate(&identity).is_err());
                let mut bad = input.clone();
                bad.bytes[0] ^= 1;
                bad.bytes[256] ^= 1;
                assert!(handler.apply(&bad, &identity, &[], false).is_err());
                bad.bytes.pop();
                assert!(handler.apply(&bad, &identity, &[], false).is_err());
                assert!(
                    handler
                        .apply(
                            &input,
                            &identity,
                            &[SaveEdit {
                                field: field.into(),
                                value: SaveValue::U32(10000)
                            }],
                            false
                        )
                        .is_err()
                );
            }
        }
    }

    #[test]
    fn match_time_updates_timer_flag_and_checksum() {
        let handler = schemas().remove(1);
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes: fixture(Game::StreetFighter, 1),
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let result = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "options.match_time".into(),
                    value: SaveValue::Enum("60".into()),
                }],
                false,
            )
            .unwrap();
        let mut expected = swap(&input.bytes);
        expected[256 + 0x90] = 1;
        expected[256 + 0x8e] = 1;
        repair(Game::StreetFighter, &mut expected[256..]);
        assert_eq!(result.bytes.unwrap(), swap(&expected));
    }
}
