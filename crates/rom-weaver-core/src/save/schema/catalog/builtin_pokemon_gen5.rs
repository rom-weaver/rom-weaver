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

fn gender() -> Vec<FieldChoice> {
    choices(&[("male", 0), ("female", 1)])
}

fn trainer(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "trainer.name".into(),
                "Trainer Name".into(),
                103428,
                Storage::Ascii,
            )
            .description("Player trainer name".into())
            .length(16)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                text_codec: Some("pokemon_gen5_utf16le".into()),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: Some(7),
                        choices: vec![],
                    }),
                    step: Some(None),
                    encoding: Some(Some("utf16le".into())),
                    ..field::Presentation::new(27, 4)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.id".into(),
                "Trainer ID".into(),
                103444,
                Storage::U16Le,
            )
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 20)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.secret_id".into(),
                "Secret ID".into(),
                103446,
                Storage::U16Le,
            )
            .description("Secret trainer identifier".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 22)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.money".into(),
                "Money".into(),
                135680,
                Storage::U32Le,
            )
            .description("Current money".into())
            .min(0)
            .max(9999999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(52, 0)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.gender".into(),
                "Gender".into(),
                103457,
                Storage::U8,
            )
            .description("Player gender".into())
            .choices(gender())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["male".into(), "female".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(27, 33)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time_hours".into(),
                "Play Time Hours".into(),
                103460,
                Storage::U16Le,
            )
            .description("Recorded play-time hours".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 36)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time_minutes".into(),
                "Play Time Minutes".into(),
                103462,
                Storage::U8,
            )
            .description("Recorded play-time minutes".into())
            .min(0)
            .max(59)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 38)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time_seconds".into(),
                "Play Time Seconds".into(),
                103463,
                Storage::U8,
            )
            .description("Recorded play-time seconds".into())
            .min(0)
            .max(59)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 39)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.battle_points".into(),
                "Battle Points".into(),
                138496,
                Storage::U16Le,
            )
            .description("Battle Subway points".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(58, 0)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory items slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(632)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory items slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn key_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory key items slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(632)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1240 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory key items slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(1)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1242 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn tm_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory tm hm slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(632)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1572 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory tm hm slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(1)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1574 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn medicine(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory medicine slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(632)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2008 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory medicine slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2010 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn berries(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory berries slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(632)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2200 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory berries slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2202 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn badges(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field("progress.badge_1".into(), "Trio Badge".into(), 135684, 0)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_2".into(), "Basic Badge".into(), 135684, 1)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_3".into(), "Insect Badge".into(), 135684, 2)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_4".into(), "Bolt Badge".into(), 135684, 3)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_5".into(), "Quake Badge".into(), 135684, 4)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_6".into(), "Jet Badge".into(), 135684, 5)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_7".into(), "Freeze Badge".into(), 135684, 6)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_8".into(), "Legend Badge".into(), 135684, 7)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn trainer_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "trainer.name".into(),
                "Trainer Name".into(),
                103428,
                Storage::Ascii,
            )
            .description("Player trainer name".into())
            .length(16)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                text_codec: Some("pokemon_gen5_utf16le".into()),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: Some(7),
                        choices: vec![],
                    }),
                    step: Some(None),
                    encoding: Some(Some("utf16le".into())),
                    ..field::Presentation::new(27, 4)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.id".into(),
                "Trainer ID".into(),
                103444,
                Storage::U16Le,
            )
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 20)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.secret_id".into(),
                "Secret ID".into(),
                103446,
                Storage::U16Le,
            )
            .description("Secret trainer identifier".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 22)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.money".into(),
                "Money".into(),
                135424,
                Storage::U32Le,
            )
            .description("Current money".into())
            .min(0)
            .max(9999999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(52, 0)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.gender".into(),
                "Gender".into(),
                103457,
                Storage::U8,
            )
            .description("Player gender".into())
            .choices(gender())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["male".into(), "female".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(27, 33)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time_hours".into(),
                "Play Time Hours".into(),
                103460,
                Storage::U16Le,
            )
            .description("Recorded play-time hours".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 36)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time_minutes".into(),
                "Play Time Minutes".into(),
                103462,
                Storage::U8,
            )
            .description("Recorded play-time minutes".into())
            .min(0)
            .max(59)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 38)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.play_time_seconds".into(),
                "Play Time Seconds".into(),
                103463,
                Storage::U8,
            )
            .description("Recorded play-time seconds".into())
            .min(0)
            .max(59)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(27, 39)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.battle_points".into(),
                "Battle Points".into(),
                137984,
                Storage::U16Le,
            )
            .description("Battle Subway points".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(57, 0)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn items_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory items slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(638)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory items slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn key_items_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory key items slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(638)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1240 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory key items slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(1)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1242 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn tm_hm_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory tm hm slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(638)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1572 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory tm hm slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(1)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (1574 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn medicine_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory medicine slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(638)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2008 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory medicine slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2010 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn berries_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("slot_{index}.item_id", index = scope.index),
                format!(
                    "Inventory berries slot {ordinal} item",
                    ordinal = scope.ordinal
                ),
                0,
                Storage::U16Le,
            )
            .description("Inventory item identifier; zero marks an empty slot".into())
            .min(0)
            .max(638)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2200 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
        scope
            .field(
                format!("slot_{index}.quantity", index = scope.index),
                format!(
                    "Inventory berries slot {ordinal} quantity",
                    ordinal = scope.ordinal
                ),
                2,
                Storage::U16Le,
            )
            .description("Inventory item quantity".into())
            .min(0)
            .max(999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(25, (2202 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn badges_2(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field("progress.badge_1".into(), "Trio Badge".into(), 135428, 0)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_2".into(), "Basic Badge".into(), 135428, 1)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_3".into(), "Insect Badge".into(), 135428, 2)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_4".into(), "Bolt Badge".into(), 135428, 3)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_5".into(), "Quake Badge".into(), 135428, 4)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_6".into(), "Jet Badge".into(), 135428, 5)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_7".into(), "Freeze Badge".into(), 135428, 6)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_8".into(), "Legend Badge".into(), 135428, 7)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(52, 4)
                }),
                ..Default::default()
            }),
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
            trainer,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(261, 0, 0, 99328, 32, false, "inventory.items"),
            items,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(19, 0, 0, 100568, 32, false, "inventory.key_items"),
            key_items,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(105, 0, 0, 100900, 32, false, "inventory.tm_hm"),
            tm_hm,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(47, 0, 0, 101336, 32, false, "inventory.medicine"),
            medicine,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(64, 0, 0, 101528, 32, false, "inventory.berries"),
            berries,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            badges,
        );
        GameDefinition {
            fields,
            runtime: runtime::Runtime {
                family: Some("pokemon-gen5-bw".into()),
                handler_id: Some("pokemon-gen5".into()),
                save_format: Some("nintendo_ds_512k".into()),
                save_format_name: Some("Nintendo DS save 512 KiB".into()),
                logical_size: Some(524288),
                layout: Some(layout::Layout {
                    groups: vec![layout::Group {
                        id: "save".into(),
                        logical_offset: 0,
                        logical_length: 524288,
                        copies: layout::Copies::Fixed {
                            candidates: vec![layout::Candidate {
                                spans: vec![layout::Span {
                                    logical_offset: 0,
                                    physical_offset: 0,
                                    length: 524288,
                                }],
                                checksum_blocks: Some(layout::ChecksumBlocks {
                                    algorithm: ChecksumAlgorithm::Crc16CcittFalseLe,
                                    signature: Some(rules::Scalar {
                                        offset: 103455,
                                        storage: Storage::U8,
                                        mask: None,
                                    }),
                                    blocks: vec![
                                        layout::ChecksumBlock {
                                            start: 0,
                                            length: 992,
                                            offset: 994,
                                            mirror: Some(147200),
                                        },
                                        layout::ChecksumBlock {
                                            start: 1024,
                                            length: 4080,
                                            offset: 5106,
                                            mirror: Some(147202),
                                        },
                                        layout::ChecksumBlock {
                                            start: 5120,
                                            length: 4080,
                                            offset: 9202,
                                            mirror: Some(147204),
                                        },
                                        layout::ChecksumBlock {
                                            start: 9216,
                                            length: 4080,
                                            offset: 13298,
                                            mirror: Some(147206),
                                        },
                                        layout::ChecksumBlock {
                                            start: 13312,
                                            length: 4080,
                                            offset: 17394,
                                            mirror: Some(147208),
                                        },
                                        layout::ChecksumBlock {
                                            start: 17408,
                                            length: 4080,
                                            offset: 21490,
                                            mirror: Some(147210),
                                        },
                                        layout::ChecksumBlock {
                                            start: 21504,
                                            length: 4080,
                                            offset: 25586,
                                            mirror: Some(147212),
                                        },
                                        layout::ChecksumBlock {
                                            start: 25600,
                                            length: 4080,
                                            offset: 29682,
                                            mirror: Some(147214),
                                        },
                                        layout::ChecksumBlock {
                                            start: 29696,
                                            length: 4080,
                                            offset: 33778,
                                            mirror: Some(147216),
                                        },
                                        layout::ChecksumBlock {
                                            start: 33792,
                                            length: 4080,
                                            offset: 37874,
                                            mirror: Some(147218),
                                        },
                                        layout::ChecksumBlock {
                                            start: 37888,
                                            length: 4080,
                                            offset: 41970,
                                            mirror: Some(147220),
                                        },
                                        layout::ChecksumBlock {
                                            start: 41984,
                                            length: 4080,
                                            offset: 46066,
                                            mirror: Some(147222),
                                        },
                                        layout::ChecksumBlock {
                                            start: 46080,
                                            length: 4080,
                                            offset: 50162,
                                            mirror: Some(147224),
                                        },
                                        layout::ChecksumBlock {
                                            start: 50176,
                                            length: 4080,
                                            offset: 54258,
                                            mirror: Some(147226),
                                        },
                                        layout::ChecksumBlock {
                                            start: 54272,
                                            length: 4080,
                                            offset: 58354,
                                            mirror: Some(147228),
                                        },
                                        layout::ChecksumBlock {
                                            start: 58368,
                                            length: 4080,
                                            offset: 62450,
                                            mirror: Some(147230),
                                        },
                                        layout::ChecksumBlock {
                                            start: 62464,
                                            length: 4080,
                                            offset: 66546,
                                            mirror: Some(147232),
                                        },
                                        layout::ChecksumBlock {
                                            start: 66560,
                                            length: 4080,
                                            offset: 70642,
                                            mirror: Some(147234),
                                        },
                                        layout::ChecksumBlock {
                                            start: 70656,
                                            length: 4080,
                                            offset: 74738,
                                            mirror: Some(147236),
                                        },
                                        layout::ChecksumBlock {
                                            start: 74752,
                                            length: 4080,
                                            offset: 78834,
                                            mirror: Some(147238),
                                        },
                                        layout::ChecksumBlock {
                                            start: 78848,
                                            length: 4080,
                                            offset: 82930,
                                            mirror: Some(147240),
                                        },
                                        layout::ChecksumBlock {
                                            start: 82944,
                                            length: 4080,
                                            offset: 87026,
                                            mirror: Some(147242),
                                        },
                                        layout::ChecksumBlock {
                                            start: 87040,
                                            length: 4080,
                                            offset: 91122,
                                            mirror: Some(147244),
                                        },
                                        layout::ChecksumBlock {
                                            start: 91136,
                                            length: 4080,
                                            offset: 95218,
                                            mirror: Some(147246),
                                        },
                                        layout::ChecksumBlock {
                                            start: 95232,
                                            length: 4080,
                                            offset: 99314,
                                            mirror: Some(147248),
                                        },
                                        layout::ChecksumBlock {
                                            start: 99328,
                                            length: 2496,
                                            offset: 101826,
                                            mirror: Some(147250),
                                        },
                                        layout::ChecksumBlock {
                                            start: 101888,
                                            length: 1332,
                                            offset: 103222,
                                            mirror: Some(147252),
                                        },
                                        layout::ChecksumBlock {
                                            start: 103424,
                                            length: 104,
                                            offset: 103530,
                                            mirror: Some(147254),
                                        },
                                        layout::ChecksumBlock {
                                            start: 103680,
                                            length: 156,
                                            offset: 103838,
                                            mirror: Some(147256),
                                        },
                                        layout::ChecksumBlock {
                                            start: 103936,
                                            length: 4920,
                                            offset: 108858,
                                            mirror: Some(147258),
                                        },
                                        layout::ChecksumBlock {
                                            start: 109056,
                                            length: 1988,
                                            offset: 111046,
                                            mirror: Some(147260),
                                        },
                                        layout::ChecksumBlock {
                                            start: 111104,
                                            length: 3412,
                                            offset: 114518,
                                            mirror: Some(147262),
                                        },
                                        layout::ChecksumBlock {
                                            start: 114688,
                                            length: 44,
                                            offset: 114734,
                                            mirror: Some(147264),
                                        },
                                        layout::ChecksumBlock {
                                            start: 114944,
                                            length: 1624,
                                            offset: 116570,
                                            mirror: Some(147266),
                                        },
                                        layout::ChecksumBlock {
                                            start: 116736,
                                            length: 2708,
                                            offset: 119446,
                                            mirror: Some(147268),
                                        },
                                        layout::ChecksumBlock {
                                            start: 119552,
                                            length: 428,
                                            offset: 119982,
                                            mirror: Some(147270),
                                        },
                                        layout::ChecksumBlock {
                                            start: 120064,
                                            length: 1004,
                                            offset: 121070,
                                            mirror: Some(147272),
                                        },
                                        layout::ChecksumBlock {
                                            start: 121088,
                                            length: 92,
                                            offset: 121182,
                                            mirror: Some(147274),
                                        },
                                        layout::ChecksumBlock {
                                            start: 121344,
                                            length: 480,
                                            offset: 121826,
                                            mirror: Some(147276),
                                        },
                                        layout::ChecksumBlock {
                                            start: 121856,
                                            length: 168,
                                            offset: 122026,
                                            mirror: Some(147278),
                                        },
                                        layout::ChecksumBlock {
                                            start: 122112,
                                            length: 1120,
                                            offset: 123234,
                                            mirror: Some(147280),
                                        },
                                        layout::ChecksumBlock {
                                            start: 123392,
                                            length: 5120,
                                            offset: 128514,
                                            mirror: Some(147282),
                                        },
                                        layout::ChecksumBlock {
                                            start: 128768,
                                            length: 676,
                                            offset: 129446,
                                            mirror: Some(147284),
                                        },
                                        layout::ChecksumBlock {
                                            start: 129536,
                                            length: 732,
                                            offset: 130270,
                                            mirror: Some(147286),
                                        },
                                        layout::ChecksumBlock {
                                            start: 130304,
                                            length: 844,
                                            offset: 131150,
                                            mirror: Some(147288),
                                        },
                                        layout::ChecksumBlock {
                                            start: 131328,
                                            length: 1004,
                                            offset: 132334,
                                            mirror: Some(147290),
                                        },
                                        layout::ChecksumBlock {
                                            start: 132352,
                                            length: 248,
                                            offset: 132602,
                                            mirror: Some(147292),
                                        },
                                        layout::ChecksumBlock {
                                            start: 132608,
                                            length: 764,
                                            offset: 133374,
                                            mirror: Some(147294),
                                        },
                                        layout::ChecksumBlock {
                                            start: 133376,
                                            length: 148,
                                            offset: 133526,
                                            mirror: Some(147296),
                                        },
                                        layout::ChecksumBlock {
                                            start: 133632,
                                            length: 860,
                                            offset: 134494,
                                            mirror: Some(147298),
                                        },
                                        layout::ChecksumBlock {
                                            start: 134656,
                                            length: 460,
                                            offset: 135118,
                                            mirror: Some(147300),
                                        },
                                        layout::ChecksumBlock {
                                            start: 135168,
                                            length: 360,
                                            offset: 135530,
                                            mirror: Some(147302),
                                        },
                                        layout::ChecksumBlock {
                                            start: 135680,
                                            length: 236,
                                            offset: 135918,
                                            mirror: Some(147304),
                                        },
                                        layout::ChecksumBlock {
                                            start: 135936,
                                            length: 432,
                                            offset: 136370,
                                            mirror: Some(147306),
                                        },
                                        layout::ChecksumBlock {
                                            start: 136448,
                                            length: 28,
                                            offset: 136478,
                                            mirror: Some(147308),
                                        },
                                        layout::ChecksumBlock {
                                            start: 136704,
                                            length: 1236,
                                            offset: 137942,
                                            mirror: Some(147310),
                                        },
                                        layout::ChecksumBlock {
                                            start: 137984,
                                            length: 52,
                                            offset: 138038,
                                            mirror: Some(147312),
                                        },
                                        layout::ChecksumBlock {
                                            start: 138240,
                                            length: 60,
                                            offset: 138302,
                                            mirror: Some(147314),
                                        },
                                        layout::ChecksumBlock {
                                            start: 138496,
                                            length: 428,
                                            offset: 138926,
                                            mirror: Some(147316),
                                        },
                                        layout::ChecksumBlock {
                                            start: 139008,
                                            length: 2960,
                                            offset: 141970,
                                            mirror: Some(147318),
                                        },
                                        layout::ChecksumBlock {
                                            start: 142080,
                                            length: 156,
                                            offset: 142238,
                                            mirror: Some(147320),
                                        },
                                        layout::ChecksumBlock {
                                            start: 142336,
                                            length: 2128,
                                            offset: 144466,
                                            mirror: Some(147322),
                                        },
                                        layout::ChecksumBlock {
                                            start: 144640,
                                            length: 40,
                                            offset: 144682,
                                            mirror: Some(147324),
                                        },
                                        layout::ChecksumBlock {
                                            start: 144896,
                                            length: 644,
                                            offset: 145542,
                                            mirror: Some(147326),
                                        },
                                        layout::ChecksumBlock {
                                            start: 145664,
                                            length: 16,
                                            offset: 145682,
                                            mirror: Some(147328),
                                        },
                                        layout::ChecksumBlock {
                                            start: 145920,
                                            length: 92,
                                            offset: 146014,
                                            mirror: Some(147330),
                                        },
                                        layout::ChecksumBlock {
                                            start: 146176,
                                            length: 364,
                                            offset: 146542,
                                            mirror: Some(147332),
                                        },
                                        layout::ChecksumBlock {
                                            start: 146688,
                                            length: 64,
                                            offset: 146754,
                                            mirror: Some(147334),
                                        },
                                        layout::ChecksumBlock {
                                            start: 146944,
                                            length: 252,
                                            offset: 147198,
                                            mirror: Some(147336),
                                        },
                                        layout::ChecksumBlock {
                                            start: 147200,
                                            length: 140,
                                            offset: 147354,
                                            mirror: Some(147354),
                                        },
                                    ],
                                }),
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
                    checks: vec![rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 103455,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (21i64))
                        }),
                        code: "save_game_version".into(),
                        message: "the trainer data does not match the selected game".into(),
                        section_id: None,
                        warning: None,
                    }],
                    reasons: vec![
                        SaveRecognitionReason::ChecksumValid,
                        SaveRecognitionReason::SignatureValid,
                    ],
                    confidence: SaveRecognitionConfidence::High,
                    incomplete_confidence: None,
                    selected_reason: true,
                    empty_top_level_reasons: true,
                }),
                checks: {
                    let mut checks = vec![
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 103455,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (21i64))
                            }),
                            code: "save_game_version".into(),
                            message: "the trainer data does not match the selected game".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 103457,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (1i64))
                            }),
                            code: "save_gender".into(),
                            message: "the save has an invalid player gender value".into(),
                            section_id: None,
                            warning: None,
                        },
                    ];
                    for item in 0..2 {
                        let scope = FieldScope {
                            base: item,
                            ..Default::default()
                        };
                        checks.push(rules::Check {
                            when: None,
                            assert: {
                                let address = scope.address();
                                rules::Condition::new(move |bytes| {
                                    Ok((address.scalar(103462, Storage::U8, None).read(bytes)?)
                                        <= (59i64))
                                })
                            },
                            code: "save_play_time".into(),
                            message: "the save has an invalid play-time minute or second value"
                                .into(),
                            section_id: None,
                            warning: None,
                        });
                    }
                    checks.push(rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 135680,
                                storage: Storage::U32Le,
                                mask: None,
                            }
                            .read(bytes)?)
                                <= (9999999i64))
                        }),
                        code: "save_money".into(),
                        message: "the save has a money value above the game limit".into(),
                        section_id: None,
                        warning: None,
                    });
                    checks
                },
                recovery: Some(runtime::Recovery {
                    no_valid: runtime::Failure {
                        code: "save_checksum".into(),
                        message: "a Pokémon Generation V save block checksum is invalid".into(),
                    },
                    incomplete: None,
                    damaged: None,
                    unrecoverable: None,
                    differing: None,
                    active_group: false,
                    zero_counter: false,
                }),
                ..Default::default()
            },
            ..GameDefinition::new("".into(), "".into(), "nds".into(), 524288)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([(
        "pokemon_gen5_utf16le".into(),
        text::TextCodec {
            unit: text::TextUnit::U16Le,
            max_chars: 7,
            max_units: Some(7),
            terminators: vec![0, 65535],
            skip: vec![],
            fill: 0,
            write_terminator: Some(65535),
            lane: None,
            mapping: text::TextMapping::Unicode {
                decode_replacements: BTreeMap::from([("9325".into(), 9794), ("9326".into(), 9792)]),
            },
            decode_invalid: text::DecodeInvalid::Error,
            missing_terminator: text::MissingTerminator::Accept,
            errors: text::TextErrors {
                decode_invalid: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the save has invalid UTF-16 trainer text".into(),
                },
                encode_invalid: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the trainer name uses invalid UTF-16 text".into(),
                },
                missing_terminator: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the trainer name has no terminator".into(),
                },
                too_long: text::TextError {
                    code: "save_name_length".into(),
                    message: "the trainer name is longer than seven UTF-16 code units".into(),
                },
            },
            encode_transforms: vec![text::ConditionalReplacement {
                when_all: vec![
                    text::CodepointSet::Range { min: 0, max: 4095 },
                    text::CodepointSet::Range {
                        min: 57344,
                        max: 61439,
                    },
                    text::CodepointSet::Values {
                        values: vec![9792, 9794],
                    },
                ],
                replacements: BTreeMap::from([("9792".into(), 9326), ("9794".into(), 9325)]),
            }],
        },
    )]);

    let games = vec![
        game_pokemon_black(),
        game_pokemon_white(),
        game_pokemon_black_2(),
        game_pokemon_white_2(),
    ];

    build(games, codecs, false)
}

