use super::*;

fn bottle_1() -> Vec<FieldChoice> {
    choices(&[
        ("none", 0),
        ("mushroom", 1),
        ("empty", 2),
        ("red_potion", 3),
        ("green_potion", 4),
        ("blue_potion", 5),
        ("fairy", 6),
        ("bee", 7),
        ("good_bee", 8),
    ])
}

fn file(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "player.name",
                &format!("File {index} player name", index = scope.index),
                985,
                Storage::Ascii,
            )
            .description("Player name from the original English naming screen".into())
            .length(12)
            .editable(true)
            .text_codec("zelda_alttp_english_name")
            .presentation(
                field::Presentation::new(0, 985)
                    .text_length(6)
                    .step(None)
                    .encoding(Some("zelda_alttp_english_name")),
            ),
        scope
            .field("inventory.bow", "Bow", 832, Storage::U8)
            .description("Bow and silver-arrow upgrade state".into())
            .editable(true)
            .choices(choices(&[
                ("none", 0),
                ("bow", 1),
                ("bow_and_arrows", 2),
                ("silver_bow", 3),
                ("silver_bow_and_arrows", 4),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 832)
                        .choices(vec![
                            "none".into(),
                            "bow".into(),
                            "bow_and_arrows".into(),
                            "silver_bow".into(),
                            "silver_bow_and_arrows".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.boomerang", "Boomerang", 833, Storage::U8)
            .description("Boomerang upgrade state".into())
            .editable(true)
            .choices(choices(&[("none", 0), ("blue", 1), ("red", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 833)
                        .choices(vec!["none".into(), "blue".into(), "red".into()])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.mushroom_powder",
                "Mushroom or magic powder",
                836,
                Storage::U8,
            )
            .description("Mushroom and magic powder state".into())
            .editable(true)
            .choices(choices(&[("none", 0), ("mushroom", 1), ("powder", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 836)
                        .choices(vec!["none".into(), "mushroom".into(), "powder".into()])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.flute", "Flute", 844, Storage::U8)
            .description("Shovel and flute state".into())
            .editable(true)
            .choices(choices(&[
                ("none", 0),
                ("shovel", 1),
                ("inactive", 2),
                ("active", 3),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 844)
                        .choices(vec![
                            "none".into(),
                            "shovel".into(),
                            "inactive".into(),
                            "active".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.mirror", "Magic mirror", 851, Storage::U8)
            .description("Magic mirror item state".into())
            .editable(true)
            .choices(choices(&[
                ("none", 0),
                ("letter", 1),
                ("mirror", 2),
                ("scrapped_triforce", 3),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 851)
                        .choices(vec![
                            "none".into(),
                            "letter".into(),
                            "mirror".into(),
                            "scrapped_triforce".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.bottle_1", "Bottle 1", 860, Storage::U8)
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 860)
                        .choices(vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.bottle_2", "Bottle 2", 861, Storage::U8)
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 861)
                        .choices(vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.bottle_3", "Bottle 3", 862, Storage::U8)
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 862)
                        .choices(vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.bottle_4", "Bottle 4", 863, Storage::U8)
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 863)
                        .choices(vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("resources.rupees", "Rupees", 866, Storage::U16Le)
            .description("Rupees shown by the HUD".into())
            .min(0)
            .max(999)
            .editable(true)
            .copies(vec![scope.offset(864, 0)])
            .presentation(field::Presentation::new(0, 864)),
        scope
            .field("resources.bombs", "Bombs", 835, Storage::U8)
            .description("Bombs carried by the player".into())
            .min(0)
            .max(50)
            .editable(true)
            .presentation(field::Presentation::new(0, 835)),
        scope
            .field("resources.arrows", "Arrows", 887, Storage::U8)
            .description("Arrows carried by the player".into())
            .min(0)
            .max(70)
            .editable(true)
            .presentation(field::Presentation::new(0, 887)),
        scope
            .field(
                "hearts.capacity_eighths",
                "Heart capacity (eighths)",
                876,
                Storage::U8,
            )
            .description("Maximum health. Eight units equal one heart.".into())
            .min(24)
            .max(160)
            .editable(true)
            .presentation(field::Presentation::new(0, 876).step(Some(8))),
        scope
            .field(
                "hearts.current_eighths",
                "Current health (eighths)",
                877,
                Storage::U8,
            )
            .description("Current health. Eight units equal one heart.".into())
            .min(0)
            .max(160)
            .editable(true)
            .presentation(field::Presentation::new(0, 877)),
        scope
            .field("magic.current", "Current magic", 878, Storage::U8)
            .description("Current magic power. The original game caps this at 128.".into())
            .min(0)
            .max(128)
            .editable(true)
            .presentation(field::Presentation::new(0, 878)),
        scope
            .field("magic.consumption", "Magic consumption", 891, Storage::U8)
            .description("Magic consumption mode".into())
            .editable(true)
            .choices(choices(&[("normal", 0), ("half", 1), ("quarter", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 891)
                        .choices(vec!["normal".into(), "half".into(), "quarter".into()])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "resources.bomb_capacity_upgrades",
                "Bomb capacity upgrades",
                880,
                Storage::U8,
            )
            .description("Number of bomb capacity upgrades received".into())
            .min(0)
            .max(3)
            .editable(true)
            .presentation(field::Presentation::new(0, 880)),
        scope
            .field(
                "resources.arrow_capacity_upgrades",
                "Arrow capacity upgrades",
                881,
                Storage::U8,
            )
            .description("Number of arrow capacity upgrades received".into())
            .min(0)
            .max(3)
            .editable(true)
            .presentation(field::Presentation::new(0, 881)),
        scope
            .field(
                "progress.heart_pieces",
                "Heart pieces toward next container",
                875,
                Storage::U8,
            )
            .description("Heart pieces collected toward the next container".into())
            .min(0)
            .max(3)
            .editable(true)
            .presentation(field::Presentation::new(0, 875)),
        scope
            .field("equipment.sword", "Sword", 857, Storage::U8)
            .description("Sword level".into())
            .editable(true)
            .choices(choices(&[
                ("none", 0),
                ("fighter", 1),
                ("master", 2),
                ("tempered", 3),
                ("golden", 4),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 857)
                        .choices(vec![
                            "none".into(),
                            "fighter".into(),
                            "master".into(),
                            "tempered".into(),
                            "golden".into(),
                        ])
                        .step(None),
                ),
                value_override: Some(field::ValueOverride {
                    when: {
                        let address = scope.address();
                        rules::Condition::new(move |bytes| {
                            Ok((address.scalar(857, Storage::U8, None).read(bytes)?) == (255i64))
                        })
                    },
                    value: SaveValue::Enum("tempering".into()),
                    read_only: true,
                    description: Some("The smiths temporarily hold the sword".into()),
                    warnings: Some(vec![
                        "Finish the in-game tempering event before you edit this field".into(),
                    ]),
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("equipment.shield", "Shield", 858, Storage::U8)
            .description("Shield level".into())
            .editable(true)
            .choices(choices(&[
                ("none", 0),
                ("fighter", 1),
                ("red", 2),
                ("mirror", 3),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 858)
                        .choices(vec![
                            "none".into(),
                            "fighter".into(),
                            "red".into(),
                            "mirror".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("equipment.armor", "Armor", 859, Storage::U8)
            .description("Tunic color and defense level".into())
            .editable(true)
            .choices(choices(&[("green", 0), ("blue", 1), ("red", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 859)
                        .choices(vec!["green".into(), "blue".into(), "red".into()])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("equipment.gloves", "Gloves", 852, Storage::U8)
            .description("Strength glove level".into())
            .editable(true)
            .choices(choices(&[("none", 0), ("power", 1), ("titan", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 852)
                        .choices(vec!["none".into(), "power".into(), "titan".into()])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.hookshot", "Hookshot", 834, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 834)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.fire_rod", "Fire Rod", 837, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 837)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.ice_rod", "Ice Rod", 838, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 838)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.bombos", "Bombos", 839, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 839)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.ether", "Ether", 840, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 840)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.quake", "Quake", 841, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 841)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.lantern", "Lantern", 842, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 842)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.hammer", "Hammer", 843, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 843)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.bug_net", "Bug-Catching Net", 845, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 845)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field(
                "inventory.book_of_mudora",
                "Book of Mudora",
                846,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 846)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field(
                "inventory.cane_of_somaria",
                "Cane of Somaria",
                848,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 848)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field(
                "inventory.cane_of_byrna",
                "Cane of Byrna",
                849,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 849)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.cape", "Magic Cape", 850, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 850)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field(
                "inventory.pegasus_boots",
                "Pegasus Boots",
                853,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 853)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.flippers", "Zora's Flippers", 854, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 854)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .field("inventory.moon_pearl", "Moon Pearl", 855, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .presentation(
                field::Presentation::new(0, 855)
                    .kind(SaveFieldKind::BitfieldBoolean)
                    .step(None),
            ),
        scope
            .bit_field("progress.pendant_1", "Pendant 1", 884, 0)
            .description("Progress bit from the pendant state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 884).step(None)),
        scope
            .bit_field("progress.pendant_2", "Pendant 2", 884, 1)
            .description("Progress bit from the pendant state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 884).step(None)),
        scope
            .bit_field("progress.pendant_3", "Pendant 3", 884, 2)
            .description("Progress bit from the pendant state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 884).step(None)),
        scope
            .bit_field("progress.crystal_1", "Crystal 1", 890, 0)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 890).step(None)),
        scope
            .bit_field("progress.crystal_2", "Crystal 2", 890, 1)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 890).step(None)),
        scope
            .bit_field("progress.crystal_3", "Crystal 3", 890, 2)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 890).step(None)),
        scope
            .bit_field("progress.crystal_4", "Crystal 4", 890, 3)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 890).step(None)),
        scope
            .bit_field("progress.crystal_5", "Crystal 5", 890, 4)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 890).step(None)),
        scope
            .bit_field("progress.crystal_6", "Crystal 6", 890, 5)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 890).step(None)),
        scope
            .bit_field("progress.crystal_7", "Crystal 7", 890, 6)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 890).step(None)),
        scope
            .bit_field("progress.dungeons.sewers.compass", "Sewers compass", 868, 7)
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field("progress.dungeons.sewers.big_key", "Sewers big key", 870, 7)
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field("progress.dungeons.sewers.map", "Sewers map", 872, 7)
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.sewers.keys_earned",
                "Sewers keys earned",
                892,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 892)),
        scope
            .bit_field(
                "progress.dungeons.hyrule_castle.compass",
                "Hyrule Castle compass",
                868,
                6,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field(
                "progress.dungeons.hyrule_castle.big_key",
                "Hyrule Castle big key",
                870,
                6,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field(
                "progress.dungeons.hyrule_castle.map",
                "Hyrule Castle map",
                872,
                6,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.hyrule_castle.keys_earned",
                "Hyrule Castle keys earned",
                893,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 893)),
        scope
            .bit_field(
                "progress.dungeons.eastern_palace.compass",
                "Eastern Palace compass",
                868,
                5,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field(
                "progress.dungeons.eastern_palace.big_key",
                "Eastern Palace big key",
                870,
                5,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field(
                "progress.dungeons.eastern_palace.map",
                "Eastern Palace map",
                872,
                5,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.eastern_palace.keys_earned",
                "Eastern Palace keys earned",
                894,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 894)),
        scope
            .bit_field(
                "progress.dungeons.desert_palace.compass",
                "Desert Palace compass",
                868,
                4,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field(
                "progress.dungeons.desert_palace.big_key",
                "Desert Palace big key",
                870,
                4,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field(
                "progress.dungeons.desert_palace.map",
                "Desert Palace map",
                872,
                4,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.desert_palace.keys_earned",
                "Desert Palace keys earned",
                895,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 895)),
        scope
            .bit_field(
                "progress.dungeons.agahnims_tower.compass",
                "Agahnim's Tower compass",
                868,
                3,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field(
                "progress.dungeons.agahnims_tower.big_key",
                "Agahnim's Tower big key",
                870,
                3,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field(
                "progress.dungeons.agahnims_tower.map",
                "Agahnim's Tower map",
                872,
                3,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.agahnims_tower.keys_earned",
                "Agahnim's Tower keys earned",
                896,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 896)),
        scope
            .bit_field(
                "progress.dungeons.swamp_palace.compass",
                "Swamp Palace compass",
                868,
                2,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field(
                "progress.dungeons.swamp_palace.big_key",
                "Swamp Palace big key",
                870,
                2,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field(
                "progress.dungeons.swamp_palace.map",
                "Swamp Palace map",
                872,
                2,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.swamp_palace.keys_earned",
                "Swamp Palace keys earned",
                897,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 897)),
        scope
            .bit_field(
                "progress.dungeons.palace_of_darkness.compass",
                "Palace of Darkness compass",
                868,
                1,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field(
                "progress.dungeons.palace_of_darkness.big_key",
                "Palace of Darkness big key",
                870,
                1,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field(
                "progress.dungeons.palace_of_darkness.map",
                "Palace of Darkness map",
                872,
                1,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.palace_of_darkness.keys_earned",
                "Palace of Darkness keys earned",
                898,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 898)),
        scope
            .bit_field(
                "progress.dungeons.misery_mire.compass",
                "Misery Mire compass",
                868,
                0,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 868).step(None)),
        scope
            .bit_field(
                "progress.dungeons.misery_mire.big_key",
                "Misery Mire big key",
                870,
                0,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 870).step(None)),
        scope
            .bit_field(
                "progress.dungeons.misery_mire.map",
                "Misery Mire map",
                872,
                0,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 872).step(None)),
        scope
            .field(
                "progress.dungeons.misery_mire.keys_earned",
                "Misery Mire keys earned",
                899,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 899)),
        scope
            .bit_field(
                "progress.dungeons.skull_woods.compass",
                "Skull Woods compass",
                869,
                7,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 869).step(None)),
        scope
            .bit_field(
                "progress.dungeons.skull_woods.big_key",
                "Skull Woods big key",
                871,
                7,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 871).step(None)),
        scope
            .bit_field(
                "progress.dungeons.skull_woods.map",
                "Skull Woods map",
                873,
                7,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 873).step(None)),
        scope
            .field(
                "progress.dungeons.skull_woods.keys_earned",
                "Skull Woods keys earned",
                900,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 900)),
        scope
            .bit_field(
                "progress.dungeons.ice_palace.compass",
                "Ice Palace compass",
                869,
                6,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 869).step(None)),
        scope
            .bit_field(
                "progress.dungeons.ice_palace.big_key",
                "Ice Palace big key",
                871,
                6,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 871).step(None)),
        scope
            .bit_field("progress.dungeons.ice_palace.map", "Ice Palace map", 873, 6)
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 873).step(None)),
        scope
            .field(
                "progress.dungeons.ice_palace.keys_earned",
                "Ice Palace keys earned",
                901,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 901)),
        scope
            .bit_field(
                "progress.dungeons.tower_of_hera.compass",
                "Tower of Hera compass",
                869,
                5,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 869).step(None)),
        scope
            .bit_field(
                "progress.dungeons.tower_of_hera.big_key",
                "Tower of Hera big key",
                871,
                5,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 871).step(None)),
        scope
            .bit_field(
                "progress.dungeons.tower_of_hera.map",
                "Tower of Hera map",
                873,
                5,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 873).step(None)),
        scope
            .field(
                "progress.dungeons.tower_of_hera.keys_earned",
                "Tower of Hera keys earned",
                902,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 902)),
        scope
            .bit_field(
                "progress.dungeons.thieves_town.compass",
                "Thieves' Town compass",
                869,
                4,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 869).step(None)),
        scope
            .bit_field(
                "progress.dungeons.thieves_town.big_key",
                "Thieves' Town big key",
                871,
                4,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 871).step(None)),
        scope
            .bit_field(
                "progress.dungeons.thieves_town.map",
                "Thieves' Town map",
                873,
                4,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 873).step(None)),
        scope
            .field(
                "progress.dungeons.thieves_town.keys_earned",
                "Thieves' Town keys earned",
                903,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 903)),
        scope
            .bit_field(
                "progress.dungeons.turtle_rock.compass",
                "Turtle Rock compass",
                869,
                3,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 869).step(None)),
        scope
            .bit_field(
                "progress.dungeons.turtle_rock.big_key",
                "Turtle Rock big key",
                871,
                3,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 871).step(None)),
        scope
            .bit_field(
                "progress.dungeons.turtle_rock.map",
                "Turtle Rock map",
                873,
                3,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 873).step(None)),
        scope
            .field(
                "progress.dungeons.turtle_rock.keys_earned",
                "Turtle Rock keys earned",
                904,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 904)),
        scope
            .bit_field(
                "progress.dungeons.ganons_tower.compass",
                "Ganon's Tower compass",
                869,
                2,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 869).step(None)),
        scope
            .bit_field(
                "progress.dungeons.ganons_tower.big_key",
                "Ganon's Tower big key",
                871,
                2,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 871).step(None)),
        scope
            .bit_field(
                "progress.dungeons.ganons_tower.map",
                "Ganon's Tower map",
                873,
                2,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 873).step(None)),
        scope
            .field(
                "progress.dungeons.ganons_tower.keys_earned",
                "Ganon's Tower keys earned",
                905,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .presentation(field::Presentation::new(0, 905)),
        scope
            .field("progress.game_state", "Game state", 965, Storage::U8)
            .description("Main story state".into())
            .editable(true)
            .choices(choices(&[
                ("start", 0),
                ("uncle_reached", 1),
                ("zelda_rescued", 2),
                ("agahnim_defeated", 3),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 965)
                        .choices(vec![
                            "start".into(),
                            "uncle_reached".into(),
                            "zelda_rescued".into(),
                            "agahnim_defeated".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("progress.map_icon", "Map guidance icon", 967, Storage::U8)
            .description("Map icon guidance state".into())
            .editable(true)
            .choices(choices(&[
                ("castle", 0),
                ("kakariko", 1),
                ("eastern_palace", 2),
                ("master_sword", 3),
                ("master_sword_light_world", 4),
                ("agahnim", 5),
                ("palace_of_darkness", 6),
                ("crystals", 7),
                ("ganons_tower", 8),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 967)
                        .choices(vec![
                            "castle".into(),
                            "kakariko".into(),
                            "eastern_palace".into(),
                            "master_sword".into(),
                            "master_sword_light_world".into(),
                            "agahnim".into(),
                            "palace_of_darkness".into(),
                            "crystals".into(),
                            "ganons_tower".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("progress.spawn_point", "Save spawn point", 968, Storage::U8)
            .description("Save and continue spawn point".into())
            .editable(true)
            .choices(choices(&[
                ("links_house", 0),
                ("sanctuary", 1),
                ("prison", 2),
                ("uncle", 3),
                ("throne", 4),
                ("old_man_cave", 5),
                ("old_man_home", 6),
            ]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 968)
                        .choices(vec![
                            "links_house".into(),
                            "sanctuary".into(),
                            "prison".into(),
                            "uncle".into(),
                            "throne".into(),
                            "old_man_cave".into(),
                            "old_man_home".into(),
                        ])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("progress.save_world", "Save world", 970, Storage::U8)
            .description("World selected after loading the save".into())
            .editable(true)
            .choices(choices(&[("light", 0), ("dark", 1)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(
                    field::Presentation::new(0, 970)
                        .choices(vec!["light".into(), "dark".into()])
                        .step(None),
                ),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.early_story.uncle_secret_passage",
                "uncle_secret_passage",
                966,
                0,
            )
            .description("Uncle visited in the secret passage".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 966).step(None)),
        scope
            .bit_field(
                "progress.early_story.sanctuary_priest",
                "sanctuary_priest",
                966,
                1,
            )
            .description("Priest visited in the sanctuary".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 966).step(None)),
        scope
            .bit_field(
                "progress.early_story.zelda_sanctuary",
                "zelda_sanctuary",
                966,
                2,
            )
            .description("Zelda brought to the sanctuary".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 966).step(None)),
        scope
            .bit_field(
                "progress.early_story.uncle_left_house",
                "uncle_left_house",
                966,
                4,
            )
            .description("Uncle left Link's house".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 966).step(None)),
        scope
            .bit_field(
                "progress.early_story.book_progress",
                "book_progress",
                966,
                5,
            )
            .description("Book of Mudora progress".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 966).step(None)),
        scope
            .bit_field(
                "progress.early_story.fortune_teller_variant",
                "fortune_teller_variant",
                966,
                6,
            )
            .description("Fortune teller dialog variant".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 966).step(None)),
        scope
            .bit_field(
                "progress.side_quests.smith_tempering",
                "smith_tempering",
                969,
                7,
            )
            .description("Smiths are currently tempering the sword".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 969).step(None)),
        scope
            .bit_field(
                "progress.side_quests.swordsmith_rescued",
                "swordsmith_rescued",
                969,
                5,
            )
            .description("Swordsmith has been rescued".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 969).step(None)),
        scope
            .bit_field(
                "progress.side_quests.purple_chest_opened",
                "purple_chest_opened",
                969,
                4,
            )
            .description("Purple chest has been opened".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 969).step(None)),
        scope
            .bit_field(
                "progress.side_quests.stumpy_stumped",
                "stumpy_stumped",
                969,
                3,
            )
            .description("Stumpy has been stumped".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 969).step(None)),
        scope
            .bit_field(
                "progress.side_quests.bottle_purchased",
                "bottle_purchased",
                969,
                1,
            )
            .description("Bottle was purchased from the vendor".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 969).step(None)),
        scope
            .bit_field("progress.side_quests.hobo_bottle", "hobo_bottle", 969, 0)
            .description("Bottle was received from the hobo".into())
            .editable(true)
            .presentation(field::Presentation::new(0, 969).step(None)),
    ];

    fields
}

