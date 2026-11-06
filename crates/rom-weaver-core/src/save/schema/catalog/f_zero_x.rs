use super::*;
use tracing::debug;

fn has_signature(bytes: &[u8], swapped: bool) -> bool {
    b"F-ZERO X".iter().enumerate().all(|(offset, expected)| {
        bytes.get(if swapped { offset ^ 3 } else { offset }) == Some(expected)
    })
}

fn candidate(start: usize, length: usize, swapped: bool) -> layout::Candidate {
    layout::Candidate {
        spans: (start..start + length)
            .map(|offset| layout::Span {
                logical_offset: offset,
                physical_offset: if swapped { offset ^ 3 } else { offset },
                length: 1,
            })
            .collect(),
        predicates: vec![rules::Condition::new(move |bytes| {
            Ok(has_signature(bytes, swapped))
        })],
        ..Default::default()
    }
}

fn group(id: &str, start: usize, length: usize) -> layout::Group {
    layout::Group {
        id: id.into(),
        logical_offset: start,
        logical_length: length,
        copies: layout::Copies::Fixed {
            candidates: vec![
                candidate(start, length, true),
                candidate(start, length, false),
            ],
        },
        selection: layout::Selection::FirstValid,
        write: layout::WritePolicy::Selected,
        empty: Vec::new(),
        empty_if_no_signature: false,
    }
}

// Layout and checksum rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/f-zero-x/saveEditor
// Options, cup unlocks, and Time Attack records, unchanged at: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/f-zero-x/saveEditor
const NAME_CODEC: &str = "f_zero_x_time_attack_name";
const TIME_ATTACK_START: usize = 0x20;
const RECORD_SIZE: usize = 0x110;
// A layout group holds at most 4096 byte spans, so the 24 records span two groups.
const TIME_ATTACK_SPLIT: usize = 0x1130;
const TIME_ATTACK_END: usize = 0x1a60;
const COURSES: [(&str, &str); 24] = [
    ("mute_city", "Mute City"),
    ("silence", "Silence"),
    ("sand_ocean", "Sand Ocean"),
    ("devils_forest", "Devil's Forest"),
    ("big_blue", "Big Blue"),
    ("port_town", "Port Town"),
    ("sector_alpha", "Sector Alpha"),
    ("red_canyon", "Red Canyon"),
    ("devils_forest_2", "Devil's Forest 2"),
    ("mute_city_2", "Mute City 2"),
    ("big_blue_2", "Big Blue 2"),
    ("white_land", "White Land"),
    ("fire_field", "Fire Field"),
    ("silence_2", "Silence 2"),
    ("sector_beta", "Sector Beta"),
    ("red_canyon_2", "Red Canyon 2"),
    ("white_land_2", "White Land 2"),
    ("mute_city_3", "Mute City 3"),
    ("rainbow_road", "Rainbow Road"),
    ("devils_forest_3", "Devil's Forest 3"),
    ("space_plant", "Space Plant"),
    ("sand_ocean_2", "Sand Ocean 2"),
    ("port_town_2", "Port Town 2"),
    ("big_hand", "Big Hand"),
];
// Each difficulty stores 30 machines in ten big-endian halfwords of three five-bit cup masks.
const CUP_START: usize = 0x7f90;
const CUP_DIFFICULTY_SIZE: usize = 0x14;
const DIFFICULTIES: [&str; 4] = ["novice", "standard", "expert", "master"];
const CUPS: [&str; 5] = ["jack", "queen", "king", "joker", "x"];
// Machine slug, label, halfword byte offset within a difficulty, and slot within the halfword.
const MACHINES: [(&str, &str, usize, usize); 30] = [
    ("blue_falcon", "Blue Falcon", 0, 0),
    ("golden_fox", "Golden Fox", 0, 1),
    ("wild_goose", "Wild Goose", 0, 2),
    ("fire_stingray", "Fire Stingray", 2, 0),
    ("white_cat", "White Cat", 2, 1),
    ("red_gazelle", "Red Gazelle", 2, 2),
    ("iron_tiger", "Iron Tiger", 4, 1),
    ("deep_claw", "Deep Claw", 4, 2),
    ("crazy_bear", "Crazy Bear", 14, 2),
    ("great_star", "Great Star", 4, 0),
    ("big_fang", "Big Fang", 16, 1),
    ("mad_wolf", "Mad Wolf", 18, 0),
    ("night_thunder", "Night Thunder", 16, 0),
    ("twin_noritta", "Twin Noritta", 6, 0),
    ("wonder_wasp", "Wonder Wasp", 12, 2),
    ("queen_meteor", "Queen Meteor", 12, 1),
    ("blood_hawk", "Blood Hawk", 18, 2),
    ("astro_robin", "Astro Robin", 10, 2),
    ("little_wyvern", "Little Wyvern", 8, 0),
    ("death_anchor", "Death Anchor", 14, 1),
    ("wild_boar", "Wild Boar", 10, 1),
    ("king_meteor", "King Meteor", 12, 0),
    ("super_piranha", "Super Piranha", 6, 1),
    ("mighty_hurricane", "Mighty Hurricane", 6, 2),
    ("space_angler", "Space Angler", 8, 1),
    ("mighty_typhoon", "Mighty Typhoon", 16, 2),
    ("hyper_speeder", "Hyper Speeder", 14, 0),
    ("green_panther", "Green Panther", 8, 2),
    ("black_bull", "Black Bull", 10, 0),
    ("sonic_phantom", "Sonic Phantom", 18, 1),
];
// A Time Attack place that was never set stores 60:00.000 in its time word.
const TIME_UNCLEARED: u32 = 0x36_ee7f;
const DEFAULT_COLOR: i64 = 0x0000ff;

