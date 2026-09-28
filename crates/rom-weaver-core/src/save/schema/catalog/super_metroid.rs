use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            FieldDefinition::new(
                "slot_1.energy.current".into(),
                "Current energy".into(),
                48,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.energy.maximum".into(),
                "Maximum energy".into(),
                50,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.missiles.current".into(),
                "Current missiles".into(),
                52,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.missiles.maximum".into(),
                "Maximum missiles".into(),
                54,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.super_missiles.current".into(),
                "Current super missiles".into(),
                56,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.super_missiles.maximum".into(),
                "Maximum super missiles".into(),
                58,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.power_bombs.current".into(),
                "Current power bombs".into(),
                60,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.power_bombs.maximum".into(),
                "Maximum power bombs".into(),
                62,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.reserve.current".into(),
                "Current reserve energy".into(),
                64,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.reserve.maximum".into(),
                "Maximum reserve energy".into(),
                66,
                Storage::U16Le,
            )
            .description(
                concat!(
                    "Read-only because changing zero/nonzero state requires a coupled ",
                    "supply-mode update."
                )
                .into(),
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.playtime.milliseconds".into(),
                "Playtime milliseconds".into(),
                72,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.playtime.seconds".into(),
                "Playtime seconds".into(),
                74,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.playtime.minutes".into(),
                "Playtime minutes".into(),
                76,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.playtime.hours".into(),
                "Playtime hours".into(),
                78,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.location.raw".into(),
                "Raw location words".into(),
                358,
                Storage::U32Le,
            )
            .description(
                concat!(
                    "Read-only pair packed as a u32. The source editor transforms the ",
                    "two u16 values."
                )
                .into(),
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.brinstar_rooms_count".into(),
                "Brinstar rooms count".into(),
                362,
                Storage::U16Le,
            ),
        ];
        GameDefinition {
            fields,
            description: concat!(
                "Edits documented scalar Samus A fields for the madadameyohn ",
                "footer signature. Repairs both checksum pairs and preserves ",
                "other slots. Map/event arrays and coupled equipment/reserve ",
                "changes are omitted."
            )
            .into(),
            signatures: vec![SignatureDefinition {
                offset: 8160,
                bytes: vec![109, 97, 100, 97, 100, 97, 109, 101, 121, 111, 104, 110],
            }],
            checksums: vec![
                ChecksumDefinition {
                    start: Some(16),
                    length: Some(1628),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 0)
                },
                ChecksumDefinition {
                    start: Some(16),
                    length: Some(1628),
                    target: Some(65535),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 8)
                },
                ChecksumDefinition {
                    start: Some(16),
                    length: Some(1628),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 8176)
                },
                ChecksumDefinition {
                    start: Some(16),
                    length: Some(1628),
                    target: Some(65535),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 8184)
                },
            ],
            ..GameDefinition::new("".into(), "".into(), "snes".into(), 8192)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_super_metroid_samus_a(),
        game_super_metroid_samus_b(),
        game_super_metroid_samus_c(),
        game_super_metroid_samus_a_supermetroid(),
        game_super_metroid_samus_b_supermetroid(),
        game_super_metroid_samus_c_supermetroid(),
    ];

    build(games, codecs, true)
}

fn game_super_metroid_samus_a() -> GameDefinition {
    let mut game = default();
    game.id = "super-metroid-samus-a".into();
    game.name = "Super Metroid (Samus A, madadameyohn footer)".into();
    game
}

