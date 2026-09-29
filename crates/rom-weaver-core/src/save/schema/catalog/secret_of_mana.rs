use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            FieldDefinition::new(
                "slot_1.marker".into(),
                "Slot active marker".into(),
                0,
                Storage::U8,
            )
            .editable(false),
            FieldDefinition::new("slot_1.money".into(), "Money".into(), 109, Storage::U24Le),
            FieldDefinition::new(
                "slot_1.mana.water".into(),
                "Water Mana power".into(),
                203,
                Storage::Bit,
            )
            .bit(4),
            FieldDefinition::new(
                "slot_1.mana.earth".into(),
                "Earth Mana power".into(),
                203,
                Storage::Bit,
            )
            .bit(0),
            FieldDefinition::new(
                "slot_1.mana.wind".into(),
                "Wind Mana power".into(),
                204,
                Storage::Bit,
            )
            .bit(4),
            FieldDefinition::new(
                "slot_1.mana.fire".into(),
                "Fire Mana power".into(),
                204,
                Storage::Bit,
            )
            .bit(0),
            FieldDefinition::new(
                "slot_1.mana.light".into(),
                "Light Mana power".into(),
                205,
                Storage::Bit,
            )
            .bit(4),
            FieldDefinition::new(
                "slot_1.mana.dark".into(),
                "Dark Mana power".into(),
                205,
                Storage::Bit,
            )
            .bit(0),
            FieldDefinition::new(
                "slot_1.mana.moon".into(),
                "Moon Mana power".into(),
                206,
                Storage::Bit,
            )
            .bit(4),
            FieldDefinition::new(
                "slot_1.mana.wood".into(),
                "Wood Mana power".into(),
                206,
                Storage::Bit,
            )
            .bit(0),
            FieldDefinition::new(
                "slot_1.location.spawn".into(),
                "Location spawn ID".into(),
                682,
                Storage::U16Le,
            )
            .description(
                concat!(
                    "Raw documented spawn value. Editing does not run the source ",
                    "editor's coordinate hook."
                )
                .into(),
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.save_count".into(),
                "Slot save count".into(),
                695,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.total_save_count".into(),
                "Total save count".into(),
                696,
                Storage::U8,
            ),
        ];
        GameDefinition {
            fields,
            description: concat!(
                "Edits documented scalar Slot 1 fields. Custom text, party ",
                "statistics, inventory and equipment arrays, and ",
                "location-dependent hooks are omitted. Other slots remain ",
                "unchanged."
            )
            .into(),
            checksums: vec![ChecksumDefinition {
                start: Some(3),
                length: Some(696),
                unit: ChecksumUnit::U8,
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1)
            }],
            ..GameDefinition::new("".into(), "".into(), "snes".into(), 8192)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_secret_of_mana_slot_1(),
        game_secret_of_mana_slot_2(),
        game_secret_of_mana_slot_3(),
        game_secret_of_mana_slot_4(),
    ];

    build(games, codecs, true)
}

fn game_secret_of_mana_slot_1() -> GameDefinition {
    let mut game = default();
    game.id = "secret-of-mana-slot-1".into();
    game.name = "Secret of Mana (Slot 1)".into();
    game
}

