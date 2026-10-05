use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            catalog_field("slot_1.player_1.kremkoins", "Kremkoins", 19, Storage::U8),
            catalog_field(
                "slot_1.player_1.play_time",
                "Play-time ticks",
                14,
                Storage::U32Le,
            ),
            catalog_field(
                "slot_1.player_1.completion",
                "Completion percentage",
                18,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_1.hero_coins",
                "Hero's Coins",
                20,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_1.location",
                "Location code",
                189,
                Storage::U8,
            )
            .editable(false),
            catalog_field("slot_1.player_2.kremkoins", "Kremkoins", 353, Storage::U8),
            catalog_field(
                "slot_1.player_2.play_time",
                "Play-time ticks",
                348,
                Storage::U32Le,
            ),
            catalog_field(
                "slot_1.player_2.completion",
                "Completion percentage",
                352,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_2.hero_coins",
                "Hero's Coins",
                354,
                Storage::U8,
            )
            .editable(false),
            catalog_field(
                "slot_1.player_2.location",
                "Location code",
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
        catalog_field("slot_2.player_1.kremkoins", "Kremkoins", 699, Storage::U8),
        catalog_field(
            "slot_2.player_1.play_time",
            "Play-time ticks",
            694,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_2.player_1.completion",
            "Completion percentage",
            698,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_1.hero_coins",
            "Hero's Coins",
            700,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_1.location",
            "Location code",
            869,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_2.player_2.kremkoins", "Kremkoins", 1033, Storage::U8),
        catalog_field(
            "slot_2.player_2.play_time",
            "Play-time ticks",
            1028,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_2.player_2.completion",
            "Completion percentage",
            1032,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_2.hero_coins",
            "Hero's Coins",
            1034,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_2.player_2.location",
            "Location code",
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
        catalog_field("slot_3.player_1.kremkoins", "Kremkoins", 1379, Storage::U8),
        catalog_field(
            "slot_3.player_1.play_time",
            "Play-time ticks",
            1374,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_3.player_1.completion",
            "Completion percentage",
            1378,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_1.hero_coins",
            "Hero's Coins",
            1380,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_1.location",
            "Location code",
            1549,
            Storage::U8,
        )
        .editable(false),
        catalog_field("slot_3.player_2.kremkoins", "Kremkoins", 1713, Storage::U8),
        catalog_field(
            "slot_3.player_2.play_time",
            "Play-time ticks",
            1708,
            Storage::U32Le,
        ),
        catalog_field(
            "slot_3.player_2.completion",
            "Completion percentage",
            1712,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_2.hero_coins",
            "Hero's Coins",
            1714,
            Storage::U8,
        )
        .editable(false),
        catalog_field(
            "slot_3.player_2.location",
            "Location code",
            1883,
            Storage::U8,
        )
        .editable(false),
    ];
    game.fields = fields;
    game
}
