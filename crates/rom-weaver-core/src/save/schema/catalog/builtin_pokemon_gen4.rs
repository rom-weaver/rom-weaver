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

fn dp_fields(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("trainer.id", "Trainer ID", 116, Storage::U16Le)
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 116).step(None)),
        scope
            .field("trainer.secret_id", "Secret ID", 118, Storage::U16Le)
            .description("Hidden trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 118).step(None)),
        scope
            .field("trainer.gender", "Gender", 124, Storage::U8)
            .description("Player gender".into())
            .choices(gender())
            .presentation(
                field::Presentation::new(0, 124)
                    .choices(vec!["male".into(), "female".into()])
                    .step(None),
            ),
        scope
            .field("trainer.money", "Money", 120, Storage::U32Le)
            .description("Money carried by the player".into())
            .min(0)
            .max(999999)
            .presentation(field::Presentation::new(0, 120)),
        scope
            .field("trainer.play_time", "Play time", 134, Storage::Ascii)
            .description("Time played".into())
            .length(1)
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 134,
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
                                offset: 136,
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
                                offset: 137,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(
                    field::Presentation::new(0, 134)
                        .constraints(SaveConstraint::default())
                        .step(None)
                        .encoding(None),
                ),
                ..Default::default()
            }),
        scope
            .field("trainer.coins", "Coins", 132, Storage::U16Le)
            .description("Game Corner coins".into())
            .min(0)
            .max(50000)
            .presentation(field::Presentation::new(0, 132)),
        scope
            .field(
                "trainer.play_time_hours",
                "Play time hours",
                134,
                Storage::U16Le,
            )
            .description("Hours played".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 134)),
        scope
            .field(
                "trainer.play_time_minutes",
                "Play time minutes",
                136,
                Storage::U8,
            )
            .description("Minutes in the current hour".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 136)),
        scope
            .field(
                "trainer.play_time_seconds",
                "Play time seconds",
                137,
                Storage::U8,
            )
            .description("Seconds in the current minute".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 137)),
        scope
            .field(
                "progress.battle_points",
                "Battle Points",
                26104,
                Storage::U16Le,
            )
            .description("Battle Frontier points".into())
            .min(0)
            .max(9999)
            .presentation(field::Presentation::new(0, 26104)),
        scope
            .bit_field("progress.badge_1", "Coal Badge", 126, 0)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_2", "Forest Badge", 126, 1)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_3", "Cobble Badge", 126, 2)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_4", "Fen Badge", 126, 3)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_5", "Relic Badge", 126, 4)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_6", "Mine Badge", 126, 5)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_7", "Icicle Badge", 126, 6)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_8", "Beacon Badge", 126, 7)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
    ];

    fields
}

fn pt_fields(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("trainer.id", "Trainer ID", 120, Storage::U16Le)
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 120).step(None)),
        scope
            .field("trainer.secret_id", "Secret ID", 122, Storage::U16Le)
            .description("Hidden trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 122).step(None)),
        scope
            .field("trainer.gender", "Gender", 128, Storage::U8)
            .description("Player gender".into())
            .choices(gender())
            .presentation(
                field::Presentation::new(0, 128)
                    .choices(vec!["male".into(), "female".into()])
                    .step(None),
            ),
        scope
            .field("trainer.money", "Money", 124, Storage::U32Le)
            .description("Money carried by the player".into())
            .min(0)
            .max(999999)
            .presentation(field::Presentation::new(0, 124)),
        scope
            .field("trainer.play_time", "Play time", 138, Storage::Ascii)
            .description("Time played".into())
            .length(1)
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 138,
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
                                offset: 140,
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
                                offset: 141,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(
                    field::Presentation::new(0, 138)
                        .constraints(SaveConstraint::default())
                        .step(None)
                        .encoding(None),
                ),
                ..Default::default()
            }),
        scope
            .field("trainer.coins", "Coins", 136, Storage::U16Le)
            .description("Game Corner coins".into())
            .min(0)
            .max(50000)
            .presentation(field::Presentation::new(0, 136)),
        scope
            .field(
                "trainer.play_time_hours",
                "Play time hours",
                138,
                Storage::U16Le,
            )
            .description("Hours played".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 138)),
        scope
            .field(
                "trainer.play_time_minutes",
                "Play time minutes",
                140,
                Storage::U8,
            )
            .description("Minutes in the current hour".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 140)),
        scope
            .field(
                "trainer.play_time_seconds",
                "Play time seconds",
                141,
                Storage::U8,
            )
            .description("Seconds in the current minute".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 141)),
        scope
            .field(
                "progress.battle_points",
                "Battle Points",
                29236,
                Storage::U16Le,
            )
            .description("Battle Frontier points".into())
            .min(0)
            .max(9999)
            .presentation(field::Presentation::new(0, 29236)),
        scope
            .bit_field("progress.badge_1", "Coal Badge", 130, 0)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
        scope
            .bit_field("progress.badge_2", "Forest Badge", 130, 1)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
        scope
            .bit_field("progress.badge_3", "Cobble Badge", 130, 2)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
        scope
            .bit_field("progress.badge_4", "Fen Badge", 130, 3)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
        scope
            .bit_field("progress.badge_5", "Relic Badge", 130, 4)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
        scope
            .bit_field("progress.badge_6", "Mine Badge", 130, 5)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
        scope
            .bit_field("progress.badge_7", "Icicle Badge", 130, 6)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
        scope
            .bit_field("progress.badge_8", "Beacon Badge", 130, 7)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 130).step(None)),
    ];

    fields
}

