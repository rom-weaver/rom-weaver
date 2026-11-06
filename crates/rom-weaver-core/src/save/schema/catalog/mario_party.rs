use super::*;
use tracing::{debug, trace};

const BOARDS: [(&str, &str); 8] = [
    ("dks_jungle_adventure", "DK's Jungle Adventure"),
    ("peachs_birthday_cake", "Peach's Birthday Cake"),
    ("yoshis_tropical_island", "Yoshi's Tropical Island"),
    ("warios_battle_canyon", "Wario's Battle Canyon"),
    ("luigis_engine_room", "Luigi's Engine Room"),
    ("marios_rainbow_castle", "Mario's Rainbow Castle"),
    ("bowsers_magma_mountain", "Bowser's Magma Mountain"),
    ("eternal_star", "Eternal Star"),
];
pub(super) const CHARACTERS: [(&str, i64); 6] = [
    ("mario", 0),
    ("luigi", 1),
    ("peach", 2),
    ("yoshi", 3),
    ("wario", 4),
    ("dk", 5),
];
// Category, slug, label, then the offset and bit of the "played" flag. The "bought"
// flag is the same bit seven bytes later.
const MINIGAMES: [(&str, &str, &str, usize, u8); 53] = [
    ("four_player", "buried_treasure", "Buried Treasure", 0x1a, 3),
    ("four_player", "treasure_divers", "Treasure Divers", 0x1a, 4),
    ("four_player", "hot_bob_omb", "Hot Bob-omb", 0x1a, 7),
    (
        "four_player",
        "musical_mushroom",
        "Musical Mushroom",
        0x1b,
        3,
    ),
    ("four_player", "crazy_cutter", "Crazy Cutter", 0x1b, 5),
    ("four_player", "face_lift", "Face Lift", 0x1b, 6),
    ("four_player", "balloon_burst", "Balloon Burst", 0x1c, 3),
    (
        "four_player",
        "coin_block_blitz",
        "Coin Block Blitz",
        0x1c,
        4,
    ),
    (
        "four_player",
        "skateboard_scamper",
        "Skateboard Scamper",
        0x1c,
        6,
    ),
    (
        "four_player",
        "box_mountain_mayhem",
        "Box Mountain Mayhem",
        0x1c,
        7,
    ),
    ("four_player", "platform_peril", "Platform Peril", 0x1d, 0),
    ("four_player", "mushroom_mix_up", "Mushroom Mix-Up", 0x1d, 2),
    ("four_player", "grab_bag", "Grab Bag", 0x1d, 4),
    ("four_player", "bumber_balls", "Bumber Balls", 0x1d, 6),
    ("four_player", "tipsy_tourney", "Tipsy Tourney", 0x1e, 1),
    ("four_player", "bombs_away", "Bombs Away", 0x1e, 2),
    ("four_player", "mario_bandstand", "Mario Bandstand", 0x1e, 6),
    ("four_player", "shy_guy_says", "Shy Guy Says", 0x1f, 0),
    ("four_player", "cast_aways", "Cast Aways", 0x1f, 3),
    ("four_player", "key_pa_way", "Key-pa-Way", 0x1f, 4),
    (
        "four_player",
        "running_of_the_bulb",
        "Running of the Bulb",
        0x1f,
        5,
    ),
    ("four_player", "hot_rope_jump", "Hot Rope Jump", 0x1f, 6),
    ("four_player", "hammer_drop", "Hammer Drop", 0x20, 7),
    (
        "four_player",
        "slot_car_derby_1",
        "Slot Car Derby 1",
        0x1a,
        6,
    ),
    (
        "four_player",
        "slot_car_derby_2",
        "Slot Car Derby 2",
        0x1b,
        0,
    ),
    ("one_vs_three", "pipe_maze", "Pipe Maze", 0x1b, 1),
    ("one_vs_three", "bash_n_cash", "Bash 'n' Cash", 0x1c, 0),
    ("one_vs_three", "bowl_over", "Bowl Over", 0x1c, 1),
    (
        "one_vs_three",
        "coin_block_bash",
        "Coin Block Bash",
        0x1c,
        5,
    ),
    (
        "one_vs_three",
        "tightrope_treachery",
        "TightRope Treachery",
        0x1d,
        7,
    ),
    ("one_vs_three", "crane_game", "Crane Game", 0x1e, 3),
    (
        "one_vs_three",
        "piranhas_pursuit",
        "Piranha's Pursuit",
        0x20,
        2,
    ),
    ("one_vs_three", "tug_o_war", "Tug o' War", 0x20, 3),
    ("one_vs_three", "paddle_battle", "Paddle Battle", 0x20, 4),
    (
        "one_vs_three",
        "coin_shower_flower",
        "Coin Shower Flower",
        0x20,
        6,
    ),
    ("two_vs_two", "bobsled_run", "Bobsled Run", 0x1d, 5),
    ("two_vs_two", "desert_dash", "Desert Dash", 0x1e, 7),
    ("two_vs_two", "bombsketball", "Bombsketball", 0x1f, 2),
    ("two_vs_two", "handcar_havoc", "Handcar Havoc", 0x1f, 7),
    ("two_vs_two", "deep_sea_divers", "Deep Sea Divers", 0x20, 1),
    ("one_player", "memory_match", "Memory Match", 0x1a, 0),
    ("one_player", "slot_machine", "Slot Machine", 0x1a, 2),
    ("one_player", "shell_game", "Shell Game", 0x1a, 5),
    ("one_player", "ghost_guess", "Ghost Guess", 0x1b, 2),
    ("one_player", "pedal_power", "Pedal Power", 0x1b, 4),
    ("one_player", "whack_a_plant", "Whack-a-Plant", 0x1b, 7),
    ("one_player", "ground_pound", "Ground Pound", 0x1c, 2),
    (
        "one_player",
        "teetering_towers",
        "Teetering Towers",
        0x1d,
        1,
    ),
    (
        "one_player",
        "knock_block_tower",
        "Knock Block Tower",
        0x1e,
        0,
    ),
    ("one_player", "limbo_dance", "Limbo Dance", 0x1f, 1),
    (
        "one_player",
        "bumber_ball_maze_1",
        "Bumber Ball Maze 1",
        0x1d,
        3,
    ),
    (
        "one_player",
        "bumber_ball_maze_2",
        "Bumber Ball Maze 2",
        0x1e,
        4,
    ),
    (
        "one_player",
        "bumber_ball_maze_3",
        "Bumber Ball Maze 3",
        0x20,
        5,
    ),
];
const BOUGHT_DELTA: usize = 7;
// World clear flags run as one bit stream from bit 7 of 0x186.
const CLEARED_START_BIT: usize = 0x186 * 8 + 7;
const WORLD_SIZES: [u8; 9] = [4, 5, 5, 4, 8, 6, 6, 6, 6];
// Offset of the u16 time, in game frames: 1/25 s (1/30 s NTSC) for the first group, 1/50 s (1/60 s NTSC) otherwise.
const RECORDS: [(&str, &str, usize); 8] = [
    ("slot_car_derby_1", "Slot Car Derby 1", 0xc),
    ("slot_car_derby_2", "Slot Car Derby 2", 0xe),
    ("mecha_fly_guy", "Mecha Fly Guy", 0x12),
    ("bobsled_run", "Bobsled Run", 0xa),
    ("handcar_havoc", "Handcar Havoc", 0x10),
    ("bumber_ball_maze_1", "Bumber Ball Maze 1", 0x14),
    ("bumber_ball_maze_2", "Bumber Ball Maze 2", 0x16),
    ("bumber_ball_maze_3", "Bumber Ball Maze 3", 0x18),
];

