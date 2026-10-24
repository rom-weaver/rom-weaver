use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_solatorobo_red_the_hunter_desmume()];

    build(games, codecs, true)
}

fn game_solatorobo_red_the_hunter_desmume() -> GameDefinition {
    let fields = vec![
        catalog_field(
            "general.play_time_seconds",
            "Play time (seconds)",
            92,
            Storage::U32Le,
        )
        .description("Total play time in seconds; updates both save previews".into())
        .copies(vec![76, 28]),
        catalog_field("general.level", "Level", 114, Storage::U8)
            .description("Current level; updates both save previews".into())
            .copies(vec![84, 36]),
        catalog_field("general.experience", "Experience", 116, Storage::U32Le),
        catalog_field("general.rings", "Rings", 120, Storage::U32Le)
            .description("Current rings; updates both save previews".into())
            .copies(vec![80, 32]),
        catalog_field("general.p_crystals", "P Crystals", 124, Storage::U16Le),
        catalog_field("general.hunter_rank", "Hunter rank", 1598, Storage::U16Le),
        catalog_field("general.quest_points", "Quest points", 1600, Storage::U16Le),
        catalog_field(
            "general.new_game_plus_bit_0",
            "New Game Plus raw bit 0",
            1395,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "general.new_game_plus_bit_1",
            "New Game Plus raw bit 1",
            1395,
            Storage::Bit,
        )
        .bit(5),
        catalog_field("position.red.x", "Red position X", 404, Storage::I32Le),
        catalog_field("position.red.y", "Red position Y", 408, Storage::I32Le),
        catalog_field("position.red.z", "Red position Z", 412, Storage::I32Le),
        catalog_field(
            "position.red.orientation",
            "Red orientation",
            416,
            Storage::I16Le,
        ),
        catalog_field("position.dahak.x", "Dahak position X", 420, Storage::I32Le),
        catalog_field("position.dahak.y", "Dahak position Y", 424, Storage::I32Le),
        catalog_field("position.dahak.z", "Dahak position Z", 428, Storage::I32Le),
    ];
    GameDefinition {
        fields,
        description: concat!(
            "Edits the normalized 8 KiB Nintendo DS save payload. The ",
            "container layer preserves a DeSmuME .dsv footer."
        )
        .into(),
        signatures: vec![SignatureDefinition {
            offset: 0,
            bytes: vec![67, 79, 68, 65, 83, 65, 86, 69, 95, 48, 48, 48, 48, 48, 98],
        }],
        checksums: vec![
            ChecksumDefinition {
                start: Some(21),
                length: Some(19),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Xor8, 20)
            },
            ChecksumDefinition {
                start: Some(88),
                length: Some(1608),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Xor8, 65)
            },
            ChecksumDefinition {
                start: Some(69),
                length: Some(19),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Xor8, 68)
            },
        ],
        ..GameDefinition::new(
            "solatorobo-red-the-hunter-desmume".into(),
            "Solatorobo: Red the Hunter (DeSmuME raw save)".into(),
            "nintendo-ds".into(),
            8192,
        )
    }
}