fn game_pokemon_black() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-black".into();
    game.name = "Pokémon Black".into();
    game
}

fn game_pokemon_white() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-white".into();
    game.name = "Pokémon White".into();
    game.runtime.recognition = Some(runtime::Recognition {
        checks: vec![rules::Check {
            when: None,
            assert: rules::Condition::new(move |bytes| {
                Ok((rules::Scalar {
                    offset: 103455,
                    storage: Storage::U8,
                    mask: None,
                }
                .read(bytes)?)
                    == (20i64))
            }),
            code: "save_game_version".into(),
            message: "the trainer data does not match the selected game".into(),
            section_id: None,
            warning: None,
        }],
        reasons: vec![
            SaveRecognitionReason::ChecksumValid,
            SaveRecognitionReason::SignatureValid,
        ],
        confidence: SaveRecognitionConfidence::High,
        incomplete_confidence: None,
        selected_reason: true,
        empty_top_level_reasons: true,
    });
    game.runtime.checks = {
        let mut checks = vec![
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 103455,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        == (20i64))
                }),
                code: "save_game_version".into(),
                message: "the trainer data does not match the selected game".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 103457,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (1i64))
                }),
                code: "save_gender".into(),
                message: "the save has an invalid player gender value".into(),
                section_id: None,
                warning: None,
            },
        ];
        for item in 0..2 {
            let scope = FieldScope {
                base: item,
                ..Default::default()
            };
            checks.push(rules::Check {
                when: None,
                assert: {
                    let address = scope.address();
                    rules::Condition::new(move |bytes| {
                        Ok((address.scalar(103462, Storage::U8, None).read(bytes)?) <= (59i64))
                    })
                },
                code: "save_play_time".into(),
                message: "the save has an invalid play-time minute or second value".into(),
                section_id: None,
                warning: None,
            });
        }
        checks.push(rules::Check {
            when: None,
            assert: rules::Condition::new(move |bytes| {
                Ok((rules::Scalar {
                    offset: 135680,
                    storage: Storage::U32Le,
                    mask: None,
                }
                .read(bytes)?)
                    <= (9999999i64))
            }),
            code: "save_money".into(),
            message: "the save has a money value above the game limit".into(),
            section_id: None,
            warning: None,
        });
        checks
    };
    game
}