pub(super) fn bit_field(id: &str, label: &str, bit_index: usize) -> FieldDefinition {
    catalog_field(id, label, bit_index / 8, Storage::Bit).bit((bit_index % 8) as u8)
}

fn board_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (index, (slug, name)) in BOARDS.into_iter().enumerate() {
        let record = 0x28 + index * 4;
        // The warp pipe lists a board as played once it has any plays: bit `index + 1` from 0x52.
        let flag_bit = 0x52 * 8 + index + 1;
        let played = catalog_field(
            &format!("boards.{slug}.played"),
            &format!("{name} times played"),
            record,
            Storage::U16Be,
        )
        .mask(0x7fff)
        .min(0)
        .max(999)
        .behavior(field::FieldBehavior {
            on_edit: vec![rules::Store {
                when: None,
                destination: rules::Scalar {
                    offset: flag_bit / 8,
                    storage: Storage::U8,
                    mask: Some(1 << (flag_bit % 8)),
                },
                value: rules::ReadValue::new(move |bytes| {
                    let played = u16::from_be_bytes([bytes[record], bytes[record + 1]]) & 0x7fff;
                    trace!(record, played, "updated Mario Party board played flag");
                    Ok(i64::from(played > 0))
                }),
            }],
            ..Default::default()
        });
        fields.push(played);
        fields.push(
            catalog_field(
                &format!("boards.{slug}.stars"),
                &format!("{name} stars won"),
                record + 2,
                Storage::U16Be,
            )
            .min(0)
            .max(9999),
        );
        // The first six boards are always available.
        if index >= 6 {
            fields.push(
                catalog_field(
                    &format!("boards.{slug}.unlocked"),
                    &format!("{name} unlocked"),
                    record,
                    Storage::Bit,
                )
                .bit(7),
            );
        }
    }
    fields
}

