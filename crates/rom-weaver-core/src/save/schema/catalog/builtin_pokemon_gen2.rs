use super::*;

fn extend_fields(
    fields: &mut Vec<FieldDefinition>,
    scope: &FieldScope,
    repetition: Repetition,
    build: fn(&FieldScope) -> Vec<FieldDefinition>,
) {
    for item in 0..repetition.count {
        let number = item + repetition.start;
        let index = format!("{number:0width$}", width = repetition.width);
        let mut child = FieldScope {
            base: scope.base + scope.bits / 8 + repetition.base,
            bits: item * repetition.stride,
            bit_stride: repetition.bit_stride,
            index,
            ordinal: item + 1,
            prefix: String::new(),
            group: scope.group.clone(),
            guards: scope.guards.clone(),
        };
        child.prefix = scope.id(repetition.prefix);
        fields.extend(build(&child));
    }
}

fn extend_guarded_fields(
    fields: &mut Vec<FieldDefinition>,
    scope: &FieldScope,
    repetition: Repetition,
    count_offset: usize,
    build: fn(&FieldScope) -> Vec<FieldDefinition>,
) {
    let capacity = repetition.count;
    for item in 0..capacity {
        let number = item + repetition.start;
        let index = format!("{number:0width$}", width = repetition.width);
        let mut child = FieldScope {
            base: scope.base + scope.bits / 8 + repetition.base,
            bits: item * repetition.stride,
            bit_stride: repetition.bit_stride,
            index,
            ordinal: item + 1,
            prefix: scope.id(repetition.prefix),
            group: scope.group.clone(),
            guards: scope.guards.clone(),
        };
        child.guards.push(field::ArrayGuard {
            count: rules::Scalar {
                offset: count_offset,
                storage: Storage::U8,
                mask: None,
            },
            index: item,
            capacity,
        });
        fields.extend(build(&child));
    }
}

fn text_speed() -> Vec<FieldChoice> {
    choices(&[("fast", 1), ("medium", 3), ("slow", 5)])
}

fn sound() -> Vec<FieldChoice> {
    choices(&[("mono", 0), ("stereo", 1)])
}

fn gold_silver_header(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("trainer.name", "Trainer name", 8203, Storage::Ascii)
            .description(
                "Use { for the PK glyph and } for the MN glyph. Each uses one game character."
                    .into(),
            )
            .length(11)
            .text_codec("pokemon_gen2_english")
            .presentation(
                field::Presentation::new(0, 2)
                    .text_length(7)
                    .step(None)
                    .encoding(Some("pokemon_gen2_english")),
            ),
        scope
            .field("trainer.id", "Trainer ID", 8201, Storage::U16Be)
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 0).encoding(Some("big_endian_u16"))),
        scope
            .field("trainer.money", "Money", 9179, Storage::U24Be)
            .description("Money carried by the player".into())
            .min(0)
            .max(999999)
            .presentation(field::Presentation::new(0, 2).encoding(Some("big_endian_u24"))),
        scope
            .field("trainer.coins", "Coins", 9186, Storage::U16Be)
            .description("Coins carried by the player".into())
            .min(0)
            .max(9999)
            .presentation(field::Presentation::new(0, 9).encoding(Some("big_endian_u16"))),
        scope
            .field("trainer.stored_money", "Stored money", 9182, Storage::U24Be)
            .description("Money stored with the player's mother".into())
            .min(0)
            .max(999999)
            .presentation(field::Presentation::new(0, 5).encoding(Some("big_endian_u24"))),
        scope
            .field("trainer.play_time", "Play time", 8274, Storage::U8)
            .description("Time played".into())
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8275,
                                storage: Storage::U16Be,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 0,
                    },
                    field::FormatPart::Text(":".into()),
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8277,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                    field::FormatPart::Text(":".into()),
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8278,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                    field::FormatPart::Text(":".into()),
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8279,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(
                    field::Presentation::new(0, 73)
                        .constraints(SaveConstraint::default())
                        .kind(SaveFieldKind::ReadOnlyText)
                        .step(None)
                        .encoding(Some("pokemon_gen2_english"))
                        .warnings(vec!["Read-only".into()]),
                ),
                ..Default::default()
            }),
        scope
            .field("options.text_speed", "Text speed", 8192, Storage::U8)
            .description("Frames between text characters".into())
            .copies(vec![scope.offset(4608, 0)])
            .mask(7)
            .choices(text_speed())
            .presentation(
                field::Presentation::new(0, 8192)
                    .choices(vec!["fast".into(), "medium".into(), "slow".into()])
                    .step(None),
            ),
        scope
            .bit_field("options.battle_scene", "Battle scene", 8192, 7)
            .description("Show battle animations".into())
            .inverted(true)
            .copies(vec![scope.offset(4608, 7)])
            .presentation(
                field::Presentation::new(0, 8192)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
        scope
            .bit_field("options.battle_style", "Battle style", 8192, 6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true)
            .copies(vec![scope.offset(4608, 6)])
            .presentation(
                field::Presentation::new(0, 8192)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
        scope
            .field("options.sound", "Sound", 8192, Storage::U8)
            .description("Sound output mode".into())
            .copies(vec![scope.offset(4608, 0)])
            .mask(32)
            .choices(sound())
            .presentation(
                field::Presentation::new(0, 8192)
                    .choices(vec!["mono".into(), "stereo".into()])
                    .step(None),
            ),
        scope
            .field(
                "options.text_box_frame",
                "Text box frame",
                8194,
                Storage::U8,
            )
            .description("Text box border selection".into())
            .min(0)
            .max(7)
            .copies(vec![scope.offset(4610, 0)])
            .mask(7)
            .presentation(field::Presentation::new(0, 8194)),
        scope
            .field(
                "options.text_box_flags",
                "Text box flags",
                8195,
                Storage::U8,
            )
            .description("Text timing flags".into())
            .min(0)
            .max(255)
            .copies(vec![scope.offset(4611, 0)])
            .presentation(field::Presentation::new(0, 8195)),
        scope
            .field(
                "options.printer_brightness",
                "Printer brightness",
                8196,
                Storage::U8,
            )
            .description("Game Boy Printer brightness".into())
            .min(0)
            .max(127)
            .copies(vec![scope.offset(4612, 0)])
            .presentation(field::Presentation::new(0, 8196)),
        scope
            .field("options.menu_account", "Menu account", 8197, Storage::Bool)
            .description("Menu account option".into())
            .copies(vec![scope.offset(4613, 0)])
            .presentation(field::Presentation::new(0, 8197).step(None)),
        scope
            .field(
                "trainer.play_time.hours",
                "Play time hours",
                8275,
                Storage::U16Be,
            )
            .description("Hours played".into())
            .min(0)
            .max(999)
            .presentation(field::Presentation::new(0, 74)),
        scope
            .field(
                "trainer.play_time.minutes",
                "Play time minutes",
                8277,
                Storage::U8,
            )
            .description("Minutes played".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 76)),
        scope
            .field(
                "trainer.play_time.seconds",
                "Play time seconds",
                8278,
                Storage::U8,
            )
            .description("Seconds played".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 77)),
        scope
            .field(
                "trainer.play_time.frames",
                "Play time frames",
                8279,
                Storage::U8,
            )
            .description("Frames played".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 78)),
    ];

    fields
}

