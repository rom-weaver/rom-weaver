use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            catalog_field(
                "slot_1.player_1.play_time",
                "Play-time ticks",
                114,
                Storage::U32Le,
            ),
            catalog_field(
                "slot_1.player_1.bear_coins",
                "Bear Coins",
                123,
                Storage::U16Le,
            ),
            catalog_field(
                "slot_1.player_1.bonus_coins",
                "Bonus Coins",
                125,
                Storage::U16Le,
            ),
            catalog_field("slot_1.player_1.dk_coins", "DK Coins", 129, Storage::U16Le),
            catalog_field(
                "slot_1.player_1.banana_birds",
                "Banana Birds",
                127,
                Storage::U16Le,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_1.completion",
                "Completion percentage",
                118,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_1.location",
                "Location code",
                135,
                Storage::U32Le,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_2.play_time",
                "Play-time ticks",
                436,
                Storage::U32Le,
            ),
            catalog_field(
                "slot_1.player_2.bear_coins",
                "Bear Coins",
                445,
                Storage::U16Le,
            ),
            catalog_field(
                "slot_1.player_2.bonus_coins",
                "Bonus Coins",
                447,
                Storage::U16Le,
            ),
            catalog_field("slot_1.player_2.dk_coins", "DK Coins", 451, Storage::U16Le),
            catalog_field(
                "slot_1.player_2.banana_birds",
                "Banana Birds",
                449,
                Storage::U16Le,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_2.completion",
                "Completion percentage",
                440,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_2.location",
                "Location code",
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
        catalog_field(
            "slot_2.player_1.play_time",
            "Play-time ticks",
            764,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_2.player_1.bear_coins",
            "Bear Coins",
            773,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_2.player_1.bonus_coins",
            "Bonus Coins",
            775,
            Storage::U16Le,
        ),
        catalog_field("slot_2.player_1.dk_coins", "DK Coins", 779, Storage::U16Le),
        catalog_field(
            "slot_2.player_1.banana_birds",
            "Banana Birds",
            777,
            Storage::U16Le,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_1.completion",
            "Completion percentage",
            768,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_1.location",
            "Location code",
            785,
            Storage::U32Le,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_2.play_time",
            "Play-time ticks",
            1086,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_2.player_2.bear_coins",
            "Bear Coins",
            1095,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_2.player_2.bonus_coins",
            "Bonus Coins",
            1097,
            Storage::U16Le,
        ),
        catalog_field("slot_2.player_2.dk_coins", "DK Coins", 1101, Storage::U16Le),
        catalog_field(
            "slot_2.player_2.banana_birds",
            "Banana Birds",
            1099,
            Storage::U16Le,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_2.completion",
            "Completion percentage",
            1090,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_2.location",
            "Location code",
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
        catalog_field(
            "slot_3.player_1.play_time",
            "Play-time ticks",
            1414,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_3.player_1.bear_coins",
            "Bear Coins",
            1423,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_3.player_1.bonus_coins",
            "Bonus Coins",
            1425,
            Storage::U16Le,
        ),
        catalog_field("slot_3.player_1.dk_coins", "DK Coins", 1429, Storage::U16Le),
        catalog_field(
            "slot_3.player_1.banana_birds",
            "Banana Birds",
            1427,
            Storage::U16Le,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_1.completion",
            "Completion percentage",
            1418,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_1.location",
            "Location code",
            1435,
            Storage::U32Le,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_2.play_time",
            "Play-time ticks",
            1736,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_3.player_2.bear_coins",
            "Bear Coins",
            1745,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_3.player_2.bonus_coins",
            "Bonus Coins",
            1747,
            Storage::U16Le,
        ),
        catalog_field("slot_3.player_2.dk_coins", "DK Coins", 1751, Storage::U16Le),
        catalog_field(
            "slot_3.player_2.banana_birds",
            "Banana Birds",
            1749,
            Storage::U16Le,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_2.completion",
            "Completion percentage",
            1740,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_2.location",
            "Location code",
            1757,
            Storage::U32Le,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}
