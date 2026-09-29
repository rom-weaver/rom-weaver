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

fn button_mode() -> Vec<FieldChoice> {
    choices(&[("help", 0), ("lr", 1), ("l_equals_a", 2)])
}

fn sound() -> Vec<FieldChoice> {
    choices(&[("mono", 0), ("stereo", 1)])
}

fn battle_style() -> Vec<FieldChoice> {
    choices(&[("shift", 0), ("set", 1)])
}

fn battle_scene() -> Vec<FieldChoice> {
    choices(&[("on", 0), ("off", 1)])
}

fn rs_dex_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                format!("owned_{index}", index = scope.index),
                format!("Pokédex owned #{index}", index = scope.index),
                40,
                0,
            )
            .description("Owned entries are also seen. Clearing seen also clears owned.".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(92, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(6456, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(19084, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                ],
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, (40 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn rs_dex_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                format!("seen_{index}", index = scope.index),
                format!("Pokédex seen #{index}", index = scope.index),
                92,
                0,
            )
            .description("Owned entries are also seen. Clearing seen also clears owned.".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(92, Storage::U8, Some(1)).read(bytes)?)
                                    == (0i64))
                            })
                        }),
                        destination: scope.scalar(40, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(0i64)),
                    },
                    rules::Store {
                        when: None,
                        destination: scope.scalar(6456, Storage::U8, Some(1)),
                        value: {
                            let address = scope.address();
                            rules::ReadValue::new(move |bytes| {
                                address.scalar(92, Storage::U8, Some(1)).read(bytes)
                            })
                        },
                    },
                    rules::Store {
                        when: None,
                        destination: scope.scalar(19084, Storage::U8, Some(1)),
                        value: {
                            let address = scope.address();
                            rules::ReadValue::new(move |bytes| {
                                address.scalar(92, Storage::U8, Some(1)).read(bytes)
                            })
                        },
                    },
                ],
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, (92 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn rs_pc(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("pc_{index}.item_id",
 index = scope.index),
 format!("pc slot {index} item ID",
 index = scope.index),
 5272,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(348).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1176 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("pc_{index}.quantity",
 index = scope.index),
 format!("pc slot {index} quantity",
 index = scope.index),
 5274,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1178 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn rs_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("items_{index}.item_id",
 index = scope.index),
 format!("items slot {index} item ID",
 index = scope.index),
 5472,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(348).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1376 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("items_{index}.quantity",
 index = scope.index),
 format!("items slot {index} quantity",
 index = scope.index),
 5474,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(99).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1378 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn rs_key_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("key_items_{index}.item_id",
 index = scope.index),
 format!("key items slot {index} item ID",
 index = scope.index),
 5552,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(348).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1456 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("key_items_{index}.quantity",
 index = scope.index),
 format!("key items slot {index} quantity",
 index = scope.index),
 5554,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(1).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1458 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn rs_balls(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("balls_{index}.item_id",
 index = scope.index),
 format!("balls slot {index} item ID",
 index = scope.index),
 5632,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(348).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1536 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("balls_{index}.quantity",
 index = scope.index),
 format!("balls slot {index} quantity",
 index = scope.index),
 5634,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(99).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1538 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn rs_tm_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("tm_hm_{index}.item_id",
 index = scope.index),
 format!("tm hm slot {index} item ID",
 index = scope.index),
 5696,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(348).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1600 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("tm_hm_{index}.quantity",
 index = scope.index),
 format!("tm hm slot {index} quantity",
 index = scope.index),
 5698,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(99).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1602 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn rs_berries(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("berries_{index}.item_id",
 index = scope.index),
 format!("berries slot {index} item ID",
 index = scope.index),
 5952,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(348).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1856 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("berries_{index}.quantity",
 index = scope.index),
 format!("berries slot {index} quantity",
 index = scope.index),
 5954,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1858 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn rs_tail(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field("progress.badge_1".into(), "Stone Badge".into(), 8992, 7)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 928)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_2".into(), "Knuckle Badge".into(), 8993, 0)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 929)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_3".into(), "Dynamo Badge".into(), 8993, 1)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 929)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_4".into(), "Heat Badge".into(), 8993, 2)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 929)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_5".into(), "Balance Badge".into(), 8993, 3)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 929)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_6".into(), "Feather Badge".into(), 8993, 4)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 929)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_7".into(), "Mind Badge".into(), 8993, 5)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 929)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_8".into(), "Rain Badge".into(), 8993, 6)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 929)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn emerald_dex_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                format!("owned_{index}", index = scope.index),
                format!("Pokédex owned #{index}", index = scope.index),
                40,
                0,
            )
            .description("Owned entries are also seen. Clearing seen also clears owned.".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(92, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(6536, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(19236, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                ],
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, (40 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn emerald_dex_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                format!("seen_{index}", index = scope.index),
                format!("Pokédex seen #{index}", index = scope.index),
                92,
                0,
            )
            .description("Owned entries are also seen. Clearing seen also clears owned.".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(92, Storage::U8, Some(1)).read(bytes)?)
                                    == (0i64))
                            })
                        }),
                        destination: scope.scalar(40, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(0i64)),
                    },
                    rules::Store {
                        when: None,
                        destination: scope.scalar(6536, Storage::U8, Some(1)),
                        value: {
                            let address = scope.address();
                            rules::ReadValue::new(move |bytes| {
                                address.scalar(92, Storage::U8, Some(1)).read(bytes)
                            })
                        },
                    },
                    rules::Store {
                        when: None,
                        destination: scope.scalar(19236, Storage::U8, Some(1)),
                        value: {
                            let address = scope.address();
                            rules::ReadValue::new(move |bytes| {
                                address.scalar(92, Storage::U8, Some(1)).read(bytes)
                            })
                        },
                    },
                ],
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, (92 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn emerald_pc(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("pc_{index}.item_id",
 index = scope.index),
 format!("pc slot {index} item ID",
 index = scope.index),
 5272,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(376).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1176 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("pc_{index}.quantity",
 index = scope.index),
 format!("pc slot {index} quantity",
 index = scope.index),
 5274,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1178 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn emerald_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("items_{index}.item_id",
 index = scope.index),
 format!("items slot {index} item ID",
 index = scope.index),
 5472,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(376).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1376 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("items_{index}.quantity",
 index = scope.index),
 format!("items slot {index} quantity",
 index = scope.index),
 5474,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(99).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5472,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5474,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1378 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn emerald_key_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("key_items_{index}.item_id",
 index = scope.index),
 format!("key items slot {index} item ID",
 index = scope.index),
 5592,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(376).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1496 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("key_items_{index}.quantity",
 index = scope.index),
 format!("key items slot {index} quantity",
 index = scope.index),
 5594,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(1).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5592,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5594,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1498 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn emerald_balls(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("balls_{index}.item_id",
 index = scope.index),
 format!("balls slot {index} item ID",
 index = scope.index),
 5712,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(376).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1616 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("balls_{index}.quantity",
 index = scope.index),
 format!("balls slot {index} quantity",
 index = scope.index),
 5714,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(99).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5712,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5714,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1618 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn emerald_tm_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("tm_hm_{index}.item_id",
 index = scope.index),
 format!("tm hm slot {index} item ID",
 index = scope.index),
 5776,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(376).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1680 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("tm_hm_{index}.quantity",
 index = scope.index),
 format!("tm hm slot {index} quantity",
 index = scope.index),
 5778,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(99).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5776,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5778,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1682 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn emerald_berries(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("berries_{index}.item_id",
 index = scope.index),
 format!("berries slot {index} item ID",
 index = scope.index),
 6032,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(376).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1936 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("berries_{index}.quantity",
 index = scope.index),
 format!("berries slot {index} quantity",
 index = scope.index),
 6034,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(6032,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(6034,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 172,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1938 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn emerald_tail(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "progress.battle_points".into(),
                "Battle Points".into(),
                3768,
                Storage::U16Le,
            )
            .description("Battle Frontier points".into())
            .min(0)
            .max(9999)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 3768)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "trainer.security_key".into(),
                "Security key".into(),
                172,
                Storage::U32Le,
            )
            .description("Key used to mask money".into())
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![],
                    }),
                    step: Some(None),
                    warnings: vec!["Read-only".into()],
                    ..field::Presentation::new(0, 172)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_1".into(), "Stone Badge".into(), 9084, 7)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1020)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_2".into(), "Knuckle Badge".into(), 9085, 0)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1021)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_3".into(), "Dynamo Badge".into(), 9085, 1)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1021)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_4".into(), "Heat Badge".into(), 9085, 2)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1021)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_5".into(), "Balance Badge".into(), 9085, 3)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1021)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_6".into(), "Feather Badge".into(), 9085, 4)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1021)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_7".into(), "Mind Badge".into(), 9085, 5)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1021)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_8".into(), "Rain Badge".into(), 9085, 6)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 1021)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn frlg_dex_owned(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                format!("owned_{index}", index = scope.index),
                format!("Pokédex owned #{index}", index = scope.index),
                40,
                0,
            )
            .description("Owned entries are also seen. Clearing seen also clears owned.".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(92, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(5624, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(40, Storage::U8, Some(1)).read(bytes)?)
                                    == (1i64))
                            })
                        }),
                        destination: scope.scalar(18968, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(1i64)),
                    },
                ],
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, (40 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn frlg_dex_seen(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .bit_field(
                format!("seen_{index}", index = scope.index),
                format!("Pokédex seen #{index}", index = scope.index),
                92,
                0,
            )
            .description("Owned entries are also seen. Clearing seen also clears owned.".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                on_edit: vec![
                    rules::Store {
                        when: Some({
                            let address = scope.address();
                            rules::Condition::new(move |bytes| {
                                Ok((address.scalar(92, Storage::U8, Some(1)).read(bytes)?)
                                    == (0i64))
                            })
                        }),
                        destination: scope.scalar(40, Storage::U8, Some(1)),
                        value: rules::ReadValue::new(move |_bytes| Ok(0i64)),
                    },
                    rules::Store {
                        when: None,
                        destination: scope.scalar(5624, Storage::U8, Some(1)),
                        value: {
                            let address = scope.address();
                            rules::ReadValue::new(move |bytes| {
                                address.scalar(92, Storage::U8, Some(1)).read(bytes)
                            })
                        },
                    },
                    rules::Store {
                        when: None,
                        destination: scope.scalar(18968, Storage::U8, Some(1)),
                        value: {
                            let address = scope.address();
                            rules::ReadValue::new(move |bytes| {
                                address.scalar(92, Storage::U8, Some(1)).read(bytes)
                            })
                        },
                    },
                ],
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, (92 + scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn frlg_pc(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("pc_{index}.item_id",
 index = scope.index),
 format!("pc slot {index} item ID",
 index = scope.index),
 4760,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(374).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (664 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("pc_{index}.quantity",
 index = scope.index),
 format!("pc slot {index} quantity",
 index = scope.index),
 4762,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (666 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn frlg_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("items_{index}.item_id",
 index = scope.index),
 format!("items slot {index} item ID",
 index = scope.index),
 4880,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(374).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (784 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("items_{index}.quantity",
 index = scope.index),
 format!("items slot {index} quantity",
 index = scope.index),
 4882,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(4880,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(4882,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (786 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn frlg_key_items(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("key_items_{index}.item_id",
 index = scope.index),
 format!("key items slot {index} item ID",
 index = scope.index),
 5048,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(374).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (952 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("key_items_{index}.quantity",
 index = scope.index),
 format!("key items slot {index} quantity",
 index = scope.index),
 5050,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(1).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5048,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5050,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (954 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn frlg_balls(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("balls_{index}.item_id",
 index = scope.index),
 format!("balls slot {index} item ID",
 index = scope.index),
 5168,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(374).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1072 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("balls_{index}.quantity",
 index = scope.index),
 format!("balls slot {index} quantity",
 index = scope.index),
 5170,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5168,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5170,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1074 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn frlg_tm_hm(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("tm_hm_{index}.item_id",
 index = scope.index),
 format!("tm hm slot {index} item ID",
 index = scope.index),
 5220,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(374).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1124 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("tm_hm_{index}.quantity",
 index = scope.index),
 format!("tm hm slot {index} quantity",
 index = scope.index),
 5222,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5220,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5222,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1126 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn frlg_berries(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![scope.field(format!("berries_{index}.item_id",
 index = scope.index),
 format!("berries slot {index} item ID",
 index = scope.index),
 5452,
 Storage::U16Le).description("Game item ID. Use an item for this pocket. Set both ID and quantity to zero to clear a slot.".into()).min(0).max(374).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1356 + scope.bits / 8) as u16) }
),
 ..Default::default() }
),
 scope.field(format!("berries_{index}.quantity",
 index = scope.index),
 format!("berries slot {index} quantity",
 index = scope.index),
 5454,
 Storage::U16Le).description("Set a positive quantity with an item ID to fill a slot; empty slots have quantity zero.".into()).min(0).max(999).behavior(field::FieldBehavior {
 group: scope.group.clone(),
 read: Some({
 let address = scope.address(); rules::ReadValue::new(move |bytes| Ok(if (address.scalar(5452,
 Storage::U16Le,
 None).read(bytes)?) == (0i64) {
 0i64 }
 else {
 (address.scalar(5454,
 Storage::U16Le,
 None).read(bytes)?) ^ (rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?)  }
)) }
),
 xor: Some(rules::ReadValue::new(move |bytes| rules::Scalar {
 offset: 3872,
 storage: Storage::U16Le,
 mask: None }
.read(bytes))),
 presentation: Some(field::Presentation {
 ..field::Presentation::new(1,
 (1358 + scope.bits / 8) as u16) }
),
 ..Default::default() }
)];

    fields
}

fn frlg_tail(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "trainer.security_key".into(),
                "Security key".into(),
                3872,
                Storage::U32Le,
            )
            .description("Key used to mask money".into())
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![],
                    }),
                    step: Some(None),
                    warnings: vec!["Read-only".into()],
                    ..field::Presentation::new(0, 3872)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_1".into(), "Boulder Badge".into(), 8164, 0)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_2".into(), "Cascade Badge".into(), 8164, 1)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_3".into(), "Thunder Badge".into(), 8164, 2)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_4".into(), "Rainbow Badge".into(), 8164, 3)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_5".into(), "Soul Badge".into(), 8164, 4)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_6".into(), "Marsh Badge".into(), 8164, 5)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_7".into(), "Volcano Badge".into(), 8164, 6)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.badge_8".into(), "Earth Badge".into(), 8164, 7)
            .description("Gym badge flag".into())
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(2, 100)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn default() -> GameDefinition {
    {
        let mut fields = vec![
            FieldDefinition::new(
                "trainer.name".into(),
                "Trainer name".into(),
                0,
                Storage::Ascii,
            )
            .description("English trainer text".into())
            .length(7)
            .behavior(field::FieldBehavior {
                text_codec: Some("pokemon_gen3_english".into()),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    encoding: Some(Some("pokemon_gen3_english".into())),
                    ..field::Presentation::new(0, 0)
                }),
                ..Default::default()
            }),
            FieldDefinition::new("trainer.gender".into(), "Gender".into(), 8, Storage::U8)
                .description("Player gender".into())
                .choices(choices(&[("male", 0), ("female", 1)]))
                .behavior(field::FieldBehavior {
                    presentation: Some(field::Presentation {
                        constraints: Some(SaveConstraint {
                            min: None,
                            max: None,
                            max_length: None,
                            choices: vec!["male".into(), "female".into()],
                        }),
                        step: Some(None),
                        ..field::Presentation::new(0, 8)
                    }),
                    ..Default::default()
                }),
            FieldDefinition::new("trainer.id".into(), "Trainer ID".into(), 10, Storage::U16Le)
                .description("Public trainer identifier".into())
                .min(0)
                .max(65535)
                .behavior(field::FieldBehavior {
                    presentation: Some(field::Presentation {
                        step: Some(None),
                        ..field::Presentation::new(0, 10)
                    }),
                    ..Default::default()
                }),
            FieldDefinition::new(
                "trainer.secret_id".into(),
                "Secret ID".into(),
                12,
                Storage::U16Le,
            )
            .description("Hidden trainer identifier".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 12)
                }),
                ..Default::default()
            }),
            FieldDefinition::new("trainer.money".into(), "Money".into(), 5264, Storage::U32Le)
                .description("Money carried by the player".into())
                .min(0)
                .max(999999)
                .behavior(field::FieldBehavior {
                    presentation: Some(field::Presentation {
                        ..field::Presentation::new(1, 1168)
                    }),
                    ..Default::default()
                }),
            FieldDefinition::new("trainer.coins".into(), "Coins".into(), 5268, Storage::U16Le)
                .description("Game Corner coins".into())
                .min(0)
                .max(9999)
                .behavior(field::FieldBehavior {
                    presentation: Some(field::Presentation {
                        ..field::Presentation::new(1, 1172)
                    }),
                    ..Default::default()
                }),
            FieldDefinition::new(
                "trainer.play_time".into(),
                "Play time".into(),
                14,
                Storage::Ascii,
            )
            .description("Time played".into())
            .length(1)
            .editable(false)
            .behavior(field::FieldBehavior {
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 14,
                                storage: Storage::U16Le,
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
                                offset: 16,
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
                                offset: 17,
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
                                offset: 18,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![],
                    }),
                    step: Some(None),
                    encoding: Some(None),
                    ..field::Presentation::new(0, 14)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "trainer.play_time_hours".into(),
                "Play time hours".into(),
                14,
                Storage::U16Le,
            )
            .description("Hours played".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 14)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "trainer.play_time_minutes".into(),
                "Play time minutes".into(),
                16,
                Storage::U8,
            )
            .description("Minutes in the current hour".into())
            .min(0)
            .max(59)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 16)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "trainer.play_time_seconds".into(),
                "Play time seconds".into(),
                17,
                Storage::U8,
            )
            .description("Seconds in the current minute".into())
            .min(0)
            .max(59)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 17)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "trainer.play_time_frames".into(),
                "Play time frames".into(),
                18,
                Storage::U8,
            )
            .description("Frames in the current second".into())
            .min(0)
            .max(59)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 18)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "options.button_mode".into(),
                "Button mode".into(),
                19,
                Storage::U8,
            )
            .description("A-button and shoulder-button behavior".into())
            .choices(choices(&[("help", 0), ("lr", 1), ("l_equals_a", 2)]))
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["help".into(), "lr".into(), "l_equals_a".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 19)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "options.text_speed".into(),
                "Text speed".into(),
                20,
                Storage::U16Le,
            )
            .description("Text speed: 0 slow, 1 medium, 2 fast".into())
            .min(0)
            .max(2)
            .mask(7)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 20)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "options.window_frame".into(),
                "Window frame".into(),
                20,
                Storage::U16Le,
            )
            .description("Text window frame type".into())
            .min(0)
            .max(19)
            .mask(248)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 20)
                }),
                ..Default::default()
            }),
            FieldDefinition::new("options.sound".into(), "Sound".into(), 20, Storage::U16Le)
                .description("Sound output mode".into())
                .choices(choices(&[("mono", 0), ("stereo", 1)]))
                .mask(256)
                .behavior(field::FieldBehavior {
                    presentation: Some(field::Presentation {
                        constraints: Some(SaveConstraint {
                            min: None,
                            max: None,
                            max_length: None,
                            choices: vec!["mono".into(), "stereo".into()],
                        }),
                        step: Some(None),
                        ..field::Presentation::new(0, 20)
                    }),
                    ..Default::default()
                }),
            FieldDefinition::new(
                "options.battle_style".into(),
                "Battle style".into(),
                20,
                Storage::U16Le,
            )
            .description("Whether the game offers a switch after a foe faints".into())
            .choices(choices(&[("shift", 0), ("set", 1)]))
            .mask(512)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["shift".into(), "set".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 20)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "options.battle_scene".into(),
                "Battle scene".into(),
                20,
                Storage::U16Le,
            )
            .description("Battle animation mode".into())
            .choices(choices(&[("on", 0), ("off", 1)]))
            .mask(1024)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["on".into(), "off".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 20)
                }),
                ..Default::default()
            }),
            FieldDefinition::new(
                "options.region_map_zoom".into(),
                "Region map zoom".into(),
                21,
                Storage::Bit,
            )
            .bit(3)
            .description("Region map zoom state".into())
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::Boolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 20)
                }),
                ..Default::default()
            }),
        ];
        let scope = FieldScope::default();
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(50, 1, 0, 0, 32, false, "inventory"),
            rs_pc,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(20, 1, 0, 0, 32, false, "inventory"),
            rs_items,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(20, 1, 0, 0, 32, false, "inventory"),
            rs_key_items,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(16, 1, 0, 0, 32, false, "inventory"),
            rs_balls,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(64, 1, 0, 0, 32, false, "inventory"),
            rs_tm_hm,
        );
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(46, 1, 0, 0, 32, false, "inventory"),
            rs_berries,
        );
        {
            for item in 0..386 {
                let number = item + 1;
                let index = format!("{number:03}");
                let mut child = FieldScope {
                    base: scope.base + scope.bits / 8,
                    bits: item,
                    bit_stride: true,
                    index,
                    ordinal: item + 1,
                    prefix: String::new(),
                    group: scope.group.clone(),
                    guards: scope.guards.clone(),
                };
                child.prefix = scope.id("pokedex");
                fields.extend(rs_dex_owned(&child));
            }
        }
        {
            for item in 0..386 {
                let number = item + 1;
                let index = format!("{number:03}");
                let mut child = FieldScope {
                    base: scope.base + scope.bits / 8,
                    bits: item,
                    bit_stride: true,
                    index,
                    ordinal: item + 1,
                    prefix: String::new(),
                    group: scope.group.clone(),
                    guards: scope.guards.clone(),
                };
                child.prefix = scope.id("pokedex");
                fields.extend(rs_dex_seen(&child));
            }
        }
        extend_fields(
            &mut fields,
            &scope,
            Repetition::new(1, 0, 0, 0, 0, false, ""),
            rs_tail,
        );
        GameDefinition {
            fields,
            runtime: runtime::Runtime {
                family: Some("pokemon-gen3-rs".into()),
                handler_id: Some("pokemon-gen3".into()),
                save_format: Some("gba_flash_128k".into()),
                save_format_name: Some("Flash 128 KiB".into()),
                checksum_sizes: vec![
                    2192, 3968, 3968, 3968, 3136, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968,
                    2000,
                ],
                logical_size: Some(55680),
                layout: Some(layout::Layout {
                    groups: vec![layout::Group {
                        id: "save".into(),
                        logical_offset: 0,
                        logical_length: 55680,
                        copies: layout::Copies::Tagged {
                            candidates: vec![
                                layout::TaggedCandidate {
                                    offset: 0,
                                    section_count: 14,
                                },
                                layout::TaggedCandidate {
                                    offset: 57344,
                                    section_count: 14,
                                },
                            ],
                            sections: vec![
                                layout::TaggedSection {
                                    id: 0,
                                    logical_offset: 0,
                                    length: 4096,
                                    checksum_length: 2192,
                                },
                                layout::TaggedSection {
                                    id: 1,
                                    logical_offset: 4096,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 2,
                                    logical_offset: 8064,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 3,
                                    logical_offset: 12032,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 4,
                                    logical_offset: 16000,
                                    length: 3968,
                                    checksum_length: 3136,
                                },
                                layout::TaggedSection {
                                    id: 5,
                                    logical_offset: 19968,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 6,
                                    logical_offset: 23936,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 7,
                                    logical_offset: 27904,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 8,
                                    logical_offset: 31872,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 9,
                                    logical_offset: 35840,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 10,
                                    logical_offset: 39808,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 11,
                                    logical_offset: 43776,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 12,
                                    logical_offset: 47744,
                                    length: 3968,
                                    checksum_length: 3968,
                                },
                                layout::TaggedSection {
                                    id: 13,
                                    logical_offset: 51712,
                                    length: 3968,
                                    checksum_length: 2000,
                                },
                            ],
                            section_size: 4096,
                            id_offset: 4084,
                            checksum_offset: 4086,
                            checksum_algorithm: None,
                            checksum_unit: None,
                            signature_offset: 4088,
                            counter_offset: 4092,
                            signature: 134291493,
                        },
                        selection: layout::Selection::NewestCounterMaxToZeroErrorOnTie,
                        write: layout::WritePolicy::Selected,
                        empty: vec![255],
                        empty_if_no_signature: true,
                    }],
                }),
                recognition: Some(runtime::Recognition {
                    checks: Vec::new(),
                    reasons: vec![
                        SaveRecognitionReason::ChecksumValid,
                        SaveRecognitionReason::SignatureValid,
                        SaveRecognitionReason::CounterUniform,
                    ],
                    confidence: SaveRecognitionConfidence::High,
                    incomplete_confidence: Some(SaveRecognitionConfidence::Medium),
                    selected_reason: false,
                    empty_top_level_reasons: true,
                }),
                checks: {
                    let mut checks = vec![
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 8,
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
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 5264,
                                    storage: Storage::U32Le,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (999999i64))
                            }),
                            code: "save_money".into(),
                            message: "the save has a money value above the game limit".into(),
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
                                    Ok((address.scalar(16, Storage::U8, None).read(bytes)?)
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
                                offset: 19,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                <= (2i64))
                        }),
                        code: "save_options".into(),
                        message: "the save has an invalid Generation III option value".into(),
                        section_id: None,
                        warning: None,
                    });
                    checks.push(rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 20,
                                storage: Storage::U16Le,
                                mask: Some(7),
                            }
                            .read(bytes)?)
                                <= (2i64))
                        }),
                        code: "save_options".into(),
                        message: "the save has an invalid Generation III option value".into(),
                        section_id: None,
                        warning: None,
                    });
                    checks.push(rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 20,
                                storage: Storage::U16Le,
                                mask: Some(248),
                            }
                            .read(bytes)?)
                                <= (19i64))
                        }),
                        code: "save_options".into(),
                        message: "the save has an invalid Generation III option value".into(),
                        section_id: None,
                        warning: None,
                    });
                    for item in 0..50 {
                        let scope = FieldScope {
                            base: item * 4,
                            ..Default::default()
                        };
                        checks.push(rules::Check {
                            when: None,
                            assert: {
                                let address = scope.address();
                                rules::Condition::new(move |bytes| {
                                    Ok(((address
                                        .scalar(5272, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64))
                                        || (((1i64)
                                            <= (address
                                                .scalar(5274, Storage::U16Le, None)
                                                .read(bytes)?))
                                            && ((address
                                                .scalar(5274, Storage::U16Le, None)
                                                .read(bytes)?)
                                                <= (999i64))))
                                })
                            },
                            code: "save_inventory_quantity".into(),
                            message: "an occupied inventory slot has an invalid quantity".into(),
                            section_id: None,
                            warning: None,
                        });
                    }
                    for item in 0..20 {
                        let scope = FieldScope {
                            base: item * 4,
                            ..Default::default()
                        };
                        checks.push(rules::Check {
                            when: None,
                            assert: {
                                let address = scope.address();
                                rules::Condition::new(move |bytes| {
                                    Ok(((address
                                        .scalar(5472, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64))
                                        || (((1i64)
                                            <= (address
                                                .scalar(5474, Storage::U16Le, None)
                                                .read(bytes)?))
                                            && ((address
                                                .scalar(5474, Storage::U16Le, None)
                                                .read(bytes)?)
                                                <= (99i64))))
                                })
                            },
                            code: "save_inventory_quantity".into(),
                            message: "an occupied inventory slot has an invalid quantity".into(),
                            section_id: None,
                            warning: None,
                        });
                    }
                    for item in 0..20 {
                        let scope = FieldScope {
                            base: item * 4,
                            ..Default::default()
                        };
                        checks.push(rules::Check {
                            when: None,
                            assert: {
                                let address = scope.address();
                                rules::Condition::new(move |bytes| {
                                    Ok(((address
                                        .scalar(5552, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64))
                                        || (((1i64)
                                            <= (address
                                                .scalar(5554, Storage::U16Le, None)
                                                .read(bytes)?))
                                            && ((address
                                                .scalar(5554, Storage::U16Le, None)
                                                .read(bytes)?)
                                                <= (1i64))))
                                })
                            },
                            code: "save_inventory_quantity".into(),
                            message: "an occupied inventory slot has an invalid quantity".into(),
                            section_id: None,
                            warning: None,
                        });
                    }
                    for item in 0..80 {
                        let scope = FieldScope {
                            base: item * 4,
                            ..Default::default()
                        };
                        checks.push(rules::Check {
                            when: None,
                            assert: {
                                let address = scope.address();
                                rules::Condition::new(move |bytes| {
                                    Ok(((address
                                        .scalar(5632, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64))
                                        || (((1i64)
                                            <= (address
                                                .scalar(5634, Storage::U16Le, None)
                                                .read(bytes)?))
                                            && ((address
                                                .scalar(5634, Storage::U16Le, None)
                                                .read(bytes)?)
                                                <= (99i64))))
                                })
                            },
                            code: "save_inventory_quantity".into(),
                            message: "an occupied inventory slot has an invalid quantity".into(),
                            section_id: None,
                            warning: None,
                        });
                    }
                    for item in 0..46 {
                        let scope = FieldScope {
                            base: item * 4,
                            ..Default::default()
                        };
                        checks.push(rules::Check {
                            when: None,
                            assert: {
                                let address = scope.address();
                                rules::Condition::new(move |bytes| {
                                    Ok(((address
                                        .scalar(5952, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64))
                                        || (((1i64)
                                            <= (address
                                                .scalar(5954, Storage::U16Le, None)
                                                .read(bytes)?))
                                            && ((address
                                                .scalar(5954, Storage::U16Le, None)
                                                .read(bytes)?)
                                                <= (999i64))))
                                })
                            },
                            code: "save_inventory_quantity".into(),
                            message: "an occupied inventory slot has an invalid quantity".into(),
                            section_id: None,
                            warning: None,
                        });
                    }
                    checks
                },
                recovery: Some(runtime::Recovery {
                    no_valid: runtime::Failure {
                        code: "save_checksum".into(),
                        message: "the save has an invalid section checksum".into(),
                    },
                    incomplete: Some(runtime::RecoveryOutcome {
                        state: SaveIntegrityState::ValidWithWarnings,
                        disable_editing: false,
                        issue: Some(runtime::Failure {
                            code: "redundant_slot_empty".into(),
                            message: "The redundant save slot is empty".into(),
                        }),
                        warning: Some(
                            "The redundant save slot is empty; the editor preserves it".into(),
                        ),
                        field_warning: None,
                        edit_error: None,
                        parse_error: None,
                        section_id: false,
                    }),
                    damaged: Some(runtime::RecoveryOutcome {
                        state: SaveIntegrityState::PartiallyRecoverable,
                        disable_editing: true,
                        issue: Some(runtime::Failure {
                            code: "redundant_slot_invalid".into(),
                            message: "One redundant save slot failed integrity checks".into(),
                        }),
                        warning: Some(
                            "One redundant save slot is invalid; normal editing is disabled".into(),
                        ),
                        field_warning: None,
                        edit_error: Some(runtime::Failure {
                            code: "save_integrity_partial".into(),
                            message: "normal edits need two valid Pokémon save slots".into(),
                        }),
                        parse_error: None,
                        section_id: false,
                    }),
                    unrecoverable: None,
                    differing: None,
                    active_group: false,
                    zero_counter: false,
                }),
                include_implicit_changes: true,
                ..Default::default()
            },
            ..GameDefinition::new("".into(), "".into(), "gba".into(), 131072)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([(
        "pokemon_gen3_english".into(),
        text::TextCodec {
            unit: text::TextUnit::U8,
            max_chars: 7,
            max_units: Some(7),
            terminators: vec![255],
            skip: vec![],
            fill: 0,
            write_terminator: Some(255),
            lane: None,
            mapping: text::TextMapping::Table {
                ranges: vec![
                    text::GlyphRange {
                        first: '0',
                        last: '9',
                        first_code: 161,
                    },
                    text::GlyphRange {
                        first: 'A',
                        last: 'Z',
                        first_code: 187,
                    },
                    text::GlyphRange {
                        first: 'a',
                        last: 'z',
                        first_code: 213,
                    },
                ],
                glyphs: BTreeMap::from([
                    (' ', 0),
                    ('!', 171),
                    ('?', 172),
                    ('.', 173),
                    ('-', 174),
                    ('…', 176),
                    ('“', 177),
                    ('”', 178),
                    ('‘', 179),
                    ('’', 180),
                    ('♂', 181),
                    ('♀', 182),
                    (',', 184),
                    ('/', 186),
                ]),
                aliases: BTreeMap::from([('\'', '’')]),
            },
            decode_invalid: text::DecodeInvalid::Error,
            missing_terminator: text::MissingTerminator::Accept,
            errors: text::TextErrors {
                decode_invalid: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the save has unsupported trainer text".into(),
                },
                encode_invalid: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the trainer name uses unsupported text".into(),
                },
                missing_terminator: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the trainer name has no terminator".into(),
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
        game_pokemon_ruby(),
        game_pokemon_sapphire(),
        game_pokemon_emerald(),
        game_pokemon_firered_leafgreen("pokemon-firered", "Pokémon FireRed"),
        game_pokemon_firered_leafgreen("pokemon-leafgreen", "Pokémon LeafGreen"),
    ];

    build(games, codecs, false)
}

fn game_pokemon_ruby() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-ruby".into();
    game.name = "Pokémon Ruby".into();
    game
}

fn game_pokemon_sapphire() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-sapphire".into();
    game.name = "Pokémon Sapphire".into();
    game
}

fn game_pokemon_emerald() -> GameDefinition {
    let mut game = default();
    game.id = "pokemon-emerald".into();
    game.name = "Pokémon Emerald".into();
    let mut fields = vec![
        FieldDefinition::new(
            "trainer.name".into(),
            "Trainer name".into(),
            0,
            Storage::Ascii,
        )
        .description("English trainer text".into())
        .length(7)
        .behavior(field::FieldBehavior {
            text_codec: Some("pokemon_gen3_english".into()),
            presentation: Some(field::Presentation {
                step: Some(None),
                encoding: Some(Some("pokemon_gen3_english".into())),
                ..field::Presentation::new(0, 0)
            }),
            ..Default::default()
        }),
        FieldDefinition::new("trainer.gender".into(), "Gender".into(), 8, Storage::U8)
            .description("Player gender".into())
            .choices(gender())
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["male".into(), "female".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 8)
                }),
                ..Default::default()
            }),
        FieldDefinition::new("trainer.id".into(), "Trainer ID".into(), 10, Storage::U16Le)
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 10)
                }),
                ..Default::default()
            }),
        FieldDefinition::new(
            "trainer.secret_id".into(),
            "Secret ID".into(),
            12,
            Storage::U16Le,
        )
        .description("Hidden trainer identifier".into())
        .min(0)
        .max(65535)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                step: Some(None),
                ..field::Presentation::new(0, 12)
            }),
            ..Default::default()
        }),
        FieldDefinition::new("trainer.money".into(), "Money".into(), 5264, Storage::U32Le)
            .description("Money carried by the player".into())
            .min(0)
            .max(999999)
            .behavior(field::FieldBehavior {
                xor: Some(rules::ReadValue::new(move |bytes| {
                    rules::Scalar {
                        offset: 172,
                        storage: Storage::U32Le,
                        mask: None,
                    }
                    .read(bytes)
                })),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(1, 1168)
                }),
                ..Default::default()
            }),
        FieldDefinition::new("trainer.coins".into(), "Coins".into(), 5268, Storage::U16Le)
            .description("Game Corner coins".into())
            .min(0)
            .max(9999)
            .behavior(field::FieldBehavior {
                xor: Some(rules::ReadValue::new(move |bytes| {
                    rules::Scalar {
                        offset: 172,
                        storage: Storage::U16Le,
                        mask: None,
                    }
                    .read(bytes)
                })),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(1, 1172)
                }),
                ..Default::default()
            }),
        FieldDefinition::new(
            "trainer.play_time".into(),
            "Play time".into(),
            14,
            Storage::Ascii,
        )
        .description("Time played".into())
        .length(1)
        .editable(false)
        .behavior(field::FieldBehavior {
            format: Some(vec![
                field::FormatPart::Number {
                    value: rules::ReadValue::new(move |bytes| {
                        rules::Scalar {
                            offset: 14,
                            storage: Storage::U16Le,
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
                            offset: 16,
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
                            offset: 17,
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
                            offset: 18,
                            storage: Storage::U8,
                            mask: None,
                        }
                        .read(bytes)
                    }),
                    width: 2,
                },
            ]),
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec![],
                }),
                step: Some(None),
                encoding: Some(None),
                ..field::Presentation::new(0, 14)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_hours".into(),
            "Play time hours".into(),
            14,
            Storage::U16Le,
        )
        .description("Hours played".into())
        .min(0)
        .max(65535)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 14)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_minutes".into(),
            "Play time minutes".into(),
            16,
            Storage::U8,
        )
        .description("Minutes in the current hour".into())
        .min(0)
        .max(59)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 16)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_seconds".into(),
            "Play time seconds".into(),
            17,
            Storage::U8,
        )
        .description("Seconds in the current minute".into())
        .min(0)
        .max(59)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 17)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_frames".into(),
            "Play time frames".into(),
            18,
            Storage::U8,
        )
        .description("Frames in the current second".into())
        .min(0)
        .max(59)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 18)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.button_mode".into(),
            "Button mode".into(),
            19,
            Storage::U8,
        )
        .description("A-button and shoulder-button behavior".into())
        .choices(button_mode())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec!["help".into(), "lr".into(), "l_equals_a".into()],
                }),
                step: Some(None),
                ..field::Presentation::new(0, 19)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.text_speed".into(),
            "Text speed".into(),
            20,
            Storage::U16Le,
        )
        .description("Text speed: 0 slow, 1 medium, 2 fast".into())
        .min(0)
        .max(2)
        .mask(7)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.window_frame".into(),
            "Window frame".into(),
            20,
            Storage::U16Le,
        )
        .description("Text window frame type".into())
        .min(0)
        .max(19)
        .mask(248)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new("options.sound".into(), "Sound".into(), 20, Storage::U16Le)
            .description("Sound output mode".into())
            .mask(256)
            .choices(sound())
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["mono".into(), "stereo".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 20)
                }),
                ..Default::default()
            }),
        FieldDefinition::new(
            "options.battle_style".into(),
            "Battle style".into(),
            20,
            Storage::U16Le,
        )
        .description("Whether the game offers a switch after a foe faints".into())
        .mask(512)
        .choices(battle_style())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec!["shift".into(), "set".into()],
                }),
                step: Some(None),
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.battle_scene".into(),
            "Battle scene".into(),
            20,
            Storage::U16Le,
        )
        .description("Battle animation mode".into())
        .mask(1024)
        .choices(battle_scene())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec!["on".into(), "off".into()],
                }),
                step: Some(None),
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.region_map_zoom".into(),
            "Region map zoom".into(),
            21,
            Storage::Bit,
        )
        .bit(3)
        .description("Region map zoom state".into())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                kind: Some(SaveFieldKind::Boolean),
                step: Some(None),
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
    ];
    let scope = FieldScope::default();
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(50, 1, 0, 0, 32, false, "inventory"),
        emerald_pc,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(30, 1, 0, 0, 32, false, "inventory"),
        emerald_items,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(30, 1, 0, 0, 32, false, "inventory"),
        emerald_key_items,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(16, 1, 0, 0, 32, false, "inventory"),
        emerald_balls,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(64, 1, 0, 0, 32, false, "inventory"),
        emerald_tm_hm,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(46, 1, 0, 0, 32, false, "inventory"),
        emerald_berries,
    );
    {
        for item in 0..386 {
            let number = item + 1;
            let index = format!("{number:03}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8,
                bits: item,
                bit_stride: true,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("pokedex");
            fields.extend(emerald_dex_owned(&child));
        }
    }
    {
        for item in 0..386 {
            let number = item + 1;
            let index = format!("{number:03}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8,
                bits: item,
                bit_stride: true,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("pokedex");
            fields.extend(emerald_dex_seen(&child));
        }
    }
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        emerald_tail,
    );
    game.fields = fields;
    game.runtime.family = Some("pokemon-gen3-emerald".into());
    game.runtime.checksum_sizes = vec![
        3884, 3968, 3968, 3968, 3848, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000,
    ];
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "save".into(),
            logical_offset: 0,
            logical_length: 55680,
            copies: layout::Copies::Tagged {
                candidates: vec![
                    layout::TaggedCandidate {
                        offset: 0,
                        section_count: 14,
                    },
                    layout::TaggedCandidate {
                        offset: 57344,
                        section_count: 14,
                    },
                ],
                sections: vec![
                    layout::TaggedSection {
                        id: 0,
                        logical_offset: 0,
                        length: 4096,
                        checksum_length: 3884,
                    },
                    layout::TaggedSection {
                        id: 1,
                        logical_offset: 4096,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 2,
                        logical_offset: 8064,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 3,
                        logical_offset: 12032,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 4,
                        logical_offset: 16000,
                        length: 3968,
                        checksum_length: 3848,
                    },
                    layout::TaggedSection {
                        id: 5,
                        logical_offset: 19968,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 6,
                        logical_offset: 23936,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 7,
                        logical_offset: 27904,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 8,
                        logical_offset: 31872,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 9,
                        logical_offset: 35840,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 10,
                        logical_offset: 39808,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 11,
                        logical_offset: 43776,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 12,
                        logical_offset: 47744,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 13,
                        logical_offset: 51712,
                        length: 3968,
                        checksum_length: 2000,
                    },
                ],
                section_size: 4096,
                id_offset: 4084,
                checksum_offset: 4086,
                checksum_algorithm: None,
                checksum_unit: None,
                signature_offset: 4088,
                counter_offset: 4092,
                signature: 134291493,
            },
            selection: layout::Selection::NewestCounterMaxToZeroErrorOnTie,
            write: layout::WritePolicy::Selected,
            empty: vec![255],
            empty_if_no_signature: true,
        }],
    });
    game.runtime.checks =
        {
            let mut checks = vec![
                rules::Check {
                    when: None,
                    assert: rules::Condition::new(move |bytes| {
                        Ok((rules::Scalar {
                            offset: 8,
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
                rules::Check {
                    when: None,
                    assert: rules::Condition::new(move |bytes| {
                        Ok(((rules::Scalar {
                            offset: 5264,
                            storage: Storage::U32Le,
                            mask: None,
                        }
                        .read(bytes)?)
                            ^ (rules::Scalar {
                                offset: 172,
                                storage: Storage::U32Le,
                                mask: None,
                            }
                            .read(bytes)?))
                            <= (999999i64))
                    }),
                    code: "save_money".into(),
                    message: "the save has a money value above the game limit".into(),
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
                            Ok((address.scalar(16, Storage::U8, None).read(bytes)?) <= (59i64))
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
                        offset: 19,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (2i64))
                }),
                code: "save_options".into(),
                message: "the save has an invalid Generation III option value".into(),
                section_id: None,
                warning: None,
            });
            checks.push(rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 20,
                        storage: Storage::U16Le,
                        mask: Some(7),
                    }
                    .read(bytes)?)
                        <= (2i64))
                }),
                code: "save_options".into(),
                message: "the save has an invalid Generation III option value".into(),
                section_id: None,
                warning: None,
            });
            checks.push(rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 20,
                        storage: Storage::U16Le,
                        mask: Some(248),
                    }
                    .read(bytes)?)
                        <= (19i64))
                }),
                code: "save_options".into(),
                message: "the save has an invalid Generation III option value".into(),
                section_id: None,
                warning: None,
            });
            for item in 0..50 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(5272, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (address
                                        .scalar(5274, Storage::U16Le, None)
                                        .read(bytes)?))
                                    && ((address
                                        .scalar(5274, Storage::U16Le, None)
                                        .read(bytes)?)
                                        <= (999i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            for item in 0..30 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(5472, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (if (address
                                        .scalar(5472, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5474, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }))
                                    && ((if (address
                                        .scalar(5472, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5474, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }) <= (99i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            for item in 0..30 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(5592, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (if (address
                                        .scalar(5592, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5594, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }))
                                    && ((if (address
                                        .scalar(5592, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5594, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }) <= (1i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            for item in 0..80 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(5712, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (if (address
                                        .scalar(5712, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5714, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }))
                                    && ((if (address
                                        .scalar(5712, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5714, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }) <= (99i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            for item in 0..46 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(6032, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (if (address
                                        .scalar(6032, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(6034, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }))
                                    && ((if (address
                                        .scalar(6032, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(6034, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 172,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }) <= (999i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            checks.push(rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 3768,
                        storage: Storage::U16Le,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (9999i64))
                }),
                code: "save_battle_points".into(),
                message: "the save has battle points above the game limit".into(),
                section_id: None,
                warning: None,
            });
            checks
        };
    game
}

fn game_pokemon_firered_leafgreen(id: &str, name: &str) -> GameDefinition {
    let mut game = default();
    game.id = id.into();
    game.name = name.into();
    let mut fields = vec![
        FieldDefinition::new(
            "trainer.name".into(),
            "Trainer name".into(),
            0,
            Storage::Ascii,
        )
        .description("English trainer text".into())
        .length(7)
        .behavior(field::FieldBehavior {
            text_codec: Some("pokemon_gen3_english".into()),
            presentation: Some(field::Presentation {
                step: Some(None),
                encoding: Some(Some("pokemon_gen3_english".into())),
                ..field::Presentation::new(0, 0)
            }),
            ..Default::default()
        }),
        FieldDefinition::new("trainer.gender".into(), "Gender".into(), 8, Storage::U8)
            .description("Player gender".into())
            .choices(gender())
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["male".into(), "female".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 8)
                }),
                ..Default::default()
            }),
        FieldDefinition::new("trainer.id".into(), "Trainer ID".into(), 10, Storage::U16Le)
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 10)
                }),
                ..Default::default()
            }),
        FieldDefinition::new(
            "trainer.secret_id".into(),
            "Secret ID".into(),
            12,
            Storage::U16Le,
        )
        .description("Hidden trainer identifier".into())
        .min(0)
        .max(65535)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                step: Some(None),
                ..field::Presentation::new(0, 12)
            }),
            ..Default::default()
        }),
        FieldDefinition::new("trainer.money".into(), "Money".into(), 4752, Storage::U32Le)
            .description("Money carried by the player".into())
            .min(0)
            .max(999999)
            .behavior(field::FieldBehavior {
                xor: Some(rules::ReadValue::new(move |bytes| {
                    rules::Scalar {
                        offset: 3872,
                        storage: Storage::U32Le,
                        mask: None,
                    }
                    .read(bytes)
                })),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(1, 656)
                }),
                ..Default::default()
            }),
        FieldDefinition::new("trainer.coins".into(), "Coins".into(), 4756, Storage::U16Le)
            .description("Game Corner coins".into())
            .min(0)
            .max(9999)
            .behavior(field::FieldBehavior {
                xor: Some(rules::ReadValue::new(move |bytes| {
                    rules::Scalar {
                        offset: 3872,
                        storage: Storage::U16Le,
                        mask: None,
                    }
                    .read(bytes)
                })),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(1, 660)
                }),
                ..Default::default()
            }),
        FieldDefinition::new(
            "trainer.play_time".into(),
            "Play time".into(),
            14,
            Storage::Ascii,
        )
        .description("Time played".into())
        .length(1)
        .editable(false)
        .behavior(field::FieldBehavior {
            format: Some(vec![
                field::FormatPart::Number {
                    value: rules::ReadValue::new(move |bytes| {
                        rules::Scalar {
                            offset: 14,
                            storage: Storage::U16Le,
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
                            offset: 16,
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
                            offset: 17,
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
                            offset: 18,
                            storage: Storage::U8,
                            mask: None,
                        }
                        .read(bytes)
                    }),
                    width: 2,
                },
            ]),
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec![],
                }),
                step: Some(None),
                encoding: Some(None),
                ..field::Presentation::new(0, 14)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_hours".into(),
            "Play time hours".into(),
            14,
            Storage::U16Le,
        )
        .description("Hours played".into())
        .min(0)
        .max(65535)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 14)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_minutes".into(),
            "Play time minutes".into(),
            16,
            Storage::U8,
        )
        .description("Minutes in the current hour".into())
        .min(0)
        .max(59)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 16)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_seconds".into(),
            "Play time seconds".into(),
            17,
            Storage::U8,
        )
        .description("Seconds in the current minute".into())
        .min(0)
        .max(59)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 17)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "trainer.play_time_frames".into(),
            "Play time frames".into(),
            18,
            Storage::U8,
        )
        .description("Frames in the current second".into())
        .min(0)
        .max(59)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 18)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.button_mode".into(),
            "Button mode".into(),
            19,
            Storage::U8,
        )
        .description("A-button and shoulder-button behavior".into())
        .choices(button_mode())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec!["help".into(), "lr".into(), "l_equals_a".into()],
                }),
                step: Some(None),
                ..field::Presentation::new(0, 19)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.text_speed".into(),
            "Text speed".into(),
            20,
            Storage::U16Le,
        )
        .description("Text speed: 0 slow, 1 medium, 2 fast".into())
        .min(0)
        .max(2)
        .mask(7)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.window_frame".into(),
            "Window frame".into(),
            20,
            Storage::U16Le,
        )
        .description("Text window frame type".into())
        .min(0)
        .max(19)
        .mask(248)
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new("options.sound".into(), "Sound".into(), 20, Storage::U16Le)
            .description("Sound output mode".into())
            .mask(256)
            .choices(sound())
            .behavior(field::FieldBehavior {
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["mono".into(), "stereo".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 20)
                }),
                ..Default::default()
            }),
        FieldDefinition::new(
            "options.battle_style".into(),
            "Battle style".into(),
            20,
            Storage::U16Le,
        )
        .description("Whether the game offers a switch after a foe faints".into())
        .mask(512)
        .choices(battle_style())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec!["shift".into(), "set".into()],
                }),
                step: Some(None),
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.battle_scene".into(),
            "Battle scene".into(),
            20,
            Storage::U16Le,
        )
        .description("Battle animation mode".into())
        .mask(1024)
        .choices(battle_scene())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                constraints: Some(SaveConstraint {
                    min: None,
                    max: None,
                    max_length: None,
                    choices: vec!["on".into(), "off".into()],
                }),
                step: Some(None),
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
        FieldDefinition::new(
            "options.region_map_zoom".into(),
            "Region map zoom".into(),
            21,
            Storage::Bit,
        )
        .bit(3)
        .description("Region map zoom state".into())
        .behavior(field::FieldBehavior {
            presentation: Some(field::Presentation {
                kind: Some(SaveFieldKind::Boolean),
                step: Some(None),
                ..field::Presentation::new(0, 20)
            }),
            ..Default::default()
        }),
    ];
    let scope = FieldScope::default();
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(30, 1, 0, 0, 32, false, "inventory"),
        frlg_pc,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(42, 1, 0, 0, 32, false, "inventory"),
        frlg_items,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(30, 1, 0, 0, 32, false, "inventory"),
        frlg_key_items,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(13, 1, 0, 0, 32, false, "inventory"),
        frlg_balls,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(58, 1, 0, 0, 32, false, "inventory"),
        frlg_tm_hm,
    );
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(43, 1, 0, 0, 32, false, "inventory"),
        frlg_berries,
    );
    {
        for item in 0..386 {
            let number = item + 1;
            let index = format!("{number:03}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8,
                bits: item,
                bit_stride: true,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("pokedex");
            fields.extend(frlg_dex_owned(&child));
        }
    }
    {
        for item in 0..386 {
            let number = item + 1;
            let index = format!("{number:03}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8,
                bits: item,
                bit_stride: true,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("pokedex");
            fields.extend(frlg_dex_seen(&child));
        }
    }
    extend_fields(
        &mut fields,
        &scope,
        Repetition::new(1, 0, 0, 0, 0, false, ""),
        frlg_tail,
    );
    game.fields = fields;
    game.runtime.family = Some("pokemon-gen3-frlg".into());
    game.runtime.checksum_sizes = vec![
        3876, 3968, 3968, 3968, 3816, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 3968, 2000,
    ];
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "save".into(),
            logical_offset: 0,
            logical_length: 55680,
            copies: layout::Copies::Tagged {
                candidates: vec![
                    layout::TaggedCandidate {
                        offset: 0,
                        section_count: 14,
                    },
                    layout::TaggedCandidate {
                        offset: 57344,
                        section_count: 14,
                    },
                ],
                sections: vec![
                    layout::TaggedSection {
                        id: 0,
                        logical_offset: 0,
                        length: 4096,
                        checksum_length: 3876,
                    },
                    layout::TaggedSection {
                        id: 1,
                        logical_offset: 4096,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 2,
                        logical_offset: 8064,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 3,
                        logical_offset: 12032,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 4,
                        logical_offset: 16000,
                        length: 3968,
                        checksum_length: 3816,
                    },
                    layout::TaggedSection {
                        id: 5,
                        logical_offset: 19968,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 6,
                        logical_offset: 23936,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 7,
                        logical_offset: 27904,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 8,
                        logical_offset: 31872,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 9,
                        logical_offset: 35840,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 10,
                        logical_offset: 39808,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 11,
                        logical_offset: 43776,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 12,
                        logical_offset: 47744,
                        length: 3968,
                        checksum_length: 3968,
                    },
                    layout::TaggedSection {
                        id: 13,
                        logical_offset: 51712,
                        length: 3968,
                        checksum_length: 2000,
                    },
                ],
                section_size: 4096,
                id_offset: 4084,
                checksum_offset: 4086,
                checksum_algorithm: None,
                checksum_unit: None,
                signature_offset: 4088,
                counter_offset: 4092,
                signature: 134291493,
            },
            selection: layout::Selection::NewestCounterMaxToZeroErrorOnTie,
            write: layout::WritePolicy::Selected,
            empty: vec![255],
            empty_if_no_signature: true,
        }],
    });
    game.runtime.checks =
        {
            let mut checks = vec![
                rules::Check {
                    when: None,
                    assert: rules::Condition::new(move |bytes| {
                        Ok((rules::Scalar {
                            offset: 8,
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
                rules::Check {
                    when: None,
                    assert: rules::Condition::new(move |bytes| {
                        Ok(((rules::Scalar {
                            offset: 4752,
                            storage: Storage::U32Le,
                            mask: None,
                        }
                        .read(bytes)?)
                            ^ (rules::Scalar {
                                offset: 3872,
                                storage: Storage::U32Le,
                                mask: None,
                            }
                            .read(bytes)?))
                            <= (999999i64))
                    }),
                    code: "save_money".into(),
                    message: "the save has a money value above the game limit".into(),
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
                            Ok((address.scalar(16, Storage::U8, None).read(bytes)?) <= (59i64))
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
                        offset: 19,
                        storage: Storage::U8,
                        mask: None,
                    }
                    .read(bytes)?)
                        <= (2i64))
                }),
                code: "save_options".into(),
                message: "the save has an invalid Generation III option value".into(),
                section_id: None,
                warning: None,
            });
            checks.push(rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 20,
                        storage: Storage::U16Le,
                        mask: Some(7),
                    }
                    .read(bytes)?)
                        <= (2i64))
                }),
                code: "save_options".into(),
                message: "the save has an invalid Generation III option value".into(),
                section_id: None,
                warning: None,
            });
            checks.push(rules::Check {
                when: None,
                assert: rules::Condition::new(move |bytes| {
                    Ok((rules::Scalar {
                        offset: 20,
                        storage: Storage::U16Le,
                        mask: Some(248),
                    }
                    .read(bytes)?)
                        <= (19i64))
                }),
                code: "save_options".into(),
                message: "the save has an invalid Generation III option value".into(),
                section_id: None,
                warning: None,
            });
            for item in 0..30 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(4760, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (address
                                        .scalar(4762, Storage::U16Le, None)
                                        .read(bytes)?))
                                    && ((address
                                        .scalar(4762, Storage::U16Le, None)
                                        .read(bytes)?)
                                        <= (999i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            for item in 0..42 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(4880, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (if (address
                                        .scalar(4880, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(4882, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 3872,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }))
                                    && ((if (address
                                        .scalar(4880, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(4882, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 3872,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }) <= (999i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            for item in 0..30 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(5048, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (if (address
                                        .scalar(5048, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5050, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 3872,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }))
                                    && ((if (address
                                        .scalar(5048, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5050, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 3872,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }) <= (1i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            for item in 0..114 {
                let scope = FieldScope {
                    base: item * 4,
                    ..Default::default()
                };
                checks.push(rules::Check {
                    when: None,
                    assert: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok(((address.scalar(5168, Storage::U16Le, None).read(bytes)?)
                                == (0i64))
                                || (((1i64)
                                    <= (if (address
                                        .scalar(5168, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5170, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 3872,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }))
                                    && ((if (address
                                        .scalar(5168, Storage::U16Le, None)
                                        .read(bytes)?)
                                        == (0i64)
                                    {
                                        0i64
                                    } else {
                                        (address.scalar(5170, Storage::U16Le, None).read(bytes)?)
                                            ^ (rules::Scalar {
                                                offset: 3872,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                    }) <= (999i64))))
                        })
                    },
                    code: "save_inventory_quantity".into(),
                    message: "an occupied inventory slot has an invalid quantity".into(),
                    section_id: None,
                    warning: None,
                });
            }
            checks
        };
    game
}
