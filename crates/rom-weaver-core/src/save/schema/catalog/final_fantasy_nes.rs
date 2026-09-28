use super::*;

fn member_fields(member: usize) -> Vec<FieldDefinition> {
    let offset = (member - 1) * 64;
    let mut fields = vec![
        FieldDefinition::new(
            "party.member_1.class".into(),
            "Party member 1 class".into(),
            1280,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.condition".into(),
            "Party member 1 condition".into(),
            1281,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.experience".into(),
            "Party member 1 experience".into(),
            1287,
            Storage::U24Le,
        ),
        FieldDefinition::new(
            "party.member_1.hp_current".into(),
            "Party member 1 hp current".into(),
            1290,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "party.member_1.hp_max".into(),
            "Party member 1 hp max".into(),
            1292,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "party.member_1.strength".into(),
            "Party member 1 strength".into(),
            1296,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.agility".into(),
            "Party member 1 agility".into(),
            1297,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.intelligence".into(),
            "Party member 1 intelligence".into(),
            1298,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.vitality".into(),
            "Party member 1 vitality".into(),
            1299,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.luck".into(),
            "Party member 1 luck".into(),
            1300,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.unknown_516".into(),
            "Party member 1 unknown 516".into(),
            1302,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.unknown_517".into(),
            "Party member 1 unknown 517".into(),
            1303,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.weapon_1".into(),
            "Party member 1 weapon 1".into(),
            1304,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.weapon_2".into(),
            "Party member 1 weapon 2".into(),
            1305,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.weapon_3".into(),
            "Party member 1 weapon 3".into(),
            1306,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.weapon_4".into(),
            "Party member 1 weapon 4".into(),
            1307,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.armor_1".into(),
            "Party member 1 armor 1".into(),
            1308,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.armor_2".into(),
            "Party member 1 armor 2".into(),
            1309,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.armor_3".into(),
            "Party member 1 armor 3".into(),
            1310,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.armor_4".into(),
            "Party member 1 armor 4".into(),
            1311,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.damage".into(),
            "Party member 1 damage".into(),
            1312,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.hit".into(),
            "Party member 1 hit".into(),
            1313,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.absorb".into(),
            "Party member 1 absorb".into(),
            1314,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.evade".into(),
            "Party member 1 evade".into(),
            1315,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.unknown_524".into(),
            "Party member 1 unknown 524".into(),
            1316,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.unknown_525".into(),
            "Party member 1 unknown 525".into(),
            1317,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.level_stored".into(),
            "Party member 1 level stored".into(),
            1318,
            Storage::U8,
        )
        .description("Raw stored level; displayed level is this value plus one.".into()),
        FieldDefinition::new(
            "party.member_1.magic.level_1.current".into(),
            "Party member 1 level 1 current spell charges".into(),
            1824,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_1.max".into(),
            "Party member 1 level 1 maximum spell charges".into(),
            1832,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_1.spell_1".into(),
            "Party member 1 level 1 spell 1".into(),
            1792,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_1.spell_2".into(),
            "Party member 1 level 1 spell 2".into(),
            1793,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_1.spell_3".into(),
            "Party member 1 level 1 spell 3".into(),
            1794,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_2.current".into(),
            "Party member 1 level 2 current spell charges".into(),
            1825,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_2.max".into(),
            "Party member 1 level 2 maximum spell charges".into(),
            1833,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_2.spell_1".into(),
            "Party member 1 level 2 spell 1".into(),
            1796,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_2.spell_2".into(),
            "Party member 1 level 2 spell 2".into(),
            1797,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_2.spell_3".into(),
            "Party member 1 level 2 spell 3".into(),
            1798,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_3.current".into(),
            "Party member 1 level 3 current spell charges".into(),
            1826,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_3.max".into(),
            "Party member 1 level 3 maximum spell charges".into(),
            1834,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_3.spell_1".into(),
            "Party member 1 level 3 spell 1".into(),
            1800,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_3.spell_2".into(),
            "Party member 1 level 3 spell 2".into(),
            1801,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_3.spell_3".into(),
            "Party member 1 level 3 spell 3".into(),
            1802,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_4.current".into(),
            "Party member 1 level 4 current spell charges".into(),
            1827,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_4.max".into(),
            "Party member 1 level 4 maximum spell charges".into(),
            1835,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_4.spell_1".into(),
            "Party member 1 level 4 spell 1".into(),
            1804,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_4.spell_2".into(),
            "Party member 1 level 4 spell 2".into(),
            1805,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_4.spell_3".into(),
            "Party member 1 level 4 spell 3".into(),
            1806,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_5.current".into(),
            "Party member 1 level 5 current spell charges".into(),
            1828,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_5.max".into(),
            "Party member 1 level 5 maximum spell charges".into(),
            1836,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_5.spell_1".into(),
            "Party member 1 level 5 spell 1".into(),
            1808,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_5.spell_2".into(),
            "Party member 1 level 5 spell 2".into(),
            1809,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_5.spell_3".into(),
            "Party member 1 level 5 spell 3".into(),
            1810,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_6.current".into(),
            "Party member 1 level 6 current spell charges".into(),
            1829,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_6.max".into(),
            "Party member 1 level 6 maximum spell charges".into(),
            1837,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_6.spell_1".into(),
            "Party member 1 level 6 spell 1".into(),
            1812,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_6.spell_2".into(),
            "Party member 1 level 6 spell 2".into(),
            1813,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_6.spell_3".into(),
            "Party member 1 level 6 spell 3".into(),
            1814,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_7.current".into(),
            "Party member 1 level 7 current spell charges".into(),
            1830,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_7.max".into(),
            "Party member 1 level 7 maximum spell charges".into(),
            1838,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_7.spell_1".into(),
            "Party member 1 level 7 spell 1".into(),
            1816,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_7.spell_2".into(),
            "Party member 1 level 7 spell 2".into(),
            1817,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_7.spell_3".into(),
            "Party member 1 level 7 spell 3".into(),
            1818,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_8.current".into(),
            "Party member 1 level 8 current spell charges".into(),
            1831,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_8.max".into(),
            "Party member 1 level 8 maximum spell charges".into(),
            1839,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_8.spell_1".into(),
            "Party member 1 level 8 spell 1".into(),
            1820,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_8.spell_2".into(),
            "Party member 1 level 8 spell 2".into(),
            1821,
            Storage::U8,
        ),
        FieldDefinition::new(
            "party.member_1.magic.level_8.spell_3".into(),
            "Party member 1 level 8 spell 3".into(),
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
        FieldDefinition::new(
            "world.ship.obtained".into(),
            "Ship obtained".into(),
            1024,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "world.ship.x".into(),
            "Ship position X".into(),
            1025,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.ship.y".into(),
            "Ship position Y".into(),
            1026,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.airship.obtained".into(),
            "Airship obtained".into(),
            1028,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "world.airship.x".into(),
            "Airship position X".into(),
            1029,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.airship.y".into(),
            "Airship position Y".into(),
            1030,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.bridge.enabled".into(),
            "Bridge enabled".into(),
            1032,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "world.bridge.x".into(),
            "Bridge position X".into(),
            1033,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.bridge.y".into(),
            "Bridge position Y".into(),
            1034,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.grass_path.enabled".into(),
            "Grass Path enabled".into(),
            1036,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "world.grass_path.x".into(),
            "Grass Path position X".into(),
            1037,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.grass_path.y".into(),
            "Grass Path position Y".into(),
            1038,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.party.x".into(),
            "Party position X".into(),
            1040,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.party.y".into(),
            "Party position Y".into(),
            1041,
            Storage::U8,
        ),
        FieldDefinition::new(
            "world.canoe_enabled".into(),
            "Canoe enabled".into(),
            1042,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new("party.gil".into(), "Gil".into(), 1052, Storage::U32Le),
        FieldDefinition::new(
            "items.key.lute".into(),
            "Lute obtained".into(),
            1057,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.crown".into(),
            "Crown obtained".into(),
            1058,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.crystal".into(),
            "Crystal obtained".into(),
            1059,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.herb".into(),
            "Herb obtained".into(),
            1060,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.key".into(),
            "Key obtained".into(),
            1061,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.tnt".into(),
            "Tnt obtained".into(),
            1062,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.adamant".into(),
            "Adamant obtained".into(),
            1063,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.slab".into(),
            "Slab obtained".into(),
            1064,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.ruby".into(),
            "Ruby obtained".into(),
            1065,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.rod".into(),
            "Rod obtained".into(),
            1066,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.floater".into(),
            "Floater obtained".into(),
            1067,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.chime".into(),
            "Chime obtained".into(),
            1068,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.tail".into(),
            "Tail obtained".into(),
            1069,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.cube".into(),
            "Cube obtained".into(),
            1070,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.bottle".into(),
            "Bottle obtained".into(),
            1071,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.oxyale".into(),
            "Oxyale obtained".into(),
            1072,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "items.key.canoe".into(),
            "Canoe obtained".into(),
            1073,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "orbs.fire".into(),
            "Fire Orb revived".into(),
            1074,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "orbs.water".into(),
            "Water Orb revived".into(),
            1075,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "orbs.air".into(),
            "Air Orb revived".into(),
            1076,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "orbs.earth".into(),
            "Earth Orb revived".into(),
            1077,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new("items.tent".into(), "Tent count".into(), 1078, Storage::U8),
        FieldDefinition::new(
            "items.cabin".into(),
            "Cabin count".into(),
            1079,
            Storage::U8,
        ),
        FieldDefinition::new(
            "items.house".into(),
            "House count".into(),
            1080,
            Storage::U8,
        ),
        FieldDefinition::new("items.heal".into(), "Heal count".into(), 1081, Storage::U8),
        FieldDefinition::new("items.pure".into(), "Pure count".into(), 1082, Storage::U8),
        FieldDefinition::new("items.soft".into(), "Soft count".into(), 1083, Storage::U8),
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
