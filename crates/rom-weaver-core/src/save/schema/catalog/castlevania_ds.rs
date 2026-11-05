use super::*;
use sha1::{Digest, Sha1};
use tracing::{debug, trace};

// Layouts, salt offsets, fields, and BIOS CRC16: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/castlevania-dawn-of-sorrow/saveEditor
// The adjacent castlevania-order-of-ecclesia template and src/lib/utils/common/nintendoDs.ts define Ecclesia and the BIOS algorithm (MIT; LICENSE-GAME-TOOLS-COLLECTION).
// Portrait of Ruin layout, save preview copies, and SHA-1 checksums: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/castlevania-portrait-of-ruin/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut games: Vec<_> = (0..2).map(game).collect();
    games.push(portrait_of_ruin());
    build(games, BTreeMap::new(), true)
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

const POR_SIZE: usize = 0x10000;
const POR_SLOTS: usize = 6;
const POR_SLOT_START: usize = 0x3800;
const POR_SLOT_STRIDE: usize = 0x1800;
const POR_SLOT_LENGTH: usize = 0xce9;
const POR_SYSTEM_LENGTH: usize = 0x2dc;
const POR_SYSTEM_DIGEST: usize = 0xe000;
const POR_SLOT_DIGEST: usize = 0xe020;
const POR_SLOT_DIGEST_STRIDE: usize = 0x20;
/// Each slot owns a 0x28-byte save preview record in the system block.
const POR_PREVIEW_STRIDE: usize = 0x28;

/// The game stores the five SHA-1 digest words big-endian, so the digest bytes equal the
/// stored bytes.
fn por_digest(bytes: &[u8], start: usize, length: usize) -> [u8; 20] {
    let digest: [u8; 20] = Sha1::digest(&bytes[start..start + length]).into();
    trace!(start, length, "portrait of ruin sha-1 checksum");
    digest
}

