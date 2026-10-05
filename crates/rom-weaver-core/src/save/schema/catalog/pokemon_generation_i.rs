use super::*;

fn owned_1(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("pokedex_owned_{index}", index = scope.index),
                &format!("Pokédex owned #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex owned flag".into()),
    ];

    fields
}

fn seen_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("pokedex_seen_{index}", index = scope.index),
                &format!("Pokédex seen #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex seen flag".into()),
    ];

    fields
}

fn default() -> GameDefinition {
    {
        let mut fields = vec![
            catalog_field("trainer.id", "Trainer ID", 9733, Storage::U16Be)
                .description("Public trainer identifier".into()),
            catalog_field("trainer.money", "Money", 9715, Storage::BcdBe)
                .description("Money carried by the player".into())
                .length(3),
            catalog_field("trainer.coins", "Coins", 10320, Storage::BcdBe)
                .description("Coins carried by the player".into())
                .length(2),
            catalog_field(
                "trainer.name_glyph_01",
                "Trainer name glyph 1",
                9624,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_02",
                "Trainer name glyph 2",
                9625,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_03",
                "Trainer name glyph 3",
                9626,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_04",
                "Trainer name glyph 4",
                9627,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_05",
                "Trainer name glyph 5",
                9628,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_06",
                "Trainer name glyph 6",
                9629,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_07",
                "Trainer name glyph 7",
                9630,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_08",
                "Trainer name glyph 8",
                9631,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_09",
                "Trainer name glyph 9",
                9632,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_10",
                "Trainer name glyph 10",
                9633,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.name_glyph_11",
                "Trainer name glyph 11",
                9634,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_01",
                "Rival name glyph 1",
                9718,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_02",
                "Rival name glyph 2",
                9719,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_03",
                "Rival name glyph 3",
                9720,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_04",
                "Rival name glyph 4",
                9721,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_05",
                "Rival name glyph 5",
                9722,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_06",
                "Rival name glyph 6",
                9723,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_07",
                "Rival name glyph 7",
                9724,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_08",
                "Rival name glyph 8",
                9725,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_09",
                "Rival name glyph 9",
                9726,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_10",
                "Rival name glyph 10",
                9727,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field(
                "trainer.rival_name_glyph_11",
                "Rival name glyph 11",
                9728,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            catalog_field("options.text_speed", "Text speed", 9729, Storage::U8)
                .description("Text delay; changing it preserves the other option bits".into())
                .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
                .mask(7),
            catalog_field("options.battle_scene", "Battle scene", 9729, Storage::Bit)
                .bit(7)
                .description("Show battle animations".into())
                .inverted(true),
            catalog_field("options.battle_style", "Battle style", 9729, Storage::Bit)
                .bit(6)
                .description("Prompt before switching Pokémon".into())
                .inverted(true),
            catalog_field(
                "trainer.play_time.hours",
                "Play time hours",
                11501,
                Storage::U8,
            )
            .description("Hours played".into()),
            catalog_field(
                "trainer.play_time.minutes",
                "Play time minutes",
                11503,
                Storage::U8,
            )
            .description("Minutes played".into()),
            catalog_field(
                "trainer.play_time.seconds",
                "Play time seconds",
                11504,
                Storage::U8,
            )
            .description("Seconds played".into()),
            catalog_field(
                "trainer.play_time.frames",
                "Play time frames",
                11505,
                Storage::U8,
            )
            .description("Frames played".into()),
            catalog_field("progress.badge_1", "Gym badge 1", 9730, Storage::Bit)
                .bit(0)
                .description("Gym badge flag".into()),
            catalog_field("progress.badge_2", "Gym badge 2", 9730, Storage::Bit)
                .bit(1)
                .description("Gym badge flag".into()),
            catalog_field("progress.badge_3", "Gym badge 3", 9730, Storage::Bit)
                .bit(2)
                .description("Gym badge flag".into()),
            catalog_field("progress.badge_4", "Gym badge 4", 9730, Storage::Bit)
                .bit(3)
                .description("Gym badge flag".into()),
            catalog_field("progress.badge_5", "Gym badge 5", 9730, Storage::Bit)
                .bit(4)
                .description("Gym badge flag".into()),
            catalog_field("progress.badge_6", "Gym badge 6", 9730, Storage::Bit)
                .bit(5)
                .description("Gym badge flag".into()),
            catalog_field("progress.badge_7", "Gym badge 7", 9730, Storage::Bit)
                .bit(6)
                .description("Gym badge flag".into()),
            catalog_field("progress.badge_8", "Gym badge 8", 9730, Storage::Bit)
                .bit(7)
                .description("Gym badge flag".into()),
        ];
        let scope = FieldScope::default();
        {
            for item in 0..151 {
                let number = item + 1;
                let index = format!("{number:03}");
                let mut child = FieldScope {
                    base: scope.base + scope.bits / 8 + 9635,
                    bits: item,
                    bit_stride: true,
                    index,
                    ordinal: item + 1,
                    prefix: String::new(),
                    group: scope.group.clone(),
                    guards: scope.guards.clone(),
                };
                child.prefix = scope.id("progress");
                fields.extend(owned_1(&child));
            }
        }
        {
            for item in 0..151 {
                let number = item + 1;
                let index = format!("{number:03}");
                let mut child = FieldScope {
                    base: scope.base + scope.bits / 8 + 9654,
                    bits: item,
                    bit_stride: true,
                    index,
                    ordinal: item + 1,
                    prefix: String::new(),
                    group: scope.group.clone(),
                    guards: scope.guards.clone(),
                };
                child.prefix = scope.id("progress");
                fields.extend(seen_2(&child));
            }
        }
        GameDefinition {
            fields,
            description: concat!(
                "English 32 KiB SRAM layout. This profile exposes fixed fields. ",
                "Use the full game profile for variable inventory and text."
            )
            .into(),
            checksums: vec![ChecksumDefinition {
                start: Some(9624),
                length: Some(3979),
                target: Some(255),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Sum8, 13603)
            }],
            ..GameDefinition::new("".into(), "".into(), "game-boy".into(), 32768)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_pokemon_red_schema(),
        game_pokemon_blue_schema(),
        game_pokemon_yellow_schema(),
    ];

    build(games, codecs, true)
}

fn game_pokemon_red_schema() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-red-schema".into();
    game.name = "Pokémon Red (English schema)".into();
    game
}

fn game_pokemon_blue_schema() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-blue-schema".into();
    game.name = "Pokémon Blue (English schema)".into();
    game
}