fn file_checksum(offset: usize) -> ChecksumDefinition {
    ChecksumDefinition {
        start: Some(offset),
        length: Some(1278),
        target: Some(23130),
        unit: ChecksumUnit::U16Le,
        ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, offset + 1278)
    }
}

fn file_candidate(slot: usize, physical_offset: usize) -> layout::Candidate {
    let signature_offset = physical_offset + 997;
    layout::Candidate {
        spans: vec![layout::Span {
            logical_offset: slot * 1280,
            physical_offset,
            length: 1280,
        }],
        signatures: vec![layout::Signature {
            offset: signature_offset,
            bytes: vec![170, 85],
        }],
        checksums: vec![file_checksum(physical_offset)],
        sections: vec![layout::FixedSection {
            id: slot as u8,
            physical_offset,
            checksum: file_checksum(physical_offset),
            signature: Some(rules::Scalar {
                offset: signature_offset,
                storage: Storage::U16Le,
                mask: None,
            }),
            counter: None,
        }],
        ..Default::default()
    }
}

fn file_group(slot: usize) -> layout::Group {
    let logical_offset = slot * 1280;
    layout::Group {
        id: format!("slot_{}", slot + 1),
        logical_offset,
        logical_length: 1280,
        copies: layout::Copies::Fixed {
            candidates: vec![
                file_candidate(slot, logical_offset),
                file_candidate(slot, logical_offset + 3840),
            ],
        },
        selection: layout::Selection::FirstValid,
        write: layout::WritePolicy::CloneSelectedToAll,
        empty: vec![0],
        empty_if_no_signature: false,
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([(
        "zelda_alttp_english_name".into(),
        text::TextCodec {
            unit: text::TextUnit::U16Le,
            max_chars: 6,
            max_units: Some(6),
            terminators: vec![],
            skip: vec![89],
            fill: 89,
            write_terminator: None,
            lane: Some(text::BitLane {
                logical_to_storage: vec![0, 1, 2, 3, 5, 6, 7, 8],
            }),
            mapping: text::TextMapping::Table {
                ranges: vec![
                    text::GlyphRange {
                        first: 'A',
                        last: 'Z',
                        first_code: 0,
                    },
                    text::GlyphRange {
                        first: 'a',
                        last: 'z',
                        first_code: 26,
                    },
                ],
                glyphs: BTreeMap::from([(' ', 95)]),
                aliases: BTreeMap::from([]),
            },
            decode_invalid: text::DecodeInvalid::Replacement { character: '�' },
            missing_terminator: text::MissingTerminator::Accept,
            errors: text::TextErrors {
                decode_invalid: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the save has unsupported player-name text".into(),
                },
                encode_invalid: text::TextError {
                    code: "save_name_charset".into(),
                    message: "the player name contains a character outside the original keyboard"
                        .into(),
                },
                missing_terminator: text::TextError {
                    code: "save_text_codec".into(),
                    message: "the player name has no terminator".into(),
                },
                too_long: text::TextError {
                    code: "save_name_length".into(),
                    message: "the player name is longer than six characters".into(),
                },
            },
            encode_transforms: vec![],
        },
    )]);

    let games = vec![game_zelda_a_link_to_the_past()];

    build(games, codecs, false)
}

