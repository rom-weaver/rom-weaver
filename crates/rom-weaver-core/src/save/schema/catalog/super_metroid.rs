use super::*;

#[inline(never)]
fn fields(slot: usize, base: usize) -> Vec<FieldDefinition> {
    vec![
        FieldDefinition::new(
            format!("slot_{slot}.energy.current"),
            "Current energy".into(),
            base + 48,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.energy.maximum"),
            "Maximum energy".into(),
            base + 50,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.missiles.current"),
            "Current missiles".into(),
            base + 52,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.missiles.maximum"),
            "Maximum missiles".into(),
            base + 54,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.super_missiles.current"),
            "Current super missiles".into(),
            base + 56,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.super_missiles.maximum"),
            "Maximum super missiles".into(),
            base + 58,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.power_bombs.current"),
            "Current power bombs".into(),
            base + 60,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.power_bombs.maximum"),
            "Maximum power bombs".into(),
            base + 62,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.reserve.current"),
            "Current reserve energy".into(),
            base + 64,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.reserve.maximum"),
            "Maximum reserve energy".into(),
            base + 66,
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
            format!("slot_{slot}.playtime.milliseconds"),
            "Playtime milliseconds".into(),
            base + 72,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.playtime.seconds"),
            "Playtime seconds".into(),
            base + 74,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.playtime.minutes"),
            "Playtime minutes".into(),
            base + 76,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.playtime.hours"),
            "Playtime hours".into(),
            base + 78,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            format!("slot_{slot}.location.raw"),
            "Raw location words".into(),
            base + 358,
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
            format!("slot_{slot}.brinstar_rooms_count"),
            "Brinstar rooms count".into(),
            base + 362,
            Storage::U16Le,
        ),
    ]
}

fn default() -> GameDefinition {
    {
        let fields = fields(1, 0);
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
    let fields = fields(2, 1628);
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
    let fields = fields(3, 3256);
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
    let fields = fields(2, 1628);
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
    let fields = fields(3, 3256);
    game.fields = fields;
    game
}
