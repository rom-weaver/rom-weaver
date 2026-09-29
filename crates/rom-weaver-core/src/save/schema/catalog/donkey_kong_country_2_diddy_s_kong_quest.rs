use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            FieldDefinition::new(
                "slot_1.player_1.kremkoins".into(),
                "Kremkoins".into(),
                19,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.player_1.play_time".into(),
                "Play-time ticks".into(),
                14,
                Storage::U32Le,
            ),
            FieldDefinition::new(
                "slot_1.player_1.completion".into(),
                "Completion percentage".into(),
                18,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_1.hero_coins".into(),
                "Hero's Coins".into(),
                20,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_1.location".into(),
                "Location code".into(),
                189,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_2.kremkoins".into(),
                "Kremkoins".into(),
                353,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.player_2.play_time".into(),
                "Play-time ticks".into(),
                348,
                Storage::U32Le,
            ),
            FieldDefinition::new(
                "slot_1.player_2.completion".into(),
                "Completion percentage".into(),
                352,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_2.hero_coins".into(),
                "Hero's Coins".into(),
                354,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_2.location".into(),
                "Location code".into(),
                523,
                Storage::U8,
            )
            .editable(false),
        ];
        GameDefinition {
            fields,
            description: concat!(
                "Edits independent counters in Slot 1; preserves other slots. ",
                "Coupled progression, completion, inventory and location updates ",
                "remain unsupported. Numeric values use full storage ranges; ",
                "playable states are not guaranteed. EUR/USA/JPN layouts."
            )
            .into(),
            checksums: vec![
                ChecksumDefinition {
                    start: Some(14),
                    length: Some(674),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 8)
                },
                ChecksumDefinition {
                    start: Some(14),
                    length: Some(674),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 10)
                },
            ],
            ..GameDefinition::new("".into(), "".into(), "snes".into(), 2048)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_donkey_kong_country_2_diddy_s_kong_quest_slot_1(),
        game_donkey_kong_country_2_diddy_s_kong_quest_slot_2(),
        game_donkey_kong_country_2_diddy_s_kong_quest_slot_3(),
    ];

    build(games, codecs, true)
}

fn game_donkey_kong_country_2_diddy_s_kong_quest_slot_1() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-2-diddy-s-kong-quest-slot-1".into();
    game.name = "Donkey Kong Country 2: Diddy's Kong Quest (Slot 1)".into();
    game
}

fn game_donkey_kong_country_2_diddy_s_kong_quest_slot_2() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-2-diddy-s-kong-quest-slot-2".into();
    game.name = "Donkey Kong Country 2: Diddy's Kong Quest (Slot 2)".into();
    game.description = concat!(
        "Edits independent counters in Slot 2; preserves other slots. ",
        "Coupled progression, completion, inventory and location updates ",
        "remain unsupported. Numeric values use full storage ranges; ",
        "playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(694),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 688)
        },
        ChecksumDefinition {
            start: Some(694),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 690)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_2.player_1.kremkoins".into(),
            "Kremkoins".into(),
            699,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.player_1.play_time".into(),
            "Play-time ticks".into(),
            694,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_2.player_1.completion".into(),
            "Completion percentage".into(),
            698,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_1.hero_coins".into(),
            "Hero's Coins".into(),
            700,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_1.location".into(),
            "Location code".into(),
            869,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_2.kremkoins".into(),
            "Kremkoins".into(),
            1033,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.player_2.play_time".into(),
            "Play-time ticks".into(),
            1028,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_2.player_2.completion".into(),
            "Completion percentage".into(),
            1032,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_2.hero_coins".into(),
            "Hero's Coins".into(),
            1034,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_2.location".into(),
            "Location code".into(),
            1203,
            Storage::U8,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}

fn game_donkey_kong_country_2_diddy_s_kong_quest_slot_3() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-2-diddy-s-kong-quest-slot-3".into();
    game.name = "Donkey Kong Country 2: Diddy's Kong Quest (Slot 3)".into();
    game.description = concat!(
        "Edits independent counters in Slot 3; preserves other slots. ",
        "Coupled progression, completion, inventory and location updates ",
        "remain unsupported. Numeric values use full storage ranges; ",
        "playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1374),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1368)
        },
        ChecksumDefinition {
            start: Some(1374),
            length: Some(674),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 1370)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_3.player_1.kremkoins".into(),
            "Kremkoins".into(),
            1379,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.player_1.play_time".into(),
            "Play-time ticks".into(),
            1374,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_3.player_1.completion".into(),
            "Completion percentage".into(),
            1378,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_1.hero_coins".into(),
            "Hero's Coins".into(),
            1380,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_1.location".into(),
            "Location code".into(),
            1549,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_2.kremkoins".into(),
            "Kremkoins".into(),
            1713,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.player_2.play_time".into(),
            "Play-time ticks".into(),
            1708,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_3.player_2.completion".into(),
            "Completion percentage".into(),
            1712,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_2.hero_coins".into(),
            "Hero's Coins".into(),
            1714,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_2.location".into(),
            "Location code".into(),
            1883,
            Storage::U8,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}
