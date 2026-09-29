use super::*;

fn text_speed() -> Vec<FieldChoice> {
    choices(&[("fast", 1), ("medium", 3), ("slow", 5)])
}

fn red_blue_header(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("trainer.name", "Trainer name", 9624, Storage::Ascii)
            .description(
                "Use { for the PK glyph and } for the MN glyph. Each uses one game character."
                    .into(),
            )
            .length(11)
            .text_codec("pokemon_gen1_english")
            .presentation(
                field::Presentation::new(0, 9624)
                    .text_length(7)
                    .step(None)
                    .encoding(Some("pokemon_gen1_english")),
            ),
        scope
            .field("trainer.rival_name", "Rival name", 9718, Storage::Ascii)
            .description(
                "Use { for the PK glyph and } for the MN glyph. Each uses one game character."
                    .into(),
            )
            .length(11)
            .text_codec("pokemon_gen1_english")
            .presentation(
                field::Presentation::new(0, 9718)
                    .text_length(7)
                    .step(None)
                    .encoding(Some("pokemon_gen1_english")),
            ),
        scope
            .field("trainer.id", "Trainer ID", 9733, Storage::U16Be)
            .description("Public trainer identifier".into())
            .presentation(field::Presentation::new(0, 9733).range(0, 65535)),
        scope
            .field("trainer.money", "Money", 9715, Storage::BcdBe)
            .description("Money carried by the player".into())
            .length(3)
            .max(999999)
            .presentation(
                field::Presentation::new(0, 9715)
                    .range(0, 999999)
                    .encoding(Some("pokemon_gen1_bcd_be_u24")),
            ),
        scope
            .field("trainer.coins", "Coins", 10320, Storage::BcdBe)
            .description("Coins carried by the player".into())
            .length(2)
            .max(9999)
            .presentation(
                field::Presentation::new(0, 10320)
                    .range(0, 9999)
                    .encoding(Some("pokemon_gen1_bcd_be_u16")),
            ),
        scope
            .field("trainer.play_time", "Play time", 11501, Storage::U8)
            .description("Time played".into())
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 11501,
                                storage: Storage::U8,
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
                                offset: 11503,
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
                                offset: 11504,
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
                                offset: 11505,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(
                    field::Presentation::new(0, 11501)
                        .constraints(SaveConstraint::default())
                        .kind(SaveFieldKind::ReadOnlyText)
                        .step(None)
                        .encoding(Some("pokemon_gen1_english"))
                        .warnings(vec!["Read-only".into()]),
                ),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time.hours",
                "Play time hours",
                11501,
                Storage::U8,
            )
            .description("Hours played".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![rules::Store {
                    when: None,
                    destination: rules::Scalar {
                        offset: 11502,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: rules::ReadValue::new(move |bytes| {
                        Ok(
                            if (rules::Scalar {
                                offset: 11501,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (255i64)
                            {
                                255i64
                            } else {
                                0i64
                            },
                        )
                    }),
                }],
                presentation: Some(field::Presentation::new(0, 11501).range(0, 255)),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time.minutes",
                "Play time minutes",
                11503,
                Storage::U8,
            )
            .description("Minutes played".into())
            .max(59)
            .presentation(field::Presentation::new(0, 11503).range(0, 59)),
        scope
            .field(
                "trainer.play_time.seconds",
                "Play time seconds",
                11504,
                Storage::U8,
            )
            .description("Seconds played".into())
            .max(59)
            .presentation(field::Presentation::new(0, 11504).range(0, 59)),
        scope
            .field(
                "trainer.play_time.frames",
                "Play time frames",
                11505,
                Storage::U8,
            )
            .description("Frames played".into())
            .max(59)
            .presentation(field::Presentation::new(0, 11505).range(0, 59)),
        scope
            .field("options.text_speed", "Text speed", 9729, Storage::U8)
            .description("Text delay setting".into())
            .mask(7)
            .choices(text_speed())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                editable_when: Some(rules::Condition::new(move |bytes| {
                    Ok(((rules::Scalar {
                        offset: 9729,
                        storage: Storage::U8,
                        mask: Some(7),
                    }
                    .read(bytes)?)
                        == (1i64))
                        || ((rules::Scalar {
                            offset: 9729,
                            storage: Storage::U8,
                            mask: Some(7),
                        }
                        .read(bytes)?)
                            == (3i64))
                        || ((rules::Scalar {
                            offset: 9729,
                            storage: Storage::U8,
                            mask: Some(7),
                        }
                        .read(bytes)?)
                            == (5i64)))
                })),
                presentation: Some(
                    field::Presentation::new(0, 9729)
                        .choices(vec!["fast".into(), "medium".into(), "slow".into()])
                        .step(None),
                ),
                value_override: Some(field::ValueOverride {
                    when: rules::Condition::new(move |bytes| {
                        Ok(!(((rules::Scalar {
                            offset: 9729,
                            storage: Storage::U8,
                            mask: Some(7),
                        }
                        .read(bytes)?)
                            == (1i64))
                            || ((rules::Scalar {
                                offset: 9729,
                                storage: Storage::U8,
                                mask: Some(7),
                            }
                            .read(bytes)?)
                                == (3i64))
                            || ((rules::Scalar {
                                offset: 9729,
                                storage: Storage::U8,
                                mask: Some(7),
                            }
                            .read(bytes)?)
                                == (5i64))))
                    }),
                    value: SaveValue::Enum("unknown".into()),
                    read_only: true,
                    description: None,
                    warnings: None,
                }),
                ..Default::default()
            }),
        scope
            .bit_field("options.battle_scene", "Battle scene", 9729, 7)
            .description("Show battle animations".into())
            .inverted(true)
            .presentation(
                field::Presentation::new(0, 9729)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
        scope
            .bit_field("options.battle_style", "Battle style", 9729, 6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true)
            .presentation(
                field::Presentation::new(0, 9729)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
    ];

    fields
}

fn gen1_badges(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field("progress.badge_1", "Boulder Badge", 9730, 0)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
        scope
            .bit_field("progress.badge_2", "Cascade Badge", 9730, 1)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
        scope
            .bit_field("progress.badge_3", "Thunder Badge", 9730, 2)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
        scope
            .bit_field("progress.badge_4", "Rainbow Badge", 9730, 3)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
        scope
            .bit_field("progress.badge_5", "Soul Badge", 9730, 4)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
        scope
            .bit_field("progress.badge_6", "Marsh Badge", 9730, 5)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
        scope
            .bit_field("progress.badge_7", "Volcano Badge", 9730, 6)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
        scope
            .bit_field("progress.badge_8", "Earth Badge", 9730, 7)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 9730).step(None)),
    ];

    fields
}

