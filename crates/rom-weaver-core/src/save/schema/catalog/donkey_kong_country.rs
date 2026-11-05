use super::super::rules::{ReadValue, Scalar, Store};
use super::*;
use tracing::trace;

// Layout, completion rate, progression, and language write rules: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/donkey-kong-country/saveEditor
// Original checksum and counter layout: https://github.com/RyudoSynbios/game-tools-collection/tree/fd8ca0beba05723fcfdb5af83c453ba9bea1221a/src/lib/templates/donkey-kong-country/saveEditor

/// Slot, player, and byte offset of each player block; slots are 0x2a8 bytes and players 0x154.
const PLAYERS: [(usize, usize, usize); 6] = [
    (1, 1, 0),
    (1, 2, 0x154),
    (2, 1, 0x2a8),
    (2, 2, 0x3fc),
    (3, 1, 0x550),
    (3, 2, 0x6a4),
];

const LANGUAGES: [&[u8; 8]; 3] = [b"ENGLISH ", b"FRENCH  ", b"GERMAN  "];

/// Slug, label, level-state byte, distance to the world-map copy of that byte (0 for none), and the
/// bonus rooms that exist for the level. Bit 0 and bit 7 of the byte are the Donkey and Diddy clear
/// flags; bit N is bonus room N.
const LEVELS: [(&str, &str, usize, usize, &[u8]); 40] = [
    ("jungle_hijinxs", "Jungle Hijinxs", 0x2e, 0, &[1, 2]),
    ("ropey_rampage", "Ropey Rampage", 0x24, 0, &[1, 2]),
    ("reptile_rumble", "Reptile Rumble", 0x19, 0, &[1, 2, 3]),
    ("coral_capers", "Coral Capers", 0xd7, 0, &[]),
    (
        "barrel_cannon_canyon",
        "Barrel Cannon Canyon",
        0x2f,
        0,
        &[1, 2],
    ),
    ("very_gnawty_s_lair", "Very Gnawty's Lair", 0xf8, 12, &[]),
    ("winky_s_walkway", "Winky's Walkway", 0xf1, 0, &[1]),
    ("mine_cart_carnage", "Mine Cart Carnage", 0x46, 0, &[]),
    ("bouncy_bonanza", "Bouncy Bonanza", 0x1f, 0, &[1, 2]),
    ("stop_go_station", "Stop & Go Station", 0x49, 0, &[1, 2]),
    ("millstone_mayhem", "Millstone Mayhem", 0x5a, 0, &[1, 2, 3]),
    ("necky_s_nuts", "Necky's Nuts", 0xf9, 12, &[]),
    ("vulture_culture", "Vulture Culture", 0xbd, 0, &[1, 2, 3]),
    ("tree_top_town", "Tree Top Town", 0xbc, 0, &[1, 2]),
    ("forest_frenzy", "Forest Frenzy", 0xe8, 0, &[1, 2]),
    ("temple_tempest", "Temple Tempest", 0x5b, 0, &[1, 2]),
    (
        "orang_utan_gang",
        "Orang-utan Gang",
        0x25,
        0,
        &[1, 2, 3, 4, 5],
    ),
    ("clam_city", "Clam City", 0xf6, 0, &[]),
    ("bumble_b_rumble", "Bumble B Rumble", 0xfd, 4, &[]),
    (
        "snow_barrel_blast",
        "Snow Barrel Blast",
        0x3c,
        0,
        &[1, 2, 3],
    ),
    ("slipslide_ride", "Slipslide Ride", 0x85, 0, &[1, 2, 3]),
    ("ice_age_alley", "Ice Age Alley", 0xbf, 0, &[1, 2]),
    ("croctopus_chase", "Croctopus Chase", 0x56, 0, &[]),
    ("torchlight_trouble", "Torchlight Trouble", 0x2c, 0, &[1, 2]),
    ("rope_bridge_rumble", "Rope Bridge Rumble", 0xe6, 0, &[1, 2]),
    (
        "really_gnawty_rampage",
        "Really Gnawty Rampage",
        0xfa,
        6,
        &[],
    ),
    ("oil_drum_alley", "Oil Drum Alley", 0x58, 0, &[1, 2, 3, 4]),
    ("trick_track_trek", "Trick Track Trek", 0x47, 0, &[1, 2, 3]),
    ("elevator_antics", "Elevator Antics", 0x30, 0, &[1, 2, 3]),
    ("poison_pond", "Poison Pond", 0x3a, 0, &[]),
    (
        "mine_cart_madness",
        "Mine Cart Madness",
        0x3f,
        0,
        &[1, 2, 3],
    ),
    ("blackout_basement", "Blackout Basement", 0x59, 0, &[1, 2]),
    ("boss_dumb_drum", "Boss Dumb Drum", 0xfb, 4, &[]),
    ("tanked_up_trouble", "Tanked Up Trouble", 0x48, 0, &[1]),
    ("manic_mincers", "Manic Mincers", 0x2a, 0, &[1, 2]),
    ("misty_mine", "Misty Mine", 0x22, 0, &[1, 2]),
    ("loppy_lights", "Loppy Lights", 0x4e, 0, &[1, 2]),
    ("platform_perils", "Platform Perils", 0x43, 0, &[1, 2]),
    ("necky_s_revenge", "Necky's Revenge", 0xfc, 2, &[]),
    ("gang_plank_galleon", "Gang-Plank Galleon", 0x76, 10, &[]),
];

