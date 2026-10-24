use super::*;

// Record selection and checksum arithmetic MUST follow the pinned MIT source.
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/paper-mario/saveEditor
fn checksums(base: usize) -> Vec<ChecksumDefinition> {
    [
        (ChecksumAlgorithm::Add32Be, 0x30, u32::MAX),
        (ChecksumAlgorithm::Sum32Be, 0x34, 0),
    ]
    .into_iter()
    .map(|(algorithm, offset, target)| ChecksumDefinition {
        start: Some(base),
        length: Some(0x1380),
        unit: ChecksumUnit::U32Be,
        target: Some(target),
        exclude: vec![ChecksumExclusion {
            offset: base + 0x30,
            length: 8,
        }],
        ..ChecksumDefinition::new(algorithm, base + offset)
    })
    .collect()
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..4u32).map(|slot| {
        let candidates = (0..8).map(|record| {
            let base = record * 0x4000;
            layout::Candidate {
                spans: vec![layout::Span { logical_offset: 0, physical_offset: base, length: 0x4000 }],
                signatures: vec![layout::Signature { offset: base, bytes: b"Mario Story 006".to_vec() }],
                checksums: checksums(base),
                predicates: vec![rules::Condition::new(move |bytes| Ok(
                    u32::from_be_bytes(bytes[base + 0x38..base + 0x3c].try_into().unwrap()) == slot &&
                    u32::from_be_bytes(bytes[base + 0x3c..base + 0x40].try_into().unwrap()) > 0 &&
                    bytes[base + 0x80..base + 0x84] != [255; 4] &&
                    !(0..8).any(|other| {
                        let offset = other * 0x4000;
                        u32::from_be_bytes(bytes[offset + 0x38..offset + 0x3c].try_into().unwrap()) == slot &&
                        bytes[offset + 0x80..offset + 0x84] != [255; 4] &&
                        u32::from_be_bytes(bytes[offset + 0x3c..offset + 0x40].try_into().unwrap()) >
                            u32::from_be_bytes(bytes[base + 0x3c..base + 0x40].try_into().unwrap())
                    }))) ],
                counter: Some(rules::Scalar { offset: base + 0x3c, storage: Storage::U32Be, mask: None }),
                ..Default::default()
            }
        }).collect();
        GameDefinition {
            fields: [("coins", "Coins", 0x4c, Storage::U16Be, 999),
                ("star_pieces", "Star Pieces", 0x4f, Storage::U8, 160),
                ("star_points", "Star Points", 0x50, Storage::U8, 99)]
                .into_iter().map(|(id, label, offset, storage, max)| FieldDefinition::new(id.into(), label.into(), offset, storage).max(max)
                    .behavior(field::FieldBehavior { group: Some("file".into()), ..Default::default() })).collect(),
            description: "Edits currency in the newest occupied record for one file in canonical big-endian 128 KiB FlashRAM. Preserves older backups and other files; rejects a damaged newest record. Byte-swapped saves, inventory and linked character statistics are unsupported. Requires a game-made template.".into(),
            runtime: runtime::Runtime {
                logical_size: Some(0x4000),
                layout: Some(layout::Layout { groups: vec![layout::Group {
                    id: "file".into(), logical_offset: 0, logical_length: 0x4000,
                    copies: layout::Copies::Fixed { candidates }, selection: layout::Selection::NewestCounter,
                    write: layout::WritePolicy::Selected, empty: Vec::new(), empty_if_no_signature: false,
                }] }), save_format: Some("n64_flashram_128k".into()), ..Default::default()
            },
            ..GameDefinition::new(format!("paper-mario-canonical-flashram-file-{}", slot + 1),
                format!("Paper Mario (canonical FlashRAM, File {})", slot + 1), "nintendo-64".into(), 0x20000)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(bytes: &mut [u8]) {
        let sum = bytes[..0x1380]
            .chunks_exact(4)
            .enumerate()
            .filter(|(i, _)| ![12, 13].contains(i))
            .fold(u32::MAX, |sum, (_, word)| {
                sum.wrapping_add(u32::from_be_bytes(word.try_into().unwrap()))
            });
        bytes[0x30..0x34].copy_from_slice(&sum.to_be_bytes());
        bytes[0x34..0x38].copy_from_slice(&(!sum).to_be_bytes());
    }
    fn input(slot: usize) -> SaveDetectionInput {
        let mut bytes = vec![255; 0x20000];
        for (record, counter) in [(2, 4u32), (5, 9u32)] {
            let data = &mut bytes[record * 0x4000..(record + 1) * 0x4000];
            data.fill(0);
            data[..15].copy_from_slice(b"Mario Story 006");
            data[0x38..0x3c].copy_from_slice(&(slot as u32).to_be_bytes());
            data[0x3c..0x40].copy_from_slice(&counter.to_be_bytes());
            repair(data);
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some(format!("paper-mario-canonical-flashram-file-{}", slot + 1)),
            rom_sha1: None,
        }
    }
    #[test]
    fn newest_record_only_and_corrupt_newest_rejection() {
        for (slot, handler) in schemas().into_iter().enumerate() {
            let identity = handler.definitions().remove(0).identity;
            let original = input(slot);
            let edit = SaveEdit {
                field: "coins".into(),
                value: SaveValue::U32(999),
            };
            let output = handler
                .apply(&original, &identity, std::slice::from_ref(&edit), false)
                .unwrap()
                .bytes
                .unwrap();
            let mut expected = original.bytes.clone();
            let data = &mut expected[5 * 0x4000..6 * 0x4000];
            data[0x4c..0x4e].copy_from_slice(&999u16.to_be_bytes());
            repair(data);
            assert_eq!(output, expected);
            assert!(
                handler
                    .apply(&original, &identity, &[], false)
                    .unwrap()
                    .bytes
                    .is_none()
            );
            let mut fallback = original.clone();
            fallback.bytes[5 * 0x4000 + 0x90] ^= 1;
            assert!(handler.apply(&fallback, &identity, &[edit], false).is_err());
            for bytes in [vec![0; 0x20000], vec![0; 0x1ffff], {
                let mut b = fallback.bytes.clone();
                b[2 * 0x4000 + 0x90] ^= 1;
                b
            }] {
                assert!(
                    handler
                        .apply(
                            &SaveDetectionInput {
                                bytes,
                                ..original.clone()
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
