use super::*;

// Canonical EEPROM fields and block checksums MUST follow the pinned MIT source.
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/bomberman-64/saveEditor
fn checksums(base: usize) -> Vec<ChecksumDefinition> {
    (0..18)
        .map(|index| {
            let (start, length, offset) = match index {
                2 => (0x10, 9, 0x18),
                3 => (0x19, 7, 0x1f),
                _ => (index * 8, 8, index * 8 + 7),
            };
            ChecksumDefinition {
                start: Some(base + start),
                length: Some(length),
                target: Some(255),
                exclude: vec![ChecksumExclusion {
                    offset: base + offset,
                    length: 1,
                }],
                ..ChecksumDefinition::new(ChecksumAlgorithm::Sum8, base + offset)
            }
        })
        .collect()
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3).map(|slot| {
        let base = slot * 0x90;
        GameDefinition {
            fields: vec![
                catalog_field("playtime_seconds", "Playtime in seconds", base + 8, Storage::U32Be),
                catalog_field("hard_mode", "Hard difficulty", base + 0xe, Storage::Bit).bit(7),
                catalog_field("rainbow_palace", "Rainbow Palace unlocked", base + 0x19, Storage::Bit).bit(7),
            ],
            signatures: vec![SignatureDefinition { offset: 0, bytes: b"BAKU".to_vec() }],
            checksums: checksums(base),
            description: "Edits playtime, difficulty and Rainbow Palace in one occupied slot of canonical 512-byte EEPROM. Packed stage times and byte-swapped images are unsupported. Requires a game-made template.".into(),
            runtime: runtime::Runtime { checks: vec![rules::Check {
                when: None, assert: rules::Condition::new(move |bytes| Ok(bytes[base + 0xc] != 0)),
                code: "save_slot_empty".into(), message: "The selected Bomberman 64 slot is empty.".into(),
                section_id: None, warning: None,
            }], save_format: Some("n64_eeprom_512".into()), ..Default::default() },
            ..GameDefinition::new(format!("bomberman-64-canonical-eeprom-slot-{}", slot + 1),
                format!("Bomberman 64 (canonical EEPROM, Slot {})", slot + 1), "nintendo-64".into(), 512)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(slot: usize) -> Vec<u8> {
        let mut bytes = vec![0x25; 512];
        bytes[..4].copy_from_slice(b"BAKU");
        for index in 0..18 {
            let base = slot * 0x90;
            let (start, end, offset) = match index {
                2 => (0x10, 0x18, 0x18),
                3 => (0x19, 0x1f, 0x1f),
                _ => (index * 8, index * 8 + 7, index * 8 + 7),
            };
            let sum = bytes[base + start..base + end]
                .iter()
                .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
            bytes[base + offset] = !sum;
        }
        bytes
    }
    #[test]
    fn each_profile_preserves_other_slots_and_checksums() {
        for (slot, handler) in schemas().into_iter().enumerate() {
            let identity = handler.definitions().remove(0).identity;
            let input = SaveDetectionInput {
                bytes: fixture(slot),
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            let output = handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "playtime_seconds".into(),
                        value: SaveValue::U32(123),
                    }],
                    false,
                )
                .unwrap()
                .bytes
                .unwrap();
            let base = slot * 0x90;
            let mut expected = input.bytes.clone();
            expected[base + 8..base + 12].copy_from_slice(&123u32.to_be_bytes());
            expected[base + 15] = !expected[base + 8..base + 15]
                .iter()
                .fold(0u8, |a, b| a.wrapping_add(*b));
            assert_eq!(output, expected);
            assert!(
                handler
                    .apply(&input, &identity, &[], false)
                    .unwrap()
                    .bytes
                    .is_none()
            );
            for bytes in [vec![0; 512], vec![0; 511], {
                let mut b = input.bytes.clone();
                b[base + 8] ^= 1;
                b
            }] {
                assert!(
                    handler
                        .apply(
                            &SaveDetectionInput {
                                bytes,
                                ..input.clone()
                            },
                            &identity,
                            &[],
                            false
                        )
                        .is_err()
                );
            }
        }
    }
}