/// The game stores the share of cleared levels and found bonus rooms in the byte before the
/// level-state array, counting every level byte except the Gang-Plank Galleon world-map copy.
fn completion_store(base: usize) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset: base + 0x16,
            storage: Storage::U8,
            mask: None,
        },
        value: ReadValue::new(move |bytes| {
            let percent: u32 = (1..0xe2)
                .filter(|index| *index != 0x6a)
                .map(|index| (bytes[base + 0x16 + index] & 0x7f).count_ones())
                .sum();
            trace!(
                base,
                percent, "recomputed Donkey Kong Country completion rate"
            );
            Ok(i64::from(percent))
        }),
    }
}

fn progression_fields(prefix: &str, base: usize) -> Vec<FieldDefinition> {
    let completion = completion_store(base);
    let mut fields = Vec::new();
    for (slug, label, offset, copy, rooms) in LEVELS {
        let state = base + offset;
        let mut cleared_effects = Vec::new();
        if copy != 0 {
            // The world map reads its own copy of the clear flags.
            cleared_effects.push(Store {
                when: None,
                destination: Scalar {
                    offset: state + copy,
                    storage: Storage::U8,
                    mask: None,
                },
                value: ReadValue::new(move |bytes| Ok(i64::from(bytes[state] & 0x81))),
            });
        }
        cleared_effects.push(completion.clone());
        for (suffix, text, bit) in [
            ("cleared", "cleared", 0),
            ("cleared_with_diddy", "cleared with Diddy", 7),
        ] {
            fields.push(
                catalog_field(
                    &format!("{prefix}.levels.{slug}.{suffix}"),
                    &format!("{label} {text}"),
                    state,
                    Storage::Bit,
                )
                .bit(bit)
                .behavior(field::FieldBehavior {
                    on_edit: cleared_effects.clone(),
                    ..Default::default()
                }),
            );
        }
        for room in rooms {
            fields.push(
                catalog_field(
                    &format!("{prefix}.levels.{slug}.bonus_room_{room}"),
                    &format!("{label} bonus room {room}"),
                    state,
                    Storage::Bit,
                )
                .bit(*room)
                .behavior(field::FieldBehavior {
                    on_edit: vec![completion.clone()],
                    ..Default::default()
                }),
            );
        }
    }
    fields
}

// The language is stored as eight ASCII characters at the start of the slot; the first one selects it.
fn language_field(slot: usize, base: usize) -> FieldDefinition {
    let stores = (0..8)
        .rev()
        .map(|index| Store {
            when: None,
            destination: Scalar {
                offset: base + index,
                storage: Storage::U8,
                mask: None,
            },
            value: ReadValue::new(move |bytes| {
                LANGUAGES
                    .get(usize::from(bytes[base]))
                    .map(|text| i64::from(text[index]))
                    .ok_or_else(|| {
                        invalid(
                            "the Donkey Kong Country language must be English, French, or German",
                        )
                    })
            }),
        })
        .collect();
    catalog_field(
        &format!("slot_{slot}.language"),
        "Language",
        base,
        Storage::U8,
    )
    .choices(choices(&[("English", 0), ("French", 1), ("German", 2)]))
    .behavior(field::FieldBehavior {
        read: Some(ReadValue::new(move |bytes| {
            Ok(match bytes[base] {
                b'F' => 1,
                b'G' => 2,
                _ => 0,
            })
        })),
        on_edit: stores,
        ..Default::default()
    })
}

