use super::*;
use crate::save::schema::rules::{Condition, ReadValue, Scalar, Store};

fn field(id: &str, offset: usize, storage: Storage) -> FieldDefinition {
    FieldDefinition::new(id.into(), id.into(), offset, storage)
}

fn game(fields: Vec<FieldDefinition>, save_size: usize) -> GameDefinition {
    let mut game = GameDefinition::new("demo".into(), "Demo".into(), "test".into(), save_size);
    game.fields = fields;
    game
}

fn handler(raw: GameDefinition) -> SchemaSaveHandler {
    SchemaSaveHandler {
        game: std::sync::Arc::new(GameSchema::build(raw).unwrap()),
    }
}

fn identity(handler: &SchemaSaveHandler) -> SaveGameIdentity {
    handler.definitions().remove(0).identity
}

fn checksum(
    algorithm: ChecksumAlgorithm,
    start: usize,
    length: usize,
    offset: usize,
) -> ChecksumDefinition {
    ChecksumDefinition {
        algorithm,
        start: Some(start),
        length: Some(length),
        spans: Vec::new(),
        offset,
        target: None,
        unit: ChecksumUnit::U8,
        exclude: Vec::new(),
    }
}

#[test]
fn reads_and_writes_numeric_bit_bool_and_ascii_storage() {
    let mut bit = field("flag", 4, Storage::Bit);
    bit.bit = Some(3);
    let mut text = field("name", 6, Storage::Ascii);
    text.length = Some(4);
    let mut raw = game(
        vec![
            field("le", 0, Storage::U16Le),
            field("be", 2, Storage::I16Be),
            bit,
            field("enabled", 5, Storage::Bool),
            text,
        ],
        16,
    );
    raw.signatures.push(SignatureDefinition {
        offset: 15,
        bytes: vec![0xaa],
    });
    let handler = handler(raw);
    let identity = identity(&handler);
    let input = SaveDetectionInput {
        bytes: vec![
            0x34, 0x12, 0xff, 0xfe, 0xa5, 2, b'A', 0, 0xcc, 0xdd, 0, 0, 0, 0, 0, 0xaa,
        ],
        selected_game: Some(identity.id.clone()),
        rom_sha1: None,
    };
    let document = handler.parse(&input, &identity).unwrap();
    assert_eq!(document.fields[0].value, SaveValue::U32(0x1234));
    assert_eq!(document.fields[1].value, SaveValue::I32(-2));
    assert_eq!(document.fields[2].value, SaveValue::Bool(false));
    assert_eq!(document.fields[3].value, SaveValue::Bool(true));
    assert_eq!(document.fields[4].value, SaveValue::Text("A".into()));

    let edits = [
        SaveEdit {
            field: "le".into(),
            value: SaveValue::U32(0xabcd),
        },
        SaveEdit {
            field: "be".into(),
            value: SaveValue::I32(-3),
        },
        SaveEdit {
            field: "flag".into(),
            value: SaveValue::Bool(true),
        },
        SaveEdit {
            field: "enabled".into(),
            value: SaveValue::Bool(false),
        },
        SaveEdit {
            field: "name".into(),
            value: SaveValue::Text("XY".into()),
        },
    ];
    let bytes = handler
        .apply(&input, &identity, &edits, false)
        .unwrap()
        .bytes
        .unwrap();
    assert_eq!(
        &bytes[..10],
        &[0xcd, 0xab, 0xff, 0xfd, 0xad, 0, b'X', b'Y', 0, 0]
    );
    assert_eq!(bytes[15], 0xaa);
}

