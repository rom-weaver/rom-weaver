use super::*;

// Layout, record selection, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/advance-wars/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "advance-wars".into(),
        "Advance Wars".into(),
        "game-boy-advance".into(),
        0x10000,
    );
    game.description = "Edits points and coins in raw 64 KiB Europe/USA/Japan saves. Selects the first highest-counter system record with type 0x0518 and validates its sum/complement checksum before writing. Preserves every other record and the counter. Campaign state, names, and wrappers are omitted; requires a game-made template.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0xf000,
        bytes: b"wars".to_vec(),
    }];
    game.fields = vec![
        catalog_field("points", "Points", 0x386, Storage::U32Le).max(9999),
        catalog_field("coins", "Coins", 0x382, Storage::U16Le).max(999),
    ];
    for field in &mut game.fields {
        field.behavior.group = Some("system_record".into());
    }
    let candidates = (0..16)
        .map(|record| {
            let base = record * 0x1000;
            let mut checksums = Vec::new();
            for (algorithm, offset, target) in [
                (ChecksumAlgorithm::Add8, base + 6, 0xff),
                (ChecksumAlgorithm::Sum8, base + 7, 0),
            ] {
                checksums.push(ChecksumDefinition {
                    start: Some(base),
                    length: Some(0x1000),
                    target: Some(target),
                    exclude: vec![ChecksumExclusion {
                        offset: base + 6,
                        length: 2,
                    }],
                    ..ChecksumDefinition::new(algorithm, offset)
                });
            }
            layout::Candidate {
                spans: vec![layout::Span {
                    logical_offset: 0,
                    physical_offset: base,
                    length: 0x1000,
                }],
                signatures: vec![layout::Signature {
                    offset: base + 0x50,
                    bytes: vec![0x18, 5],
                }],
                predicates: vec![rules::Condition::new(move |bytes| {
                    let count = u32::from_le_bytes(bytes[base + 8..base + 12].try_into().unwrap());
                    Ok((0..16).all(|other_record| {
                        let other = other_record * 0x1000;
                        if bytes[other + 0x50..other + 0x52] != [0x18, 5] {
                            return true;
                        }
                        let other_count =
                            u32::from_le_bytes(bytes[other + 8..other + 12].try_into().unwrap());
                        other_count < count || (other_count == count && other_record >= record)
                    }))
                })],
                repairs: checksums
                    .iter()
                    .cloned()
                    .map(|checksum| layout::Repair::Checksum { checksum })
                    .collect(),
                checksums,
                ..Default::default()
            }
        })
        .collect();
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "system_record".into(),
            logical_offset: 0,
            logical_length: 0x1000,
            copies: layout::Copies::Fixed { candidates },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        }],
    });
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], base: usize) {
        bytes[base + 6..base + 8].fill(0);
        let sum = bytes[base..base + 0x1000]
            .iter()
            .fold(0xffu32, |sum, byte| sum + u32::from(*byte));
        bytes[base + 6] = sum as u8;
        bytes[base + 7] = !(sum as u8);
    }

    #[test]
    fn newest_system_record_exact_checksum_bytes_and_no_fallback() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0xff; 0x10000];
        bytes[0xf000..0xf004].copy_from_slice(b"wars");
        for (base, counter) in [(0, 3u32), (0x4000, 9)] {
            bytes[base..base + 0x1000].fill(0);
            bytes[base + 0x50..base + 0x52].copy_from_slice(&[0x18, 5]);
            bytes[base + 8..base + 12].copy_from_slice(&counter.to_le_bytes());
            repair(&mut bytes, base);
        }
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "points".into(),
            value: SaveValue::U32(4321),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x4386..0x438a].copy_from_slice(&4321u32.to_le_bytes());
        repair(&mut expected, 0x4000);
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
        corrupt.bytes[0x4006] ^= 1;
        assert!(handler.apply(&corrupt, &identity, &edits, false).is_err());
        for size in [0, 0xffff, 0x10001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        let mut empty = input;
        empty.bytes[..0xf000].fill(0xff);
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
    }
}