fn minigame_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (category, slug, label, offset, bit) in MINIGAMES {
        for (kind, delta) in [("played", 0), ("bought", BOUGHT_DELTA)] {
            fields.push(
                catalog_field(
                    &format!("minigames.{category}.{slug}.{kind}"),
                    &format!("{label} ({}) {kind}", category.replace('_', " ")),
                    offset + delta,
                    Storage::Bit,
                )
                .bit(bit),
            );
        }
    }
    fields
}

fn island_fields() -> Vec<FieldDefinition> {
    let mut fields = vec![
        catalog_field(
            "island.player_character",
            "Mini-Game Island player character",
            0x182,
            Storage::U8,
        )
        .choices(choices(&CHARACTERS))
        .min(0)
        .max(5),
        catalog_field(
            "island.computer_character",
            "Mini-Game Island computer character",
            0x183,
            Storage::U8,
        )
        .choices(choices(&CHARACTERS))
        .min(0)
        .max(5),
        catalog_field("island.lives", "Mini-Game Island lives", 0x185, Storage::U8)
            .min(0)
            .max(99),
        catalog_field("island.coins", "Mini-Game Island coins", 0x18e, Storage::U8)
            .min(0)
            .max(99),
    ];
    let mut bit = CLEARED_START_BIT;
    for (world, size) in WORLD_SIZES.into_iter().enumerate() {
        for number in 1..=size {
            let goal = world == 8 && number == size;
            let (id, label) = if goal {
                (
                    "island.cleared.goal_space".to_string(),
                    "Mini-Game Island goal space cleared".to_string(),
                )
            } else {
                (
                    format!("island.cleared.world_{}_{number}", world + 1),
                    format!("Mini-Game Island world {}-{number} cleared", world + 1),
                )
            };
            fields.push(bit_field(&id, &label, bit));
            bit += 1;
        }
    }
    fields
}

fn record_fields() -> Vec<FieldDefinition> {
    RECORDS
        .into_iter()
        .map(|(slug, name, offset)| {
            catalog_field(
                &format!("records.{slug}"),
                &format!("{name} best time (frames)"),
                offset,
                Storage::U16Be,
            )
        })
        .collect()
}