fn gold_silver_badges(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field("progress.badge_1", "Zephyr Badge", 9188, 0)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_2", "Hive Badge", 9188, 1)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_3", "Plain Badge", 9188, 2)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_4", "Fog Badge", 9188, 3)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_5", "Storm Badge", 9188, 4)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_6", "Mineral Badge", 9188, 5)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_7", "Glacier Badge", 9188, 6)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_8", "Rising Badge", 9188, 7)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 11).step(None)),
        scope
            .bit_field("progress.badge_9", "Boulder Badge", 9189, 0)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
        scope
            .bit_field("progress.badge_10", "Cascade Badge", 9189, 1)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
        scope
            .bit_field("progress.badge_11", "Thunder Badge", 9189, 2)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
        scope
            .bit_field("progress.badge_12", "Rainbow Badge", 9189, 3)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
        scope
            .bit_field("progress.badge_13", "Soul Badge", 9189, 4)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
        scope
            .bit_field("progress.badge_14", "Marsh Badge", 9189, 5)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
        scope
            .bit_field("progress.badge_15", "Volcano Badge", 9189, 6)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
        scope
            .bit_field("progress.badge_16", "Earth Badge", 9189, 7)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 12).step(None)),
    ];

    fields
}

fn gold_silver_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("progress.pokedex_owned_{index}", index = scope.index),
                &format!("Pokédex owned #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex owned flag".into())
            .presentation(field::Presentation::new(0, (10828 + scope.bits / 8) as u16).step(None)),
    ];

    fields
}

fn gold_silver_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("progress.pokedex_seen_{index}", index = scope.index),
                &format!("Pokédex seen #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex seen flag".into())
            .presentation(field::Presentation::new(0, (10860 + scope.bits / 8) as u16).step(None)),
    ];

    fields
}

fn gold_silver_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(20, 1, 0, 9248, 16, false, ""),
        9247,
        gold_silver_items_slot,
    );

    fields
}

fn gold_silver_key_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(25, 1, 0, 9290, 8, false, ""),
        9289,
        gold_silver_key_items_slot,
    );

    fields
}

fn gold_silver_balls(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(12, 1, 0, 9317, 16, false, ""),
        9316,
        gold_silver_balls_slot,
    );

    fields
}

fn gold_silver_pc(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(50, 1, 0, 0, 16, false, ""),
        9342,
        pc_slot,
    );

    fields
}

