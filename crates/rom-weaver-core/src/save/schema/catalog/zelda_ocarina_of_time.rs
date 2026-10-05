use super::*;

// SRAM recovery and paired writes MUST follow the decompilation at this revision.
// https://github.com/zeldaret/oot/blob/52a510f379afd143aaa0375be9f1e190369572e1/src/code/z_sram.c#L615
// https://github.com/zeldaret/oot/blob/52a510f379afd143aaa0375be9f1e190369572e1/include/save.h#L218
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3).map(|slot| {
        let candidates = [slot, slot + 3].into_iter().map(|record| {
            let base = 0x20 + record * 0x1450;
            layout::Candidate {
                spans: vec![layout::Span { logical_offset: 0, physical_offset: base, length: 0x1354 }],
                signatures: vec![layout::Signature { offset: base + 0x1c, bytes: b"ZELDAZ".to_vec() }],
                checksums: vec![ChecksumDefinition {
                    start: Some(base), length: Some(0x1352), unit: ChecksumUnit::U16Be,
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, base + 0x1352)
                }], ..Default::default()
            }
        }).collect();
        GameDefinition {
            fields: vec![
                FieldDefinition::new("deaths".into(), "Death count".into(), 0x22, Storage::U16Be).max(999),
                FieldDefinition::new("rupees".into(), "Rupees (basic wallet range)".into(), 0x34, Storage::U16Be).max(99),
            ].into_iter().map(|field| field.behavior(field::FieldBehavior { group: Some("file".into()), ..Default::default() })).collect(),
            description: "Edits death count and 0–99 rupees in one occupied file of canonical big-endian 32 KiB N64 SRAM. Uses the primary save or valid backup, and repairs both save copies. Slot padding and other files remain unchanged. GameCube, iQue and byte-swapped saves are unsupported. Requires a game-made template.".into(),
            runtime: runtime::Runtime { logical_size: Some(0x1354),
                layout: Some(layout::Layout { groups: vec![layout::Group {
                    id: "file".into(), logical_offset: 0, logical_length: 0x1354,
                    copies: layout::Copies::Fixed { candidates }, selection: layout::Selection::FirstValid,
                    write: layout::WritePolicy::CloneSelectedToAll, empty: Vec::new(), empty_if_no_signature: false,
                }] }), save_format: Some("n64_sram_32k".into()), ..Default::default()
            },
            ..GameDefinition::new(format!("zelda-ocarina-of-time-canonical-sram-file-{}", slot + 1),
                format!("The Legend of Zelda: Ocarina of Time (canonical SRAM, File {})", slot + 1), "nintendo-64".into(), 32768)
        }
    }).collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(data: &mut [u8]) {
        let sum = data[..0x1352].chunks_exact(2).fold(0u16, |sum, word| {
            sum.wrapping_add(u16::from_be_bytes([word[0], word[1]]))
        });
        data[0x1352..0x1354].copy_from_slice(&sum.to_be_bytes());
    }
    fn input(slot: usize) -> SaveDetectionInput {
        let mut bytes = vec![0x5a; 32768];
        for record in [slot, slot + 3] {
            let base = 0x20 + record * 0x1450;
            let data = &mut bytes[base..base + 0x1354];
            data.fill(0);
            data[0x1c..0x22].copy_from_slice(b"ZELDAZ");
            repair(data);
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some(format!(
                "zelda-ocarina-of-time-canonical-sram-file-{}",
                slot + 1
            )),
            rom_sha1: None,
        }
    }
    #[test]
    fn edits_both_copies_and_recovers_primary_from_backup() {
        for (slot, handler) in schemas().into_iter().enumerate() {
            let identity = handler.definitions().remove(0).identity;
            let original = input(slot);
            let edit = SaveEdit {
                field: "rupees".into(),
                value: SaveValue::U32(99),
            };
            let output = handler
                .apply(&original, &identity, std::slice::from_ref(&edit), false)
                .unwrap()
                .bytes
                .unwrap();
            let mut expected = original.bytes.clone();
            for record in [slot, slot + 3] {
                let base = 0x20 + record * 0x1450;
                let data = &mut expected[base..base + 0x1354];
                data[0x34..0x36].copy_from_slice(&99u16.to_be_bytes());
                repair(data);
            }
            assert_eq!(output, expected);
            assert!(
                handler
                    .apply(&original, &identity, &[], false)
                    .unwrap()
                    .bytes
                    .is_none()
            );
            let mut damaged = original.clone();
            damaged.bytes[0x20 + slot * 0x1450 + 0x70] ^= 1;
            assert_eq!(
                handler
                    .apply(&damaged, &identity, &[edit], false)
                    .unwrap()
                    .bytes
                    .unwrap(),
                expected
            );
            damaged.bytes[0x20 + (slot + 3) * 0x1450 + 0x70] ^= 1;
            assert!(handler.apply(&damaged, &identity, &[], false).is_err());
            for bytes in [vec![0; 32768], vec![0; 32767]] {
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
