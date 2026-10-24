use super::*;

// Eight-byte physical reversal, initialized-file markers, field, and weighted checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/legend-of-zelda-the-the-minish-cap/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "zelda-the-minish-cap".into(),
        "The Legend of Zelda: The Minish Cap".into(),
        "game-boy-advance".into(),
        0x2000,
    );
    game.description = "Edits Mysterious Shell quantities in initialized files of raw 8 KiB Europe/USA/Japan EEPROM saves whose eight-byte words are reversed. Validates each initialized file's weighted checksum and preserves empty files and unknown bytes. Other byte orders, wrappers, regional quest flags, and fresh generation are unsupported.".into();
    let mut physical_signature = b"AGBZELDA:THE MINISH CAP:".to_vec();
    for word in physical_signature.chunks_exact_mut(8) {
        word.reverse();
    }
    let candidate = layout::Candidate {
        spans: (0..0xf80)
            .map(|offset| layout::Span {
                logical_offset: offset,
                physical_offset: (offset & !7) + 7 - (offset & 7),
                length: 1,
            })
            .collect(),
        signatures: vec![layout::Signature {
            offset: 0,
            bytes: physical_signature,
        }],
        ..Default::default()
    };
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "eeprom_words".into(),
            logical_offset: 0,
            logical_length: 0xf80,
            copies: layout::Copies::Fixed {
                candidates: vec![candidate],
            },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        }],
    });
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(&bytes[..29] == b"AGBZELDA:THE MINISH CAP:ZELDA"
                && (0..3).any(|slot| initialized(bytes, slot)))
        }),
        code: "save_signature".into(),
        message: "the Minish Cap header or initialized-file markers are unsupported".into(),
        section_id: None,
        warning: None,
    });
    for slot in 0..3 {
        let active = rules::Condition::new(move |bytes| Ok(initialized(bytes, slot)));
        game.runtime.checks.push(rules::Check {
            when: Some(active.clone()),
            assert: rules::Condition::new(move |bytes| {
                let offset = 0x30 + slot * 0x10;
                Ok(
                    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
                        == weighted_sum(bytes, slot),
                )
            }),
            code: "save_checksum".into(),
            message: "a Minish Cap file weighted checksum is invalid".into(),
            section_id: None,
            warning: None,
        });
        game.runtime.after_edit.push(rules::Store {
            when: Some(active.clone()),
            destination: rules::Scalar {
                offset: 0x30 + slot * 0x10,
                storage: Storage::U32Le,
                mask: None,
            },
            value: rules::ReadValue::new(move |bytes| Ok(i64::from(weighted_sum(bytes, slot)))),
        });
        game.fields.push(
            FieldDefinition::new(
                format!("slot_{}.mysterious_shells", slot + 1),
                format!("Slot {} Mysterious Shells", slot + 1),
                0x142 + slot * 0x500,
                Storage::U16Le,
            )
            .max(999)
            .behavior(field::FieldBehavior {
                group: Some("eeprom_words".into()),
                present_when: Some(active.clone()),
                editable_when: Some(active),
                ..Default::default()
            }),
        );
    }
    build(vec![game], BTreeMap::new(), true)
}

fn initialized(bytes: &[u8], slot: usize) -> bool {
    &bytes[0x34 + slot * 0x10..0x38 + slot * 0x10] == b"3ZCM"
}

fn weighted_sum(bytes: &[u8], slot: usize) -> u32 {
    let start = 0x80 + slot * 0x500;
    let sum = (0..0x500).step_by(2).fold(0xa778u32, |sum, relative| {
        sum.wrapping_add(
            u32::from(u16::from_le_bytes(
                bytes[start + relative..start + relative + 2]
                    .try_into()
                    .unwrap(),
            )) ^ (0x500 - relative) as u32,
        )
    });
    (sum.wrapping_neg() << 16) | (sum & 0xffff)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reverse(bytes: &mut [u8]) {
        for word in bytes.chunks_exact_mut(8) {
            word.reverse();
        }
    }
    fn repair(bytes: &mut [u8], slot: usize) {
        let mut sum = 0xa778u32;
        for (index, word) in bytes[0x80 + slot * 0x500..0x580 + slot * 0x500]
            .chunks_exact(2)
            .enumerate()
        {
            sum += u32::from(
                u16::from_le_bytes(word.try_into().unwrap()) ^ (0x500 - index * 2) as u16,
            );
        }
        let checksum = ((0u32.wrapping_sub(sum) & 0xffff) << 16) | (sum & 0xffff);
        bytes[0x30 + slot * 0x10..0x34 + slot * 0x10].copy_from_slice(&checksum.to_le_bytes());
    }

    #[test]
    fn physical_word_reversal_and_weighted_checksum_footprint() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut logical = vec![0; 0x2000];
        logical[..29].copy_from_slice(b"AGBZELDA:THE MINISH CAP:ZELDA");
        logical[0x44..0x48].copy_from_slice(b"3ZCM");
        repair(&mut logical, 1);
        let mut bytes = logical.clone();
        reverse(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "slot_2.mysterious_shells".into(),
            value: SaveValue::U32(987),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        logical[0x642..0x644].copy_from_slice(&987u16.to_le_bytes());
        repair(&mut logical, 1);
        reverse(&mut logical);
        assert_eq!(out, logical);
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
        for position in [7, 0x47, 0x607] {
            let mut bad = input.clone();
            bad.bytes[position] ^= 1;
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        for size in [0, 0x1fff, 0x2001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        let wrong_order = {
            let mut bytes = input.bytes.clone();
            reverse(&mut bytes);
            SaveDetectionInput {
                bytes,
                ..input.clone()
            }
        };
        assert!(
            handler
                .apply(&wrong_order, &identity, &edits, false)
                .is_err()
        );
        let mut empty = input;
        empty.bytes[0x40..0x48].fill(0);
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
    }
}
