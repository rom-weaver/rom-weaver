use super::*;

// Layout: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/legend-of-zelda-the-oracle-of-ages/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    oracle_schema(
        "zelda-oracle-of-ages",
        "The Legend of Zelda: Oracle of Ages",
        b"Z21216-0",
    )
}

pub(super) fn oracle_schema(id: &str, name: &str, signature: &[u8]) -> Vec<SchemaSaveHandler> {
    let games = (0..3)
        .map(|slot| {
            let mut fields = Vec::new();
            let base = slot * 0x550;
            for (key, label, offset, storage, max) in [
                ("mode", "Mode", 0x72, Storage::U16Le, u16::MAX as i64),
                ("health", "Health quarter-hearts", 0x10a, Storage::U8, 64),
                (
                    "max_health",
                    "Maximum health quarter-hearts",
                    0x10b,
                    Storage::U8,
                    64,
                ),
                ("heart_pieces", "Heart pieces", 0x10c, Storage::U8, 3),
                (
                    "rupees_bcd",
                    "Rupees (packed BCD)",
                    0x10d,
                    Storage::BcdLe,
                    999,
                ),
            ] {
                let mut field =
                    FieldDefinition::new(key.into(), label.into(), base + offset, storage)
                        .min(0)
                        .max(max);
                if key == "rupees_bcd" {
                    field = field.length(2);
                }
                fields.push(field);
            }
            GameDefinition {
                fields,
                description: format!(
                    "Edits core values in slot {}. Select the occupied slot explicitly.",
                    slot + 1
                ),
                signatures: vec![SignatureDefinition {
                    offset: base + 0x12,
                    bytes: signature.to_vec(),
                }],
                checksums: vec![ChecksumDefinition {
                    start: Some(base + 0x12),
                    length: Some(0x54e),
                    unit: ChecksumUnit::U16Le,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, base + 0x10)
                }],
                ..GameDefinition::new(
                    format!("{id}-slot-{}", slot + 1),
                    format!("{name} — Slot {}", slot + 1),
                    "game-boy-color".into(),
                    8192,
                )
            }
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0xa5; 8192];
        for slot in 0..3 {
            let base = slot * 0x550;
            bytes[base + 0x12..base + 0x1a].copy_from_slice(b"Z21216-0");
            bytes[base + 0x10d..base + 0x10f].copy_from_slice(&[0x23, 0x01]);
            let sum = bytes[base + 0x12..base + 0x560]
                .chunks_exact(2)
                .fold(0u16, |sum, pair| {
                    sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
                });
            bytes[base + 0x10..base + 0x12].copy_from_slice(&sum.to_le_bytes());
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some("zelda-oracle-of-ages-slot-1".into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn edits_one_slot_repairs_only_its_checksum_and_rejects_malformed_input() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let input = input();
        let result = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "rupees_bcd".into(),
                    value: SaveValue::U32(321),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&result[0x10d..0x10f], &[0x21, 0x03]);
        assert_eq!(&result[0x550..], &input.bytes[0x550..]);
        let expected = result[0x12..0x560].chunks_exact(2).fold(0u16, |sum, pair| {
            sum.wrapping_add(u16::from_le_bytes([pair[0], pair[1]]))
        });
        assert_eq!(u16::from_le_bytes([result[0x10], result[0x11]]), expected);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[0x12] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        assert!(handler.generate(&identity).is_err());
    }
}
