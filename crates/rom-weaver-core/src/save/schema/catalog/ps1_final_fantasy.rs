use super::playstation_card::{self, BLOCK_SIZE};
use super::*;
use rules::{Check, Condition, ReadValue, Scalar, Store};

// CRC ranges and preview writes MUST follow the pinned PS1 layouts, excluding PC ports.
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/final-fantasy-vii/saveEditor
// https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/final-fantasy-viii/saveEditor
// FF8 MUST retain its noncanonical final lookup entry, independently checked in Hyne.
// https://github.com/myst6re/hyne/blob/54cc50dc133897b9db45f9deab5167e9d14de0fc/src/SaveData.cpp#L555
fn crc(bytes: &[u8], eight: bool) -> u16 {
    let mut value = 0xffffu16;
    for byte in bytes {
        if eight && (value >> 8) ^ u16::from(*byte) == 0xff {
            value <<= 8;
            continue;
        }
        value ^= u16::from(*byte) << 8;
        for _ in 0..8 {
            value = (value << 1) ^ if value & 0x8000 != 0 { 0x1021 } else { 0 };
        }
    }
    !value
}

fn integrity(
    game: &mut GameDefinition,
    base: usize,
    start: usize,
    end: usize,
    offsets: &[usize],
    eight: bool,
) {
    let offsets = offsets.to_vec();
    let checked_offsets = offsets.clone();
    let check = Check {
        when: None,
        assert: Condition::new(move |bytes| {
            let expected = crc(&bytes[base + start..base + end], eight).to_le_bytes();
            let level = bytes[base + if eight { 0x194 } else { 0x204 }];
            Ok((1..=99).contains(&level)
                && checked_offsets
                    .iter()
                    .all(|offset| bytes[base + offset..base + offset + 2] == expected))
        }),
        code: "final_fantasy_crc".into(),
        message: "selected Final Fantasy block checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    game.runtime.checks.push(check.clone());
    game.runtime
        .recognition
        .as_mut()
        .unwrap()
        .checks
        .push(check);
    for offset in offsets {
        game.runtime.after_edit.push(Store {
            when: None,
            destination: Scalar {
                offset: base + offset,
                storage: Storage::U16Le,
                mask: None,
            },
            value: ReadValue::new(move |bytes| {
                Ok(i64::from(crc(&bytes[base + start..base + end], eight)))
            }),
        });
    }
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games = Vec::new();
    for block in 1..=15 {
        let base = block * BLOCK_SIZE;
        for (region, product) in [
            ("europe", "SCES-00867"),
            ("usa", "SCUS-94163"),
            ("japan", "SLPS-00700"),
            ("japan-international", "SLPS-01057"),
            ("france", "SCES-00868"),
            ("germany", "SCES-00869"),
            ("spain", "SCES-00900"),
        ] {
            let fields = vec![
                catalog_field("gil", "Gil", base + 0xd7c, Storage::U32Le)
                    .min(0)
                    .max(9999999)
                    .copies(vec![base + 0x220]),
                catalog_field("gp", "GP", base + 0xeee, Storage::U16Le)
                    .min(0)
                    .max(10000),
            ];
            let mut game = playstation_card::definition(
                "final-fantasy-vii",
                "Final Fantasy VII",
                region,
                product,
                block,
                fields,
            );
            integrity(&mut game, base, 0x204, 0x12f4, &[0x200], false);
            games.push(game);
        }
        for (region, product) in [
            ("europe-australia", "SLESP02080"),
            ("usa", "SLUSP00892"),
            ("japan", "SLPSP01880"),
            ("france", "SLESP02081"),
            ("germany", "SLESP02082"),
            ("italy", "SLESP02083"),
            ("spain", "SLESP02084"),
        ] {
            let fields = vec![
                catalog_field("squall.gil", "Squall gil", base + 0xc8c, Storage::U32Le)
                    .min(0)
                    .max(99999999),
                catalog_field("laguna.gil", "Laguna gil", base + 0xc90, Storage::U32Le)
                    .min(0)
                    .max(99999999),
            ];
            let mut game = playstation_card::definition(
                "final-fantasy-viii",
                "Final Fantasy VIII",
                region,
                product,
                block,
                fields,
            );
            for (index, offset) in [0xc8c, 0xc90].into_iter().enumerate() {
                game.runtime.after_edit.push(Store {
                    when: Some(Condition::new(move |bytes| {
                        Ok(usize::from(bytes[base + 0xea2] & 1) == index)
                    })),
                    destination: Scalar {
                        offset: base + 0x18c,
                        storage: Storage::U32Le,
                        mask: None,
                    },
                    value: ReadValue::new(move |bytes| {
                        read_at(bytes, (base + offset) as i64, Storage::U32Le)
                    }),
                });
            }
            integrity(&mut game, base, 0x1d0, 0x1520, &[0x180, 0x1520], true);
            games.push(game);
        }
    }
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_has_the_independent_standard_check_value() {
        assert_eq!(crc(b"123456789", false), 0xd64e);
        assert_eq!(crc(&[0], true), 0x00ff);
        assert_eq!(crc(&[0], false), 0x1e0f);
    }

    fn fixture(product: &str, block: usize, eight: bool) -> Vec<u8> {
        let mut bytes = playstation_card::fixture(product, block);
        let base = block * BLOCK_SIZE;
        let (start, end, offsets) = if eight {
            (0x1d0, 0x1520, vec![0x180, 0x1520])
        } else {
            (0x204, 0x12f4, vec![0x200])
        };
        bytes[base + 0x200] = 0;
        bytes[base + 0x204] = 1;
        if eight {
            bytes[base + 0x194] = 1;
        }
        let expected = crc(&bytes[base + start..base + end], eight);
        for offset in offsets {
            bytes[base + offset..base + offset + 2].copy_from_slice(&expected.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn edits_repair_crcs_and_preserve_the_rest_of_the_card() {
        for (id, product, eight, field, offset, checksum_offsets, preview) in [
            (
                "final-fantasy-vii-usa-block-2",
                "SCUS-94163",
                false,
                "gil",
                0xd7c,
                vec![0x200],
                true,
            ),
            (
                "final-fantasy-viii-usa-block-2",
                "SLUSP00892",
                true,
                "squall.gil",
                0xc8c,
                vec![0x180, 0x1520],
                true,
            ),
            (
                "final-fantasy-viii-japan-block-2",
                "SLPSP01880",
                true,
                "laguna.gil",
                0xc90,
                vec![0x180, 0x1520],
                false,
            ),
        ] {
            let handler = schemas()
                .into_iter()
                .find(|handler| handler.definitions()[0].identity.id == id)
                .unwrap();
            let identity = handler.definitions()[0].identity.clone();
            let input = SaveDetectionInput {
                bytes: fixture(product, 2, eight),
                selected_game: Some(id.into()),
                rom_sha1: None,
            };
            let edit = SaveEdit {
                field: field.into(),
                value: SaveValue::U32(123456),
            };
            let output = handler
                .apply(&input, &identity, std::slice::from_ref(&edit), false)
                .unwrap()
                .bytes
                .unwrap();
            let base = 2 * BLOCK_SIZE;
            let preview_offset = if eight { 0x18c } else { 0x220 };
            assert_eq!(
                &output[base + offset..base + offset + 4],
                &123456u32.to_le_bytes()
            );
            if preview {
                assert_eq!(
                    &output[base + preview_offset..base + preview_offset + 4],
                    &123456u32.to_le_bytes()
                );
            }
            for (index, (&after, &before)) in output.iter().zip(&input.bytes).enumerate() {
                if !(base + offset..base + offset + 4).contains(&index)
                    && !(preview
                        && (base + preview_offset..base + preview_offset + 4).contains(&index))
                    && !checksum_offsets
                        .iter()
                        .any(|checksum| (base + checksum..base + checksum + 2).contains(&index))
                {
                    assert_eq!(after, before, "{id} at {index:x}");
                }
            }
            // CRCs MUST match independent Python binascii (VII) and Hyne-table (VIII) fixtures.
            let expected = if !eight {
                0xb64du16
            } else if preview {
                0x6023
            } else {
                0x28a8
            };
            for checksum in checksum_offsets {
                assert_eq!(
                    &output[base + checksum..base + checksum + 2],
                    &expected.to_le_bytes()
                );
            }
            let edited = SaveDetectionInput {
                bytes: output.clone(),
                ..input.clone()
            };
            assert_eq!(
                handler
                    .apply(&edited, &identity, &[edit], false)
                    .unwrap()
                    .bytes
                    .unwrap_or_else(|| edited.bytes.clone()),
                output
            );
            let mut damaged = input.clone();
            damaged.bytes[base + 0x300] ^= 1;
            assert!(handler.apply(&damaged, &identity, &[], false).is_err());
            let mut empty = input.clone();
            empty.bytes[base + if eight { 0x194 } else { 0x204 }] = 0;
            let (start, end, offsets) = if eight {
                (0x1d0, 0x1520, vec![0x180, 0x1520])
            } else {
                (0x204, 0x12f4, vec![0x200])
            };
            let checksum = crc(&empty.bytes[base + start..base + end], eight);
            for offset in offsets {
                empty.bytes[base + offset..base + offset + 2]
                    .copy_from_slice(&checksum.to_le_bytes());
            }
            assert!(handler.apply(&empty, &identity, &[], false).is_err());
            if eight {
                let mut mismatched = input.clone();
                mismatched.bytes[base + 0x1520] ^= 1;
                assert!(handler.apply(&mismatched, &identity, &[], false).is_err());
            }
            assert!(
                handler
                    .apply(
                        &input,
                        &identity,
                        &[SaveEdit {
                            field: field.into(),
                            value: SaveValue::U32(100_000_000)
                        }],
                        false
                    )
                    .is_err()
            );
            let mut short = input;
            short.bytes.pop();
            assert!(handler.apply(&short, &identity, &[], false).is_err());
        }
    }
}
