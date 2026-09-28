use super::*;

fn owned_1(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                format!("pokedex_owned_{index}", index = scope.index),
                format!("Pokédex owned #{index}", index = scope.index),
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
                format!("pokedex_seen_{index}", index = scope.index),
                format!("Pokédex seen #{index}", index = scope.index),
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
            FieldDefinition::new(
                "trainer.id".into(),
                "Trainer ID".into(),
                9733,
                Storage::U16Be,
            )
            .description("Public trainer identifier".into()),
            FieldDefinition::new("trainer.money".into(), "Money".into(), 9715, Storage::BcdBe)
                .description("Money carried by the player".into())
                .length(3),
            FieldDefinition::new(
                "trainer.coins".into(),
                "Coins".into(),
                10320,
                Storage::BcdBe,
            )
            .description("Coins carried by the player".into())
            .length(2),
            FieldDefinition::new(
                "trainer.name_glyph_01".into(),
                "Trainer name glyph 1".into(),
                9624,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_02".into(),
                "Trainer name glyph 2".into(),
                9625,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_03".into(),
                "Trainer name glyph 3".into(),
                9626,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_04".into(),
                "Trainer name glyph 4".into(),
                9627,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_05".into(),
                "Trainer name glyph 5".into(),
                9628,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_06".into(),
                "Trainer name glyph 6".into(),
                9629,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_07".into(),
                "Trainer name glyph 7".into(),
                9630,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_08".into(),
                "Trainer name glyph 8".into(),
                9631,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_09".into(),
                "Trainer name glyph 9".into(),
                9632,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_10".into(),
                "Trainer name glyph 10".into(),
                9633,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.name_glyph_11".into(),
                "Trainer name glyph 11".into(),
                9634,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_01".into(),
                "Rival name glyph 1".into(),
                9718,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_02".into(),
                "Rival name glyph 2".into(),
                9719,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_03".into(),
                "Rival name glyph 3".into(),
                9720,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_04".into(),
                "Rival name glyph 4".into(),
                9721,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_05".into(),
                "Rival name glyph 5".into(),
                9722,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_06".into(),
                "Rival name glyph 6".into(),
                9723,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_07".into(),
                "Rival name glyph 7".into(),
                9724,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_08".into(),
                "Rival name glyph 8".into(),
                9725,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_09".into(),
                "Rival name glyph 9".into(),
                9726,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_10".into(),
                "Rival name glyph 10".into(),
                9727,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "trainer.rival_name_glyph_11".into(),
                "Rival name glyph 11".into(),
                9728,
                Storage::U8,
            )
            .description(
                "Raw English Generation I character code; 0x50 terminates the name".into(),
            ),
            FieldDefinition::new(
                "options.text_speed".into(),
                "Text speed".into(),
                9729,
                Storage::U8,
            )
            .description("Text delay; changing it preserves the other option bits".into())
            .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
            .mask(7),
            FieldDefinition::new(
                "options.battle_scene".into(),
                "Battle scene".into(),
                9729,
                Storage::Bit,
            )
            .bit(7)
            .description("Show battle animations".into())
            .inverted(true),
            FieldDefinition::new(
                "options.battle_style".into(),
                "Battle style".into(),
                9729,
                Storage::Bit,
            )
            .bit(6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true),
            FieldDefinition::new(
                "trainer.play_time.hours".into(),
                "Play time hours".into(),
                11501,
                Storage::U8,
            )
            .description("Hours played".into()),
            FieldDefinition::new(
                "trainer.play_time.minutes".into(),
                "Play time minutes".into(),
                11503,
                Storage::U8,
            )
            .description("Minutes played".into()),
            FieldDefinition::new(
                "trainer.play_time.seconds".into(),
                "Play time seconds".into(),
                11504,
                Storage::U8,
            )
            .description("Seconds played".into()),
            FieldDefinition::new(
                "trainer.play_time.frames".into(),
                "Play time frames".into(),
                11505,
                Storage::U8,
            )
            .description("Frames played".into()),
            FieldDefinition::new(
                "progress.badge_1".into(),
                "Gym badge 1".into(),
                9730,
                Storage::Bit,
            )
            .bit(0)
            .description("Gym badge flag".into()),
            FieldDefinition::new(
                "progress.badge_2".into(),
                "Gym badge 2".into(),
                9730,
                Storage::Bit,
            )
            .bit(1)
            .description("Gym badge flag".into()),
            FieldDefinition::new(
                "progress.badge_3".into(),
                "Gym badge 3".into(),
                9730,
                Storage::Bit,
            )
            .bit(2)
            .description("Gym badge flag".into()),
            FieldDefinition::new(
                "progress.badge_4".into(),
                "Gym badge 4".into(),
                9730,
                Storage::Bit,
            )
            .bit(3)
            .description("Gym badge flag".into()),
            FieldDefinition::new(
                "progress.badge_5".into(),
                "Gym badge 5".into(),
                9730,
                Storage::Bit,
            )
            .bit(4)
            .description("Gym badge flag".into()),
            FieldDefinition::new(
                "progress.badge_6".into(),
                "Gym badge 6".into(),
                9730,
                Storage::Bit,
            )
            .bit(5)
            .description("Gym badge flag".into()),
            FieldDefinition::new(
                "progress.badge_7".into(),
                "Gym badge 7".into(),
                9730,
                Storage::Bit,
            )
            .bit(6)
            .description("Gym badge flag".into()),
            FieldDefinition::new(
                "progress.badge_8".into(),
                "Gym badge 8".into(),
                9730,
                Storage::Bit,
            )
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
                "English 32 KiB SRAM layout. Packed-decimal, text, option, and ",
                "variable inventory fields remain with the native handler."
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
        FieldDefinition::new(
            "trainer.id".into(),
            "Trainer ID".into(),
            9733,
            Storage::U16Be,
        )
        .description("Public trainer identifier".into()),
        FieldDefinition::new("trainer.money".into(), "Money".into(), 9715, Storage::BcdBe)
            .description("Money carried by the player".into())
            .length(3),
        FieldDefinition::new(
            "trainer.coins".into(),
            "Coins".into(),
            10320,
            Storage::BcdBe,
        )
        .description("Coins carried by the player".into())
        .length(2),
        FieldDefinition::new(
            "trainer.name_glyph_01".into(),
            "Trainer name glyph 1".into(),
            9624,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_02".into(),
            "Trainer name glyph 2".into(),
            9625,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_03".into(),
            "Trainer name glyph 3".into(),
            9626,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_04".into(),
            "Trainer name glyph 4".into(),
            9627,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_05".into(),
            "Trainer name glyph 5".into(),
            9628,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_06".into(),
            "Trainer name glyph 6".into(),
            9629,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_07".into(),
            "Trainer name glyph 7".into(),
            9630,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_08".into(),
            "Trainer name glyph 8".into(),
            9631,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_09".into(),
            "Trainer name glyph 9".into(),
            9632,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_10".into(),
            "Trainer name glyph 10".into(),
            9633,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.name_glyph_11".into(),
            "Trainer name glyph 11".into(),
            9634,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_01".into(),
            "Rival name glyph 1".into(),
            9718,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_02".into(),
            "Rival name glyph 2".into(),
            9719,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_03".into(),
            "Rival name glyph 3".into(),
            9720,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_04".into(),
            "Rival name glyph 4".into(),
            9721,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_05".into(),
            "Rival name glyph 5".into(),
            9722,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_06".into(),
            "Rival name glyph 6".into(),
            9723,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_07".into(),
            "Rival name glyph 7".into(),
            9724,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_08".into(),
            "Rival name glyph 8".into(),
            9725,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_09".into(),
            "Rival name glyph 9".into(),
            9726,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_10".into(),
            "Rival name glyph 10".into(),
            9727,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "trainer.rival_name_glyph_11".into(),
            "Rival name glyph 11".into(),
            9728,
            Storage::U8,
        )
        .description("Raw English Generation I character code; 0x50 terminates the name".into()),
        FieldDefinition::new(
            "options.text_speed".into(),
            "Text speed".into(),
            9729,
            Storage::U8,
        )
        .description("Text delay; changing it preserves the other option bits".into())
        .choices(choices(&[("fast", 1), ("medium", 3), ("slow", 5)]))
        .mask(7),
        FieldDefinition::new(
            "options.battle_scene".into(),
            "Battle scene".into(),
            9729,
            Storage::Bit,
        )
        .bit(7)
        .description("Show battle animations".into())
        .inverted(true),
        FieldDefinition::new(
            "options.battle_style".into(),
            "Battle style".into(),
            9729,
            Storage::Bit,
        )
        .bit(6)
        .description("Prompt before switching Pokémon".into())
        .inverted(true),
        FieldDefinition::new(
            "trainer.play_time.hours".into(),
            "Play time hours".into(),
            11501,
            Storage::U8,
        )
        .description("Hours played".into()),
        FieldDefinition::new(
            "trainer.play_time.minutes".into(),
            "Play time minutes".into(),
            11503,
            Storage::U8,
        )
        .description("Minutes played".into()),
        FieldDefinition::new(
            "trainer.play_time.seconds".into(),
            "Play time seconds".into(),
            11504,
            Storage::U8,
        )
        .description("Seconds played".into()),
        FieldDefinition::new(
            "trainer.play_time.frames".into(),
            "Play time frames".into(),
            11505,
            Storage::U8,
        )
        .description("Frames played".into()),
        FieldDefinition::new(
            "progress.badge_1".into(),
            "Gym badge 1".into(),
            9730,
            Storage::Bit,
        )
        .bit(0)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "progress.badge_2".into(),
            "Gym badge 2".into(),
            9730,
            Storage::Bit,
        )
        .bit(1)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "progress.badge_3".into(),
            "Gym badge 3".into(),
            9730,
            Storage::Bit,
        )
        .bit(2)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "progress.badge_4".into(),
            "Gym badge 4".into(),
            9730,
            Storage::Bit,
        )
        .bit(3)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "progress.badge_5".into(),
            "Gym badge 5".into(),
            9730,
            Storage::Bit,
        )
        .bit(4)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "progress.badge_6".into(),
            "Gym badge 6".into(),
            9730,
            Storage::Bit,
        )
        .bit(5)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "progress.badge_7".into(),
            "Gym badge 7".into(),
            9730,
            Storage::Bit,
        )
        .bit(6)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "progress.badge_8".into(),
            "Gym badge 8".into(),
            9730,
            Storage::Bit,
        )
        .bit(7)
        .description("Gym badge flag".into()),
        FieldDefinition::new(
            "yellow.pikachu_friendship".into(),
            "Pikachu friendship".into(),
            10012,
            Storage::U8,
        )
        .description("Yellow's starter Pikachu friendship".into()),
        FieldDefinition::new(
            "yellow.printer_brightness".into(),
            "Printer brightness".into(),
            10052,
            Storage::U8,
        )
        .description("Game Boy Printer brightness".into()),
        FieldDefinition::new(
            "yellow.pikachu_beach_score".into(),
            "Pikachu Beach score".into(),
            10049,
            Storage::BcdLe,
        )
        .description("Pikachu Beach high score".into())
        .length(2),
        FieldDefinition::new(
            "options.sound_bit_0".into(),
            "Sound raw bit 0".into(),
            9729,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "options.sound_bit_1".into(),
            "Sound raw bit 1".into(),
            9729,
            Storage::Bit,
        )
        .bit(5),
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