fn crystal_header(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("trainer.name", "Trainer name", 8203, Storage::Ascii)
            .description(
                "Use { for the PK glyph and } for the MN glyph. Each uses one game character."
                    .into(),
            )
            .length(11)
            .text_codec("pokemon_gen2_english")
            .presentation(
                field::Presentation::new(0, 2)
                    .text_length(7)
                    .step(None)
                    .encoding(Some("pokemon_gen2_english")),
            ),
        scope
            .field("trainer.id", "Trainer ID", 8201, Storage::U16Be)
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 0).encoding(Some("big_endian_u16"))),
        scope
            .field("trainer.money", "Money", 9180, Storage::U24Be)
            .description("Money carried by the player".into())
            .min(0)
            .max(999999)
            .presentation(field::Presentation::new(0, 979).encoding(Some("big_endian_u24"))),
        scope
            .field("trainer.coins", "Coins", 9187, Storage::U16Be)
            .description("Coins carried by the player".into())
            .min(0)
            .max(9999)
            .presentation(field::Presentation::new(0, 986).encoding(Some("big_endian_u16"))),
        scope
            .field("trainer.stored_money", "Stored money", 9183, Storage::U24Be)
            .description("Money stored with the player's mother".into())
            .min(0)
            .max(999999)
            .presentation(field::Presentation::new(0, 982).encoding(Some("big_endian_u24"))),
        scope
            .field("trainer.play_time", "Play time", 8273, Storage::U8)
            .description("Time played".into())
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8274,
                                storage: Storage::U16Be,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 0,
                    },
                    field::FormatPart::Text(":".into()),
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8276,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                    field::FormatPart::Text(":".into()),
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8277,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                    field::FormatPart::Text(":".into()),
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 8278,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(
                    field::Presentation::new(0, 72)
                        .constraints(SaveConstraint::default())
                        .kind(SaveFieldKind::ReadOnlyText)
                        .step(None)
                        .encoding(Some("pokemon_gen2_english"))
                        .warnings(vec!["Read-only".into()]),
                ),
                ..Default::default()
            }),
        scope
            .field("options.text_speed", "Text speed", 8192, Storage::U8)
            .description("Frames between text characters".into())
            .copies(vec![scope.offset(4608, 0)])
            .mask(7)
            .choices(text_speed())
            .presentation(
                field::Presentation::new(0, 8192)
                    .choices(vec!["fast".into(), "medium".into(), "slow".into()])
                    .step(None),
            ),
        scope
            .bit_field("options.battle_scene", "Battle scene", 8192, 7)
            .description("Show battle animations".into())
            .inverted(true)
            .copies(vec![scope.offset(4608, 7)])
            .presentation(
                field::Presentation::new(0, 8192)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
        scope
            .bit_field("options.battle_style", "Battle style", 8192, 6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true)
            .copies(vec![scope.offset(4608, 6)])
            .presentation(
                field::Presentation::new(0, 8192)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
        scope
            .field("options.sound", "Sound", 8192, Storage::U8)
            .description("Sound output mode".into())
            .copies(vec![scope.offset(4608, 0)])
            .mask(32)
            .choices(sound())
            .presentation(
                field::Presentation::new(0, 8192)
                    .choices(vec!["mono".into(), "stereo".into()])
                    .step(None),
            ),
        scope
            .field(
                "options.text_box_frame",
                "Text box frame",
                8194,
                Storage::U8,
            )
            .description("Text box border selection".into())
            .min(0)
            .max(7)
            .copies(vec![scope.offset(4610, 0)])
            .mask(7)
            .presentation(field::Presentation::new(0, 8194)),
        scope
            .field(
                "options.text_box_flags",
                "Text box flags",
                8195,
                Storage::U8,
            )
            .description("Text timing flags".into())
            .min(0)
            .max(255)
            .copies(vec![scope.offset(4611, 0)])
            .presentation(field::Presentation::new(0, 8195)),
        scope
            .field(
                "options.printer_brightness",
                "Printer brightness",
                8196,
                Storage::U8,
            )
            .description("Game Boy Printer brightness".into())
            .min(0)
            .max(127)
            .copies(vec![scope.offset(4612, 0)])
            .presentation(field::Presentation::new(0, 8196)),
        scope
            .field("options.menu_account", "Menu account", 8197, Storage::Bool)
            .description("Menu account option".into())
            .copies(vec![scope.offset(4613, 0)])
            .presentation(field::Presentation::new(0, 8197).step(None)),
        scope
            .field(
                "trainer.play_time.hours",
                "Play time hours",
                8274,
                Storage::U16Be,
            )
            .description("Hours played".into())
            .min(0)
            .max(999)
            .presentation(field::Presentation::new(0, 73)),
        scope
            .field(
                "trainer.play_time.minutes",
                "Play time minutes",
                8276,
                Storage::U8,
            )
            .description("Minutes played".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 75)),
        scope
            .field(
                "trainer.play_time.seconds",
                "Play time seconds",
                8277,
                Storage::U8,
            )
            .description("Seconds played".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 76)),
        scope
            .field(
                "trainer.play_time.frames",
                "Play time frames",
                8278,
                Storage::U8,
            )
            .description("Frames played".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 77)),
    ];

    fields
}

fn crystal_badges(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field("progress.badge_1", "Zephyr Badge", 9189, 0)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_2", "Hive Badge", 9189, 1)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_3", "Plain Badge", 9189, 2)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_4", "Fog Badge", 9189, 3)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_5", "Storm Badge", 9189, 4)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_6", "Mineral Badge", 9189, 5)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_7", "Glacier Badge", 9189, 6)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_8", "Rising Badge", 9189, 7)
            .description("Johto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 988).step(None)),
        scope
            .bit_field("progress.badge_9", "Boulder Badge", 9190, 0)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
        scope
            .bit_field("progress.badge_10", "Cascade Badge", 9190, 1)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
        scope
            .bit_field("progress.badge_11", "Thunder Badge", 9190, 2)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
        scope
            .bit_field("progress.badge_12", "Rainbow Badge", 9190, 3)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
        scope
            .bit_field("progress.badge_13", "Soul Badge", 9190, 4)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
        scope
            .bit_field("progress.badge_14", "Marsh Badge", 9190, 5)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
        scope
            .bit_field("progress.badge_15", "Volcano Badge", 9190, 6)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
        scope
            .bit_field("progress.badge_16", "Earth Badge", 9190, 7)
            .description("Kanto Gym Badge flag".into())
            .presentation(field::Presentation::new(0, 989).step(None)),
    ];

    fields
}

fn crystal_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("progress.pokedex_owned_{index}", index = scope.index),
                &format!("Pokédex owned #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex owned flag".into())
            .presentation(field::Presentation::new(0, (10791 + scope.bits / 8) as u16).step(None)),
    ];

    fields
}