fn item_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (id, label, bit_index) in [
        ("unlocked.no_koopa", "No Koopa unlocked", 0x54 * 8),
        ("unlocked.no_boo", "No Boo unlocked", 0x54 * 8 + 1),
        ("unlocked.record", "Record unlocked", 0x54 * 8 + 2),
        (
            "unlocked.mecha_fly_guy",
            "Mecha Fly Guy unlocked",
            0x53 * 8 + 7,
        ),
        (
            "unlocked.talking_parrot",
            "Talking Parrot unlocked",
            0x54 * 8 + 3,
        ),
        ("unlocked.lucky_box", "Lucky Box unlocked", 0x54 * 8 + 4),
        ("unlocked.casino_box", "Casino Box unlocked", 0x54 * 8 + 5),
        ("unlocked.gameballs", "Gameballs unlocked", 0x54 * 8 + 6),
        ("active.plus_block", "Plus Block active", 0x50 * 8 + 7),
        ("active.minus_block", "Minus Block active", 0x51 * 8),
        ("active.speed_block", "Speed Block active", 0x51 * 8 + 1),
        ("active.slow_block", "Slow Block active", 0x51 * 8 + 2),
        ("active.warp_block", "Warp Block active", 0x51 * 8 + 3),
        ("active.event_block", "Event Block active", 0x51 * 8 + 4),
        ("active.no_koopa", "No Koopa active", 0x51 * 8 + 6),
        ("active.no_boo", "No Boo active", 0x51 * 8 + 7),
        ("options.sound_stereo", "Sound is stereo", 0x52 * 8),
    ] {
        fields.push(bit_field(id, label, bit_index));
    }
    fields.push(
        catalog_field("options.language", "Language", 0x9, Storage::U8)
            .choices(choices(&[("default", 0), ("english", 2), ("french", 3), ("german", 4)]))
            .min(0)
            .max(4)
            .description("The PAL release stores English, French, or German here; other releases use the default".into()),
    );
    fields
}

// Layout, checksum, and extended fields: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/mario-party/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_mario_party_canonical_eeprom()];

    build(games, codecs, true)
}

