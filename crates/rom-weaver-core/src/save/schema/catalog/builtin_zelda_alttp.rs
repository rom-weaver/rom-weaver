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
                "player.name".into(),
                format!("File {index} player name", index = scope.index),
                985,
                Storage::Ascii,
            )
            .description("Player name from the original English naming screen".into())
            .length(12)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                text_codec: Some("zelda_alttp_english_name".into()),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: Some(6),
                        choices: vec![],
                    }),
                    step: Some(None),
                    encoding: Some(Some("zelda_alttp_english_name".into())),
                    ..field::Presentation::new(0, 985)
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.bow".into(), "Bow".into(), 832, Storage::U8)
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "bow".into(),
                            "bow_and_arrows".into(),
                            "silver_bow".into(),
                            "silver_bow_and_arrows".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 832)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.boomerang".into(),
                "Boomerang".into(),
                833,
                Storage::U8,
            )
            .description("Boomerang upgrade state".into())
            .editable(true)
            .choices(choices(&[("none", 0), ("blue", 1), ("red", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["none".into(), "blue".into(), "red".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 833)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.mushroom_powder".into(),
                "Mushroom or magic powder".into(),
                836,
                Storage::U8,
            )
            .description("Mushroom and magic powder state".into())
            .editable(true)
            .choices(choices(&[("none", 0), ("mushroom", 1), ("powder", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["none".into(), "mushroom".into(), "powder".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 836)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.flute".into(), "Flute".into(), 844, Storage::U8)
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "shovel".into(),
                            "inactive".into(),
                            "active".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 844)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.mirror".into(),
                "Magic mirror".into(),
                851,
                Storage::U8,
            )
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "letter".into(),
                            "mirror".into(),
                            "scrapped_triforce".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 851)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.bottle_1".into(),
                "Bottle 1".into(),
                860,
                Storage::U8,
            )
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 860)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.bottle_2".into(),
                "Bottle 2".into(),
                861,
                Storage::U8,
            )
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 861)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.bottle_3".into(),
                "Bottle 3".into(),
                862,
                Storage::U8,
            )
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 862)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.bottle_4".into(),
                "Bottle 4".into(),
                863,
                Storage::U8,
            )
            .description("Bottle contents".into())
            .editable(true)
            .choices(bottle_1())
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "mushroom".into(),
                            "empty".into(),
                            "red_potion".into(),
                            "green_potion".into(),
                            "blue_potion".into(),
                            "fairy".into(),
                            "bee".into(),
                            "good_bee".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 863)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "resources.rupees".into(),
                "Rupees".into(),
                866,
                Storage::U16Le,
            )
            .description("Rupees shown by the HUD".into())
            .min(0)
            .max(999)
            .editable(true)
            .copies(vec![scope.offset(864, 0)])
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 864)
                }),
                ..Default::default()
            }),
        scope
            .field("resources.bombs".into(), "Bombs".into(), 835, Storage::U8)
            .description("Bombs carried by the player".into())
            .min(0)
            .max(50)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 835)
                }),
                ..Default::default()
            }),
        scope
            .field("resources.arrows".into(), "Arrows".into(), 887, Storage::U8)
            .description("Arrows carried by the player".into())
            .min(0)
            .max(70)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 887)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "hearts.capacity_eighths".into(),
                "Heart capacity (eighths)".into(),
                876,
                Storage::U8,
            )
            .description("Maximum health. Eight units equal one heart.".into())
            .min(24)
            .max(160)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(Some(8)),
                    ..field::Presentation::new(0, 876)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "hearts.current_eighths".into(),
                "Current health (eighths)".into(),
                877,
                Storage::U8,
            )
            .description("Current health. Eight units equal one heart.".into())
            .min(0)
            .max(160)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 877)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "magic.current".into(),
                "Current magic".into(),
                878,
                Storage::U8,
            )
            .description("Current magic power. The original game caps this at 128.".into())
            .min(0)
            .max(128)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 878)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "magic.consumption".into(),
                "Magic consumption".into(),
                891,
                Storage::U8,
            )
            .description("Magic consumption mode".into())
            .editable(true)
            .choices(choices(&[("normal", 0), ("half", 1), ("quarter", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["normal".into(), "half".into(), "quarter".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 891)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "resources.bomb_capacity_upgrades".into(),
                "Bomb capacity upgrades".into(),
                880,
                Storage::U8,
            )
            .description("Number of bomb capacity upgrades received".into())
            .min(0)
            .max(3)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 880)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "resources.arrow_capacity_upgrades".into(),
                "Arrow capacity upgrades".into(),
                881,
                Storage::U8,
            )
            .description("Number of arrow capacity upgrades received".into())
            .min(0)
            .max(3)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 881)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.heart_pieces".into(),
                "Heart pieces toward next container".into(),
                875,
                Storage::U8,
            )
            .description("Heart pieces collected toward the next container".into())
            .min(0)
            .max(3)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 875)
                }),
                ..Default::default()
            }),
        scope
            .field("equipment.sword".into(), "Sword".into(), 857, Storage::U8)
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "fighter".into(),
                            "master".into(),
                            "tempered".into(),
                            "golden".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 857)
                }),
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
            .field("equipment.shield".into(), "Shield".into(), 858, Storage::U8)
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "none".into(),
                            "fighter".into(),
                            "red".into(),
                            "mirror".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 858)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("equipment.armor".into(), "Armor".into(), 859, Storage::U8)
            .description("Tunic color and defense level".into())
            .editable(true)
            .choices(choices(&[("green", 0), ("blue", 1), ("red", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["green".into(), "blue".into(), "red".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 859)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field("equipment.gloves".into(), "Gloves".into(), 852, Storage::U8)
            .description("Strength glove level".into())
            .editable(true)
            .choices(choices(&[("none", 0), ("power", 1), ("titan", 2)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["none".into(), "power".into(), "titan".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 852)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.hookshot".into(),
                "Hookshot".into(),
                834,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 834)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.fire_rod".into(),
                "Fire Rod".into(),
                837,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 837)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.ice_rod".into(),
                "Ice Rod".into(),
                838,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 838)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.bombos".into(),
                "Bombos".into(),
                839,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 839)
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.ether".into(), "Ether".into(), 840, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 840)
                }),
                ..Default::default()
            }),
        scope
            .field("inventory.quake".into(), "Quake".into(), 841, Storage::Bool)
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 841)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.lantern".into(),
                "Lantern".into(),
                842,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 842)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.hammer".into(),
                "Hammer".into(),
                843,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 843)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.bug_net".into(),
                "Bug-Catching Net".into(),
                845,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 845)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.book_of_mudora".into(),
                "Book of Mudora".into(),
                846,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 846)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.cane_of_somaria".into(),
                "Cane of Somaria".into(),
                848,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 848)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.cane_of_byrna".into(),
                "Cane of Byrna".into(),
                849,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 849)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.cape".into(),
                "Magic Cape".into(),
                850,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 850)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.pegasus_boots".into(),
                "Pegasus Boots".into(),
                853,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 853)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.flippers".into(),
                "Zora's Flippers".into(),
                854,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 854)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "inventory.moon_pearl".into(),
                "Moon Pearl".into(),
                855,
                Storage::Bool,
            )
            .description("Inventory item".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    kind: Some(SaveFieldKind::BitfieldBoolean),
                    step: Some(None),
                    ..field::Presentation::new(0, 855)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.pendant_1".into(), "Pendant 1".into(), 884, 0)
            .description("Progress bit from the pendant state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 884)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.pendant_2".into(), "Pendant 2".into(), 884, 1)
            .description("Progress bit from the pendant state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 884)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.pendant_3".into(), "Pendant 3".into(), 884, 2)
            .description("Progress bit from the pendant state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 884)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.crystal_1".into(), "Crystal 1".into(), 890, 0)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 890)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.crystal_2".into(), "Crystal 2".into(), 890, 1)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 890)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.crystal_3".into(), "Crystal 3".into(), 890, 2)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 890)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.crystal_4".into(), "Crystal 4".into(), 890, 3)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 890)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.crystal_5".into(), "Crystal 5".into(), 890, 4)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 890)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.crystal_6".into(), "Crystal 6".into(), 890, 5)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 890)
                }),
                ..Default::default()
            }),
        scope
            .bit_field("progress.crystal_7".into(), "Crystal 7".into(), 890, 6)
            .description("Progress bit from the crystal state byte".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 890)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.sewers.compass".into(),
                "Sewers compass".into(),
                868,
                7,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.sewers.big_key".into(),
                "Sewers big key".into(),
                870,
                7,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.sewers.map".into(),
                "Sewers map".into(),
                872,
                7,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.sewers.keys_earned".into(),
                "Sewers keys earned".into(),
                892,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 892)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.hyrule_castle.compass".into(),
                "Hyrule Castle compass".into(),
                868,
                6,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.hyrule_castle.big_key".into(),
                "Hyrule Castle big key".into(),
                870,
                6,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.hyrule_castle.map".into(),
                "Hyrule Castle map".into(),
                872,
                6,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.hyrule_castle.keys_earned".into(),
                "Hyrule Castle keys earned".into(),
                893,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 893)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.eastern_palace.compass".into(),
                "Eastern Palace compass".into(),
                868,
                5,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.eastern_palace.big_key".into(),
                "Eastern Palace big key".into(),
                870,
                5,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.eastern_palace.map".into(),
                "Eastern Palace map".into(),
                872,
                5,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.eastern_palace.keys_earned".into(),
                "Eastern Palace keys earned".into(),
                894,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 894)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.desert_palace.compass".into(),
                "Desert Palace compass".into(),
                868,
                4,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.desert_palace.big_key".into(),
                "Desert Palace big key".into(),
                870,
                4,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.desert_palace.map".into(),
                "Desert Palace map".into(),
                872,
                4,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.desert_palace.keys_earned".into(),
                "Desert Palace keys earned".into(),
                895,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 895)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.agahnims_tower.compass".into(),
                "Agahnim's Tower compass".into(),
                868,
                3,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.agahnims_tower.big_key".into(),
                "Agahnim's Tower big key".into(),
                870,
                3,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.agahnims_tower.map".into(),
                "Agahnim's Tower map".into(),
                872,
                3,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.agahnims_tower.keys_earned".into(),
                "Agahnim's Tower keys earned".into(),
                896,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 896)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.swamp_palace.compass".into(),
                "Swamp Palace compass".into(),
                868,
                2,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.swamp_palace.big_key".into(),
                "Swamp Palace big key".into(),
                870,
                2,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.swamp_palace.map".into(),
                "Swamp Palace map".into(),
                872,
                2,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.swamp_palace.keys_earned".into(),
                "Swamp Palace keys earned".into(),
                897,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 897)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.palace_of_darkness.compass".into(),
                "Palace of Darkness compass".into(),
                868,
                1,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.palace_of_darkness.big_key".into(),
                "Palace of Darkness big key".into(),
                870,
                1,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.palace_of_darkness.map".into(),
                "Palace of Darkness map".into(),
                872,
                1,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.palace_of_darkness.keys_earned".into(),
                "Palace of Darkness keys earned".into(),
                898,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 898)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.misery_mire.compass".into(),
                "Misery Mire compass".into(),
                868,
                0,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 868)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.misery_mire.big_key".into(),
                "Misery Mire big key".into(),
                870,
                0,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 870)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.misery_mire.map".into(),
                "Misery Mire map".into(),
                872,
                0,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 872)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.misery_mire.keys_earned".into(),
                "Misery Mire keys earned".into(),
                899,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 899)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.skull_woods.compass".into(),
                "Skull Woods compass".into(),
                869,
                7,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 869)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.skull_woods.big_key".into(),
                "Skull Woods big key".into(),
                871,
                7,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 871)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.skull_woods.map".into(),
                "Skull Woods map".into(),
                873,
                7,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 873)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.skull_woods.keys_earned".into(),
                "Skull Woods keys earned".into(),
                900,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 900)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.ice_palace.compass".into(),
                "Ice Palace compass".into(),
                869,
                6,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 869)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.ice_palace.big_key".into(),
                "Ice Palace big key".into(),
                871,
                6,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 871)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.ice_palace.map".into(),
                "Ice Palace map".into(),
                873,
                6,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 873)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.ice_palace.keys_earned".into(),
                "Ice Palace keys earned".into(),
                901,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 901)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.tower_of_hera.compass".into(),
                "Tower of Hera compass".into(),
                869,
                5,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 869)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.tower_of_hera.big_key".into(),
                "Tower of Hera big key".into(),
                871,
                5,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 871)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.tower_of_hera.map".into(),
                "Tower of Hera map".into(),
                873,
                5,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 873)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.tower_of_hera.keys_earned".into(),
                "Tower of Hera keys earned".into(),
                902,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 902)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.thieves_town.compass".into(),
                "Thieves' Town compass".into(),
                869,
                4,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 869)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.thieves_town.big_key".into(),
                "Thieves' Town big key".into(),
                871,
                4,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 871)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.thieves_town.map".into(),
                "Thieves' Town map".into(),
                873,
                4,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 873)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.thieves_town.keys_earned".into(),
                "Thieves' Town keys earned".into(),
                903,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 903)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.turtle_rock.compass".into(),
                "Turtle Rock compass".into(),
                869,
                3,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 869)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.turtle_rock.big_key".into(),
                "Turtle Rock big key".into(),
                871,
                3,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 871)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.turtle_rock.map".into(),
                "Turtle Rock map".into(),
                873,
                3,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 873)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.turtle_rock.keys_earned".into(),
                "Turtle Rock keys earned".into(),
                904,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 904)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.ganons_tower.compass".into(),
                "Ganon's Tower compass".into(),
                869,
                2,
            )
            .description("Dungeon compass ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 869)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.ganons_tower.big_key".into(),
                "Ganon's Tower big key".into(),
                871,
                2,
            )
            .description("Dungeon big key ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 871)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.dungeons.ganons_tower.map".into(),
                "Ganon's Tower map".into(),
                873,
                2,
            )
            .description("Dungeon map ownership".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 873)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.dungeons.ganons_tower.keys_earned".into(),
                "Ganon's Tower keys earned".into(),
                905,
                Storage::U8,
            )
            .description("Number of keys earned in this dungeon".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 905)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.game_state".into(),
                "Game state".into(),
                965,
                Storage::U8,
            )
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "start".into(),
                            "uncle_reached".into(),
                            "zelda_rescued".into(),
                            "agahnim_defeated".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 965)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.map_icon".into(),
                "Map guidance icon".into(),
                967,
                Storage::U8,
            )
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "castle".into(),
                            "kakariko".into(),
                            "eastern_palace".into(),
                            "master_sword".into(),
                            "master_sword_light_world".into(),
                            "agahnim".into(),
                            "palace_of_darkness".into(),
                            "crystals".into(),
                            "ganons_tower".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 967)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.spawn_point".into(),
                "Save spawn point".into(),
                968,
                Storage::U8,
            )
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
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec![
                            "links_house".into(),
                            "sanctuary".into(),
                            "prison".into(),
                            "uncle".into(),
                            "throne".into(),
                            "old_man_cave".into(),
                            "old_man_home".into(),
                        ],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 968)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.save_world".into(),
                "Save world".into(),
                970,
                Storage::U8,
            )
            .description("World selected after loading the save".into())
            .editable(true)
            .choices(choices(&[("light", 0), ("dark", 1)]))
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    constraints: Some(SaveConstraint {
                        min: None,
                        max: None,
                        max_length: None,
                        choices: vec!["light".into(), "dark".into()],
                    }),
                    step: Some(None),
                    ..field::Presentation::new(0, 970)
                }),
                unknown_choice: Some(field::UnknownChoice {
                    value: "unknown".into(),
                    warning: "The stored value is outside the original game range".into(),
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.early_story.uncle_secret_passage".into(),
                "uncle_secret_passage".into(),
                966,
                0,
            )
            .description("Uncle visited in the secret passage".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 966)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.early_story.sanctuary_priest".into(),
                "sanctuary_priest".into(),
                966,
                1,
            )
            .description("Priest visited in the sanctuary".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 966)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.early_story.zelda_sanctuary".into(),
                "zelda_sanctuary".into(),
                966,
                2,
            )
            .description("Zelda brought to the sanctuary".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 966)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.early_story.uncle_left_house".into(),
                "uncle_left_house".into(),
                966,
                4,
            )
            .description("Uncle left Link's house".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 966)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.early_story.book_progress".into(),
                "book_progress".into(),
                966,
                5,
            )
            .description("Book of Mudora progress".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 966)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.early_story.fortune_teller_variant".into(),
                "fortune_teller_variant".into(),
                966,
                6,
            )
            .description("Fortune teller dialog variant".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 966)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.side_quests.smith_tempering".into(),
                "smith_tempering".into(),
                969,
                7,
            )
            .description("Smiths are currently tempering the sword".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 969)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.side_quests.swordsmith_rescued".into(),
                "swordsmith_rescued".into(),
                969,
                5,
            )
            .description("Swordsmith has been rescued".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 969)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.side_quests.purple_chest_opened".into(),
                "purple_chest_opened".into(),
                969,
                4,
            )
            .description("Purple chest has been opened".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 969)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.side_quests.stumpy_stumped".into(),
                "stumpy_stumped".into(),
                969,
                3,
            )
            .description("Stumpy has been stumped".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 969)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.side_quests.bottle_purchased".into(),
                "bottle_purchased".into(),
                969,
                1,
            )
            .description("Bottle was purchased from the vendor".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 969)
                }),
                ..Default::default()
            }),
        scope
            .bit_field(
                "progress.side_quests.hobo_bottle".into(),
                "hobo_bottle".into(),
                969,
                0,
            )
            .description("Bottle was received from the hobo".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: Some(format!("slot_{index}", index = scope.index)),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 969)
                }),
                ..Default::default()
            }),
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
