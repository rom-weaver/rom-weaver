use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            FieldDefinition::new(
                "slot_1.player_1.play_time".into(),
                "Play-time ticks".into(),
                114,
                Storage::U32Le,
            ),
            FieldDefinition::new(
                "slot_1.player_1.bear_coins".into(),
                "Bear Coins".into(),
                123,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.player_1.bonus_coins".into(),
                "Bonus Coins".into(),
                125,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.player_1.dk_coins".into(),
                "DK Coins".into(),
                129,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.player_1.banana_birds".into(),
                "Banana Birds".into(),
                127,
                Storage::U16Le,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_1.completion".into(),
                "Completion percentage".into(),
                118,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_1.location".into(),
                "Location code".into(),
                135,
                Storage::U32Le,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_2.play_time".into(),
                "Play-time ticks".into(),
                436,
                Storage::U32Le,
            ),
            FieldDefinition::new(
                "slot_1.player_2.bear_coins".into(),
                "Bear Coins".into(),
                445,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.player_2.bonus_coins".into(),
                "Bonus Coins".into(),
                447,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.player_2.dk_coins".into(),
                "DK Coins".into(),
                451,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.player_2.banana_birds".into(),
                "Banana Birds".into(),
                449,
                Storage::U16Le,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_2.completion".into(),
                "Completion percentage".into(),
                440,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.player_2.location".into(),
                "Location code".into(),
                457,
                Storage::U32Le,
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
                    start: Some(104),
                    length: Some(644),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 98)
                },
                ChecksumDefinition {
                    start: Some(104),
                    length: Some(644),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 100)
                },
            ],
            ..GameDefinition::new("".into(), "".into(), "snes".into(), 2048)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_donkey_kong_country_3_dixie_kong_s_double_trouble_slot_1(),
        game_donkey_kong_country_3_dixie_kong_s_double_trouble_slot_2(),
        game_donkey_kong_country_3_dixie_kong_s_double_trouble_slot_3(),
    ];

    build(games, codecs, true)
}

fn game_donkey_kong_country_3_dixie_kong_s_double_trouble_slot_1() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-3-dixie-kong-s-double-trouble-slot-1".into();
    game.name = "Donkey Kong Country 3: Dixie Kong's Double Trouble! (Slot 1)".into();
    game
}

fn game_donkey_kong_country_3_dixie_kong_s_double_trouble_slot_2() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-3-dixie-kong-s-double-trouble-slot-2".into();
    game.name = "Donkey Kong Country 3: Dixie Kong's Double Trouble! (Slot 2)".into();
    game.description = concat!(
        "Edits independent counters in Slot 2; preserves other slots. ",
        "Coupled progression, completion, inventory and location updates ",
        "remain unsupported. Numeric values use full storage ranges; ",
        "playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(754),
            length: Some(644),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 748)
        },
        ChecksumDefinition {
            start: Some(754),
            length: Some(644),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 750)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_2.player_1.play_time".into(),
            "Play-time ticks".into(),
            764,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_2.player_1.bear_coins".into(),
            "Bear Coins".into(),
            773,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.player_1.bonus_coins".into(),
            "Bonus Coins".into(),
            775,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.player_1.dk_coins".into(),
            "DK Coins".into(),
            779,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.player_1.banana_birds".into(),
            "Banana Birds".into(),
            777,
            Storage::U16Le,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_1.completion".into(),
            "Completion percentage".into(),
            768,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_1.location".into(),
            "Location code".into(),
            785,
            Storage::U32Le,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_2.play_time".into(),
            "Play-time ticks".into(),
            1086,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_2.player_2.bear_coins".into(),
            "Bear Coins".into(),
            1095,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.player_2.bonus_coins".into(),
            "Bonus Coins".into(),
            1097,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.player_2.dk_coins".into(),
            "DK Coins".into(),
            1101,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.player_2.banana_birds".into(),
            "Banana Birds".into(),
            1099,
            Storage::U16Le,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_2.completion".into(),
            "Completion percentage".into(),
            1090,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.player_2.location".into(),
            "Location code".into(),
            1107,
            Storage::U32Le,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}

fn game_donkey_kong_country_3_dixie_kong_s_double_trouble_slot_3() -> GameDefinition {
    let mut game = default();
    game.id = "donkey-kong-country-3-dixie-kong-s-double-trouble-slot-3".into();
    game.name = "Donkey Kong Country 3: Dixie Kong's Double Trouble! (Slot 3)".into();
    game.description = concat!(
        "Edits independent counters in Slot 3; preserves other slots. ",
        "Coupled progression, completion, inventory and location updates ",
        "remain unsupported. Numeric values use full storage ranges; ",
        "playable states are not guaranteed. EUR/USA/JPN layouts."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1404),
            length: Some(644),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1398)
        },
        ChecksumDefinition {
            start: Some(1404),
            length: Some(644),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor16Le, 1400)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_3.player_1.play_time".into(),
            "Play-time ticks".into(),
            1414,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_3.player_1.bear_coins".into(),
            "Bear Coins".into(),
            1423,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.player_1.bonus_coins".into(),
            "Bonus Coins".into(),
            1425,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.player_1.dk_coins".into(),
            "DK Coins".into(),
            1429,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.player_1.banana_birds".into(),
            "Banana Birds".into(),
            1427,
            Storage::U16Le,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_1.completion".into(),
            "Completion percentage".into(),
            1418,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_1.location".into(),
            "Location code".into(),
            1435,
            Storage::U32Le,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_2.play_time".into(),
            "Play-time ticks".into(),
            1736,
            Storage::U32Le,
        ),
        FieldDefinition::new(
            "slot_3.player_2.bear_coins".into(),
            "Bear Coins".into(),
            1745,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.player_2.bonus_coins".into(),
            "Bonus Coins".into(),
            1747,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.player_2.dk_coins".into(),
            "DK Coins".into(),
            1751,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.player_2.banana_birds".into(),
            "Banana Birds".into(),
            1749,
            Storage::U16Le,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_2.completion".into(),
            "Completion percentage".into(),
            1740,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.player_2.location".into(),
            "Location code".into(),
            1757,
            Storage::U32Le,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}
