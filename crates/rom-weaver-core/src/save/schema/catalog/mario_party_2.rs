use super::mario_party::{CHARACTERS, bit_field};
use super::*;
use tracing::{debug, trace};

const BOARDS: [(&str, &str); 6] = [
    ("western_land", "Western Land"),
    ("pirate_land", "Pirate Land"),
    ("horror_land", "Horror Land"),
    ("space_land", "Space Land"),
    ("mystery_land", "Mystery Land"),
    ("bowser_land", "Bowser Land"),
];
// Category, slug, label, then the offset and bit of the "played" flag. The "bought"
// flag is the same bit nine bytes later.
const MINIGAMES: [(&str, &str, &str, usize, u8); 58] = [
    ("four_player", "lava_tile_isle", "Lava Tile Isle", 0x28, 4),
    ("four_player", "hot_rope_jump", "Hot Rope Jump", 0x28, 5),
    ("four_player", "shell_shocked", "Shell Shocked", 0x28, 6),
    ("four_player", "toad_in_the_box", "TOAD in the Box", 0x28, 7),
    ("four_player", "mecha_marathon", "Mecha-Marathon", 0x29, 0),
    ("four_player", "roll_call", "Roll Call", 0x29, 1),
    ("four_player", "abandon_ship", "Abandon Ship", 0x29, 2),
    ("four_player", "platform_peril", "Platform Peril", 0x29, 3),
    (
        "four_player",
        "totem_pole_pound",
        "Totem Pole Pound",
        0x29,
        4,
    ),
    ("four_player", "bumper_balls", "Bumper Balls", 0x29, 5),
    ("four_player", "bombs_away", "Bombs Away", 0x29, 7),
    ("four_player", "tipsy_tourney", "Tipsy Tourney", 0x2a, 0),
    ("four_player", "honeycomb_havoc", "Honeycomb Havoc", 0x2a, 1),
    ("four_player", "hexagon_heat", "Hexagon Heat", 0x2a, 2),
    (
        "four_player",
        "skateboard_scamper",
        "Skateboard Scamper",
        0x2a,
        3,
    ),
    ("four_player", "slot_car_derby", "Slot Car Derby", 0x2a, 4),
    ("four_player", "shy_guy_says", "Shy Guy Says", 0x2a, 5),
    ("four_player", "sneak_n_snore", "Sneak 'n' Snore", 0x2a, 6),
    ("four_player", "dizzy_dancing", "Dizzy Dancing", 0x2c, 4),
    ("four_player", "tile_driver", "Tile Driver", 0x2c, 5),
    (
        "four_player",
        "deep_sea_salvage",
        "Deep Sea Salvage",
        0x2c,
        7,
    ),
    ("one_vs_three", "bowl_over", "Bowl Over", 0x25, 6),
    ("one_vs_three", "crane_game", "Crane Game", 0x26, 0),
    (
        "one_vs_three",
        "move_to_the_music",
        "Move to the Music",
        0x26,
        1,
    ),
    (
        "one_vs_three",
        "bob_omb_barrage",
        "BOB-OMB Barrage",
        0x26,
        2,
    ),
    ("one_vs_three", "look_away", "Look Away", 0x26, 3),
    (
        "one_vs_three",
        "shock_drop_or_roll",
        "Shock Drop or Roll",
        0x26,
        4,
    ),
    ("one_vs_three", "lights_out", "Lights Out", 0x26, 5),
    ("one_vs_three", "filet_relay", "Filet Relay", 0x26, 6),
    ("one_vs_three", "archer_ival", "Archer-ival", 0x26, 7),
    (
        "one_vs_three",
        "quicksand_cache",
        "Quicksand Cache",
        0x2c,
        6,
    ),
    ("one_vs_three", "rainbow_run", "Rainbow Run", 0x25, 7),
    ("two_vs_two", "toad_bandstand", "TOAD Bandstand", 0x27, 1),
    ("two_vs_two", "bobsled_run", "Bobsled Run", 0x27, 2),
    ("two_vs_two", "handcar_havoc", "Handcar Havoc", 0x27, 3),
    ("two_vs_two", "balloon_burst", "Balloon Burst", 0x27, 5),
    ("two_vs_two", "sky_pilots", "Sky Pilots", 0x27, 6),
    ("two_vs_two", "speed_hockey", "Speed Hockey", 0x27, 7),
    ("two_vs_two", "cake_factory", "Cake Factory", 0x28, 0),
    ("two_vs_two", "magnet_carta", "Magnet Carta", 0x28, 3),
    (
        "two_vs_two",
        "looney_lumberjacks",
        "Looney Lumberjacks",
        0x2c,
        1,
    ),
    ("two_vs_two", "torpedo_targets", "Torpedo Targets", 0x2c, 2),
    (
        "two_vs_two",
        "destruction_duet",
        "Destruction Duet",
        0x2c,
        3,
    ),
    ("two_vs_two", "dungeon_dash", "Dungeon Dash", 0x28, 2),
    ("battle", "grab_bag", "Grab Bag", 0x24, 6),
    (
        "battle",
        "bumper_balloon_cars",
        "Bumper Balloon Cars",
        0x24,
        7,
    ),
    ("battle", "rakin_em_in", "Rakin' 'em In", 0x25, 0),
    ("battle", "day_at_the_races", "Day at the Races", 0x25, 2),
    ("battle", "face_lift", "Face Lift", 0x25, 3),
    ("battle", "crazy_cutters", "Crazy Cutters", 0x25, 4),
    ("battle", "hot_bob_omb", "Hot BOB-OMB", 0x25, 5),
    ("battle", "bowsers_big_blast", "BOWSER's Big Blast", 0x2c, 0),
    ("item", "bowser_slots", "BOWSER Slots", 0x24, 0),
    (
        "item",
        "roll_out_the_barrels",
        "Roll Out the Barrels",
        0x24,
        1,
    ),
    ("item", "coffin_congestion", "Coffin Congestion", 0x24, 2),
    ("item", "hammer_slammer", "Hammer Slammer", 0x24, 3),
    ("item", "give_me_a_breake", "Give Me a Breake!", 0x24, 4),
    ("item", "mallet_go_round", "Mallet-Go-Round", 0x24, 5),
];
const BOUGHT_DELTA: usize = 9;
// The bought flags fill 0x2d..0x34. Buying at least 50 minigames unlocks Driver's Ed,
// which the game records in the two flags just outside that range.
const BOUGHT_START: usize = 0x2d;
const BOUGHT_BYTES: usize = 7;
const DRIVERS_ED_PLAYED: usize = 0x2b;
const DRIVERS_ED_UNLOCKED: usize = 0x34;
const DRIVERS_ED_THRESHOLD: u32 = 50;
const COASTER_SAVES: [(&str, &str); 2] =
    [("save_space", "Save Space"), ("save_quit", "Save and Quit")];
