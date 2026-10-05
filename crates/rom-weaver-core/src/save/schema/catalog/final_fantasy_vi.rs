use super::*;

const SLOT_SIZE: usize = 0xa00;

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/final-fantasy-vi/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3)
        .map(|slot| {
            let base = slot * SLOT_SIZE;
            GameDefinition {
                fields: vec![
                    catalog_field("money", "Money", base + 0x260, Storage::U24Le)
                        .min(0).max(9_999_999),
                    catalog_field("location", "Location code", base + 0x964, Storage::U16Le)
                        .mask(0x1ff).editable(false)
                        .description("Read-only because changing locations also requires matching map coordinates.".into()),
                    catalog_field("config.battle_speed", "Battle speed (stored 0-5)", base + 0x74d, Storage::U8)
                        .mask(0x7).min(0).max(5),
                ],
                description: format!("Edits independent scalar fields in SNES save slot {}. Character, inventory, and progression fields are omitted because several have coupled write rules.", slot + 1),
                checksums: vec![ChecksumDefinition {
                    start: Some(base), length: Some(0x9fe),
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, base + 0x9fe)
                }],
                ..GameDefinition::new(format!("final-fantasy-vi-slot-{}", slot + 1), format!("Final Fantasy VI (SNES Slot {})", slot + 1), "snes".into(), 8192)
            }
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], base: usize) {
        let sum = bytes[base..base + 0x9fe]
            .iter()
            .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
        bytes[base + 0x9fe..base + 0xa00].copy_from_slice(&sum.to_le_bytes());
    }

    #[test]
    fn edits_only_selected_slot_and_repairs_checksum() {
        let handler = schemas().remove(1);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x5a; 8192];
        for slot in 0..3 {
            repair(&mut bytes, slot * SLOT_SIZE);
        }
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0xc60..0xc63].copy_from_slice(&0x345678u32.to_le_bytes()[..3]);
        repair(&mut expected, SLOT_SIZE);
        let result = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "money".into(),
                    value: SaveValue::U32(0x345678),
                }],
                false,
            )
            .unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
        assert!(
            handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "location".into(),
                        value: SaveValue::U32(1),
                    }],
                    false,
                )
                .is_err()
        );
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[SLOT_SIZE + 7] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