fn hgss_fields(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field("trainer.id", "Trainer ID", 116, Storage::U16Le)
            .description("Public trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 116).step(None)),
        scope
            .field("trainer.secret_id", "Secret ID", 118, Storage::U16Le)
            .description("Hidden trainer identifier".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 118).step(None)),
        scope
            .field("trainer.gender", "Gender", 124, Storage::U8)
            .description("Player gender".into())
            .choices(gender())
            .presentation(
                field::Presentation::new(0, 124)
                    .choices(vec!["male".into(), "female".into()])
                    .step(None),
            ),
        scope
            .field("trainer.money", "Money", 120, Storage::U32Le)
            .description("Money carried by the player".into())
            .min(0)
            .max(999999)
            .presentation(field::Presentation::new(0, 120)),
        scope
            .field("trainer.play_time", "Play time", 134, Storage::Ascii)
            .description("Time played".into())
            .length(1)
            .editable(false)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                format: Some(vec![
                    field::FormatPart::Number {
                        value: rules::ReadValue::new(move |bytes| {
                            rules::Scalar {
                                offset: 134,
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
                                offset: 136,
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
                                offset: 137,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)
                        }),
                        width: 2,
                    },
                ]),
                presentation: Some(
                    field::Presentation::new(0, 134)
                        .constraints(SaveConstraint::default())
                        .step(None)
                        .encoding(None),
                ),
                ..Default::default()
            }),
        scope
            .field("trainer.coins", "Coins", 132, Storage::U16Le)
            .description("Game Corner coins".into())
            .min(0)
            .max(50000)
            .presentation(field::Presentation::new(0, 132)),
        scope
            .field(
                "trainer.play_time_hours",
                "Play time hours",
                134,
                Storage::U16Le,
            )
            .description("Hours played".into())
            .min(0)
            .max(65535)
            .presentation(field::Presentation::new(0, 134)),
        scope
            .field(
                "trainer.play_time_minutes",
                "Play time minutes",
                136,
                Storage::U8,
            )
            .description("Minutes in the current hour".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 136)),
        scope
            .field(
                "trainer.play_time_seconds",
                "Play time seconds",
                137,
                Storage::U8,
            )
            .description("Seconds in the current minute".into())
            .min(0)
            .max(59)
            .presentation(field::Presentation::new(0, 137)),
        scope
            .field(
                "progress.battle_points",
                "Battle Points",
                23480,
                Storage::U16Le,
            )
            .description("Battle Frontier points".into())
            .min(0)
            .max(9999)
            .presentation(field::Presentation::new(0, 23480)),
        scope
            .bit_field("progress.badge_1", "Zephyr Badge", 126, 0)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_2", "Hive Badge", 126, 1)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_3", "Plain Badge", 126, 2)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_4", "Fog Badge", 126, 3)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_5", "Storm Badge", 126, 4)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_6", "Mineral Badge", 126, 5)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_7", "Glacier Badge", 126, 6)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_8", "Rising Badge", 126, 7)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 126).step(None)),
        scope
            .bit_field("progress.badge_9", "Boulder Badge", 131, 0)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
        scope
            .bit_field("progress.badge_10", "Cascade Badge", 131, 1)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
        scope
            .bit_field("progress.badge_11", "Thunder Badge", 131, 2)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
        scope
            .bit_field("progress.badge_12", "Rainbow Badge", 131, 3)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
        scope
            .bit_field("progress.badge_13", "Soul Badge", 131, 4)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
        scope
            .bit_field("progress.badge_14", "Marsh Badge", 131, 5)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
        scope
            .bit_field("progress.badge_15", "Volcano Badge", 131, 6)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
        scope
            .bit_field("progress.badge_16", "Earth Badge", 131, 7)
            .description("Gym badge flag".into())
            .presentation(field::Presentation::new(0, 131).step(None)),
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
            dp_fields,
        );
        GameDefinition {
 fields,
 runtime: runtime::Runtime {
 family: Some("pokemon-gen4-dppt".into()),
 handler_id: Some("pokemon-gen4".into()),
 save_format: Some("nintendo_ds_512k".into()),
 save_format_name: Some("Nintendo DS save 512 KiB".into()),
 logical_size: Some(262144),
 layout: Some(layout::Layout {
 groups: vec![layout::Group {
 id: "save".into(),
 logical_offset: 0,
 logical_length: 262144,
 copies: layout::Copies::Fixed {
 candidates: vec![layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 0,
 physical_offset: 0,
 length: 262144 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(0),
 length: Some(49392),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 49406) }
,
 ChecksumDefinition {
 start: Some(49408),
 length: Some(74192),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 123614) }
],
 repairs: vec![layout::Repair::Checksum {
 checksum: ChecksumDefinition {
 start: Some(0),
 length: Some(49392),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 49406) }
 }
,
 layout::Repair::Checksum {
 checksum: ChecksumDefinition {
 start: Some(49408),
 length: Some(74192),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 123614) }
 }
],
 predicates: vec![rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 49396,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (49408i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 49400,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (537265699i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 49404,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?) == (0i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 123604,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (74208i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 123608,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (537265699i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 123612,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?) == (1i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 49392,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (rules::Scalar {
 offset: 123600,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?)))],
 sections: vec![layout::FixedSection {
 id: 0,
 physical_offset: 0,
 checksum: ChecksumDefinition {
 start: Some(0),
 length: Some(49392),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 49406) }
,
 signature: Some(rules::Scalar {
 offset: 49400,
 storage: Storage::U32Le,
 mask: None }
),
 counter: Some(rules::Scalar {
 offset: 49392,
 storage: Storage::U32Le,
 mask: None }
) }
,
 layout::FixedSection {
 id: 1,
 physical_offset: 49408,
 checksum: ChecksumDefinition {
 start: Some(49408),
 length: Some(74192),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 123614) }
,
 signature: Some(rules::Scalar {
 offset: 123608,
 storage: Storage::U32Le,
 mask: None }
),
 counter: Some(rules::Scalar {
 offset: 123600,
 storage: Storage::U32Le,
 mask: None }
) }
],
 counter: Some(rules::Scalar {
 offset: 49392,
 storage: Storage::U32Le,
 mask: None }
),
 ..Default::default() }
,
 layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 0,
 physical_offset: 262144,
 length: 262144 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(262144),
 length: Some(49392),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 311550) }