const COASTER_SIZE: usize = 0x12;
const COASTER_WORLDS: [u8; 8] = [4, 5, 4, 5, 6, 6, 6, 6];
// Offset of the u16 time, in game frames: 1/50 s (1/60 s NTSC) except the 1/25 s (1/30 s NTSC) slot car derby.
const RECORDS: [(&str, &str, usize); 6] = [
    ("bobsled_run", "Bobsled Run", 0xc),
    ("handcar_havoc", "Handcar Havoc", 0xe),
    ("sky_pilots", "Sky Pilots", 0x10),
    ("slot_car_derby_1", "Slot Car Derby course 1", 0x14),
    ("slot_car_derby_2", "Slot Car Derby course 2", 0x16),
    ("slot_car_derby_3", "Slot Car Derby course 3", 0x18),
];

fn bit_store(
    offset: usize,
    bit: u8,
    value: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
) -> rules::Store {
    rules::Store {
        when: None,
        destination: rules::Scalar {
            offset,
            storage: Storage::U8,
            mask: Some(1 << bit),
        },
        value: rules::ReadValue::new(move |bytes| Ok(i64::from(value(bytes)))),
    }
}

fn bit_set(bytes: &[u8], offset: usize, bit: u8) -> bool {
    bytes[offset] >> bit & 1 == 1
}