fn gen1_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("progress.pokedex_owned_{index}", index = scope.index),
                &format!("Pokédex owned #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex owned flag".into())
            .presentation(field::Presentation::new(0, (9635 + scope.bits / 8) as u16).step(None)),
    ];

    fields
}

fn gen1_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                &format!("progress.pokedex_seen_{index}", index = scope.index),
                &format!("Pokédex seen #{index}", index = scope.index),
                0,
                0,
            )
            .description("Pokédex seen flag".into())
            .presentation(field::Presentation::new(0, (9654 + scope.bits / 8) as u16).step(None)),
    ];

    fields
}

fn gen1_bag(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    {
        for item in 0..20 {
            let number = item + 1;
            let index = format!("{number:00}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8 + 9674,
                bits: item * 16,
                bit_stride: false,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("");
            child.guards.push(field::ArrayGuard {
                count: rules::Scalar {
                    offset: 9673,
                    storage: Storage::U8,
                    mask: None,
                },
                index: item,
                capacity: 20,
            });
            fields.extend(gen1_bag_slot(&child));
        }
    }

    fields
}

fn gen1_pc(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = vec![];

    {
        for item in 0..50 {
            let number = item + 1;
            let index = format!("{number:00}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8 + 10215,
                bits: item * 16,
                bit_stride: false,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("");
            child.guards.push(field::ArrayGuard {
                count: rules::Scalar {
                    offset: 10214,
                    storage: Storage::U8,
                    mask: None,
                },
                index: item,
                capacity: 50,
            });
            fields.extend(gen1_pc_slot(&child));
        }
    }

    fields
}

fn red_blue_footer(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("storage.current_box", "Current PC box", 10316, Storage::U8)
            .description(
                "Current PC box number. Changing boxes requires moving their Pokémon data.".into(),
            )
            .max(11)
            .editable(false)
            .mask(127)
            .presentation(
                field::Presentation::new(0, 10316)
                    .kind(SaveFieldKind::UnsignedInteger)
                    .range(0, 11),
            ),
    ];

    fields
}

fn yellow_header(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("trainer.name", "Trainer name", 9624, Storage::Ascii)
            .description(
                "Use { for the PK glyph and } for the MN glyph. Each uses one game character."
                    .into(),
            )
            .length(11)
            .text_codec("pokemon_gen1_english")
            .presentation(
                field::Presentation::new(0, 9624)
                    .text_length(7)
                    .step(None)
                    .encoding(Some("pokemon_gen1_english")),
            ),
        scope
            .field("trainer.rival_name", "Rival name", 9718, Storage::Ascii)
            .description(
                "Use { for the PK glyph and } for the MN glyph. Each uses one game character."
                    .into(),
            )
            .length(11)
            .text_codec("pokemon_gen1_english")
            .presentation(
                field::Presentation::new(0, 9718)
                    .text_length(7)
                    .step(None)
                    .encoding(Some("pokemon_gen1_english")),
            ),
        scope
            .field("trainer.id", "Trainer ID", 9733, Storage::U16Be)
            .description("Public trainer identifier".into())
            .presentation(field::Presentation::new(0, 9733).range(0, 65535)),
        scope
            .field("trainer.money", "Money", 9715, Storage::BcdBe)
            .description("Money carried by the player".into())
            .length(3)
            .max(999999)
            .presentation(
                field::Presentation::new(0, 9715)
                    .range(0, 999999)
                    .encoding(Some("pokemon_gen1_bcd_be_u24")),
            ),
        scope
            .field("trainer.coins", "Coins", 10320, Storage::BcdBe)
            .description("Coins carried by the player".into())
            .length(2)
            .max(9999)
            .presentation(
                field::Presentation::new(0, 10320)
                    .range(0, 9999)
                    .encoding(Some("pokemon_gen1_bcd_be_u16")),
            ),
        scope
            .field("trainer.play_time", "Play time", 11501, Storage::U8)
            .description("Time played".into())
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 11501,
                                storage: Storage::U8,
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
                                offset: 11503,
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
                                offset: 11504,
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
                                offset: 11505,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(
                    field::Presentation::new(0, 11501)
                        .constraints(SaveConstraint::default())
                        .kind(SaveFieldKind::ReadOnlyText)
                        .step(None)
                        .encoding(Some("pokemon_gen1_english"))
                        .warnings(vec!["Read-only".into()]),
                ),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time.hours",
                "Play time hours",
                11501,
                Storage::U8,
            )
            .description("Hours played".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![rules::Store {
                    when: None,
                    destination: rules::Scalar {
                        offset: 11502,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: rules::ReadValue::new(move |bytes| {
                        Ok(
                            if (rules::Scalar {
                                offset: 11501,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (255i64)
                            {
                                255i64
                            } else {
                                0i64
                            },
                        )
                    }),
                }],
                presentation: Some(field::Presentation::new(0, 11501).range(0, 255)),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time.minutes",
                "Play time minutes",
                11503,
                Storage::U8,
            )
            .description("Minutes played".into())
            .max(59)
            .presentation(field::Presentation::new(0, 11503).range(0, 59)),
        scope
            .field(
                "trainer.play_time.seconds",
                "Play time seconds",
                11504,
                Storage::U8,
            )
            .description("Seconds played".into())
            .max(59)
            .presentation(field::Presentation::new(0, 11504).range(0, 59)),
        scope
            .field(
                "trainer.play_time.frames",
                "Play time frames",
                11505,
                Storage::U8,
            )
            .description("Frames played".into())
            .max(59)
            .presentation(field::Presentation::new(0, 11505).range(0, 59)),
        scope
            .field("options.text_speed", "Text speed", 9729, Storage::U8)
            .description("Text delay setting".into())
            .mask(7)
            .choices(text_speed())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                editable_when: Some(rules::Condition::new(move |bytes| {
                    Ok(((rules::Scalar {
                        offset: 9729,
                        storage: Storage::U8,
                        mask: Some(7),
                    }
                    .read(bytes)?)
                        == (1i64))
                        || ((rules::Scalar {
                            offset: 9729,
                            storage: Storage::U8,
                            mask: Some(7),
                        }
                        .read(bytes)?)
                            == (3i64))
                        || ((rules::Scalar {
                            offset: 9729,
                            storage: Storage::U8,
                            mask: Some(7),
                        }
                        .read(bytes)?)
                            == (5i64)))
                })),
                presentation: Some(
                    field::Presentation::new(0, 9729)
                        .choices(vec!["fast".into(), "medium".into(), "slow".into()])
                        .step(None),
                ),
                value_override: Some(field::ValueOverride {
                    when: rules::Condition::new(move |bytes| {
                        Ok(!(((rules::Scalar {
                            offset: 9729,
                            storage: Storage::U8,
                            mask: Some(7),
                        }
                        .read(bytes)?)
                            == (1i64))
                            || ((rules::Scalar {
                                offset: 9729,
                                storage: Storage::U8,
                                mask: Some(7),
                            }
                            .read(bytes)?)
                                == (3i64))
                            || ((rules::Scalar {
                                offset: 9729,
                                storage: Storage::U8,
                                mask: Some(7),
                            }
                            .read(bytes)?)
                                == (5i64))))
                    }),
                    value: SaveValue::Enum("unknown".into()),
                    read_only: true,
                    description: None,
                    warnings: None,
                }),
                ..Default::default()
            }),
        scope
            .bit_field("options.battle_scene", "Battle scene", 9729, 7)
            .description("Show battle animations".into())
            .inverted(true)
            .presentation(
                field::Presentation::new(0, 9729)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
        scope
            .bit_field("options.battle_style", "Battle style", 9729, 6)
            .description("Prompt before switching Pokémon".into())
            .inverted(true)
            .presentation(
                field::Presentation::new(0, 9729)
                    .kind(SaveFieldKind::Boolean)
                    .step(None),
            ),
        scope
            .field("options.sound", "Sound", 9729, Storage::U8)
            .description("Sound output mode".into())
            .choices(choices(&[
                ("mono", 0),
                ("earphone_1", 1),
                ("earphone_2", 2),
                ("earphone_3", 3),
            ]))
            .mask(48)
            .presentation(
                field::Presentation::new(0, 9729)
                    .choices(vec![
                        "mono".into(),
                        "earphone_1".into(),
                        "earphone_2".into(),
                        "earphone_3".into(),
                    ])
                    .step(None),
            ),
    ];

    fields
}

fn yellow_footer(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("storage.current_box", "Current PC box", 10316, Storage::U8)
            .description(
                "Current PC box number. Changing boxes requires moving their Pokémon data.".into(),
            )
            .max(11)
            .editable(false)
            .mask(127)
            .presentation(
                field::Presentation::new(0, 10316)
                    .kind(SaveFieldKind::UnsignedInteger)
                    .range(0, 11),
            ),
        scope
            .field(
                "yellow.pikachu_friendship",
                "Pikachu friendship",
                10012,
                Storage::U8,
            )
            .description("Yellow's starter Pikachu friendship".into())
            .presentation(field::Presentation::new(0, 10012).range(0, 255)),
        scope
            .field(
                "yellow.pikachu_beach_score",
                "Pikachu Beach score",
                10049,
                Storage::BcdLe,
            )
            .description("Pokémon Yellow Pikachu Beach high score".into())
            .length(2)
            .max(9999)
            .presentation(field::Presentation::new(0, 10049).range(0, 9999)),
        scope
            .field(
                "yellow.printer_brightness",
                "Printer brightness",
                10052,
                Storage::U8,
            )
            .description("Game Boy Printer brightness".into())
            .max(127)
            .presentation(field::Presentation::new(0, 10052).range(0, 127)),
    ];

    fields
}

