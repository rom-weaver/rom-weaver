use super::*;

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/legend-of-zelda-the-oracle-of-seasons/saveEditor
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/legend-of-zelda-the-oracle-of-seasons/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    super::zelda_oracle_of_ages::oracle_schema(
        "zelda-oracle-of-seasons",
        "The Legend of Zelda: Oracle of Seasons",
        b"Z11216-0",
        super::zelda_oracle_of_ages::Game::Seasons,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seasons_signature_is_distinct_and_required() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 8192];
        for slot in 0..3 {
            let base = slot * 0x550;
            bytes[base + 0x12..base + 0x1a].copy_from_slice(b"Z11216-0");
            let sum = bytes[base + 0x12..base + 0x560]
                .chunks_exact(2)
                .fold(0u16, |sum, pair| {
                    sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
                });
            bytes[base + 0x10..base + 0x12].copy_from_slice(&sum.to_le_bytes());
        }
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut ages = input.clone();
        ages.bytes[0x12..0x1a].copy_from_slice(b"Z21216-0");
        assert!(handler.apply(&ages, &identity, &[], false).is_err());
    }

    #[test]
    fn seasons_values_use_the_seasons_offsets_not_the_ages_ones() {
        use super::super::zelda_oracle_of_ages::tests::{edit_slot, seal, slot_save};
        let handlers = schemas();
        let bytes = slot_save(b"Z11216-0");
        for slot in 0..3 {
            let base = slot * 0x550;
            let out = edit_slot(
                &handlers,
                &bytes,
                slot,
                &[
                    ("health", SaveValue::U32(12)),
                    ("max_health", SaveValue::U32(20)),
                    ("heart_pieces", SaveValue::U32(3)),
                    ("rupees_bcd", SaveValue::U32(999)),
                    ("ore_chunks", SaveValue::U32(500)),
                    ("sword_level", SaveValue::U32(3)),
                    ("boomerang_level", SaveValue::U32(2)),
                    ("season", SaveValue::U32(2)),
                    ("essence.fertile_soil", SaveValue::Bool(true)),
                    ("key_item.master_s_plaque", SaveValue::Bool(true)),
                    ("gale_warp.tarm_ruins_170", SaveValue::Bool(true)),
                    ("dungeon.11.small_keys", SaveValue::U32(5)),
                    ("dungeon.00.map", SaveValue::Bool(true)),
                ],
            )
            .unwrap();
            let mut expected = bytes.clone();
            for (offset, value) in [
                (0x102, 12),
                (0x103, 20),
                (0x104, 3),
                (0x105, 0x99),
                (0x106, 0x09),
                (0x107, 0x00),
                (0x108, 0x05),
                (0x10c, 3),
                (0x111, 2),
                (0x8d, 2),
                (0x11b, 0x01),
                (0xfc, 0x10),
                (0x170, 0x10),
                (0xd9, 5),
                (0xde, 0x01),
            ] {
                expected[base + offset] = value;
            }
            seal(&mut expected, slot);
            assert_eq!(out, expected, "slot {slot}");
        }
    }
}