,
 ChecksumDefinition {
 start: Some(311552),
 length: Some(74192),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 385758) }
],
 repairs: vec![layout::Repair::Checksum {
 checksum: ChecksumDefinition {
 start: Some(262144),
 length: Some(49392),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 311550) }
 }
,
 layout::Repair::Checksum {
 checksum: ChecksumDefinition {
 start: Some(311552),
 length: Some(74192),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 385758) }
 }
],
 predicates: vec![rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 311540,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (49408i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 311544,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (537265699i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 311548,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?) == (0i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 385748,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (74208i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 385752,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (537265699i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 385756,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?) == (1i64))),
 rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 311536,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) == (rules::Scalar {
 offset: 385744,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?)))],
 sections: vec![layout::FixedSection {
 id: 0,
 physical_offset: 262144,
 checksum: ChecksumDefinition {
 start: Some(262144),
 length: Some(49392),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 311550) }
,
 signature: Some(rules::Scalar {
 offset: 311544,
 storage: Storage::U32Le,
 mask: None }
),
 counter: Some(rules::Scalar {
 offset: 311536,
 storage: Storage::U32Le,
 mask: None }
) }
,
 layout::FixedSection {
 id: 1,
 physical_offset: 311552,
 checksum: ChecksumDefinition {
 start: Some(311552),
 length: Some(74192),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Crc16CcittFalseLe,
 385758) }