fn default() -> GameDefinition {
    {
        let fields = vec![
            catalog_field("slot_1.player_1.location", "Location code", 21, Storage::U8),
            catalog_field(
                "slot_1.player_1.play_time",
                "Play-time counter",
                19,
                Storage::U16Le,
            ),
            catalog_field(
                "slot_1.player_1.completion",
                "Completion percentage",
                22,
                Storage::U8,
            )
            .editable(false),
            catalog_field("slot_1.player_1.mode", "Mode code", 16, Storage::U8).editable(false),
        ];
        GameDefinition {
            fields,
            description: concat!(
                "Edits independent counters in Slot 1, Player 1; preserves other ",
                "slots. Level clears and bonus rooms update the completion rate; ",
                "inventory and location updates remain unsupported. Numeric values use full storage ",
                "ranges; playable states are not guaranteed. EUR/USA/JPN layouts."
            )
            .into(),
            signatures: vec![SignatureDefinition {
                offset: 12,
                bytes: vec![65, 82, 69, 82],
            }],
            checksums: vec![
                ChecksumDefinition {
                    start: Some(12),
                    length: Some(274),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 8)
                },
                ChecksumDefinition {
                    start: Some(12),
                    length: Some(274),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 10)
                },
            ],
            ..GameDefinition::new("".into(), "".into(), "snes".into(), 2048)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let mut games = vec![
        game_donkey_kong_country_slot_1_player_1(),
        game_donkey_kong_country_slot_1_player_2(),
        game_donkey_kong_country_slot_2_player_1(),
        game_donkey_kong_country_slot_2_player_2(),
        game_donkey_kong_country_slot_3_player_1(),
        game_donkey_kong_country_slot_3_player_2(),
    ];

    for (game, (slot, player, base)) in games.iter_mut().zip(PLAYERS) {
        game.fields.extend(progression_fields(
            &format!("slot_{slot}.player_{player}"),
            base,
        ));
        if player == 1 {
            game.fields.push(language_field(slot, base));
        }
    }

    build(games, codecs, true)
}

fn game_donkey_kong_country_slot_1_player_1() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-slot-1-player-1".into();
    game.name = "Donkey Kong Country (Slot 1, Player 1)".into();
    game
}

fn game_donkey_kong_country_slot_1_player_2() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-slot-1-player-2".into();
    game.name = "Donkey Kong Country (Slot 1, Player 2)".into();
    game.description = concat!(
        "Edits independent counters in Slot 1, Player 2; preserves other ",
        "slots. Level clears and bonus rooms update the completion rate; ",
        "inventory and location updates remain unsupported. Numeric values use full storage ",
        "ranges; playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 352,
        bytes: vec![65, 82, 69, 82],
    }];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(352),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 348)
        },
        ChecksumDefinition {
            start: Some(352),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 350)
        },
    ];
    let fields = vec![
        catalog_field(
            "slot_1.player_2.location",
            "Location code",
            361,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.player_2.play_time",
            "Play-time counter",
            359,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.player_2.completion",
            "Completion percentage",
            362,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_1.player_2.mode", "Mode code", 356, Storage::U8).editable(false),
    ];
    game.fields = fields;
    game
}

fn game_donkey_kong_country_slot_2_player_1() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-slot-2-player-1".into();
    game.name = "Donkey Kong Country (Slot 2, Player 1)".into();
    game.description = concat!(
        "Edits independent counters in Slot 2, Player 1; preserves other ",
        "slots. Level clears and bonus rooms update the completion rate; ",
        "inventory and location updates remain unsupported. Numeric values use full storage ",
        "ranges; playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 692,
        bytes: vec![65, 82, 69, 82],
    }];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(692),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 688)
        },
        ChecksumDefinition {
            start: Some(692),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 690)
        },
    ];
    let fields = vec![
        catalog_field(
            "slot_2.player_1.location",
            "Location code",
            701,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.player_1.play_time",
            "Play-time counter",
            699,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_2.player_1.completion",
            "Completion percentage",
            702,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_2.player_1.mode", "Mode code", 696, Storage::U8).editable(false),
    ];
    game.fields = fields;
    game
}