fn crystal_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("progress.pokedex_seen_{index}", index = scope.index),
                &format!("Pokédex seen #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex seen flag".into())
            .presentation(field::Presentation::new(0, (10823 + scope.bits / 8) as u16).step(None)),
    ];

    fields
}

fn crystal_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(20, 1, 0, 9249, 16, false, ""),
        9248,
        crystal_items_slot,
    );

    fields
}

fn crystal_key_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(25, 1, 0, 9291, 8, false, ""),
        9290,
        crystal_key_items_slot,
    );

    fields
}

fn crystal_balls(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(12, 1, 0, 9318, 16, false, ""),
        9317,
        crystal_balls_slot,
    );

    fields
}

fn crystal_pc(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_guarded_fields(
        &mut fields,
        scope,
        Repetition::new(50, 1, 0, 1, 16, false, ""),
        9343,
        pc_slot,
    );

    fields
}

fn gold_silver_tm_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_fields(
        &mut fields,
        scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        gold_silver_tm_leading,
    );
    extend_fields(
        &mut fields,
        scope,
        Repetition::new(41, 10, 0, 9199, 8, false, ""),
        gold_silver_tm,
    );
    extend_fields(
        &mut fields,
        scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        gold_silver_hm,
    );

    fields
}

fn crystal_tm_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    extend_fields(
        &mut fields,
        scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_tm_leading,
    );
    extend_fields(
        &mut fields,
        scope,
        Repetition::new(41, 10, 0, 9200, 8, false, ""),
        crystal_tm,
    );
    extend_fields(
        &mut fields,
        scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_hm,
    );

    fields
}

fn pc_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.pc.{index}.item_id", index = scope.index),
                &format!("pc slot {index} item ID", index = scope.index),
                9343,
                Storage::U8,
            )
            .description("Inventory item identifier".into())
            .min(1)
            .max(255)
            .presentation(field::Presentation::new(0, (9343 + scope.bits / 8) as u16)),
        scope
            .field(
                &format!("inventory.pc.{index}.quantity", index = scope.index),
                &format!("pc slot {index} quantity", index = scope.index),
                9344,
                Storage::U8,
            )
            .description("Inventory item quantity".into())
            .min(1)
            .max(99)
            .presentation(field::Presentation::new(0, (9344 + scope.bits / 8) as u16)),
    ];

    fields
}

fn gold_silver_items_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.items.{index}.item_id", index = scope.index),
                &format!("items slot {index} item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item identifier".into())
            .min(1)
            .max(255)
            .presentation(field::Presentation::new(0, (9248 + scope.bits / 8) as u16)),
        scope
            .field(
                &format!("inventory.items.{index}.quantity", index = scope.index),
                &format!("items slot {index} quantity", index = scope.index),
                1,
                Storage::U8,
            )
            .description("Inventory item quantity".into())
            .min(1)
            .max(99)
            .presentation(field::Presentation::new(0, (9249 + scope.bits / 8) as u16)),
    ];

    fields
}

fn gold_silver_key_items_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.key_items.{index}.item_id", index = scope.index),
                &format!("key items slot {index} item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item identifier".into())
            .min(1)
            .max(255)
            .presentation(field::Presentation::new(0, (9290 + scope.bits / 8) as u16)),
    ];

    fields
}

fn gold_silver_balls_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.balls.{index}.item_id", index = scope.index),
                &format!("balls slot {index} item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item identifier".into())
            .min(1)
            .max(255)
            .presentation(field::Presentation::new(0, (9317 + scope.bits / 8) as u16)),
        scope
            .field(
                &format!("inventory.balls.{index}.quantity", index = scope.index),
                &format!("balls slot {index} quantity", index = scope.index),
                1,
                Storage::U8,
            )
            .description("Inventory item quantity".into())
            .min(1)
            .max(99)
            .presentation(field::Presentation::new(0, (9318 + scope.bits / 8) as u16)),
    ];

    fields
}

fn crystal_items_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.items.{index}.item_id", index = scope.index),
                &format!("items slot {index} item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item identifier".into())
            .min(1)
            .max(255)
            .presentation(field::Presentation::new(0, (9249 + scope.bits / 8) as u16)),
        scope
            .field(
                &format!("inventory.items.{index}.quantity", index = scope.index),
                &format!("items slot {index} quantity", index = scope.index),
                1,
                Storage::U8,
            )
            .description("Inventory item quantity".into())
            .min(1)
            .max(99)
            .presentation(field::Presentation::new(0, (9250 + scope.bits / 8) as u16)),
    ];

    fields
}

fn crystal_key_items_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.key_items.{index}.item_id", index = scope.index),
                &format!("key items slot {index} item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item identifier".into())
            .min(1)
            .max(255)
            .presentation(field::Presentation::new(0, (9291 + scope.bits / 8) as u16)),
    ];

    fields
}

fn crystal_balls_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.balls.{index}.item_id", index = scope.index),
                &format!("balls slot {index} item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item identifier".into())
            .min(1)
            .max(255)
            .presentation(field::Presentation::new(0, (9318 + scope.bits / 8) as u16)),
        scope
            .field(
                &format!("inventory.balls.{index}.quantity", index = scope.index),
                &format!("balls slot {index} quantity", index = scope.index),
                1,
                Storage::U8,
            )
            .description("Inventory item quantity".into())
            .min(1)
            .max(99)
            .presentation(field::Presentation::new(0, (9319 + scope.bits / 8) as u16)),
    ];

    fields
}

