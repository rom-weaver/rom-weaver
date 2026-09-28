use super::*;

fn file(scope: &FieldScope) -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for item in 0..96 {
        let child = FieldScope {
            base: scope.base + scope.bits / 8,
            bits: item * 8,
            index: format!("{item:02x}"),
            ordinal: item + 1,
            prefix: scope.id(""),
            group: scope.group.clone(),
            guards: scope.guards.clone(),
            ..Default::default()
        };
        fields.extend(level(&child));
    }
    let child = FieldScope {
        base: scope.base + scope.bits / 8,
        ordinal: 1,
        prefix: scope.id(""),
        group: scope.group.clone(),
        guards: scope.guards.clone(),
        ..Default::default()
    };
    fields.extend(event(&child));
    fields.extend(player(&child));
    fields.extend(progress(&child));
    fields
}
fn level(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                format!("levels.level_{index}.flags", index = scope.index),
                format!(
                    "Level {index_upper} movement and completion flags",
                    index_upper = scope.index.to_ascii_uppercase()
                ),
                0,
                Storage::U8,
            )
            .description("Overworld movement directions and level completion state".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, (scope.bits / 8) as u16)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn event(scope: &FieldScope) -> Vec<FieldDefinition> {
    (0..120)
        .map(|event| {
            let offset = 96 + event / 8;
            scope
                .bit_field(
                    format!("events.event_{event:03}"),
                    format!("Overworld event {event}"),
                    offset,
                    7 - (event % 8) as u8,
                )
                .description("Overworld event activation bit".into())
                .editable(true)
                .behavior(field::FieldBehavior {
                    group: scope.group.clone(),
                    presentation: Some(field::Presentation {
                        step: Some(None),
                        ..field::Presentation::new(0, offset as u16)
                    }),
                    ..Default::default()
                })
        })
        .collect()
}
fn player(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "players.player_1.submap".into(),
                "Player 1 submap".into(),
                111,
                Storage::U8,
            )
            .description("Current overworld submap".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 111)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_1.animation".into(),
                "Player 1 overworld animation".into(),
                113,
                Storage::U16Le,
            )
            .description("Overworld animation state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 113)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_1.x".into(),
                "Player 1 X position".into(),
                117,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 117)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_1.y".into(),
                "Player 1 Y position".into(),
                119,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 119)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_1.x_tile".into(),
                "Player 1 X tile pointer".into(),
                125,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 125)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_1.y_tile".into(),
                "Player 1 Y tile pointer".into(),
                127,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 127)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_2.submap".into(),
                "Player 2 submap".into(),
                112,
                Storage::U8,
            )
            .description("Current overworld submap".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 112)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_2.animation".into(),
                "Player 2 overworld animation".into(),
                115,
                Storage::U16Le,
            )
            .description("Overworld animation state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 115)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_2.x".into(),
                "Player 2 X position".into(),
                121,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 121)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_2.y".into(),
                "Player 2 Y position".into(),
                123,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 123)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_2.x_tile".into(),
                "Player 2 X tile pointer".into(),
                129,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 129)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "players.player_2.y_tile".into(),
                "Player 2 Y tile pointer".into(),
                131,
                Storage::U16Le,
            )
            .description("Overworld position state".into())
            .min(0)
            .max(65535)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 131)
                }),
                ..Default::default()
            }),
    ];

    fields
}

