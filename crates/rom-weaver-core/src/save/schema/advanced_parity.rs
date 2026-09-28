use super::{SchemaSaveHandler, catalog};
use crate::save::{
    SaveDetectionInput, SaveEdit, SaveGameHandler, SaveValue,
    pokemon_gen3::PokemonGen3Handler,
    pokemon_gen4::PokemonGen4Handler,
    pokemon_gen5::{PokemonGen5Handler, tests::fixture_for_id},
};

fn input(bytes: Vec<u8>, id: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(id.into()),
        rom_sha1: None,
    }
}

fn check_pack(
    handlers: Vec<SchemaSaveHandler>,
    native: &dyn SaveGameHandler,
    fixtures: impl Fn(&str) -> Vec<u8>,
) {
    for definition in native.definitions() {
        let schema = handlers
            .iter()
            .find(|handler| handler.definitions()[0].identity.id == definition.identity.id)
            .unwrap();
        assert_eq!(schema.definitions(), vec![definition.clone()]);
        assert!(!schema.supports_generation(&definition.identity));
        let source = input(fixtures(&definition.identity.id), &definition.identity.id);
        assert_eq!(schema.recognize(&source), native.recognize(&source));
        let expected = native.parse(&source, &definition.identity).unwrap();
        let actual = schema.parse(&source, &definition.identity).unwrap();
        assert_eq!(
            actual, expected,
            "{} parse mismatch",
            definition.identity.id
        );

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
                    SaveValue::U32(value) if !field.id.starts_with("inventory.") => {
                        SaveValue::U32(if *value == 0 { 1 } else { 0 })
                    }
                    SaveValue::Text(_) if field.id == "trainer.name" => {
                        SaveValue::Text("A♀".into())
                    }
                    _ => return None,
                };
                Some(SaveEdit {
                    field: field.id.clone(),
                    value,
                })
            })
            .collect::<Vec<_>>();
        let native_result = native
            .apply(&source, &definition.identity, &edits, false)
            .unwrap();
        let schema_result = schema
            .apply(&source, &definition.identity, &edits, false)
            .unwrap();
        if schema_result != native_result {
            let schema_bytes = schema_result.bytes.as_ref().unwrap();
            let native_bytes = native_result.bytes.as_ref().unwrap();
            let first = schema_bytes
                .iter()
                .zip(native_bytes)
                .position(|(schema, native)| schema != native);
            panic!(
                "{} edit mismatch: first byte {first:?}, document={}, schema byte={:?}, native byte={:?}, schema touched={:?}, native touched={:?}, schema changes={}, native changes={}",
                definition.identity.id,
                schema_result.document == native_result.document,
                first.map(|offset| schema_bytes[offset]),
                first.map(|offset| native_bytes[offset]),
                schema_result.preview.touched_sections,
                native_result.preview.touched_sections,
                schema_result.preview.changes.len(),
                native_result.preview.changes.len(),
            );
        }
    }
}

#[test]
fn pokemon_generation_3_schema_matches_native_documents_and_edits() {
    let native = PokemonGen3Handler;
    check_pack(catalog::builtin_pokemon_gen3::schemas(), &native, |id| {
        let identity = native
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == id)
            .unwrap()
            .identity;
        native.generate(&identity).unwrap()
    });
}

#[test]
fn pokemon_generation_4_schema_matches_native_documents_and_edits() {
    let native = PokemonGen4Handler;
    check_pack(catalog::builtin_pokemon_gen4::schemas(), &native, |id| {
        let identity = native
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == id)
            .unwrap()
            .identity;
        native.generate(&identity).unwrap()
    });
}

#[test]
fn pokemon_generation_5_schema_matches_native_documents_and_edits() {
    check_pack(
        catalog::builtin_pokemon_gen5::schemas(),
        &PokemonGen5Handler,
        fixture_for_id,
    );
}