fn game_super_metroid_samus_b() -> GameDefinition {
    let mut game = default();
    game.id = "super-metroid-samus-b".into();
    game.name = "Super Metroid (Samus B, madadameyohn footer)".into();
    game.description = concat!(
        "Edits documented scalar Samus B fields for the madadameyohn ",
        "footer signature. Repairs both checksum pairs and preserves ",
        "other slots. Map/event arrays and coupled equipment/reserve ",
        "changes are omitted."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 2)
        },
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 10)
        },
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 8178)
        },
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 8186)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_2.energy.current".into(),
            "Current energy".into(),
            1676,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.energy.maximum".into(),
            "Maximum energy".into(),
            1678,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.missiles.current".into(),
            "Current missiles".into(),
            1680,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.missiles.maximum".into(),
            "Maximum missiles".into(),
            1682,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.super_missiles.current".into(),
            "Current super missiles".into(),
            1684,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.super_missiles.maximum".into(),
            "Maximum super missiles".into(),
            1686,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.power_bombs.current".into(),
            "Current power bombs".into(),
            1688,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.power_bombs.maximum".into(),
            "Maximum power bombs".into(),
            1690,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.reserve.current".into(),
            "Current reserve energy".into(),
            1692,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.reserve.maximum".into(),
            "Maximum reserve energy".into(),
            1694,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Read-only because changing zero/nonzero state requires a coupled ",
                "supply-mode update."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.playtime.milliseconds".into(),
            "Playtime milliseconds".into(),
            1700,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.playtime.seconds".into(),
            "Playtime seconds".into(),
            1702,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.playtime.minutes".into(),
            "Playtime minutes".into(),
            1704,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.playtime.hours".into(),
            "Playtime hours".into(),
            1706,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.location.raw".into(),
            "Raw location words".into(),
            1986,
            Storage::U32Le,
        )
        .description(
            concat!(
                "Read-only pair packed as a u32. The source editor transforms the ",
                "two u16 values."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.brinstar_rooms_count".into(),
            "Brinstar rooms count".into(),
            1990,
            Storage::U16Le,
        ),
    ];
    game.fields = fields;
    game
}

fn game_super_metroid_samus_c() -> GameDefinition {
    let mut game = default();
    game.id = "super-metroid-samus-c".into();
    game.name = "Super Metroid (Samus C, madadameyohn footer)".into();
    game.description = concat!(
        "Edits documented scalar Samus C fields for the madadameyohn ",
        "footer signature. Repairs both checksum pairs and preserves ",
        "other slots. Map/event arrays and coupled equipment/reserve ",
        "changes are omitted."
    )
    .into();
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 4)
        },
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 12)
        },
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 8180)
        },
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 8188)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_3.energy.current".into(),
            "Current energy".into(),
            3304,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.energy.maximum".into(),
            "Maximum energy".into(),
            3306,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.missiles.current".into(),
            "Current missiles".into(),
            3308,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.missiles.maximum".into(),
            "Maximum missiles".into(),
            3310,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.super_missiles.current".into(),
            "Current super missiles".into(),
            3312,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.super_missiles.maximum".into(),
            "Maximum super missiles".into(),
            3314,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.power_bombs.current".into(),
            "Current power bombs".into(),
            3316,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.power_bombs.maximum".into(),
            "Maximum power bombs".into(),
            3318,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.reserve.current".into(),
            "Current reserve energy".into(),
            3320,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.reserve.maximum".into(),
            "Maximum reserve energy".into(),
            3322,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Read-only because changing zero/nonzero state requires a coupled ",
                "supply-mode update."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.playtime.milliseconds".into(),
            "Playtime milliseconds".into(),
            3328,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.playtime.seconds".into(),
            "Playtime seconds".into(),
            3330,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.playtime.minutes".into(),
            "Playtime minutes".into(),
            3332,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.playtime.hours".into(),
            "Playtime hours".into(),
            3334,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.location.raw".into(),
            "Raw location words".into(),
            3614,
            Storage::U32Le,
        )
        .description(
            concat!(
                "Read-only pair packed as a u32. The source editor transforms the ",
                "two u16 values."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.brinstar_rooms_count".into(),
            "Brinstar rooms count".into(),
            3618,
            Storage::U16Le,
        ),
    ];
    game.fields = fields;
    game
}

fn game_super_metroid_samus_a_supermetroid() -> GameDefinition {
    let mut game = default();
    game.id = "super-metroid-samus-a-supermetroid".into();
    game.name = "Super Metroid (Samus A, supermetroid footer)".into();
    game.description = concat!(
        "Edits documented scalar Samus A fields for the supermetroid ",
        "footer signature. Repairs both checksum pairs and preserves ",
        "other slots. Map/event arrays and coupled equipment/reserve ",
        "changes are omitted."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 8160,
        bytes: vec![115, 117, 112, 101, 114, 109, 101, 116, 114, 111, 105, 100],
    }];
    game
}

