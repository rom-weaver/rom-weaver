use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_solatorobo_red_the_hunter_desmume()];

    build(games, codecs, true)
}

fn game_solatorobo_red_the_hunter_desmume() -> GameDefinition {
    let fields = vec![
        FieldDefinition::new(
            "general.play_time_seconds".into(),
            "Play time (seconds)".into(),
            92,
            Storage::U32Le,
        )
        .description("Total play time in seconds; updates both save previews".into())
        .copies(vec![76, 28]),
        FieldDefinition::new("general.level".into(), "Level".into(), 114, Storage::U8)
            .description("Current level; updates both save previews".into())
            .copies(vec![84, 36]),
        FieldDefinition::new(
            "general.experience".into(),
            "Experience".into(),
            116,
            Storage::U32Le,
        ),
        FieldDefinition::new("general.rings".into(), "Rings".into(), 120, Storage::U32Le)
            .description("Current rings; updates both save previews".into())
            .copies(vec![80, 32]),
        FieldDefinition::new(
            "general.p_crystals".into(),
            "P Crystals".into(),
            124,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "general.hunter_rank".into(),
            "Hunter rank".into(),
            1598,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "general.quest_points".into(),
            "Quest points".into(),
            1600,
            Storage::U16Le,
        ),
        FieldDefinition::new(
            "general.new_game_plus_bit_0".into(),
            "New Game Plus raw bit 0".into(),
            1395,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "general.new_game_plus_bit_1".into(),
            "New Game Plus raw bit 1".into(),
            1395,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "position.red.x".into(),
            "Red position X".into(),
            404,
            Storage::I32Le,
        ),
        FieldDefinition::new(
            "position.red.y".into(),
            "Red position Y".into(),
            408,
            Storage::I32Le,
        ),
        FieldDefinition::new(
            "position.red.z".into(),
            "Red position Z".into(),
            412,
            Storage::I32Le,
        ),
        FieldDefinition::new(
            "position.red.orientation".into(),
            "Red orientation".into(),
            416,
            Storage::I16Le,
        ),
        FieldDefinition::new(
            "position.dahak.x".into(),
            "Dahak position X".into(),
            420,
            Storage::I32Le,
        ),
        FieldDefinition::new(
            "position.dahak.y".into(),
            "Dahak position Y".into(),
            424,
            Storage::I32Le,
        ),
        FieldDefinition::new(
            "position.dahak.z".into(),
            "Dahak position Z".into(),
            428,
            Storage::I32Le,
        ),
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
