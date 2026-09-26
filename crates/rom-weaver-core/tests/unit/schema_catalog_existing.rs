use super::{
    PokemonGen1Handler, PokemonGen2Handler, SaveDetectionInput, SaveEdit, SaveGameHandler,
    SaveGameRegistry, SaveValue, ZeldaAlttpHandler,
};

const POKEMON_GEN1_PACK: &[u8] =
    include_bytes!("../../../../data/save-schemas/pokemon-generation-i.json");
const ZELDA_ALTTP_PACK: &[u8] =
    include_bytes!("../../../../data/save-schemas/zelda-a-link-to-the-past.json");
const POKEMON_GEN2_PACK: &[u8] =
    include_bytes!("../../../../data/save-schemas/pokemon-generation-ii.json");

fn input(bytes: Vec<u8>, game: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(game.into()),
        rom_sha1: None,
    }
}

fn value_for_gen1_field(id: &str) -> SaveValue {
    match id {
        "trainer.id" => SaveValue::U32(0xabcd),
        "trainer.money" => SaveValue::U32(123_456),
        "trainer.coins" => SaveValue::U32(1234),
        "trainer.play_time.hours" => SaveValue::U32(42),
        "trainer.play_time.minutes" => SaveValue::U32(23),
        "trainer.play_time.seconds" => SaveValue::U32(34),
        "trainer.play_time.frames" => SaveValue::U32(45),
        "yellow.pikachu_friendship" => SaveValue::U32(255),
        "yellow.printer_brightness" => SaveValue::U32(127),
        "yellow.pikachu_beach_score" => SaveValue::U32(1234),
        _ if id.contains("name_glyph") => SaveValue::U32(0x80),
        "options.battle_scene" | "options.battle_style" => SaveValue::Bool(false),
        _ => SaveValue::Bool(true),
    }
}

#[test]
fn pokemon_gen1_schema_template_and_representable_edits_match_native() {
    let registry = SaveGameRegistry::default()
        .with_schema_pack_json(POKEMON_GEN1_PACK)
        .unwrap();
    for (native_id, schema_id) in [
        ("pokemon-red", "pokemon-red-schema"),
        ("pokemon-blue", "pokemon-blue-schema"),
        ("pokemon-yellow", "pokemon-yellow-schema"),
    ] {
        let native_game = PokemonGen1Handler
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == native_id)
            .unwrap()
            .identity;
        let schema_game = registry
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == schema_id)
            .unwrap()
            .identity;
        let native_bytes = PokemonGen1Handler.generate(&native_game).unwrap();
        assert!(registry.generate(schema_id).is_err());

        let schema_input = input(native_bytes.clone(), schema_id);
        let schema_document = registry.parse(&schema_input, &schema_game).unwrap();
        let edits = schema_document
            .fields
            .iter()
            .filter(|field| !field.id.contains("name_glyph") && !field.id.contains("_bit_"))
            .map(|field| SaveEdit {
                field: field.id.clone(),
                value: value_for_gen1_field(&field.id),
            })
            .collect::<Vec<_>>();
        let expected = PokemonGen1Handler
            .apply(&input(native_bytes, native_id), &native_game, &edits, false)
            .unwrap();
        let actual = registry
            .apply(&schema_input, &schema_game, &edits, false)
            .unwrap();
        assert_eq!(actual.bytes, expected.bytes);
    }
}

fn value_for_zelda_field(id: &str) -> SaveValue {
    if id.ends_with("resources.rupees") {
        return SaveValue::U32(321);
    }
    if id.ends_with("smith_tempering") {
        return SaveValue::Bool(false);
    }
    if id.contains("hearts.capacity_eighths") {
        return SaveValue::U32(32);
    }
    if id.contains("hearts.current_eighths") {
        return SaveValue::U32(24);
    }
    if id.contains("resources.bombs")
        || id.contains("resources.arrows")
        || id.contains("capacity_upgrades")
        || id.contains("heart_pieces")
        || id.contains("magic.current")
        || id.ends_with("keys_earned")
    {
        return SaveValue::U32(1);
    }
    SaveValue::Bool(true)
}

