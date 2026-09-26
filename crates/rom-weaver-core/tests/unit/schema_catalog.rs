use std::{collections::HashSet, fs, path::Path};

use super::{SaveDetectionInput, SaveEdit, SaveGameRegistry, SaveValue};

#[test]
fn every_catalog_pack_loads_without_replacing_another_game() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/save-schemas");
    let mut registry = SaveGameRegistry::default();
    let mut ids = HashSet::new();
    let mut count = 0;
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|extension| extension != "json")
            || path.file_name().unwrap() == "schema-v1.schema.json"
        {
            continue;
        }
        let bytes = fs::read(&path).unwrap();
        let pack: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        registry = registry
            .with_schema_pack_json(&bytes)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        for game in pack["games"].as_array().unwrap() {
            let id = game["id"].as_str().unwrap();
            assert!(ids.insert(id.to_owned()), "duplicate catalog game: {id}");
            assert!(
                !game["fields"].as_array().unwrap().is_empty(),
                "empty catalog game: {id}"
            );
            if game
                .get("generation")
                .is_some_and(|generation| !generation.is_null())
            {
                registry
                    .generate(id)
                    .unwrap_or_else(|error| panic!("{id}: {error}"));
            }
            count += 1;
        }
    }
    assert!(count > 1);
}

#[test]
fn extra_zelda_slots_preserve_other_files_and_match_native_rupee_edits() {
    let registry = SaveGameRegistry::default()
        .with_schema_pack_json(include_bytes!(
            "../../../../data/save-schemas/zelda-a-link-to-the-past.json"
        ))
        .unwrap();
    let mut original = registry.generate("zelda-a-link-to-the-past").unwrap();
    for offset in [0x500, 0xa00, 0x1400, 0x1900] {
        original.bytes.copy_within(0..0x500, offset);
    }
    // Real SRAM can contain a stale backup while its primary checksum is valid.
    // Editing must accept that primary and replace the stale backup like the game.
    for offset in [0xf00, 0x1400, 0x1900] {
        original.bytes[offset] ^= 1;
    }
    let definitions = registry.definitions();
    let native = definitions
        .iter()
        .find(|game| game.identity.id == "zelda-a-link-to-the-past")
        .unwrap();
    for slot in 1..=3 {
        let id = format!("zelda-a-link-to-the-past-file-{slot}-schema");
        let schema = definitions
            .iter()
            .find(|game| game.identity.id == id)
            .unwrap();
        let input = SaveDetectionInput {
            bytes: original.bytes.clone(),
            selected_game: Some(id),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: format!("slot_{slot}.resources.rupees"),
            value: SaveValue::U32(321),
        }];
        let expected = registry
            .apply(&original, &native.identity, &edits, false)
            .unwrap();
        let actual = registry
            .apply(&input, &schema.identity, &edits, false)
            .unwrap();
        assert_eq!(actual.bytes, expected.bytes);
    }
}

#[test]
fn extra_mario_world_slots_preserve_other_files_and_match_native_edits() {
    let registry = SaveGameRegistry::default()
        .with_schema_pack_json(include_bytes!(
            "../../../../data/save-schemas/super-mario-world.json"
        ))
        .unwrap();
    let mut original = registry.generate("super-mario-world").unwrap();
    for offset in [143, 286, 572, 715] {
        original.bytes.copy_within(0..143, offset);
    }
    let definitions = registry.definitions();
    let native = definitions
        .iter()
        .find(|game| game.identity.id == "super-mario-world")
        .unwrap();
    for slot in 2..=3 {
        let id = format!("super-mario-world-file-{slot}-schema");
        let schema = definitions
            .iter()
            .find(|game| game.identity.id == id)
            .unwrap();
        let input = SaveDetectionInput {
            bytes: original.bytes.clone(),
            selected_game: Some(id),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: format!("slot_{slot}.progress.exits_completed"),
            value: SaveValue::U32(255),
        }];
        let expected = registry
            .apply(&original, &native.identity, &edits, false)
            .unwrap();
        let actual = registry
            .apply(&input, &schema.identity, &edits, false)
            .unwrap();
        assert_eq!(actual.bytes, expected.bytes);
    }
}