fn game_pokemon_yellow_schema() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-yellow-schema".into();
    game.name = "Pokémon Yellow (English schema)".into();
    let mut fields = vec![
        catalog_field("trainer.id", "Trainer ID", 9733, Storage::U16Be)
            .description("Public trainer identifier".into()),
        catalog_field("trainer.money", "Money", 9715, Storage::BcdBe)
            .description("Money carried by the player".into())
            .length(3),
        catalog_field("trainer.coins", "Coins", 10320, Storage::BcdBe)
            .description("Coins carried by the player".into())
            .length(2),
        catalog_field(
            "trainer.name_glyph_01",
            "Trainer name glyph 1",
            9624,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_02",
            "Trainer name glyph 2",
            9625,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_03",
            "Trainer name glyph 3",
            9626,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_04",
            "Trainer name glyph 4",
            9627,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_05",
            "Trainer name glyph 5",
            9628,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_06",
            "Trainer name glyph 6",
            9629,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_07",
            "Trainer name glyph 7",
            9630,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_08",
            "Trainer name glyph 8",
            9631,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_09",
            "Trainer name glyph 9",
            9632,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_10",
            "Trainer name glyph 10",
            9633,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.name_glyph_11",
            "Trainer name glyph 11",
            9634,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_01",
            "Rival name glyph 1",
            9718,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_02",
            "Rival name glyph 2",
            9719,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_03",
            "Rival name glyph 3",
            9720,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_04",
            "Rival name glyph 4",
            9721,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_05",
            "Rival name glyph 5",
            9722,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_06",
            "Rival name glyph 6",
            9723,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_07",
            "Rival name glyph 7",
            9724,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_08",
            "Rival name glyph 8",
            9725,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_09",
            "Rival name glyph 9",
            9726,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_10",
            "Rival name glyph 10",
            9727,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field(
            "trainer.rival_name_glyph_11",
            "Rival name glyph 11",
            9728,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        catalog_field("options.text_speed", "Text speed", 9729, Storage::U8)
            .description("Text delay; changing it preserves the other option bits".into())
            .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
            .mask(7),
        catalog_field("options.battle_scene", "Battle scene", 9729, Storage::Bit)
            .bit(7)
            .description("Show battle animations".into())
            .inverted(true),
        catalog_field("options.battle_style", "Battle style", 9729, Storage::Bit)
            .bit(6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true),
        catalog_field(
            "trainer.play_time.hours",
            "Play time hours",
            11501,
            Storage::U8,
        )
        .description("Hours played".into()),
        catalog_field(
            "trainer.play_time.minutes",
            "Play time minutes",
            11503,
            Storage::U8,
        )
        .description("Minutes played".into()),
        catalog_field(
            "trainer.play_time.seconds",
            "Play time seconds",
            11504,
            Storage::U8,
        )
        .description("Seconds played".into()),
        catalog_field(
            "trainer.play_time.frames",
            "Play time frames",
            11505,
            Storage::U8,
        )
        .description("Frames played".into()),
        catalog_field("progress.badge_1", "Gym badge 1", 9730, Storage::Bit)
            .bit(0)
            .description("Gym badge flag".into()),
        catalog_field("progress.badge_2", "Gym badge 2", 9730, Storage::Bit)
            .bit(1)
            .description("Gym badge flag".into()),
        catalog_field("progress.badge_3", "Gym badge 3", 9730, Storage::Bit)
            .bit(2)
            .description("Gym badge flag".into()),
        catalog_field("progress.badge_4", "Gym badge 4", 9730, Storage::Bit)
            .bit(3)
            .description("Gym badge flag".into()),
        catalog_field("progress.badge_5", "Gym badge 5", 9730, Storage::Bit)
            .bit(4)
            .description("Gym badge flag".into()),
        catalog_field("progress.badge_6", "Gym badge 6", 9730, Storage::Bit)
            .bit(5)
            .description("Gym badge flag".into()),
        catalog_field("progress.badge_7", "Gym badge 7", 9730, Storage::Bit)
            .bit(6)
            .description("Gym badge flag".into()),
        catalog_field("progress.badge_8", "Gym badge 8", 9730, Storage::Bit)
            .bit(7)
            .description("Gym badge flag".into()),
        catalog_field(
            "yellow.pikachu_friendship",
            "Pikachu friendship",
            10012,
            Storage::U8,
        )
        .description("Yellow's starter Pikachu friendship".into()),
        catalog_field(
            "yellow.printer_brightness",
            "Printer brightness",
            10052,
            Storage::U8,
        )
        .description("Game Boy Printer brightness".into()),
        catalog_field(
            "yellow.pikachu_beach_score",
            "Pikachu Beach score",
            10049,
            Storage::BcdLe,
        )
        .description("Pikachu Beach high score".into())
        .length(2),
        catalog_field("options.sound_bit_0", "Sound raw bit 0", 9729, Storage::Bit).bit(4),
        catalog_field("options.sound_bit_1", "Sound raw bit 1", 9729, Storage::Bit).bit(5),
    ];
    let scope = FieldScope::default();
    {
        for item in 0..151 {
            let number = item + 1;
            let index = format!("{number:03}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8 + 9635,
                bits: item,
                bit_stride: true,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("progress");
            fields.extend(owned_1(&child));
        }
    }
    {
        for item in 0..151 {
            let number = item + 1;
            let index = format!("{number:03}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8 + 9654,
                bits: item,
                bit_stride: true,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("progress");
            fields.extend(seen_2(&child));
        }
    }
    game.fields = fields;
    game
}
