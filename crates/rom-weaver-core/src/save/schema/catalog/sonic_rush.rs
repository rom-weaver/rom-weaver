use super::*;

// Layout, counter selection, menu flags, and complemented standard CRC32: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/sonic-rush/saveEditor
// generateCrcCcitt selects the CRC32 table for this u32 field, despite its name (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "sonic-rush".into(),
        "Sonic Rush".into(),
        "nintendo-ds".into(),
        0x2000,
    );
    game.description = "Edits independent Time Attack and Sound Test menu unlocks in raw 8 KiB Europe/USA/Japan saves. Validates the standard CRC32 of the first highest-counter 0x320-byte record and preserves every other record. Progression, story flags, race times, wrappers, and larger padded layouts are omitted; requires a game-made template.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0,
        bytes: b"sonic_rush_".to_vec(),
    }];
    for (bit, id, label) in [
        (0, "time_attack", "Time Attack unlocked"),
        (1, "sound_test", "Sound Test unlocked"),
    ] {
        game.fields.push(
            FieldDefinition::new(format!("unlocks.{id}"), label.into(), 0x15, Storage::Bit)
                .bit(bit)
                .behavior(field::FieldBehavior {
                    group: Some("active_record".into()),
                    ..Default::default()
                }),
        );
    }
    let candidates = (0..10)
        .map(|record| {
            let base = record * 0x320;
            layout::Candidate {
                spans: vec![layout::Span {
                    logical_offset: 0,
                    physical_offset: base,
                    length: 0x320,
                }],
                // Upstream validates the physical file header before selecting its newest record. Both headers MUST survive logical remapping checks.
                signatures: [0, base]
                    .into_iter()
                    .map(|offset| layout::Signature {
                        offset,
                        bytes: b"sonic_rush_".to_vec(),
                    })
                    .collect(),
                predicates: vec![rules::Condition::new(move |bytes| {
                    let count =
                        u32::from_le_bytes(bytes[base + 0x10..base + 0x14].try_into().unwrap());
                    Ok(count > 0
                        && (0..10).all(|other_record| {
                            let other = other_record * 0x320;
                            let other_count = u32::from_le_bytes(
                                bytes[other + 0x10..other + 0x14].try_into().unwrap(),
                            );
                            other_count < count || (other_count == count && other_record >= record)
                        }))
                })],
                ..Default::default()
            }
        })
        .collect();
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "active_record".into(),
            logical_offset: 0,
            logical_length: 0x320,
            copies: layout::Copies::Fixed { candidates },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        }],
    });
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(u32::from_le_bytes(bytes[0xc..0x10].try_into().unwrap())
                == crc32(&bytes[0x10..0x320]))
        }),
        code: "save_checksum".into(),
        message: "the active Sonic Rush record CRC32 is invalid".into(),
        section_id: None,
        warning: None,
    });
    game.runtime.after_edit.push(rules::Store {
        when: None,
        destination: rules::Scalar {
            offset: 0xc,
            storage: Storage::U32Le,
            mask: None,
        },
        value: rules::ReadValue::new(|bytes| Ok(i64::from(crc32(&bytes[0x10..0x320])))),
    });
    build(vec![game], BTreeMap::new(), true)
}

fn crc32(bytes: &[u8]) -> u32 {
    let crc = bytes.iter().fold(u32::MAX, |mut crc, byte| {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ if crc & 1 != 0 { 0xedb88320 } else { 0 };
        }
        crc
    });
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], base: usize) {
        let mut table = [0u32; 256];
        for (index, entry) in table.iter_mut().enumerate() {
            let mut crc = index as u32;
            for _ in 0..8 {
                crc = if crc & 1 == 0 {
                    crc >> 1
                } else {
                    (crc >> 1) ^ 0xedb88320
                };
            }
            *entry = crc;
        }
        let crc = !bytes[base + 0x10..base + 0x320]
            .iter()
            .fold(u32::MAX, |crc, byte| {
                table[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8)
            });
        bytes[base + 0xc..base + 0x10].copy_from_slice(&crc.to_le_bytes());
    }

    #[test]
    fn crc_known_vector_and_active_record_edit_footprint() {
        assert_eq!(crc32(b"123456789"), 0xcbf43926);
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 0x2000];
        for (base, count) in [(0, 1u32), (0x960, 7)] {
            bytes[base..base + 11].copy_from_slice(b"sonic_rush_");
            bytes[base + 0x10..base + 0x14].copy_from_slice(&count.to_le_bytes());
            repair(&mut bytes, base);
        }
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "unlocks.sound_test".into(),
            value: SaveValue::Bool(true),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x975] |= 2;
        repair(&mut expected, 0x960);
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
        for position in [0, 0x960, 0x96c, 0x976] {
            let mut bad = input.clone();
            bad.bytes[position] ^= 1;
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
            assert!(handler.apply(&bad, &identity, &[], false).is_err());
        }
        for size in [0, 0x1fff, 0x2001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        let blank = SaveDetectionInput {
            bytes: vec![0; 0x2000],
            ..input
        };
        assert!(handler.apply(&blank, &identity, &edits, false).is_err());
    }
}