fn progress(scope: &FieldScope) -> Vec<FieldDefinition> {
    let fields = vec![
        scope
            .field(
                "progress.switch_palaces.yellow".into(),
                "Yellow Switch Palace".into(),
                133,
                Storage::Bool,
            )
            .description("Switch Palace completion flag".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 133)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.switch_palaces.green".into(),
                "Green Switch Palace".into(),
                134,
                Storage::Bool,
            )
            .description("Switch Palace completion flag".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 134)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.switch_palaces.red".into(),
                "Red Switch Palace".into(),
                135,
                Storage::Bool,
            )
            .description("Switch Palace completion flag".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 135)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.switch_palaces.blue".into(),
                "Blue Switch Palace".into(),
                136,
                Storage::Bool,
            )
            .description("Switch Palace completion flag".into())
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    step: Some(None),
                    ..field::Presentation::new(0, 136)
                }),
                ..Default::default()
            }),
        scope
            .field(
                "progress.exits_completed".into(),
                "Exits completed".into(),
                140,
                Storage::U8,
            )
            .description("Exit count shown on the file-select screen".into())
            .min(0)
            .max(255)
            .editable(true)
            .behavior(field::FieldBehavior {
                group: scope.group.clone(),
                presentation: Some(field::Presentation {
                    ..field::Presentation::new(0, 140)
                }),
                ..Default::default()
            }),
    ];

    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_super_mario_world()];

    build(games, codecs, false)
}

fn game_super_mario_world() -> GameDefinition {
    let mut fields = vec![];
    let scope = FieldScope::default();
    {
        for item in 0..1 {
            let number = item + 1;
            let index = format!("{number:00}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8,
                bits: 0,
                bit_stride: false,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("slot_1");
            child.group = Some("slot_1".into());
            fields.extend(file(&child));
        }
    }
    {
        for item in 0..1 {
            let number = item + 2;
            let index = format!("{number:00}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8 + 143,
                bits: 0,
                bit_stride: false,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("slot_2");
            child.group = Some("slot_2".into());
            fields.extend(file(&child));
        }
    }
    {
        for item in 0..1 {
            let number = item + 3;
            let index = format!("{number:00}");
            let mut child = FieldScope {
                base: scope.base + scope.bits / 8 + 286,
                bits: 0,
                bit_stride: false,
                index,
                ordinal: item + 1,
                prefix: String::new(),
                group: scope.group.clone(),
                guards: scope.guards.clone(),
            };
            child.prefix = scope.id("slot_3");
            child.group = Some("slot_3".into());
            fields.extend(file(&child));
        }
    }
    GameDefinition {
 fields,
 generation: Some(generation::GenerationDefinition {
 fill: 0,
 patches: vec![generation::InitialPatch {
 offset: 40,
 bytes: vec![3] }
,
 generation::InitialPatch {
 offset: 48,
 bytes: vec![1] }
,
 generation::InitialPatch {
 offset: 77,
 bytes: vec![1] }
,
 generation::InitialPatch {
 offset: 82,
 bytes: vec![1,
 1] }
,
 generation::InitialPatch {
 offset: 87,
 bytes: vec![4] }
,
 generation::InitialPatch {
 offset: 91,
 bytes: vec![8,
 2] }
,
 generation::InitialPatch {
 offset: 111,
 bytes: vec![1,
 1,
 2] }
,
 generation::InitialPatch {
 offset: 115,
 bytes: vec![2] }
,
 generation::InitialPatch {
 offset: 117,
 bytes: vec![104] }
,
 generation::InitialPatch {
 offset: 119,
 bytes: vec![120] }
,
 generation::InitialPatch {
 offset: 121,
 bytes: vec![104] }
,
 generation::InitialPatch {
 offset: 123,
 bytes: vec![120] }
,
 generation::InitialPatch {
 offset: 125,
 bytes: vec![6] }
,
 generation::InitialPatch {
 offset: 127,
 bytes: vec![7] }
,
 generation::InitialPatch {
 offset: 129,
 bytes: vec![6] }
,
 generation::InitialPatch {
 offset: 131,
 bytes: vec![7] }
,
 generation::InitialPatch {
 offset: 141,
 bytes: vec![101,
 88] }
,
 generation::InitialPatch {
 offset: 469,
 bytes: vec![3] }
,
 generation::InitialPatch {
 offset: 477,
 bytes: vec![1] }
,
 generation::InitialPatch {
 offset: 506,
 bytes: vec![1] }
,
 generation::InitialPatch {
 offset: 511,
 bytes: vec![1,
 1] }
,
 generation::InitialPatch {
 offset: 516,
 bytes: vec![4] }
,
 generation::InitialPatch {
 offset: 520,
 bytes: vec![8,
 2] }
,
 generation::InitialPatch {
 offset: 540,
 bytes: vec![1,
 1,
 2] }
,
 generation::InitialPatch {
 offset: 544,
 bytes: vec![2] }
,
 generation::InitialPatch {
 offset: 546,
 bytes: vec![104] }
,
 generation::InitialPatch {
 offset: 548,
 bytes: vec![120] }
,
 generation::InitialPatch {
 offset: 550,
 bytes: vec![104] }
,
 generation::InitialPatch {
 offset: 552,
 bytes: vec![120] }
,
 generation::InitialPatch {
 offset: 554,
 bytes: vec![6] }
,
 generation::InitialPatch {
 offset: 556,
 bytes: vec![7] }
,
 generation::InitialPatch {
 offset: 558,
 bytes: vec![6] }
,
 generation::InitialPatch {
 offset: 560,
 bytes: vec![7] }
,
 generation::InitialPatch {
 offset: 570,
 bytes: vec![101,
 88] }
],
 values: BTreeMap::from([]) }
),
 runtime: runtime::Runtime {
 family: Some("super-mario-world".into()),
 handler_id: Some("super-mario-world".into()),
 save_format: Some("snes_sram_2k".into()),
 save_format_name: Some("Battery SRAM 2 KiB".into()),
 checksum_sizes: vec![143,
 143,
 143],
 layout: Some(layout::Layout {
 groups: vec![layout::Group {
 id: "slot_1".into(),
 logical_offset: 0,
 logical_length: 143,
 copies: layout::Copies::Fixed {
 candidates: vec![layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 0,
 physical_offset: 0,
 length: 143 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(0),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 141) }
],
 sections: vec![layout::FixedSection {
 id: 0,
 physical_offset: 0,
 checksum: ChecksumDefinition {
 start: Some(0),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 141) }
,
 signature: None,
 counter: Some(rules::Scalar {
 offset: 140,
 storage: Storage::U8,
 mask: None }
) }
],
 ..Default::default() }
,
 layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 0,
 physical_offset: 429,
 length: 143 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(429),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 570) }
],
 sections: vec![layout::FixedSection {
 id: 0,
 physical_offset: 429,
 checksum: ChecksumDefinition {
 start: Some(429),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 570) }
,
 signature: None,
 counter: Some(rules::Scalar {
 offset: 569,
 storage: Storage::U8,
 mask: None }
) }
],
 ..Default::default() }
] }
,
 selection: layout::Selection::FirstValid,
 write: layout::WritePolicy::CloneSelectedToAll,
 empty: vec![0,
 255],
 empty_if_no_signature: false }