fn header_group(offset: usize) -> &'static str {
    match offset {
        ..0x130 => "header",
        0x130..TIME_ATTACK_SPLIT => "time_attack_1",
        TIME_ATTACK_SPLIT..TIME_ATTACK_END => "time_attack_2",
        0x7380..0x7f80 => "speed_ratios",
        _ => "cups",
    }
}

fn grouped(mut field: FieldDefinition) -> FieldDefinition {
    field.behavior.group = Some(header_group(field.offset).into());
    field
}

fn cup_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (difficulty, difficulty_name) in DIFFICULTIES.into_iter().enumerate() {
        for (slug, name, halfword, slot) in MACHINES {
            for (cup, cup_name) in CUPS.into_iter().enumerate() {
                let bit = slot * 5 + cup;
                let offset = CUP_START + difficulty * CUP_DIFFICULTY_SIZE + halfword + 1 - bit / 8;
                fields.push(grouped(
                    catalog_field(
                        &format!("cups.{difficulty_name}.{slug}.{cup_name}"),
                        &format!("{difficulty_name} {name} {cup_name} cup unlocked"),
                        offset,
                        Storage::Bit,
                    )
                    .bit((bit % 8) as u8),
                ));
            }
        }
    }
    fields
}

fn option_fields() -> Vec<FieldDefinition> {
    vec![
        grouped(catalog_field("options.vs_com", "VS COM (2P, 3P)", 0x8, Storage::Bit).bit(0)),
        grouped(catalog_field("options.vs_slot", "VS Slot", 0x8, Storage::Bit).bit(1)),
        grouped(
            catalog_field("options.vs_handicap", "VS Handicap", 0x8, Storage::U8)
                .mask(0x30)
                .choices(choices(&[("none", 0), ("plus_1", 1), ("plus_2", 2)]))
                .min(0)
                .max(2),
        ),
        grouped(
            catalog_field(
                "options.sound_mode",
                "Sound mode (0: stereo, 1: mono)",
                0x8,
                Storage::Bit,
            )
            .bit(2),
        ),
        grouped(
            catalog_field(
                "options.everything_unlocked",
                "Everything unlocked",
                0x8,
                Storage::Bit,
            )
            .bit(3),
        ),
    ]
}

// The first Time Attack edit on a never-set place leaves its machine color black, so the
// editor gives it Blue Falcon's default color as the upstream editor does.
fn default_color(color_offset: usize) -> rules::Store {
    rules::Store {
        when: Some(rules::Condition::new(move |bytes| {
            Ok(bytes[color_offset..color_offset + 3] == [0, 0, 0])
        })),
        destination: rules::Scalar {
            offset: color_offset,
            storage: Storage::U24Be,
            mask: None,
        },
        value: rules::ReadValue::new(|_| Ok(DEFAULT_COLOR)),
    }
}