fn game_secret_of_mana_slot_2() -> GameDefinition {
    let mut game = default();
    game.id = "secret-of-mana-slot-2".into();
    game.name = "Secret of Mana (Slot 2)".into();
    game.description = concat!(
        "Edits documented scalar Slot 2 fields. Custom text, party ",
        "statistics, inventory and equipment arrays, and ",
        "location-dependent hooks are omitted. Other slots remain ",
        "unchanged."
    )
    .into();
    game.checksums = vec![ChecksumDefinition {
        start: Some(1027),
        length: Some(696),
        unit: ChecksumUnit::U8,
        ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 1025)
    }];
    let fields = vec![
        FieldDefinition::new(
            "slot_2.marker".into(),
            "Slot active marker".into(),
            1024,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new("slot_2.money".into(), "Money".into(), 1133, Storage::U24Le),
        FieldDefinition::new(
            "slot_2.mana.water".into(),
            "Water Mana power".into(),
            1227,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_2.mana.earth".into(),
            "Earth Mana power".into(),
            1227,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_2.mana.wind".into(),
            "Wind Mana power".into(),
            1228,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_2.mana.fire".into(),
            "Fire Mana power".into(),
            1228,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_2.mana.light".into(),
            "Light Mana power".into(),
            1229,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_2.mana.dark".into(),
            "Dark Mana power".into(),
            1229,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_2.mana.moon".into(),
            "Moon Mana power".into(),
            1230,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_2.mana.wood".into(),
            "Wood Mana power".into(),
            1230,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_2.location.spawn".into(),
            "Location spawn ID".into(),
            1706,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Raw documented spawn value. Editing does not run the source ",
                "editor's coordinate hook."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.save_count".into(),
            "Slot save count".into(),
            1719,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.total_save_count".into(),
            "Total save count".into(),
            1720,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}

fn game_secret_of_mana_slot_3() -> GameDefinition {
    let mut game = default();
    game.id = "secret-of-mana-slot-3".into();
    game.name = "Secret of Mana (Slot 3)".into();
    game.description = concat!(
        "Edits documented scalar Slot 3 fields. Custom text, party ",
        "statistics, inventory and equipment arrays, and ",
        "location-dependent hooks are omitted. Other slots remain ",
        "unchanged."
    )
    .into();
    game.checksums = vec![ChecksumDefinition {
        start: Some(2051),
        length: Some(696),
        unit: ChecksumUnit::U8,
        ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 2049)
    }];
    let fields = vec![
        FieldDefinition::new(
            "slot_3.marker".into(),
            "Slot active marker".into(),
            2048,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new("slot_3.money".into(), "Money".into(), 2157, Storage::U24Le),
        FieldDefinition::new(
            "slot_3.mana.water".into(),
            "Water Mana power".into(),
            2251,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_3.mana.earth".into(),
            "Earth Mana power".into(),
            2251,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_3.mana.wind".into(),
            "Wind Mana power".into(),
            2252,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_3.mana.fire".into(),
            "Fire Mana power".into(),
            2252,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_3.mana.light".into(),
            "Light Mana power".into(),
            2253,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_3.mana.dark".into(),
            "Dark Mana power".into(),
            2253,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_3.mana.moon".into(),
            "Moon Mana power".into(),
            2254,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_3.mana.wood".into(),
            "Wood Mana power".into(),
            2254,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_3.location.spawn".into(),
            "Location spawn ID".into(),
            2730,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Raw documented spawn value. Editing does not run the source ",
                "editor's coordinate hook."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.save_count".into(),
            "Slot save count".into(),
            2743,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.total_save_count".into(),
            "Total save count".into(),
            2744,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}

fn game_secret_of_mana_slot_4() -> GameDefinition {
    let mut game = default();
    game.id = "secret-of-mana-slot-4".into();
    game.name = "Secret of Mana (Slot 4)".into();
    game.description = concat!(
        "Edits documented scalar Slot 4 fields. Custom text, party ",
        "statistics, inventory and equipment arrays, and ",
        "location-dependent hooks are omitted. Other slots remain ",
        "unchanged."
    )
    .into();
    game.checksums = vec![ChecksumDefinition {
        start: Some(3075),
        length: Some(696),
        unit: ChecksumUnit::U8,
        ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 3073)
    }];
    let fields = vec![
        FieldDefinition::new(
            "slot_4.marker".into(),
            "Slot active marker".into(),
            3072,
            Storage::U8,
        )
        .editable(false),
        FieldDefinition::new("slot_4.money".into(), "Money".into(), 3181, Storage::U24Le),
        FieldDefinition::new(
            "slot_4.mana.water".into(),
            "Water Mana power".into(),
            3275,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_4.mana.earth".into(),
            "Earth Mana power".into(),
            3275,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_4.mana.wind".into(),
            "Wind Mana power".into(),
            3276,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_4.mana.fire".into(),
            "Fire Mana power".into(),
            3276,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_4.mana.light".into(),
            "Light Mana power".into(),
            3277,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_4.mana.dark".into(),
            "Dark Mana power".into(),
            3277,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_4.mana.moon".into(),
            "Moon Mana power".into(),
            3278,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_4.mana.wood".into(),
            "Wood Mana power".into(),
            3278,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_4.location.spawn".into(),
            "Location spawn ID".into(),
            3754,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Raw documented spawn value. Editing does not run the source ",
                "editor's coordinate hook."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_4.save_count".into(),
            "Slot save count".into(),
            3767,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.total_save_count".into(),
            "Total save count".into(),
            3768,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}
