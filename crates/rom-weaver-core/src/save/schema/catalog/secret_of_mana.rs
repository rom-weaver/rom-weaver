use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            catalog_field("slot_1.marker", "Slot active marker", 0, Storage::U8).editable(false),
            catalog_field("slot_1.money", "Money", 109, Storage::U24Le),
            catalog_field("slot_1.mana.water", "Water Mana power", 203, Storage::Bit).bit(4),
            catalog_field("slot_1.mana.earth", "Earth Mana power", 203, Storage::Bit).bit(0),
            catalog_field("slot_1.mana.wind", "Wind Mana power", 204, Storage::Bit).bit(4),
            catalog_field("slot_1.mana.fire", "Fire Mana power", 204, Storage::Bit).bit(0),
            catalog_field("slot_1.mana.light", "Light Mana power", 205, Storage::Bit).bit(4),
            catalog_field("slot_1.mana.dark", "Dark Mana power", 205, Storage::Bit).bit(0),
            catalog_field("slot_1.mana.moon", "Moon Mana power", 206, Storage::Bit).bit(4),
            catalog_field("slot_1.mana.wood", "Wood Mana power", 206, Storage::Bit).bit(0),
            catalog_field(
                "slot_1.location.spawn",
                "Location spawn ID",
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
            catalog_field("slot_1.save_count", "Slot save count", 695, Storage::U8),
            catalog_field(
                "slot_1.total_save_count",
                "Total save count",
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
        catalog_field("slot_2.marker", "Slot active marker", 1024, Storage::U8).editable(false),
        catalog_field("slot_2.money", "Money", 1133, Storage::U24Le),
        catalog_field("slot_2.mana.water", "Water Mana power", 1227, Storage::Bit).bit(4),
        catalog_field("slot_2.mana.earth", "Earth Mana power", 1227, Storage::Bit).bit(0),
        catalog_field("slot_2.mana.wind", "Wind Mana power", 1228, Storage::Bit).bit(4),
        catalog_field("slot_2.mana.fire", "Fire Mana power", 1228, Storage::Bit).bit(0),
        catalog_field("slot_2.mana.light", "Light Mana power", 1229, Storage::Bit).bit(4),
        catalog_field("slot_2.mana.dark", "Dark Mana power", 1229, Storage::Bit).bit(0),
        catalog_field("slot_2.mana.moon", "Moon Mana power", 1230, Storage::Bit).bit(4),
        catalog_field("slot_2.mana.wood", "Wood Mana power", 1230, Storage::Bit).bit(0),
        catalog_field(
            "slot_2.location.spawn",
            "Location spawn ID",
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
        catalog_field("slot_2.save_count", "Slot save count", 1719, Storage::U8),
        catalog_field(
            "slot_2.total_save_count",
            "Total save count",
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
        catalog_field("slot_3.marker", "Slot active marker", 2048, Storage::U8).editable(false),
        catalog_field("slot_3.money", "Money", 2157, Storage::U24Le),
        catalog_field("slot_3.mana.water", "Water Mana power", 2251, Storage::Bit).bit(4),
        catalog_field("slot_3.mana.earth", "Earth Mana power", 2251, Storage::Bit).bit(0),
        catalog_field("slot_3.mana.wind", "Wind Mana power", 2252, Storage::Bit).bit(4),
        catalog_field("slot_3.mana.fire", "Fire Mana power", 2252, Storage::Bit).bit(0),
        catalog_field("slot_3.mana.light", "Light Mana power", 2253, Storage::Bit).bit(4),
        catalog_field("slot_3.mana.dark", "Dark Mana power", 2253, Storage::Bit).bit(0),
        catalog_field("slot_3.mana.moon", "Moon Mana power", 2254, Storage::Bit).bit(4),
        catalog_field("slot_3.mana.wood", "Wood Mana power", 2254, Storage::Bit).bit(0),
        catalog_field(
            "slot_3.location.spawn",
            "Location spawn ID",
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
        catalog_field("slot_3.save_count", "Slot save count", 2743, Storage::U8),
        catalog_field(
            "slot_3.total_save_count",
            "Total save count",
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
        catalog_field("slot_4.marker", "Slot active marker", 3072, Storage::U8).editable(false),
        catalog_field("slot_4.money", "Money", 3181, Storage::U24Le),
        catalog_field("slot_4.mana.water", "Water Mana power", 3275, Storage::Bit).bit(4),
        catalog_field("slot_4.mana.earth", "Earth Mana power", 3275, Storage::Bit).bit(0),
        catalog_field("slot_4.mana.wind", "Wind Mana power", 3276, Storage::Bit).bit(4),
        catalog_field("slot_4.mana.fire", "Fire Mana power", 3276, Storage::Bit).bit(0),
        catalog_field("slot_4.mana.light", "Light Mana power", 3277, Storage::Bit).bit(4),
        catalog_field("slot_4.mana.dark", "Dark Mana power", 3277, Storage::Bit).bit(0),
        catalog_field("slot_4.mana.moon", "Moon Mana power", 3278, Storage::Bit).bit(4),
        catalog_field("slot_4.mana.wood", "Wood Mana power", 3278, Storage::Bit).bit(0),
        catalog_field(
            "slot_4.location.spawn",
            "Location spawn ID",
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
        catalog_field("slot_4.save_count", "Slot save count", 3767, Storage::U8),
        catalog_field(
            "slot_4.total_save_count",
            "Total save count",
            3768,
            Storage::U8,
        ),
    ];
    game.fields = fields;
    game
}
