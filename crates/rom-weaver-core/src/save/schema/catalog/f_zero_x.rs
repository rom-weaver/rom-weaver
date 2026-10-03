use super::*;

fn has_signature(bytes: &[u8], swapped: bool) -> bool {
    b"F-ZERO X".iter().enumerate().all(|(offset, expected)| {
        bytes.get(if swapped { offset ^ 3 } else { offset }) == Some(expected)
    })
}

fn candidate(start: usize, length: usize, swapped: bool) -> layout::Candidate {
    layout::Candidate {
        spans: (start..start + length)
            .map(|offset| layout::Span {
                logical_offset: offset,
                physical_offset: if swapped { offset ^ 3 } else { offset },
                length: 1,
            })
            .collect(),
        predicates: vec![rules::Condition::new(move |bytes| {
            Ok(has_signature(bytes, swapped))
        })],
        ..Default::default()
    }
}

fn group(id: &str, start: usize, length: usize) -> layout::Group {
    layout::Group {
        id: id.into(),
        logical_offset: start,
        logical_length: length,
        copies: layout::Copies::Fixed {
            candidates: vec![
                candidate(start, length, true),
                candidate(start, length, false),
            ],
        },
        selection: layout::Selection::FirstValid,
        write: layout::WritePolicy::Selected,
        empty: Vec::new(),
        empty_if_no_signature: false,
    }
}

// Layout and checksum rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/f-zero-x/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let fields = [
        ("jack_cup", "Jack Cup progression", 0xa),
        ("queen_cup", "Queen Cup progression", 0xb),
        ("king_cup", "King Cup progression", 0xc),
        ("joker_cup", "Joker Cup progression", 0xd),
    ]
    .into_iter()
    .map(|(id, label, offset)| {
        FieldDefinition::new(id.into(), label.into(), offset, Storage::U8)
            .max(4)
            .behavior(field::FieldBehavior {
                group: Some("header".into()),
                ..Default::default()
            })
    })
    .chain(std::iter::once(
        FieldDefinition::new(
            "death_race_time".into(),
            "Death Race time".into(),
            0x14,
            Storage::U32Be,
        )
        .behavior(field::FieldBehavior {
            group: Some("header".into()),
            ..Default::default()
        }),
    ))
    .collect();
    let ranges = [
        (0, 0xe, 0xe),
        (0x7f82, 0x7e, 0x7f80),
        (0x22, 0x10e, 0x20),
        (0x10, 0x10, 0x10),
        (0x7382, 0x7e, 0x7380),
    ];
    let checksums = ranges
        .into_iter()
        .map(|(start, length, offset)| ChecksumDefinition {
            start: Some(start),
            length: Some(length),
            exclude: if offset == 0x10 {
                vec![ChecksumExclusion { offset, length: 2 }]
            } else {
                Vec::new()
            },
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, offset)
        })
        .collect();
    let game = GameDefinition {
        fields,
        description: "Edits Grand Prix progression and the Death Race record in native word-swapped or normalized 32 KiB SRAM. Requires a game-made template.".into(),
        signatures: vec![SignatureDefinition { offset: 0, bytes: b"F-ZERO X".to_vec() }],
        checksums,
        runtime: runtime::Runtime { require_selection: true, layout: Some(layout::Layout { groups: vec![group("header", 0, 0x130), group("speed_ratios", 0x7380, 0x80), group("cups", 0x7f80, 0x80)] }), save_format: Some("n64_sram_32k".into()), save_format_name: Some("Nintendo 64 SRAM 32 KiB".into()), ..Default::default() },
        ..GameDefinition::new("f-zero-x".into(), "F-Zero X".into(), "nintendo-64".into(), 32768)
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(bytes: &mut [u8]) {
        for (start, length, offset) in [
            (0, 0xe, 0xe),
            (0x7f82, 0x7e, 0x7f80),
            (0x22, 0x10e, 0x20),
            (0x10, 0x10, 0x10),
            (0x7382, 0x7e, 0x7380),
        ] {
            if offset == 0x10 {
                bytes[0x10..0x12].fill(0);
            }
            let sum = bytes[start..start + length]
                .iter()
                .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
            bytes[offset..offset + 2].copy_from_slice(&sum.to_be_bytes());
        }
    }
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x5a; 32768];
        bytes[..8].copy_from_slice(b"F-ZERO X");
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("f-zero-x".into()),
            rom_sha1: None,
        }
    }
    fn swap_words(bytes: &[u8]) -> Vec<u8> {
        bytes
            .chunks_exact(4)
            .flat_map(|word| word.iter().rev().copied())
            .collect()
    }
    #[test]
    fn edit_repairs_checksum_and_rejects_bad_signature() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "jack_cup".into(),
                    value: SaveValue::U32(4),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[0xa], 4);
        assert_ne!(&bytes[0xe..0x10], &original.bytes[0xe..0x10]);
        assert_eq!(&bytes[0x130..0x7380], &original.bytes[0x130..0x7380]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[0] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    #[test]
    fn edits_word_swapped_sram_without_changing_its_byte_order() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let normalized = input();
        let physical = SaveDetectionInput {
            bytes: swap_words(&normalized.bytes),
            ..normalized
        };
        let bytes = handler
            .apply(
                &physical,
                &identity,
                &[SaveEdit {
                    field: "jack_cup".into(),
                    value: SaveValue::U32(4),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&bytes[..8], b"EZ-FX OR");
        assert_eq!(bytes[0xa ^ 3], 4);
        let normalized_output = swap_words(&bytes);
        assert_eq!(
            u16::from_be_bytes([normalized_output[0xe], normalized_output[0xf]]),
            normalized_output[..0xe]
                .iter()
                .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)))
        );
    }
}