fn game_super_metroid_samus_b_supermetroid() -> GameDefinition {
    let mut game = default();
    game.id = "super-metroid-samus-b-supermetroid".into();
    game.name = "Super Metroid (Samus B, supermetroid footer)".into();
    game.description = concat!(
        "Edits documented scalar Samus B fields for the supermetroid ",
        "footer signature. Repairs both checksum pairs and preserves ",
        "other slots. Map/event arrays and coupled equipment/reserve ",
        "changes are omitted."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 8160,
        bytes: vec![115, 117, 112, 101, 114, 109, 101, 116, 114, 111, 105, 100],
    }];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 2)
        },
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 10)
        },
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 8178)
        },
        ChecksumDefinition {
            start: Some(1644),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 8186)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_2.energy.current".into(),
            "Current energy".into(),
            1676,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.energy.maximum".into(),
            "Maximum energy".into(),
            1678,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.missiles.current".into(),
            "Current missiles".into(),
            1680,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.missiles.maximum".into(),
            "Maximum missiles".into(),
            1682,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.super_missiles.current".into(),
            "Current super missiles".into(),
            1684,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.super_missiles.maximum".into(),
            "Maximum super missiles".into(),
            1686,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.power_bombs.current".into(),
            "Current power bombs".into(),
            1688,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.power_bombs.maximum".into(),
            "Maximum power bombs".into(),
            1690,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.reserve.current".into(),
            "Current reserve energy".into(),
            1692,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.reserve.maximum".into(),
            "Maximum reserve energy".into(),
            1694,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Read-only because changing zero/nonzero state requires a coupled ",
                "supply-mode update."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.playtime.milliseconds".into(),
            "Playtime milliseconds".into(),
            1700,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.playtime.seconds".into(),
            "Playtime seconds".into(),
            1702,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.playtime.minutes".into(),
            "Playtime minutes".into(),
            1704,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.playtime.hours".into(),
            "Playtime hours".into(),
            1706,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.location.raw".into(),
            "Raw location words".into(),
            1986,
            Storage::U32Le,
        )
        .description(
            concat!(
                "Read-only pair packed as a u32. The source editor transforms the ",
                "two u16 values."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.brinstar_rooms_count".into(),
            "Brinstar rooms count".into(),
            1990,
            Storage::U16Le,
        ),
    ];
    game.fields = fields;
    game
}

fn game_super_metroid_samus_c_supermetroid() -> GameDefinition {
    let mut game = default();
    game.id = "super-metroid-samus-c-supermetroid".into();
    game.name = "Super Metroid (Samus C, supermetroid footer)".into();
    game.description = concat!(
        "Edits documented scalar Samus C fields for the supermetroid ",
        "footer signature. Repairs both checksum pairs and preserves ",
        "other slots. Map/event arrays and coupled equipment/reserve ",
        "changes are omitted."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 8160,
        bytes: vec![115, 117, 112, 101, 114, 109, 101, 116, 114, 111, 105, 100],
    }];
    game.checksums = vec![
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 4)
        },
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 12)
        },
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 8180)
        },
        ChecksumDefinition {
            start: Some(3272),
            length: Some(1628),
            target: Some(65535),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 8188)
        },
    ];
    let fields = vec![
        FieldDefinition::new(
            "slot_3.energy.current".into(),
            "Current energy".into(),
            3304,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.energy.maximum".into(),
            "Maximum energy".into(),
            3306,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.missiles.current".into(),
            "Current missiles".into(),
            3308,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.missiles.maximum".into(),
            "Maximum missiles".into(),
            3310,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.super_missiles.current".into(),
            "Current super missiles".into(),
            3312,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.super_missiles.maximum".into(),
            "Maximum super missiles".into(),
            3314,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.power_bombs.current".into(),
            "Current power bombs".into(),
            3316,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.power_bombs.maximum".into(),
            "Maximum power bombs".into(),
            3318,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.reserve.current".into(),
            "Current reserve energy".into(),
            3320,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.reserve.maximum".into(),
            "Maximum reserve energy".into(),
            3322,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Read-only because changing zero/nonzero state requires a coupled ",
                "supply-mode update."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.playtime.milliseconds".into(),
            "Playtime milliseconds".into(),
            3328,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.playtime.seconds".into(),
            "Playtime seconds".into(),
            3330,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.playtime.minutes".into(),
            "Playtime minutes".into(),
            3332,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.playtime.hours".into(),
            "Playtime hours".into(),
            3334,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.location.raw".into(),
            "Raw location words".into(),
            3614,
            Storage::U32Le,
        )
        .description(
            concat!(
                "Read-only pair packed as a u32. The source editor transforms the ",
                "two u16 values."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.brinstar_rooms_count".into(),
            "Brinstar rooms count".into(),
            3618,
            Storage::U16Le,
        ),
    ];
    game.fields = fields;
    game
}
