use super::super::rules::{Condition, ReadValue, Scalar, Store};
use super::*;

const TREASURE_COUNT_OFFSET: usize = 0x3bd;
const UNSET: u8 = 0xaa;

// Every treasure flag in the Treasures tab as (byte offset, bit, label). The game keeps the
// number of owned treasures at `TREASURE_COUNT_OFFSET` as packed BCD.
const TREASURES: [(usize, u8, &str); 100] = [
    (0x3df, 1, "Music Box 1"),
    (0x3df, 2, "Music Box 2"),
    (0x3df, 3, "Music Box 3"),
    (0x3df, 4, "Music Box 4"),
    (0x3df, 5, "Music Box 5"),
    (0x3df, 6, "Super Flippers"),
    (0x3df, 7, "Flippers"),
    (0x3e0, 0, "Winged Boots"),
    (0x3e0, 1, "Brown Glove"),
    (0x3e0, 2, "Garlic"),
    (0x3e0, 3, "Red Glove"),
    (0x3e0, 4, "Blue Overalls"),
    (0x3e0, 5, "Red Overalls"),
    (0x3e0, 6, "Spike Helmet"),
    (0x3e0, 7, "Lantern"),
    (0x3e1, 0, "Campfire"),
    (0x3e1, 1, "Torch"),
    (0x3e1, 2, "Screw"),
    (0x3e1, 3, "Cog"),
    (0x3e1, 4, "Pocket Mirror"),
    (0x3e1, 5, "Rain Jar"),
    (0x3e1, 6, "Treasure Map"),
    (0x3e1, 7, "Ice Spellbook"),
    (0x3e2, 0, "Key"),
    (0x3e2, 1, "Lightning Spellbook"),
    (0x3e2, 2, "Trident"),
    (0x3e2, 3, "Axe"),
    (0x3e2, 4, "Lightning Wand"),
    (0x3e2, 5, "Blue Skull"),
    (0x3e2, 6, "Red Skull"),
    (0x3e2, 7, "Half of Tablet (Blue)"),
    (0x3e3, 0, "Half of Tablet (Green)"),
    (0x3e3, 1, "Ornamental Fan"),
    (0x3e3, 2, "Half of Scroll (Top)"),
    (0x3e3, 3, "Half of Scroll (Bottom)"),
    (0x3e3, 4, "Leaf"),
    (0x3e3, 5, "Conch"),
    (0x3e3, 6, "Pinecone"),
    (0x3e3, 7, "Blue Chemical"),
    (0x3e4, 0, "Red Chemical"),
    (0x3e4, 1, "Pump"),
    (0x3e4, 2, "Fruit"),
    (0x3e4, 3, "Night Vision Scope"),
    (0x3e4, 4, "Electric Fan Propeller"),
    (0x3e4, 5, "Rust Spray"),
    (0x3e4, 6, "Statue"),
    (0x3e4, 7, "Detonator"),
    (0x3e5, 0, "Scissors"),
    (0x3e5, 1, "Box"),
    (0x3e5, 2, "Remote Control"),
    (0x3e5, 3, "Key Card (Red)"),
    (0x3e5, 4, "Key Card (Blue)"),
    (0x3e5, 5, "Drill"),
    (0x3e5, 6, "Pickaxe"),
    (0x3e5, 7, "Rocket"),
    (0x3e6, 0, "Pokémon Pikachu"),
    (0x3e6, 1, "Valve"),
    (0x3e6, 2, "Blood"),
    (0x3e6, 3, "Sand"),
    (0x3e6, 4, "Doll"),
    (0x3e6, 5, "Wheels"),
    (0x3e6, 6, "Flute"),
    (0x3e6, 7, "Foot of Stone"),
    (0x3e7, 0, "Golden Snake Eye (Left)"),
    (0x3e7, 1, "Golden Snake Eye (Right)"),
    (0x3e7, 2, "Blue Snake Eye (Left)"),
    (0x3e7, 3, "Blue Snake Eye (Right)"),
    (0x3e7, 4, "Water Wand"),
    (0x3e7, 5, "Half of Sun Stone (Left)"),
    (0x3e7, 6, "Half of Sun Stone (Right)"),
    (0x3e7, 7, "Whirlwind"),
    (0x3e8, 0, "Seed"),
    (0x3e8, 1, "Sack"),
    (0x3e8, 2, "Gong"),
    (0x3e8, 3, "Telephone"),
    (0x3e8, 4, "Crown"),
    (0x3e8, 5, "Day / Night Tablet"),
    (0x3e8, 6, "Bracelet (Red)"),
    (0x3e8, 7, "Bracelet (Green)"),
    (0x3e9, 0, "Bracelet (Blue)"),
    (0x3e9, 1, "Crest (Club)"),
    (0x3e9, 2, "Crest (Spade)"),
    (0x3e9, 3, "Crest (Heart)"),
    (0x3e9, 4, "Crest (Diamond)"),
    (0x3e9, 5, "Gloom"),
    (0x3e9, 6, "Saber"),
    (0x3e9, 7, "Chalice"),
    (0x3ea, 0, "Teapot"),
    (0x3ea, 1, "Magnifying Glass"),
    (0x3ea, 2, "UFO"),
    (0x3ea, 3, "Toy Car"),
    (0x3ea, 4, "Toy Train"),
    (0x3ea, 5, "Fire Extinguisher"),
    (0x3ea, 6, "Crayon (Red)"),
    (0x3ea, 7, "Crayon (Brown)"),
    (0x3eb, 0, "Crayon (Yellow)"),
    (0x3eb, 1, "Crayon (Green)"),
    (0x3eb, 2, "Crayon (Cyan)"),
    (0x3eb, 3, "Crayon (Blue)"),
    (0x3eb, 4, "Crayon (Pink)"),
];