#[test]
fn dry_run_returns_document_without_bytes_or_input_mutation() {
    let mut raw = game(vec![field("value", 1, Storage::U8)], 16);
    raw.signatures.push(SignatureDefinition {
        offset: 0,
        bytes: vec![82],
    });
    let handler = handler(raw);
    let identity = identity(&handler);
    let input = SaveDetectionInput {
        bytes: [82, 1].into_iter().chain([0; 14]).collect(),
        selected_game: Some(identity.id.clone()),
        rom_sha1: None,
    };
    let original = input.bytes.clone();
    let result = handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "value".into(),
                value: SaveValue::U32(9),
            }],
            true,
        )
        .unwrap();
    assert!(result.bytes.is_none());
    assert_eq!(result.document.fields[0].value, SaveValue::U32(9));
    assert_eq!(input.bytes, original);
}

#[test]
fn schemas_without_evidence_need_explicit_selection() {
    let handler = handler(game(vec![field("value", 0, Storage::U8)], 1));
    let mut input = SaveDetectionInput {
        bytes: vec![0],
        selected_game: None,
        rom_sha1: None,
    };
    assert!(matches!(
        handler.recognize(&input).outcome,
        SaveRecognitionOutcome::Unsupported { .. }
    ));
    input.selected_game = Some("demo".into());
    assert!(matches!(
        handler.recognize(&input).outcome,
        SaveRecognitionOutcome::Recognized { .. }
    ));
}

#[test]
fn rejects_duplicate_bounds_overlap_and_unsafe_ids() {
    let cases = [
        game(
            vec![field("a", 0, Storage::U8), field("a", 1, Storage::U8)],
            2,
        ),
        game(vec![field("a", 1, Storage::U8)], 1),
        game(
            vec![field("a", 0, Storage::U16Le), field("b", 1, Storage::U8)],
            2,
        ),
    ];
    for raw in cases {
        assert!(GameSchema::build(raw).is_err());
    }
    for id in ["../save", "a/b", ".hidden", "Upper", ""] {
        let raw = GameDefinition::new(id.into(), "X".into(), "test".into(), 1);
        assert!(GameSchema::build(raw).is_err(), "accepted {id}");
    }
    for id in ["a..b", ".a", "a.", "a/b", "a=b", "a b", "é"] {
        assert!(
            GameSchema::build(game(vec![field(id, 0, Storage::U8)], 1)).is_err(),
            "accepted {id}"
        );
    }
}

#[test]
fn corrupted_integrity_refuses_edits_and_exposes_read_only_fields() {
    let mut raw = game(vec![field("value", 1, Storage::U8)], 3);
    raw.signatures.push(SignatureDefinition {
        offset: 0,
        bytes: vec![82],
    });
    raw.checksums
        .push(checksum(ChecksumAlgorithm::Sum8, 0, 2, 2));
    let handler = handler(raw);
    let identity = identity(&handler);
    let input = SaveDetectionInput {
        bytes: vec![82, 1, 0],
        selected_game: Some(identity.id.clone()),
        rom_sha1: None,
    };
    let document = handler.parse(&input, &identity).unwrap();
    assert_eq!(document.integrity.state, SaveIntegrityState::Invalid);
    assert!(!document.fields[0].editable);
    assert!(
        handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "value".into(),
                    value: SaveValue::U32(2)
                }],
                false,
            )
            .is_err()
    );
}

#[test]
fn checksum_algorithms_match_independent_byte_vectors() {
    for (algorithm, unit, target, expected) in [
        (ChecksumAlgorithm::Add8, ChecksumUnit::U8, 0, vec![10]),
        (ChecksumAlgorithm::Sum8, ChecksumUnit::U8, 255, vec![245]),
        (ChecksumAlgorithm::Xor8, ChecksumUnit::U8, 0, vec![4]),
        (
            ChecksumAlgorithm::Add16Le,
            ChecksumUnit::U16Le,
            0,
            vec![4, 6],
        ),
        (
            ChecksumAlgorithm::Sum16Be,
            ChecksumUnit::U16Be,
            65535,
            vec![251, 249],
        ),
        (
            ChecksumAlgorithm::Xor32Le,
            ChecksumUnit::U32Be,
            0,
            vec![4, 3, 2, 1],
        ),
    ] {
        let raw = ChecksumDefinition {
            algorithm,
            start: Some(0),
            length: Some(4),
            spans: Vec::new(),
            offset: 8,
            target: Some(target),
            unit,
            exclude: Vec::new(),
        };
        let checksum = Checksum::build(raw, 12).unwrap();
        let mut bytes = vec![1, 2, 3, 4, 77, 88, 99, 111, 0, 0, 0, 0];
        checksum.repair(&mut bytes);
        assert_eq!(&bytes[8..8 + expected.len()], expected);
        assert!(checksum.valid(&bytes));
        bytes[0] = 2;
        assert!(!checksum.valid(&bytes));
    }
}

