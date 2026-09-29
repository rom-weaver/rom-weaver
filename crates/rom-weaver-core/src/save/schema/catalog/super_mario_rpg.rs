use super::*;

fn default() -> GameDefinition {
    {
        let fields = vec![
            FieldDefinition::new("slot_1.coins".into(), "Coins".into(), 175, Storage::U16Le),
            FieldDefinition::new(
                "slot_1.flowers.current".into(),
                "Current flower points".into(),
                177,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.flowers.maximum".into(),
                "Maximum flower points".into(),
                178,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.frog_coins".into(),
                "Frog Coins".into(),
                179,
                Storage::U16Le,
            ),
            FieldDefinition::new(
                "slot_1.location".into(),
                "Location ID".into(),
                960,
                Storage::U16Le,
            )
            .description(
                concat!(
                    "Read-only because changing this field also requires coordinate ",
                    "and preview updates."
                )
                .into(),
            )
            .editable(false),
            FieldDefinition::new(
                "slot_1.party.count".into(),
                "Number of party characters".into(),
                962,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.party.main_1".into(),
                "Main party character 1".into(),
                963,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.party.main_2".into(),
                "Main party character 2".into(),
                964,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.party.main_3".into(),
                "Main party character 3".into(),
                965,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.party.reserve_1".into(),
                "Reserve character 1".into(),
                966,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.party.reserve_2".into(),
                "Reserve character 2".into(),
                967,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.star_pieces".into(),
                "Star Pieces".into(),
                1221,
                Storage::U8,
            ),
            FieldDefinition::new(
                "slot_1.beetle_mania_score".into(),
                "Beetle Mania high score".into(),
                1235,
                Storage::BcdLe,
            )
            .length(4),
            FieldDefinition::new(
                "slot_1.menu.map".into(),
                "Map menu unlocked".into(),
                1106,
                Storage::Bit,
            )
            .bit(0),
            FieldDefinition::new(
                "slot_1.menu.star_pieces".into(),
                "Star Pieces menu unlocked".into(),
                1106,
                Storage::Bit,
            )
            .bit(1),
            FieldDefinition::new(
                "slot_1.menu.switch".into(),
                "Switch menu unlocked".into(),
                1106,
                Storage::Bit,
            )
            .bit(2),
            FieldDefinition::new(
                "slot_1.menu.game".into(),
                "Game menu unlocked".into(),
                1106,
                Storage::Bit,
            )
            .bit(3),
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
        FieldDefinition::new("slot_2.coins".into(), "Coins".into(), 2223, Storage::U16Le),
        FieldDefinition::new(
            "slot_2.flowers.current".into(),
            "Current flower points".into(),
            2225,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.flowers.maximum".into(),
            "Maximum flower points".into(),
            2226,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.frog_coins".into(),
            "Frog Coins".into(),
            2227,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_2.location".into(),
            "Location ID".into(),
            3008,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Read-only because changing this field also requires coordinate ",
                "and preview updates."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_2.party.count".into(),
            "Number of party characters".into(),
            3010,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.party.main_1".into(),
            "Main party character 1".into(),
            3011,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.party.main_2".into(),
            "Main party character 2".into(),
            3012,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.party.main_3".into(),
            "Main party character 3".into(),
            3013,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.party.reserve_1".into(),
            "Reserve character 1".into(),
            3014,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.party.reserve_2".into(),
            "Reserve character 2".into(),
            3015,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.star_pieces".into(),
            "Star Pieces".into(),
            3269,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_2.beetle_mania_score".into(),
            "Beetle Mania high score".into(),
            3283,
            Storage::BcdLe,
        )
        .length(4),
        FieldDefinition::new(
            "slot_2.menu.map".into(),
            "Map menu unlocked".into(),
            3154,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_2.menu.star_pieces".into(),
            "Star Pieces menu unlocked".into(),
            3154,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_2.menu.switch".into(),
            "Switch menu unlocked".into(),
            3154,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_2.menu.game".into(),
            "Game menu unlocked".into(),
            3154,
            Storage::Bit,
        )
        .bit(3),
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
        FieldDefinition::new("slot_3.coins".into(), "Coins".into(), 4271, Storage::U16Le),
        FieldDefinition::new(
            "slot_3.flowers.current".into(),
            "Current flower points".into(),
            4273,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.flowers.maximum".into(),
            "Maximum flower points".into(),
            4274,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.frog_coins".into(),
            "Frog Coins".into(),
            4275,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_3.location".into(),
            "Location ID".into(),
            5056,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Read-only because changing this field also requires coordinate ",
                "and preview updates."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_3.party.count".into(),
            "Number of party characters".into(),
            5058,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.party.main_1".into(),
            "Main party character 1".into(),
            5059,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.party.main_2".into(),
            "Main party character 2".into(),
            5060,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.party.main_3".into(),
            "Main party character 3".into(),
            5061,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.party.reserve_1".into(),
            "Reserve character 1".into(),
            5062,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.party.reserve_2".into(),
            "Reserve character 2".into(),
            5063,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.star_pieces".into(),
            "Star Pieces".into(),
            5317,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_3.beetle_mania_score".into(),
            "Beetle Mania high score".into(),
            5331,
            Storage::BcdLe,
        )
        .length(4),
        FieldDefinition::new(
            "slot_3.menu.map".into(),
            "Map menu unlocked".into(),
            5202,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_3.menu.star_pieces".into(),
            "Star Pieces menu unlocked".into(),
            5202,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_3.menu.switch".into(),
            "Switch menu unlocked".into(),
            5202,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_3.menu.game".into(),
            "Game menu unlocked".into(),
            5202,
            Storage::Bit,
        )
        .bit(3),
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
        FieldDefinition::new("slot_4.coins".into(), "Coins".into(), 6319, Storage::U16Le),
        FieldDefinition::new(
            "slot_4.flowers.current".into(),
            "Current flower points".into(),
            6321,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.flowers.maximum".into(),
            "Maximum flower points".into(),
            6322,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.frog_coins".into(),
            "Frog Coins".into(),
            6323,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "slot_4.location".into(),
            "Location ID".into(),
            7104,
            Storage::U16Le,
        )
        .description(
            concat!(
                "Read-only because changing this field also requires coordinate ",
                "and preview updates."
            )
            .into(),
        )
        .editable(false),
        FieldDefinition::new(
            "slot_4.party.count".into(),
            "Number of party characters".into(),
            7106,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.party.main_1".into(),
            "Main party character 1".into(),
            7107,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.party.main_2".into(),
            "Main party character 2".into(),
            7108,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.party.main_3".into(),
            "Main party character 3".into(),
            7109,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.party.reserve_1".into(),
            "Reserve character 1".into(),
            7110,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.party.reserve_2".into(),
            "Reserve character 2".into(),
            7111,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.star_pieces".into(),
            "Star Pieces".into(),
            7365,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_4.beetle_mania_score".into(),
            "Beetle Mania high score".into(),
            7379,
            Storage::BcdLe,
        )
        .length(4),
        FieldDefinition::new(
            "slot_4.menu.map".into(),
            "Map menu unlocked".into(),
            7250,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_4.menu.star_pieces".into(),
            "Star Pieces menu unlocked".into(),
            7250,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_4.menu.switch".into(),
            "Switch menu unlocked".into(),
            7250,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_4.menu.game".into(),
            "Game menu unlocked".into(),
            7250,
            Storage::Bit,
        )
        .bit(3),
    ];
    game.fields = fields;
    game
}