#[test]
fn zelda_alttp_schema_generation_and_representable_edits_match_native() {
    let registry = SaveGameRegistry::default()
        .with_schema_pack_json(ZELDA_ALTTP_PACK)
        .unwrap();
    let native_game = ZeldaAlttpHandler.definitions()[0].identity.clone();
    let schema_id = "zelda-a-link-to-the-past-file-1-schema";
    let schema_game = registry
        .definitions()
        .into_iter()
        .find(|definition| definition.identity.id == schema_id)
        .unwrap()
        .identity;
    let native_bytes = ZeldaAlttpHandler.generate(&native_game).unwrap();
    assert_eq!(registry.generate(schema_id).unwrap().bytes, native_bytes);

    let schema_input = input(native_bytes.clone(), schema_id);
    let schema_document = registry.parse(&schema_input, &schema_game).unwrap();
    let edits = schema_document
        .fields
        .iter()
        .filter(|field| !field.id.contains(".raw_"))
        .map(|field| SaveEdit {
            field: field.id.clone(),
            value: value_for_zelda_field(&field.id),
        })
        .collect::<Vec<_>>();
    let expected = ZeldaAlttpHandler
        .apply(
            &input(native_bytes, &native_game.id),
            &native_game,
            &edits,
            false,
        )
        .unwrap();
    let actual = registry
        .apply(&schema_input, &schema_game, &edits, false)
        .unwrap();
    assert_eq!(actual.bytes, expected.bytes);
}

#[test]
fn pokemon_gen2_schema_template_and_semantic_fixed_edits_match_native() {
    let registry = SaveGameRegistry::default()
        .with_schema_pack_json(POKEMON_GEN2_PACK)
        .unwrap();
    for native_game in PokemonGen2Handler.definitions() {
        let native_game = native_game.identity;
        let schema_id = format!("{}-schema", native_game.id);
        let schema_game = registry
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == schema_id)
            .unwrap()
            .identity;
        let native_bytes = PokemonGen2Handler.generate(&native_game).unwrap();
        assert!(registry.generate(&schema_id).is_err());

        let schema_input = input(native_bytes.clone(), &schema_id);
        let schema_document = registry.parse(&schema_input, &schema_game).unwrap();
        let edits = schema_document
            .fields
            .iter()
            .filter(|field| {
                !field.id.contains("name_glyph")
                    && (!field.id.starts_with("options.")
                        || matches!(
                            field.id.as_str(),
                            "options.battle_scene" | "options.battle_style"
                        ))
            })
            .map(|field| SaveEdit {
                field: field.id.clone(),
                value: match field.value {
                    SaveValue::Bool(_) if field.id.starts_with("options.battle_") => {
                        SaveValue::Bool(false)
                    }
                    SaveValue::Bool(_) => SaveValue::Bool(true),
                    SaveValue::U32(_) if field.id == "trainer.id" => SaveValue::U32(0xabcd),
                    SaveValue::U32(_) if field.id.contains("play_time.hours") => SaveValue::U32(42),
                    SaveValue::U32(_) if field.id.contains("play_time.") => SaveValue::U32(23),
                    SaveValue::U32(_) if field.id.starts_with("trainer.") => SaveValue::U32(1234),
                    SaveValue::U32(_) => SaveValue::U32(1),
                    _ => panic!("unexpected Generation II schema field kind"),
                },
            })
            .collect::<Vec<_>>();
        let expected = PokemonGen2Handler
            .apply(
                &input(native_bytes, &native_game.id),
                &native_game,
                &edits,
                false,
            )
            .unwrap();
        let actual = registry
            .apply(&schema_input, &schema_game, &edits, false)
            .unwrap();
        assert_eq!(actual.bytes, expected.bytes);
    }
}
