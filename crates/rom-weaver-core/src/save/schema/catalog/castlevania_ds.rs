use super::*;

// Layouts, salt offsets, fields, and BIOS CRC16: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/castlevania-dawn-of-sorrow/saveEditor
// The adjacent castlevania-order-of-ecclesia template and src/lib/utils/common/nintendoDs.ts define Ecclesia and the BIOS algorithm (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build((0..2).map(game).collect(), BTreeMap::new(), true)
}

fn game(version: usize) -> GameDefinition {
    let (id, name) = if version == 0 {
        ("castlevania-dawn-of-sorrow", "Castlevania: Dawn of Sorrow")
    } else {
        (
            "castlevania-order-of-ecclesia",
            "Castlevania: Order of Ecclesia",
        )
    };
    let mut game = GameDefinition::new(id.into(), name.into(), "nintendo-ds".into(), 0x2000);
    game.description = if version == 0 {
        "Edits gold with its system preview and independent bonus-mode flags in initialized raw 8 KiB Europe/USA/Japan saves. Validates the salted BIOS CRC16 of the system and every initialized file. Collection saves, wrappers, and larger padded layouts are unsupported; requires a game-made template."
    } else {
        "Edits gold in initialized raw 8 KiB Europe/USA/Japan/Korea saves. Validates all three system salted BIOS CRC16 checksums and every initialized file, then repairs file CRCs before the dependent system CRC. Collection saves, wrappers, bonus-mode transitions, and larger padded layouts are unsupported; requires a game-made template."
    }.into();
    game.signatures = vec![if version == 0 {
        SignatureDefinition {
            offset: 0,
            bytes: vec![0xdf, 0xc0, 0xad, 0xde, 2],
        }
    } else {
        SignatureDefinition {
            offset: 4,
            bytes: b"JP KONAMI CV".to_vec(),
        }
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(move |bytes| {
            Ok((0..3).any(|slot| active(bytes, version, slot)))
        }),
        code: "save_empty".into(),
        message: "no DS Castlevania file is initialized".into(),
        section_id: None,
        warning: None,
    });
    for slot in 0..3 {
        let initialized = rules::Condition::new(move |bytes| Ok(active(bytes, version, slot)));
        let (start, end, checksum, salt, gold) = if version == 0 {
            (
                0x100 + slot * 0x540,
                0x5c4 + slot * 0x540,
                0x82 + slot * 2,
                0x94 + slot * 4,
                0x5a4 + slot * 0x540,
            )
        } else {
            (
                0x1e8 + slot * 0x690,
                0x878 + slot * 0x690,
                0x1d2 + slot * 4,
                0x1d0 + slot * 4,
                0x3b4 + slot * 0x690,
            )
        };
        integrity(
            &mut game,
            start,
            end,
            checksum,
            salt,
            Some(initialized.clone()),
        );
        let mut gold_field = FieldDefinition::new(
            format!("slot_{}.gold", slot + 1),
            format!("Slot {} gold", slot + 1),
            gold,
            Storage::U32Le,
        )
        .max(9999999)
        .behavior(field::FieldBehavior {
            present_when: Some(initialized.clone()),
            editable_when: Some(initialized),
            ..Default::default()
        });
        if version == 0 {
            gold_field = gold_field.copies(vec![0x48 + slot * 4]);
        }
        game.fields.push(gold_field);
    }
    if version == 0 {
        for (bit, id, label) in [
            (0, "boss_rush", "Boss Rush"),
            (1, "sound_mode", "Sound Mode"),
            (2, "julius_mode", "Julius Mode"),
        ] {
            game.fields.push(
                FieldDefinition::new(
                    format!("unlocks.{id}"),
                    format!("{label} unlocked"),
                    0x6a,
                    Storage::Bit,
                )
                .bit(bit),
            );
        }
        integrity(&mut game, 0, 0x70, 0x80, 0x90, None);
    } else {
        for (start, end, checksum, salt) in [
            (0, 0x10, 0x1c6, 0x1c4),
            (0x10, 0x1c4, 0x1ca, 0x1c8),
            (0x1c4, 0x1e8, 0x1ce, 0x1cc),
        ] {
            integrity(&mut game, start, end, checksum, salt, None);
        }
    }
    game
}

fn active(bytes: &[u8], version: usize, slot: usize) -> bool {
    if version == 0 {
        bytes[0x12c + slot * 0x540] != 0
    } else {
        bytes[0x10] & (1 << slot) != 0
    }
}

fn bios_crc(bytes: &[u8], start: usize, end: usize, checksum: usize, salt: usize) -> u16 {
    let mut crc = u16::from_le_bytes(bytes[salt..salt + 2].try_into().unwrap());
    for (offset, byte) in bytes.iter().enumerate().take(end).skip(start) {
        crc ^= if offset == checksum || offset == checksum + 1 {
            0
        } else {
            u16::from(*byte)
        };
        for _ in 0..8 {
            crc = (crc >> 1) ^ if crc & 1 != 0 { 0xa001 } else { 0 };
        }
    }
    crc
}