// Level order of the musical-coin bitfield (0x3c2) and the time-attack byte pairs (0x38b).
const LEVELS: [(&str, &str); 25] = [
    ("n1", "N1 Out of the Woods"),
    ("n2", "N2 The Peaceful Village"),
    ("n3", "N3 The Vast Plain"),
    ("n4", "N4 Bank of the Wild River"),
    ("n5", "N5 The Tidal Coast"),
    ("n6", "N6 Sea Turtle Rocks"),
    ("w1", "W1 Desert Ruins"),
    ("w2", "W2 The Volcano's Base"),
    ("w3", "W3 The Pool of Rain"),
    ("w4", "W4 A Town in Chaos"),
    ("w5", "W5 Beneath the Waves"),
    ("w6", "W6 The West Crater"),
    ("s1", "S1 The Grasslands"),
    ("s2", "S2 The Big Bridge"),
    ("s3", "S3 Tower of Revival"),
    ("s4", "S4 The Steep Canyon"),
    ("s5", "S5 Cave of Flames"),
    ("s6", "S6 Above the Clouds"),
    ("e1", "E1 The Stagnant Swamp"),
    ("e2", "E2 The Frigid Sea"),
    ("e3", "E3 Castle of Illusions"),
    ("e4", "E4 The Colossal Hole"),
    ("e5", "E5 The Warped Void"),
    ("e6", "E6 The East Crater"),
    ("e7", "E7 Forest of Fear"),
];

// The ninth upgrade (Super Throw) is not exposed: the level byte has only eight bit positions
// and a byte-wide field would overlap the other upgrade fields.
const POWERS: [(&str, &str); 8] = [
    ("ground_pound", "Ground Pound acquired"),
    ("swim", "Swim acquired"),
    ("head_smash", "Head Smash acquired"),
    ("throw", "Throw acquired"),
    ("super_charge", "Super Charge acquired"),
    ("super_ground_pound", "Super Ground Pound acquired"),
    ("super_jump", "Super Jump acquired"),
    ("super_swim", "Super Swim acquired"),
];

fn byte_store(offset: usize, value: impl Fn(&[u8]) -> i64 + Send + Sync + 'static) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset,
            storage: Storage::U8,
            mask: None,
        },
        value: ReadValue::new(move |bytes| Ok(value(bytes))),
    }
}

fn bit_field(id: &str, label: &str, offset: usize, bit: u8) -> FieldDefinition {
    catalog_field(id, label, offset, Storage::Bit).bit(bit)
}