,
 layout::Group {
 id: "slot_2".into(),
 logical_offset: 143,
 logical_length: 143,
 copies: layout::Copies::Fixed {
 candidates: vec![layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 143,
 physical_offset: 143,
 length: 143 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(143),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 284) }
],
 sections: vec![layout::FixedSection {
 id: 1,
 physical_offset: 143,
 checksum: ChecksumDefinition {
 start: Some(143),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 284) }
,
 signature: None,
 counter: Some(rules::Scalar {
 offset: 283,
 storage: Storage::U8,
 mask: None }
) }
],
 ..Default::default() }
,
 layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 143,
 physical_offset: 572,
 length: 143 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(572),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 713) }
],
 sections: vec![layout::FixedSection {
 id: 1,
 physical_offset: 572,
 checksum: ChecksumDefinition {
 start: Some(572),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 713) }
,
 signature: None,
 counter: Some(rules::Scalar {
 offset: 712,
 storage: Storage::U8,
 mask: None }
) }
],
 ..Default::default() }
] }
,
 selection: layout::Selection::FirstValid,
 write: layout::WritePolicy::CloneSelectedToAll,
 empty: vec![0,
 255],
 empty_if_no_signature: false }
,
 layout::Group {
 id: "slot_3".into(),
 logical_offset: 286,
 logical_length: 143,
 copies: layout::Copies::Fixed {
 candidates: vec![layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 286,
 physical_offset: 286,
 length: 143 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(286),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 427) }
],
 sections: vec![layout::FixedSection {
 id: 2,
 physical_offset: 286,
 checksum: ChecksumDefinition {
 start: Some(286),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 427) }
,
 signature: None,
 counter: Some(rules::Scalar {
 offset: 426,
 storage: Storage::U8,
 mask: None }
) }
],
 ..Default::default() }
