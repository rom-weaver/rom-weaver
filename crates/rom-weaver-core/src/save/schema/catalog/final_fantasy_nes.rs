use super::*;

fn member_fields(member: usize) -> Vec<FieldDefinition> {
    let offset = (member - 1) * 64;
    let mut fields = vec![
        catalog_field(
            "party.member_1.class",
            "Party member 1 class",
            1280,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.condition",
            "Party member 1 condition",
            1281,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.experience",
            "Party member 1 experience",
            1287,
            Storage::U24Le,
        ),
        catalog_field(
            "party.member_1.hp_current",
            "Party member 1 hp current",
            1290,
            Storage::U16Le,
        ),
        catalog_field(
            "party.member_1.hp_max",
            "Party member 1 hp max",
            1292,
            Storage::U16Le,
        ),
        catalog_field(
            "party.member_1.strength",
            "Party member 1 strength",
            1296,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.agility",
            "Party member 1 agility",
            1297,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.intelligence",
            "Party member 1 intelligence",
            1298,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.vitality",
            "Party member 1 vitality",
            1299,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.luck",
            "Party member 1 luck",
            1300,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.unknown_516",
            "Party member 1 unknown 516",
            1302,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.unknown_517",
            "Party member 1 unknown 517",
            1303,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.weapon_1",
            "Party member 1 weapon 1",
            1304,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.weapon_2",
            "Party member 1 weapon 2",
            1305,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.weapon_3",
            "Party member 1 weapon 3",
            1306,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.weapon_4",
            "Party member 1 weapon 4",
            1307,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.armor_1",
            "Party member 1 armor 1",
            1308,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.armor_2",
            "Party member 1 armor 2",
            1309,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.armor_3",
            "Party member 1 armor 3",
            1310,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.armor_4",
            "Party member 1 armor 4",
            1311,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.damage",
            "Party member 1 damage",
            1312,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.hit",
            "Party member 1 hit",
            1313,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.absorb",
            "Party member 1 absorb",
            1314,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.evade",
            "Party member 1 evade",
            1315,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.unknown_524",
            "Party member 1 unknown 524",
            1316,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.unknown_525",
            "Party member 1 unknown 525",
            1317,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.level_stored",
            "Party member 1 level stored",
            1318,
            Storage::U8,
        )
        .description("Raw stored level; displayed level is this value plus one.".into()),
        catalog_field(
            "party.member_1.magic.level_1.current",
            "Party member 1 level 1 current spell charges",
            1824,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_1.max",
            "Party member 1 level 1 maximum spell charges",
            1832,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_1.spell_1",
            "Party member 1 level 1 spell 1",
            1792,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_1.spell_2",
            "Party member 1 level 1 spell 2",
            1793,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_1.spell_3",
            "Party member 1 level 1 spell 3",
            1794,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_2.current",
            "Party member 1 level 2 current spell charges",
            1825,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_2.max",
            "Party member 1 level 2 maximum spell charges",
            1833,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_2.spell_1",
            "Party member 1 level 2 spell 1",
            1796,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_2.spell_2",
            "Party member 1 level 2 spell 2",
            1797,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_2.spell_3",
            "Party member 1 level 2 spell 3",
            1798,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_3.current",
            "Party member 1 level 3 current spell charges",
            1826,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_3.max",
            "Party member 1 level 3 maximum spell charges",
            1834,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_3.spell_1",
            "Party member 1 level 3 spell 1",
            1800,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_3.spell_2",
            "Party member 1 level 3 spell 2",
            1801,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_3.spell_3",
            "Party member 1 level 3 spell 3",
            1802,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_4.current",
            "Party member 1 level 4 current spell charges",
            1827,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_4.max",
            "Party member 1 level 4 maximum spell charges",
            1835,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_4.spell_1",
            "Party member 1 level 4 spell 1",
            1804,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_4.spell_2",
            "Party member 1 level 4 spell 2",
            1805,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_4.spell_3",
            "Party member 1 level 4 spell 3",
            1806,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_5.current",
            "Party member 1 level 5 current spell charges",
            1828,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_5.max",
            "Party member 1 level 5 maximum spell charges",
            1836,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_5.spell_1",
            "Party member 1 level 5 spell 1",
            1808,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_5.spell_2",
            "Party member 1 level 5 spell 2",
            1809,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_5.spell_3",
            "Party member 1 level 5 spell 3",
            1810,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_6.current",
            "Party member 1 level 6 current spell charges",
            1829,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_6.max",
            "Party member 1 level 6 maximum spell charges",
            1837,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_6.spell_1",
            "Party member 1 level 6 spell 1",
            1812,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_6.spell_2",
            "Party member 1 level 6 spell 2",
            1813,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_6.spell_3",
            "Party member 1 level 6 spell 3",
            1814,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_7.current",
            "Party member 1 level 7 current spell charges",
            1830,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_7.max",
            "Party member 1 level 7 maximum spell charges",
            1838,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_7.spell_1",
            "Party member 1 level 7 spell 1",
            1816,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_7.spell_2",
            "Party member 1 level 7 spell 2",
            1817,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_7.spell_3",
            "Party member 1 level 7 spell 3",
            1818,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_8.current",
            "Party member 1 level 8 current spell charges",
            1831,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_8.max",
            "Party member 1 level 8 maximum spell charges",
            1839,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_8.spell_1",
            "Party member 1 level 8 spell 1",
            1820,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_8.spell_2",
            "Party member 1 level 8 spell 2",
            1821,
            Storage::U8,
        ),
        catalog_field(
            "party.member_1.magic.level_8.spell_3",
            "Party member 1 level 8 spell 3",
            1822,
            Storage::U8,
        ),
    ];
    for field in &mut fields {
        field.id = field
            .id
            .replacen("member_1", &format!("member_{member}"), 1);
        field.label = field
            .label
            .replacen("member 1", &format!("member {member}"), 1);
        field.offset += offset;
        for copy in &mut field.copies {
            *copy += offset;
        }
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(vec![game_final_fantasy_nes()], BTreeMap::new(), true)
}

fn game_final_fantasy_nes() -> GameDefinition {
    let mut fields = vec![
        catalog_field("world.ship.obtained", "Ship obtained", 1024, Storage::Bit).bit(0),
        catalog_field("world.ship.x", "Ship position X", 1025, Storage::U8),
        catalog_field("world.ship.y", "Ship position Y", 1026, Storage::U8),
        catalog_field(
            "world.airship.obtained",
            "Airship obtained",
            1028,
            Storage::Bit,
        )
        .bit(0),
        catalog_field("world.airship.x", "Airship position X", 1029, Storage::U8),
        catalog_field("world.airship.y", "Airship position Y", 1030, Storage::U8),
        catalog_field("world.bridge.enabled", "Bridge enabled", 1032, Storage::Bit).bit(0),
        catalog_field("world.bridge.x", "Bridge position X", 1033, Storage::U8),
        catalog_field("world.bridge.y", "Bridge position Y", 1034, Storage::U8),
        catalog_field(
            "world.grass_path.enabled",
            "Grass Path enabled",
            1036,
            Storage::Bit,
        )
        .bit(0),
        catalog_field(
            "world.grass_path.x",
            "Grass Path position X",
            1037,
            Storage::U8,
        ),
        catalog_field(
            "world.grass_path.y",
            "Grass Path position Y",
            1038,
            Storage::U8,
        ),
        catalog_field("world.party.x", "Party position X", 1040, Storage::U8),
        catalog_field("world.party.y", "Party position Y", 1041, Storage::U8),
        catalog_field("world.canoe_enabled", "Canoe enabled", 1042, Storage::Bit).bit(0),
        catalog_field("party.gil", "Gil", 1052, Storage::U32Le),
        catalog_field("items.key.lute", "Lute obtained", 1057, Storage::Bit).bit(0),
        catalog_field("items.key.crown", "Crown obtained", 1058, Storage::Bit).bit(0),
        catalog_field("items.key.crystal", "Crystal obtained", 1059, Storage::Bit).bit(0),
        catalog_field("items.key.herb", "Herb obtained", 1060, Storage::Bit).bit(0),
        catalog_field("items.key.key", "Key obtained", 1061, Storage::Bit).bit(0),
        catalog_field("items.key.tnt", "Tnt obtained", 1062, Storage::Bit).bit(0),
        catalog_field("items.key.adamant", "Adamant obtained", 1063, Storage::Bit).bit(0),
        catalog_field("items.key.slab", "Slab obtained", 1064, Storage::Bit).bit(0),
        catalog_field("items.key.ruby", "Ruby obtained", 1065, Storage::Bit).bit(0),
        catalog_field("items.key.rod", "Rod obtained", 1066, Storage::Bit).bit(0),
        catalog_field("items.key.floater", "Floater obtained", 1067, Storage::Bit).bit(0),
        catalog_field("items.key.chime", "Chime obtained", 1068, Storage::Bit).bit(0),
        catalog_field("items.key.tail", "Tail obtained", 1069, Storage::Bit).bit(0),
        catalog_field("items.key.cube", "Cube obtained", 1070, Storage::Bit).bit(0),
        catalog_field("items.key.bottle", "Bottle obtained", 1071, Storage::Bit).bit(0),
        catalog_field("items.key.oxyale", "Oxyale obtained", 1072, Storage::Bit).bit(0),
        catalog_field("items.key.canoe", "Canoe obtained", 1073, Storage::Bit).bit(0),
        catalog_field("orbs.fire", "Fire Orb revived", 1074, Storage::Bit).bit(0),
        catalog_field("orbs.water", "Water Orb revived", 1075, Storage::Bit).bit(0),
        catalog_field("orbs.air", "Air Orb revived", 1076, Storage::Bit).bit(0),
        catalog_field("orbs.earth", "Earth Orb revived", 1077, Storage::Bit).bit(0),
        catalog_field("items.tent", "Tent count", 1078, Storage::U8),
        catalog_field("items.cabin", "Cabin count", 1079, Storage::U8),
        catalog_field("items.house", "House count", 1080, Storage::U8),
        catalog_field("items.heal", "Heal count", 1081, Storage::U8),
        catalog_field("items.pure", "Pure count", 1082, Storage::U8),
        catalog_field("items.soft", "Soft count", 1083, Storage::U8),
    ];
    fields.extend((1..=4).flat_map(member_fields));
    GameDefinition {
        fields,
        description: concat!(
            "Edits the shared world state and four party members in the ",
            "0x400-0x7FF save block. Repairs the modulo-255 complemented ",
            "checksum at 0x4FD. Character names use a game-specific codec and ",
            "are omitted; equipment exposes the full stored byte including ",
            "its equipped flag."
        )
        .into(),
        checksums: vec![ChecksumDefinition {
            start: Some(1024),
            length: Some(1024),
            exclude: vec![ChecksumExclusion {
                offset: 1277,
                length: 1,
            }],
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum8Mod255Complement, 1277)
        }],
        ..GameDefinition::new(
            "final-fantasy-nes".into(),
            "Final Fantasy".into(),
            "nes".into(),
            8192,
        )
    }
}