// Driver's Ed unlocks once at least fifty minigames are bought, counting every stored bit.
fn drivers_ed_stores() -> Vec<rules::Store> {
    let unlocked = |bytes: &[u8]| {
        let bought: u32 = bytes[BOUGHT_START..BOUGHT_START + BOUGHT_BYTES]
            .iter()
            .map(|byte| byte.count_ones())
            .sum();
        trace!(bought, "counted bought Mario Party 2 minigames");
        bought >= DRIVERS_ED_THRESHOLD
    };
    vec![
        bit_store(DRIVERS_ED_PLAYED, 0, unlocked),
        bit_store(DRIVERS_ED_UNLOCKED, 0, unlocked),
    ]
}

fn board_play_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (board, (slug, name)) in BOARDS.into_iter().enumerate() {
        let first = 0x38 + board * 8;
        // Each board keeps a total at the two bytes before its counts and a played flag
        // in the shared flag stream starting at bit 5 of 0x80.
        let flag_bit = 0x80 * 8 + 5 + board;
        let effects = vec![
            rules::Store {
                when: None,
                destination: rules::Scalar {
                    offset: first - 2,
                    storage: Storage::U16Be,
                    mask: None,
                },
                value: rules::ReadValue::new(move |bytes| {
                    Ok(bytes[first..first + 6]
                        .iter()
                        .map(|count| i64::from(*count))
                        .sum())
                }),
            },
            bit_store(flag_bit / 8, (flag_bit % 8) as u8, move |bytes| {
                bytes[first..first + 6].iter().any(|count| *count > 0)
            }),
        ];
        for (index, (character, _)) in CHARACTERS.into_iter().enumerate() {
            fields.push(
                catalog_field(
                    &format!("board_plays.{slug}.{character}"),
                    &format!("{name} plays as {character}"),
                    first + index,
                    Storage::U8,
                )
                .min(0)
                .max(99)
                .behavior(field::FieldBehavior {
                    on_edit: effects.clone(),
                    ..Default::default()
                }),
            );
        }
    }
    fields
}

fn minigame_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (category, slug, label, offset, bit) in MINIGAMES {
        let bought = offset + BOUGHT_DELTA;
        // A minigame cannot be bought without being played: clearing "played" clears
        // "bought", and setting "bought" sets "played".
        let mut played_effects = vec![bit_store(bought, bit, move |bytes| {
            bit_set(bytes, bought, bit) && bit_set(bytes, offset, bit)
        })];
        played_effects.extend(drivers_ed_stores());
        let mut bought_effects = vec![bit_store(offset, bit, move |bytes| {
            bit_set(bytes, bought, bit) || bit_set(bytes, offset, bit)
        })];
        bought_effects.extend(drivers_ed_stores());
        for (kind, at, effects) in [
            ("played", offset, played_effects),
            ("bought", bought, bought_effects),
        ] {
            fields.push(
                catalog_field(
                    &format!("minigames.{category}.{slug}.{kind}"),
                    &format!("{label} ({}) {kind}", category.replace('_', " ")),
                    at,
                    Storage::Bit,
                )
                .bit(bit)
                .behavior(field::FieldBehavior {
                    on_edit: effects,
                    ..Default::default()
                }),
            );
        }
    }
    fields
}