fn game_mario_party_canonical_eeprom() -> GameDefinition {
    let fields = vec![
        catalog_field("coins", "Coins", 72, Storage::U32Be),
        catalog_field("stars", "Stars", 76, Storage::U16Be),
        catalog_field(
            "title_background",
            "Title screen background",
            78,
            Storage::U8,
        ),
        catalog_field("coin_box", "Coin box", 79, Storage::U8),
        catalog_field("events.rules_heard", "Game rules heard", 80, Storage::Bit).bit(1),
        catalog_field(
            "events.toad_first_talk",
            "Toad first talk",
            80,
            Storage::Bit,
        )
        .bit(2),
        catalog_field("events.bowser_note", "Bowser note read", 80, Storage::Bit).bit(3),
        catalog_field(
            "unlocked.plus_block",
            "Plus Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "unlocked.minus_block",
            "Minus Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "unlocked.speed_block",
            "Speed Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "unlocked.slow_block",
            "Slow Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "unlocked.warp_block",
            "Warp Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "unlocked.event_block",
            "Event Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "unlocked.magma_mountain",
            "Magma Mountain unlocked",
            84,
            Storage::Bit,
        )
        .bit(7),
        catalog_field("unlocked.credits", "Credits unlocked", 85, Storage::Bit).bit(0),
    ];
    let mut fields = fields;
    fields.extend(item_fields());
    fields.extend(board_fields());
    fields.extend(minigame_fields());
    fields.extend(island_fields());
    fields.extend(record_fields());
    debug!(fields = fields.len(), "built Mario Party save fields");
    GameDefinition {
        fields,
        description: concat!(
            "Edits global progression, items, board records, Mini-Game House ",
            "and Island state, and minigame records in a canonical 2 KiB ",
            "EEPROM. Koopa Troopa space and byte-swapped emulator images are ",
            "omitted."
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
            "mario-party-canonical-eeprom".into(),
            "Mario Party (canonical EEPROM)".into(),
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
            selected_game: Some("mario-party-canonical-eeprom".into()),
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
    fn assert_only_changed(before: &[u8], after: &[u8], changed: &[usize]) {
        for (offset, (a, b)) in before.iter().zip(after).enumerate() {
            if !changed.contains(&offset) && !(0x1f8..0x1fa).contains(&offset) {
                assert_eq!(a, b, "byte {offset:#x} must stay unchanged");
            }
        }
        assert_eq!(
            u16::from_be_bytes([after[0x1f8], after[0x1f9]]),
            upstream_checksum(after)
        );
    }

    #[test]
    fn schema_exposes_items_boards_minigames_island_and_records() {
        let handler = schemas().remove(0);
        // 15 original fields, 18 item and option fields, 18 board fields, 106 minigame
        // flags, 54 island fields, and 8 records.
        assert_eq!(handler.game.fields.len(), 15 + 18 + 18 + 106 + 54 + 8);
        assert_eq!(MINIGAMES.len(), 53);
        assert_eq!(
            WORLD_SIZES
                .iter()
                .map(|size| usize::from(*size))
                .sum::<usize>(),
            50
        );
    }

    #[test]
    fn board_counts_raise_the_played_flags_like_the_upstream_hook() {
        let source = input();
        let bytes = apply(
            &source,
            &[
                edit("boards.dks_jungle_adventure.played", SaveValue::U32(999)),
                edit("boards.eternal_star.played", SaveValue::U32(3)),
                edit("boards.eternal_star.stars", SaveValue::U32(9999)),
                edit(
                    "boards.bowsers_magma_mountain.unlocked",
                    SaveValue::Bool(true),
                ),
            ],
        )
        .unwrap();
        let mut expected = source.bytes.clone();
        expected[0x28..0x2a].copy_from_slice(&999u16.to_be_bytes());
        expected[0x44..0x46].copy_from_slice(&3u16.to_be_bytes());
        expected[0x46..0x48].copy_from_slice(&9999u16.to_be_bytes());
        expected[0x40] |= 0x80;
        // Board 0 sets bit 1 of 0x52, and board 7 sets bit 0 of 0x53.
        expected[0x52] |= 1 << 1;
        expected[0x53] |= 1;
        assert_eq!(bytes[..0x1f8], {
            let mut with_sum = expected.clone();
            repair(&mut with_sum);
            with_sum[..0x1f8].to_vec()
        });
        assert_only_changed(
            &source.bytes,
            &bytes,
            &[0x28, 0x29, 0x40, 0x44, 0x45, 0x46, 0x47, 0x52, 0x53],
        );
        // Clearing the count lowers the flag again and keeps the status bit.
        let cleared = SaveDetectionInput {
            bytes,
            ..source.clone()
        };
        let back = apply(
            &cleared,
            &[edit(
                "boards.dks_jungle_adventure.played",
                SaveValue::U32(0),
            )],
        )
        .unwrap();
        assert_eq!(back[0x52] & 2, 0);
        assert_eq!(back[0x53] & 1, 1);
        assert_eq!(
            parsed(
                &SaveDetectionInput {
                    bytes: back,
                    ..source
                },
                "boards.eternal_star.played"
            ),
            SaveValue::U32(3)
        );
    }

    #[test]
    fn minigame_item_island_record_and_option_edits_hit_the_documented_bits() {
        let source = input();
        let edits = [
            edit(
                "minigames.four_player.buried_treasure.played",
                SaveValue::Bool(true),
            ),
            edit(
                "minigames.four_player.buried_treasure.bought",
                SaveValue::Bool(true),
            ),
            edit(
                "minigames.one_vs_three.pipe_maze.bought",
                SaveValue::Bool(true),
            ),
            edit(
                "minigames.two_vs_two.deep_sea_divers.played",
                SaveValue::Bool(true),
            ),
            edit(
                "minigames.one_player.bumber_ball_maze_3.bought",
                SaveValue::Bool(true),
            ),
            edit("unlocked.no_koopa", SaveValue::Bool(true)),
            edit("unlocked.mecha_fly_guy", SaveValue::Bool(true)),
            edit("unlocked.gameballs", SaveValue::Bool(true)),
            edit("active.plus_block", SaveValue::Bool(true)),
            edit("active.no_boo", SaveValue::Bool(true)),
            edit("options.sound_stereo", SaveValue::Bool(true)),
            edit("options.language", SaveValue::Enum("german".into())),
            edit("island.player_character", SaveValue::Enum("dk".into())),
            edit("island.computer_character", SaveValue::Enum("peach".into())),
            edit("island.lives", SaveValue::U32(99)),
            edit("island.coins", SaveValue::U32(5)),
            edit("island.cleared.world_1_1", SaveValue::Bool(true)),
            edit("island.cleared.world_5_8", SaveValue::Bool(true)),
            edit("island.cleared.goal_space", SaveValue::Bool(true)),
            edit("records.mecha_fly_guy", SaveValue::U32(1234)),
            edit("records.bumber_ball_maze_3", SaveValue::U32(0xffff)),
        ];
        let bytes = apply(&source, &edits).unwrap();
        let mut expected = source.bytes.clone();
        expected[0x1a] |= 1 << 3;
        expected[0x21] |= 1 << 3;
        expected[0x22] |= 1 << 1;
        expected[0x20] |= 1 << 1;
        expected[0x27] |= 1 << 5;
        expected[0x54] |= 1 | 1 << 6;
        expected[0x53] |= 1 << 7;
        expected[0x50] |= 1 << 7;
        expected[0x51] |= 1 << 7;
        expected[0x52] |= 1;
        expected[0x9] = 4;
        expected[0x182] = 5;
        expected[0x183] = 2;
        expected[0x185] = 99;
        expected[0x18e] = 5;
        expected[0x186] |= 1 << 7;
        // World 5-8 closes the fifth world block; Goal Space is the last stream bit.
        expected[0x18a] |= 1;
        expected[0x18d] |= 1;
        expected[0x12..0x14].copy_from_slice(&1234u16.to_be_bytes());
        expected[0x18..0x1a].copy_from_slice(&0xffffu16.to_be_bytes());
        repair(&mut expected);
        assert_eq!(bytes, expected);
        let saved = SaveDetectionInput { bytes, ..source };
        assert_eq!(
            parsed(&saved, "island.cleared.goal_space"),
            SaveValue::Bool(true)
        );
        assert_eq!(
            parsed(&saved, "island.player_character"),
            SaveValue::Enum("dk".into())
        );
        assert_eq!(
            parsed(&saved, "records.mecha_fly_guy"),
            SaveValue::U32(1234)
        );
    }

    #[test]
    fn invalid_values_and_corrupt_checksums_are_rejected() {
        let source = input();
        for (id, value) in [
            ("boards.eternal_star.played", SaveValue::U32(1000)),
            ("boards.eternal_star.stars", SaveValue::U32(10_000)),
            ("island.lives", SaveValue::U32(100)),
            ("island.player_character", SaveValue::Enum("raw:6".into())),
            ("options.language", SaveValue::Enum("raw:5".into())),
        ] {
            assert!(apply(&source, &[edit(id, value)]).is_err(), "{id}");
        }
        let mut corrupt = input();
        corrupt.bytes[0x100] ^= 1;
        assert!(apply(&corrupt, &[edit("island.coins", SaveValue::U32(1))]).is_err());
        let mut unsigned = input();
        unsigned.bytes[0] = b'X';
        assert!(apply(&unsigned, &[edit("island.coins", SaveValue::U32(1))]).is_err());
    }

    #[test]
    fn checksum_wraps_past_sixteen_bits() {
        let source = input_with(0xff);
        // 0x1f2 bytes of 0xff add up to more than 0xffff.
        let total: u32 = source
            .bytes
            .iter()
            .take(0x1f2)
            .map(|&byte| u32::from(byte))
            .sum();
        assert!(total > 0xffff);
        let bytes = apply(&source, &[edit("island.coins", SaveValue::U32(7))]).unwrap();
        assert_eq!(bytes[0x18e], 7);
        assert_eq!(
            u16::from_be_bytes([bytes[0x1f8], bytes[0x1f9]]),
            upstream_checksum(&bytes)
        );
    }
}
