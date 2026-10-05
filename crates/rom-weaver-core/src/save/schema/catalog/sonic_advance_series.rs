use super::*;

// Layouts, selection, fields, and word sums: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/sonic-advance-2/saveEditor
// Sonic Advance and Sonic Advance 3 use the adjacent sonic-advance and sonic-advance-3 templates at that same revision (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build((1..=3).map(game).collect(), BTreeMap::new(), true)
}

fn game(version: usize) -> GameDefinition {
    let (magic, end, records) = match version {
        1 => (b"PIRO", 0x42c, 10),
        2 => (b"MGGE", 0x374, 10),
        _ => (b"LNTG", 0x368, 16),
    };
    let mut fields = Vec::new();
    if version == 1 || version == 3 {
        let offset = if version == 1 { 0x1d } else { 0x3c };
        for (bit, color) in ["red", "blue", "yellow", "green", "white", "cyan", "purple"]
            .into_iter()
            .enumerate()
        {
            fields.push(
                FieldDefinition::new(
                    format!("chaos_emeralds.{color}"),
                    format!("{color} Chaos Emerald"),
                    offset,
                    Storage::Bit,
                )
                .bit(bit as u8),
            );
        }
    }
    let unlocks: &[(usize, u8, &str)] = match version {
        1 => &[],
        2 => &[
            (0x1b, 0, "cream"),
            (0x1b, 1, "tails"),
            (0x1b, 2, "knuckles"),
            (0x1b, 3, "amy"),
            (0x1b, 6, "tiny_chao_garden"),
            (0x1b, 5, "sound_test"),
            (0x1b, 4, "time_attack_boss"),
        ],
        _ => &[
            (0x19, 0, "sonic"),
            (0x19, 2, "tails"),
            (0x19, 3, "knuckles"),
            (0x19, 1, "cream"),
            (0x19, 4, "amy"),
            (0x3d, 0, "sound_test"),
            (0x3d, 1, "time_attack_boss"),
            (0x3d, 2, "secret_hint"),
        ],
    };
    for &(offset, bit, id) in unlocks {
        fields.push(
            FieldDefinition::new(
                format!("unlocks.{id}"),
                format!("{id} unlocked"),
                offset,
                Storage::Bit,
            )
            .bit(bit),
        );
    }
    for field in &mut fields {
        field.behavior.group = Some("active_record".into());
    }
    let candidates = (0..records)
        .map(|record| {
            let base = record * 0x1000;
            let checksum = ChecksumDefinition {
                start: Some(base),
                length: Some(end),
                unit: ChecksumUnit::U32Le,
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add32Le, base + end)
            };
            // The game chooses its record before validating integrity. A corrupt newest record MUST NOT silently fall back to a stale one.
            let selected = rules::Condition::new(move |bytes| {
                if version == 1 {
                    return Ok((0..=record)
                        .all(|index| &bytes[index * 0x1000..index * 0x1000 + 4] == magic)
                        && (record + 1 == records
                            || &bytes[(record + 1) * 0x1000..(record + 1) * 0x1000 + 4] != magic));
                }
                let count = u32::from_le_bytes(bytes[base + 4..base + 8].try_into().unwrap());
                Ok(count > 0
                    && (0..records).all(|index| {
                        let other = index * 0x1000;
                        if &bytes[other..other + 4] != magic {
                            return true;
                        }
                        let other_count =
                            u32::from_le_bytes(bytes[other + 4..other + 8].try_into().unwrap());
                        other_count < count || (other_count == count && index >= record)
                    }))
            });
            layout::Candidate {
                spans: vec![layout::Span {
                    logical_offset: 0,
                    physical_offset: base,
                    length: end + 4,
                }],
                signatures: vec![layout::Signature {
                    offset: base,
                    bytes: magic.to_vec(),
                }],
                predicates: vec![selected],
                checksums: vec![checksum.clone()],
                repairs: vec![layout::Repair::Checksum { checksum }],
                ..Default::default()
            }
        })
        .collect();
    let id = if version == 1 {
        "sonic-advance".into()
    } else {
        format!("sonic-advance-{version}")
    };
    let name = if version == 1 {
        "Sonic Advance".into()
    } else {
        format!("Sonic Advance {version}")
    };
    let mut game = GameDefinition { fields, description: "Edits independent character/menu unlocks and documented independent Chaos Emerald flags in a raw 64 KiB save. Only the game-selected record changes; older records, counters, progression, race results, and Chao data are preserved. Requires a game-made template.".into(), ..GameDefinition::new(id, name, "game-boy-advance".into(), 0x10000) };
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "active_record".into(),
            logical_offset: 0,
            logical_length: end + 4,
            copies: layout::Copies::Fixed { candidates },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        }],
    });
    game
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(bytes: &mut [u8], base: usize, magic: &[u8], end: usize, counter: u32) {
        bytes[base..base + 4].copy_from_slice(magic);
        bytes[base + 4..base + 8].copy_from_slice(&counter.to_le_bytes());
        let mut checksum = 0u32;
        for offset in (base..base + end).step_by(4) {
            checksum = checksum.wrapping_add(u32::from_le_bytes(
                bytes[offset..offset + 4].try_into().unwrap(),
            ));
        }
        bytes[base + end..base + end + 4].copy_from_slice(&checksum.to_le_bytes());
    }

    #[test]
    fn selected_record_only_and_independent_word_sum() {
        for (version, magic, end, field, offset, bit) in [
            (1, b"PIRO", 0x42c, "chaos_emeralds.red", 0x1d, 0),
            (2, b"MGGE", 0x374, "unlocks.sound_test", 0x1b, 5),
            (3, b"LNTG", 0x368, "unlocks.sound_test", 0x3d, 0),
        ] {
            let handler = schemas().remove(version - 1);
            let identity = handler.definitions().remove(0).identity;
            let mut bytes = vec![0xff; 0x10000];
            bytes[..0x2000].fill(0);
            record(&mut bytes, 0, magic, end, 2);
            record(&mut bytes, 0x1000, magic, end, 9);
            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            let edits = [SaveEdit {
                field: field.into(),
                value: SaveValue::Bool(true),
            }];
            let out = handler
                .apply(&input, &identity, &edits, false)
                .unwrap()
                .bytes
                .unwrap();
            let mut expected = input.bytes.clone();
            expected[0x1000 + offset] |= 1 << bit;
            record(&mut expected, 0x1000, magic, end, 9);
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
            let mut corrupt = input.clone();
            corrupt.bytes[0x1000 + end] ^= 1;
            assert!(handler.apply(&corrupt, &identity, &edits, false).is_err());
            for size in [0, 0x8000, 0xffff, 0x10001] {
                let invalid = SaveDetectionInput {
                    bytes: vec![0; size],
                    ..input.clone()
                };
                assert!(handler.apply(&invalid, &identity, &edits, false).is_err());
            }
            let blank = SaveDetectionInput {
                bytes: vec![0; 0x10000],
                ..input
            };
            assert!(handler.apply(&blank, &identity, &edits, false).is_err());
        }
    }
}
