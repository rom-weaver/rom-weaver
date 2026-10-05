use super::*;

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
                "slots. Coupled progression, completion, inventory and location ",
                "updates remain unsupported. Numeric values use full storage ",
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

    let games = vec![
        game_donkey_kong_country_slot_1_player_1(),
        game_donkey_kong_country_slot_1_player_2(),
        game_donkey_kong_country_slot_2_player_1(),
        game_donkey_kong_country_slot_2_player_2(),
        game_donkey_kong_country_slot_3_player_1(),
        game_donkey_kong_country_slot_3_player_2(),
    ];

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
        "slots. Coupled progression, completion, inventory and location ",
        "updates remain unsupported. Numeric values use full storage ",
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
        "slots. Coupled progression, completion, inventory and location ",
        "updates remain unsupported. Numeric values use full storage ",
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
        "slots. Coupled progression, completion, inventory and location ",
        "updates remain unsupported. Numeric values use full storage ",
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
        "slots. Coupled progression, completion, inventory and location ",
        "updates remain unsupported. Numeric values use full storage ",
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
        "slots. Coupled progression, completion, inventory and location ",
        "updates remain unsupported. Numeric values use full storage ",
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