,
 signature: Some(rules::Scalar {
 offset: 385752,
 storage: Storage::U32Le,
 mask: None }
),
 counter: Some(rules::Scalar {
 offset: 385744,
 storage: Storage::U32Le,
 mask: None }
) }
],
 counter: Some(rules::Scalar {
 offset: 311536,
 storage: Storage::U32Le,
 mask: None }
),
 ..Default::default() }
] }
,
 selection: layout::Selection::NewestCounterMaxToZero,
 write: layout::WritePolicy::Selected,
 empty: vec![255],
 empty_if_no_signature: false }
] }
),
 recognition: Some(runtime::Recognition {
 checks: Vec::new(),
 reasons: vec![SaveRecognitionReason::ChecksumValid,
 SaveRecognitionReason::SignatureValid,
 SaveRecognitionReason::CounterUniform],
 confidence: SaveRecognitionConfidence::High,
 incomplete_confidence: None,
 selected_reason: true,
 empty_top_level_reasons: true }
),
 checks: {
 let mut checks = vec![rules::Check {
 when: None,
 assert: rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 124,
 storage: Storage::U8,
 mask: None }
.read(bytes)?) <= (1i64))),
 code: "save_gender".into(),
 message: "the save has an invalid player gender value".into(),
 section_id: None,
 warning: None }
,
 rules::Check {
 when: None,
 assert: rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 120,
 storage: Storage::U32Le,
 mask: None }
.read(bytes)?) <= (999999i64))),
 code: "save_money".into(),
 message: "the save has a money value above the game limit".into(),
 section_id: None,
 warning: None }
,
 rules::Check {
 when: None,
 assert: rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 132,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?) <= (50000i64))),
 code: "save_coins".into(),
 message: "the save has coins above the game limit".into(),
 section_id: None,
 warning: None }
,
 rules::Check {
 when: None,
 assert: rules::Condition::new(move |bytes| Ok((rules::Scalar {
 offset: 26104,
 storage: Storage::U16Le,
 mask: None }
.read(bytes)?) <= (9999i64))),
 code: "save_battle_points".into(),
 message: "the save has battle points above the game limit".into(),
 section_id: None,
 warning: None }
];
for item in 0..2 { let scope = FieldScope { base: item, ..Default::default() };
checks.push(rules::Check {
 when: None,
 assert: {
 let address = scope.address(); rules::Condition::new(move |bytes| Ok((address.scalar(136,
 Storage::U8,
 None).read(bytes)?) <= (59i64))) }
,
 code: "save_play_time".into(),
 message: "the save has an invalid play-time minute or second value".into(),
 section_id: None,
 warning: None }
); }

checks }
,
 recovery: Some(runtime::Recovery {
 no_valid: runtime::Failure {
 code: "save_checksum".into(),
 message: "the main save block checksum is invalid".into() }
,
 incomplete: Some(runtime::RecoveryOutcome {
 state: SaveIntegrityState::ValidWithWarnings,
 disable_editing: true,
 issue: Some(runtime::Failure {
 code: "redundant_slot_empty".into(),
 message: "The redundant save copy is empty".into() }
),
 warning: Some("The redundant save copy is empty; the editor preserves it".into()),
 field_warning: None,
 edit_error: Some(runtime::Failure {
 code: "save_integrity_partial".into(),
 message: "normal edits need two valid Pokémon HeartGold or SoulSilver save copies".into() }
),
 parse_error: None,
 section_id: false }
),
 damaged: Some(runtime::RecoveryOutcome {
 state: SaveIntegrityState::PartiallyRecoverable,
 disable_editing: true,
 issue: Some(runtime::Failure {
 code: "redundant_slot_invalid".into(),
 message: "One redundant save copy failed integrity checks".into() }
),
 warning: Some("One redundant save copy is invalid; normal editing is disabled".into()),
 field_warning: None,
 edit_error: Some(runtime::Failure {
 code: "save_integrity_partial".into(),
 message: "normal edits need two valid Pokémon HeartGold or SoulSilver save copies".into() }
),
 parse_error: None,
 section_id: false }
),
 unrecoverable: None,
 differing: None,
 active_group: false,
 zero_counter: false }
),
 ..Default::default() }