fn game_pokemon_black_2() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-black-2".into();
    game.name = "Pokémon Black 2".into();
    let mut fields = vec![];
    let scope = FieldScope::default();
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        trainer_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(261, 0, 0, 99328, 32, false, "inventory.items"),
        items_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(27, 0, 0, 100568, 32, false, "inventory.key_items"),
        key_items_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(105, 0, 0, 100900, 32, false, "inventory.tm_hm"),
        tm_hm_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(47, 0, 0, 101336, 32, false, "inventory.medicine"),
        medicine_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(64, 0, 0, 101528, 32, false, "inventory.berries"),
        berries_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        badges_2,
    );
    game.fields = fields;
    game.runtime.family = Some("pokemon-gen5-b2w2".into());
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "save".into(),
            logical_offset: 0,
            logical_length: 524288,
            copies: layout::Copies::Fixed {
                candidates: vec![layout::Candidate {
                    spans: vec![layout::Span {
                        logical_offset: 0,
                        physical_offset: 0,
                        length: 524288,
                    }],
                    checksum_blocks: Some(layout::ChecksumBlocks {
                        algorithm: ChecksumAlgorithm::Crc16CcittFalseLe,
                        signature: Some(rules::Scalar {
                            offset: 103455,
                            storage: Storage::U8,
                            mask: None,
                        }),
                        blocks: vec![
                            layout::ChecksumBlock {
                                start: 0,
                                length: 992,
                                offset: 994,
                                mirror: Some(155392),
                            },
                            layout::ChecksumBlock {
                                start: 1024,
                                length: 4080,
                                offset: 5106,
                                mirror: Some(155394),
                            },
                            layout::ChecksumBlock {
                                start: 5120,
                                length: 4080,
                                offset: 9202,
                                mirror: Some(155396),
                            },
                            layout::ChecksumBlock {
                                start: 9216,
                                length: 4080,
                                offset: 13298,
                                mirror: Some(155398),
                            },
                            layout::ChecksumBlock {
                                start: 13312,
                                length: 4080,
                                offset: 17394,
                                mirror: Some(155400),
                            },
                            layout::ChecksumBlock {
                                start: 17408,
                                length: 4080,
                                offset: 21490,
                                mirror: Some(155402),
                            },
                            layout::ChecksumBlock {
                                start: 21504,
                                length: 4080,
                                offset: 25586,
                                mirror: Some(155404),
                            },
                            layout::ChecksumBlock {
                                start: 25600,
                                length: 4080,
                                offset: 29682,
                                mirror: Some(155406),
                            },
                            layout::ChecksumBlock {
                                start: 29696,
                                length: 4080,
                                offset: 33778,
                                mirror: Some(155408),
                            },
                            layout::ChecksumBlock {
                                start: 33792,
                                length: 4080,
                                offset: 37874,
                                mirror: Some(155410),
                            },
                            layout::ChecksumBlock {
                                start: 37888,
                                length: 4080,
                                offset: 41970,
                                mirror: Some(155412),
                            },
                            layout::ChecksumBlock {
                                start: 41984,
                                length: 4080,
                                offset: 46066,
                                mirror: Some(155414),
                            },
                            layout::ChecksumBlock {
                                start: 46080,
                                length: 4080,
                                offset: 50162,
                                mirror: Some(155416),
                            },
                            layout::ChecksumBlock {
                                start: 50176,
                                length: 4080,
                                offset: 54258,
                                mirror: Some(155418),
                            },
                            layout::ChecksumBlock {
                                start: 54272,
                                length: 4080,
                                offset: 58354,
                                mirror: Some(155420),
                            },
                            layout::ChecksumBlock {
                                start: 58368,
                                length: 4080,
                                offset: 62450,
                                mirror: Some(155422),
                            },
                            layout::ChecksumBlock {
                                start: 62464,
                                length: 4080,
                                offset: 66546,
                                mirror: Some(155424),
                            },
                            layout::ChecksumBlock {
                                start: 66560,
                                length: 4080,
                                offset: 70642,
                                mirror: Some(155426),
                            },
                            layout::ChecksumBlock {
                                start: 70656,
                                length: 4080,
                                offset: 74738,
                                mirror: Some(155428),
                            },
                            layout::ChecksumBlock {
                                start: 74752,
                                length: 4080,
                                offset: 78834,
                                mirror: Some(155430),
                            },
                            layout::ChecksumBlock {
                                start: 78848,
                                length: 4080,
                                offset: 82930,
                                mirror: Some(155432),
                            },
                            layout::ChecksumBlock {
                                start: 82944,
                                length: 4080,
                                offset: 87026,
                                mirror: Some(155434),
                            },
                            layout::ChecksumBlock {
                                start: 87040,
                                length: 4080,
                                offset: 91122,
                                mirror: Some(155436),
                            },
                            layout::ChecksumBlock {
                                start: 91136,
                                length: 4080,
                                offset: 95218,
                                mirror: Some(155438),
                            },
                            layout::ChecksumBlock {
                                start: 95232,
                                length: 4080,
                                offset: 99314,
                                mirror: Some(155440),
                            },
                            layout::ChecksumBlock {
                                start: 99328,
                                length: 2540,
                                offset: 101870,
                                mirror: Some(155442),
                            },
                            layout::ChecksumBlock {
                                start: 101888,
                                length: 1332,
                                offset: 103222,
                                mirror: Some(155444),
                            },
                            layout::ChecksumBlock {
                                start: 103424,
                                length: 176,
                                offset: 103602,
                                mirror: Some(155446),
                            },
                            layout::ChecksumBlock {
                                start: 103680,
                                length: 168,
                                offset: 103850,
                                mirror: Some(155448),
                            },
                            layout::ChecksumBlock {
                                start: 103936,
                                length: 4920,
                                offset: 108858,
                                mirror: Some(155450),
                            },
                            layout::ChecksumBlock {
                                start: 109056,
                                length: 1988,
                                offset: 111046,
                                mirror: Some(155452),
                            },
                            layout::ChecksumBlock {
                                start: 111104,
                                length: 3412,
                                offset: 114518,
                                mirror: Some(155454),
                            },
                            layout::ChecksumBlock {
                                start: 114688,
                                length: 148,
                                offset: 114838,
                                mirror: Some(155456),
                            },
                            layout::ChecksumBlock {
                                start: 114944,
                                length: 1624,
                                offset: 116570,
                                mirror: Some(155458),
                            },
                            layout::ChecksumBlock {
                                start: 116736,
                                length: 2708,
                                offset: 119446,
                                mirror: Some(155460),
                            },
                            layout::ChecksumBlock {
                                start: 119552,
                                length: 428,
                                offset: 119982,
                                mirror: Some(155462),
                            },
                            layout::ChecksumBlock {
                                start: 120064,
                                length: 1004,
                                offset: 121070,
                                mirror: Some(155464),
                            },
                            layout::ChecksumBlock {
                                start: 121088,
                                length: 92,
                                offset: 121182,
                                mirror: Some(155466),
                            },
                            layout::ChecksumBlock {
                                start: 121344,
                                length: 480,
                                offset: 121826,
                                mirror: Some(155468),
                            },
                            layout::ChecksumBlock {
                                start: 121856,
                                length: 168,
                                offset: 122026,
                                mirror: Some(155470),
                            },
                            layout::ChecksumBlock {
                                start: 122112,
                                length: 1120,
                                offset: 123234,
                                mirror: Some(155472),
                            },
                            layout::ChecksumBlock {
                                start: 123392,
                                length: 5120,
                                offset: 128514,
                                mirror: Some(155474),
                            },
                            layout::ChecksumBlock {
                                start: 128768,
                                length: 676,
                                offset: 129446,
                                mirror: Some(155476),
                            },
                            layout::ChecksumBlock {
                                start: 129536,
                                length: 224,
                                offset: 129762,
                                mirror: Some(155478),
                            },
                            layout::ChecksumBlock {
                                start: 129792,
                                length: 844,
                                offset: 130638,
                                mirror: Some(155480),
                            },
                            layout::ChecksumBlock {
                                start: 130816,
                                length: 1248,
                                offset: 132066,
                                mirror: Some(155482),
                            },
                            layout::ChecksumBlock {
                                start: 132096,
                                length: 248,
                                offset: 132346,
                                mirror: Some(155484),
                            },
                            layout::ChecksumBlock {
                                start: 132352,
                                length: 764,
                                offset: 133118,
                                mirror: Some(155486),
                            },
                            layout::ChecksumBlock {
                                start: 133120,
                                length: 148,
                                offset: 133270,
                                mirror: Some(155488),
                            },
                            layout::ChecksumBlock {
                                start: 133376,
                                length: 860,
                                offset: 134238,
                                mirror: Some(155490),
                            },
                            layout::ChecksumBlock {
                                start: 134400,
                                length: 468,
                                offset: 134870,
                                mirror: Some(155492),
                            },
                            layout::ChecksumBlock {
                                start: 134912,
                                length: 480,
                                offset: 135394,
                                mirror: Some(155494),
                            },
                            layout::ChecksumBlock {
                                start: 135424,
                                length: 240,
                                offset: 135666,
                                mirror: Some(155496),
                            },
                            layout::ChecksumBlock {
                                start: 135680,
                                length: 436,
                                offset: 136118,
                                mirror: Some(155498),
                            },
                            layout::ChecksumBlock {
                                start: 136192,
                                length: 1244,
                                offset: 137438,
                                mirror: Some(155500),
                            },
                            layout::ChecksumBlock {
                                start: 137472,
                                length: 52,
                                offset: 137526,
                                mirror: Some(155502),
                            },
                            layout::ChecksumBlock {
                                start: 137728,
                                length: 60,
                                offset: 137790,
                                mirror: Some(155504),
                            },
                            layout::ChecksumBlock {
                                start: 137984,
                                length: 428,
                                offset: 138414,
                                mirror: Some(155506),
                            },
                            layout::ChecksumBlock {
                                start: 138496,
                                length: 2960,
                                offset: 141458,
                                mirror: Some(155508),
                            },
                            layout::ChecksumBlock {
                                start: 141568,
                                length: 172,
                                offset: 141742,
                                mirror: Some(155510),
                            },
                            layout::ChecksumBlock {
                                start: 141824,
                                length: 2128,
                                offset: 143954,
                                mirror: Some(155512),
                            },
                            layout::ChecksumBlock {
                                start: 144128,
                                length: 644,
                                offset: 144774,
                                mirror: Some(155514),
                            },
                            layout::ChecksumBlock {
                                start: 144896,
                                length: 16,
                                offset: 144914,
                                mirror: Some(155516),
                            },
                            layout::ChecksumBlock {
                                start: 145152,
                                length: 168,
                                offset: 145322,
                                mirror: Some(155518),
                            },
                            layout::ChecksumBlock {
                                start: 145408,
                                length: 364,
                                offset: 145774,
                                mirror: Some(155520),
                            },
                            layout::ChecksumBlock {
                                start: 145920,
                                length: 128,
                                offset: 146050,
                                mirror: Some(155522),
                            },
                            layout::ChecksumBlock {
                                start: 146176,
                                length: 252,
                                offset: 146430,
                                mirror: Some(155524),
                            },
                            layout::ChecksumBlock {
                                start: 146432,
                                length: 5800,
                                offset: 152234,
                                mirror: Some(155526),
                            },
                            layout::ChecksumBlock {
                                start: 152320,
                                length: 1176,
                                offset: 153498,
                                mirror: Some(155528),
                            },
                            layout::ChecksumBlock {
                                start: 153600,
                                length: 96,
                                offset: 153698,
                                mirror: Some(155530),
                            },
                            layout::ChecksumBlock {
                                start: 153856,
                                length: 252,
                                offset: 154110,
                                mirror: Some(155532),
                            },
                            layout::ChecksumBlock {
                                start: 154112,
                                length: 996,
                                offset: 155110,
                                mirror: Some(155534),
                            },
                            layout::ChecksumBlock {
                                start: 155136,
                                length: 240,
                                offset: 155378,
                                mirror: Some(155536),
                            },
                            layout::ChecksumBlock {
                                start: 155392,
                                length: 148,
                                offset: 155554,
                                mirror: Some(155554),
                            },
                        ],
                    }),
                    ..Default::default()
                }],
            },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: vec![],
            empty_if_no_signature: false,
        }],
    });
    game.runtime.recognition = Some(runtime::Recognition {
        checks: vec![rules::Check {
            when: None,
            assert: rules::Condition::new(move |bytes| {
                Ok((rules::Scalar {
                    offset: 103455,
                    storage: Storage::U8,
                    mask: None,
                }
                .read(bytes)?)
                    == (23i64))
            }),
            code: "save_game_version".into(),
            message: "the trainer data does not match the selected game".into(),
            section_id: None,
            warning: None,
        }],
        reasons: vec![
            SaveRecognitionReason::ChecksumValid,
            SaveRecognitionReason::SignatureValid,
        ],
        confidence: SaveRecognitionConfidence::High,
        incomplete_confidence: None,
        selected_reason: true,
        empty_top_level_reasons: true,
    });
    game.runtime.checks = {
        let mut checks = vec![
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 103455,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        == (23i64))
                }),
                code: "save_game_version".into(),
                message: "the trainer data does not match the selected game".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 103457,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (1i64))
                }),
                code: "save_gender".into(),
                message: "the save has an invalid player gender value".into(),
                section_id: None,
                warning: None,
            },
        ];
        for item in 0..2 {
            let scope = FieldScope {
                base: item,
                ..Default::default()
            };
            checks.push(rules::Check {
                when: None,
                assert: {
                    let address = scope.address();
                    rules::Condition::new(move |bytes| {
                        Ok((address.scalar(103462, Storage::U8, None).read(bytes)?) <= (59i64))
                    })
                },
                code: "save_play_time".into(),
                message: "the save has an invalid play-time minute or second value".into(),
                section_id: None,
                warning: None,
            });
        }
        checks.push(rules::Check {
            when: None,
            assert: rules::Condition::new(move |bytes| {
                Ok((rules::Scalar {
                    offset: 135424,
                    storage: Storage::U32Le,
                    mask: None,
                }
                .read(bytes)?)
                    <= (9999999i64))
            }),
            code: "save_money".into(),
            message: "the save has a money value above the game limit".into(),
            section_id: None,
            warning: None,
        });
        checks
    };
    game
}

