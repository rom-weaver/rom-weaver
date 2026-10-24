use super::*;

// Layout, section selector, file ordering, and byte sums: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/kurukuru-kururin/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "kurukuru-kururin".into(),
        "Kuru Kuru Kururin".into(),
        "game-boy-advance".into(),
        0x8000,
    );
    game.description = "Edits rank, difficulty, Last Land and Challenge Level 11 unlock flags in initialized files of raw 32 KiB Europe/Japan saves. Validates both section byte sums and writes only the section chosen by the stored 0/1 selector. Names, level status, cosmetics, records, and wrappers are omitted; requires a game-made template.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0,
        bytes: b"KURURIN 1.01".to_vec(),
    }];
    let checksums: Vec<_> = [(0x18, 0x226b, 0x12), (0x226c, 0x44c0, 0x14)]
        .into_iter()
        .map(|(start, end, offset)| ChecksumDefinition {
            start: Some(start),
            length: Some(end - start),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, offset)
        })
        .collect();
    let candidates = (0..2)
        .map(|section| layout::Candidate {
            spans: vec![layout::Span {
                logical_offset: 0x18,
                physical_offset: 0x18 + section * 0x2254,
                length: 0x2254,
            }],
            predicates: vec![rules::Condition::new(move |bytes| {
                Ok(usize::from(bytes[0x10]) == section
                    && (0..5).any(|file| bytes[0x1a + section * 0x2254 + file * 0x1f4] != 0))
            })],
            checksums: checksums.clone(),
            repairs: vec![layout::Repair::Checksum {
                checksum: checksums[section].clone(),
            }],
            ..Default::default()
        })
        .collect();
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "active_section".into(),
            logical_offset: 0x18,
            logical_length: 0x2254,
            copies: layout::Copies::Fixed { candidates },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        }],
    });
    for slot in 0..5 {
        let physical = if slot < 4 { slot + 1 } else { 0 };
        let base = physical * 0x1f4;
        let active = rules::Condition::new(move |bytes| Ok(bytes[base + 0x1a] != 0));
        let behavior = field::FieldBehavior {
            group: Some("active_section".into()),
            present_when: Some(active.clone()),
            editable_when: Some(active),
            ..Default::default()
        };
        game.fields.push(
            FieldDefinition::new(
                format!("slot_{}.rank", slot + 1),
                format!(
                    "Slot {} rank (0: none, 1: teacher, 2: professor, 3: master)",
                    slot + 1
                ),
                base + 0x25,
                Storage::U8,
            )
            .max(3)
            .behavior(behavior.clone()),
        );
        for (bit, id, label) in [
            (4, "difficulty", "Hard difficulty"),
            (1, "last_land", "Last Land unlocked"),
            (2, "challenge_level_11", "Challenge Level 11 unlocked"),
        ] {
            game.fields.push(
                FieldDefinition::new(
                    format!("slot_{}.{id}", slot + 1),
                    format!("Slot {} {label}", slot + 1),
                    base + 0x28,
                    Storage::Bit,
                )
                .bit(bit)
                .behavior(behavior.clone()),
            );
        }
    }
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], section: usize) {
        let (start, end, offset) = if section == 0 {
            (0x18, 0x226b, 0x12)
        } else {
            (0x226c, 0x44c0, 0x14)
        };
        let sum = bytes[start..end]
            .iter()
            .fold(0u32, |sum, byte| sum + u32::from(*byte)) as u16;
        bytes[offset..offset + 2].copy_from_slice(&sum.to_le_bytes());
    }

    #[test]
    fn both_sections_checked_only_selected_section_changes() {
        for section in 0..2 {
            let handler = schemas().remove(0);
            let identity = handler.definitions().remove(0).identity;
            let mut bytes = vec![0; 0x8000];
            bytes[..12].copy_from_slice(b"KURURIN 1.01");
            bytes[0x10] = section as u8;
            bytes[0x1a + section * 0x2254 + 0x1f4] = b'A';
            repair(&mut bytes, 0);
            repair(&mut bytes, 1);
            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            let edits = [SaveEdit {
                field: "slot_1.last_land".into(),
                value: SaveValue::Bool(true),
            }];
            let out = handler
                .apply(&input, &identity, &edits, false)
                .unwrap()
                .bytes
                .unwrap();
            let mut expected = input.bytes.clone();
            expected[0x21c + section * 0x2254] |= 2;
            repair(&mut expected, section);
            assert_eq!(out, expected);
            assert!(
                handler
                    .apply(&input, &identity, &[], false)
                    .unwrap()
                    .bytes
                    .is_none()
            );
            let noop = SaveDetectionInput {
                bytes: out,
                ..input.clone()
            };
            assert!(
                handler
                    .apply(&noop, &identity, &edits, false)
                    .unwrap()
                    .bytes
                    .is_none()
            );
            for offset in [0, 0x12, 0x14] {
                let mut bad = input.clone();
                bad.bytes[offset] ^= 1;
                assert!(handler.apply(&bad, &identity, &edits, false).is_err());
            }
            let mut invalid_selector = input.clone();
            invalid_selector.bytes[0x10] = 2;
            assert!(
                handler
                    .apply(&invalid_selector, &identity, &edits, false)
                    .is_err()
            );
            for size in [0, 0x7fff, 0x8001] {
                let bad = SaveDetectionInput {
                    bytes: vec![0; size],
                    ..input.clone()
                };
                assert!(handler.apply(&bad, &identity, &edits, false).is_err());
            }
            let mut empty = input;
            empty.bytes[0x1a + section * 0x2254 + 0x1f4] = 0;
            repair(&mut empty.bytes, section);
            assert!(handler.apply(&empty, &identity, &edits, false).is_err());
        }
    }
}
