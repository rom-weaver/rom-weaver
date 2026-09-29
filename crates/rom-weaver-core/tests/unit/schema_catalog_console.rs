use super::{
    SaveDetectionInput, SaveEdit, SaveGameRegistry, SaveIntegrityState, SaveRecognitionOutcome,
    SaveValue, SchemaSaveHandler, schema::catalog,
};

#[test]
fn console_catalog_modules_build_expected_games() {
    for (schemas, expected) in [
        (
            catalog::mario_party::schemas(),
            "mario-party-canonical-eeprom",
        ),
        (
            catalog::mario_party_2::schemas(),
            "mario-party-2-canonical-eeprom",
        ),
        (catalog::secret_of_mana::schemas(), "secret-of-mana-slot-1"),
        (
            catalog::super_mario_64::schemas(),
            "super-mario-64-canonical-eeprom-mario-a",
        ),
        (
            catalog::super_mario_rpg::schemas(),
            "super-mario-rpg-slot-1",
        ),
        (catalog::super_metroid::schemas(), "super-metroid-samus-a"),
    ] {
        assert!(
            schemas
                .iter()
                .flat_map(SchemaSaveHandler::definitions)
                .any(|definition| definition.identity.id == expected),
            "catalog module omitted {expected}"
        );
    }
}

fn sm64_block_checksum(bytes: &mut [u8], start: usize, length: usize, magic: &[u8; 2]) {
    let signature = start + length - 4;
    bytes[signature..signature + 2].copy_from_slice(magic);
    let checksum = bytes[start..signature + 2]
        .iter()
        .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
    bytes[signature + 2..signature + 4].copy_from_slice(&checksum.to_be_bytes());
}

fn sm64_fixture(size: usize) -> Vec<u8> {
    // The game stores four pairs of 56-byte files and two 32-byte menu records.
    // https://github.com/n64decomp/sm64/blob/master/src/game/save_file.h
    let mut bytes = (0..size)
        .map(|offset| (offset % 251) as u8)
        .collect::<Vec<_>>();
    for start in (0..448).step_by(56) {
        bytes[start + 11] |= 1;
        sm64_block_checksum(&mut bytes, start, 56, b"DA");
    }
    for start in [448, 480] {
        bytes[start + 16] = 0;
        bytes[start + 17] = 0;
        sm64_block_checksum(&mut bytes, start, 32, b"HI");
    }
    bytes
}

fn sm64_input(size: usize, slot: char) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes: sm64_fixture(size),
        selected_game: Some(format!("super-mario-64-canonical-eeprom-mario-{slot}")),
        rom_sha1: None,
    }
}

#[test]
fn sm64_profiles_accept_native_and_padded_eeprom() {
    let registry = SaveGameRegistry::default();
    for slot in ['a', 'b', 'c', 'd'] {
        for size in [512, 2048] {
            let source = sm64_input(size, slot);
            let definition = registry
                .definitions()
                .into_iter()
                .find(|game| Some(&game.identity.id) == source.selected_game.as_ref())
                .unwrap();
            assert_eq!(definition.supported_save_sizes, [512, 2048]);
            assert!(matches!(
                registry.detect(&source).outcome,
                SaveRecognitionOutcome::Recognized { .. }
            ));
            let document = registry.parse(&source, &definition.identity).unwrap();
            assert_eq!(document.save_size, size as u32);
            assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
        }
        for size in [511, 513, 1024, 2049] {
            let mut source = sm64_input(2048, slot);
            source.bytes.resize(size, 0);
            assert!(matches!(
                registry.detect(&source).outcome,
                SaveRecognitionOutcome::Unsupported { .. }
            ));
        }
    }
}

#[test]
fn sm64_edits_survive_reload_and_preserve_other_files_and_padding() {
    let registry = SaveGameRegistry::default();
    for (slot_index, slot) in ['a', 'b', 'c', 'd'].into_iter().enumerate() {
        for size in [2048, 512] {
            let source = sm64_input(size, slot);
            let game = registry
                .definitions()
                .into_iter()
                .find(|game| Some(&game.identity.id) == source.selected_game.as_ref())
                .unwrap()
                .identity;
            let edits = [
                SaveEdit {
                    field: format!("mario_{slot}.course_flags_01"),
                    value: SaveValue::U32(0x55),
                },
                SaveEdit {
                    field: "options.sound".into(),
                    value: SaveValue::U32(1),
                },
            ];
            let result = registry.apply(&source, &game, &edits, false).unwrap();
            let output = result.bytes.unwrap();
            let start = slot_index * 112;
            let mut expected = source.bytes.clone();
            expected[start + 12] = 0x55;
            expected[465] = 1;
            sm64_block_checksum(&mut expected, start, 56, b"DA");
            sm64_block_checksum(&mut expected, 448, 32, b"HI");
            expected.copy_within(start..start + 56, start + 56);
            expected.copy_within(448..480, 480);
            assert_eq!(output, expected, "Mario {slot}, {size} bytes");
            assert_eq!(result.document.save_size, size as u32);

            // Game-over reload MUST retain the edit when it restores both backups.
            // https://github.com/n64decomp/sm64/blob/master/src/game/save_file.c#L315
            let mut reloaded = output.clone();
            reloaded.copy_within(start + 56..start + 112, start);
            reloaded.copy_within(480..512, 448);
            assert_eq!(reloaded, output);
        }
    }
}

#[test]
fn sm64_noop_dry_run_and_invalid_input_preserve_the_source() {
    let registry = SaveGameRegistry::default();
    for size in [512, 2048] {
        let source = sm64_input(size, 'a');
        let original = source.bytes.clone();
        let game = registry
            .definitions()
            .into_iter()
            .find(|game| Some(&game.identity.id) == source.selected_game.as_ref())
            .unwrap()
            .identity;
        let noop = registry
            .apply(
                &source,
                &game,
                &[SaveEdit {
                    field: "options.sound".into(),
                    value: SaveValue::U32(0),
                }],
                false,
            )
            .unwrap();
        assert!(!noop.preview.changed);
        assert!(noop.bytes.is_none());
        assert_eq!(noop.document.save_size, size as u32);

        let edit = [SaveEdit {
            field: "options.sound".into(),
            value: SaveValue::U32(1),
        }];
        let dry_run = registry.apply(&source, &game, &edit, true).unwrap();
        assert!(dry_run.preview.changed);
        assert!(dry_run.bytes.is_none());
        assert_eq!(dry_run.document.save_size, size as u32);
        assert_eq!(source.bytes, original);

        for offset in [0, 52, 448, 476] {
            let mut corrupt = source.clone();
            corrupt.bytes[offset] ^= 1;
            let original = corrupt.bytes.clone();
            assert!(registry.apply(&corrupt, &game, &edit, false).is_err());
            assert_eq!(corrupt.bytes, original);
        }
    }
}