fn gen1_bag_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.bag.{index}.item_id", index = scope.index),
                &format!("Bag slot {index} Item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item slot value".into())
            .min(1)
            .presentation(
                field::Presentation::new(0, (9674 + scope.bits / 8) as u16).range(1, 255),
            ),
        scope
            .field(
                &format!("inventory.bag.{index}.quantity", index = scope.index),
                &format!("Bag slot {index} Quantity", index = scope.index),
                1,
                Storage::U8,
            )
            .description("Inventory item slot value".into())
            .min(1)
            .max(99)
            .presentation(field::Presentation::new(0, (9675 + scope.bits / 8) as u16)),
    ];

    fields
}

fn gen1_pc_slot(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                &format!("inventory.pc.{index}.item_id", index = scope.index),
                &format!("PC slot {index} Item ID", index = scope.index),
                0,
                Storage::U8,
            )
            .description("Inventory item slot value".into())
            .min(1)
            .presentation(
                field::Presentation::new(0, (10215 + scope.bits / 8) as u16).range(1, 255),
            ),
        scope
            .field(
                &format!("inventory.pc.{index}.quantity", index = scope.index),
                &format!("PC slot {index} Quantity", index = scope.index),
                1,
                Storage::U8,
            )
            .description("Inventory item slot value".into())
            .min(1)
            .max(99)
            .presentation(field::Presentation::new(0, (10216 + scope.bits / 8) as u16)),
    ];

    fields
}