/// The digest variant of upstream's editor, which hashes only the whole 32-bit words of the
/// range and pads after them: the range with its trailing `length % 4` bytes zeroed.
fn por_upstream_digest(bytes: &[u8], start: usize, length: usize) -> [u8; 20] {
    let mut range = bytes[start..start + length].to_vec();
    range[length - length % 4..].fill(0);
    Sha1::digest(&range).into()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PorDigest {
    Plain,
    Upstream,
}

/// The variant that reproduces the stored digest, preferring plain SHA-1 when both match.
fn por_stored_digest(
    bytes: &[u8],
    start: usize,
    length: usize,
    stored: usize,
) -> Option<PorDigest> {
    let stored = &bytes[stored..stored + 20];
    if stored == por_digest(bytes, start, length) {
        Some(PorDigest::Plain)
    } else if stored == por_upstream_digest(bytes, start, length) {
        Some(PorDigest::Upstream)
    } else {
        None
    }
}

fn por_active(bytes: &[u8], slot: usize) -> bool {
    bytes[8 + slot] != 0
}

/// Checks the stored digest against plain SHA-1 or the upstream variant, and rewrites each of
/// its five big-endian words after an edit in the variant the unedited save stored.
fn por_integrity(
    game: &mut GameDefinition,
    when: Option<rules::Condition>,
    start: usize,
    length: usize,
    stored: usize,
) {
    game.runtime.checks.push(rules::Check {
        when: when.clone(),
        assert: rules::Condition::new(move |bytes| {
            let variant = por_stored_digest(bytes, start, length, stored);
            trace!(start, ?variant, "portrait of ruin stored digest variant");
            Ok(variant.is_some())
        }),
        code: "save_checksum".into(),
        message: "a Portrait of Ruin SHA-1 checksum is invalid".into(),
        section_id: None,
        warning: None,
    });
    for word in 0..5 {
        game.runtime.after_edit.push(rules::Store {
            when: when.clone(),
            destination: rules::Scalar {
                offset: stored + word * 4,
                storage: Storage::U32Be,
                mask: None,
            },
            value: rules::ReadValue::with_original(move |original, bytes| {
                let digest = match por_stored_digest(original, start, length, stored) {
                    Some(PorDigest::Upstream) => por_upstream_digest(bytes, start, length),
                    Some(PorDigest::Plain) | None => por_digest(bytes, start, length),
                };
                Ok(i64::from(u32::from_be_bytes(
                    digest[word * 4..word * 4 + 4].try_into().unwrap(),
                )))
            }),
        });
    }
}

fn portrait_of_ruin() -> GameDefinition {
    let mut game = GameDefinition::new(
        "castlevania-portrait-of-ruin".into(),
        "Castlevania: Portrait of Ruin".into(),
        "nintendo-ds".into(),
        POR_SIZE,
    );
    game.description = concat!(
        "Edits gold, difficulty, playtime, and the cleared marker in each initialized slot of a raw 64 KiB Europe/USA/Japan save, ",
        "including the save preview copies. Validates the SHA-1 digests of the system block and every initialized slot, ",
        "then repairs them. Characters, items, map, and mode unlocks are omitted. ",
        "Collection saves, DUC wrappers, and Action Replay headers are unsupported. The container layer preserves a DeSmuME .dsv footer; requires a game-made template."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 0,
        bytes: vec![0x64, 0x75, 0xa3, 0x08],
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok((0..POR_SLOTS).any(|slot| por_active(bytes, slot)))
        }),
        code: "save_empty".into(),
        message: "no Portrait of Ruin slot is initialized".into(),
        section_id: None,
        warning: None,
    });
    por_integrity(&mut game, None, 0, POR_SYSTEM_LENGTH, POR_SYSTEM_DIGEST);
    for slot in 0..POR_SLOTS {
        let active = rules::Condition::new(move |bytes| Ok(por_active(bytes, slot)));
        por_integrity(
            &mut game,
            Some(active.clone()),
            POR_SLOT_START + slot * POR_SLOT_STRIDE,
            POR_SLOT_LENGTH,
            POR_SLOT_DIGEST + slot * POR_SLOT_DIGEST_STRIDE,
        );
        let base = slot * POR_SLOT_STRIDE;
        let preview = slot * POR_PREVIEW_STRIDE;
        let number = slot + 1;
        let behavior = field::FieldBehavior {
            present_when: Some(active.clone()),
            editable_when: Some(active),
            ..Default::default()
        };
        let fields = [
            FieldDefinition::new(
                format!("slot_{number}.gold"),
                format!("Slot {number} gold"),
                0x3fad + base,
                Storage::U32Le,
            )
            .max(99_999_999)
            .copies(vec![0x30 + preview]),
            FieldDefinition::new(
                format!("slot_{number}.difficulty"),
                format!("Slot {number} difficulty"),
                0x3f3a + base,
                Storage::U8,
            )
            .choices(choices(&[("normal", 0), ("hard", 1)]))
            .copies(vec![0x17 + preview]),
            FieldDefinition::new(
                format!("slot_{number}.playtime_frames"),
                format!("Slot {number} playtime frames"),
                0x28 + preview,
                Storage::U32Le,
            )
            .description("The game stores playtime at 60 frames per second.".into()),
            FieldDefinition::new(
                format!("slot_{number}.cleared"),
                format!("Slot {number} progression cleared"),
                0x15 + preview,
                Storage::Bit,
            )
            .bit(0),
        ];
        game.fields.extend(
            fields
                .into_iter()
                .map(|field| field.behavior(behavior.clone())),
        );
    }
    debug!(
        fields = game.fields.len(),
        "built Portrait of Ruin save schema"
    );
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

    fn digest(hex: &str) -> [u8; 20] {
        let mut digest = [0u8; 20];
        for (index, byte) in digest.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap();
        }
        digest
    }

    #[test]
    fn por_digest_matches_sha1_reference_vectors_across_padding_boundaries() {
        // FIPS 180-4 examples, then `bytes(range(n))` digests from Python's hashlib at the
        // lengths where the message padding changes block count.
        let long: Vec<u8> = std::iter::repeat_n(b'a', 1_000_000).collect();
        let cases: [(&[u8], &str); 4] = [
            (b"", "da39a3ee5e6b4b0d3255bfef95601890afd80709"),
            (b"abc", "a9993e364706816aba3e25717850c26c9cd0d89d"),
            (
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
                "84983e441c3bd26ebaae4aa1f95129e5e54670f1",
            ),
            (&long, "34aa973cd4c4daa4f61eeb2bdbad27316534016f"),
        ];
        for (message, expected) in cases {
            assert_eq!(por_digest(message, 0, message.len()), digest(expected));
        }
        for (length, expected) in [
            (55, "8ae2d46729cfe68ff927af5eec9c7d1b66d65ac2"),
            (56, "636e2ec698dac903498e648bd2f3af641d3c88cb"),
            (63, "6d942da0c4392b123528f2905c713a3ce28364bd"),
            (64, "c6138d514ffa2135bfce0ed0b8fac65669917ec7"),
            (65, "69bd728ad6e13cd76ff19751fde427b00e395746"),
        ] {
            let message: Vec<u8> = (0..length as u8).collect();
            assert_eq!(
                por_digest(&message, 0, message.len()),
                digest(expected),
                "length {length}"
            );
        }
    }

    fn por_template() -> Vec<u8> {
        let mut bytes: Vec<u8> = (0..POR_SIZE)
            .map(|index| ((index * 17 + (index >> 8) * 3 + 11) & 0xff) as u8)
            .collect();
        bytes[..4].copy_from_slice(&[0x64, 0x75, 0xa3, 0x08]);
        for slot in 0..POR_SLOTS {
            bytes[8 + slot] = u8::from(slot == 0 || slot == 3);
        }
        bytes
    }

    // SHA-1 digests of the template's system block and slots 1 and 4, before and after the
    // edits below, computed with Python's hashlib.
    const POR_BEFORE: [&str; 3] = [
        "ead9000348ea8e73001f62f7435bd6d88231b968",
        "f1b81b0273f89cbcb15ce312b5d52a17e11e74e1",
        "dc5dd213556d7dee5d8b0ede1347ea03c0d4fc12",
    ];
    const POR_AFTER: [&str; 3] = [
        "adf74750e5e2f1b49ccb119424cb14da26284031",
        "ba1b2535855fe6abdf1976a8a26e375a766ae49c",
        "01f39da618934807f2fb968116a8aa762c43100e",
    ];

    fn set_por_digests(bytes: &mut [u8], digests: [&str; 3]) {
        for (offset, hex) in [
            (POR_SYSTEM_DIGEST, digests[0]),
            (POR_SLOT_DIGEST, digests[1]),
            (POR_SLOT_DIGEST + 3 * POR_SLOT_DIGEST_STRIDE, digests[2]),
        ] {
            bytes[offset..offset + 20].copy_from_slice(&digest(hex));
        }
    }

    fn por_edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    #[test]
    fn portrait_of_ruin_edits_repair_previews_and_sha1_digests() {
        let handler = schemas().remove(2);
        let identity = handler.definitions().remove(0).identity;
        assert_eq!(identity.id, "castlevania-portrait-of-ruin");
        let mut bytes = por_template();
        set_por_digests(&mut bytes, POR_BEFORE);
        assert_eq!(
            por_digest(&bytes, 0, POR_SYSTEM_LENGTH),
            digest(POR_BEFORE[0])
        );
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [
            por_edit("slot_1.gold", SaveValue::U32(99_999_999)),
            por_edit("slot_1.difficulty", SaveValue::Enum("hard".into())),
            por_edit("slot_4.playtime_frames", SaveValue::U32(u32::MAX)),
            por_edit("slot_4.cleared", SaveValue::Bool(true)),
            por_edit("slot_4.difficulty", SaveValue::Enum("normal".into())),
        ];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        let slot_4 = 3 * POR_SLOT_STRIDE;
        expected[0x3fad..0x3fb1].copy_from_slice(&99_999_999u32.to_le_bytes());
        expected[0x30..0x34].copy_from_slice(&99_999_999u32.to_le_bytes());
        expected[0x3f3a] = 1;
        expected[0x17] = 1;
        expected[0x28 + 0x78..0x2c + 0x78].copy_from_slice(&u32::MAX.to_le_bytes());
        expected[0x8d] |= 1;
        expected[0x3f3a + slot_4] = 0;
        expected[0x8f] = 0;
        set_por_digests(&mut expected, POR_AFTER);
        assert_eq!(out, expected);
        // Inactive slot records, including their stale digests, stay byte-identical.
        for slot in [1, 2, 4, 5] {
            let start = POR_SLOT_START + slot * POR_SLOT_STRIDE;
            assert_eq!(
                out[start..start + 0x1800],
                input.bytes[start..start + 0x1800]
            );
            let digest = POR_SLOT_DIGEST + slot * POR_SLOT_DIGEST_STRIDE;
            assert_eq!(
                out[digest..digest + 0x20],
                input.bytes[digest..digest + 0x20]
            );
        }
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
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
    }

    #[test]
    fn portrait_of_ruin_rejects_corrupt_empty_or_out_of_range_input() {
        let handler = schemas().remove(2);
        let identity = handler.definitions().remove(0).identity;
        let edits = [por_edit("slot_1.gold", SaveValue::U32(1))];
        let mut bytes = por_template();
        set_por_digests(&mut bytes, POR_BEFORE);
        let valid = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        assert!(handler.apply(&valid, &identity, &edits, false).is_ok());
        // The system block, the last covered slot byte (it breaks the plain digest stored
        // here, and the upstream variant of the flipped range is not the stored digest
        // either), the digest ends, and slot 4.
        for offset in [
            0x100,
            POR_SYSTEM_LENGTH - 1,
            POR_SYSTEM_DIGEST,
            POR_SYSTEM_DIGEST + 19,
            POR_SLOT_START + POR_SLOT_LENGTH - 1,
            POR_SLOT_DIGEST + 19,
            POR_SLOT_START + 3 * POR_SLOT_STRIDE + 7,
        ] {
            let mut bad = valid.clone();
            bad.bytes[offset] ^= 1;
            assert!(
                handler.apply(&bad, &identity, &edits, false).is_err(),
                "offset {offset:#x}"
            );
        }
        // The first byte after the covered range is outside the digest.
        let mut outside = valid.clone();
        outside.bytes[POR_SLOT_START + POR_SLOT_LENGTH] ^= 1;
        assert!(handler.apply(&outside, &identity, &edits, false).is_ok());
        let blocked = [por_edit("slot_2.gold", SaveValue::U32(1))];
        assert!(handler.apply(&valid, &identity, &blocked, false).is_err());
        let too_much = [por_edit("slot_1.gold", SaveValue::U32(100_000_000))];
        assert!(handler.apply(&valid, &identity, &too_much, false).is_err());
        let mut none = valid.clone();
        none.bytes[8..14].fill(0);
        assert!(handler.apply(&none, &identity, &edits, false).is_err());
        for size in [0, 0x2000, POR_SIZE - 1, POR_SIZE + 1] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..valid.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
    }

    fn por_last_slot_byte(slot: usize) -> usize {
        POR_SLOT_START + slot * POR_SLOT_STRIDE + POR_SLOT_LENGTH - 1
    }

    /// A template whose slots 1 and 4 store the digest variant given for each.
    fn por_variant_input(variants: [PorDigest; 2]) -> (SaveDetectionInput, SaveGameIdentity) {
        let handler = schemas().remove(2);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = por_template();
        for (slot, variant) in [0, 3].into_iter().zip(variants) {
            assert_ne!(bytes[por_last_slot_byte(slot)], 0);
            let start = POR_SLOT_START + slot * POR_SLOT_STRIDE;
            let digest = match variant {
                PorDigest::Plain => por_digest(&bytes, start, POR_SLOT_LENGTH),
                PorDigest::Upstream => {
                    let mut range = bytes[start..start + POR_SLOT_LENGTH].to_vec();
                    *range.last_mut().unwrap() = 0;
                    Sha1::digest(&range).into()
                }
            };
            let stored = POR_SLOT_DIGEST + slot * POR_SLOT_DIGEST_STRIDE;
            bytes[stored..stored + 20].copy_from_slice(&digest);
        }
        let system = por_digest(&bytes, 0, POR_SYSTEM_LENGTH);
        bytes[POR_SYSTEM_DIGEST..POR_SYSTEM_DIGEST + 20].copy_from_slice(&system);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        (input, identity)
    }

    #[test]
    fn portrait_of_ruin_keeps_the_digest_variant_the_template_stored() {
        let handler = schemas().remove(2);
        let edits = [
            por_edit("slot_1.gold", SaveValue::U32(7)),
            por_edit("slot_4.gold", SaveValue::U32(9)),
        ];
        for variants in [
            [PorDigest::Upstream, PorDigest::Upstream],
            [PorDigest::Upstream, PorDigest::Plain],
            [PorDigest::Plain, PorDigest::Upstream],
            [PorDigest::Plain, PorDigest::Plain],
        ] {
            let (input, identity) = por_variant_input(variants);
            let out = handler
                .apply(&input, &identity, &edits, false)
                .unwrap()
                .bytes
                .unwrap();
            for (slot, variant) in [0, 3].into_iter().zip(variants) {
                let start = POR_SLOT_START + slot * POR_SLOT_STRIDE;
                let stored = POR_SLOT_DIGEST + slot * POR_SLOT_DIGEST_STRIDE;
                let plain = por_digest(&out, start, POR_SLOT_LENGTH);
                let upstream = por_upstream_digest(&out, start, POR_SLOT_LENGTH);
                assert_ne!(plain, upstream);
                let expected = match variant {
                    PorDigest::Plain => plain,
                    PorDigest::Upstream => upstream,
                };
                assert_eq!(out[stored..stored + 20], expected, "{variants:?} {slot}");
            }
            // The repaired output is accepted again and a second edit keeps the variant.
            let again = [por_edit("slot_1.gold", SaveValue::U32(8))];
            let next = SaveDetectionInput {
                bytes: out,
                ..input
            };
            let out = handler
                .apply(&next, &identity, &again, false)
                .unwrap()
                .bytes
                .unwrap();
            assert_eq!(
                por_stored_digest(&out, POR_SLOT_START, POR_SLOT_LENGTH, POR_SLOT_DIGEST),
                Some(variants[0])
            );
        }
    }

    #[test]
    fn portrait_of_ruin_upstream_variant_ignores_only_the_trailing_range_bytes() {
        let handler = schemas().remove(2);
        let edits = [por_edit("slot_1.gold", SaveValue::U32(1))];
        let (valid, identity) = por_variant_input([PorDigest::Upstream, PorDigest::Upstream]);
        let mut last = valid.clone();
        last.bytes[por_last_slot_byte(0)] ^= 1;
        assert!(handler.apply(&last, &identity, &edits, false).is_ok());
        let mut before_last = valid.clone();
        before_last.bytes[por_last_slot_byte(0) - 1] ^= 1;
        assert!(
            handler
                .apply(&before_last, &identity, &edits, false)
                .is_err()
        );
        // A plain template rejects the same last-byte flip.
        let (plain, identity) = por_variant_input([PorDigest::Plain, PorDigest::Plain]);
        let mut last = plain;
        last.bytes[por_last_slot_byte(0)] ^= 1;
        assert!(handler.apply(&last, &identity, &edits, false).is_err());
    }
}
