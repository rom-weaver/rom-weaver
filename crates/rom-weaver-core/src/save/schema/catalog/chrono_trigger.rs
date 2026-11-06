use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

const SLOT_SIZE: usize = 0xa00;

/// Mirrors the game's `SaveSlot_Checksum` at `$FF:FBE7`: starting with carry clear, it
/// `ADC`s each little-endian word from slot offset `0x9fe` down to `0`, so each carry enters
/// the next add and the last carry is dropped.
/// https://github.com/dscotton/ct_disassembly/blob/eeae27acdb6565e96d1d796a3d60792c250c0aa1/bank_FF.asm#L1301-L1322
fn checksum(bytes: &[u8], base: usize) -> u16 {
    let (sum, _) = bytes[base..base + SLOT_SIZE].chunks_exact(2).rev().fold(
        (0u16, false),
        |(sum, carry), word| {
            let (sum, word_carry) = sum.overflowing_add(u16::from_le_bytes([word[0], word[1]]));
            let (sum, carry_in_carry) = sum.overflowing_add(u16::from(carry));
            (sum, word_carry || carry_in_carry)
        },
    );
    sum
}

// Layout, slot markers, and write rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/chrono-trigger/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3).map(|slot| {
        let base = slot * SLOT_SIZE;
        let checksum_offset = 0x1ff0 + slot * 2;
        let check = Check { when: None, assert: Condition::new(move |bytes| Ok(u16::from_le_bytes([bytes[checksum_offset], bytes[checksum_offset + 1]]) == checksum(bytes, base))), code: "chrono_trigger_checksum".into(), message: "the Chrono Trigger slot checksum is invalid".into(), section_id: None, warning: None };
        GameDefinition {
            fields: vec![
                catalog_field("gold", "Gold", base + 0x5e0, Storage::U24Le).min(0).max(9_999_999),
                catalog_field("inventory.first_item", "First inventory item code", base, Storage::U8).editable(false),
            ],
            description: format!("Edits independent scalar fields in slot {}. Character levels, locations, inventory pairs, and progression are omitted because they have coupled write rules.", slot + 1),
            signatures: vec![SignatureDefinition { offset: 0x1ff8 + slot * 2, bytes: vec![0x1b, 0xe4] }],
            runtime: runtime::Runtime { recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: true }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: checksum_offset, storage: Storage::U16Le, mask: None }, value: ReadValue::new(move |bytes| Ok(i64::from(checksum(bytes, base)))) }], ..Default::default() },
            ..GameDefinition::new(format!("chrono-trigger-slot-{}", slot + 1), format!("Chrono Trigger (Slot {})", slot + 1), "snes".into(), 8192)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn slot_words(slot: usize, words: &[(usize, u16)]) -> Vec<u8> {
        let mut bytes = vec![0; 8192];
        for &(offset, word) in words {
            let offset = slot * SLOT_SIZE + offset;
            bytes[offset..offset + 2].copy_from_slice(&word.to_le_bytes());
        }
        bytes
    }

    /// Wraps `slot_words` with the slot marker and stored checksum of a valid save.
    fn slot_input(
        slot: usize,
        words: &[(usize, u16)],
        stored_checksum: u16,
        game: &str,
    ) -> SaveDetectionInput {
        let mut bytes = slot_words(slot, words);
        bytes[0x1ff8 + slot * 2..0x1ffa + slot * 2].copy_from_slice(&[0x1b, 0xe4]);
        bytes[0x1ff0 + slot * 2..0x1ff2 + slot * 2].copy_from_slice(&stored_checksum.to_le_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some(game.into()),
            rom_sha1: None,
        }
    }

    // https://github.com/mikearnos/snessum/blob/5c2d71fcfc989b407f79c01eccdbae6034436824/snessum.c#L145-L158
    #[test]
    fn checksum_matches_game_adc_chain_vectors() {
        let ramp: Vec<u8> = (0..8192).map(|offset| offset as u8).collect();
        for slot in 0..3 {
            assert_eq!(checksum(&ramp, slot * SLOT_SIZE), 0x7d82);
        }
        assert_eq!(checksum(&vec![0xff; 8192], 0), 0xfffe);
        assert_eq!(checksum(&vec![0x33; 8192], 0), 0xffff);
        assert_eq!(
            checksum(&slot_words(1, &[(0, 0xffff), (2, 0x0001)]), SLOT_SIZE),
            0
        );
        assert_eq!(
            checksum(&slot_words(1, &[(0, 0x0001), (2, 0xffff)]), SLOT_SIZE),
            0
        );
        assert_eq!(
            checksum(&slot_words(0, &[(0, 0x0001), (2, 0xfffe)]), 0),
            0xffff
        );
        assert_eq!(
            checksum(&slot_words(2, &[(2, 0xffff)]), 2 * SLOT_SIZE),
            0xffff
        );
        assert_eq!(
            checksum(
                &slot_words(2, &[(0x9fe, 0xffff), (0x9fc, 0x0001)]),
                2 * SLOT_SIZE
            ),
            1
        );
    }

    #[test]
    fn edit_repairs_slot_checksum_and_preserves_system_area() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x33; 8192];
        bytes[0x1ff8..0x1ffa].copy_from_slice(&[0x1b, 0xe4]);
        bytes[0x1ff0..0x1ff2].copy_from_slice(&0xffffu16.to_le_bytes());
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x5e0..0x5e3].copy_from_slice(&[0x56, 0x34, 0x12]);
        expected[0x1ff0..0x1ff2].copy_from_slice(&0x0101u16.to_le_bytes());
        let output = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "gold".into(),
                    value: SaveValue::U32(0x123456),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(output, expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[9] ^= 1;
        assert!(matches!(
            handler.recognize(&bad).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    #[test]
    fn edit_accepts_and_writes_the_games_checksum_after_a_carry() {
        let handler = schemas().remove(0);
        let game = handler.definitions().remove(0).identity;
        let input = slot_input(0, &[(0, 0x0001), (2, 0xfffe)], 0xffff, &game.id);
        let output = handler
            .apply(
                &input,
                &game,
                &[SaveEdit {
                    field: "gold".into(),
                    value: SaveValue::U32(1),
                }],
                false,
            )
            .expect("a save with the game's own checksum must be editable")
            .bytes
            .expect("edited bytes");
        assert_eq!(output[0x5e0..0x5e3], [0x01, 0x00, 0x00]);
        assert_eq!(
            output[0x1ff0..0x1ff2],
            [0x00, 0x00],
            "edit must store the game's checksum"
        );
    }

    #[test]
    fn first_item_reads_the_first_inventory_byte() {
        let handler = schemas().remove(1);
        let game = handler.definitions().remove(0).identity;
        let input = slot_input(1, &[(0, 0x00c4), (0x2c4, 0x7700)], 0x77c4, &game.id);
        let document = handler.parse(&input, &game).expect("valid slot 2");
        let first_item = document
            .fields
            .iter()
            .find(|field| field.id == "inventory.first_item")
            .expect("first item field");
        assert_eq!(
            first_item.value,
            SaveValue::U32(0xc4),
            "first item must come from slot offset 0x0"
        );
    }
}
