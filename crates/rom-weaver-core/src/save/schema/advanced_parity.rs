use super::{SchemaSaveHandler, catalog, legacy_contract};
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
        let source = input(fixtures(&definition.identity.id), &definition.identity.id);
        assert_eq!(schema.recognize(&source), native.recognize(&source));
        let expected = native.parse(&source, &definition.identity).unwrap();
        let actual = schema.parse(&source, &definition.identity).unwrap();
        legacy_contract::assert_document(actual, &expected);

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
        legacy_contract::assert_edit(schema_result, native_result);
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

#[test]
fn schema_fields_and_generation_extend_the_frozen_legacy_contract() {
    use std::sync::Arc;

    use super::generation::{Generation, GenerationDefinition, InitialPatch};
    use super::{FieldDefinition, FieldSchema, Storage};

    let native = PokemonGen3Handler;
    let mut schema = catalog::builtin_pokemon_gen3::schemas()
        .into_iter()
        .find(|handler| handler.game.id == "pokemon-emerald")
        .unwrap();
    let identity = schema.definitions().remove(0).identity;
    let source = input(native.generate(&identity).unwrap(), &identity.id);
    let original = native.parse(&source, &identity).unwrap();
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

    legacy_contract::assert_document(schema.parse(&source, &identity).unwrap(), &original);
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
    legacy_contract::assert_edit(
        actual,
        native.apply(&source, &identity, &edits, false).unwrap(),
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