fn child_scope(
    base: usize,
    bits: usize,
    bit_stride: bool,
    index: String,
    ordinal: usize,
) -> FieldScope {
    FieldScope {
        base,
        bits,
        bit_stride,
        index,
        ordinal,
        ..Default::default()
    }
}

fn single_scope() -> FieldScope {
    child_scope(0, 0, false, "0".into(), 1)
}

fn gen1_fields(
    header: fn(&FieldScope) -> Vec<FieldDefinition>,
    footer: fn(&FieldScope) -> Vec<FieldDefinition>,
) -> Vec<FieldDefinition> {
    let mut fields = header(&single_scope());
    fields.extend(gen1_badges(&single_scope()));
    for item in 0..151 {
        fields.extend(gen1_owned(&child_scope(
            9635,
            item,
            true,
            format!("{:03}", item + 1),
            item + 1,
        )));
    }
    for item in 0..151 {
        fields.extend(gen1_seen(&child_scope(
            9654,
            item,
            true,
            format!("{:03}", item + 1),
            item + 1,
        )));
    }
    fields.extend(gen1_bag(&single_scope()));
    fields.extend(gen1_pc(&single_scope()));
    fields.extend(footer(&single_scope()));
    fields
}

fn default() -> GameDefinition {
    {
        let fields = gen1_fields(red_blue_header, red_blue_footer);
        GameDefinition {
            fields,
            description: "Pokémon Red, English 32 KiB SRAM.".into(),
            runtime: runtime::Runtime {
                family: Some("pokemon-gen1".into()),
                handler_id: Some("pokemon-gen1".into()),
                save_format: Some("game_boy_sram_32k".into()),
                save_format_name: Some("Battery SRAM 32 KiB".into()),
                logical_size: Some(32768),
                layout: Some(layout::Layout {
                    groups: vec![layout::Group {
                        id: "save".into(),
                        logical_offset: 9624,
                        logical_length: 3980,
                        copies: layout::Copies::Fixed {
                            candidates: vec![layout::Candidate {
                                spans: vec![layout::Span {
                                    logical_offset: 9624,
                                    physical_offset: 9624,
                                    length: 3980,
                                }],
                                checksums: vec![ChecksumDefinition {
                                    start: Some(9624),
                                    length: Some(3979),
                                    target: Some(255),
                                    ..ChecksumDefinition::new(ChecksumAlgorithm::Sum8, 13603)
                                }],
                                repairs: vec![],
                                predicates: vec![],
                                sections: vec![layout::FixedSection {
                                    id: 0,
                                    physical_offset: 9624,
                                    checksum: ChecksumDefinition {
                                        start: Some(9624),
                                        length: Some(3979),
                                        target: Some(255),
                                        ..ChecksumDefinition::new(ChecksumAlgorithm::Sum8, 13603)
                                    },
                                    signature: None,
                                    counter: None,
                                }],
                                ..Default::default()
                            }],
                        },
                        selection: layout::Selection::FirstValid,
                        write: layout::WritePolicy::Selected,
                        empty: vec![],
                        empty_if_no_signature: false,
                    }],
                }),
                recognition: Some(runtime::Recognition {
                    checks: {
                        let mut checks = vec![rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 9673,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (20i64))
                            }),
                            code: "save_layout".into(),
                            message:
                                "the save does not contain valid English inventory layout markers"
                                    .into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((read_at(
                                    bytes,
                                    (9674i64)
                                        .checked_add(
                                            (rules::Scalar {
                                                offset: 9673,
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
                            code: "save_layout".into(),
                            message:
                                "the save does not contain valid English inventory layout markers"
                                    .into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 10214,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (50i64))
                            }),
                            code: "save_layout".into(),
                            message:
                                "the save does not contain valid English inventory layout markers"
                                    .into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((read_at(
                                    bytes,
                                    (10215i64)
                                        .checked_add(
                                            (rules::Scalar {
                                                offset: 10214,
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
                            code: "save_layout".into(),
                            message:
                                "the save does not contain valid English inventory layout markers"
                                    .into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 10316,
                                    storage: Storage::U8,
                                    mask: Some(127),
                                }
                                .read(bytes)?)
                                    < (12i64))
                            }),
                            code: "save_layout".into(),
                            message:
                                "the save does not contain valid English inventory layout markers"
                                    .into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 9715,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (15i64))
                                    <= (9i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 9715,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (240i64))
                                    <= (144i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 9716,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (15i64))
                                    <= (9i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 9716,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (240i64))
                                    <= (144i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 9717,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (15i64))
                                    <= (9i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 9717,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (240i64))
                                    <= (144i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 10320,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (15i64))
                                    <= (9i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 10320,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (240i64))
                                    <= (144i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 10321,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (15i64))
                                    <= (9i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }, rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(((rules::Scalar {
                                    offset: 10321,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    & (240i64))
                                    <= (144i64))
                            }),
                            code: "save_bcd".into(),
                            message: "the save contains an invalid packed decimal value".into(),
                            section_id: None,
                            warning: None,
                        }];
                        for item in 0..3 {
                            let scope = FieldScope {
                                base: item,
                                ..Default::default()
                            };
                            checks.push(rules::Check {
                                when: None,
                                assert: {
                                    let address = scope.address();
                                    rules::Condition::new(move |bytes| {
                                        Ok((address
                                            .scalar(11503, Storage::U8, None)
                                            .read(bytes)?)
                                            <= (59i64))
                                    })
                                },
                                code: "save_play_time".into(),
                                message: "play time must use values below 60 and stop at 255:00:00"
                                    .into(),
                                section_id: None,
                                warning: None,
                            });
                        }
                        checks.push(rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((!((rules::Scalar {
                                    offset: 11501,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (255i64)))
                                    || (((rules::Scalar {
                                        offset: 11503,
                                        storage: Storage::U8,
                                        mask: None,
                                    }
                                    .read(bytes)?)
                                        == (0i64))
                                        && ((rules::Scalar {
                                            offset: 11504,
                                            storage: Storage::U8,
                                            mask: None,
                                        }
                                        .read(bytes)?)
                                            == (0i64))
                                        && ((rules::Scalar {
                                            offset: 11505,
                                            storage: Storage::U8,
                                            mask: None,
                                        }
                                        .read(bytes)?)
                                            == (0i64))))
                            }),
                            code: "save_play_time".into(),
                            message: "play time must use values below 60 and stop at 255:00:00"
                                .into(),
                            section_id: None,
                            warning: None,
                        });
                        checks.push(rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok(!(((rules::Scalar {
                                    offset: 10691,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (84i64))
                                    || (((rules::Scalar {
                                        offset: 10691,
                                        storage: Storage::U8,
                                        mask: None,
                                    }
                                    .read(bytes)?)
                                        == (0i64))
                                        && ((0i64)
                                            < (rules::Scalar {
                                                offset: 10012,
                                                storage: Storage::U8,
                                                mask: None,
                                            }
                                            .read(bytes)?)))))
                            }),
                            code: "save_game_mismatch".into(),
                            message: "game discriminator mismatch".into(),
                            section_id: None,
                            warning: None,
                        });
                        checks
                    },
                    reasons: vec![SaveRecognitionReason::ChecksumValid],
                    confidence: SaveRecognitionConfidence::High,
                    incomplete_confidence: None,
                    selected_reason: false,
                    empty_top_level_reasons: true,
                }),
                checks: {
                    let mut checks =
                        vec![rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 9673,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                <= (20i64))
                        }),
                        code: "save_layout".into(),
                        message: "the save does not contain valid English inventory layout markers"
                            .into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((read_at(
                                bytes,
                                (9674i64)
                                    .checked_add(
                                        (rules::Scalar {
                                            offset: 9673,
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
                        code: "save_layout".into(),
                        message: "the save does not contain valid English inventory layout markers"
                            .into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 10214,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                <= (50i64))
                        }),
                        code: "save_layout".into(),
                        message: "the save does not contain valid English inventory layout markers"
                            .into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((read_at(
                                bytes,
                                (10215i64)
                                    .checked_add(
                                        (rules::Scalar {
                                            offset: 10214,
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
                        code: "save_layout".into(),
                        message: "the save does not contain valid English inventory layout markers"
                            .into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 10316,
                                storage: Storage::U8,
                                mask: Some(127),
                            }
                            .read(bytes)?)
                                < (12i64))
                        }),
                        code: "save_layout".into(),
                        message: "the save does not contain valid English inventory layout markers"
                            .into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 9715,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (15i64))
                                <= (9i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 9715,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (240i64))
                                <= (144i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 9716,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (15i64))
                                <= (9i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 9716,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (240i64))
                                <= (144i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 9717,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (15i64))
                                <= (9i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 9717,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (240i64))
                                <= (144i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 10320,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (15i64))
                                <= (9i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 10320,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (240i64))
                                <= (144i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 10321,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (15i64))
                                <= (9i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }, rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(((rules::Scalar {
                                offset: 10321,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                & (240i64))
                                <= (144i64))
                        }),
                        code: "save_bcd".into(),
                        message: "the save contains an invalid packed decimal value".into(),
                        section_id: None,
                        warning: None,
                    }];
                    for item in 0..3 {
                        let scope = FieldScope {
                            base: item,
                            ..Default::default()
                        };
                        checks.push(rules::Check {
                            when: None,
                            assert: {
                                let address = scope.address();
                                rules::Condition::new(move |bytes| {
                                    Ok((address.scalar(11503, Storage::U8, None).read(bytes)?)
                                        <= (59i64))
                                })
                            },
                            code: "save_play_time".into(),
                            message: "play time must use values below 60 and stop at 255:00:00"
                                .into(),
                            section_id: None,
                            warning: None,
                        });
                    }
                    checks.push(rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((!((rules::Scalar {
                                offset: 11501,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (255i64)))
                                || (((rules::Scalar {
                                    offset: 11503,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (0i64))
                                    && ((rules::Scalar {
                                        offset: 11504,
                                        storage: Storage::U8,
                                        mask: None,
                                    }
                                    .read(bytes)?)
                                        == (0i64))
                                    && ((rules::Scalar {
                                        offset: 11505,
                                        storage: Storage::U8,
                                        mask: None,
                                    }
                                    .read(bytes)?)
                                        == (0i64))))
                        }),
                        code: "save_play_time".into(),
                        message: "play time must use values below 60 and stop at 255:00:00".into(),
                        section_id: None,
                        warning: None,
                    });
                    checks
                },
                document_checks: {
                    let checks = vec![rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok(!(((rules::Scalar {
                                offset: 10691,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (84i64))
                                || (((rules::Scalar {
                                    offset: 10691,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (0i64))
                                    && ((0i64)
                                        < (rules::Scalar {
                                            offset: 10012,
                                            storage: Storage::U8,
                                            mask: None,
                                        }
                                        .read(bytes)?)))))
                        }),
                        code: "save_game_mismatch".into(),
                        message: "the save contains the Pokémon Yellow starter marker".into(),
                        section_id: None,
                        warning: None,
                    }];
                    checks
                },
                recovery: Some(runtime::Recovery {
                    no_valid: runtime::Failure {
                        code: "save_checksum".into(),
                        message: "the save checksum is invalid".into(),
                    },
                    incomplete: None,
                    damaged: None,
                    unrecoverable: None,
                    differing: None,
                    active_group: false,
                    zero_counter: true,
                }),
                ..Default::default()
            },
            ..GameDefinition::new("".into(), "".into(), "game-boy".into(), 32768)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([("pokemon_gen1_english".into(),
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
 ranges: vec![text::GlyphRange {
 first: 'A',
 last: 'Z',
 first_code: 128 }
,
 text::GlyphRange {
 first: 'a',
 last: 'z',
 first_code: 160 }
,
 text::GlyphRange {
 first: '0',
 last: '9',
 first_code: 246 }
],
 glyphs: BTreeMap::from([(' ',
 127),
 ('(',
 154),
 (')',
 155),
 (':',
 156),
 (';',
 157),
 ('[',
 158),
 (']',
 159),
 ('é',
 186),
 ('\'',
 224),
 ('{',
 225),
 ('}',
 226),
 ('-',
 227),
 ('?',
 230),
 ('!',
 231),
 ('.',
 232),
 ('♂',
 239),
 ('¥',
 240),
 ('×',
 241),
 ('/',
 243),
 (',',
 244),
 ('♀',
 245)]),
 aliases: BTreeMap::from([]) }
,
 decode_invalid: text::DecodeInvalid::Literal {
 template: "Unsupported Gen I character byte {code:#x}".into() }
,
 missing_terminator: text::MissingTerminator::Accept,
 errors: text::TextErrors {
 decode_invalid: text::TextError {
 code: "save_text_codec".into(),
 message: "the save has unsupported trainer text".into() }
,
 encode_invalid: text::TextError {
 code: "save_name_character".into(),
 message: "the requested name contains a character unsupported by the English save encoding".into() }
,
 missing_terminator: text::TextError {
 code: "save_text_codec".into(),
 message: "Trainer name has no terminator".into() }
,
 too_long: text::TextError {
 code: "save_name_length".into(),
 message: "the trainer name is longer than seven characters".into() }
 }
,
 encode_transforms: vec![] }
)]);

    let games = vec![
        game_pokemon_red(),
        game_pokemon_blue(),
        game_pokemon_yellow(),
    ];

    build(games, codecs, false)
}

