use super::{SchemaSaveHandler, catalog};
use crate::save::{
    SaveDetectionInput, SaveEdit, SaveGameHandler, SaveValue,
    pokemon_gen1::PokemonGen1Handler as NativeGen1, pokemon_gen2::PokemonGen2Handler as NativeGen2,
};

fn input(bytes: Vec<u8>, id: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(id.into()),
        rom_sha1: None,
    }
}

fn check_documents(handlers: Vec<SchemaSaveHandler>, native: &dyn SaveGameHandler) {
    for definition in native.definitions() {
        let schema = handlers
            .iter()
            .find(|handler| handler.definitions()[0].identity.id == definition.identity.id)
            .unwrap();
        assert_eq!(schema.definitions(), vec![definition.clone()]);
        let source = input(
            native.generate(&definition.identity).unwrap(),
            &definition.identity.id,
        );
        assert_eq!(
            schema.recognize(&source),
            native.recognize(&source),
            "{} recognition mismatch",
            definition.identity.id,
        );
        let actual = schema.parse(&source, &definition.identity).unwrap();
        let expected = native.parse(&source, &definition.identity).unwrap();
        if actual != expected {
            let first = actual
                .fields
                .iter()
                .zip(&expected.fields)
                .position(|(actual, expected)| actual != expected);
            panic!(
                "{} document mismatch: fields {} != {}, first field {first:?}: actual={:?}, expected={:?}, metadata={}",
                definition.identity.id,
                actual.fields.len(),
                expected.fields.len(),
                first.and_then(|index| actual.fields.get(index)),
                first.and_then(|index| expected.fields.get(index)),
                format_args!(
                    "identity={} slot={} counter={} integrity={} sections={:?}/{:?} platform={} format={} format_name={} handler={} size={} warnings={}",
                    actual.identity == expected.identity,
                    actual.active_slot == expected.active_slot,
                    actual.counter == expected.counter,
                    actual.integrity == expected.integrity,
                    actual.sections,
                    expected.sections,
                    actual.platform == expected.platform,
                    actual.save_format == expected.save_format,
                    actual.save_format_name == expected.save_format_name,
                    actual.handler_id == expected.handler_id,
                    actual.save_size == expected.save_size,
                    actual.warnings == expected.warnings,
                ),
            );
        }
        let edits = expected
            .fields
            .iter()
            .filter(|field| field.editable)
            .filter_map(|field| {
                let value = match &field.value {
                    SaveValue::Bool(value) => SaveValue::Bool(!value),
                    SaveValue::Enum(value) => SaveValue::Enum(
                        field
                            .constraints
                            .choices
                            .iter()
                            .find(|choice| *choice != value)?
                            .clone(),
                    ),
                    SaveValue::U32(value) => SaveValue::U32(u32::from(*value == 0)),
                    SaveValue::Text(_) => SaveValue::Text("A♀".into()),
                    _ => return None,
                };
                Some(SaveEdit {
                    field: field.id.clone(),
                    value,
                })
            })
            .collect::<Vec<_>>();
        let actual = schema
            .apply(&source, &definition.identity, &edits, false)
            .unwrap();
        let expected = native
            .apply(&source, &definition.identity, &edits, false)
            .unwrap();
        if actual != expected {
            let first = actual.bytes.as_ref().zip(expected.bytes.as_ref()).and_then(
                |(actual, expected)| {
                    actual
                        .iter()
                        .zip(expected)
                        .position(|(actual, expected)| actual != expected)
                },
            );
            panic!(
                "{} edit mismatch: first byte {first:?}, touched={:?}/{:?}, valid={}/{}, recalculated={}/{}, changes={}, document={}",
                definition.identity.id,
                actual.preview.touched_sections,
                expected.preview.touched_sections,
                actual.preview.output_valid,
                expected.preview.output_valid,
                actual.preview.integrity_recalculated,
                expected.preview.integrity_recalculated,
                actual.preview.changes == expected.preview.changes,
                actual.document == expected.document,
            );
        }
    }
}

#[test]
fn pokemon_generation_1_schema_matches_native_documents() {
    check_documents(catalog::builtin_pokemon_gen1::schemas(), &NativeGen1);
}

#[test]
fn pokemon_generation_2_schema_matches_native_documents() {
    check_documents(catalog::builtin_pokemon_gen2::schemas(), &NativeGen2);
}

#[test]
fn pokemon_generation_2_schema_matches_native_partial_recovery() {
    let native = NativeGen2;
    let handlers = catalog::builtin_pokemon_gen2::schemas();
    for definition in native.definitions() {
        let schema = handlers
            .iter()
            .find(|handler| handler.definitions()[0].identity.id == definition.identity.id)
            .unwrap();
        let mut bytes = native.generate(&definition.identity).unwrap();
        let backup_checksum = if definition.identity.id == "pokemon-crystal" {
            0x1f0d
        } else {
            0x7e6d
        };
        bytes[backup_checksum] ^= 1;
        let source = input(bytes, &definition.identity.id);
        assert_eq!(
            schema.parse(&source, &definition.identity).unwrap(),
            native.parse(&source, &definition.identity).unwrap(),
        );
        let edit = [SaveEdit {
            field: "trainer.money".into(),
            value: SaveValue::U32(1),
        }];
        assert_eq!(
            schema
                .apply(&source, &definition.identity, &edit, false)
                .unwrap_err()
                .to_string(),
            native
                .apply(&source, &definition.identity, &edit, false)
                .unwrap_err()
                .to_string(),
        );
    }
}

#[test]
fn pokemon_schemas_match_native_occupied_inventory_fields() {
    type InventoryCase = (
        fn() -> Vec<SchemaSaveHandler>,
        &'static dyn SaveGameHandler,
        &'static str,
        fn(&mut [u8]),
    );
    let cases: [InventoryCase; 2] = [
        (
            catalog::builtin_pokemon_gen1::schemas,
            &NativeGen1,
            "pokemon-red",
            |bytes| {
                bytes[0x25c9..=0x25cc].copy_from_slice(&[1, 1, 2, 0xff]);
                let sum = bytes[0x2598..0x3523]
                    .iter()
                    .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
                bytes[0x3523] = !sum;
            },
        ),
        (
            catalog::builtin_pokemon_gen2::schemas,
            &NativeGen2,
            "pokemon-gold",
            |bytes| {
                for base in [0x241f, 0x0cb1] {
                    bytes[base..=base + 3].copy_from_slice(&[1, 1, 2, 0xff]);
                }
                let main = bytes[0x2009..0x2d69]
                    .iter()
                    .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
                bytes[0x2d69..0x2d6b].copy_from_slice(&main.to_le_bytes());
                let backup = [
                    (0x10e8, 0x4df),
                    (0x0c6b, 0x47d),
                    (0x15c7, 0x226),
                    (0x3d96, 0x1aa),
                    (0x7e39, 0x34),
                ]
                .into_iter()
                .flat_map(|(start, length)| &bytes[start..start + length])
                .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
                bytes[0x7e6d..0x7e6f].copy_from_slice(&backup.to_le_bytes());
            },
        ),
    ];
    for (schemas, native, id, prepare) in cases {
        let definition = native
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == id)
            .unwrap();
        let mut bytes = native.generate(&definition.identity).unwrap();
        prepare(&mut bytes);
        let source = input(bytes, id);
        let schema = schemas()
            .into_iter()
            .find(|handler| handler.definitions()[0].identity.id == id)
            .unwrap();
        assert_eq!(
            schema.parse(&source, &definition.identity).unwrap(),
            native.parse(&source, &definition.identity).unwrap(),
        );
    }
}
