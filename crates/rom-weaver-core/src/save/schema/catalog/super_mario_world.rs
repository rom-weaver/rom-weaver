use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_super_mario_world_schema(),
        template_game(2),
        template_game(3),
    ];

    build(games, codecs, true)
}

fn game_super_mario_world_schema() -> GameDefinition {
    let fields = vec![
        FieldDefinition::new(
            "slot_1.levels.level_00.flags".into(),
            "Level 00 movement and completion flags".into(),
            0,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_01.flags".into(),
            "Level 01 movement and completion flags".into(),
            1,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_02.flags".into(),
            "Level 02 movement and completion flags".into(),
            2,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_03.flags".into(),
            "Level 03 movement and completion flags".into(),
            3,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_04.flags".into(),
            "Level 04 movement and completion flags".into(),
            4,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_05.flags".into(),
            "Level 05 movement and completion flags".into(),
            5,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_06.flags".into(),
            "Level 06 movement and completion flags".into(),
            6,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_07.flags".into(),
            "Level 07 movement and completion flags".into(),
            7,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_08.flags".into(),
            "Level 08 movement and completion flags".into(),
            8,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_09.flags".into(),
            "Level 09 movement and completion flags".into(),
            9,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_0a.flags".into(),
            "Level 0A movement and completion flags".into(),
            10,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_0b.flags".into(),
            "Level 0B movement and completion flags".into(),
            11,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_0c.flags".into(),
            "Level 0C movement and completion flags".into(),
            12,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_0d.flags".into(),
            "Level 0D movement and completion flags".into(),
            13,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_0e.flags".into(),
            "Level 0E movement and completion flags".into(),
            14,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_0f.flags".into(),
            "Level 0F movement and completion flags".into(),
            15,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_10.flags".into(),
            "Level 10 movement and completion flags".into(),
            16,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_11.flags".into(),
            "Level 11 movement and completion flags".into(),
            17,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_12.flags".into(),
            "Level 12 movement and completion flags".into(),
            18,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_13.flags".into(),
            "Level 13 movement and completion flags".into(),
            19,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_14.flags".into(),
            "Level 14 movement and completion flags".into(),
            20,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_15.flags".into(),
            "Level 15 movement and completion flags".into(),
            21,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_16.flags".into(),
            "Level 16 movement and completion flags".into(),
            22,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_17.flags".into(),
            "Level 17 movement and completion flags".into(),
            23,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_18.flags".into(),
            "Level 18 movement and completion flags".into(),
            24,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_19.flags".into(),
            "Level 19 movement and completion flags".into(),
            25,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_1a.flags".into(),
            "Level 1A movement and completion flags".into(),
            26,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_1b.flags".into(),
            "Level 1B movement and completion flags".into(),
            27,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_1c.flags".into(),
            "Level 1C movement and completion flags".into(),
            28,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_1d.flags".into(),
            "Level 1D movement and completion flags".into(),
            29,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_1e.flags".into(),
            "Level 1E movement and completion flags".into(),
            30,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_1f.flags".into(),
            "Level 1F movement and completion flags".into(),
            31,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_20.flags".into(),
            "Level 20 movement and completion flags".into(),
            32,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_21.flags".into(),
            "Level 21 movement and completion flags".into(),
            33,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_22.flags".into(),
            "Level 22 movement and completion flags".into(),
            34,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_23.flags".into(),
            "Level 23 movement and completion flags".into(),
            35,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_24.flags".into(),
            "Level 24 movement and completion flags".into(),
            36,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_25.flags".into(),
            "Level 25 movement and completion flags".into(),
            37,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_26.flags".into(),
            "Level 26 movement and completion flags".into(),
            38,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_27.flags".into(),
            "Level 27 movement and completion flags".into(),
            39,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_28.flags".into(),
            "Level 28 movement and completion flags".into(),
            40,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_29.flags".into(),
            "Level 29 movement and completion flags".into(),
            41,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_2a.flags".into(),
            "Level 2A movement and completion flags".into(),
            42,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_2b.flags".into(),
            "Level 2B movement and completion flags".into(),
            43,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_2c.flags".into(),
            "Level 2C movement and completion flags".into(),
            44,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_2d.flags".into(),
            "Level 2D movement and completion flags".into(),
            45,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_2e.flags".into(),
            "Level 2E movement and completion flags".into(),
            46,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_2f.flags".into(),
            "Level 2F movement and completion flags".into(),
            47,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_30.flags".into(),
            "Level 30 movement and completion flags".into(),
            48,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_31.flags".into(),
            "Level 31 movement and completion flags".into(),
            49,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_32.flags".into(),
            "Level 32 movement and completion flags".into(),
            50,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_33.flags".into(),
            "Level 33 movement and completion flags".into(),
            51,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_34.flags".into(),
            "Level 34 movement and completion flags".into(),
            52,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_35.flags".into(),
            "Level 35 movement and completion flags".into(),
            53,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_36.flags".into(),
            "Level 36 movement and completion flags".into(),
            54,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_37.flags".into(),
            "Level 37 movement and completion flags".into(),
            55,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_38.flags".into(),
            "Level 38 movement and completion flags".into(),
            56,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_39.flags".into(),
            "Level 39 movement and completion flags".into(),
            57,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_3a.flags".into(),
            "Level 3A movement and completion flags".into(),
            58,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_3b.flags".into(),
            "Level 3B movement and completion flags".into(),
            59,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_3c.flags".into(),
            "Level 3C movement and completion flags".into(),
            60,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_3d.flags".into(),
            "Level 3D movement and completion flags".into(),
            61,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_3e.flags".into(),
            "Level 3E movement and completion flags".into(),
            62,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_3f.flags".into(),
            "Level 3F movement and completion flags".into(),
            63,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_40.flags".into(),
            "Level 40 movement and completion flags".into(),
            64,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_41.flags".into(),
            "Level 41 movement and completion flags".into(),
            65,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_42.flags".into(),
            "Level 42 movement and completion flags".into(),
            66,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_43.flags".into(),
            "Level 43 movement and completion flags".into(),
            67,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_44.flags".into(),
            "Level 44 movement and completion flags".into(),
            68,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_45.flags".into(),
            "Level 45 movement and completion flags".into(),
            69,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_46.flags".into(),
            "Level 46 movement and completion flags".into(),
            70,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_47.flags".into(),
            "Level 47 movement and completion flags".into(),
            71,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_48.flags".into(),
            "Level 48 movement and completion flags".into(),
            72,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_49.flags".into(),
            "Level 49 movement and completion flags".into(),
            73,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_4a.flags".into(),
            "Level 4A movement and completion flags".into(),
            74,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_4b.flags".into(),
            "Level 4B movement and completion flags".into(),
            75,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_4c.flags".into(),
            "Level 4C movement and completion flags".into(),
            76,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_4d.flags".into(),
            "Level 4D movement and completion flags".into(),
            77,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_4e.flags".into(),
            "Level 4E movement and completion flags".into(),
            78,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_4f.flags".into(),
            "Level 4F movement and completion flags".into(),
            79,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_50.flags".into(),
            "Level 50 movement and completion flags".into(),
            80,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_51.flags".into(),
            "Level 51 movement and completion flags".into(),
            81,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_52.flags".into(),
            "Level 52 movement and completion flags".into(),
            82,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_53.flags".into(),
            "Level 53 movement and completion flags".into(),
            83,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_54.flags".into(),
            "Level 54 movement and completion flags".into(),
            84,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_55.flags".into(),
            "Level 55 movement and completion flags".into(),
            85,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_56.flags".into(),
            "Level 56 movement and completion flags".into(),
            86,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_57.flags".into(),
            "Level 57 movement and completion flags".into(),
            87,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_58.flags".into(),
            "Level 58 movement and completion flags".into(),
            88,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_59.flags".into(),
            "Level 59 movement and completion flags".into(),
            89,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_5a.flags".into(),
            "Level 5A movement and completion flags".into(),
            90,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_5b.flags".into(),
            "Level 5B movement and completion flags".into(),
            91,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_5c.flags".into(),
            "Level 5C movement and completion flags".into(),
            92,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_5d.flags".into(),
            "Level 5D movement and completion flags".into(),
            93,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_5e.flags".into(),
            "Level 5E movement and completion flags".into(),
            94,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.levels.level_5f.flags".into(),
            "Level 5F movement and completion flags".into(),
            95,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.events.event_000".into(),
            "Overworld event 0".into(),
            96,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_001".into(),
            "Overworld event 1".into(),
            96,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_002".into(),
            "Overworld event 2".into(),
            96,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_003".into(),
            "Overworld event 3".into(),
            96,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_004".into(),
            "Overworld event 4".into(),
            96,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_005".into(),
            "Overworld event 5".into(),
            96,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_006".into(),
            "Overworld event 6".into(),
            96,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_007".into(),
            "Overworld event 7".into(),
            96,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_008".into(),
            "Overworld event 8".into(),
            97,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_009".into(),
            "Overworld event 9".into(),
            97,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_010".into(),
            "Overworld event 10".into(),
            97,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_011".into(),
            "Overworld event 11".into(),
            97,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_012".into(),
            "Overworld event 12".into(),
            97,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_013".into(),
            "Overworld event 13".into(),
            97,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_014".into(),
            "Overworld event 14".into(),
            97,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_015".into(),
            "Overworld event 15".into(),
            97,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_016".into(),
            "Overworld event 16".into(),
            98,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_017".into(),
            "Overworld event 17".into(),
            98,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_018".into(),
            "Overworld event 18".into(),
            98,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_019".into(),
            "Overworld event 19".into(),
            98,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_020".into(),
            "Overworld event 20".into(),
            98,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_021".into(),
            "Overworld event 21".into(),
            98,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_022".into(),
            "Overworld event 22".into(),
            98,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_023".into(),
            "Overworld event 23".into(),
            98,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_024".into(),
            "Overworld event 24".into(),
            99,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_025".into(),
            "Overworld event 25".into(),
            99,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_026".into(),
            "Overworld event 26".into(),
            99,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_027".into(),
            "Overworld event 27".into(),
            99,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_028".into(),
            "Overworld event 28".into(),
            99,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_029".into(),
            "Overworld event 29".into(),
            99,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_030".into(),
            "Overworld event 30".into(),
            99,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_031".into(),
            "Overworld event 31".into(),
            99,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_032".into(),
            "Overworld event 32".into(),
            100,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_033".into(),
            "Overworld event 33".into(),
            100,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_034".into(),
            "Overworld event 34".into(),
            100,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_035".into(),
            "Overworld event 35".into(),
            100,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_036".into(),
            "Overworld event 36".into(),
            100,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_037".into(),
            "Overworld event 37".into(),
            100,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_038".into(),
            "Overworld event 38".into(),
            100,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_039".into(),
            "Overworld event 39".into(),
            100,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_040".into(),
            "Overworld event 40".into(),
            101,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_041".into(),
            "Overworld event 41".into(),
            101,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_042".into(),
            "Overworld event 42".into(),
            101,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_043".into(),
            "Overworld event 43".into(),
            101,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_044".into(),
            "Overworld event 44".into(),
            101,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_045".into(),
            "Overworld event 45".into(),
            101,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_046".into(),
            "Overworld event 46".into(),
            101,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_047".into(),
            "Overworld event 47".into(),
            101,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_048".into(),
            "Overworld event 48".into(),
            102,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_049".into(),
            "Overworld event 49".into(),
            102,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_050".into(),
            "Overworld event 50".into(),
            102,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_051".into(),
            "Overworld event 51".into(),
            102,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_052".into(),
            "Overworld event 52".into(),
            102,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_053".into(),
            "Overworld event 53".into(),
            102,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_054".into(),
            "Overworld event 54".into(),
            102,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_055".into(),
            "Overworld event 55".into(),
            102,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_056".into(),
            "Overworld event 56".into(),
            103,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_057".into(),
            "Overworld event 57".into(),
            103,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_058".into(),
            "Overworld event 58".into(),
            103,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_059".into(),
            "Overworld event 59".into(),
            103,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_060".into(),
            "Overworld event 60".into(),
            103,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_061".into(),
            "Overworld event 61".into(),
            103,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_062".into(),
            "Overworld event 62".into(),
            103,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_063".into(),
            "Overworld event 63".into(),
            103,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_064".into(),
            "Overworld event 64".into(),
            104,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_065".into(),
            "Overworld event 65".into(),
            104,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_066".into(),
            "Overworld event 66".into(),
            104,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_067".into(),
            "Overworld event 67".into(),
            104,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_068".into(),
            "Overworld event 68".into(),
            104,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_069".into(),
            "Overworld event 69".into(),
            104,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_070".into(),
            "Overworld event 70".into(),
            104,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_071".into(),
            "Overworld event 71".into(),
            104,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_072".into(),
            "Overworld event 72".into(),
            105,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_073".into(),
            "Overworld event 73".into(),
            105,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_074".into(),
            "Overworld event 74".into(),
            105,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_075".into(),
            "Overworld event 75".into(),
            105,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_076".into(),
            "Overworld event 76".into(),
            105,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_077".into(),
            "Overworld event 77".into(),
            105,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_078".into(),
            "Overworld event 78".into(),
            105,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_079".into(),
            "Overworld event 79".into(),
            105,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_080".into(),
            "Overworld event 80".into(),
            106,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_081".into(),
            "Overworld event 81".into(),
            106,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_082".into(),
            "Overworld event 82".into(),
            106,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_083".into(),
            "Overworld event 83".into(),
            106,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_084".into(),
            "Overworld event 84".into(),
            106,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_085".into(),
            "Overworld event 85".into(),
            106,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_086".into(),
            "Overworld event 86".into(),
            106,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_087".into(),
            "Overworld event 87".into(),
            106,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_088".into(),
            "Overworld event 88".into(),
            107,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_089".into(),
            "Overworld event 89".into(),
            107,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_090".into(),
            "Overworld event 90".into(),
            107,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_091".into(),
            "Overworld event 91".into(),
            107,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_092".into(),
            "Overworld event 92".into(),
            107,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_093".into(),
            "Overworld event 93".into(),
            107,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_094".into(),
            "Overworld event 94".into(),
            107,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_095".into(),
            "Overworld event 95".into(),
            107,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_096".into(),
            "Overworld event 96".into(),
            108,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_097".into(),
            "Overworld event 97".into(),
            108,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_098".into(),
            "Overworld event 98".into(),
            108,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_099".into(),
            "Overworld event 99".into(),
            108,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_100".into(),
            "Overworld event 100".into(),
            108,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_101".into(),
            "Overworld event 101".into(),
            108,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_102".into(),
            "Overworld event 102".into(),
            108,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_103".into(),
            "Overworld event 103".into(),
            108,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_104".into(),
            "Overworld event 104".into(),
            109,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_105".into(),
            "Overworld event 105".into(),
            109,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_106".into(),
            "Overworld event 106".into(),
            109,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_107".into(),
            "Overworld event 107".into(),
            109,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_108".into(),
            "Overworld event 108".into(),
            109,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_109".into(),
            "Overworld event 109".into(),
            109,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_110".into(),
            "Overworld event 110".into(),
            109,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_111".into(),
            "Overworld event 111".into(),
            109,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.events.event_112".into(),
            "Overworld event 112".into(),
            110,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.events.event_113".into(),
            "Overworld event 113".into(),
            110,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.events.event_114".into(),
            "Overworld event 114".into(),
            110,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.events.event_115".into(),
            "Overworld event 115".into(),
            110,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.events.event_116".into(),
            "Overworld event 116".into(),
            110,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.events.event_117".into(),
            "Overworld event 117".into(),
            110,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.events.event_118".into(),
            "Overworld event 118".into(),
            110,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.events.event_119".into(),
            "Overworld event 119".into(),
            110,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.players.player_1.submap".into(),
            "Player 1 submap".into(),
            111,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.players.player_1.animation".into(),
            "Player 1 overworld animation".into(),
            113,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_1.x".into(),
            "Player 1 X position".into(),
            117,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_1.y".into(),
            "Player 1 Y position".into(),
            119,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_1.x_tile".into(),
            "Player 1 X tile pointer".into(),
            125,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_1.y_tile".into(),
            "Player 1 Y tile pointer".into(),
            127,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_2.submap".into(),
            "Player 2 submap".into(),
            112,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.players.player_2.animation".into(),
            "Player 2 overworld animation".into(),
            115,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_2.x".into(),
            "Player 2 X position".into(),
            121,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_2.y".into(),
            "Player 2 Y position".into(),
            123,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_2.x_tile".into(),
            "Player 2 X tile pointer".into(),
            129,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.players.player_2.y_tile".into(),
            "Player 2 Y tile pointer".into(),
            131,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_1.progress.switch_palaces.yellow".into(),
            "Yellow Switch Palace".into(),
            133,
            Storage::Bool,
        ),
        FieldDefinition::new(
            "slot_1.progress.switch_palaces.green".into(),
            "Green Switch Palace".into(),
            134,
            Storage::Bool,
        ),
        FieldDefinition::new(
            "slot_1.progress.switch_palaces.red".into(),
            "Red Switch Palace".into(),
            135,
            Storage::Bool,
        ),
        FieldDefinition::new(
            "slot_1.progress.switch_palaces.blue".into(),
            "Blue Switch Palace".into(),
            136,
            Storage::Bool,
        ),
        FieldDefinition::new(
            "slot_1.progress.exits_completed".into(),
            "Exits completed".into(),
            140,
            Storage::U8,
        ),
    ];
    GameDefinition {
 fields,
 description: "Edits File 1 and its backup. Preserves Files 2 and 3. Fresh saves use the original initial overworld state.".into(),
 checksums: vec![ChecksumDefinition {
 start: Some(0),
 length: Some(141),
 target: Some(23130),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 141) }
],
 mirrors: vec![MirrorDefinition {
 source: 0,
 target: 429,
 length: 143,
 validate: None }
],
 generation: Some(generation::GenerationDefinition {
 fill: 0,
 patches: vec![generation::InitialPatch {
 offset: 111,
 bytes: vec![1,
 1,
 2,
 0,
 2,
 0,
 104,
 0,
 120,
 0,
 104,
 0,
 120,
 0,
 6,
 0,
 7,
 0,
 6,
 0,
 7,
 0] }
],
 values: BTreeMap::from([("slot_1.levels.level_28.flags".into(),
 SaveValue::U32(3)),
 ("slot_1.levels.level_30.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_4d.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_52.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_53.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_57.flags".into(),
 SaveValue::U32(4)),
 ("slot_1.levels.level_5b.flags".into(),
 SaveValue::U32(8)),
 ("slot_1.levels.level_5c.flags".into(),
 SaveValue::U32(2))]) }
),
 ..GameDefinition::new("super-mario-world-schema".into(),
 "Super Mario World (File 1 schema)".into(),
 "snes".into(),
 2048) }
}

fn template_game(slot: usize) -> GameDefinition {
    let base = (slot - 1) * 143;
    let mut fields = game_super_mario_world_schema().fields;
    for field in &mut fields {
        field.id = field.id.replacen("slot_1", &format!("slot_{slot}"), 1);
        field.offset += base;
        for copy in &mut field.copies {
            *copy += base;
        }
    }
    GameDefinition {
        fields,
        description: format!(
            "Edits File {slot} and its backup; preserves other files. Requires a valid checksum and matching backup. Template only."
        ),
        checksums: vec![ChecksumDefinition {
            start: Some(base),
            length: Some(141),
            target: Some(23130),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, base + 141)
        }],
        mirrors: vec![MirrorDefinition {
            source: base,
            target: base + 429,
            length: 143,
            validate: None,
        }],
        ..GameDefinition::new(
            format!("super-mario-world-file-{slot}-schema"),
            format!("Super Mario World (File {slot} schema)"),
            "snes".into(),
            2048,
        )
    }
}
