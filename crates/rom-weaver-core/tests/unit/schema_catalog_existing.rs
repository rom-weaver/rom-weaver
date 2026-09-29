use super::{
    SaveDetectionInput, SaveEdit, SaveGameRegistry, SaveIntegrityState, SaveValue,
    pokemon_gen2::Family,
};

fn input(bytes: Vec<u8>, game: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(game.into()),
        rom_sha1: None,
    }
}

fn value(document: &super::SaveDocument, field: &str) -> SaveValue {
    document
        .fields
        .iter()
        .find(|candidate| candidate.id == field)
        .unwrap()
        .value
        .clone()
}

#[test]
fn imported_gen1_profiles_parse_and_edit_game_bytes() {
    let registry = SaveGameRegistry::default();
    for (id, yellow) in [
        ("pokemon-red-schema", false),
        ("pokemon-blue-schema", false),
        ("pokemon-yellow-schema", true),
    ] {
        assert!(registry.generate(id).is_err());
        let source = input(super::pokemon_gen1::fixture(yellow), id);
        let game = registry
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == id)
            .unwrap()
            .identity;
        let result = registry
            .apply(
                &source,
                &game,
                &[
                    SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(654_321),
                    },
                    SaveEdit {
                        field: "trainer.id".into(),
                        value: SaveValue::U32(0x1234),
                    },
                ],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        assert_eq!(&bytes[0x25f3..0x25f6], &[0x65, 0x43, 0x21]);
        assert_eq!(&bytes[0x2605..0x2607], &[0x12, 0x34]);
        assert_eq!(
            value(&result.document, "trainer.money"),
            SaveValue::U32(654_321)
        );
    }
}

#[test]
fn imported_gen2_profiles_edit_both_physical_copies() {
    let registry = SaveGameRegistry::default();
    for (id, family, offsets) in [
        (
            "pokemon-gold-schema",
            Family::GoldSilver,
            [(0x23db, 0x23de), (0x0c6d, 0x0c70)],
        ),
        (
            "pokemon-silver-schema",
            Family::GoldSilver,
            [(0x23db, 0x23de), (0x0c6d, 0x0c70)],
        ),
        (
            "pokemon-crystal-schema",
            Family::Crystal,
            [(0x23dc, 0x23df), (0x15dc, 0x15df)],
        ),
    ] {
        assert!(registry.generate(id).is_err());
        let source = input(super::pokemon_gen2::fixture(family), id);
        let game = registry
            .definitions()
            .into_iter()
            .find(|definition| definition.identity.id == id)
            .unwrap()
            .identity;
        let result = registry
            .apply(
                &source,
                &game,
                &[SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(654_321),
                }],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        for (start, end) in offsets {
            assert_eq!(&bytes[start..end], &[0x09, 0xfb, 0xf1]);
        }
        assert_eq!(result.document.integrity.state, SaveIntegrityState::Valid);
        assert_eq!(
            value(&result.document, "trainer.money"),
            SaveValue::U32(654_321)
        );
    }
}

#[test]
fn imported_zelda_profile_edits_generated_game_bytes() {
    let registry = SaveGameRegistry::default();
    let generated = registry.generate("zelda-a-link-to-the-past").unwrap();
    let id = "zelda-a-link-to-the-past-file-1-schema";
    let source = input(generated.bytes, id);
    let game = registry
        .definitions()
        .into_iter()
        .find(|definition| definition.identity.id == id)
        .unwrap()
        .identity;
    let before_checksum = source.bytes[1278..1280].to_vec();
    let result = registry
        .apply(
            &source,
            &game,
            &[SaveEdit {
                field: "slot_1.resources.rupees".into(),
                value: SaveValue::U32(321),
            }],
            false,
        )
        .unwrap();
    let bytes = result.bytes.unwrap();
    assert_eq!(&bytes[866..868], &[0x41, 0x01]);
    assert_ne!(&bytes[1278..1280], before_checksum);
    assert_eq!(result.document.integrity.state, SaveIntegrityState::Valid);
    assert_eq!(
        value(&result.document, "slot_1.resources.rupees"),
        SaveValue::U32(321)
    );
}