fn coaster_fields() -> Vec<FieldDefinition> {
    let mut fields = vec![
        catalog_field(
            "coaster.progression",
            "Mini-Game Coaster progression",
            0x82,
            Storage::U8,
        )
        .mask(0x03)
        .choices(choices(&[
            ("none", 0),
            ("course_normal_clear", 1),
            ("course_hard_clear", 3),
        ]))
        .min(0)
        .max(3),
    ];
    for (index, (slug, name)) in COASTER_SAVES.into_iter().enumerate() {
        let shift = index * COASTER_SIZE;
        let id = |field: &str| format!("coaster.{slug}.{field}");
        let label = |field: &str| format!("Mini-Game Coaster {name} {field}");
        fields.push(bit_field(
            &id("pending"),
            &label("game pending"),
            (0x1c9 + shift) * 8,
        ));
        for (field, text, offset) in [
            ("player_character", "player character", 0x1c4),
            ("computer_character", "computer character", 0x1c5),
        ] {
            fields.push(
                catalog_field(&id(field), &label(text), offset + shift, Storage::U8)
                    .choices(choices(&CHARACTERS))
                    .min(0)
                    .max(5),
            );
        }
        fields.push(
            catalog_field(&id("course"), &label("course"), 0x1c8 + shift, Storage::U8)
                .choices(choices(&[("easy", 0), ("normal", 1), ("hard", 2)]))
                .min(0)
                .max(2),
        );
        // The save preview mirrors the world number, which the game counts from one.
        let world = 0x1c6 + shift;
        fields.push(
            catalog_field(
                &id("world"),
                &label("world (0 is world 1)"),
                world,
                Storage::U8,
            )
            .min(0)
            .max(8)
            .behavior(field::FieldBehavior {
                on_edit: vec![rules::Store {
                    when: None,
                    destination: rules::Scalar {
                        offset: world + 0xe,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: rules::ReadValue::new(move |bytes| Ok(i64::from(bytes[world]) + 1)),
                }],
                ..Default::default()
            }),
        );
        for (field, text, offset, max) in
            [("lives", "lives", 0x1c7, 99), ("coins", "coins", 0x1d1, 99)]
        {
            fields.push(
                catalog_field(&id(field), &label(text), offset + shift, Storage::U8)
                    .min(0)
                    .max(max),
            );
        }
        fields.push(
            catalog_field(
                &id("consecutive_clears"),
                &label("consecutive clears"),
                0x1d0 + shift,
                Storage::I8,
            )
            .min(0)
            .max(127),
        );
        let mut bit = (0x1ca + shift) * 8 + 1;
        for (world_index, size) in COASTER_WORLDS.into_iter().enumerate() {
            for number in 1..=size {
                fields.push(bit_field(
                    &id(&format!("cleared.world_{}_{number}", world_index + 1)),
                    &label(&format!("world {}-{number} cleared", world_index + 1)),
                    bit,
                ));
                bit += 1;
            }
        }
    }
    fields
}

fn record_fields() -> Vec<FieldDefinition> {
    let mut fields: Vec<_> = RECORDS
        .into_iter()
        .map(|(slug, name, offset)| {
            catalog_field(
                &format!("records.{slug}"),
                &format!("{name} best time (frames)"),
                offset,
                Storage::U16Be,
            )
        })
        .collect();
    // The distance is whole yards plus hundredths; both zero means the 20 yard default.
    fields.push(catalog_field(
        "records.mecha_marathon_yards",
        "Mecha-Marathon best distance (yards)",
        0x12,
        Storage::U8,
    ));
    fields.push(
        catalog_field(
            "records.mecha_marathon_hundredths",
            "Mecha-Marathon best distance (hundredths of a yard)",
            0x13,
            Storage::U8,
        )
        .min(0)
        .max(99),
    );
    for course in 0..5 {
        let offset = 0x1a + course * 2;
        // Both bytes zero means no record is stored.
        fields.push(
            catalog_field(
                &format!("records.drivers_ed_{}_seconds", course + 1),
                &format!("Driver's Ed course {} best time (seconds, BCD)", course + 1),
                offset,
                Storage::BcdBe,
            )
            .length(1)
            .min(0)
            .max(59),
        );
        fields.push(
            catalog_field(
                &format!("records.drivers_ed_{}_hundredths", course + 1),
                &format!(
                    "Driver's Ed course {} best time (hundredths, BCD)",
                    course + 1
                ),
                offset + 1,
                Storage::BcdBe,
            )
            .length(1)
            .min(0)
            .max(99),
        );
    }
    fields
}

fn option_fields() -> Vec<FieldDefinition> {
    vec![
        catalog_field("options.language", "Language", 0x9, Storage::U8)
            .choices(choices(&[
                ("none", 0),
                ("japanese", 1),
                ("english", 2),
                ("french", 3),
                ("german", 4),
                ("spanish", 5),
                ("italian", 6),
            ]))
            .min(0)
            .max(6)
            .description("Each release only stores the languages it ships with".into()),
        bit_field("options.sound_stereo", "Sound is stereo", 0x80 * 8 + 2),
    ]
}

// Layout, checksum, and extended fields: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/mario-party-2/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_mario_party_2_canonical_eeprom()];

    build(games, codecs, true)
}