fn time_attack_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (course, (slug, name)) in COURSES.into_iter().enumerate() {
        let record = course * RECORD_SIZE;
        fields.push(grouped(
            catalog_field(
                &format!("time_attack.{slug}.best_lap_ms"),
                &format!("{name} best lap (ms)"),
                record + 0x50,
                Storage::U32Be,
            )
            .min(0)
            .max(3_599_999),
        ));
        for place in 0..5 {
            let time_offset = record + 0x24 + place * 4;
            let name_offset = record + 0x54 + place * 4;
            let color_offset = record + 0x78 + place * 0x20;
            fields.push(grouped(
                catalog_field(
                    &format!("time_attack.{slug}.place_{}.time_ms", place + 1),
                    &format!("{name} place {} time (ms)", place + 1),
                    time_offset,
                    Storage::U32Be,
                )
                .min(0)
                .max(i64::from(TIME_UNCLEARED))
                .behavior(field::FieldBehavior {
                    on_edit: vec![default_color(color_offset)],
                    ..Default::default()
                }),
            ));
            fields.push(grouped(
                catalog_field(
                    &format!("time_attack.{slug}.place_{}.name", place + 1),
                    &format!("{name} place {} name", place + 1),
                    name_offset,
                    Storage::Ascii,
                )
                .length(3)
                .editable(true)
                .behavior(field::FieldBehavior {
                    editable_when: Some(rules::Condition::new(move |bytes| {
                        Ok(u32::from_be_bytes(
                            bytes[time_offset..time_offset + 4].try_into().unwrap(),
                        ) != TIME_UNCLEARED)
                    })),
                    text_codec: Some(NAME_CODEC.into()),
                    ..Default::default()
                })
                .presentation(
                    field::Presentation::new(0, name_offset as u16)
                        .text_length(3)
                        .step(None)
                        .encoding(Some(NAME_CODEC)),
                ),
            ));
        }
    }
    fields
}

