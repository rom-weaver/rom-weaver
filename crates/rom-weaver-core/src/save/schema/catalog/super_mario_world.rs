use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![
        game_super_mario_world_schema(),
        template_game(2),
        template_game(3),
    ];

    build(games, codecs, true)
}

fn game_super_mario_world_schema() -> GameDefinition {
    let mut fields = Vec::with_capacity(233);
    for level in 0..96 {
        fields.push(FieldDefinition::new(
            format!("slot_1.levels.level_{level:02x}.flags"),
            format!("Level {level:02X} movement and completion flags"),
            level,
            Storage::U8,
        ));
    }
    for event in 0..120 {
        fields.push(
            FieldDefinition::new(
                format!("slot_1.events.event_{event:03}"),
                format!("Overworld event {event}"),
                96 + event / 8,
                Storage::Bit,
            )
            .bit(7 - (event % 8) as u8),
        );
    }
    fields.extend([
        catalog_field(
            "slot_1.players.player_1.submap",
            "Player 1 submap",
            111,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.players.player_1.animation",
            "Player 1 overworld animation",
            113,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_1.x",
            "Player 1 X position",
            117,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_1.y",
            "Player 1 Y position",
            119,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_1.x_tile",
            "Player 1 X tile pointer",
            125,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_1.y_tile",
            "Player 1 Y tile pointer",
            127,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_2.submap",
            "Player 2 submap",
            112,
            Storage::U8,
        ),
        catalog_field(
            "slot_1.players.player_2.animation",
            "Player 2 overworld animation",
            115,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_2.x",
            "Player 2 X position",
            121,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_2.y",
            "Player 2 Y position",
            123,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_2.x_tile",
            "Player 2 X tile pointer",
            129,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.players.player_2.y_tile",
            "Player 2 Y tile pointer",
            131,
            Storage::U16Le,
        ),
        catalog_field(
            "slot_1.progress.switch_palaces.yellow",
            "Yellow Switch Palace",
            133,
            Storage::Bool,
        ),
        catalog_field(
            "slot_1.progress.switch_palaces.green",
            "Green Switch Palace",
            134,
            Storage::Bool,
        ),
        catalog_field(
            "slot_1.progress.switch_palaces.red",
            "Red Switch Palace",
            135,
            Storage::Bool,
        ),
        catalog_field(
            "slot_1.progress.switch_palaces.blue",
            "Blue Switch Palace",
            136,
            Storage::Bool,
        ),
        catalog_field(
            "slot_1.progress.exits_completed",
            "Exits completed",
            140,
            Storage::U8,
        ),
    ]);
    GameDefinition {
 fields,
 description: "Edits File 1 and its backup. Preserves Files 2 and 3. Fresh saves use the original initial overworld state.".into(),
 checksums: vec![ChecksumDefinition {
 start: Some(0),
 length: Some(141),
 target: Some(23130),
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 141) }
],
 mirrors: vec![MirrorDefinition {
 source: 0,
 target: 429,
 length: 143,
 validate: None }
],
 generation: Some(generation::GenerationDefinition {
 fill: 0,
 patches: vec![generation::InitialPatch {
 offset: 111,
 bytes: vec![1,
 1,
 2,
 0,
 2,
 0,
 104,
 0,
 120,
 0,
 104,
 0,
 120,
 0,
 6,
 0,
 7,
 0,
 6,
 0,
 7,
 0] }
],
 values: BTreeMap::from([("slot_1.levels.level_28.flags".into(),
 SaveValue::U32(3)),
 ("slot_1.levels.level_30.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_4d.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_52.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_53.flags".into(),
 SaveValue::U32(1)),
 ("slot_1.levels.level_57.flags".into(),
 SaveValue::U32(4)),
 ("slot_1.levels.level_5b.flags".into(),
 SaveValue::U32(8)),
 ("slot_1.levels.level_5c.flags".into(),
 SaveValue::U32(2))]) }
),
 ..GameDefinition::new("super-mario-world-schema".into(),
 "Super Mario World (File 1 schema)".into(),
 "snes".into(),
 2048) }
}

fn template_game(slot: usize) -> GameDefinition {
    let base = (slot - 1) * 143;
    let mut fields = game_super_mario_world_schema().fields;
    for field in &mut fields {
        field.id = field.id.replacen("slot_1", &format!("slot_{slot}"), 1);
        field.offset += base;
        for copy in &mut field.copies {
            *copy += base;
        }
    }
    GameDefinition {
        fields,
        description: format!(
            "Edits File {slot} and its backup; preserves other files. Requires a valid checksum and matching backup. Template only."
        ),
        checksums: vec![ChecksumDefinition {
            start: Some(base),
            length: Some(141),
            target: Some(23130),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, base + 141)
        }],
        mirrors: vec![MirrorDefinition {
            source: base,
            target: base + 429,
            length: 143,
            validate: None,
        }],
        ..GameDefinition::new(
            format!("super-mario-world-file-{slot}-schema"),
            format!("Super Mario World (File {slot} schema)"),
            "snes".into(),
            2048,
        )
    }
}