fn initial_patches() -> Vec<generation::InitialPatch> {
    const PATCHES: &[(usize, &[u8])] = &[
        (525, &[240]),
        (527, &[240]),
        (876, &[24, 24]),
        (889, &[248]),
        (985, &[11]),
        (987, &[8]),
        (989, &[13]),
        (991, &[10]),
        (993, &[169]),
        (995, &[169]),
        (997, &[170, 85]),
        (1029, &[255, 255]),
        (1278, &[238, 67]),
    ];

    [0, 3840]
        .into_iter()
        .flat_map(|base| {
            PATCHES
                .iter()
                .map(move |(offset, bytes)| generation::InitialPatch {
                    offset: base + offset,
                    bytes: bytes.to_vec(),
                })
        })
        .collect()
}

fn zelda_byte_limits(base: usize, limits: &'static [(usize, u8)]) -> rules::Condition {
    rules::Condition::new(move |bytes| {
        for &(offset, limit) in limits {
            if read_at(bytes, (base + offset) as i64, Storage::U8)? > i64::from(limit) {
                return Ok(false);
            }
        }
        Ok(true)
    })
}

fn zelda_edit_checks(slot: usize) -> Vec<rules::Check> {
    let base = slot * 1280;
    let when = rules::Condition::new(move |bytes| {
        Ok(read_at(bytes, (base + 0x3e5) as i64, Storage::U16Le)? == 0x55aa)
    });
    let check = |code: &str, message: &str, assert| rules::Check {
        when: Some(when.clone()),
        assert,
        code: code.into(),
        message: message.into(),
        section_id: None,
        warning: None,
    };
    vec![
        check(
            "save_rupees",
            "the rupee value is above the original game limit",
            rules::Condition::new(move |bytes| {
                Ok(
                    read_at(bytes, (base + 0x360) as i64, Storage::U16Le)? <= 999
                        && read_at(bytes, (base + 0x362) as i64, Storage::U16Le)? <= 999,
                )
            }),
        ),
        check(
            "save_bombs",
            "the bomb value is above the original game limit",
            zelda_byte_limits(base, &[(0x343, 50)]),
        ),
        check(
            "save_arrows",
            "the arrow value is above the original game limit",
            zelda_byte_limits(base, &[(0x377, 70)]),
        ),
        check(
            "save_inventory",
            "an inventory item value is outside the original game range",
            zelda_byte_limits(
                base,
                &[
                    (0x340, 4),
                    (0x341, 2),
                    (0x344, 2),
                    (0x34c, 3),
                    (0x353, 3),
                    (0x35c, 8),
                    (0x35d, 8),
                    (0x35e, 8),
                    (0x35f, 8),
                ],
            ),
        ),
        check(
            "save_heart_pieces",
            "heart pieces must be from zero through three",
            zelda_byte_limits(base, &[(0x36b, 3)]),
        ),
        check(
            "save_magic",
            "magic power is above the original game limit",
            zelda_byte_limits(base, &[(0x36e, 128)]),
        ),
        check(
            "save_magic_consumption",
            "magic consumption is outside the original game range",
            zelda_byte_limits(base, &[(0x37b, 2)]),
        ),
        check(
            "save_capacity_upgrades",
            "capacity upgrades are above the original game limit",
            zelda_byte_limits(base, &[(0x370, 3), (0x371, 3)]),
        ),
        check(
            "save_progression",
            "a progression value is outside the original game range",
            zelda_byte_limits(base, &[(0x3c5, 3), (0x3c7, 8), (0x3c8, 6), (0x3ca, 1)]),
        ),
        check(
            "save_progression",
            "the high byte of the save world must be zero",
            zelda_byte_limits(base, &[(0x3cb, 0)]),
        ),
        check(
            "save_heart_capacity",
            "heart capacity must be from three through twenty whole hearts",
            rules::Condition::new(move |bytes| {
                let capacity = read_at(bytes, (base + 0x36c) as i64, Storage::U8)?;
                Ok((24..=160).contains(&capacity) && capacity % 8 == 0)
            }),
        ),
        check(
            "save_current_health",
            "current health cannot exceed heart capacity",
            rules::Condition::new(move |bytes| {
                Ok(read_at(bytes, (base + 0x36d) as i64, Storage::U8)?
                    <= read_at(bytes, (base + 0x36c) as i64, Storage::U8)?)
            }),
        ),
        check(
            "save_equipment",
            "the sword and smith progress values are inconsistent",
            rules::Condition::new(move |bytes| {
                let sword = read_at(bytes, (base + 0x359) as i64, Storage::U8)?;
                let smith = read_at(bytes, (base + 0x3c9) as i64, Storage::U8)? & 0x80 != 0;
                Ok((sword == 255 && smith) || (sword <= 4 && !smith))
            }),
        ),
        check(
            "save_equipment",
            "an equipment value is outside the original game range",
            zelda_byte_limits(base, &[(0x35a, 3), (0x35b, 2), (0x354, 2)]),
        ),
        check(
            "save_inventory",
            "an inventory flag is outside the original game range",
            zelda_byte_limits(
                base,
                &[
                    (0x342, 1),
                    (0x345, 1),
                    (0x346, 1),
                    (0x347, 1),
                    (0x348, 1),
                    (0x349, 1),
                    (0x34a, 1),
                    (0x34b, 1),
                    (0x34d, 1),
                    (0x34e, 1),
                    (0x350, 1),
                    (0x351, 1),
                    (0x352, 1),
                    (0x355, 1),
                    (0x356, 1),
                    (0x357, 1),
                ],
            ),
        ),
    ]
}