,
 layout::Candidate {
 spans: vec![layout::Span {
 logical_offset: 286,
 physical_offset: 715,
 length: 143 }
],
 checksums: vec![ChecksumDefinition {
 start: Some(715),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 856) }
],
 sections: vec![layout::FixedSection {
 id: 2,
 physical_offset: 715,
 checksum: ChecksumDefinition {
 start: Some(715),
 length: Some(141),
 target: Some(23130),
 unit: ChecksumUnit::U8,
 ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le,
 856) }
,
 signature: None,
 counter: Some(rules::Scalar {
 offset: 855,
 storage: Storage::U8,
 mask: None }
) }
],
 ..Default::default() }
] }
,
 selection: layout::Selection::FirstValid,
 write: layout::WritePolicy::CloneSelectedToAll,
 empty: vec![0,
 255],
 empty_if_no_signature: false }
] }
),
 recognition: Some(runtime::Recognition {
 checks: Vec::new(),
 reasons: vec![SaveRecognitionReason::ChecksumValid],
 confidence: SaveRecognitionConfidence::High,
 incomplete_confidence: Some(SaveRecognitionConfidence::Medium),
 selected_reason: false,
 empty_top_level_reasons: false }
),
 recovery: Some(runtime::Recovery {
 no_valid: runtime::Failure {
 code: "save_integrity_invalid".into(),
 message: "the save has no valid Super Mario World slot copy".into() }
,
 incomplete: Some(runtime::RecoveryOutcome {
 state: SaveIntegrityState::ValidWithWarnings,
 disable_editing: false,
 issue: Some(runtime::Failure {
 code: "duplicate_copy_invalid".into(),
 message: "Slot {slot} has one invalid duplicate copy".into() }
),
 warning: Some("An edit repairs both copies of its target slot".into()),
 field_warning: None,
 edit_error: None,
 parse_error: None,
 section_id: true }
),
 damaged: Some(runtime::RecoveryOutcome {
 state: SaveIntegrityState::ValidWithWarnings,
 disable_editing: false,
 issue: Some(runtime::Failure {
 code: "duplicate_copy_invalid".into(),
 message: "Slot {slot} has one invalid duplicate copy".into() }
),
 warning: Some("An edit repairs both copies of its target slot".into()),
 field_warning: None,
 edit_error: None,
 parse_error: None,
 section_id: true }
),
 unrecoverable: Some(runtime::RecoveryOutcome {
 state: SaveIntegrityState::PartiallyRecoverable,
 disable_editing: true,
 issue: Some(runtime::Failure {
 code: "slot_invalid".into(),
 message: "Slot {slot} has no valid copy".into() }
),
 warning: Some("Normal editing is disabled because one slot has no valid copy".into()),
 field_warning: None,
 edit_error: Some(runtime::Failure {
 code: "save_integrity_partial".into(),
 message: "normal edits need every nonempty Super Mario World slot to have a valid copy".into() }
),
 parse_error: None,
 section_id: true }
),
 differing: Some(runtime::RecoveryOutcome {
 state: SaveIntegrityState::ValidWithWarnings,
 disable_editing: false,
 issue: Some(runtime::Failure {
 code: "duplicate_copy_mismatch".into(),
 message: "Slot {slot} duplicate copies differ; the primary copy is used".into() }
),
 warning: Some("An edit repairs both copies of its target slot".into()),
 field_warning: None,
 edit_error: None,
 parse_error: None,
 section_id: true }
),
 active_group: true,
 zero_counter: true }
),
 ..Default::default() }
,
 ..GameDefinition::new("super-mario-world".into(),
 "Super Mario World".into(),
 "snes".into(),
 2048) }
}