fn game_pokemon_red() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-red".into();
    game.name = "Pokémon Red".into();
    game
}

fn game_pokemon_blue() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-blue".into();
    game.name = "Pokémon Blue".into();
    game.description = "Pokémon Blue, English 32 KiB SRAM.".into();
    game
}

fn yellow_marker_check(message: &str) -> rules::Check {
    rules::Check {
        when: None,
        assert: rules::Condition::new(move |bytes| {
            Ok((rules::Scalar {
                offset: 10691,
                storage: Storage::U8,
                mask: None,
            }
            .read(bytes)?
                == 84)
                || ((rules::Scalar {
                    offset: 10691,
                    storage: Storage::U8,
                    mask: None,
                }
                .read(bytes)?
                    == 0)
                    && (rules::Scalar {
                        offset: 10012,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?
                        > 0)))
        }),
        code: "save_game_mismatch".into(),
        message: message.into(),
        section_id: None,
        warning: None,
    }
}

fn game_pokemon_yellow() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-yellow".into();
    game.name = "Pokémon Yellow".into();
    game.description = "Pokémon Yellow, English 32 KiB SRAM.".into();
    game.fields = gen1_fields(yellow_header, yellow_footer);
    let recognition = game.runtime.recognition.as_mut().unwrap();
    recognition.checks.pop();
    recognition
        .checks
        .push(yellow_marker_check("game discriminator mismatch"));
    game.runtime.document_checks = vec![yellow_marker_check(
        "the save does not contain the Pokémon Yellow starter marker",
    )];
    game
}
