use super::*;

fn backup_records(file_offset: usize) -> Vec<MirrorDefinition> {
    // Edits MUST update backups because game-over reload restores both records.
    // https://github.com/n64decomp/sm64/blob/master/src/game/save_file.c#L315
    vec![
        MirrorDefinition {
            source: file_offset,
            target: file_offset + 56,
            length: 56,
            validate: Some(false),
        },
        MirrorDefinition {
            source: 448,
            target: 480,
            length: 32,
            validate: Some(false),
        },
    ]
}

fn default() -> GameDefinition {
    {
        let fields = vec![
            catalog_field(
                "mario_a.secret_star_flags",
                "Castle secret-star flags",
                8,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.door_event_flags",
                "Castle door event flags",
                9,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.castle_event_flags",
                "Castle event flags",
                10,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.key_and_cap_flags",
                "Key and cap-switch flags",
                11,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_01",
                "Course 1 stars and adjacent cannon flags",
                12,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_02",
                "Course 2 stars and adjacent cannon flags",
                13,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_03",
                "Course 3 stars and adjacent cannon flags",
                14,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_04",
                "Course 4 stars and adjacent cannon flags",
                15,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_05",
                "Course 5 stars and adjacent cannon flags",
                16,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_06",
                "Course 6 stars and adjacent cannon flags",
                17,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_07",
                "Course 7 stars and adjacent cannon flags",
                18,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_08",
                "Course 8 stars and adjacent cannon flags",
                19,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_09",
                "Course 9 stars and adjacent cannon flags",
                20,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_10",
                "Course 10 stars and adjacent cannon flags",
                21,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_11",
                "Course 11 stars and adjacent cannon flags",
                22,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_12",
                "Course 12 stars and adjacent cannon flags",
                23,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_13",
                "Course 13 stars and adjacent cannon flags",
                24,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_14",
                "Course 14 stars and adjacent cannon flags",
                25,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.course_flags_15",
                "Course 15 stars and adjacent cannon flags",
                26,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.bob_omb_battlefield",
                "Bob-omb Battlefield coin score",
                37,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.whomps_fortress",
                "Whomp's Fortress coin score",
                38,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.jolly_roger_bay",
                "Jolly Roger Bay coin score",
                39,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.cool_cool_mountain",
                "Cool, Cool Mountain coin score",
                40,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.big_boos_haunt",
                "Big Boo's Haunt coin score",
                41,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.hazy_maze_cave",
                "Hazy Maze Cave coin score",
                42,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.lethal_lava_land",
                "Lethal Lava Land coin score",
                43,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.shifting_sand_land",
                "Shifting Sand Land coin score",
                44,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.dire_dire_docks",
                "Dire, Dire Docks coin score",
                45,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.snowmans_land",
                "Snowman's Land coin score",
                46,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.wet_dry_world",
                "Wet-Dry World coin score",
                47,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.tall_tall_mountain",
                "Tall, Tall Mountain coin score",
                48,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.tiny_huge_island",
                "Tiny-Huge Island coin score",
                49,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.tick_tock_clock",
                "Tick Tock Clock coin score",
                50,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.score.rainbow_ride",
                "Rainbow Ride coin score",
                51,
                Storage::U8,
            ),
            catalog_field("options.sound", "Sound mode", 465, Storage::U8),
            catalog_field("options.language", "Language", 467, Storage::U8),
            catalog_field(
                "mario_a.secret_course_flags_01",
                "Bowser in the Dark World flags",
                27,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_02",
                "Bowser in the Fire Sea flags",
                28,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_03",
                "Bowser in the Sky flags",
                29,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_04",
                "The Princess’s Secret Slide flags",
                30,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_05",
                "Cavern of the Metal Cap flags",
                31,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_06",
                "Tower of the Wing Cap flags",
                32,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_07",
                "Vanish Cap Under the Moat flags",
                33,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_08",
                "Wing Mario Over the Rainbow flags",
                34,
                Storage::U8,
            ),
            catalog_field(
                "mario_a.secret_course_flags_09",
                "The Secret Aquarium flags",
                35,
                Storage::U8,
            ),
        ];
        GameDefinition {
            fields,
            description: concat!(
                "Edits Mario A in a 512-byte big-endian EEPROM image, optionally ",
                "padded to 2 KiB. Repairs both file and options copies. Other ",
                "slots and padding stay unchanged. Byte-swapped files, ",
                "bit-packed score rankings, derived total stars, and conditional ",
                "cap coordinates are omitted."
            )
            .into(),
            signatures: vec![
                SignatureDefinition {
                    offset: 52,
                    bytes: vec![68, 65],
                },
                SignatureDefinition {
                    offset: 476,
                    bytes: vec![72, 73],
                },
            ],
            checksums: vec![
                ChecksumDefinition {
                    start: Some(0),
                    length: Some(54),
                    unit: ChecksumUnit::U8,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 54)
                },
                ChecksumDefinition {
                    start: Some(448),
                    length: Some(30),
                    unit: ChecksumUnit::U8,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 478)
                },
            ],
            padded_sizes: vec![2048],
            mirrors: backup_records(0),
            ..GameDefinition::new("".into(), "".into(), "n64".into(), 512)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_super_mario_64_canonical_eeprom_mario_a(),
        game_super_mario_64_canonical_eeprom_mario_b(),
        game_super_mario_64_canonical_eeprom_mario_c(),
        game_super_mario_64_canonical_eeprom_mario_d(),
    ];

    build(games, codecs, true)
}