#[test]
fn exclusions_zero_storage_and_mod255_checksum_matches_vectors() {
    let raw = ChecksumDefinition {
        algorithm: ChecksumAlgorithm::Sum8Mod255Complement,
        start: Some(0),
        length: Some(4),
        spans: Vec::new(),
        offset: 1,
        target: None,
        unit: ChecksumUnit::U8,
        exclude: vec![ChecksumExclusion {
            offset: 1,
            length: 1,
        }],
    };
    let checksum = Checksum::build(raw, 4).unwrap();
    let mut bytes = vec![255, 77, 2, 3];
    checksum.repair(&mut bytes);
    assert_eq!(bytes, [255, 250, 2, 3]);
    assert!(!checksum.reads_span((1, 2)));
    assert!(checksum.reads_span((1, 3)));
    assert!(checksum.valid(&bytes));
}

#[test]
fn copies_preserve_other_backup_data_and_repair_checksums() {
    let mut value = field("value", 1, Storage::U8);
    value.copies.push(9);
    let mut raw = game(vec![value], 16);
    raw.checksums
        .push(checksum(ChecksumAlgorithm::Add8, 0, 3, 3));
    raw.checksums.push(ChecksumDefinition {
        algorithm: ChecksumAlgorithm::Add8,
        start: None,
        length: None,
        spans: vec![
            ChecksumSpan {
                start: 8,
                length: 2,
            },
            ChecksumSpan {
                start: 12,
                length: 2,
            },
        ],
        offset: 15,
        target: None,
        unit: ChecksumUnit::U8,
        exclude: Vec::new(),
    });
    let handler = handler(raw);
    let identity = identity(&handler);
    let input = SaveDetectionInput {
        bytes: vec![0, 2, 0, 2, 0, 0, 0, 0, 11, 3, 0, 0, 13, 0, 0, 27],
        selected_game: Some(identity.id.clone()),
        rom_sha1: None,
    };
    let bytes = handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "value".into(),
                value: SaveValue::U32(7),
            }],
            false,
        )
        .unwrap()
        .bytes
        .unwrap();
    assert_eq!((bytes[1], bytes[3], bytes[9], bytes[15]), (7, 7, 7, 31));
    assert_eq!((bytes[8], bytes[12]), (11, 13));
}

#[test]
fn bcd_u24_and_inverted_bits_cover_boundaries() {
    for (storage, encoded) in [
        (Storage::BcdBe, vec![0x12, 0x34, 0x56]),
        (Storage::BcdLe, vec![0x56, 0x34, 0x12]),
    ] {
        let mut raw = field("money", 0, storage);
        raw.length = Some(3);
        let field = FieldSchema::build(raw, 3).unwrap();
        let mut bytes = vec![0; 3];
        field.write(&mut bytes, &SaveValue::U32(123456)).unwrap();
        assert_eq!(bytes, encoded);
        bytes[1] = 0xfa;
        assert!(field.read(&bytes).is_err());
    }
    for storage in [Storage::U24Le, Storage::U24Be] {
        let field = FieldSchema::build(field("value", 0, storage), 3).unwrap();
        let mut bytes = vec![0; 3];
        field.write(&mut bytes, &SaveValue::U32(0xffffff)).unwrap();
        assert_eq!(field.read(&bytes).unwrap(), SaveValue::U32(0xffffff));
    }
    let mut raw = field("flag", 0, Storage::Bit);
    raw.bit = Some(2);
    raw.inverted = true;
    let field = FieldSchema::build(raw, 1).unwrap();
    let mut bytes = vec![255];
    field.write(&mut bytes, &SaveValue::Bool(true)).unwrap();
    assert_eq!(bytes, [251]);
}

