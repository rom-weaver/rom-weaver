use super::*;

const SLOT_SIZE: usize = 1280;
const BACKUP_OFFSET: usize = 3840;

fn file_fields(slot: usize) -> Vec<FieldDefinition> {
    let base = (slot - 1) * SLOT_SIZE;
    let mut fields = vec![
        FieldDefinition::new(
            "slot_1.resources.bombs".into(),
            "Bombs".into(),
            835,
            Storage::U8,
        )
        .description("Bombs carried by the player".into()),
        FieldDefinition::new(
            "slot_1.resources.arrows".into(),
            "Arrows".into(),
            887,
            Storage::U8,
        )
        .description("Arrows carried by the player".into()),
        FieldDefinition::new(
            "slot_1.hearts.capacity_eighths".into(),
            "Heart capacity (eighths)".into(),
            876,
            Storage::U8,
        )
        .description("Maximum health; eight units equal one heart".into()),
        FieldDefinition::new(
            "slot_1.hearts.current_eighths".into(),
            "Current health (eighths)".into(),
            877,
            Storage::U8,
        )
        .description("Current health; eight units equal one heart".into()),
        FieldDefinition::new(
            "slot_1.magic.current".into(),
            "Current magic".into(),
            878,
            Storage::U8,
        )
        .description("Current magic power".into()),
        FieldDefinition::new(
            "slot_1.resources.bomb_capacity_upgrades".into(),
            "Bomb capacity upgrades".into(),
            880,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.resources.arrow_capacity_upgrades".into(),
            "Arrow capacity upgrades".into(),
            881,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.heart_pieces".into(),
            "Heart pieces toward next container".into(),
            875,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.inventory.hookshot".into(),
            "Hookshot".into(),
            834,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.fire_rod".into(),
            "Fire Rod".into(),
            837,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.ice_rod".into(),
            "Ice Rod".into(),
            838,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.bombos".into(),
            "Bombos".into(),
            839,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.ether".into(),
            "Ether".into(),
            840,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.quake".into(),
            "Quake".into(),
            841,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.lantern".into(),
            "Lantern".into(),
            842,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.hammer".into(),
            "Hammer".into(),
            843,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.bug_net".into(),
            "Bug-Catching Net".into(),
            845,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.book_of_mudora".into(),
            "Book of Mudora".into(),
            846,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.cane_of_somaria".into(),
            "Cane of Somaria".into(),
            848,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.cane_of_byrna".into(),
            "Cane of Byrna".into(),
            849,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.cape".into(),
            "Magic Cape".into(),
            850,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.pegasus_boots".into(),
            "Pegasus Boots".into(),
            853,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.flippers".into(),
            "Zora's Flippers".into(),
            854,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.inventory.moon_pearl".into(),
            "Moon Pearl".into(),
            855,
            Storage::Bool,
        )
        .description("Inventory item".into()),
        FieldDefinition::new(
            "slot_1.progress.pendant_1".into(),
            "Pendant 1".into(),
            884,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.progress.pendant_2".into(),
            "Pendant 2".into(),
            884,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.progress.pendant_3".into(),
            "Pendant 3".into(),
            884,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.crystal_1".into(),
            "Crystal 1".into(),
            890,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.progress.crystal_2".into(),
            "Crystal 2".into(),
            890,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.progress.crystal_3".into(),
            "Crystal 3".into(),
            890,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.crystal_4".into(),
            "Crystal 4".into(),
            890,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.crystal_5".into(),
            "Crystal 5".into(),
            890,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.crystal_6".into(),
            "Crystal 6".into(),
            890,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.crystal_7".into(),
            "Crystal 7".into(),
            890,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.dungeons.sewers.compass".into(),
            "sewers compass".into(),
            868,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.progress.dungeons.sewers.big_key".into(),
            "sewers big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.progress.dungeons.sewers.map".into(),
            "sewers map".into(),
            872,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.progress.dungeons.sewers.keys_earned".into(),
            "sewers keys earned".into(),
            892,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.hyrule_castle.compass".into(),
            "hyrule_castle compass".into(),
            868,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.dungeons.hyrule_castle.big_key".into(),
            "hyrule_castle big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.dungeons.hyrule_castle.map".into(),
            "hyrule_castle map".into(),
            872,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.dungeons.hyrule_castle.keys_earned".into(),
            "hyrule_castle keys earned".into(),
            893,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.eastern_palace.compass".into(),
            "eastern_palace compass".into(),
            868,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.dungeons.eastern_palace.big_key".into(),
            "eastern_palace big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.dungeons.eastern_palace.map".into(),
            "eastern_palace map".into(),
            872,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.dungeons.eastern_palace.keys_earned".into(),
            "eastern_palace keys earned".into(),
            894,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.desert_palace.compass".into(),
            "desert_palace compass".into(),
            868,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.dungeons.desert_palace.big_key".into(),
            "desert_palace big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.dungeons.desert_palace.map".into(),
            "desert_palace map".into(),
            872,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.dungeons.desert_palace.keys_earned".into(),
            "desert_palace keys earned".into(),
            895,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.agahnims_tower.compass".into(),
            "agahnims_tower compass".into(),
            868,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.dungeons.agahnims_tower.big_key".into(),
            "agahnims_tower big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.dungeons.agahnims_tower.map".into(),
            "agahnims_tower map".into(),
            872,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.dungeons.agahnims_tower.keys_earned".into(),
            "agahnims_tower keys earned".into(),
            896,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.swamp_palace.compass".into(),
            "swamp_palace compass".into(),
            868,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.dungeons.swamp_palace.big_key".into(),
            "swamp_palace big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.dungeons.swamp_palace.map".into(),
            "swamp_palace map".into(),
            872,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.dungeons.swamp_palace.keys_earned".into(),
            "swamp_palace keys earned".into(),
            897,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.palace_of_darkness.compass".into(),
            "palace_of_darkness compass".into(),
            868,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.progress.dungeons.palace_of_darkness.big_key".into(),
            "palace_of_darkness big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.progress.dungeons.palace_of_darkness.map".into(),
            "palace_of_darkness map".into(),
            872,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.progress.dungeons.palace_of_darkness.keys_earned".into(),
            "palace_of_darkness keys earned".into(),
            898,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.misery_mire.compass".into(),
            "misery_mire compass".into(),
            868,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.progress.dungeons.misery_mire.big_key".into(),
            "misery_mire big_key".into(),
            870,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.progress.dungeons.misery_mire.map".into(),
            "misery_mire map".into(),
            872,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.progress.dungeons.misery_mire.keys_earned".into(),
            "misery_mire keys earned".into(),
            899,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.skull_woods.compass".into(),
            "skull_woods compass".into(),
            869,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.progress.dungeons.skull_woods.big_key".into(),
            "skull_woods big_key".into(),
            871,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.progress.dungeons.skull_woods.map".into(),
            "skull_woods map".into(),
            873,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.progress.dungeons.skull_woods.keys_earned".into(),
            "skull_woods keys earned".into(),
            900,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ice_palace.compass".into(),
            "ice_palace compass".into(),
            869,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ice_palace.big_key".into(),
            "ice_palace big_key".into(),
            871,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ice_palace.map".into(),
            "ice_palace map".into(),
            873,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ice_palace.keys_earned".into(),
            "ice_palace keys earned".into(),
            901,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.tower_of_hera.compass".into(),
            "tower_of_hera compass".into(),
            869,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.dungeons.tower_of_hera.big_key".into(),
            "tower_of_hera big_key".into(),
            871,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.dungeons.tower_of_hera.map".into(),
            "tower_of_hera map".into(),
            873,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.dungeons.tower_of_hera.keys_earned".into(),
            "tower_of_hera keys earned".into(),
            902,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.thieves_town.compass".into(),
            "thieves_town compass".into(),
            869,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.dungeons.thieves_town.big_key".into(),
            "thieves_town big_key".into(),
            871,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.dungeons.thieves_town.map".into(),
            "thieves_town map".into(),
            873,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.dungeons.thieves_town.keys_earned".into(),
            "thieves_town keys earned".into(),
            903,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.turtle_rock.compass".into(),
            "turtle_rock compass".into(),
            869,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.dungeons.turtle_rock.big_key".into(),
            "turtle_rock big_key".into(),
            871,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.dungeons.turtle_rock.map".into(),
            "turtle_rock map".into(),
            873,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.dungeons.turtle_rock.keys_earned".into(),
            "turtle_rock keys earned".into(),
            904,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ganons_tower.compass".into(),
            "ganons_tower compass".into(),
            869,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ganons_tower.big_key".into(),
            "ganons_tower big_key".into(),
            871,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ganons_tower.map".into(),
            "ganons_tower map".into(),
            873,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.dungeons.ganons_tower.keys_earned".into(),
            "ganons_tower keys earned".into(),
            905,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.progress.early_story.uncle_secret_passage".into(),
            "uncle_secret_passage".into(),
            966,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.progress.early_story.sanctuary_priest".into(),
            "sanctuary_priest".into(),
            966,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.progress.early_story.zelda_sanctuary".into(),
            "zelda_sanctuary".into(),
            966,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "slot_1.progress.early_story.uncle_left_house".into(),
            "uncle_left_house".into(),
            966,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.early_story.book_progress".into(),
            "book_progress".into(),
            966,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.early_story.fortune_teller_variant".into(),
            "fortune_teller_variant".into(),
            966,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "slot_1.progress.side_quests.smith_tempering".into(),
            "smith_tempering".into(),
            969,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "slot_1.progress.side_quests.swordsmith_rescued".into(),
            "swordsmith_rescued".into(),
            969,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "slot_1.progress.side_quests.purple_chest_opened".into(),
            "purple_chest_opened".into(),
            969,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "slot_1.progress.side_quests.stumpy_stumped".into(),
            "stumpy_stumped".into(),
            969,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "slot_1.progress.side_quests.bottle_purchased".into(),
            "bottle_purchased".into(),
            969,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "slot_1.progress.side_quests.hobo_bottle".into(),
            "hobo_bottle".into(),
            969,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "slot_1.resources.rupees".into(),
            "Rupees".into(),
            866,
            Storage::U16Le,
        )
        .description("Updates both rupee values stored by the game.".into())
        .copies(vec![864]),
        FieldDefinition::new(
            "slot_1.raw_inventory.bow".into(),
            "Bow code".into(),
            832,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_inventory.boomerang".into(),
            "Boomerang code".into(),
            833,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_inventory.mushroom_powder".into(),
            "Mushroom or powder code".into(),
            836,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_inventory.flute".into(),
            "Flute code".into(),
            844,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_inventory.mirror".into(),
            "Magic mirror code".into(),
            851,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_magic.consumption".into(),
            "Magic consumption code".into(),
            891,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_equipment.sword".into(),
            "Sword code".into(),
            857,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_equipment.shield".into(),
            "Shield code".into(),
            858,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_equipment.armor".into(),
            "Armor code".into(),
            859,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_equipment.gloves".into(),
            "Gloves code".into(),
            852,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_progress.game_state".into(),
            "Game state code".into(),
            965,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_progress.map_icon".into(),
            "Map guidance icon code".into(),
            967,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_progress.spawn_point".into(),
            "Spawn point code".into(),
            968,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_progress.save_world".into(),
            "Saved world code".into(),
            970,
            Storage::U8,
        )
        .description("Raw stored code; not every numeric value is a playable game state.".into()),
        FieldDefinition::new(
            "slot_1.raw_inventory.bottle_1".into(),
            "Bottle 1 contents code".into(),
            860,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.raw_inventory.bottle_2".into(),
            "Bottle 2 contents code".into(),
            861,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.raw_inventory.bottle_3".into(),
            "Bottle 3 contents code".into(),
            862,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.raw_inventory.bottle_4".into(),
            "Bottle 4 contents code".into(),
            863,
            Storage::U8,
        ),
        FieldDefinition::new(
            "slot_1.raw_name.glyph_1".into(),
            "Name glyph 1 code".into(),
            985,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        FieldDefinition::new(
            "slot_1.raw_name.glyph_2".into(),
            "Name glyph 2 code".into(),
            987,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        FieldDefinition::new(
            "slot_1.raw_name.glyph_3".into(),
            "Name glyph 3 code".into(),
            989,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        FieldDefinition::new(
            "slot_1.raw_name.glyph_4".into(),
            "Name glyph 4 code".into(),
            991,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        FieldDefinition::new(
            "slot_1.raw_name.glyph_5".into(),
            "Name glyph 5 code".into(),
            993,
            Storage::U16Le,
        )
        .description("Original English naming-screen glyph code, not Unicode.".into()),
        FieldDefinition::new(
            "slot_1.raw_name.glyph_6".into(),
            "Name glyph 6 code".into(),
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
