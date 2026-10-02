use std::collections::HashSet;

use super::super::{SaveDetectionInput, SaveEdit, SaveGameRegistry, SaveValue};

#[test]
fn every_catalog_pack_loads_and_builtins_match_the_default_registry() {
    let registry = SaveGameRegistry::default();
    let mut ids = HashSet::new();
    let handlers = super::catalog::all();
    assert_eq!(handlers.len(), 140);
    for handler in handlers {
        let definition = super::SchemaSaveHandler::definitions(&handler)
            .into_iter()
            .next()
            .unwrap();
        let id = &definition.identity.id;
        assert!(ids.insert(id.clone()), "duplicate catalog game: {id}");
        assert!(!handler.game.fields.is_empty(), "empty catalog game: {id}");
        assert!(registry.definitions().contains(&definition));
        if super::SchemaSaveHandler::supports_generation(&handler, &definition.identity) {
            super::SchemaSaveHandler::generate(&handler, &definition.identity)
                .unwrap_or_else(|error| panic!("{id}: {error}"));
        }
    }
}

#[test]
fn extra_zelda_slots_preserve_other_files_and_match_full_profile_rupee_edits() {
    let registry = SaveGameRegistry::default();
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
    let full_profile = definitions
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
            .apply(&original, &full_profile.identity, &edits, false)
            .unwrap();
        let actual = registry
            .apply(&input, &schema.identity, &edits, false)
            .unwrap();
        assert_eq!(actual.bytes, expected.bytes);
    }
}

#[test]
fn extra_mario_world_slots_preserve_other_files_and_match_full_profile_edits() {
    let registry = SaveGameRegistry::default();
    let mut original = registry.generate("super-mario-world").unwrap();
    for offset in [143, 286, 572, 715] {
        original.bytes.copy_within(0..143, offset);
    }
    let definitions = registry.definitions();
    let full_profile = definitions
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
            .apply(&original, &full_profile.identity, &edits, false)
            .unwrap();
        let actual = registry
            .apply(&input, &schema.identity, &edits, false)
            .unwrap();
        assert_eq!(actual.bytes, expected.bytes);
    }
}