fn gold_silver_tm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.tm_hm.{index}.quantity", index = scope.index),
                &format!("TM{index} quantity", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, (9199 + scope.bits / 8) as u16)),
    ];

    fields
}

fn gold_silver_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "inventory.tm_hm.51.quantity",
                "HM01 quantity",
                9240,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9240)),
        scope
            .field(
                "inventory.tm_hm.52.quantity",
                "HM02 quantity",
                9241,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9241)),
        scope
            .field(
                "inventory.tm_hm.53.quantity",
                "HM03 quantity",
                9242,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9242)),
        scope
            .field(
                "inventory.tm_hm.54.quantity",
                "HM04 quantity",
                9243,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9243)),
        scope
            .field(
                "inventory.tm_hm.55.quantity",
                "HM05 quantity",
                9244,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9244)),
        scope
            .field(
                "inventory.tm_hm.56.quantity",
                "HM06 quantity",
                9245,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9245)),
        scope
            .field(
                "inventory.tm_hm.57.quantity",
                "HM07 quantity",
                9246,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9246)),
    ];

    fields
}

fn crystal_tm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.tm_hm.{index}.quantity", index = scope.index),
                &format!("TM{index} quantity", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, (9200 + scope.bits / 8) as u16)),
    ];

    fields
}

fn crystal_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "inventory.tm_hm.51.quantity",
                "HM01 quantity",
                9241,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9241)),
        scope
            .field(
                "inventory.tm_hm.52.quantity",
                "HM02 quantity",
                9242,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9242)),
        scope
            .field(
                "inventory.tm_hm.53.quantity",
                "HM03 quantity",
                9243,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9243)),
        scope
            .field(
                "inventory.tm_hm.54.quantity",
                "HM04 quantity",
                9244,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9244)),
        scope
            .field(
                "inventory.tm_hm.55.quantity",
                "HM05 quantity",
                9245,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9245)),
        scope
            .field(
                "inventory.tm_hm.56.quantity",
                "HM06 quantity",
                9246,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9246)),
        scope
            .field(
                "inventory.tm_hm.57.quantity",
                "HM07 quantity",
                9247,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9247)),
    ];

    fields
}

fn gold_silver_tm_leading(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "inventory.tm_hm.1.quantity",
                "TM01 quantity",
                9190,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9190)),
        scope
            .field(
                "inventory.tm_hm.2.quantity",
                "TM02 quantity",
                9191,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9191)),
        scope
            .field(
                "inventory.tm_hm.3.quantity",
                "TM03 quantity",
                9192,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9192)),
        scope
            .field(
                "inventory.tm_hm.4.quantity",
                "TM04 quantity",
                9193,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9193)),
        scope
            .field(
                "inventory.tm_hm.5.quantity",
                "TM05 quantity",
                9194,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9194)),
        scope
            .field(
                "inventory.tm_hm.6.quantity",
                "TM06 quantity",
                9195,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9195)),
        scope
            .field(
                "inventory.tm_hm.7.quantity",
                "TM07 quantity",
                9196,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9196)),
        scope
            .field(
                "inventory.tm_hm.8.quantity",
                "TM08 quantity",
                9197,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9197)),
        scope
            .field(
                "inventory.tm_hm.9.quantity",
                "TM09 quantity",
                9198,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9198)),
    ];

    fields
}

fn crystal_tm_leading(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "inventory.tm_hm.1.quantity",
                "TM01 quantity",
                9191,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9191)),
        scope
            .field(
                "inventory.tm_hm.2.quantity",
                "TM02 quantity",
                9192,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9192)),
        scope
            .field(
                "inventory.tm_hm.3.quantity",
                "TM03 quantity",
                9193,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9193)),
        scope
            .field(
                "inventory.tm_hm.4.quantity",
                "TM04 quantity",
                9194,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9194)),
        scope
            .field(
                "inventory.tm_hm.5.quantity",
                "TM05 quantity",
                9195,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9195)),
        scope
            .field(
                "inventory.tm_hm.6.quantity",
                "TM06 quantity",
                9196,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9196)),
        scope
            .field(
                "inventory.tm_hm.7.quantity",
                "TM07 quantity",
                9197,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9197)),
        scope
            .field(
                "inventory.tm_hm.8.quantity",
                "TM08 quantity",
                9198,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9198)),
        scope
            .field(
                "inventory.tm_hm.9.quantity",
                "TM09 quantity",
                9199,
                Storage::U8,
            )
            .description("Stored TM or HM quantity".into())
            .min(0)
            .max(99)
            .presentation(field::Presentation::new(0, 9199)),
    ];

    fields
}

