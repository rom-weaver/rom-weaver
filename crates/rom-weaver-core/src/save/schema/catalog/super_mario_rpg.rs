use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            catalog_field("slot_1.coins", "Coins", 175, Storage::U16Le),
            catalog_field(
                "slot_1.flowers.current",
                "Current flower points",
                177,
                Storage::U8,
            ),
            catalog_field(
                "slot_1.flowers.maximum",
                "Maximum flower points",
                178,
                Storage::U8,
            ),
            catalog_field("slot_1.frog_coins", "Frog Coins", 179, Storage::U16Le),
            catalog_field("slot_1.location", "Location ID", 960, Storage::U16Le)
                .description(
                    concat!(
                        "Read-only because changing this field also requires coordinate ",
                        "and preview updates."
                    )
                    .into(),
                )
                .editable(false),
            catalog_field(
                "slot_1.party.count",
                "Number of party characters",
                962,
                Storage::U8,
            ),
            catalog_field(
                "slot_1.party.main_1",
                "Main party character 1",
                963,
                Storage::U8,
            ),
            catalog_field(
                "slot_1.party.main_2",
                "Main party character 2",
                964,
                Storage::U8,
            ),
            catalog_field(
                "slot_1.party.main_3",
                "Main party character 3",
                965,
                Storage::U8,
            ),
            catalog_field(
                "slot_1.party.reserve_1",
                "Reserve character 1",
                966,
                Storage::U8,
            ),
            catalog_field(
                "slot_1.party.reserve_2",
                "Reserve character 2",
                967,
                Storage::U8,
            ),
            catalog_field("slot_1.star_pieces", "Star Pieces", 1221, Storage::U8),
            catalog_field(
                "slot_1.beetle_mania_score",
                "Beetle Mania high score",
                1235,
                Storage::BcdLe,
            )
            .length(4),
            catalog_field("slot_1.menu.map", "Map menu unlocked", 1106, Storage::Bit).bit(0),
            catalog_field(
                "slot_1.menu.star_pieces",
                "Star Pieces menu unlocked",
                1106,
                Storage::Bit,
            )
            .bit(1),
            catalog_field(
                "slot_1.menu.switch",
                "Switch menu unlocked",
                1106,
                Storage::Bit,
            )
            .bit(2),
            catalog_field("slot_1.menu.game", "Game menu unlocked", 1106, Storage::Bit).bit(3),
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
                start: Some(0),
                length: Some(2044),
                target: Some(65535),
                unit: ChecksumUnit::U8,
                ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 2044)
            }],
            ..GameDefinition::new("".into(), "".into(), "snes".into(), 32768)
        }
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_super_mario_rpg_slot_1(),
        game_super_mario_rpg_slot_2(),
        game_super_mario_rpg_slot_3(),
        game_super_mario_rpg_slot_4(),
    ];

    build(games, codecs, true)
}

fn game_super_mario_rpg_slot_1() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-rpg-slot-1".into();
    game.name = "Super Mario RPG: Legend of the Seven Stars (Slot 1)".into();
    game
}

fn game_super_mario_rpg_slot_2() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-rpg-slot-2".into();
    game.name = "Super Mario RPG: Legend of the Seven Stars (Slot 2)".into();
    game.description = concat!(
        "Edits documented scalar Slot 2 fields. Custom text, party ",
        "statistics, inventory and equipment arrays, and ",
        "location-dependent hooks are omitted. Other slots remain ",
        "unchanged."
    )
    .into();
    game.checksums = vec![ChecksumDefinition {
        start: Some(2048),
        length: Some(2044),
        target: Some(65535),
        unit: ChecksumUnit::U8,
        ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 4092)
    }];
    let fields = vec![
        catalog_field("slot_2.coins", "Coins", 2223, Storage::U16Le),
        catalog_field(
            "slot_2.flowers.current",
            "Current flower points",
            2225,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.flowers.maximum",
            "Maximum flower points",
            2226,
            Storage::U8,
        ),
        catalog_field("slot_2.frog_coins", "Frog Coins", 2227, Storage::U16Le),
        catalog_field("slot_2.location", "Location ID", 3008, Storage::U16Le)
            .description(
                concat!(
                    "Read-only because changing this field also requires coordinate ",
                    "and preview updates."
                )
                .into(),
            )
            .editable(false),
        catalog_field(
            "slot_2.party.count",
            "Number of party characters",
            3010,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.party.main_1",
            "Main party character 1",
            3011,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.party.main_2",
            "Main party character 2",
            3012,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.party.main_3",
            "Main party character 3",
            3013,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.party.reserve_1",
            "Reserve character 1",
            3014,
            Storage::U8,
        ),
        catalog_field(
            "slot_2.party.reserve_2",
            "Reserve character 2",
            3015,
            Storage::U8,
        ),
        catalog_field("slot_2.star_pieces", "Star Pieces", 3269, Storage::U8),
        catalog_field(
            "slot_2.beetle_mania_score",
            "Beetle Mania high score",
            3283,
            Storage::BcdLe,
        )
        .length(4),
        catalog_field("slot_2.menu.map", "Map menu unlocked", 3154, Storage::Bit).bit(0),
        catalog_field(
            "slot_2.menu.star_pieces",
            "Star Pieces menu unlocked",
            3154,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_2.menu.switch",
            "Switch menu unlocked",
            3154,
            Storage::Bit,
        )
        .bit(2),
        catalog_field("slot_2.menu.game", "Game menu unlocked", 3154, Storage::Bit).bit(3),
    ];
    game.fields = fields;
    game
}