fn zelda_document_check(slot: usize) -> rules::Check {
    let checks = zelda_edit_checks(slot);
    rules::Check {
        when: checks[0].when.clone(),
        assert: rules::Condition::new(move |bytes| {
            for check in &checks {
                if !check.assert.test(bytes)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }),
        code: "exposed_value_invalid".into(),
        message: format!(
            "File {} has a value outside the original game range",
            slot + 1
        ),
        section_id: Some(slot as u8),
        warning: Some("Normal editing is disabled because one file has an invalid value".into()),
    }
}

fn game_zelda_a_link_to_the_past() -> GameDefinition {
    let mut fields = Vec::new();
    for slot in 0..3 {
        fields.extend(file(&FieldScope {
            base: slot * 1280,
            index: (slot + 1).to_string(),
            ordinal: 1,
            prefix: format!("slot_{}", slot + 1),
            group: Some(format!("slot_{}", slot + 1)),
            ..Default::default()
        }));
    }
    GameDefinition {
        fields,
        generation: Some(generation::GenerationDefinition {
            fill: 0,
            patches: initial_patches(),
            values: BTreeMap::from([]),
        }),
        runtime: runtime::Runtime {
            family: Some("zelda-alttp".into()),
            handler_id: Some("zelda-alttp".into()),
            save_format: Some("snes_sram_8k".into()),
            save_format_name: Some("Battery SRAM 8 KiB".into()),
            checksum_sizes: vec![1280, 1280, 1280],
            layout: Some(layout::Layout {
                groups: (0..3).map(file_group).collect(),
            }),
            recognition: Some(runtime::Recognition {
                checks: Vec::new(),
                reasons: vec![
                    SaveRecognitionReason::ChecksumValid,
                    SaveRecognitionReason::SignatureValid,
                ],
                confidence: SaveRecognitionConfidence::High,
                incomplete_confidence: Some(SaveRecognitionConfidence::Medium),
                selected_reason: false,
                empty_top_level_reasons: false,
            }),
            document_checks: (0..3).map(zelda_document_check).collect(),
            edit_checks: (0..3).flat_map(zelda_edit_checks).collect(),
            recovery: Some(runtime::Recovery {
                no_valid: runtime::Failure {
                    code: "save_integrity_invalid".into(),
                    message: "the save has no valid Zelda file copy".into(),
                },
                incomplete: Some(runtime::RecoveryOutcome {
                    state: SaveIntegrityState::ValidWithWarnings,
                    disable_editing: false,
                    issue: Some(runtime::Failure {
                        code: "duplicate_copy_invalid".into(),
                        message: "File {slot} has one invalid duplicate copy".into(),
                    }),
                    warning: Some("An edit repairs both copies of its target file".into()),
                    field_warning: None,
                    edit_error: None,
                    parse_error: None,
                    section_id: true,
                }),
                damaged: Some(runtime::RecoveryOutcome {
                    state: SaveIntegrityState::ValidWithWarnings,
                    disable_editing: false,
                    issue: Some(runtime::Failure {
                        code: "duplicate_copy_invalid".into(),
                        message: "File {slot} has one invalid duplicate copy".into(),
                    }),
                    warning: Some("An edit repairs both copies of its target file".into()),
                    field_warning: None,
                    edit_error: None,
                    parse_error: None,
                    section_id: true,
                }),
                unrecoverable: Some(runtime::RecoveryOutcome {
                    state: SaveIntegrityState::PartiallyRecoverable,
                    disable_editing: true,
                    issue: Some(runtime::Failure {
                        code: "file_invalid".into(),
                        message: "File {slot} has no valid copy".into(),
                    }),
                    warning: Some(
                        "Normal editing is disabled because one file has no valid copy".into(),
                    ),
                    field_warning: None,
                    edit_error: Some(runtime::Failure {
                        code: "save_integrity_partial".into(),
                        message: "normal edits need every nonempty Zelda file to have a valid copy"
                            .into(),
                    }),
                    parse_error: None,
                    section_id: true,
                }),
                differing: Some(runtime::RecoveryOutcome {
                    state: SaveIntegrityState::ValidWithWarnings,
                    disable_editing: false,
                    issue: Some(runtime::Failure {
                        code: "duplicate_copy_mismatch".into(),
                        message: "File {slot} duplicate copies differ; the primary copy is used"
                            .into(),
                    }),
                    warning: Some("An edit repairs both copies of its target file".into()),
                    field_warning: None,
                    edit_error: None,
                    parse_error: None,
                    section_id: true,
                }),
                active_group: true,
                zero_counter: true,
            }),
            ..Default::default()
        },
        ..GameDefinition::new(
            "zelda-a-link-to-the-past".into(),
            "The Legend of Zelda: A Link to the Past".into(),
            "snes".into(),
            8192,
        )
    }
}