fn slug(label: &str) -> String {
    let mut out = String::new();
    for ch in label.chars() {
        let ch = if ch == 'é' { 'e' } else { ch };
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    out.trim_end_matches('_').to_string()
}

fn bcd(value: i64) -> i64 {
    ((value / 10) << 4) | (value % 10)
}

// The treasure counter MUST follow the number of set treasure flags after every treasure edit.
fn treasure_count_store() -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset: TREASURE_COUNT_OFFSET,
            storage: Storage::U16Be,
            mask: None,
        },
        value: ReadValue::new(|bytes| {
            let count = TREASURES
                .iter()
                .filter(|(offset, bit, _)| bytes[*offset] & (1 << bit) != 0)
                .count() as i64;
            trace!(count, "recomputed Wario Land 3 treasure count");
            Ok(((count / 100) << 8) | bcd(count % 100))
        }),
    }
}

// Level best times are two BCD bytes; both hold 0xaa while no time is recorded. The raw write
// stores the binary value, then the stores normalize both bytes the way the game expects.
fn time_attack(id: &str, label: &str, offset: usize, partner: usize) -> FieldDefinition {
    FieldDefinition::new(id.into(), label.into(), offset, Storage::U8)
        .min(0)
        .max(59)
        .behavior(field::FieldBehavior {
            read: Some(ReadValue::new(move |bytes| {
                let (own, other) = (bytes[offset], bytes[partner]);
                Ok(if own == UNSET && other == UNSET {
                    0
                } else if own >> 4 > 9 || own & 15 > 9 {
                    i64::from(own)
                } else {
                    i64::from(own >> 4) * 10 + i64::from(own & 15)
                })
            })),
            on_edit: vec![
                byte_store(partner, move |bytes| {
                    let (own, other) = (bytes[offset], bytes[partner]);
                    i64::from(match (own, other) {
                        (0, 0 | UNSET) => UNSET,
                        (1.., UNSET) => 0,
                        _ => other,
                    })
                }),
                byte_store(offset, move |bytes| {
                    if bytes[offset] == 0 && bytes[partner] == UNSET {
                        i64::from(UNSET)
                    } else {
                        bcd(i64::from(bytes[offset]))
                    }
                }),
            ],
            ..Default::default()
        })
}