fn game_super_mario_rpg_slot_3() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-rpg-slot-3".into();
    game.name = "Super Mario RPG: Legend of the Seven Stars (Slot 3)".into();
    game.description = concat!(
        "Edits documented scalar Slot 3 fields. Custom text, party ",
        "statistics, inventory and equipment arrays, and ",
        "location-dependent hooks are omitted. Other slots remain ",
        "unchanged."
    )
    .into();
    game.checksums = vec![ChecksumDefinition {
        start: Some(4096),
        length: Some(2044),
        target: Some(65535),
        unit: ChecksumUnit::U8,
        ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 6140)
    }];
    let fields = vec![
        catalog_field("slot_3.coins", "Coins", 4271, Storage::U16Le),
        catalog_field(
            "slot_3.flowers.current",
            "Current flower points",
            4273,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.flowers.maximum",
            "Maximum flower points",
            4274,
            Storage::U8,
        ),
        catalog_field("slot_3.frog_coins", "Frog Coins", 4275, Storage::U16Le),
        catalog_field("slot_3.location", "Location ID", 5056, Storage::U16Le)
            .description(
                concat!(
                    "Read-only because changing this field also requires coordinate ",
                    "and preview updates."
                )
                .into(),
            )
            .editable(false),
        catalog_field(
            "slot_3.party.count",
            "Number of party characters",
            5058,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.party.main_1",
            "Main party character 1",
            5059,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.party.main_2",
            "Main party character 2",
            5060,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.party.main_3",
            "Main party character 3",
            5061,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.party.reserve_1",
            "Reserve character 1",
            5062,
            Storage::U8,
        ),
        catalog_field(
            "slot_3.party.reserve_2",
            "Reserve character 2",
            5063,
            Storage::U8,
        ),
        catalog_field("slot_3.star_pieces", "Star Pieces", 5317, Storage::U8),
        catalog_field(
            "slot_3.beetle_mania_score",
            "Beetle Mania high score",
            5331,
            Storage::BcdLe,
        )
        .length(4),
        catalog_field("slot_3.menu.map", "Map menu unlocked", 5202, Storage::Bit).bit(0),
        catalog_field(
            "slot_3.menu.star_pieces",
            "Star Pieces menu unlocked",
            5202,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_3.menu.switch",
            "Switch menu unlocked",
            5202,
            Storage::Bit,
        )
        .bit(2),
        catalog_field("slot_3.menu.game", "Game menu unlocked", 5202, Storage::Bit).bit(3),
    ];
    game.fields = fields;
    game
}

fn game_super_mario_rpg_slot_4() -> GameDefinition {
    let mut game = default();
    game.id = "super-mario-rpg-slot-4".into();
    game.name = "Super Mario RPG: Legend of the Seven Stars (Slot 4)".into();
    game.description = concat!(
        "Edits documented scalar Slot 4 fields. Custom text, party ",
        "statistics, inventory and equipment arrays, and ",
        "location-dependent hooks are omitted. Other slots remain ",
        "unchanged."
    )
    .into();
    game.checksums = vec![ChecksumDefinition {
        start: Some(6144),
        length: Some(2044),
        target: Some(65535),
        unit: ChecksumUnit::U8,
        ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, 8188)
    }];
    let fields = vec![
        catalog_field("slot_4.coins", "Coins", 6319, Storage::U16Le),
        catalog_field(
            "slot_4.flowers.current",
            "Current flower points",
            6321,
            Storage::U8,
        ),
        catalog_field(
            "slot_4.flowers.maximum",
            "Maximum flower points",
            6322,
            Storage::U8,
        ),
        catalog_field("slot_4.frog_coins", "Frog Coins", 6323, Storage::U16Le),
        catalog_field("slot_4.location", "Location ID", 7104, Storage::U16Le)
            .description(
                concat!(
                    "Read-only because changing this field also requires coordinate ",
                    "and preview updates."
                )
                .into(),
            )
            .editable(false),
        catalog_field(
            "slot_4.party.count",
            "Number of party characters",
            7106,
            Storage::U8,
        ),
        catalog_field(
            "slot_4.party.main_1",
            "Main party character 1",
            7107,
            Storage::U8,
        ),
        catalog_field(
            "slot_4.party.main_2",
            "Main party character 2",
            7108,
            Storage::U8,
        ),
        catalog_field(
            "slot_4.party.main_3",
            "Main party character 3",
            7109,
            Storage::U8,
        ),
        catalog_field(
            "slot_4.party.reserve_1",
            "Reserve character 1",
            7110,
            Storage::U8,
        ),
        catalog_field(
            "slot_4.party.reserve_2",
            "Reserve character 2",
            7111,
            Storage::U8,
        ),
        catalog_field("slot_4.star_pieces", "Star Pieces", 7365, Storage::U8),
        catalog_field(
            "slot_4.beetle_mania_score",
            "Beetle Mania high score",
            7379,
            Storage::BcdLe,
        )
        .length(4),
        catalog_field("slot_4.menu.map", "Map menu unlocked", 7250, Storage::Bit).bit(0),
        catalog_field(
            "slot_4.menu.star_pieces",
            "Star Pieces menu unlocked",
            7250,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_4.menu.switch",
            "Switch menu unlocked",
            7250,
            Storage::Bit,
        )
        .bit(2),
        catalog_field("slot_4.menu.game", "Game menu unlocked", 7250, Storage::Bit).bit(3),
    ];
    game.fields = fields;
    game
}