#[test]
fn array_guards_control_visibility_and_reject_invalid_counts() {
    let mut value = field("item", 1, Storage::U8);
    value.array_guards.push(field::ArrayGuard {
        count: Scalar {
            offset: 0,
            storage: Storage::U8,
            mask: None,
        },
        index: 1,
        capacity: 2,
    });
    let handler = handler(game(vec![value], 2));
    let identity = identity(&handler);
    let parse = |bytes| {
        handler.parse(
            &SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            },
            &identity,
        )
    };
    assert!(parse(vec![1, 9]).unwrap().fields.is_empty());
    assert_eq!(
        parse(vec![2, 9]).unwrap().fields[0].value,
        SaveValue::U32(9)
    );
    assert!(parse(vec![3, 9]).is_err());
}

#[test]
fn native_callbacks_drive_views_checks_and_side_effects() {
    let mut view = field("view", 0, Storage::U8);
    view.behavior.xor = Some(ReadValue::new(|_| Ok(1)));
    view.behavior.on_edit.push(Store {
        when: Some(Condition::new(|bytes| Ok(bytes[0] > 0))),
        destination: Scalar {
            offset: 1,
            storage: Storage::U8,
            mask: None,
        },
        value: ReadValue::new(|bytes| Ok(i64::from(bytes[0]) * 2)),
    });
    let handler = handler(game(vec![view], 2));
    let identity = identity(&handler);
    let input = SaveDetectionInput {
        bytes: vec![1, 0],
        selected_game: Some(identity.id.clone()),
        rom_sha1: None,
    };
    assert_eq!(
        handler.parse(&input, &identity).unwrap().fields[0].value,
        SaveValue::U32(0)
    );
    let bytes = handler
        .apply(
            &input,
            &identity,
            &[SaveEdit {
                field: "view".into(),
                value: SaveValue::U32(3),
            }],
            false,
        )
        .unwrap()
        .bytes
        .unwrap();
    assert_eq!(bytes, [2, 4]);
}

#[test]
fn rejects_invalid_checksum_ranges_and_copy_collisions() {
    for raw in [
        ChecksumDefinition {
            unit: ChecksumUnit::U16Le,
            ..checksum(ChecksumAlgorithm::Add16Le, 0, 3, 8)
        },
        ChecksumDefinition {
            spans: vec![
                ChecksumSpan {
                    start: 0,
                    length: 3,
                },
                ChecksumSpan {
                    start: 2,
                    length: 3,
                },
            ],
            start: None,
            length: None,
            ..checksum(ChecksumAlgorithm::Add8, 0, 1, 8)
        },
        ChecksumDefinition {
            target: Some(256),
            ..checksum(ChecksumAlgorithm::Add8, 0, 3, 8)
        },
    ] {
        assert!(Checksum::build(raw, 16).is_err());
    }
    let mut copied = field("value", 1, Storage::U8);
    copied.copies.push(1);
    assert!(GameSchema::build(game(vec![copied], 16)).is_err());
}

#[test]
fn overlapping_read_only_views_protect_editable_storage() {
    let mut view = field("view", 0, Storage::U16Le);
    view.editable = Some(false);
    let mut copy = field("copy", 1, Storage::U8);
    copy.editable = Some(false);
    assert!(GameSchema::build(game(vec![view.clone(), copy.clone()], 2)).is_ok());
    copy.editable = Some(true);
    assert!(GameSchema::build(game(vec![view.clone(), copy.clone()], 2)).is_err());
    assert!(GameSchema::build(game(vec![copy, view], 2)).is_err());
}

