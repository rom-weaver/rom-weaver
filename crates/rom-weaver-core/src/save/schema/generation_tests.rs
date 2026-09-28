use super::super::{
    ChecksumAlgorithm, ChecksumDefinition, ChecksumUnit, FieldDefinition, GameDefinition,
    GameSchema, MirrorDefinition, SchemaSaveHandler, SignatureDefinition, Storage, layout, rules,
};
use super::*;
use crate::save::{SaveDetectionInput, SaveGameHandler};

fn raw_game(
    size: usize,
    fields: Vec<FieldDefinition>,
    generation: GenerationDefinition,
) -> GameDefinition {
    let mut game = GameDefinition::new("demo".into(), "Demo".into(), "test".into(), size);
    game.fields = fields;
    game.generation = Some(generation);
    game
}

fn generation(
    fill: u8,
    values: impl IntoIterator<Item = (&'static str, SaveValue)>,
) -> GenerationDefinition {
    GenerationDefinition {
        fill,
        patches: Vec::new(),
        values: values
            .into_iter()
            .map(|(id, value)| (id.into(), value))
            .collect(),
    }
}

fn field(id: &str, offset: usize, storage: Storage) -> FieldDefinition {
    FieldDefinition::new(id.into(), id.into(), offset, storage)
}

fn sum8(start: usize, length: usize, offset: usize) -> ChecksumDefinition {
    ChecksumDefinition {
        algorithm: ChecksumAlgorithm::Sum8,
        start: Some(start),
        length: Some(length),
        spans: Vec::new(),
        offset,
        target: None,
        unit: ChecksumUnit::U8,
        exclude: Vec::new(),
    }
}

fn build(spec: GameDefinition) -> crate::Result<SchemaSaveHandler> {
    let game = GameSchema::build(spec)?;
    game.validate_generation()?;
    Ok(SchemaSaveHandler {
        game: std::sync::Arc::new(game),
    })
}

fn identity(handler: &SchemaSaveHandler) -> super::super::SaveGameIdentity {
    handler.definitions().remove(0).identity
}

#[test]
fn applies_numeric_text_and_masked_defaults_and_repairs_integrity() {
    let signed = field("signed", 2, Storage::I8);
    let mut name = field("name", 3, Storage::Ascii);
    name.length = Some(3);
    let mut masked = field("masked", 6, Storage::U8);
    masked.mask = Some(28);
    let mut spec = raw_game(
        16,
        vec![field("unsigned", 1, Storage::U8), signed, name, masked],
        generation(
            0,
            [
                ("unsigned", SaveValue::U32(3)),
                ("signed", SaveValue::I32(-4)),
                ("name", SaveValue::Text("AB".into())),
                ("masked", SaveValue::U32(5)),
            ],
        ),
    );
    spec.signatures.push(SignatureDefinition {
        offset: 0,
        bytes: vec![82],
    });
    spec.checksums.push(sum8(0, 7, 7));
    spec.mirrors.push(MirrorDefinition {
        source: 0,
        target: 8,
        length: 8,
        validate: None,
    });
    let initializer = spec.generation.as_mut().unwrap();
    initializer.patches = vec![
        InitialPatch {
            offset: 0,
            bytes: vec![82],
        },
        InitialPatch {
            offset: 6,
            bytes: vec![227],
        },
    ];

    let handler = build(spec).unwrap();
    let bytes = handler.generate(&identity(&handler)).unwrap();
    assert_eq!(&bytes[..7], &[82, 3, 252, b'A', b'B', 0, 247]);
    assert_eq!(bytes[7], 53);
    assert_eq!(&bytes[..8], &bytes[8..]);
}

#[test]
fn rejects_unknown_read_only_and_invalid_defaults() {
    for (id, value) in [
        ("missing", SaveValue::U32(1)),
        ("locked", SaveValue::U32(1)),
        ("editable", SaveValue::U32(4)),
        ("editable", SaveValue::Text("bad".into())),
    ] {
        let mut editable = field("editable", 0, Storage::U8);
        editable.max = Some(3);
        let mut locked = field("locked", 1, Storage::U8);
        locked.editable = Some(false);
        let spec = raw_game(2, vec![editable, locked], generation(0, [(id, value)]));
        assert!(build(spec).is_err());
    }
}

#[test]
fn rejects_an_initializer_with_invalid_integrity() {
    let mut signature = raw_game(2, vec![], generation(0, []));
    signature.signatures.push(SignatureDefinition {
        offset: 0,
        bytes: vec![82],
    });
    let error = build(signature).expect_err("invalid initializer must be rejected");
    assert!(error.to_string().contains("initializer failed"));

    let candidate = layout::Candidate {
        spans: vec![layout::Span {
            logical_offset: 0,
            physical_offset: 0,
            length: 1,
        }],
        signatures: Vec::new(),
        checksums: vec![sum8(0, 1, 1)],
        repairs: Vec::new(),
        predicates: Vec::new(),
        sections: Vec::new(),
        counter: None,
        checksum_blocks: None,
    };
    let mut layout_spec = raw_game(2, vec![], generation(0, []));
    layout_spec.runtime.logical_size = Some(1);
    layout_spec.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "slot".into(),
            logical_offset: 0,
            logical_length: 1,
            copies: layout::Copies::Fixed {
                candidates: vec![candidate],
            },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        }],
    });
    layout_spec
        .generation
        .as_mut()
        .unwrap()
        .patches
        .push(InitialPatch {
            offset: 0,
            bytes: vec![1, 0],
        });
    assert!(build(layout_spec).is_err());
}