fn checksum_ranges() -> Vec<(usize, usize, usize)> {
    let mut ranges = vec![
        (0, 0xe, 0xe),
        (0x7f82, 0x7e, 0x7f80),
        (0x10, 0x10, 0x10),
        (0x7382, 0x7e, 0x7380),
    ];
    // Every Time Attack course record carries its own checksum in its first word.
    ranges.extend((0..COURSES.len()).map(|course| {
        let checksum = TIME_ATTACK_START + course * RECORD_SIZE;
        (checksum + 2, RECORD_SIZE - 2, checksum)
    }));
    ranges
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields: Vec<FieldDefinition> = [
        ("jack_cup", "Jack Cup progression", 0xa),
        ("queen_cup", "Queen Cup progression", 0xb),
        ("king_cup", "King Cup progression", 0xc),
        ("joker_cup", "Joker Cup progression", 0xd),
    ]
    .into_iter()
    .map(|(id, label, offset)| {
        FieldDefinition::new(id.into(), label.into(), offset, Storage::U8)
            .max(4)
            .behavior(field::FieldBehavior {
                group: Some("header".into()),
                ..Default::default()
            })
    })
    .chain(std::iter::once(
        catalog_field("death_race_time", "Death Race time", 0x14, Storage::U32Be).behavior(
            field::FieldBehavior {
                group: Some("header".into()),
                ..Default::default()
            },
        ),
    ))
    .collect();
    fields.extend(option_fields());
    fields.extend(cup_fields());
    fields.extend(time_attack_fields());
    debug!(fields = fields.len(), "built F-Zero X save fields");
    let checksums = checksum_ranges()
        .into_iter()
        .map(|(start, length, offset)| ChecksumDefinition {
            start: Some(start),
            length: Some(length),
            exclude: if offset == 0x10 {
                vec![ChecksumExclusion { offset, length: 2 }]
            } else {
                Vec::new()
            },
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, offset)
        })
        .collect();
    let game = GameDefinition {
        fields,
        description: "Edits Grand Prix progression, options, cup unlocks, and Time Attack and Death Race records in native word-swapped or normalized 32 KiB SRAM. Requires a game-made template.".into(),
        signatures: vec![SignatureDefinition { offset: 0, bytes: b"F-ZERO X".to_vec() }],
        checksums,
        runtime: runtime::Runtime { require_selection: true, layout: Some(layout::Layout { groups: vec![group("header", 0, 0x130), group("time_attack_1", 0x130, TIME_ATTACK_SPLIT - 0x130), group("time_attack_2", TIME_ATTACK_SPLIT, TIME_ATTACK_END - TIME_ATTACK_SPLIT), group("speed_ratios", 0x7380, 0x80), group("cups", 0x7f80, 0x80)] }), save_format: Some("n64_sram_32k".into()), save_format_name: Some("Nintendo 64 SRAM 32 KiB".into()), ..Default::default() },
        ..GameDefinition::new("f-zero-x".into(), "F-Zero X".into(), "nintendo-64".into(), 32768)
    };
    let codecs = BTreeMap::from([(
        NAME_CODEC.to_string(),
        ascii_name_codec(
            " !',-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            3,
            0,
            true,
            "record name",
        ),
    )]);
    build(vec![game], codecs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent copy of the upstream checksum ranges: start, length, checksum offset.
    fn upstream_ranges() -> Vec<(usize, usize, usize)> {
        let mut ranges = vec![
            (0, 0xe, 0xe),
            (0x7f82, 0x7e, 0x7f80),
            (0x10, 0x10, 0x10),
            (0x7382, 0x7e, 0x7380),
        ];
        for course in 0..24 {
            let offset = 0x20 + course * 0x110;
            ranges.push((offset + 2, 0x10e, offset));
        }
        ranges
    }
    fn sum16(bytes: &[u8], start: usize, length: usize) -> u16 {
        let mut checksum = 0u32;
        for byte in &bytes[start..start + length] {
            checksum += u32::from(*byte);
        }
        (checksum & 0xffff) as u16
    }
    fn repair(bytes: &mut [u8]) {
        for (start, length, offset) in upstream_ranges() {
            if offset == 0x10 {
                bytes[0x10..0x12].fill(0);
            }
            let sum = sum16(bytes, start, length);
            bytes[offset..offset + 2].copy_from_slice(&sum.to_be_bytes());
        }
    }
    fn assert_checksums(bytes: &[u8]) {
        for (start, length, offset) in upstream_ranges() {
            let mut data = bytes.to_vec();
            if offset == 0x10 {
                data[0x10..0x12].fill(0);
            }
            assert_eq!(
                u16::from_be_bytes([bytes[offset], bytes[offset + 1]]),
                sum16(&data, start, length),
                "checksum at {offset:#x}"
            );
        }
    }
    fn input_with(fill: u8) -> SaveDetectionInput {
        let mut bytes = vec![fill; 32768];
        bytes[..8].copy_from_slice(b"F-ZERO X");
        // Option and cup progression bytes decode to their documented ranges.
        bytes[0x8] = 0;
        // Course records start uncleared with an unset color.
        for course in 0..24 {
            for place in 0..5 {
                let time = course * 0x110 + 0x24 + place * 4;
                bytes[time..time + 4].copy_from_slice(&TIME_UNCLEARED.to_be_bytes());
                let color = course * 0x110 + 0x78 + place * 0x20;
                bytes[color..color + 3].fill(0);
            }
        }
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("f-zero-x".into()),
            rom_sha1: None,
        }
    }
    fn input() -> SaveDetectionInput {
        input_with(0x5a)
    }
    fn swap_words(bytes: &[u8]) -> Vec<u8> {
        bytes
            .chunks_exact(4)
            .flat_map(|word| word.iter().rev().copied())
            .collect()
    }
    fn edit(id: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: id.into(),
            value,
        }
    }
    fn parsed(input: &SaveDetectionInput, id: &str) -> SaveValue {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        handler
            .parse(input, &identity)
            .unwrap()
            .fields
            .into_iter()
            .find(|field| field.id == id)
            .unwrap_or_else(|| panic!("missing {id}"))
            .value
    }

    #[test]
    fn edit_repairs_checksum_and_rejects_bad_signature() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "jack_cup".into(),
                    value: SaveValue::U32(4),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[0xa], 4);
        assert_ne!(&bytes[0xe..0x10], &original.bytes[0xe..0x10]);
        assert_eq!(&bytes[0x130..0x7380], &original.bytes[0x130..0x7380]);
        assert_checksums(&bytes);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[0] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    #[test]
    fn edits_word_swapped_sram_without_changing_its_byte_order() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let normalized = input();
        let physical = SaveDetectionInput {
            bytes: swap_words(&normalized.bytes),
            ..normalized
        };
        let bytes = handler
            .apply(
                &physical,
                &identity,
                &[SaveEdit {
                    field: "jack_cup".into(),
                    value: SaveValue::U32(4),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&bytes[..8], b"EZ-FX OR");
        assert_eq!(bytes[0xa ^ 3], 4);
        let normalized_output = swap_words(&bytes);
        assert_eq!(
            u16::from_be_bytes([normalized_output[0xe], normalized_output[0xf]]),
            normalized_output[..0xe]
                .iter()
                .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)))
        );
    }

    #[test]
    fn schema_grows_to_options_cups_and_time_attack_fields() {
        let handler = schemas().remove(0);
        assert_eq!(handler.game.fields.len(), 5 + 5 + 4 * 30 * 5 + 24 * 11);
        let mut bits = std::collections::HashSet::new();
        for field in handler
            .game
            .fields
            .iter()
            .filter(|field| field.id.starts_with("cups."))
        {
            assert!((0x7f90..0x7fe0).contains(&field.offset), "{}", field.id);
            assert!(bits.insert((field.offset, field.bit)), "{}", field.id);
        }
        assert_eq!(bits.len(), 600);
    }

    #[test]
    fn cup_flags_match_the_upstream_bit_addresses() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        // Addresses copied from the upstream Cups tab, offset by 0x14 per difficulty.
        let samples = [
            ("novice", "blue_falcon", "jack", 0x7f91, 0),
            ("novice", "golden_fox", "joker", 0x7f90, 0),
            ("novice", "wild_goose", "x", 0x7f90, 6),
            ("novice", "crazy_bear", "jack", 0x7f9e, 2),
            ("standard", "sonic_phantom", "king", 0x7fa3 + 0x14, 7),
            ("expert", "iron_tiger", "joker", 0x7f94 + 0x28, 0),
            ("master", "big_fang", "queen", 0x7fa1 + 0x3c, 6),
            ("master", "mighty_typhoon", "x", 0x7fa0 + 0x3c, 6),
        ];
        let mut original = input();
        original.bytes[0x7f90..0x7fe0].fill(0);
        repair(&mut original.bytes);
        for (difficulty, machine, cup, offset, bit) in samples {
            let id = format!("cups.{difficulty}.{machine}.{cup}");
            let mut expected = original.bytes.clone();
            expected[offset] |= 1 << bit;
            let checksum = sum16(&expected, 0x7f82, 0x7e);
            expected[0x7f80..0x7f82].copy_from_slice(&checksum.to_be_bytes());
            let bytes = handler
                .apply(
                    &original,
                    &identity,
                    &[edit(&id, SaveValue::Bool(true))],
                    false,
                )
                .unwrap()
                .bytes
                .unwrap();
            assert_eq!(bytes, expected, "{id}");
            let saved = SaveDetectionInput {
                bytes,
                ..original.clone()
            };
            assert_eq!(parsed(&saved, &id), SaveValue::Bool(true));
        }
    }

    #[test]
    fn option_edits_update_header_bits_and_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let edits = [
            edit("options.vs_com", SaveValue::Bool(true)),
            edit("options.vs_slot", SaveValue::Bool(true)),
            edit("options.vs_handicap", SaveValue::Enum("plus_2".into())),
            edit("options.sound_mode", SaveValue::Bool(true)),
            edit("options.everything_unlocked", SaveValue::Bool(true)),
        ];
        let bytes = handler
            .apply(&original, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[8], 0b0010_1111);
        assert_checksums(&bytes);
        let mut invalid = edits.to_vec();
        invalid[2].value = SaveValue::Enum("raw:3".into());
        assert!(
            handler
                .apply(&original, &identity, &invalid, false)
                .is_err()
        );
    }

    #[test]
    fn time_attack_edits_repair_only_their_record_and_default_the_color() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        // Place 2 of course 24 holds a color already, place 1 of course 2 does not.
        let mut seeded = original.clone();
        let color = 23 * 0x110 + 0x78 + 0x20;
        seeded.bytes[color..color + 3].copy_from_slice(&[0x12, 0x34, 0x56]);
        repair(&mut seeded.bytes);
        let edits = [
            edit(
                "time_attack.silence.place_1.time_ms",
                SaveValue::U32(83_456),
            ),
            edit("time_attack.big_hand.place_2.time_ms", SaveValue::U32(0)),
            edit(
                "time_attack.big_hand.best_lap_ms",
                SaveValue::U32(3_599_999),
            ),
            edit("time_attack.mute_city.best_lap_ms", SaveValue::U32(1)),
            edit("death_race_time", SaveValue::U32(0xffff_ffff)),
        ];
        let bytes = handler
            .apply(&seeded, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        assert_checksums(&bytes);
        let mut expected = seeded.bytes.clone();
        let record = 0x110;
        expected[record + 0x24..record + 0x28].copy_from_slice(&83_456u32.to_be_bytes());
        expected[record + 0x78..record + 0x7b].copy_from_slice(&[0, 0, 0xff]);
        let last = 23 * 0x110;
        expected[last + 0x28..last + 0x2c].copy_from_slice(&0u32.to_be_bytes());
        expected[last + 0x50..last + 0x54].copy_from_slice(&3_599_999u32.to_be_bytes());
        expected[0x50..0x54].copy_from_slice(&1u32.to_be_bytes());
        expected[0x14..0x18].copy_from_slice(&0xffff_ffffu32.to_be_bytes());
        repair(&mut expected);
        assert_eq!(bytes, expected);
        assert_eq!(&bytes[color..color + 3], &[0x12, 0x34, 0x56]);
    }

    #[test]
    fn time_attack_names_need_a_set_time_and_the_game_character_set() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let name = "time_attack.sand_ocean.place_3.name";
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[edit(name, SaveValue::Text("AB".into()))],
                    false
                )
                .is_err(),
            "uncleared places keep their names read-only"
        );
        let mut cleared = original.clone();
        let time = 2 * 0x110 + 0x24 + 2 * 4;
        cleared.bytes[time..time + 4].copy_from_slice(&90_000u32.to_be_bytes());
        repair(&mut cleared.bytes);
        let bytes = handler
            .apply(
                &cleared,
                &identity,
                &[edit(name, SaveValue::Text("A-'".into()))],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        let offset = 2 * 0x110 + 0x54 + 2 * 4;
        assert_eq!(&bytes[offset..offset + 3], b"A-'");
        assert_checksums(&bytes);
        let short = handler
            .apply(
                &cleared,
                &identity,
                &[edit(name, SaveValue::Text("Z!".into()))],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&short[offset..offset + 3], b"Z!\0");
        for rejected in ["ab", "A_B", "ABCD"] {
            assert!(
                handler
                    .apply(
                        &cleared,
                        &identity,
                        &[edit(name, SaveValue::Text(rejected.into()))],
                        false
                    )
                    .is_err(),
                "{rejected}"
            );
        }
    }

    #[test]
    fn record_checksums_wrap_and_every_course_is_validated() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        // Fill the whole first record so its sum (0xff * 0x10e) exceeds 16 bits.
        let mut full = input_with(0xff);
        let record = TIME_ATTACK_START + 2..TIME_ATTACK_START + RECORD_SIZE;
        full.bytes[record.clone()].fill(0xff);
        repair(&mut full.bytes);
        let total: u32 = full.bytes[record].iter().map(|&byte| u32::from(byte)).sum();
        assert!(total > 0xffff);
        let bytes = handler
            .apply(
                &full,
                &identity,
                &[edit("time_attack.mute_city.best_lap_ms", SaveValue::U32(7))],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_checksums(&bytes);
        for course in [1usize, 12, 23] {
            let mut corrupt = input();
            corrupt.bytes[0x20 + course * 0x110 + 0x40] ^= 1;
            assert!(
                handler
                    .apply(
                        &corrupt,
                        &identity,
                        &[edit("jack_cup", SaveValue::U32(1))],
                        false
                    )
                    .is_err(),
                "course {course} record must be validated"
            );
        }
    }

    #[test]
    fn time_attack_edits_survive_word_swapped_sram() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let normalized = input();
        let edits = [
            edit(
                "time_attack.big_hand.place_5.time_ms",
                SaveValue::U32(12_345),
            ),
            edit("cups.master.mad_wolf.x", SaveValue::Bool(true)),
        ];
        let expected = handler
            .apply(&normalized, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let physical = SaveDetectionInput {
            bytes: swap_words(&normalized.bytes),
            ..normalized
        };
        let swapped = handler
            .apply(&physical, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(swap_words(&swapped), expected);
    }
}