#[test]
fn added_schema_fields_and_initializers_use_the_declared_storage() {
    use std::sync::Arc;

    use super::generation::{Generation, GenerationDefinition, InitialPatch};
    use super::{FieldDefinition, FieldSchema, Storage};

    let mut schema = catalog::builtin_pokemon_gen3::schemas()
        .into_iter()
        .find(|handler| handler.game.id == "pokemon-emerald")
        .unwrap();
    let identity = schema.definitions().remove(0).identity;
    let source = SaveDetectionInput {
        bytes: super::super::tests::fixture(super::super::pokemon_gen3::Family::Emerald, 3, 2),
        selected_game: Some(identity.id.clone()),
        rom_sha1: None,
    };
    let original = schema.parse(&source, &identity).unwrap();
    let game = Arc::make_mut(&mut schema.game);
    game.fields.push(
        FieldSchema::build(
            FieldDefinition::new(
                "extra.value".into(),
                "Extra value".into(),
                0x400,
                Storage::U8,
            ),
            game.runtime.logical_size.unwrap(),
        )
        .unwrap(),
    );
    let mut alias = game
        .fields
        .iter()
        .find(|field| field.id == "trainer.money")
        .unwrap()
        .clone();
    alias.id = "extra.money_alias".into();
    alias.editable = false;
    game.fields.push(alias);

    let extended = schema.parse(&source, &identity).unwrap();
    assert_eq!(extended.fields.len(), original.fields.len() + 2);
    assert_eq!(
        extended
            .fields
            .iter()
            .find(|field| field.id == "extra.value")
            .unwrap()
            .value,
        SaveValue::U32(0)
    );
    let edits = [SaveEdit {
        field: "trainer.money".into(),
        value: SaveValue::U32(2000),
    }];
    let actual = schema.apply(&source, &identity, &edits, false).unwrap();
    assert!(
        actual
            .preview
            .changes
            .iter()
            .any(|change| change.field == "extra.money_alias")
    );
    assert_eq!(
        actual
            .document
            .fields
            .iter()
            .find(|field| field.id == "extra.money_alias")
            .unwrap()
            .value,
        SaveValue::U32(2000)
    );

    let base = original
        .sections
        .iter()
        .find(|section| section.id == 0)
        .unwrap()
        .physical_offset as usize;
    let mut expected = source.bytes.clone();
    expected[base + 0x400] = 37;
    let sum = expected[base..base + 0xf2c]
        .chunks_exact(4)
        .fold(0u32, |sum, word| {
            sum.wrapping_add(u32::from_le_bytes(word.try_into().unwrap()))
        });
    let checksum = (sum as u16).wrapping_add((sum >> 16) as u16);
    expected[base + 0xff6..base + 0xff8].copy_from_slice(&checksum.to_le_bytes());
    let result = schema
        .apply(
            &source,
            &identity,
            &[SaveEdit {
                field: "extra.value".into(),
                value: SaveValue::U32(37),
            }],
            false,
        )
        .unwrap();
    assert_eq!(result.bytes.as_ref(), Some(&expected));
    assert_eq!(
        result
            .document
            .fields
            .iter()
            .find(|field| field.id == "extra.value")
            .unwrap()
            .value,
        SaveValue::U32(37)
    );

    let game = Arc::make_mut(&mut schema.game);
    game.generation = Some(
        Generation::build(
            GenerationDefinition {
                fill: 0,
                patches: vec![InitialPatch {
                    offset: 0,
                    bytes: source.bytes,
                }],
                values: [("extra.value".into(), SaveValue::U32(37))].into(),
            },
            game.save_size,
        )
        .unwrap(),
    );
    game.validate_generation().unwrap();
    assert!(schema.supports_generation(&identity));
    assert_eq!(schema.generate(&identity).unwrap(), expected);
}
