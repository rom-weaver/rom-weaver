use super::*;

const RECORD_DESCRIPTION: &str =
    "Raw stored record byte; 0xA in the low minutes nibble denotes an unset record.";

fn course(scope: &FieldScope) -> Vec<FieldDefinition> {
    const PARTS: [(&str, &str); 3] = [
        ("hundredths", "Hundredths BCD byte"),
        ("seconds", "Seconds BCD byte"),
        ("minutes_character", "Packed minutes and character byte"),
    ];
    (1..=6)
        .flat_map(|record| {
            PARTS
                .into_iter()
                .enumerate()
                .map(move |(part, (id, label))| {
                    scope
                        .field(
                            &format!("trial_{}.record_{record}.{id}", scope.index),
                            &format!("Course {} record {record}: {label}", scope.index),
                            (record - 1) * 3 + part,
                            Storage::U8,
                        )
                        .description(RECORD_DESCRIPTION.into())
                })
        })
        .collect()
}
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_super_mario_kart_schema()];

    build(games, codecs, true)
}

fn game_super_mario_kart_schema() -> GameDefinition {
    let mut fields = vec![
        catalog_field(
            "grand_prix.mushroom_cup",
            "Mushroom Cup packed trophy flags",
            2034,
            Storage::U8,
        ),
        catalog_field(
            "grand_prix.flower_cup",
            "Flower Cup packed trophy flags",
            2035,
            Storage::U8,
        ),
        catalog_field(
            "grand_prix.star_cup",
            "Star Cup packed trophy flags",
            2036,
            Storage::U8,
        ),
        catalog_field(
            "grand_prix.special_cup",
            "Special Cup packed trophy flags",
            2037,
            Storage::U8,
        ),
    ];
    let scope = FieldScope::default();
    {
        for item in 0..20 {
            let number = item + 1;
            let index = format!("{number:00}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8 + 1634,
                bits: item * 160,
                bit_stride: false,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("");
            fields.extend(course(&child));
        }
    }
    GameDefinition {
        fields,
        description: concat!(
            "All regions, 2 KiB SRAM. Edits all four packed GP trophy bytes ",
            "and all six packed time/character records on each of 20 courses. ",
            "Raw stored bytes preserve unset-record encodings; not every ",
            "encoded value is a playable time."
        )
        .into(),
        checksums: vec![
            ChecksumDefinition {
                start: Some(2034),
                length: Some(4),
                unit: ChecksumUnit::U16Le,
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 2032)
            },
            ChecksumDefinition {
                start: Some(1632),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1632,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1632)
            },
            ChecksumDefinition {
                start: Some(1652),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1652,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1652)
            },
            ChecksumDefinition {
                start: Some(1672),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1672,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1672)
            },
            ChecksumDefinition {
                start: Some(1692),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1692,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1692)
            },
            ChecksumDefinition {
                start: Some(1712),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1712,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1712)
            },
            ChecksumDefinition {
                start: Some(1732),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1732,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1732)
            },
            ChecksumDefinition {
                start: Some(1752),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1752,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1752)
            },
            ChecksumDefinition {
                start: Some(1772),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1772,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1772)
            },
            ChecksumDefinition {
                start: Some(1792),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1792,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1792)
            },
            ChecksumDefinition {
                start: Some(1812),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1812,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1812)
            },
            ChecksumDefinition {
                start: Some(1832),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1832,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1832)
            },
            ChecksumDefinition {
                start: Some(1852),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1852,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1852)
            },
            ChecksumDefinition {
                start: Some(1872),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1872,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1872)
            },
            ChecksumDefinition {
                start: Some(1892),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1892,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1892)
            },
            ChecksumDefinition {
                start: Some(1912),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1912,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1912)
            },
            ChecksumDefinition {
                start: Some(1932),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1932,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1932)
            },
            ChecksumDefinition {
                start: Some(1952),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1952,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1952)
            },
            ChecksumDefinition {
                start: Some(1972),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1972,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1972)
            },
            ChecksumDefinition {
                start: Some(1992),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 1992,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1992)
            },
            ChecksumDefinition {
                start: Some(2012),
                length: Some(20),
                exclude: vec![ChecksumExclusion {
                    offset: 2012,
                    length: 2,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 2012)
            },
        ],
        ..GameDefinition::new(
            "super-mario-kart-schema".into(),
            "Super Mario Kart".into(),
            "snes".into(),
            2048,
        )
    }
}