fn game_super_mario_64_canonical_eeprom_mario_a() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-64-canonical-eeprom-mario-a".into();
    game.name = "Super Mario 64 (canonical EEPROM, Mario A)".into();
    game
}

fn game_super_mario_64_canonical_eeprom_mario_b() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-64-canonical-eeprom-mario-b".into();
    game.name = "Super Mario 64 (canonical EEPROM, Mario B)".into();
    game.mirrors = backup_records(112);
    game.description = concat!(
        "Edits Mario B in a 512-byte big-endian EEPROM image, optionally ",
        "padded to 2 KiB. Repairs both file and options copies. Other ",
        "slots and padding stay unchanged. Byte-swapped files, ",
        "bit-packed score rankings, derived total stars, and conditional ",
        "cap coordinates are omitted."
    )
    .into();
    game.signatures = vec![
        SignatureDefinition {
            offset: 164,
            bytes: vec![68, 65],
        },
        SignatureDefinition {
            offset: 476,
            bytes: vec![72, 73],
        },
    ];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(112),
            length: Some(54),
            unit: ChecksumUnit::U8,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 166)
        },
        ChecksumDefinition {
            start: Some(448),
            length: Some(30),
            unit: ChecksumUnit::U8,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 478)
        },
    ];
    let fields = vec![
        catalog_field(
            "mario_b.secret_star_flags",
            "Castle secret-star flags",
            120,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.door_event_flags",
            "Castle door event flags",
            121,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.castle_event_flags",
            "Castle event flags",
            122,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.key_and_cap_flags",
            "Key and cap-switch flags",
            123,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_01",
            "Course 1 stars and adjacent cannon flags",
            124,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_02",
            "Course 2 stars and adjacent cannon flags",
            125,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_03",
            "Course 3 stars and adjacent cannon flags",
            126,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_04",
            "Course 4 stars and adjacent cannon flags",
            127,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_05",
            "Course 5 stars and adjacent cannon flags",
            128,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_06",
            "Course 6 stars and adjacent cannon flags",
            129,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_07",
            "Course 7 stars and adjacent cannon flags",
            130,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_08",
            "Course 8 stars and adjacent cannon flags",
            131,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_09",
            "Course 9 stars and adjacent cannon flags",
            132,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_10",
            "Course 10 stars and adjacent cannon flags",
            133,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_11",
            "Course 11 stars and adjacent cannon flags",
            134,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_12",
            "Course 12 stars and adjacent cannon flags",
            135,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_13",
            "Course 13 stars and adjacent cannon flags",
            136,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_14",
            "Course 14 stars and adjacent cannon flags",
            137,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.course_flags_15",
            "Course 15 stars and adjacent cannon flags",
            138,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.bob_omb_battlefield",
            "Bob-omb Battlefield coin score",
            149,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.whomps_fortress",
            "Whomp's Fortress coin score",
            150,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.jolly_roger_bay",
            "Jolly Roger Bay coin score",
            151,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.cool_cool_mountain",
            "Cool, Cool Mountain coin score",
            152,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.big_boos_haunt",
            "Big Boo's Haunt coin score",
            153,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.hazy_maze_cave",
            "Hazy Maze Cave coin score",
            154,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.lethal_lava_land",
            "Lethal Lava Land coin score",
            155,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.shifting_sand_land",
            "Shifting Sand Land coin score",
            156,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.dire_dire_docks",
            "Dire, Dire Docks coin score",
            157,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.snowmans_land",
            "Snowman's Land coin score",
            158,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.wet_dry_world",
            "Wet-Dry World coin score",
            159,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.tall_tall_mountain",
            "Tall, Tall Mountain coin score",
            160,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.tiny_huge_island",
            "Tiny-Huge Island coin score",
            161,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.tick_tock_clock",
            "Tick Tock Clock coin score",
            162,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.score.rainbow_ride",
            "Rainbow Ride coin score",
            163,
            Storage::U8,
        ),
        catalog_field("options.sound", "Sound mode", 465, Storage::U8),
        catalog_field("options.language", "Language", 467, Storage::U8),
        catalog_field(
            "mario_b.secret_course_flags_01",
            "Bowser in the Dark World flags",
            139,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_02",
            "Bowser in the Fire Sea flags",
            140,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_03",
            "Bowser in the Sky flags",
            141,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_04",
            "The Princess’s Secret Slide flags",
            142,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_05",
            "Cavern of the Metal Cap flags",
            143,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_06",
            "Tower of the Wing Cap flags",
            144,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_07",
            "Vanish Cap Under the Moat flags",
            145,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_08",
            "Wing Mario Over the Rainbow flags",
            146,
            Storage::U8,
        ),
        catalog_field(
            "mario_b.secret_course_flags_09",
            "The Secret Aquarium flags",
            147,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}

fn game_super_mario_64_canonical_eeprom_mario_c() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-64-canonical-eeprom-mario-c".into();
    game.name = "Super Mario 64 (canonical EEPROM, Mario C)".into();
    game.mirrors = backup_records(224);
    game.description = concat!(
        "Edits Mario C in a 512-byte big-endian EEPROM image, optionally ",
        "padded to 2 KiB. Repairs both file and options copies. Other ",
        "slots and padding stay unchanged. Byte-swapped files, ",
        "bit-packed score rankings, derived total stars, and conditional ",
        "cap coordinates are omitted."
    )
    .into();
    game.signatures = vec![
        SignatureDefinition {
            offset: 276,
            bytes: vec![68, 65],
        },
        SignatureDefinition {
            offset: 476,
            bytes: vec![72, 73],
        },
    ];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(224),
            length: Some(54),
            unit: ChecksumUnit::U8,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 278)
        },
        ChecksumDefinition {
            start: Some(448),
            length: Some(30),
            unit: ChecksumUnit::U8,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 478)
        },
    ];
    let fields = vec![
        catalog_field(
            "mario_c.secret_star_flags",
            "Castle secret-star flags",
            232,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.door_event_flags",
            "Castle door event flags",
            233,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.castle_event_flags",
            "Castle event flags",
            234,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.key_and_cap_flags",
            "Key and cap-switch flags",
            235,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_01",
            "Course 1 stars and adjacent cannon flags",
            236,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_02",
            "Course 2 stars and adjacent cannon flags",
            237,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_03",
            "Course 3 stars and adjacent cannon flags",
            238,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_04",
            "Course 4 stars and adjacent cannon flags",
            239,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_05",
            "Course 5 stars and adjacent cannon flags",
            240,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_06",
            "Course 6 stars and adjacent cannon flags",
            241,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_07",
            "Course 7 stars and adjacent cannon flags",
            242,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_08",
            "Course 8 stars and adjacent cannon flags",
            243,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_09",
            "Course 9 stars and adjacent cannon flags",
            244,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_10",
            "Course 10 stars and adjacent cannon flags",
            245,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_11",
            "Course 11 stars and adjacent cannon flags",
            246,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_12",
            "Course 12 stars and adjacent cannon flags",
            247,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_13",
            "Course 13 stars and adjacent cannon flags",
            248,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_14",
            "Course 14 stars and adjacent cannon flags",
            249,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.course_flags_15",
            "Course 15 stars and adjacent cannon flags",
            250,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.bob_omb_battlefield",
            "Bob-omb Battlefield coin score",
            261,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.whomps_fortress",
            "Whomp's Fortress coin score",
            262,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.jolly_roger_bay",
            "Jolly Roger Bay coin score",
            263,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.cool_cool_mountain",
            "Cool, Cool Mountain coin score",
            264,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.big_boos_haunt",
            "Big Boo's Haunt coin score",
            265,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.hazy_maze_cave",
            "Hazy Maze Cave coin score",
            266,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.lethal_lava_land",
            "Lethal Lava Land coin score",
            267,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.shifting_sand_land",
            "Shifting Sand Land coin score",
            268,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.dire_dire_docks",
            "Dire, Dire Docks coin score",
            269,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.snowmans_land",
            "Snowman's Land coin score",
            270,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.wet_dry_world",
            "Wet-Dry World coin score",
            271,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.tall_tall_mountain",
            "Tall, Tall Mountain coin score",
            272,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.tiny_huge_island",
            "Tiny-Huge Island coin score",
            273,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.tick_tock_clock",
            "Tick Tock Clock coin score",
            274,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.score.rainbow_ride",
            "Rainbow Ride coin score",
            275,
            Storage::U8,
        ),
        catalog_field("options.sound", "Sound mode", 465, Storage::U8),
        catalog_field("options.language", "Language", 467, Storage::U8),
        catalog_field(
            "mario_c.secret_course_flags_01",
            "Bowser in the Dark World flags",
            251,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_02",
            "Bowser in the Fire Sea flags",
            252,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_03",
            "Bowser in the Sky flags",
            253,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_04",
            "The Princess’s Secret Slide flags",
            254,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_05",
            "Cavern of the Metal Cap flags",
            255,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_06",
            "Tower of the Wing Cap flags",
            256,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_07",
            "Vanish Cap Under the Moat flags",
            257,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_08",
            "Wing Mario Over the Rainbow flags",
            258,
            Storage::U8,
        ),
        catalog_field(
            "mario_c.secret_course_flags_09",
            "The Secret Aquarium flags",
            259,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}

fn game_super_mario_64_canonical_eeprom_mario_d() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-64-canonical-eeprom-mario-d".into();
    game.name = "Super Mario 64 (canonical EEPROM, Mario D)".into();
    game.mirrors = backup_records(336);
    game.description = concat!(
        "Edits Mario D in a 512-byte big-endian EEPROM image, optionally ",
        "padded to 2 KiB. Repairs both file and options copies. Other ",
        "slots and padding stay unchanged. Byte-swapped files, ",
        "bit-packed score rankings, derived total stars, and conditional ",
        "cap coordinates are omitted."
    )
    .into();
    game.signatures = vec![
        SignatureDefinition {
            offset: 388,
            bytes: vec![68, 65],
        },
        SignatureDefinition {
            offset: 476,
            bytes: vec![72, 73],
        },
    ];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(336),
            length: Some(54),
            unit: ChecksumUnit::U8,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 390)
        },
        ChecksumDefinition {
            start: Some(448),
            length: Some(30),
            unit: ChecksumUnit::U8,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 478)
        },
    ];
    let fields = vec![
        catalog_field(
            "mario_d.secret_star_flags",
            "Castle secret-star flags",
            344,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.door_event_flags",
            "Castle door event flags",
            345,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.castle_event_flags",
            "Castle event flags",
            346,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.key_and_cap_flags",
            "Key and cap-switch flags",
            347,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_01",
            "Course 1 stars and adjacent cannon flags",
            348,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_02",
            "Course 2 stars and adjacent cannon flags",
            349,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_03",
            "Course 3 stars and adjacent cannon flags",
            350,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_04",
            "Course 4 stars and adjacent cannon flags",
            351,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_05",
            "Course 5 stars and adjacent cannon flags",
            352,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_06",
            "Course 6 stars and adjacent cannon flags",
            353,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_07",
            "Course 7 stars and adjacent cannon flags",
            354,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_08",
            "Course 8 stars and adjacent cannon flags",
            355,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_09",
            "Course 9 stars and adjacent cannon flags",
            356,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_10",
            "Course 10 stars and adjacent cannon flags",
            357,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_11",
            "Course 11 stars and adjacent cannon flags",
            358,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_12",
            "Course 12 stars and adjacent cannon flags",
            359,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_13",
            "Course 13 stars and adjacent cannon flags",
            360,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_14",
            "Course 14 stars and adjacent cannon flags",
            361,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.course_flags_15",
            "Course 15 stars and adjacent cannon flags",
            362,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.bob_omb_battlefield",
            "Bob-omb Battlefield coin score",
            373,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.whomps_fortress",
            "Whomp's Fortress coin score",
            374,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.jolly_roger_bay",
            "Jolly Roger Bay coin score",
            375,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.cool_cool_mountain",
            "Cool, Cool Mountain coin score",
            376,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.big_boos_haunt",
            "Big Boo's Haunt coin score",
            377,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.hazy_maze_cave",
            "Hazy Maze Cave coin score",
            378,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.lethal_lava_land",
            "Lethal Lava Land coin score",
            379,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.shifting_sand_land",
            "Shifting Sand Land coin score",
            380,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.dire_dire_docks",
            "Dire, Dire Docks coin score",
            381,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.snowmans_land",
            "Snowman's Land coin score",
            382,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.wet_dry_world",
            "Wet-Dry World coin score",
            383,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.tall_tall_mountain",
            "Tall, Tall Mountain coin score",
            384,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.tiny_huge_island",
            "Tiny-Huge Island coin score",
            385,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.tick_tock_clock",
            "Tick Tock Clock coin score",
            386,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.score.rainbow_ride",
            "Rainbow Ride coin score",
            387,
            Storage::U8,
        ),
        catalog_field("options.sound", "Sound mode", 465, Storage::U8),
        catalog_field("options.language", "Language", 467, Storage::U8),
        catalog_field(
            "mario_d.secret_course_flags_01",
            "Bowser in the Dark World flags",
            363,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_02",
            "Bowser in the Fire Sea flags",
            364,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_03",
            "Bowser in the Sky flags",
            365,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_04",
            "The Princess’s Secret Slide flags",
            366,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_05",
            "Cavern of the Metal Cap flags",
            367,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_06",
            "Tower of the Wing Cap flags",
            368,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_07",
            "Vanish Cap Under the Moat flags",
            369,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_08",
            "Wing Mario Over the Rainbow flags",
            370,
            Storage::U8,
        ),
        catalog_field(
            "mario_d.secret_course_flags_09",
            "The Secret Aquarium flags",
            371,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}