fn game_mario_party_2_canonical_eeprom() -> GameDefinition {
    let fields = vec![
        catalog_field("coins", "Coins", 120, Storage::U32Be),
        catalog_field("bowser_land", "Bowser Land unlocked", 128, Storage::Bit).bit(1),
        catalog_field(
            "credits_machine",
            "Credits Machine unlocked",
            129,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "boards.western_land",
            "Western Land played",
            128,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "boards.pirate_land",
            "Pirate Land played",
            128,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "boards.horror_land",
            "Horror Land played",
            128,
            Storage::Bit,
        )
        .bit(7),
        catalog_field("boards.space_land", "Space Land played", 129, Storage::Bit).bit(0),
        catalog_field(
            "boards.mystery_land",
            "Mystery Land played",
            129,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "boards.bowser_land",
            "Bowser Land played",
            129,
            Storage::Bit,
        )
        .bit(2),
        catalog_field("drivers_ed.played", "Driver's Ed played", 43, Storage::Bit).bit(0),
        catalog_field(
            "drivers_ed.unlocked",
            "Driver's Ed unlocked",
            52,
            Storage::Bit,
        )
        .bit(0),
    ];
    let mut fields = fields;
    fields.extend(board_play_fields());
    fields.extend(minigame_fields());
    fields.extend(coaster_fields());
    fields.extend(record_fields());
    fields.extend(option_fields());
    debug!(fields = fields.len(), "built Mario Party 2 save fields");
    GameDefinition {
        fields,
        description: concat!(
            "Edits global progression, board play counts, Mini-Game Land, ",
            "Mini-Game Coaster state, and records in a canonical 2 KiB ",
            "EEPROM. Byte-swapped emulator images are omitted."
        )
        .into(),
        signatures: vec![SignatureDefinition {
            offset: 0,
            bytes: vec![72, 85, 68, 83, 79, 78],
        }],
        checksums: vec![ChecksumDefinition {
            start: Some(8),
            length: Some(498),
            unit: ChecksumUnit::U8,
            exclude: vec![ChecksumExclusion {
                offset: 504,
                length: 2,
            }],
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 504)
        }],
        ..GameDefinition::new(
            "mario-party-2-canonical-eeprom".into(),
            "Mario Party 2 (canonical EEPROM)".into(),
            "n64".into(),
            2048,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::save::{SaveDetectionInput, SaveEdit, SaveValue};

    // Sum of every byte from 0x8 to 0x1fa, counting the checksum field itself as zero.
    fn upstream_checksum(bytes: &[u8]) -> u16 {
        let mut checksum = 0u32;
        for (offset, byte) in bytes.iter().enumerate().take(0x1fa).skip(8) {
            if !(0x1f8..0x1fa).contains(&offset) {
                checksum += u32::from(*byte);
            }
        }
        (checksum & 0xffff) as u16
    }
    fn repair(bytes: &mut [u8]) {
        let checksum = upstream_checksum(bytes);
        bytes[0x1f8..0x1fa].copy_from_slice(&checksum.to_be_bytes());
    }
    fn input_with(fill: u8) -> SaveDetectionInput {
        let mut bytes = vec![fill; 2048];
        bytes[..6].copy_from_slice(b"HUDSON");
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("mario-party-2-canonical-eeprom".into()),
            rom_sha1: None,
        }
    }
    fn input() -> SaveDetectionInput {
        input_with(0)
    }
    fn edit(id: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: id.into(),
            value,
        }
    }
    fn apply(source: &SaveDetectionInput, edits: &[SaveEdit]) -> crate::Result<Vec<u8>> {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        handler
            .apply(source, &identity, edits, false)
            .map(|result| result.bytes.unwrap())
    }
    fn parsed(source: &SaveDetectionInput, id: &str) -> SaveValue {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        handler
            .parse(source, &identity)
            .unwrap()
            .fields
            .into_iter()
            .find(|field| field.id == id)
            .unwrap_or_else(|| panic!("missing {id}"))
            .value
    }

    fn assert_same(actual: &[u8], expected: &[u8]) {
        let differences: Vec<_> = actual
            .iter()
            .zip(expected)
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(offset, (a, b))| format!("{offset:#x}: {a:#x} != {b:#x}"))
            .collect();
        assert!(differences.is_empty(), "{differences:?}");
    }

    #[test]
    fn schema_exposes_board_plays_minigames_coaster_records_and_options() {
        let handler = schemas().remove(0);
        // 11 original fields, 36 board counts, 116 minigame flags, 1 + 2 * 50 coaster
        // fields, 18 records, and 2 options.
        assert_eq!(handler.game.fields.len(), 11 + 36 + 116 + 101 + 18 + 2);
        assert_eq!(MINIGAMES.len(), 58);
        assert_eq!(
            COASTER_WORLDS
                .iter()
                .map(|size| usize::from(*size))
                .sum::<usize>(),
            42
        );
    }

    #[test]
    fn board_play_counts_update_the_total_and_played_flag() {
        let source = input();
        let bytes = apply(
            &source,
            &[
                edit("board_plays.western_land.mario", SaveValue::U32(99)),
                edit("board_plays.western_land.dk", SaveValue::U32(1)),
                edit("board_plays.bowser_land.luigi", SaveValue::U32(7)),
            ],
        )
        .unwrap();
        let mut expected = source.bytes.clone();
        expected[0x38] = 99;
        expected[0x3d] = 1;
        expected[0x36..0x38].copy_from_slice(&100u16.to_be_bytes());
        // Western Land is flag bit 5 of 0x80 and Bowser Land is bit 2 of 0x81.
        expected[0x80] |= 1 << 5;
        expected[0x39 + 5 * 8] = 7;
        expected[0x36 + 5 * 8..0x38 + 5 * 8].copy_from_slice(&7u16.to_be_bytes());
        expected[0x81] |= 1 << 2;
        repair(&mut expected);
        assert_eq!(bytes, expected);
        let reset = SaveDetectionInput {
            bytes,
            ..source.clone()
        };
        let cleared = apply(
            &reset,
            &[
                edit("board_plays.western_land.mario", SaveValue::U32(0)),
                edit("board_plays.western_land.dk", SaveValue::U32(0)),
            ],
        )
        .unwrap();
        assert_eq!(&cleared[0x36..0x38], &[0, 0]);
        assert_eq!(cleared[0x80] & (1 << 5), 0);
        assert_eq!(cleared[0x81] & (1 << 2), 1 << 2);
        assert_eq!(
            upstream_checksum(&cleared),
            u16::from_be_bytes([cleared[0x1f8], cleared[0x1f9]])
        );
    }

    #[test]
    fn minigame_flags_keep_bought_implies_played_and_unlock_drivers_ed() {
        let source = input();
        // Buying an unplayed minigame also marks it played; un-playing clears the purchase.
        let bought = apply(
            &source,
            &[edit(
                "minigames.four_player.lava_tile_isle.bought",
                SaveValue::Bool(true),
            )],
        )
        .unwrap();
        assert_eq!(bought[0x28] >> 4 & 1, 1);
        assert_eq!(bought[0x31] >> 4 & 1, 1);
        let saved = SaveDetectionInput {
            bytes: bought,
            ..source.clone()
        };
        let reset = apply(
            &saved,
            &[edit(
                "minigames.four_player.lava_tile_isle.played",
                SaveValue::Bool(false),
            )],
        )
        .unwrap();
        assert_eq!(reset[0x28] >> 4 & 1, 0);
        assert_eq!(reset[0x31] >> 4 & 1, 0);
        assert_eq!(reset, source.bytes);
        // Buying the minigame that brings the stored bought bits to fifty unlocks Driver's Ed.
        let mut near = input();
        near.bytes[0x2d..0x33].fill(0xff);
        repair(&mut near.bytes);
        let first = apply(
            &near,
            &[edit(
                "minigames.four_player.tipsy_tourney.bought",
                SaveValue::Bool(true),
            )],
        )
        .unwrap();
        assert_eq!(
            (first[0x2b] & 1, first[0x34] & 1),
            (0, 0),
            "49 bits stay below fifty"
        );
        let second = apply(
            &near,
            &[
                edit(
                    "minigames.four_player.tipsy_tourney.bought",
                    SaveValue::Bool(true),
                ),
                edit(
                    "minigames.four_player.honeycomb_havoc.bought",
                    SaveValue::Bool(true),
                ),
            ],
        )
        .unwrap();
        assert_eq!((second[0x2b] & 1, second[0x34] & 1), (1, 1));
        let mut expected = near.bytes.clone();
        expected[0x33] |= 0b11;
        expected[0x2a] |= 0b11;
        expected[0x2b] |= 1;
        expected[0x34] |= 1;
        repair(&mut expected);
        assert_eq!(second, expected);
        // Dropping back under fifty clears both flags again.
        let unlocked = SaveDetectionInput {
            bytes: second,
            ..near
        };
        let dropped = apply(
            &unlocked,
            &[edit(
                "minigames.four_player.honeycomb_havoc.played",
                SaveValue::Bool(false),
            )],
        )
        .unwrap();
        assert_eq!((dropped[0x2b] & 1, dropped[0x34] & 1), (0, 0));
        assert_eq!(dropped[0x33] & 0b10, 0);
    }

    #[test]
    fn coaster_records_and_options_edit_their_bytes() {
        let source = input();
        let edits = [
            edit(
                "coaster.progression",
                SaveValue::Enum("course_hard_clear".into()),
            ),
            edit("coaster.save_space.pending", SaveValue::Bool(true)),
            edit(
                "coaster.save_space.player_character",
                SaveValue::Enum("wario".into()),
            ),
            edit("coaster.save_space.course", SaveValue::Enum("hard".into())),
            edit("coaster.save_space.world", SaveValue::U32(8)),
            edit("coaster.save_space.lives", SaveValue::U32(99)),
            edit("coaster.save_space.coins", SaveValue::U32(12)),
            edit("coaster.save_space.consecutive_clears", SaveValue::I32(127)),
            edit(
                "coaster.save_space.cleared.world_1_1",
                SaveValue::Bool(true),
            ),
            edit("coaster.save_quit.cleared.world_8_6", SaveValue::Bool(true)),
            edit("coaster.save_quit.world", SaveValue::U32(3)),
            edit(
                "coaster.save_quit.computer_character",
                SaveValue::Enum("dk".into()),
            ),
            edit("records.bobsled_run", SaveValue::U32(1234)),
            edit("records.slot_car_derby_3", SaveValue::U32(0xffff)),
            edit("records.mecha_marathon_yards", SaveValue::U32(127)),
            edit("records.mecha_marathon_hundredths", SaveValue::U32(99)),
            edit("records.drivers_ed_2_seconds", SaveValue::U32(59)),
            edit("records.drivers_ed_2_hundredths", SaveValue::U32(7)),
            edit("options.language", SaveValue::Enum("italian".into())),
            edit("options.sound_stereo", SaveValue::Bool(true)),
        ];
        let bytes = apply(&source, &edits).unwrap();
        let mut expected = source.bytes.clone();
        expected[0x82] |= 3;
        expected[0x1c9] |= 1;
        expected[0x1c4] = 4;
        expected[0x1c8] = 2;
        expected[0x1c6] = 8;
        expected[0x1d4] = 9;
        expected[0x1c7] = 99;
        expected[0x1d1] = 12;
        expected[0x1d0] = 127;
        expected[0x1ca] |= 1 << 1;
        // The second save lives 0x12 bytes later; world 8-6 is the 42nd bit after bit 1.
        expected[0x1ca + 0x12 + 5] |= 1 << 2;
        expected[0x1c6 + 0x12] = 3;
        expected[0x1d4 + 0x12] = 4;
        expected[0x1c5 + 0x12] = 5;
        expected[0xc..0xe].copy_from_slice(&1234u16.to_be_bytes());
        expected[0x18..0x1a].copy_from_slice(&0xffffu16.to_be_bytes());
        expected[0x12] = 127;
        expected[0x13] = 99;
        expected[0x1c] = 0x59;
        expected[0x1d] = 0x07;
        expected[0x9] = 6;
        expected[0x80] |= 1 << 2;
        repair(&mut expected);
        assert_same(&bytes, &expected);
        let saved = SaveDetectionInput { bytes, ..source };
        assert_eq!(
            parsed(&saved, "records.drivers_ed_2_seconds"),
            SaveValue::U32(59)
        );
        assert_eq!(
            parsed(&saved, "coaster.save_quit.cleared.world_8_6"),
            SaveValue::Bool(true)
        );
        assert_eq!(
            parsed(&saved, "coaster.save_space.consecutive_clears"),
            SaveValue::I32(127)
        );
    }

    #[test]
    fn invalid_values_and_corrupt_data_are_rejected() {
        let source = input();
        for (id, value) in [
            ("board_plays.pirate_land.yoshi", SaveValue::U32(100)),
            ("coaster.save_space.world", SaveValue::U32(9)),
            ("coaster.progression", SaveValue::Enum("raw:2".into())),
            ("records.drivers_ed_1_seconds", SaveValue::U32(60)),
            ("records.drivers_ed_1_hundredths", SaveValue::U32(100)),
            ("coaster.save_quit.consecutive_clears", SaveValue::I32(-1)),
        ] {
            assert!(apply(&source, &[edit(id, value)]).is_err(), "{id}");
        }
        let mut corrupt = input();
        corrupt.bytes[0x100] ^= 1;
        assert!(
            apply(
                &corrupt,
                &[edit("options.sound_stereo", SaveValue::Bool(true))]
            )
            .is_err()
        );
    }

    #[test]
    fn checksum_wraps_past_sixteen_bits() {
        // 0x99 is the largest fill whose BCD digits every BCD record still decodes.
        let source = input_with(0x99);
        let total: u32 = source
            .bytes
            .iter()
            .take(0x1f2)
            .map(|&byte| u32::from(byte))
            .sum();
        assert!(total > 0xffff);
        let bytes = apply(
            &source,
            &[edit("coaster.save_space.lives", SaveValue::U32(1))],
        )
        .unwrap();
        assert_eq!(
            u16::from_be_bytes([bytes[0x1f8], bytes[0x1f9]]),
            upstream_checksum(&bytes)
        );
    }
}