fn game_pokemon_white_2() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-white-2".into();
    game.name = "Pokémon White 2".into();
    let mut fields = vec![];
    let scope = FieldScope::default();
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        trainer_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(261, 0, 0, 99328, 32, false, "inventory.items"),
        items_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(27, 0, 0, 100568, 32, false, "inventory.key_items"),
        key_items_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(105, 0, 0, 100900, 32, false, "inventory.tm_hm"),
        tm_hm_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(47, 0, 0, 101336, 32, false, "inventory.medicine"),
        medicine_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(64, 0, 0, 101528, 32, false, "inventory.berries"),
        berries_2,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        badges_2,
    );
    game.fields = fields;
    game.runtime.family = Some("pokemon-gen5-b2w2".into());
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "save".into(),
            logical_offset: 0,
            logical_length: 524288,
            copies: layout::Copies::Fixed {
                candidates: vec![layout::Candidate {
                    spans: vec![layout::Span {
                        logical_offset: 0,
                        physical_offset: 0,
                        length: 524288,
                    }],
                    checksum_blocks: Some(layout::ChecksumBlocks {
                        algorithm: ChecksumAlgorithm::Crc16CcittFalseLe,
                        signature: Some(rules::Scalar {
                            offset: 103455,
                            storage: Storage::U8,
                            mask: None,
                        }),
                        blocks: vec![
                            layout::ChecksumBlock {
                                start: 0,
                                length: 992,
                                offset: 994,
                                mirror: Some(155392),
                            },
                            layout::ChecksumBlock {
                                start: 1024,
                                length: 4080,
                                offset: 5106,
                                mirror: Some(155394),
                            },
                            layout::ChecksumBlock {
                                start: 5120,
                                length: 4080,
                                offset: 9202,
                                mirror: Some(155396),
                            },
                            layout::ChecksumBlock {
                                start: 9216,
                                length: 4080,
                                offset: 13298,
                                mirror: Some(155398),
                            },
                            layout::ChecksumBlock {
                                start: 13312,
                                length: 4080,
                                offset: 17394,
                                mirror: Some(155400),
                            },
                            layout::ChecksumBlock {
                                start: 17408,
                                length: 4080,
                                offset: 21490,
                                mirror: Some(155402),
                            },
                            layout::ChecksumBlock {
                                start: 21504,
                                length: 4080,
                                offset: 25586,
                                mirror: Some(155404),
                            },
                            layout::ChecksumBlock {
                                start: 25600,
                                length: 4080,
                                offset: 29682,
                                mirror: Some(155406),
                            },
                            layout::ChecksumBlock {
                                start: 29696,
                                length: 4080,
                                offset: 33778,
                                mirror: Some(155408),
                            },
                            layout::ChecksumBlock {
                                start: 33792,
                                length: 4080,
                                offset: 37874,
                                mirror: Some(155410),
                            },
                            layout::ChecksumBlock {
                                start: 37888,
                                length: 4080,
                                offset: 41970,
                                mirror: Some(155412),
                            },
                            layout::ChecksumBlock {
                                start: 41984,
                                length: 4080,
                                offset: 46066,
                                mirror: Some(155414),
                            },
                            layout::ChecksumBlock {
                                start: 46080,
                                length: 4080,
                                offset: 50162,
                                mirror: Some(155416),
                            },
                            layout::ChecksumBlock {
                                start: 50176,
                                length: 4080,
                                offset: 54258,
                                mirror: Some(155418),
                            },
                            layout::ChecksumBlock {
                                start: 54272,
                                length: 4080,
                                offset: 58354,
                                mirror: Some(155420),
                            },
                            layout::ChecksumBlock {
                                start: 58368,
                                length: 4080,
                                offset: 62450,
                                mirror: Some(155422),
                            },
                            layout::ChecksumBlock {
                                start: 62464,
                                length: 4080,
                                offset: 66546,
                                mirror: Some(155424),
                            },
                            layout::ChecksumBlock {
                                start: 66560,
                                length: 4080,
                                offset: 70642,
                                mirror: Some(155426),
                            },
                            layout::ChecksumBlock {
                                start: 70656,
                                length: 4080,
                                offset: 74738,
                                mirror: Some(155428),
                            },
                            layout::ChecksumBlock {
                                start: 74752,
                                length: 4080,
                                offset: 78834,
                                mirror: Some(155430),
                            },
                            layout::ChecksumBlock {
                                start: 78848,
                                length: 4080,
                                offset: 82930,
                                mirror: Some(155432),
                            },
                            layout::ChecksumBlock {
                                start: 82944,
                                length: 4080,
                                offset: 87026,
                                mirror: Some(155434),
                            },
                            layout::ChecksumBlock {
                                start: 87040,
                                length: 4080,
                                offset: 91122,
                                mirror: Some(155436),
                            },
                            layout::ChecksumBlock {
                                start: 91136,
                                length: 4080,
                                offset: 95218,
                                mirror: Some(155438),
                            },
                            layout::ChecksumBlock {
                                start: 95232,
                                length: 4080,
                                offset: 99314,
                                mirror: Some(155440),
                            },
                            layout::ChecksumBlock {
                                start: 99328,
                                length: 2540,
                                offset: 101870,
                                mirror: Some(155442),
                            },
                            layout::ChecksumBlock {
                                start: 101888,
                                length: 1332,
                                offset: 103222,
                                mirror: Some(155444),
                            },
                            layout::ChecksumBlock {
                                start: 103424,
                                length: 176,
                                offset: 103602,
                                mirror: Some(155446),
                            },
                            layout::ChecksumBlock {
                                start: 103680,
                                length: 168,
                                offset: 103850,
                                mirror: Some(155448),
                            },
                            layout::ChecksumBlock {
                                start: 103936,
                                length: 4920,
                                offset: 108858,
                                mirror: Some(155450),
                            },
                            layout::ChecksumBlock {
                                start: 109056,
                                length: 1988,
                                offset: 111046,
                                mirror: Some(155452),
                            },
                            layout::ChecksumBlock {
                                start: 111104,
                                length: 3412,
                                offset: 114518,
                                mirror: Some(155454),
                            },
                            layout::ChecksumBlock {
                                start: 114688,
                                length: 148,
                                offset: 114838,
                                mirror: Some(155456),
                            },
                            layout::ChecksumBlock {
                                start: 114944,
                                length: 1624,
                                offset: 116570,
                                mirror: Some(155458),
                            },
                            layout::ChecksumBlock {
                                start: 116736,
                                length: 2708,
                                offset: 119446,
                                mirror: Some(155460),
                            },
                            layout::ChecksumBlock {
                                start: 119552,
                                length: 428,
                                offset: 119982,
                                mirror: Some(155462),
                            },
                            layout::ChecksumBlock {
                                start: 120064,
                                length: 1004,
                                offset: 121070,
                                mirror: Some(155464),
                            },
                            layout::ChecksumBlock {
                                start: 121088,
                                length: 92,
                                offset: 121182,
                                mirror: Some(155466),
                            },
                            layout::ChecksumBlock {
                                start: 121344,
                                length: 480,
                                offset: 121826,
                                mirror: Some(155468),
                            },
                            layout::ChecksumBlock {
                                start: 121856,
                                length: 168,
                                offset: 122026,
                                mirror: Some(155470),
                            },
                            layout::ChecksumBlock {
                                start: 122112,
                                length: 1120,
                                offset: 123234,
                                mirror: Some(155472),
                            },
                            layout::ChecksumBlock {
                                start: 123392,
                                length: 5120,
                                offset: 128514,
                                mirror: Some(155474),
                            },
                            layout::ChecksumBlock {
                                start: 128768,
                                length: 676,
                                offset: 129446,
                                mirror: Some(155476),
                            },
                            layout::ChecksumBlock {
                                start: 129536,
                                length: 224,
                                offset: 129762,
                                mirror: Some(155478),
                            },
                            layout::ChecksumBlock {
                                start: 129792,
                                length: 844,
                                offset: 130638,
                                mirror: Some(155480),
                            },
                            layout::ChecksumBlock {
                                start: 130816,
                                length: 1248,
                                offset: 132066,
                                mirror: Some(155482),
                            },
                            layout::ChecksumBlock {
                                start: 132096,
                                length: 248,
                                offset: 132346,
                                mirror: Some(155484),
                            },
                            layout::ChecksumBlock {
                                start: 132352,
                                length: 764,
                                offset: 133118,
                                mirror: Some(155486),
                            },
                            layout::ChecksumBlock {
                                start: 133120,
                                length: 148,
                                offset: 133270,
                                mirror: Some(155488),
                            },
                            layout::ChecksumBlock {
                                start: 133376,
                                length: 860,
                                offset: 134238,
                                mirror: Some(155490),
                            },
                            layout::ChecksumBlock {
                                start: 134400,
                                length: 468,
                                offset: 134870,
                                mirror: Some(155492),
                            },
                            layout::ChecksumBlock {
                                start: 134912,
                                length: 480,
                                offset: 135394,
                                mirror: Some(155494),
                            },
                            layout::ChecksumBlock {
                                start: 135424,
                                length: 240,
                                offset: 135666,
                                mirror: Some(155496),
                            },
                            layout::ChecksumBlock {
                                start: 135680,
                                length: 436,
                                offset: 136118,
                                mirror: Some(155498),
                            },
                            layout::ChecksumBlock {
                                start: 136192,
                                length: 1244,
                                offset: 137438,
                                mirror: Some(155500),
                            },
                            layout::ChecksumBlock {
                                start: 137472,
                                length: 52,
                                offset: 137526,
                                mirror: Some(155502),
                            },
                            layout::ChecksumBlock {
                                start: 137728,
                                length: 60,
                                offset: 137790,
                                mirror: Some(155504),
                            },
                            layout::ChecksumBlock {
                                start: 137984,
                                length: 428,
                                offset: 138414,
                                mirror: Some(155506),
                            },
                            layout::ChecksumBlock {
                                start: 138496,
                                length: 2960,
                                offset: 141458,
                                mirror: Some(155508),
                            },
                            layout::ChecksumBlock {
                                start: 141568,
                                length: 172,
                                offset: 141742,
                                mirror: Some(155510),
                            },
                            layout::ChecksumBlock {
                                start: 141824,
                                length: 2128,
                                offset: 143954,
                                mirror: Some(155512),
                            },
                            layout::ChecksumBlock {
                                start: 144128,
                                length: 644,
                                offset: 144774,
                                mirror: Some(155514),
                            },
                            layout::ChecksumBlock {
                                start: 144896,
                                length: 16,
                                offset: 144914,
                                mirror: Some(155516),
                            },
                            layout::ChecksumBlock {
                                start: 145152,
                                length: 168,
                                offset: 145322,
                                mirror: Some(155518),
                            },
                            layout::ChecksumBlock {
                                start: 145408,
                                length: 364,
                                offset: 145774,
                                mirror: Some(155520),
                            },
                            layout::ChecksumBlock {
                                start: 145920,
                                length: 128,
                                offset: 146050,
                                mirror: Some(155522),
                            },
                            layout::ChecksumBlock {
                                start: 146176,
                                length: 252,
                                offset: 146430,
                                mirror: Some(155524),
                            },
                            layout::ChecksumBlock {
                                start: 146432,
                                length: 5800,
                                offset: 152234,
                                mirror: Some(155526),
                            },
                            layout::ChecksumBlock {
                                start: 152320,
                                length: 1176,
                                offset: 153498,
                                mirror: Some(155528),
                            },
                            layout::ChecksumBlock {
                                start: 153600,
                                length: 96,
                                offset: 153698,
                                mirror: Some(155530),
                            },
                            layout::ChecksumBlock {
                                start: 153856,
                                length: 252,
                                offset: 154110,
                                mirror: Some(155532),
                            },
                            layout::ChecksumBlock {
                                start: 154112,
                                length: 996,
                                offset: 155110,
                                mirror: Some(155534),
                            },
                            layout::ChecksumBlock {
                                start: 155136,
                                length: 240,
                                offset: 155378,
                                mirror: Some(155536),
                            },
                            layout::ChecksumBlock {
                                start: 155392,
                                length: 148,
                                offset: 155554,
                                mirror: Some(155554),
                            },
                        ],
                    }),
                    ..Default::default()
                }],
            },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: vec![],
            empty_if_no_signature: false,
        }],
    });
    game.runtime.recognition = Some(runtime::Recognition {
        checks: vec![rules::Check {
            when: None,
            assert: rules::Condition::new(move |bytes| {
                Ok((rules::Scalar {
                    offset: 103455,
                    storage: Storage::U8,
                    mask: None,
                }
                .read(bytes)?)
                    == (22i64))
            }),
            code: "save_game_version".into(),
            message: "the trainer data does not match the selected game".into(),
            section_id: None,
            warning: None,
        }],
        reasons: vec![
            SaveRecognitionReason::ChecksumValid,
            SaveRecognitionReason::SignatureValid,
        ],
        confidence: SaveRecognitionConfidence::High,
        incomplete_confidence: None,
        selected_reason: true,
        empty_top_level_reasons: true,
    });
    game.runtime.checks = {
        let mut checks = vec![
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 103455,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        == (22i64))
                }),
                code: "save_game_version".into(),
                message: "the trainer data does not match the selected game".into(),
                section_id: None,
                warning: None,
            },
            rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 103457,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (1i64))
                }),
                code: "save_gender".into(),
                message: "the save has an invalid player gender value".into(),
                section_id: None,
                warning: None,
            },
        ];
        for item in 0..2 {
            let scope = FieldScope {
                base: item,
                ..Default::default()
            };
            checks.push(rules::Check {
                when: None,
                assert: {
                    let address = scope.address();
                    rules::Condition::new(move |bytes| {
                        Ok((address.scalar(103462, Storage::U8, None).read(bytes)?) <= (59i64))
                    })
                },
                code: "save_play_time".into(),
                message: "the save has an invalid play-time minute or second value".into(),
                section_id: None,
                warning: None,
            });
        }
        checks.push(rules::Check {
            when: None,
            assert: rules::Condition::new(move |bytes| {
                Ok((rules::Scalar {
                    offset: 135424,
                    storage: Storage::U32Le,
                    mask: None,
                }
                .read(bytes)?)
                    <= (9999999i64))
            }),
            code: "save_money".into(),
            message: "the save has a money value above the game limit".into(),
            section_id: None,
            warning: None,
        });
        checks
    };
    game
}