fn integrity(
    game: &mut GameDefinition,
    start: usize,
    end: usize,
    checksum: usize,
    salt: usize,
    when: Option<rules::Condition>,
) {
    game.runtime.checks.push(rules::Check {
        when: when.clone(),
        assert: rules::Condition::new(move |bytes| {
            Ok(
                u16::from_le_bytes(bytes[checksum..checksum + 2].try_into().unwrap())
                    == bios_crc(bytes, start, end, checksum, salt),
            )
        }),
        code: "save_checksum".into(),
        message: "a DS Castlevania salted BIOS CRC16 is invalid".into(),
        section_id: None,
        warning: None,
    });
    game.runtime.after_edit.push(rules::Store {
        when,
        destination: rules::Scalar {
            offset: checksum,
            storage: Storage::U16Le,
            mask: None,
        },
        value: rules::ReadValue::new(move |bytes| {
            Ok(i64::from(bios_crc(bytes, start, end, checksum, salt)))
        }),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], start: usize, end: usize, checksum: usize, salt: usize) {
        let table = [
            0x0000u16, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00,
            0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
        ];
        bytes[checksum..checksum + 2].fill(0);
        let mut crc = u16::from_le_bytes(bytes[salt..salt + 2].try_into().unwrap());
        for word in bytes[start..end].chunks_exact(2) {
            let value = u16::from_le_bytes(word.try_into().unwrap());
            for nibble in 0..4 {
                crc = (crc >> 4)
                    ^ table[(crc & 15) as usize]
                    ^ table[((value >> (nibble * 4)) & 15) as usize];
            }
        }
        bytes[checksum..checksum + 2].copy_from_slice(&crc.to_le_bytes());
    }

    #[test]
    fn salted_file_crc_and_dependent_system_crc_exact_footprints() {
        for version in 0..2 {
            let handler = schemas().remove(version);
            let identity = handler.definitions().remove(0).identity;
            let mut bytes = vec![0; 0x2000];
            let (start, end, checksum, salt, gold) = if version == 0 {
                bytes[..5].copy_from_slice(&[0xdf, 0xc0, 0xad, 0xde, 2]);
                bytes[0x12c] = 1;
                bytes[0x90..0x92].copy_from_slice(&0x1234u16.to_le_bytes());
                (0x100, 0x5c4, 0x82, 0x94, 0x5a4)
            } else {
                bytes[4..16].copy_from_slice(b"JP KONAMI CV");
                bytes[0x10] = 1;
                for offset in [0x1c4, 0x1c8, 0x1cc] {
                    bytes[offset..offset + 2].copy_from_slice(&0x1234u16.to_le_bytes());
                }
                (0x1e8, 0x878, 0x1d2, 0x1d0, 0x3b4)
            };
            bytes[salt..salt + 2].copy_from_slice(&0xabcd_u16.to_le_bytes());
            repair(&mut bytes, start, end, checksum, salt);
            let globals: Vec<_> = if version == 0 {
                vec![(0, 0x70, 0x80, 0x90)]
            } else {
                vec![
                    (0, 0x10, 0x1c6, 0x1c4),
                    (0x10, 0x1c4, 0x1ca, 0x1c8),
                    (0x1c4, 0x1e8, 0x1ce, 0x1cc),
                ]
            };
            for &(a, b, c, d) in &globals {
                repair(&mut bytes, a, b, c, d);
            }
            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(identity.id.clone()),
                rom_sha1: None,
            };
            let edits = [SaveEdit {
                field: "slot_1.gold".into(),
                value: SaveValue::U32(7654321),
            }];
            let out = handler
                .apply(&input, &identity, &edits, false)
                .unwrap()
                .bytes
                .unwrap();
            let mut expected = input.bytes.clone();
            expected[gold..gold + 4].copy_from_slice(&7654321u32.to_le_bytes());
            if version == 0 {
                expected[0x48..0x4c].copy_from_slice(&7654321u32.to_le_bytes());
            }
            repair(&mut expected, start, end, checksum, salt);
            for &(a, b, c, d) in &globals {
                repair(&mut expected, a, b, c, d);
            }
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
            for offset in [checksum, salt, globals[0].2, gold] {
                let mut bad = input.clone();
                bad.bytes[offset] ^= 1;
                assert!(handler.apply(&bad, &identity, &edits, false).is_err());
            }
            for size in [0, 0x1fff, 0x2001] {
                let bad = SaveDetectionInput {
                    bytes: vec![0; size],
                    ..input.clone()
                };
                assert!(handler.apply(&bad, &identity, &edits, false).is_err());
            }
            let mut empty = input;
            if version == 0 {
                empty.bytes[0x12c] = 0;
            } else {
                empty.bytes[0x10] = 0;
            }
            assert!(handler.apply(&empty, &identity, &edits, false).is_err());
        }
    }
}
