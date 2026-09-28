use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            FieldDefinition::new(
                "mario_a.secret_star_flags".into(),
                "Castle secret-star flags".into(),
                8,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.door_event_flags".into(),
                "Castle door event flags".into(),
                9,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.castle_event_flags".into(),
                "Castle event flags".into(),
                10,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.key_and_cap_flags".into(),
                "Key and cap-switch flags".into(),
                11,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_01".into(),
                "Course 1 stars and adjacent cannon flags".into(),
                12,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_02".into(),
                "Course 2 stars and adjacent cannon flags".into(),
                13,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_03".into(),
                "Course 3 stars and adjacent cannon flags".into(),
                14,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_04".into(),
                "Course 4 stars and adjacent cannon flags".into(),
                15,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_05".into(),
                "Course 5 stars and adjacent cannon flags".into(),
                16,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_06".into(),
                "Course 6 stars and adjacent cannon flags".into(),
                17,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_07".into(),
                "Course 7 stars and adjacent cannon flags".into(),
                18,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_08".into(),
                "Course 8 stars and adjacent cannon flags".into(),
                19,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_09".into(),
                "Course 9 stars and adjacent cannon flags".into(),
                20,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_10".into(),
                "Course 10 stars and adjacent cannon flags".into(),
                21,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_11".into(),
                "Course 11 stars and adjacent cannon flags".into(),
                22,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_12".into(),
                "Course 12 stars and adjacent cannon flags".into(),
                23,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_13".into(),
                "Course 13 stars and adjacent cannon flags".into(),
                24,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_14".into(),
                "Course 14 stars and adjacent cannon flags".into(),
                25,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.course_flags_15".into(),
                "Course 15 stars and adjacent cannon flags".into(),
                26,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.bob_omb_battlefield".into(),
                "Bob-omb Battlefield coin score".into(),
                37,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.whomps_fortress".into(),
                "Whomp's Fortress coin score".into(),
                38,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.jolly_roger_bay".into(),
                "Jolly Roger Bay coin score".into(),
                39,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.cool_cool_mountain".into(),
                "Cool, Cool Mountain coin score".into(),
                40,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.big_boos_haunt".into(),
                "Big Boo's Haunt coin score".into(),
                41,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.hazy_maze_cave".into(),
                "Hazy Maze Cave coin score".into(),
                42,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.lethal_lava_land".into(),
                "Lethal Lava Land coin score".into(),
                43,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.shifting_sand_land".into(),
                "Shifting Sand Land coin score".into(),
                44,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.dire_dire_docks".into(),
                "Dire, Dire Docks coin score".into(),
                45,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.snowmans_land".into(),
                "Snowman's Land coin score".into(),
                46,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.wet_dry_world".into(),
                "Wet-Dry World coin score".into(),
                47,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.tall_tall_mountain".into(),
                "Tall, Tall Mountain coin score".into(),
                48,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.tiny_huge_island".into(),
                "Tiny-Huge Island coin score".into(),
                49,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.tick_tock_clock".into(),
                "Tick Tock Clock coin score".into(),
                50,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.score.rainbow_ride".into(),
                "Rainbow Ride coin score".into(),
                51,
                Storage::U8,
            ),
            FieldDefinition::new(
                "options.sound".into(),
                "Sound mode".into(),
                465,
                Storage::U8,
            ),
            FieldDefinition::new(
                "options.language".into(),
                "Language".into(),
                467,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_01".into(),
                "Bowser in the Dark World flags".into(),
                27,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_02".into(),
                "Bowser in the Fire Sea flags".into(),
                28,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_03".into(),
                "Bowser in the Sky flags".into(),
                29,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_04".into(),
                "The Princess’s Secret Slide flags".into(),
                30,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_05".into(),
                "Cavern of the Metal Cap flags".into(),
                31,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_06".into(),
                "Tower of the Wing Cap flags".into(),
                32,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_07".into(),
                "Vanish Cap Under the Moat flags".into(),
                33,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_08".into(),
                "Wing Mario Over the Rainbow flags".into(),
                34,
                Storage::U8,
            ),
            FieldDefinition::new(
                "mario_a.secret_course_flags_09".into(),
                "The Secret Aquarium flags".into(),
                35,
                Storage::U8,
            ),
        ];
        GameDefinition {
            fields,
            description: concat!(
                "Edits Mario A in a canonical 2 KiB big-endian EEPROM image and ",
                "repairs its primary checksum plus the options checksum. Other ",
                "slots and backup records stay unchanged. Byte-swapped files, ",
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
            ..GameDefinition::new("".into(), "".into(), "n64".into(), 2048)
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
    game.description = concat!(
        "Edits Mario B in a canonical 2 KiB big-endian EEPROM image and ",
        "repairs its primary checksum plus the options checksum. Other ",
        "slots and backup records stay unchanged. Byte-swapped files, ",
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
        FieldDefinition::new(
            "mario_b.secret_star_flags".into(),
            "Castle secret-star flags".into(),
            120,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.door_event_flags".into(),
            "Castle door event flags".into(),
            121,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.castle_event_flags".into(),
            "Castle event flags".into(),
            122,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.key_and_cap_flags".into(),
            "Key and cap-switch flags".into(),
            123,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_01".into(),
            "Course 1 stars and adjacent cannon flags".into(),
            124,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_02".into(),
            "Course 2 stars and adjacent cannon flags".into(),
            125,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_03".into(),
            "Course 3 stars and adjacent cannon flags".into(),
            126,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_04".into(),
            "Course 4 stars and adjacent cannon flags".into(),
            127,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_05".into(),
            "Course 5 stars and adjacent cannon flags".into(),
            128,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_06".into(),
            "Course 6 stars and adjacent cannon flags".into(),
            129,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_07".into(),
            "Course 7 stars and adjacent cannon flags".into(),
            130,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_08".into(),
            "Course 8 stars and adjacent cannon flags".into(),
            131,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_09".into(),
            "Course 9 stars and adjacent cannon flags".into(),
            132,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_10".into(),
            "Course 10 stars and adjacent cannon flags".into(),
            133,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_11".into(),
            "Course 11 stars and adjacent cannon flags".into(),
            134,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_12".into(),
            "Course 12 stars and adjacent cannon flags".into(),
            135,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_13".into(),
            "Course 13 stars and adjacent cannon flags".into(),
            136,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_14".into(),
            "Course 14 stars and adjacent cannon flags".into(),
            137,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.course_flags_15".into(),
            "Course 15 stars and adjacent cannon flags".into(),
            138,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.bob_omb_battlefield".into(),
            "Bob-omb Battlefield coin score".into(),
            149,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.whomps_fortress".into(),
            "Whomp's Fortress coin score".into(),
            150,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.jolly_roger_bay".into(),
            "Jolly Roger Bay coin score".into(),
            151,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.cool_cool_mountain".into(),
            "Cool, Cool Mountain coin score".into(),
            152,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.big_boos_haunt".into(),
            "Big Boo's Haunt coin score".into(),
            153,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.hazy_maze_cave".into(),
            "Hazy Maze Cave coin score".into(),
            154,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.lethal_lava_land".into(),
            "Lethal Lava Land coin score".into(),
            155,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.shifting_sand_land".into(),
            "Shifting Sand Land coin score".into(),
            156,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.dire_dire_docks".into(),
            "Dire, Dire Docks coin score".into(),
            157,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.snowmans_land".into(),
            "Snowman's Land coin score".into(),
            158,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.wet_dry_world".into(),
            "Wet-Dry World coin score".into(),
            159,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.tall_tall_mountain".into(),
            "Tall, Tall Mountain coin score".into(),
            160,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.tiny_huge_island".into(),
            "Tiny-Huge Island coin score".into(),
            161,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.tick_tock_clock".into(),
            "Tick Tock Clock coin score".into(),
            162,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.score.rainbow_ride".into(),
            "Rainbow Ride coin score".into(),
            163,
            Storage::U8,
        ),
        FieldDefinition::new(
            "options.sound".into(),
            "Sound mode".into(),
            465,
            Storage::U8,
        ),
        FieldDefinition::new(
            "options.language".into(),
            "Language".into(),
            467,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_01".into(),
            "Bowser in the Dark World flags".into(),
            139,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_02".into(),
            "Bowser in the Fire Sea flags".into(),
            140,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_03".into(),
            "Bowser in the Sky flags".into(),
            141,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_04".into(),
            "The Princess’s Secret Slide flags".into(),
            142,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_05".into(),
            "Cavern of the Metal Cap flags".into(),
            143,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_06".into(),
            "Tower of the Wing Cap flags".into(),
            144,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_07".into(),
            "Vanish Cap Under the Moat flags".into(),
            145,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_08".into(),
            "Wing Mario Over the Rainbow flags".into(),
            146,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_b.secret_course_flags_09".into(),
            "The Secret Aquarium flags".into(),
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
    game.description = concat!(
        "Edits Mario C in a canonical 2 KiB big-endian EEPROM image and ",
        "repairs its primary checksum plus the options checksum. Other ",
        "slots and backup records stay unchanged. Byte-swapped files, ",
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
        FieldDefinition::new(
            "mario_c.secret_star_flags".into(),
            "Castle secret-star flags".into(),
            232,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.door_event_flags".into(),
            "Castle door event flags".into(),
            233,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.castle_event_flags".into(),
            "Castle event flags".into(),
            234,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.key_and_cap_flags".into(),
            "Key and cap-switch flags".into(),
            235,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_01".into(),
            "Course 1 stars and adjacent cannon flags".into(),
            236,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_02".into(),
            "Course 2 stars and adjacent cannon flags".into(),
            237,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_03".into(),
            "Course 3 stars and adjacent cannon flags".into(),
            238,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_04".into(),
            "Course 4 stars and adjacent cannon flags".into(),
            239,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_05".into(),
            "Course 5 stars and adjacent cannon flags".into(),
            240,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_06".into(),
            "Course 6 stars and adjacent cannon flags".into(),
            241,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_07".into(),
            "Course 7 stars and adjacent cannon flags".into(),
            242,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_08".into(),
            "Course 8 stars and adjacent cannon flags".into(),
            243,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_09".into(),
            "Course 9 stars and adjacent cannon flags".into(),
            244,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_10".into(),
            "Course 10 stars and adjacent cannon flags".into(),
            245,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_11".into(),
            "Course 11 stars and adjacent cannon flags".into(),
            246,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_12".into(),
            "Course 12 stars and adjacent cannon flags".into(),
            247,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_13".into(),
            "Course 13 stars and adjacent cannon flags".into(),
            248,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_14".into(),
            "Course 14 stars and adjacent cannon flags".into(),
            249,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.course_flags_15".into(),
            "Course 15 stars and adjacent cannon flags".into(),
            250,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.bob_omb_battlefield".into(),
            "Bob-omb Battlefield coin score".into(),
            261,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.whomps_fortress".into(),
            "Whomp's Fortress coin score".into(),
            262,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.jolly_roger_bay".into(),
            "Jolly Roger Bay coin score".into(),
            263,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.cool_cool_mountain".into(),
            "Cool, Cool Mountain coin score".into(),
            264,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.big_boos_haunt".into(),
            "Big Boo's Haunt coin score".into(),
            265,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.hazy_maze_cave".into(),
            "Hazy Maze Cave coin score".into(),
            266,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.lethal_lava_land".into(),
            "Lethal Lava Land coin score".into(),
            267,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.shifting_sand_land".into(),
            "Shifting Sand Land coin score".into(),
            268,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.dire_dire_docks".into(),
            "Dire, Dire Docks coin score".into(),
            269,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.snowmans_land".into(),
            "Snowman's Land coin score".into(),
            270,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.wet_dry_world".into(),
            "Wet-Dry World coin score".into(),
            271,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.tall_tall_mountain".into(),
            "Tall, Tall Mountain coin score".into(),
            272,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.tiny_huge_island".into(),
            "Tiny-Huge Island coin score".into(),
            273,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.tick_tock_clock".into(),
            "Tick Tock Clock coin score".into(),
            274,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.score.rainbow_ride".into(),
            "Rainbow Ride coin score".into(),
            275,
            Storage::U8,
        ),
        FieldDefinition::new(
            "options.sound".into(),
            "Sound mode".into(),
            465,
            Storage::U8,
        ),
        FieldDefinition::new(
            "options.language".into(),
            "Language".into(),
            467,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_01".into(),
            "Bowser in the Dark World flags".into(),
            251,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_02".into(),
            "Bowser in the Fire Sea flags".into(),
            252,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_03".into(),
            "Bowser in the Sky flags".into(),
            253,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_04".into(),
            "The Princess’s Secret Slide flags".into(),
            254,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_05".into(),
            "Cavern of the Metal Cap flags".into(),
            255,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_06".into(),
            "Tower of the Wing Cap flags".into(),
            256,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_07".into(),
            "Vanish Cap Under the Moat flags".into(),
            257,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_08".into(),
            "Wing Mario Over the Rainbow flags".into(),
            258,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_c.secret_course_flags_09".into(),
            "The Secret Aquarium flags".into(),
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
    game.description = concat!(
        "Edits Mario D in a canonical 2 KiB big-endian EEPROM image and ",
        "repairs its primary checksum plus the options checksum. Other ",
        "slots and backup records stay unchanged. Byte-swapped files, ",
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
        FieldDefinition::new(
            "mario_d.secret_star_flags".into(),
            "Castle secret-star flags".into(),
            344,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.door_event_flags".into(),
            "Castle door event flags".into(),
            345,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.castle_event_flags".into(),
            "Castle event flags".into(),
            346,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.key_and_cap_flags".into(),
            "Key and cap-switch flags".into(),
            347,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_01".into(),
            "Course 1 stars and adjacent cannon flags".into(),
            348,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_02".into(),
            "Course 2 stars and adjacent cannon flags".into(),
            349,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_03".into(),
            "Course 3 stars and adjacent cannon flags".into(),
            350,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_04".into(),
            "Course 4 stars and adjacent cannon flags".into(),
            351,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_05".into(),
            "Course 5 stars and adjacent cannon flags".into(),
            352,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_06".into(),
            "Course 6 stars and adjacent cannon flags".into(),
            353,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_07".into(),
            "Course 7 stars and adjacent cannon flags".into(),
            354,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_08".into(),
            "Course 8 stars and adjacent cannon flags".into(),
            355,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_09".into(),
            "Course 9 stars and adjacent cannon flags".into(),
            356,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_10".into(),
            "Course 10 stars and adjacent cannon flags".into(),
            357,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_11".into(),
            "Course 11 stars and adjacent cannon flags".into(),
            358,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_12".into(),
            "Course 12 stars and adjacent cannon flags".into(),
            359,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_13".into(),
            "Course 13 stars and adjacent cannon flags".into(),
            360,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_14".into(),
            "Course 14 stars and adjacent cannon flags".into(),
            361,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.course_flags_15".into(),
            "Course 15 stars and adjacent cannon flags".into(),
            362,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.bob_omb_battlefield".into(),
            "Bob-omb Battlefield coin score".into(),
            373,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.whomps_fortress".into(),
            "Whomp's Fortress coin score".into(),
            374,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.jolly_roger_bay".into(),
            "Jolly Roger Bay coin score".into(),
            375,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.cool_cool_mountain".into(),
            "Cool, Cool Mountain coin score".into(),
            376,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.big_boos_haunt".into(),
            "Big Boo's Haunt coin score".into(),
            377,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.hazy_maze_cave".into(),
            "Hazy Maze Cave coin score".into(),
            378,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.lethal_lava_land".into(),
            "Lethal Lava Land coin score".into(),
            379,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.shifting_sand_land".into(),
            "Shifting Sand Land coin score".into(),
            380,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.dire_dire_docks".into(),
            "Dire, Dire Docks coin score".into(),
            381,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.snowmans_land".into(),
            "Snowman's Land coin score".into(),
            382,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.wet_dry_world".into(),
            "Wet-Dry World coin score".into(),
            383,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.tall_tall_mountain".into(),
            "Tall, Tall Mountain coin score".into(),
            384,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.tiny_huge_island".into(),
            "Tiny-Huge Island coin score".into(),
            385,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.tick_tock_clock".into(),
            "Tick Tock Clock coin score".into(),
            386,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.score.rainbow_ride".into(),
            "Rainbow Ride coin score".into(),
            387,
            Storage::U8,
        ),
        FieldDefinition::new(
            "options.sound".into(),
            "Sound mode".into(),
            465,
            Storage::U8,
        ),
        FieldDefinition::new(
            "options.language".into(),
            "Language".into(),
            467,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_01".into(),
            "Bowser in the Dark World flags".into(),
            363,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_02".into(),
            "Bowser in the Fire Sea flags".into(),
            364,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_03".into(),
            "Bowser in the Sky flags".into(),
            365,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_04".into(),
            "The Princess’s Secret Slide flags".into(),
            366,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_05".into(),
            "Cavern of the Metal Cap flags".into(),
            367,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_06".into(),
            "Tower of the Wing Cap flags".into(),
            368,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_07".into(),
            "Vanish Cap Under the Moat flags".into(),
            369,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_08".into(),
            "Wing Mario Over the Rainbow flags".into(),
            370,
            Storage::U8,
        ),
        FieldDefinition::new(
            "mario_d.secret_course_flags_09".into(),
            "The Secret Aquarium flags".into(),
            371,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}
