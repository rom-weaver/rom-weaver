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
    relocate_slot_fields(&mut game.fields, "mario_b", 112);
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
    relocate_slot_fields(&mut game.fields, "mario_c", 224);
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
    relocate_slot_fields(&mut game.fields, "mario_d", 336);
    game
}

fn relocate_slot_fields(fields: &mut [FieldDefinition], prefix: &str, base: usize) {
    for field in fields {
        if let Some(suffix) = field.id.strip_prefix("mario_a.") {
            field.id = format!("{prefix}.{suffix}");
            field.offset += base;
        }
    }
}