#[test]
fn defaults_apply_only_to_fresh_generation() {
    let mut name = field("name", 1, Storage::Ascii);
    name.length = Some(2);
    let mut value = field("value", 0, Storage::U8);
    value.max = Some(9);
    let handler = build(raw_game(
        16,
        vec![value, name],
        generation(
            255,
            [
                ("value", SaveValue::U32(9)),
                ("name", SaveValue::Text("A".into())),
            ],
        ),
    ))
    .unwrap();
    let game = identity(&handler);
    assert_eq!(&handler.generate(&game).unwrap()[..3], &[9, b'A', 0]);
    let mut existing = vec![0; 16];
    existing[..3].copy_from_slice(&[3, b'B', 0]);
    let input = SaveDetectionInput {
        bytes: existing,
        selected_game: Some("demo".into()),
        rom_sha1: None,
    };
    let result = handler
        .apply(
            &input,
            &game,
            &[SaveEdit {
                field: "value".into(),
                value: SaveValue::U32(4),
            }],
            false,
        )
        .unwrap();
    assert_eq!(&result.bytes.unwrap()[..3], &[4, b'B', 0]);
}

#[test]
fn flat_defaults_are_applied_together_before_coupled_checks() {
    let mut spec = raw_game(
        16,
        vec![
            field("current", 0, Storage::U8),
            field("maximum", 1, Storage::U8),
        ],
        generation(
            255,
            [
                ("current", SaveValue::U32(3)),
                ("maximum", SaveValue::U32(5)),
            ],
        ),
    );
    spec.runtime.edit_checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(rules::Scalar {
                offset: 0,
                storage: Storage::U8,
                mask: None,
            }
            .read(bytes)?
                <= rules::Scalar {
                    offset: 1,
                    storage: Storage::U8,
                    mask: None,
                }
                .read(bytes)?)
        }),
        code: "range".into(),
        message: "current must not exceed maximum".into(),
        section_id: None,
        warning: None,
    });
    let handler = build(spec).unwrap();
    assert_eq!(
        &handler.generate(&identity(&handler)).unwrap()[..2],
        &[3, 5]
    );
}

#[test]
fn layout_defaults_update_valid_copies_and_preserve_empty_groups() {
    let mut value = field("value", 0, Storage::U8);
    value.behavior.group = Some("active".into());
    let active_candidate = |physical_offset, checksum_offset| layout::Candidate {
        spans: vec![layout::Span {
            logical_offset: 0,
            physical_offset,
            length: 1,
        }],
        signatures: Vec::new(),
        checksums: vec![sum8(physical_offset, 1, checksum_offset)],
        repairs: Vec::new(),
        predicates: Vec::new(),
        sections: Vec::new(),
        counter: None,
        checksum_blocks: None,
    };
    let empty_candidate = |physical_offset| layout::Candidate {
        spans: vec![layout::Span {
            logical_offset: 1,
            physical_offset,
            length: 1,
        }],
        signatures: vec![layout::Signature {
            offset: physical_offset,
            bytes: vec![9],
        }],
        checksums: Vec::new(),
        repairs: Vec::new(),
        predicates: Vec::new(),
        sections: Vec::new(),
        counter: None,
        checksum_blocks: None,
    };
    let mut spec = raw_game(
        6,
        vec![value],
        generation(0, [("value", SaveValue::U32(7))]),
    );
    spec.runtime.logical_size = Some(2);
    spec.runtime.layout = Some(layout::Layout {
        groups: vec![
            layout::Group {
                id: "active".into(),
                logical_offset: 0,
                logical_length: 1,
                copies: layout::Copies::Fixed {
                    candidates: vec![active_candidate(0, 1), active_candidate(2, 3)],
                },
                selection: layout::Selection::FirstValid,
                write: layout::WritePolicy::CloneSelectedToAll,
                empty: Vec::new(),
                empty_if_no_signature: false,
            },
            layout::Group {
                id: "empty".into(),
                logical_offset: 1,
                logical_length: 1,
                copies: layout::Copies::Fixed {
                    candidates: vec![empty_candidate(4), empty_candidate(5)],
                },
                selection: layout::Selection::FirstValid,
                write: layout::WritePolicy::Selected,
                empty: vec![0],
                empty_if_no_signature: false,
            },
        ],
    });
    spec.generation
        .as_mut()
        .unwrap()
        .patches
        .push(InitialPatch {
            offset: 0,
            bytes: vec![1, 255, 1, 255],
        });

    let handler = build(spec).unwrap();
    let bytes = handler.generate(&identity(&handler)).unwrap();
    assert_eq!(bytes, vec![7, 249, 7, 249, 0, 0]);
}
