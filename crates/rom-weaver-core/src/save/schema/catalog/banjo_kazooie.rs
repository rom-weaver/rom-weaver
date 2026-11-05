use super::rare_eeprom;
use super::*;

// Record tags MUST follow this pinned MIT-licensed source; the checksum hash is `rare_eeprom`'s.
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/banjo-kazooie/saveEditor

// Banjo-Kazooie stores the two Rare words folded into one.
fn checksum(data: &[u8]) -> u32 {
    let [forward, reverse] = rare_eeprom::checksum(data);
    forward ^ reverse
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = [1u8, 3, 2].into_iter().enumerate().map(|(slot, tag)| {
        // The game maps each file to the first record whose checksum and magic pass, so a damaged earlier copy never blocks a later one:
        // https://gitlab.com/banjo.decomp/banjo-kazooie/-/blob/e8d31fa53645616fcac6e051543222b973a2edb0/src/core2/code_B5E00.c#L34-71
        let owns = move |bytes: &[u8], record: usize| {
            let base = record * 0x78;
            bytes[base + 1] == tag && ![0, 255].contains(&bytes[base]) &&
                checksum(&bytes[base..base + 0x74]) == u32::from_be_bytes(bytes[base + 0x74..base + 0x78].try_into().unwrap())
        };
        let candidates = (0..4).map(|record| tagged_record_candidate(record * 0x78, 0x78, record, owns, |_| true)).collect();
        GameDefinition {
            fields: [("eggs", "Eggs", 0x66, 100), ("red_feathers", "Red feathers", 0x67, 50), ("gold_feathers", "Gold feathers", 0x68, 10)]
                .into_iter().map(|(id, label, offset, max)| FieldDefinition::new(id.into(), label.into(), offset, Storage::U8).max(max)
                    .behavior(field::FieldBehavior { group: Some("file".into()), ..Default::default() })).collect(),
            description: "Edits consumables within their basic capacities in one occupied file of canonical 512-byte EEPROM. Selects the first record tagged for the file that passes its checks, as the game does, and rejects the file when none does; preserves all other records and Stop 'n' Swop data. Capacity upgrades, packed collectibles and byte-swapped images are unsupported. Requires a game-made template.".into(),
            runtime: runtime::Runtime { logical_size: Some(0x78),
                layout: Some(single_file_layout(0x78, candidates)), after_edit: vec![rules::Store { when: None,
                    destination: rules::Scalar { offset: 0x74, storage: Storage::U32Be, mask: None },
                    value: rules::ReadValue::new(|bytes| Ok(i64::from(checksum(&bytes[..0x74]))))
                }], save_format: Some("n64_eeprom_512".into()), ..Default::default()
            },
            ..GameDefinition::new(format!("banjo-kazooie-canonical-eeprom-file-{}", slot + 1),
                format!("Banjo-Kazooie (canonical EEPROM, File {})", slot + 1), "nintendo-64".into(), 512)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tagged_record_edit_matches_independent_hash_vectors() {
        // Vectors MUST remain independent of the production checksum routine.
        // They were calculated with Python integers masked to 64 bits at each Long shift.
        for (slot, (handler, (tag, before, after))) in schemas()
            .into_iter()
            .zip([
                (1, 0x47f51d61u32, 0xe3db61ceu32),
                (3, 0xe306d79a, 0xf39f6f26),
                (2, 0x4f3b7637, 0xef275836),
            ])
            .enumerate()
        {
            let identity = handler.definitions().remove(0).identity;
            let base = (3 - slot) * 0x78;
            let mut bytes = vec![255; 512];
            bytes[base..base + 0x74].fill(0x25);
            bytes[base + 1] = tag;
            bytes[base + 0x74..base + 0x78].copy_from_slice(&before.to_be_bytes());
            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            let edit = SaveEdit {
                field: "eggs".into(),
                value: SaveValue::U32(100),
            };
            let output = handler
                .apply(&input, &identity, std::slice::from_ref(&edit), false)
                .unwrap()
                .bytes
                .unwrap();
            let mut expected = input.bytes.clone();
            expected[base + 0x66] = 100;
            expected[base + 0x74..base + 0x78].copy_from_slice(&after.to_be_bytes());
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
                b[base + 0x70] ^= 1;
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
            // The game skips an earlier record that fails its checks and loads the first valid one.
            let mut damaged_earlier = input.clone();
            damaged_earlier.bytes[1] = tag;
            let output = handler
                .apply(
                    &damaged_earlier,
                    &identity,
                    std::slice::from_ref(&edit),
                    false,
                )
                .unwrap()
                .bytes
                .unwrap();
            expected[1] = tag;
            assert_eq!(output, expected);
            let mut copies = input.clone();
            copies.bytes.copy_within(base..base + 0x78, 0);
            let output = handler
                .apply(&copies, &identity, &[edit], false)
                .unwrap()
                .bytes
                .unwrap();
            assert_eq!(output[0x66], 100);
            assert_eq!(output[0x78..], copies.bytes[0x78..]);
        }
    }
}