fn default() -> GameDefinition {
    {
        let mut fields = vec![];
        let scope = FieldScope::default();
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            gold_silver_header,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            gold_silver_badges,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(251, 1, 3, 10828, 1, true, ""),
            gold_silver_owned,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(251, 1, 3, 10860, 1, true, ""),
            gold_silver_seen,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            gold_silver_tm_hm,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            gold_silver_items,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            gold_silver_key_items,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            gold_silver_balls,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            gold_silver_pc,
        );
        GameDefinition {
            fields,
            description: "English 32 KiB SRAM layout with primary and backup save copies.".into(),
            runtime: runtime::Runtime {
                family: Some("pokemon-gen2-gs".into()),
                handler_id: Some("pokemon-gen2".into()),
                save_format: Some("game_boy_sram_32k".into()),
                save_format_name: Some("Battery SRAM 32 KiB".into()),
                logical_size: Some(32768),
                layout: Some(layout::Layout {
                    groups: vec![layout::Group {
                        id: "save".into(),
                        logical_offset: 8201,
                        logical_length: 3424,
                        copies: layout::Copies::Fixed {
                            candidates: vec![
                                layout::Candidate {
                                    spans: vec![layout::Span {
                                        logical_offset: 8201,
                                        physical_offset: 8201,
                                        length: 3424,
                                    }],
                                    signatures: vec![
                                        layout::Signature {
                                            offset: 8200,
                                            bytes: vec![99],
                                        },
                                        layout::Signature {
                                            offset: 11627,
                                            bytes: vec![127],
                                        },
                                    ],
                                    checksums: vec![ChecksumDefinition {
                                        start: Some(8201),
                                        length: Some(3424),
                                        ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 11625)
                                    }],
                                    repairs: vec![],
                                    predicates: vec![],
                                    sections: vec![layout::FixedSection {
                                        id: 0,
                                        physical_offset: 8201,
                                        checksum: ChecksumDefinition {
                                            start: Some(8201),
                                            length: Some(3424),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Add16Le,
                                                11625,
                                            )
                                        },
                                        signature: None,
                                        counter: None,
                                    }],
                                    ..Default::default()
                                },
                                layout::Candidate {
                                    spans: vec![
                                        layout::Span {
                                            logical_offset: 8201,
                                            physical_offset: 5575,
                                            length: 550,
                                        },
                                        layout::Span {
                                            logical_offset: 8751,
                                            physical_offset: 15766,
                                            length: 426,
                                        },
                                        layout::Span {
                                            logical_offset: 9177,
                                            physical_offset: 3179,
                                            length: 1149,
                                        },
                                        layout::Span {
                                            logical_offset: 10326,
                                            physical_offset: 4328,
                                            length: 1247,
                                        },
                                        layout::Span {
                                            logical_offset: 11573,
                                            physical_offset: 32313,
                                            length: 52,
                                        },
                                    ],
                                    signatures: vec![
                                        layout::Signature {
                                            offset: 32312,
                                            bytes: vec![99],
                                        },
                                        layout::Signature {
                                            offset: 32367,
                                            bytes: vec![127],
                                        },
                                    ],
                                    checksums: vec![ChecksumDefinition {
                                        spans: vec![
                                            ChecksumSpan {
                                                start: 4328,
                                                length: 1247,
                                            },
                                            ChecksumSpan {
                                                start: 3179,
                                                length: 1149,
                                            },
                                            ChecksumSpan {
                                                start: 5575,
                                                length: 550,
                                            },
                                            ChecksumSpan {
                                                start: 15766,
                                                length: 426,
                                            },
                                            ChecksumSpan {
                                                start: 32313,
                                                length: 52,
                                            },
                                        ],
                                        ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 32365)
                                    }],
                                    repairs: vec![],
                                    predicates: vec![],
                                    sections: vec![layout::FixedSection {
                                        id: 1,
                                        physical_offset: 4328,
                                        checksum: ChecksumDefinition {
                                            spans: vec![
                                                ChecksumSpan {
                                                    start: 4328,
                                                    length: 1247,
                                                },
                                                ChecksumSpan {
                                                    start: 3179,
                                                    length: 1149,
                                                },
                                                ChecksumSpan {
                                                    start: 5575,
                                                    length: 550,
                                                },
                                                ChecksumSpan {
                                                    start: 15766,
                                                    length: 426,
                                                },
                                                ChecksumSpan {
                                                    start: 32313,
                                                    length: 52,
                                                },
                                            ],
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Add16Le,
                                                32365,
                                            )
                                        },
                                        signature: None,
                                        counter: None,
                                    }],
                                    ..Default::default()
                                },
                            ],
                        },
                        selection: layout::Selection::FirstValid,
                        write: layout::WritePolicy::PatchAllValid,
                        empty: vec![0],
                        empty_if_no_signature: true,
                    }],
                }),
                recognition: Some(runtime::Recognition {
                    checks: Vec::new(),
                    reasons: vec![SaveRecognitionReason::ChecksumValid],
                    confidence: SaveRecognitionConfidence::High,
                    incomplete_confidence: None,
                    selected_reason: false,
                    empty_top_level_reasons: true,
                }),
                checks: {
                    let checks = vec![
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 9247,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (20i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((read_at(
                                    bytes,
                                    (9248i64)
                                        .checked_add(
                                            (rules::Scalar {
                                                offset: 9247,
                                                storage: Storage::U8,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                            .checked_mul(2i64)
                                            .ok_or_else(|| {
                                                invalid("save rule arithmetic is out of range")
                                            })?,
                                        )
                                        .ok_or_else(|| {
                                            invalid("save rule arithmetic is out of range")
                                        })?,
                                    Storage::U8,
                                )?) == (255i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 9289,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (25i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((read_at(
                                    bytes,
                                    (9290i64)
                                        .checked_add(
                                            (rules::Scalar {
                                                offset: 9289,
                                                storage: Storage::U8,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                            .checked_mul(1i64)
                                            .ok_or_else(|| {
                                                invalid("save rule arithmetic is out of range")
                                            })?,
                                        )
                                        .ok_or_else(|| {
                                            invalid("save rule arithmetic is out of range")
                                        })?,
                                    Storage::U8,
                                )?) == (255i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 9316,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (12i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((read_at(
                                    bytes,
                                    (9317i64)
                                        .checked_add(
                                            (rules::Scalar {
                                                offset: 9316,
                                                storage: Storage::U8,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                            .checked_mul(2i64)
                                            .ok_or_else(|| {
                                                invalid("save rule arithmetic is out of range")
                                            })?,
                                        )
                                        .ok_or_else(|| {
                                            invalid("save rule arithmetic is out of range")
                                        })?,
                                    Storage::U8,
                                )?) == (255i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 9342,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (50i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((read_at(
                                    bytes,
                                    (9343i64)
                                        .checked_add(
                                            (rules::Scalar {
                                                offset: 9342,
                                                storage: Storage::U8,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                            .checked_mul(2i64)
                                            .ok_or_else(|| {
                                                invalid("save rule arithmetic is out of range")
                                            })?,
                                        )
                                        .ok_or_else(|| {
                                            invalid("save rule arithmetic is out of range")
                                        })?,
                                    Storage::U8,
                                )?) == (255i64))
                            }),
                            code: "save_inventory".into(),
                            message: "the save contains an invalid inventory pocket".into(),
                            section_id: None,
                            warning: None,
                        },
                    ];
                    checks
                },
                after_edit: vec![rules::Store {
                    when: None,
                    destination: rules::Scalar {
                        offset: 8274,
                        storage: Storage::U8,
                        mask: Some(1),
                    },
                    value: rules::ReadValue::new(move |bytes| {
                        Ok(
                            if ((rules::Scalar {
                                offset: 8275,
                                storage: Storage::U16Be,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (999i64))
                                && ((rules::Scalar {
                                    offset: 8277,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (59i64))
                                && ((rules::Scalar {
                                    offset: 8278,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (59i64))
                                && ((rules::Scalar {
                                    offset: 8279,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (0i64))
                            {
                                1i64
                            } else {
                                0i64
                            },
                        )
                    }),
                }],
                recovery: Some(runtime::Recovery {
                    no_valid: runtime::Failure {
                        code: "save_checksum".into(),
                        message: "the save has no valid primary or backup data".into(),
                    },
                    incomplete: Some(runtime::RecoveryOutcome {
                        state: SaveIntegrityState::PartiallyRecoverable,
                        disable_editing: true,
                        issue: Some(runtime::Failure {
                            code: "redundant_slot_invalid".into(),
                            message: "One primary or backup save copy failed integrity checks"
                                .into(),
                        }),
                        warning: Some("One save copy is invalid; editing is disabled".into()),
                        field_warning: Some(
                            "Editing needs valid primary and backup save data".into(),
                        ),
                        edit_error: Some(runtime::Failure {
                            code: "save_integrity_partial".into(),
                            message: "normal edits need valid primary and backup save data".into(),
                        }),
                        parse_error: None,
                        section_id: false,
                    }),
                    damaged: Some(runtime::RecoveryOutcome {
                        state: SaveIntegrityState::PartiallyRecoverable,
                        disable_editing: true,
                        issue: Some(runtime::Failure {
                            code: "redundant_slot_invalid".into(),
                            message: "One primary or backup save copy failed integrity checks"
                                .into(),
                        }),
                        warning: Some("One save copy is invalid; editing is disabled".into()),
                        field_warning: Some(
                            "Editing needs valid primary and backup save data".into(),
                        ),
                        edit_error: Some(runtime::Failure {
                            code: "save_integrity_partial".into(),
                            message: "normal edits need valid primary and backup save data".into(),
                        }),
                        parse_error: None,
                        section_id: false,
                    }),
                    unrecoverable: None,
                    differing: None,
                    active_group: false,
                    zero_counter: true,
                }),
                all_copy_sections: true,
                ..Default::default()
            },
            ..GameDefinition::new("".into(), "".into(), "game-boy-color".into(), 32768)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([(
        "pokemon_gen2_english".into(),
        text::TextCodec {
            unit: text::TextUnit::U8,
            max_chars: 7,
            max_units: Some(11),
            terminators: vec![80],
            skip: vec![],
            fill: 80,
            write_terminator: None,
            lane: None,
            mapping: text::TextMapping::Table {
                ranges: vec![
                    text::GlyphRange {
                        first: 'A',
                        last: 'Z',
                        first_code: 128,
                    },
                    text::GlyphRange {
                        first: 'a',
                        last: 'z',
                        first_code: 160,
                    },
                    text::GlyphRange {
                        first: '0',
                        last: '9',
                        first_code: 246,
                    },
                ],
                glyphs: BTreeMap::from([
                    (' ', 127),
                    ('(', 154),
                    (')', 155),
                    (':', 156),
                    (';', 157),
                    ('[', 158),
                    (']', 159),
                    ('Ä', 192),
                    ('Ö', 193),
                    ('Ü', 194),
                    ('ä', 195),
                    ('ö', 196),
                    ('ü', 197),
                    ('←', 223),
                    ('\'', 224),
                    ('{', 225),
                    ('}', 226),
                    ('-', 227),
                    ('?', 230),
                    ('!', 231),
                    ('.', 232),
                    ('&', 233),
                    ('é', 234),
                    ('→', 235),
                    ('♂', 239),
                    ('¥', 240),
                    ('×', 241),
                    ('/', 243),
                    (',', 244),
                    ('♀', 245),
                ]),
                aliases: BTreeMap::from([]),
            },
            decode_invalid: text::DecodeInvalid::Literal {
                template: "Unsupported Gen II character byte {code:#x}".into(),
            },
            missing_terminator: text::MissingTerminator::Literal {
                value: "Trainer name has no terminator".into(),
            },
            errors: text::TextErrors {
                decode_invalid: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the save has unsupported trainer text".into(),
                },
                encode_invalid: text::TextError {
                    code: "save_name_character".into(),
                    message: concat!(
                        "the requested name contains a character unsupported by the ",
                        "English save encoding"
                    )
                    .into(),
                },
                missing_terminator: text::TextError {
                    code: "save_text_codec".into(),
                    message: "Trainer name has no terminator".into(),
                },
                too_long: text::TextError {
                    code: "save_name_length".into(),
                    message: "the trainer name is longer than seven characters".into(),
                },
            },
            encode_transforms: vec![],
        },
    )]);

    let games = vec![
        game_pokemon_gold(),
        game_pokemon_silver(),
        game_pokemon_crystal(),
    ];

    build(games, codecs, false)
}

fn game_pokemon_gold() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-gold".into();
    game.name = "Pokémon Gold".into();
    game
}

fn game_pokemon_silver() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-silver".into();
    game.name = "Pokémon Silver".into();
    game
}

fn game_pokemon_crystal() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-crystal".into();
    game.name = "Pokémon Crystal".into();
    let mut fields = vec![];
    let scope = FieldScope::default();
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_header,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_badges,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(251, 1, 3, 10791, 1, true, ""),
        crystal_owned,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(251, 1, 3, 10823, 1, true, ""),
        crystal_seen,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_tm_hm,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_items,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_key_items,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_balls,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        crystal_pc,
    );
    game.fields = fields;
    game.runtime.family = Some("pokemon-gen2-crystal".into());
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "save".into(),
            logical_offset: 8201,
            logical_length: 2938,
            copies: layout::Copies::Fixed {
                candidates: vec![
                    layout::Candidate {
                        spans: vec![layout::Span {
                            logical_offset: 8201,
                            physical_offset: 8201,
                            length: 2938,
                        }],
                        signatures: vec![
                            layout::Signature {
                                offset: 8200,
                                bytes: vec![99],
                            },
                            layout::Signature {
                                offset: 11535,
                                bytes: vec![127],
                            },
                        ],
                        checksums: vec![ChecksumDefinition {
                            start: Some(8201),
                            length: Some(2938),
                            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 11533)
                        }],
                        repairs: vec![],
                        predicates: vec![],
                        sections: vec![layout::FixedSection {
                            id: 0,
                            physical_offset: 8201,
                            checksum: ChecksumDefinition {
                                start: Some(8201),
                                length: Some(2938),
                                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 11533)
                            },
                            signature: None,
                            counter: None,
                        }],
                        ..Default::default()
                    },
                    layout::Candidate {
                        spans: vec![layout::Span {
                            logical_offset: 8201,
                            physical_offset: 4617,
                            length: 2938,
                        }],
                        signatures: vec![
                            layout::Signature {
                                offset: 4616,
                                bytes: vec![99],
                            },
                            layout::Signature {
                                offset: 7951,
                                bytes: vec![127],
                            },
                        ],
                        checksums: vec![ChecksumDefinition {
                            start: Some(4617),
                            length: Some(2938),
                            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 7949)
                        }],
                        repairs: vec![],
                        predicates: vec![],
                        sections: vec![layout::FixedSection {
                            id: 1,
                            physical_offset: 4617,
                            checksum: ChecksumDefinition {
                                start: Some(4617),
                                length: Some(2938),
                                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 7949)
                            },
                            signature: None,
                            counter: None,
                        }],
                        ..Default::default()
                    },
                ],
            },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::PatchAllValid,
            empty: vec![0],
            empty_if_no_signature: true,
        }],
    });
    game.runtime.checks = {
        let checks = vec![
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 9248,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (20i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((read_at(
                        bytes,
                        (9249i64)
                            .checked_add(
                                (rules::Scalar {
                                    offset: 9248,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                .checked_mul(2i64)
                                .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                            )
                            .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                        Storage::U8,
                    )?) == (255i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 9290,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (25i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((read_at(
                        bytes,
                        (9291i64)
                            .checked_add(
                                (rules::Scalar {
                                    offset: 9290,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                .checked_mul(1i64)
                                .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                            )
                            .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                        Storage::U8,
                    )?) == (255i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 9317,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (12i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((read_at(
                        bytes,
                        (9318i64)
                            .checked_add(
                                (rules::Scalar {
                                    offset: 9317,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                .checked_mul(2i64)
                                .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                            )
                            .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                        Storage::U8,
                    )?) == (255i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 9343,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (50i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((read_at(
                        bytes,
                        (9344i64)
                            .checked_add(
                                (rules::Scalar {
                                    offset: 9343,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                .checked_mul(2i64)
                                .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                            )
                            .ok_or_else(|| invalid("save rule arithmetic is out of range"))?,
                        Storage::U8,
                    )?) == (255i64))
                }),
                code: "save_inventory".into(),
                message: "the save contains an invalid inventory pocket".into(),
                section_id: None,
                warning: None,
            },
        ];
        checks
    };
    game.runtime.after_edit = vec![rules::Store {
        when: None,
        destination: rules::Scalar {
            offset: 8273,
            storage: Storage::U8,
            mask: Some(1),
        },
        value: rules::ReadValue::new(move |bytes| {
            Ok(
                if ((rules::Scalar {
                    offset: 8274,
                    storage: Storage::U16Be,
                    mask: None,
                }
                .read(bytes)?)
                    == (999i64))
                    && ((rules::Scalar {
                        offset: 8276,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        == (59i64))
                    && ((rules::Scalar {
                        offset: 8277,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        == (59i64))
                    && ((rules::Scalar {
                        offset: 8278,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        == (0i64))
                {
                    1i64
                } else {
                    0i64
                },
            )
        }),
    }];
    game
}
