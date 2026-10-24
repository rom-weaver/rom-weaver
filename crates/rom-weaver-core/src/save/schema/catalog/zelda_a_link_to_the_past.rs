use super::*;

const SLOT_SIZE: usize = 1280;
const BACKUP_OFFSET: usize = 3840;

fn file_fields(slot: usize) -> Vec<FieldDefinition> {
    let base = (slot - 1) * SLOT_SIZE;
    let mut fields = vec![
        catalog_field("slot_1.resources.bombs", "Bombs", 835, Storage::U8)
            .description("Bombs carried by the player".into()),
        catalog_field("slot_1.resources.arrows", "Arrows", 887, Storage::U8)
            .description("Arrows carried by the player".into()),
        catalog_field(
            "slot_1.hearts.capacity_eighths",
            "Heart capacity (eighths)",
            876,
            Storage::U8,
        )
        .description("Maximum health; eight units equal one heart".into()),
        catalog_field(
            "slot_1.hearts.current_eighths",
            "Current health (eighths)",
            877,
            Storage::U8,
        )
        .description("Current health; eight units equal one heart".into()),
        catalog_field("slot_1.magic.current", "Current magic", 878, Storage::U8)
            .description("Current magic power".into()),
        catalog_field(
            "slot_1.resources.bomb_capacity_upgrades",
            "Bomb capacity upgrades",
            880,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.resources.arrow_capacity_upgrades",
            "Arrow capacity upgrades",
            881,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.heart_pieces",
            "Heart pieces toward next container",
            875,
            Storage::U8,
        ),
        catalog_field("slot_1.inventory.hookshot", "Hookshot", 834, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field("slot_1.inventory.fire_rod", "Fire Rod", 837, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field("slot_1.inventory.ice_rod", "Ice Rod", 838, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field("slot_1.inventory.bombos", "Bombos", 839, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field("slot_1.inventory.ether", "Ether", 840, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field("slot_1.inventory.quake", "Quake", 841, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field("slot_1.inventory.lantern", "Lantern", 842, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field("slot_1.inventory.hammer", "Hammer", 843, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field(
            "slot_1.inventory.bug_net",
            "Bug-Catching Net",
            845,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        catalog_field(
            "slot_1.inventory.book_of_mudora",
            "Book of Mudora",
            846,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        catalog_field(
            "slot_1.inventory.cane_of_somaria",
            "Cane of Somaria",
            848,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        catalog_field(
            "slot_1.inventory.cane_of_byrna",
            "Cane of Byrna",
            849,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        catalog_field("slot_1.inventory.cape", "Magic Cape", 850, Storage::Bool)
            .description("Inventory item".into()),
        catalog_field(
            "slot_1.inventory.pegasus_boots",
            "Pegasus Boots",
            853,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        catalog_field(
            "slot_1.inventory.flippers",
            "Zora's Flippers",
            854,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        catalog_field(
            "slot_1.inventory.moon_pearl",
            "Moon Pearl",
            855,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        catalog_field("slot_1.progress.pendant_1", "Pendant 1", 884, Storage::Bit).bit(0),
        catalog_field("slot_1.progress.pendant_2", "Pendant 2", 884, Storage::Bit).bit(1),
        catalog_field("slot_1.progress.pendant_3", "Pendant 3", 884, Storage::Bit).bit(2),
        catalog_field("slot_1.progress.crystal_1", "Crystal 1", 890, Storage::Bit).bit(0),
        catalog_field("slot_1.progress.crystal_2", "Crystal 2", 890, Storage::Bit).bit(1),
        catalog_field("slot_1.progress.crystal_3", "Crystal 3", 890, Storage::Bit).bit(2),
        catalog_field("slot_1.progress.crystal_4", "Crystal 4", 890, Storage::Bit).bit(3),
        catalog_field("slot_1.progress.crystal_5", "Crystal 5", 890, Storage::Bit).bit(4),
        catalog_field("slot_1.progress.crystal_6", "Crystal 6", 890, Storage::Bit).bit(5),
        catalog_field("slot_1.progress.crystal_7", "Crystal 7", 890, Storage::Bit).bit(6),
        catalog_field(
            "slot_1.progress.dungeons.sewers.compass",
            "sewers compass",
            868,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.progress.dungeons.sewers.big_key",
            "sewers big_key",
            870,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.progress.dungeons.sewers.map",
            "sewers map",
            872,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.progress.dungeons.sewers.keys_earned",
            "sewers keys earned",
            892,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.hyrule_castle.compass",
            "hyrule_castle compass",
            868,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.progress.dungeons.hyrule_castle.big_key",
            "hyrule_castle big_key",
            870,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.progress.dungeons.hyrule_castle.map",
            "hyrule_castle map",
            872,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.progress.dungeons.hyrule_castle.keys_earned",
            "hyrule_castle keys earned",
            893,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.eastern_palace.compass",
            "eastern_palace compass",
            868,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.dungeons.eastern_palace.big_key",
            "eastern_palace big_key",
            870,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.dungeons.eastern_palace.map",
            "eastern_palace map",
            872,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.dungeons.eastern_palace.keys_earned",
            "eastern_palace keys earned",
            894,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.desert_palace.compass",
            "desert_palace compass",
            868,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.dungeons.desert_palace.big_key",
            "desert_palace big_key",
            870,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.dungeons.desert_palace.map",
            "desert_palace map",
            872,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.dungeons.desert_palace.keys_earned",
            "desert_palace keys earned",
            895,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.agahnims_tower.compass",
            "agahnims_tower compass",
            868,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.progress.dungeons.agahnims_tower.big_key",
            "agahnims_tower big_key",
            870,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.progress.dungeons.agahnims_tower.map",
            "agahnims_tower map",
            872,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.progress.dungeons.agahnims_tower.keys_earned",
            "agahnims_tower keys earned",
            896,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.swamp_palace.compass",
            "swamp_palace compass",
            868,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.progress.dungeons.swamp_palace.big_key",
            "swamp_palace big_key",
            870,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.progress.dungeons.swamp_palace.map",
            "swamp_palace map",
            872,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.progress.dungeons.swamp_palace.keys_earned",
            "swamp_palace keys earned",
            897,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.palace_of_darkness.compass",
            "palace_of_darkness compass",
            868,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_1.progress.dungeons.palace_of_darkness.big_key",
            "palace_of_darkness big_key",
            870,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_1.progress.dungeons.palace_of_darkness.map",
            "palace_of_darkness map",
            872,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_1.progress.dungeons.palace_of_darkness.keys_earned",
            "palace_of_darkness keys earned",
            898,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.misery_mire.compass",
            "misery_mire compass",
            868,
            Storage::Bit,
        )
        .bit(0),
        catalog_field(
            "slot_1.progress.dungeons.misery_mire.big_key",
            "misery_mire big_key",
            870,
            Storage::Bit,
        )
        .bit(0),
        catalog_field(
            "slot_1.progress.dungeons.misery_mire.map",
            "misery_mire map",
            872,
            Storage::Bit,
        )
        .bit(0),
        catalog_field(
            "slot_1.progress.dungeons.misery_mire.keys_earned",
            "misery_mire keys earned",
            899,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.skull_woods.compass",
            "skull_woods compass",
            869,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.progress.dungeons.skull_woods.big_key",
            "skull_woods big_key",
            871,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.progress.dungeons.skull_woods.map",
            "skull_woods map",
            873,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.progress.dungeons.skull_woods.keys_earned",
            "skull_woods keys earned",
            900,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.ice_palace.compass",
            "ice_palace compass",
            869,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.progress.dungeons.ice_palace.big_key",
            "ice_palace big_key",
            871,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.progress.dungeons.ice_palace.map",
            "ice_palace map",
            873,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.progress.dungeons.ice_palace.keys_earned",
            "ice_palace keys earned",
            901,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.tower_of_hera.compass",
            "tower_of_hera compass",
            869,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.dungeons.tower_of_hera.big_key",
            "tower_of_hera big_key",
            871,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.dungeons.tower_of_hera.map",
            "tower_of_hera map",
            873,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.dungeons.tower_of_hera.keys_earned",
            "tower_of_hera keys earned",
            902,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.thieves_town.compass",
            "thieves_town compass",
            869,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.dungeons.thieves_town.big_key",
            "thieves_town big_key",
            871,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.dungeons.thieves_town.map",
            "thieves_town map",
            873,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.dungeons.thieves_town.keys_earned",
            "thieves_town keys earned",
            903,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.turtle_rock.compass",
            "turtle_rock compass",
            869,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.progress.dungeons.turtle_rock.big_key",
            "turtle_rock big_key",
            871,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.progress.dungeons.turtle_rock.map",
            "turtle_rock map",
            873,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.progress.dungeons.turtle_rock.keys_earned",
            "turtle_rock keys earned",
            904,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.dungeons.ganons_tower.compass",
            "ganons_tower compass",
            869,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.progress.dungeons.ganons_tower.big_key",
            "ganons_tower big_key",
            871,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.progress.dungeons.ganons_tower.map",
            "ganons_tower map",
            873,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.progress.dungeons.ganons_tower.keys_earned",
            "ganons_tower keys earned",
            905,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.progress.early_story.uncle_secret_passage",
            "uncle_secret_passage",
            966,
            Storage::Bit,
        )
        .bit(0),
        catalog_field(
            "slot_1.progress.early_story.sanctuary_priest",
            "sanctuary_priest",
            966,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_1.progress.early_story.zelda_sanctuary",
            "zelda_sanctuary",
            966,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "slot_1.progress.early_story.uncle_left_house",
            "uncle_left_house",
            966,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.early_story.book_progress",
            "book_progress",
            966,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.early_story.fortune_teller_variant",
            "fortune_teller_variant",
            966,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "slot_1.progress.side_quests.smith_tempering",
            "smith_tempering",
            969,
            Storage::Bit,
        )
        .bit(7),
        catalog_field(
            "slot_1.progress.side_quests.swordsmith_rescued",
            "swordsmith_rescued",
            969,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "slot_1.progress.side_quests.purple_chest_opened",
            "purple_chest_opened",
            969,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "slot_1.progress.side_quests.stumpy_stumped",
            "stumpy_stumped",
            969,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "slot_1.progress.side_quests.bottle_purchased",
            "bottle_purchased",
            969,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "slot_1.progress.side_quests.hobo_bottle",
            "hobo_bottle",
            969,
            Storage::Bit,
        )
        .bit(0),
        catalog_field("slot_1.resources.rupees", "Rupees", 866, Storage::U16Le)
            .description("Updates both rupee values stored by the game.".into())
            .copies(vec![864]),
        catalog_field("slot_1.raw_inventory.bow", "Bow code", 832, Storage::U8).description(
            "Raw stored code; not every numeric value is a playable game state.".into(),
        ),
        catalog_field(
            "slot_1.raw_inventory.boomerang",
            "Boomerang code",
            833,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field(
            "slot_1.raw_inventory.mushroom_powder",
            "Mushroom or powder code",
            836,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field("slot_1.raw_inventory.flute", "Flute code", 844, Storage::U8).description(
            "Raw stored code; not every numeric value is a playable game state.".into(),
        ),
        catalog_field(
            "slot_1.raw_inventory.mirror",
            "Magic mirror code",
            851,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field(
            "slot_1.raw_magic.consumption",
            "Magic consumption code",
            891,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field("slot_1.raw_equipment.sword", "Sword code", 857, Storage::U8).description(
            "Raw stored code; not every numeric value is a playable game state.".into(),
        ),
        catalog_field(
            "slot_1.raw_equipment.shield",
            "Shield code",
            858,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field("slot_1.raw_equipment.armor", "Armor code", 859, Storage::U8).description(
            "Raw stored code; not every numeric value is a playable game state.".into(),
        ),
        catalog_field(
            "slot_1.raw_equipment.gloves",
            "Gloves code",
            852,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field(
            "slot_1.raw_progress.game_state",
            "Game state code",
            965,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field(
            "slot_1.raw_progress.map_icon",
            "Map guidance icon code",
            967,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field(
            "slot_1.raw_progress.spawn_point",
            "Spawn point code",
            968,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field(
            "slot_1.raw_progress.save_world",
            "Saved world code",
            970,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        catalog_field(
            "slot_1.raw_inventory.bottle_1",
            "Bottle 1 contents code",
            860,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.raw_inventory.bottle_2",
            "Bottle 2 contents code",
            861,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.raw_inventory.bottle_3",
            "Bottle 3 contents code",
            862,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.raw_inventory.bottle_4",
            "Bottle 4 contents code",
            863,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.raw_name.glyph_1",
            "Name glyph 1 code",
            985,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        catalog_field(
            "slot_1.raw_name.glyph_2",
            "Name glyph 2 code",
            987,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        catalog_field(
            "slot_1.raw_name.glyph_3",
            "Name glyph 3 code",
            989,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        catalog_field(
            "slot_1.raw_name.glyph_4",
            "Name glyph 4 code",
            991,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        catalog_field(
            "slot_1.raw_name.glyph_5",
            "Name glyph 5 code",
            993,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        catalog_field(
            "slot_1.raw_name.glyph_6",
            "Name glyph 6 code",
            995,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
    ];
    for field in &mut fields {
        field.id = field.id.replacen("slot_1", &format!("slot_{slot}"), 1);
        field.offset += base;
        for copy in &mut field.copies {
            *copy += base;
        }
    }
    fields
}

fn file_game(slot: usize) -> GameDefinition {
    let base = (slot - 1) * SLOT_SIZE;
    let generation = (slot == 1).then(|| generation::GenerationDefinition {
        fill: 0,
        patches: vec![
            generation::InitialPatch {
                offset: 524,
                bytes: vec![0, 240, 0, 240],
            },
            generation::InitialPatch {
                offset: 876,
                bytes: vec![24, 24],
            },
            generation::InitialPatch {
                offset: 889,
                bytes: vec![248],
            },
            generation::InitialPatch {
                offset: 985,
                bytes: vec![11, 0, 8, 0, 13, 0, 10, 0, 169, 0, 169, 0],
            },
            generation::InitialPatch {
                offset: 997,
                bytes: vec![170, 85],
            },
            generation::InitialPatch {
                offset: 1029,
                bytes: vec![255, 255],
            },
        ],
        values: BTreeMap::new(),
    });
    GameDefinition {
        fields: file_fields(slot),
        description: format!(
            concat!(
                "Edits File {slot} and its backup, including raw name glyphs and ",
                "inventory/equipment/progression codes. Preserves other files. ",
                "Numeric storage ranges do not prove playable combinations."
            ),
            slot = slot
        ),
        checksums: vec![ChecksumDefinition {
            start: Some(base),
            length: Some(1278),
            target: Some(23130),
            unit: ChecksumUnit::U16Le,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, base + 1278)
        }],
        mirrors: vec![MirrorDefinition {
            source: base,
            target: base + BACKUP_OFFSET,
            length: SLOT_SIZE,
            validate: Some(false),
        }],
        generation,
        ..GameDefinition::new(
            format!("zelda-a-link-to-the-past-file-{slot}-schema"),
            format!("The Legend of Zelda: A Link to the Past (File {slot} schema)"),
            "snes".into(),
            8192,
        )
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build((1..=3).map(file_game).collect(), BTreeMap::new(), true)
}