fn game_donkey_kong_country_slot_2_player_2() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-slot-2-player-2".into();
    game.name = "Donkey Kong Country (Slot 2, Player 2)".into();
    game.description = concat!(
        "Edits independent counters in Slot 2, Player 2; preserves other ",
        "slots. Level clears and bonus rooms update the completion rate; ",
        "inventory and location updates remain unsupported. Numeric values use full storage ",
        "ranges; playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 1032,
        bytes: vec![65, 82, 69, 82],
    }];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1032),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 1028)
        },
        ChecksumDefinition {
            start: Some(1032),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1030)
        },
    ];
    let fields = vec![
        catalog_field(
            "slot_2.player_2.location",
            "Location code",
            1041,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.player_2.play_time",
            "Play-time counter",
            1039,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_2.player_2.completion",
            "Completion percentage",
            1042,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_2.player_2.mode", "Mode code", 1036, Storage::U8).editable(false),
    ];
    game.fields = fields;
    game
}

fn game_donkey_kong_country_slot_3_player_1() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-slot-3-player-1".into();
    game.name = "Donkey Kong Country (Slot 3, Player 1)".into();
    game.description = concat!(
        "Edits independent counters in Slot 3, Player 1; preserves other ",
        "slots. Level clears and bonus rooms update the completion rate; ",
        "inventory and location updates remain unsupported. Numeric values use full storage ",
        "ranges; playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 1372,
        bytes: vec![65, 82, 69, 82],
    }];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1372),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 1368)
        },
        ChecksumDefinition {
            start: Some(1372),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1370)
        },
    ];
    let fields = vec![
        catalog_field(
            "slot_3.player_1.location",
            "Location code",
            1381,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.player_1.play_time",
            "Play-time counter",
            1379,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_3.player_1.completion",
            "Completion percentage",
            1382,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_3.player_1.mode", "Mode code", 1376, Storage::U8).editable(false),
    ];
    game.fields = fields;
    game
}

fn game_donkey_kong_country_slot_3_player_2() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-slot-3-player-2".into();
    game.name = "Donkey Kong Country (Slot 3, Player 2)".into();
    game.description = concat!(
        "Edits independent counters in Slot 3, Player 2; preserves other ",
        "slots. Level clears and bonus rooms update the completion rate; ",
        "inventory and location updates remain unsupported. Numeric values use full storage ",
        "ranges; playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 1712,
        bytes: vec![65, 82, 69, 82],
    }];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1712),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 1708)
        },
        ChecksumDefinition {
            start: Some(1712),
            length: Some(274),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1710)
        },
    ];
    let fields = vec![
        catalog_field(
            "slot_3.player_2.location",
            "Location code",
            1721,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.player_2.play_time",
            "Play-time counter",
            1719,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_3.player_2.completion",
            "Completion percentage",
            1722,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_3.player_2.mode", "Mode code", 1716, Storage::U8).editable(false),
    ];
    game.fields = fields;
    game
}

#[cfg(test)]
mod tests {
    use super::*;

    // Independent transcription of the upstream checksum: the xor word first, then the word sum.
    fn repair(bytes: &mut [u8], base: usize) {
        let (mut xor, mut sum) = (0u16, 0u16);
        for word in bytes[base + 12..base + 12 + 274].chunks(2) {
            let value = u16::from_le_bytes([word[0], word[1]]);
            xor ^= value;
            sum = sum.wrapping_add(value);
        }
        bytes[base + 8..base + 10].copy_from_slice(&xor.to_le_bytes());
        bytes[base + 10..base + 12].copy_from_slice(&sum.to_le_bytes());
    }

    fn template() -> Vec<u8> {
        let mut bytes = vec![0; 2048];
        for (_, _, base) in PLAYERS {
            bytes[base + 12..base + 16].copy_from_slice(b"ARER");
            // A cleared level with one bonus room keeps the template's completion nonzero.
            bytes[base + 0x2e] = 0x03;
            bytes[base + 0x16] = 2;
            repair(&mut bytes, base);
        }
        bytes
    }

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
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