,
 ..GameDefinition::new("".into(),
 "".into(),
 "nds".into(),
 524288) }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games =
        vec![
            {
                let mut game = default();
                game.id = "pokemon-diamond".into();
                game.name = "Pokémon Diamond".into();
                game
            },
            {
                let mut game = default();
                game.id = "pokemon-pearl".into();
                game.name = "Pokémon Pearl".into();
                game
            },
            {
                let mut game = default();
                game.id = "pokemon-platinum".into();
                game.name = "Pokémon Platinum".into();
                let mut fields = vec![];
                let scope = FieldScope::default();
                extend_fields(
                    &mut fields,
                    &scope,
                    Repetition::new(1, 0, 0, 0, 0, false, ""),
                    pt_fields,
                );
                game.fields = fields;
                game.runtime.layout = Some(layout::Layout {
                    groups: vec![layout::Group {
                        id: "save".into(),
                        logical_offset: 0,
                        logical_length: 262144,
                        copies: layout::Copies::Fixed {
                            candidates: vec![
                                layout::Candidate {
                                    spans: vec![layout::Span {
                                        logical_offset: 0,
                                        physical_offset: 0,
                                        length: 262144,
                                    }],
                                    checksums: vec![
                                        ChecksumDefinition {
                                            start: Some(0),
                                            length: Some(53020),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                53034,
                                            )
                                        },
                                        ChecksumDefinition {
                                            start: Some(53036),
                                            length: Some(74196),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                127246,
                                            )
                                        },
                                    ],
                                    repairs: vec![
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(0),
                                                length: Some(53020),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    53034,
                                                )
                                            },
                                        },
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(53036),
                                                length: Some(74196),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    127246,
                                                )
                                            },
                                        },
                                    ],
                                    predicates: vec![
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 53024,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (53036i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 53028,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 53032,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (0i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 127236,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (74212i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 127240,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 127244,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (1i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 53020,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (rules::Scalar {
                                                    offset: 127232,
                                                    storage: Storage::U32Le,
                                                    mask: None,
                                                }
                                                .read(bytes)?))
                                        }),
                                    ],
                                    sections: vec![
                                        layout::FixedSection {
                                            id: 0,
                                            physical_offset: 0,
                                            checksum: ChecksumDefinition {
                                                start: Some(0),
                                                length: Some(53020),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    53034,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 53028,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 53020,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                        layout::FixedSection {
                                            id: 1,
                                            physical_offset: 53036,
                                            checksum: ChecksumDefinition {
                                                start: Some(53036),
                                                length: Some(74196),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    127246,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 127240,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 127232,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                    ],
                                    counter: Some(rules::Scalar {
                                        offset: 53020,
                                        storage: Storage::U32Le,
                                        mask: None,
                                    }),
                                    ..Default::default()
                                },
                                layout::Candidate {
                                    spans: vec![layout::Span {
                                        logical_offset: 0,
                                        physical_offset: 262144,
                                        length: 262144,
                                    }],
                                    checksums: vec![
                                        ChecksumDefinition {
                                            start: Some(262144),
                                            length: Some(53020),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                315178,
                                            )
                                        },
                                        ChecksumDefinition {
                                            start: Some(315180),
                                            length: Some(74196),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                389390,
                                            )
                                        },
                                    ],
                                    repairs: vec![
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(262144),
                                                length: Some(53020),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    315178,
                                                )
                                            },
                                        },
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(315180),
                                                length: Some(74196),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    389390,
                                                )
                                            },
                                        },
                                    ],
                                    predicates: vec![
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 315168,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (53036i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 315172,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 315176,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (0i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 389380,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (74212i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 389384,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 389388,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (1i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 315164,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (rules::Scalar {
                                                    offset: 389376,
                                                    storage: Storage::U32Le,
                                                    mask: None,
                                                }
                                                .read(bytes)?))
                                        }),
                                    ],
                                    sections: vec![
                                        layout::FixedSection {
                                            id: 0,
                                            physical_offset: 262144,
                                            checksum: ChecksumDefinition {
                                                start: Some(262144),
                                                length: Some(53020),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    315178,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 315172,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 315164,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                        layout::FixedSection {
                                            id: 1,
                                            physical_offset: 315180,
                                            checksum: ChecksumDefinition {
                                                start: Some(315180),
                                                length: Some(74196),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    389390,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 389384,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 389376,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                    ],
                                    counter: Some(rules::Scalar {
                                        offset: 315164,
                                        storage: Storage::U32Le,
                                        mask: None,
                                    }),
                                    ..Default::default()
                                },
                            ],
                        },
                        selection: layout::Selection::NewestCounterMaxToZero,
                        write: layout::WritePolicy::Selected,
                        empty: vec![255],
                        empty_if_no_signature: false,
                    }],
                });
                game.runtime.checks = {
                    let mut checks = vec![
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 128,
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
                                    offset: 124,
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
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 136,
                                    storage: Storage::U16Le,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (50000i64))
                            }),
                            code: "save_coins".into(),
                            message: "the save has coins above the game limit".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 29236,
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
                                    Ok((address.scalar(140, Storage::U8, None).read(bytes)?)
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
                    checks
                };
                game
            },
            {
                let mut game = default();
                game.id = "pokemon-heartgold".into();
                game.name = "Pokémon HeartGold".into();
                let mut fields = vec![];
                let scope = FieldScope::default();
                extend_fields(
                    &mut fields,
                    &scope,
                    Repetition::new(1, 0, 0, 0, 0, false, ""),
                    hgss_fields,
                );
                game.fields = fields;
                game.runtime.family = Some("pokemon-gen4-hgss".into());
                game.runtime.layout = Some(layout::Layout {
                    groups: vec![layout::Group {
                        id: "save".into(),
                        logical_offset: 0,
                        logical_length: 262144,
                        copies: layout::Copies::Fixed {
                            candidates: vec![
                                layout::Candidate {
                                    spans: vec![layout::Span {
                                        logical_offset: 0,
                                        physical_offset: 0,
                                        length: 262144,
                                    }],
                                    checksums: vec![
                                        ChecksumDefinition {
                                            start: Some(0),
                                            length: Some(63000),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                63014,
                                            )
                                        },
                                        ChecksumDefinition {
                                            start: Some(63232),
                                            length: Some(74496),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                137742,
                                            )
                                        },
                                    ],
                                    repairs: vec![
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(0),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    63014,
                                                )
                                            },
                                        },
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(63232),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    137742,
                                                )
                                            },
                                        },
                                    ],
                                    predicates: vec![
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63004,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (63016i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63008,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63012,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (0i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 137732,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (74512i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 137736,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 137740,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (1i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63000,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (rules::Scalar {
                                                    offset: 137728,
                                                    storage: Storage::U32Le,
                                                    mask: None,
                                                }
                                                .read(bytes)?))
                                        }),
                                    ],
                                    sections: vec![
                                        layout::FixedSection {
                                            id: 0,
                                            physical_offset: 0,
                                            checksum: ChecksumDefinition {
                                                start: Some(0),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    63014,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 63008,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 63000,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                        layout::FixedSection {
                                            id: 1,
                                            physical_offset: 63232,
                                            checksum: ChecksumDefinition {
                                                start: Some(63232),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    137742,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 137736,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 137728,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                    ],
                                    counter: Some(rules::Scalar {
                                        offset: 63000,
                                        storage: Storage::U32Le,
                                        mask: None,
                                    }),
                                    ..Default::default()
                                },
                                layout::Candidate {
                                    spans: vec![layout::Span {
                                        logical_offset: 0,
                                        physical_offset: 262144,
                                        length: 262144,
                                    }],
                                    checksums: vec![
                                        ChecksumDefinition {
                                            start: Some(262144),
                                            length: Some(63000),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                325158,
                                            )
                                        },
                                        ChecksumDefinition {
                                            start: Some(325376),
                                            length: Some(74496),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                399886,
                                            )
                                        },
                                    ],
                                    repairs: vec![
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(262144),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    325158,
                                                )
                                            },
                                        },
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(325376),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    399886,
                                                )
                                            },
                                        },
                                    ],
                                    predicates: vec![
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325148,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (63016i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325152,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325156,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (0i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 399876,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (74512i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 399880,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 399884,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (1i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325144,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (rules::Scalar {
                                                    offset: 399872,
                                                    storage: Storage::U32Le,
                                                    mask: None,
                                                }
                                                .read(bytes)?))
                                        }),
                                    ],
                                    sections: vec![
                                        layout::FixedSection {
                                            id: 0,
                                            physical_offset: 262144,
                                            checksum: ChecksumDefinition {
                                                start: Some(262144),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    325158,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 325152,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 325144,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                        layout::FixedSection {
                                            id: 1,
                                            physical_offset: 325376,
                                            checksum: ChecksumDefinition {
                                                start: Some(325376),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    399886,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 399880,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 399872,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                    ],
                                    counter: Some(rules::Scalar {
                                        offset: 325144,
                                        storage: Storage::U32Le,
                                        mask: None,
                                    }),
                                    ..Default::default()
                                },
                            ],
                        },
                        selection: layout::Selection::NewestCounterMaxToZero,
                        write: layout::WritePolicy::Selected,
                        empty: vec![255],
                        empty_if_no_signature: false,
                    }],
                });
                game.runtime.recognition = Some(runtime::Recognition {
                    checks: vec![rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 128,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (7i64))
                        }),
                        code: "save_game_version".into(),
                        message: "the trainer profile does not match the selected game".into(),
                        section_id: None,
                        warning: None,
                    }],
                    reasons: vec![
                        SaveRecognitionReason::ChecksumValid,
                        SaveRecognitionReason::SignatureValid,
                        SaveRecognitionReason::CounterUniform,
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
                                    offset: 128,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (7i64))
                            }),
                            code: "save_game_version".into(),
                            message: "the trainer profile does not match the selected game".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 124,
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
                                    offset: 120,
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
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 132,
                                    storage: Storage::U16Le,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (50000i64))
                            }),
                            code: "save_coins".into(),
                            message: "the save has coins above the game limit".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 23480,
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
                                    Ok((address.scalar(136, Storage::U8, None).read(bytes)?)
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
                    checks
                };
                game
            },
            {
                let mut game = default();
                game.id = "pokemon-soulsilver".into();
                game.name = "Pokémon SoulSilver".into();
                let mut fields = vec![];
                let scope = FieldScope::default();
                extend_fields(
                    &mut fields,
                    &scope,
                    Repetition::new(1, 0, 0, 0, 0, false, ""),
                    hgss_fields,
                );
                game.fields = fields;
                game.runtime.family = Some("pokemon-gen4-hgss".into());
                game.runtime.layout = Some(layout::Layout {
                    groups: vec![layout::Group {
                        id: "save".into(),
                        logical_offset: 0,
                        logical_length: 262144,
                        copies: layout::Copies::Fixed {
                            candidates: vec![
                                layout::Candidate {
                                    spans: vec![layout::Span {
                                        logical_offset: 0,
                                        physical_offset: 0,
                                        length: 262144,
                                    }],
                                    checksums: vec![
                                        ChecksumDefinition {
                                            start: Some(0),
                                            length: Some(63000),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                63014,
                                            )
                                        },
                                        ChecksumDefinition {
                                            start: Some(63232),
                                            length: Some(74496),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                137742,
                                            )
                                        },
                                    ],
                                    repairs: vec![
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(0),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    63014,
                                                )
                                            },
                                        },
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(63232),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    137742,
                                                )
                                            },
                                        },
                                    ],
                                    predicates: vec![
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63004,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (63016i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63008,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63012,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (0i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 137732,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (74512i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 137736,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 137740,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (1i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 63000,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (rules::Scalar {
                                                    offset: 137728,
                                                    storage: Storage::U32Le,
                                                    mask: None,
                                                }
                                                .read(bytes)?))
                                        }),
                                    ],
                                    sections: vec![
                                        layout::FixedSection {
                                            id: 0,
                                            physical_offset: 0,
                                            checksum: ChecksumDefinition {
                                                start: Some(0),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    63014,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 63008,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 63000,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                        layout::FixedSection {
                                            id: 1,
                                            physical_offset: 63232,
                                            checksum: ChecksumDefinition {
                                                start: Some(63232),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    137742,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 137736,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 137728,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                    ],
                                    counter: Some(rules::Scalar {
                                        offset: 63000,
                                        storage: Storage::U32Le,
                                        mask: None,
                                    }),
                                    ..Default::default()
                                },
                                layout::Candidate {
                                    spans: vec![layout::Span {
                                        logical_offset: 0,
                                        physical_offset: 262144,
                                        length: 262144,
                                    }],
                                    checksums: vec![
                                        ChecksumDefinition {
                                            start: Some(262144),
                                            length: Some(63000),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                325158,
                                            )
                                        },
                                        ChecksumDefinition {
                                            start: Some(325376),
                                            length: Some(74496),
                                            ..ChecksumDefinition::new(
                                                ChecksumAlgorithm::Crc16CcittFalseLe,
                                                399886,
                                            )
                                        },
                                    ],
                                    repairs: vec![
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(262144),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    325158,
                                                )
                                            },
                                        },
                                        layout::Repair::Checksum {
                                            checksum: ChecksumDefinition {
                                                start: Some(325376),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    399886,
                                                )
                                            },
                                        },
                                    ],
                                    predicates: vec![
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325148,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (63016i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325152,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325156,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (0i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 399876,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (74512i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 399880,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (537265699i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 399884,
                                                storage: Storage::U16Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (1i64))
                                        }),
                                        rules::Condition::new(move |bytes| {
                                            Ok((rules::Scalar {
                                                offset: 325144,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }
                                            .read(bytes)?)
                                                == (rules::Scalar {
                                                    offset: 399872,
                                                    storage: Storage::U32Le,
                                                    mask: None,
                                                }
                                                .read(bytes)?))
                                        }),
                                    ],
                                    sections: vec![
                                        layout::FixedSection {
                                            id: 0,
                                            physical_offset: 262144,
                                            checksum: ChecksumDefinition {
                                                start: Some(262144),
                                                length: Some(63000),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    325158,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 325152,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 325144,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                        layout::FixedSection {
                                            id: 1,
                                            physical_offset: 325376,
                                            checksum: ChecksumDefinition {
                                                start: Some(325376),
                                                length: Some(74496),
                                                ..ChecksumDefinition::new(
                                                    ChecksumAlgorithm::Crc16CcittFalseLe,
                                                    399886,
                                                )
                                            },
                                            signature: Some(rules::Scalar {
                                                offset: 399880,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                            counter: Some(rules::Scalar {
                                                offset: 399872,
                                                storage: Storage::U32Le,
                                                mask: None,
                                            }),
                                        },
                                    ],
                                    counter: Some(rules::Scalar {
                                        offset: 325144,
                                        storage: Storage::U32Le,
                                        mask: None,
                                    }),
                                    ..Default::default()
                                },
                            ],
                        },
                        selection: layout::Selection::NewestCounterMaxToZero,
                        write: layout::WritePolicy::Selected,
                        empty: vec![255],
                        empty_if_no_signature: false,
                    }],
                });
                game.runtime.recognition = Some(runtime::Recognition {
                    checks: vec![rules::Check {
                        when: None,
                        assert: rules::Condition::new(move |bytes| {
                            Ok((rules::Scalar {
                                offset: 128,
                                storage: Storage::U8,
                                mask: None,
                            }
                            .read(bytes)?)
                                == (8i64))
                        }),
                        code: "save_game_version".into(),
                        message: "the trainer profile does not match the selected game".into(),
                        section_id: None,
                        warning: None,
                    }],
                    reasons: vec![
                        SaveRecognitionReason::ChecksumValid,
                        SaveRecognitionReason::SignatureValid,
                        SaveRecognitionReason::CounterUniform,
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
                                    offset: 128,
                                    storage: Storage::U8,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    == (8i64))
                            }),
                            code: "save_game_version".into(),
                            message: "the trainer profile does not match the selected game".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 124,
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
                                    offset: 120,
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
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 132,
                                    storage: Storage::U16Le,
                                    mask: None,
                                }
                                .read(bytes)?)
                                    <= (50000i64))
                            }),
                            code: "save_coins".into(),
                            message: "the save has coins above the game limit".into(),
                            section_id: None,
                            warning: None,
                        },
                        rules::Check {
                            when: None,
                            assert: rules::Condition::new(move |bytes| {
                                Ok((rules::Scalar {
                                    offset: 23480,
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
                                    Ok((address.scalar(136, Storage::U8, None).read(bytes)?)
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
                    checks
                };
                game
            },
        ];

    build(games, codecs, false)
}