// Golf course records store 0xaa while unset.
fn golf(course: usize) -> FieldDefinition {
    let offset = 0x3c6 + course;
    FieldDefinition::new(
        format!("golf.course_{}", course + 1),
        format!("Golf course {} best score", course + 1),
        offset,
        Storage::U8,
    )
    .min(0)
    .max(119)
    .behavior(field::FieldBehavior {
        read: Some(ReadValue::new(move |bytes| {
            Ok(if bytes[offset] == UNSET {
                0
            } else {
                i64::from(bytes[offset])
            })
        })),
        on_edit: vec![byte_store(offset, move |bytes| {
            i64::from(if bytes[offset] == 0 {
                UNSET
            } else {
                bytes[offset]
            })
        })],
        ..Default::default()
    })
}

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
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/wario-land-3/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = vec![
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
    ];
    for (index, (name, label)) in POWERS.iter().enumerate() {
        let id = format!("power.{name}");
        fields.push(power(&id, label, index as u8 + 1));
    }
    fields.extend([
        bit_field("event.final_boss_seen", "Final boss seen", 0x3c1, 2),
        bit_field("event.final_boss_defeated", "Final boss defeated", 0x3c1, 0),
        bit_field("event.time_attack_enabled", "Time Attack enabled", 0x3c1, 1),
    ]);
    for (offset, bit, label) in TREASURES {
        let mut field = bit_field(&format!("treasure.{}", slug(label)), label, offset, bit);
        field.behavior.on_edit.push(treasure_count_store());
        fields.push(field);
    }
    for (index, (code, name)) in LEVELS.iter().enumerate() {
        fields.push(bit_field(
            &format!("musical_coins.{code}"),
            &format!("{name}: 8 musical coins"),
            0x3c2 + index / 8,
            (index % 8) as u8,
        ));
        let offset = 0x38b + index * 2;
        for (part, own, other) in [
            ("first", offset, offset + 1),
            ("second", offset + 1, offset),
        ] {
            fields.push(time_attack(
                &format!("time_attack.{code}.{part}"),
                &format!("{name}: Time Attack {part} part"),
                own,
                other,
            ));
        }
    }
    fields.extend((0..4).map(golf));
    build(
        vec![GameDefinition {
            fields,
            description:
                "Edits the World Map save block: coins, language, day/night, the first eight sequential power upgrades, events, the 100 treasures with the treasure counter, musical coins, Time Attack times, and golf records. Mid-level saves are intentionally rejected.".into(),
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

    fn apply(input: &SaveDetectionInput, edits: &[(&str, SaveValue)]) -> Result<Vec<u8>> {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let edits: Vec<_> = edits
            .iter()
            .map(|(field, value)| SaveEdit {
                field: (*field).into(),
                value: value.clone(),
            })
            .collect();
        Ok(handler
            .apply(input, &identity, &edits, false)?
            .bytes
            .unwrap_or_else(|| input.bytes.clone()))
    }

    // Expected output: the input with `changes` applied, then the additive checksum repaired.
    fn expected(input: &SaveDetectionInput, changes: &[(usize, u8)]) -> Vec<u8> {
        let mut bytes = input.bytes.clone();
        for (offset, value) in changes {
            bytes[*offset] = *value;
        }
        repair(&mut bytes);
        bytes
    }

    #[test]
    fn upgrades_four_to_eight_set_and_clear_sequential_levels() {
        let cases = [
            ("power.throw", 4),
            ("power.super_charge", 5),
            ("power.super_ground_pound", 6),
            ("power.super_jump", 7),
            ("power.super_swim", 8),
        ];
        for (field, level) in cases {
            let mut start = input();
            start.bytes[0x3c0] = level - 1;
            repair(&mut start.bytes);
            let out = apply(&start, &[(field, SaveValue::Bool(true))]).unwrap();
            assert_eq!(out, expected(&start, &[(0x3c0, level)]), "{field} on");
            let mut full = input();
            full.bytes[0x3c0] = 8;
            repair(&mut full.bytes);
            let out = apply(&full, &[(field, SaveValue::Bool(false))]).unwrap();
            assert_eq!(out, expected(&full, &[(0x3c0, level - 1)]), "{field} off");
        }
    }

    #[test]
    fn event_and_musical_coin_flags_change_only_their_bit() {
        let mut start = input();
        start.bytes[0x3c1..0x3c6].fill(0);
        repair(&mut start.bytes);
        let edits = [
            ("event.final_boss_seen", SaveValue::Bool(true)),
            ("event.final_boss_defeated", SaveValue::Bool(true)),
            ("event.time_attack_enabled", SaveValue::Bool(true)),
            ("musical_coins.n1", SaveValue::Bool(true)),
            ("musical_coins.w1", SaveValue::Bool(true)),
            ("musical_coins.w3", SaveValue::Bool(true)),
            ("musical_coins.e7", SaveValue::Bool(true)),
        ];
        let out = apply(&start, &edits).unwrap();
        assert_eq!(
            out,
            expected(
                &start,
                &[(0x3c1, 0b111), (0x3c2, 0b0100_0001), (0x3c3, 1), (0x3c5, 1)]
            )
        );
        let off = apply(
            &expected_input(&out),
            &[("musical_coins.w1", SaveValue::Bool(false))],
        )
        .unwrap();
        assert_eq!(off[0x3c2], 1);
    }

    fn expected_input(bytes: &[u8]) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes: bytes.to_vec(),
            selected_game: Some("wario-land-3".into()),
            rom_sha1: None,
        }
    }

    // Independent of the module table: byte 0x3df holds flag bits 1..=7, 0x3e0..=0x3ea all eight
    // bits, and 0x3eb bits 0..=4.
    fn owned_treasures(bytes: &[u8]) -> u32 {
        (bytes[0x3df] & 0xfe).count_ones()
            + bytes[0x3e0..=0x3ea]
                .iter()
                .map(|byte| byte.count_ones())
                .sum::<u32>()
            + (bytes[0x3eb] & 0x1f).count_ones()
    }

    #[test]
    fn treasure_edits_keep_the_packed_bcd_counter_in_sync() {
        let mut start = input();
        start.bytes[0x3df..0x3ec].fill(0);
        repair(&mut start.bytes);
        let out = apply(
            &start,
            &[
                ("treasure.music_box_1", SaveValue::Bool(true)),
                ("treasure.crayon_pink", SaveValue::Bool(true)),
                ("treasure.pokemon_pikachu", SaveValue::Bool(true)),
            ],
        )
        .unwrap();
        assert_eq!(owned_treasures(&out), 3);
        assert_eq!(
            out,
            expected(
                &start,
                &[
                    (0x3df, 2),
                    (0x3e6, 1),
                    (0x3eb, 0x10),
                    (0x3bd, 0),
                    (0x3be, 3)
                ]
            )
        );
        let mut every = start.clone();
        every.bytes[0x3df] = 0xfe;
        every.bytes[0x3e0..=0x3ea].fill(0xff);
        every.bytes[0x3eb] = 0x0f;
        repair(&mut every.bytes);
        let out = apply(&every, &[("treasure.crayon_pink", SaveValue::Bool(true))]).unwrap();
        assert_eq!(owned_treasures(&out), 100);
        assert_eq!(&out[0x3bd..0x3bf], &[0x01, 0x00]);
        let out = apply(
            &expected_input(&out),
            &[("treasure.axe", SaveValue::Bool(false))],
        )
        .unwrap();
        assert_eq!(&out[0x3bd..0x3bf], &[0x00, 0x99]);
    }

    #[test]
    fn time_attack_pairs_follow_the_unset_marker_rules() {
        // (byte pair before, edited field, value, byte pair after)
        let cases = [
            ((0xaa, 0xaa), "time_attack.n1.first", 0, (0xaa, 0xaa)),
            ((0xaa, 0xaa), "time_attack.n1.first", 42, (0x42, 0x00)),
            ((0xaa, 0xaa), "time_attack.n1.second", 59, (0x00, 0x59)),
            ((0x12, 0x34), "time_attack.n1.first", 0, (0x00, 0x34)),
            ((0x00, 0x34), "time_attack.n1.second", 0, (0xaa, 0xaa)),
            ((0x12, 0x00), "time_attack.n1.second", 0, (0x12, 0x00)),
            ((0x12, 0x00), "time_attack.n1.first", 0, (0xaa, 0xaa)),
        ];
        for (before, field, value, after) in cases {
            let mut start = input();
            start.bytes[0x38b] = before.0;
            start.bytes[0x38c] = before.1;
            repair(&mut start.bytes);
            if before == after {
                let out = apply(&start, &[(field, SaveValue::U32(value))]).unwrap();
                assert_eq!(out, start.bytes, "{field}={value} is a no-op");
                continue;
            }
            let out = apply(&start, &[(field, SaveValue::U32(value))]).unwrap();
            assert_eq!(
                out,
                expected(&start, &[(0x38b, after.0), (0x38c, after.1)]),
                "{field}={value} from {before:x?}"
            );
        }
        let mut start = input();
        start.bytes[0x38b] = 0x42;
        start.bytes[0x38c] = 0x07;
        assert!(apply(&start, &[("time_attack.n1.first", SaveValue::U32(60))]).is_err());
    }

    #[test]
    fn golf_records_use_the_unset_marker_for_zero() {
        let mut start = input();
        start.bytes[0x3c6..0x3ca].copy_from_slice(&[0xaa, 0x77, 0x01, 0xaa]);
        repair(&mut start.bytes);
        let out = apply(
            &start,
            &[
                ("golf.course_1", SaveValue::U32(119)),
                ("golf.course_2", SaveValue::U32(0)),
                ("golf.course_3", SaveValue::U32(0)),
            ],
        )
        .unwrap();
        assert_eq!(
            out,
            expected(&start, &[(0x3c6, 119), (0x3c7, 0xaa), (0x3c8, 0xaa)])
        );
        assert!(apply(&start, &[("golf.course_4", SaveValue::U32(120))]).is_err());
    }
}