    fn completion(bytes: &[u8], base: usize) -> u8 {
        let mut percent = 0;
        for (offset, byte) in bytes.iter().enumerate().take(base + 0xf8).skip(base + 0x17) {
            if offset != base + 0x80 {
                percent += (byte & 0x7f).count_ones();
            }
        }
        percent as u8
    }

    #[test]
    fn level_edits_update_world_copies_completion_and_only_their_checksum() {
        let handler = schemas().remove(3);
        let base = 0x3fc;
        let bytes = template();
        let edits = [
            edit(
                "slot_2.player_2.levels.jungle_hijinxs.cleared",
                SaveValue::Bool(false),
            ),
            edit(
                "slot_2.player_2.levels.jungle_hijinxs.bonus_room_2",
                SaveValue::Bool(true),
            ),
            edit(
                "slot_2.player_2.levels.ropey_rampage.cleared",
                SaveValue::Bool(true),
            ),
            edit(
                "slot_2.player_2.levels.ropey_rampage.cleared_with_diddy",
                SaveValue::Bool(true),
            ),
            edit(
                "slot_2.player_2.levels.very_gnawty_s_lair.cleared",
                SaveValue::Bool(true),
            ),
            edit(
                "slot_2.player_2.levels.necky_s_revenge.cleared",
                SaveValue::Bool(true),
            ),
            edit(
                "slot_2.player_2.levels.gang_plank_galleon.cleared",
                SaveValue::Bool(true),
            ),
        ];
        let mut expected = bytes.clone();
        expected[base + 0x2e] = 0x06;
        expected[base + 0x24] = 0x81;
        expected[base + 0xf8] = 0x01;
        expected[base + 0x104] = 0x01;
        expected[base + 0xfc] = 0x01;
        expected[base + 0xfe] = 0x01;
        expected[base + 0x76] = 0x01;
        expected[base + 0x80] = 0x01;
        // Counted: 0x2e (two room bits), 0x24 and 0x76 (bit 0 each). The world-map copies (0x80 and above 0xf7) are not.
        expected[base + 0x16] = completion(&expected, base);
        assert_eq!(expected[base + 0x16], 4);
        repair(&mut expected, base);
        assert_eq!(apply(&handler, bytes.clone(), &edits).unwrap(), expected);
        // The other five player blocks keep their bytes and checksums.
        let output = apply(&handler, bytes.clone(), &edits).unwrap();
        for (_, _, other) in PLAYERS.into_iter().filter(|(_, _, other)| *other != base) {
            assert_eq!(output[other..other + 340], bytes[other..other + 340]);
        }
    }

    #[test]
    fn completion_rate_overflow_rejects_the_edit() {
        let handler = schemas().remove(0);
        let mut bytes = template();
        bytes[0x17..=0xf7].fill(0x7f);
        repair(&mut bytes, 0);
        let edit = edit(
            "slot_1.player_1.levels.jungle_hijinxs.cleared",
            SaveValue::Bool(false),
        );
        assert!(apply(&handler, bytes, &[edit]).is_err());
    }

    #[test]
    fn language_rewrites_all_eight_characters_and_rejects_unknown_values() {
        let handler = schemas().remove(2);
        let base = 0x2a8;
        let mut bytes = template();
        bytes[base..base + 8].copy_from_slice(b"ENGLISH ");
        let choice = |name: &str| SaveValue::Enum(name.into());
        let mut expected = bytes.clone();
        expected[base..base + 8].copy_from_slice(b"FRENCH  ");
        let french = apply(
            &handler,
            bytes.clone(),
            &[edit("slot_2.language", choice("French"))],
        )
        .unwrap();
        assert_eq!(french, expected);
        expected[base..base + 8].copy_from_slice(b"GERMAN  ");
        let german = apply(
            &handler,
            french.clone(),
            &[edit("slot_2.language", choice("German"))],
        )
        .unwrap();
        assert_eq!(german, expected);
        expected[base..base + 8].copy_from_slice(b"ENGLISH ");
        assert_eq!(
            apply(
                &handler,
                german,
                &[edit("slot_2.language", choice("English"))]
            )
            .unwrap(),
            expected
        );
        assert!(apply(&handler, bytes, &[edit("slot_2.language", choice("raw:3"))]).is_err());
        assert!(
            schemas()[3]
                .game
                .fields
                .iter()
                .all(|field| field.id != "slot_2.language")
        );
    }
}
