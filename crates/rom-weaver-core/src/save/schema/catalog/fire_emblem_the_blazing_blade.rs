use super::*;
use tracing::{debug, trace};

const SAVE_SIZE: usize = 0x8000;
const SLOT_COUNT: usize = 3;
const SLOT_START: usize = 0x3f2c;
const SLOT_SIZE: usize = 0xd8c;
const SLOT_MAGIC: u32 = 0x1_1217;
const SYSTEM_END: usize = 0x50;

// Layout, slot validity, and checksums: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/fire-emblem-the-blazing-blade/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(vec![game()], BTreeMap::new(), true)
}

/// Sum and XOR of the little-endian 16-bit words in `start..end`.
fn sum_and_xor(bytes: &[u8], start: usize, end: usize) -> (u16, u16) {
    bytes[start..end]
        .chunks_exact(2)
        .map(|word| u16::from_le_bytes([word[0], word[1]]))
        .fold((0u16, 0u16), |(sum, xor), word| {
            (sum.wrapping_add(word), xor ^ word)
        })
}

fn system_checksum(bytes: &[u8]) -> u16 {
    let (sum, xor) = sum_and_xor(bytes, 0, SYSTEM_END);
    trace!(sum, xor, "fire emblem system checksum");
    sum.wrapping_add(xor)
}

fn slot_checksum(bytes: &[u8], slot: usize) -> u32 {
    let start = SLOT_START + slot * SLOT_SIZE;
    let (sum, xor) = sum_and_xor(bytes, start, start + SLOT_SIZE);
    trace!(slot, sum, xor, "fire emblem slot checksum");
    u32::from(sum) | (u32::from(xor) << 16)
}

fn magic_offset(slot: usize) -> usize {
    0x64 + slot * 0x10
}

fn checksum_offset(slot: usize) -> usize {
    0x70 + slot * 0x10
}

fn slot_valid(bytes: &[u8], slot: usize) -> bool {
    let offset = magic_offset(slot);
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) == SLOT_MAGIC
}

fn game() -> GameDefinition {
    let mut game = GameDefinition::new(
        "fire-emblem-the-blazing-blade".into(),
        "Fire Emblem: The Blazing Blade".into(),
        "gba".into(),
        SAVE_SIZE,
    );
    game.description = concat!(
        "Edits funds, playtime, and difficulty in each valid slot, plus Lyn's Tale clear, of a raw 32 KiB GBA save. ",
        "Validates the system checksum and every valid slot's sum-and-XOR checksum, then repairs them. ",
        "Names, party, items, supports, and Eliwood/Hector tale flags are omitted. ",
        "A suspended chapter keeps its own copy of these values; restart the chapter to see edits. ",
        "SharkPort wrappers are unsupported; requires a game-made template."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 0,
        bytes: b"AGB-FE7".to_vec(),
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok((0..SLOT_COUNT).any(|slot| slot_valid(bytes, slot)))
        }),
        code: "save_empty".into(),
        message: "no Fire Emblem slot is valid".into(),
        section_id: None,
        warning: None,
    });
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(u16::from_le_bytes([bytes[0x60], bytes[0x61]]) == system_checksum(bytes))
        }),
        code: "save_checksum".into(),
        message: "the Fire Emblem system checksum is invalid".into(),
        section_id: None,
        warning: None,
    });
    game.runtime.after_edit.push(rules::Store {
        when: None,
        destination: rules::Scalar {
            offset: 0x60,
            storage: Storage::U16Le,
            mask: None,
        },
        value: rules::ReadValue::new(|bytes| Ok(i64::from(system_checksum(bytes)))),
    });
    game.fields.push(
        catalog_field(
            "system.lyn_tale_cleared",
            "Lyn's Tale cleared",
            0xe,
            Storage::Bit,
        )
        .bit(1),
    );
    for slot in 0..SLOT_COUNT {
        slot_rules(&mut game, slot);
    }
    debug!(fields = game.fields.len(), "built Fire Emblem save schema");
    game
}

fn slot_rules(game: &mut GameDefinition, slot: usize) {
    let valid = rules::Condition::new(move |bytes| Ok(slot_valid(bytes, slot)));
    let offset = checksum_offset(slot);
    game.runtime.checks.push(rules::Check {
        when: Some(valid.clone()),
        assert: rules::Condition::new(move |bytes| {
            Ok(
                u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
                    == slot_checksum(bytes, slot),
            )
        }),
        code: "save_checksum".into(),
        message: "a Fire Emblem slot checksum is invalid".into(),
        section_id: None,
        warning: None,
    });
    game.runtime.after_edit.push(rules::Store {
        when: Some(valid.clone()),
        destination: rules::Scalar {
            offset,
            storage: Storage::U32Le,
            mask: None,
        },
        value: rules::ReadValue::new(move |bytes| Ok(i64::from(slot_checksum(bytes, slot)))),
    });
    let base = SLOT_START + slot * SLOT_SIZE;
    let behavior = field::FieldBehavior {
        present_when: Some(valid.clone()),
        editable_when: Some(valid),
        ..Default::default()
    };
    let number = slot + 1;
    game.fields.extend([
        FieldDefinition::new(
            format!("slot_{number}.funds"),
            format!("Slot {number} funds"),
            base + 8,
            Storage::U32Le,
        )
        .max(999_999)
        .behavior(behavior.clone()),
        FieldDefinition::new(
            format!("slot_{number}.playtime_frames"),
            format!("Slot {number} playtime frames"),
            base,
            Storage::U32Le,
        )
        .description("The game stores playtime at 60 frames per second.".into())
        .behavior(behavior.clone()),
        FieldDefinition::new(
            format!("slot_{number}.hard_mode"),
            format!("Slot {number} hard difficulty"),
            base + 0x14,
            Storage::Bit,
        )
        .bit(6)
        .behavior(behavior),
    ]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template() -> Vec<u8> {
        let mut bytes: Vec<u8> = (0..SAVE_SIZE)
            .map(|index| ((index * 31 + (index >> 8) * 7 + 5) & 0xff) as u8)
            .collect();
        bytes[..8].copy_from_slice(b"AGB-FE7\0");
        for (slot, magic) in [(0, SLOT_MAGIC), (1, 0xffff_ffff), (2, SLOT_MAGIC)] {
            let offset = magic_offset(slot);
            bytes[offset..offset + 4].copy_from_slice(&magic.to_le_bytes());
        }
        bytes
    }

    fn set_checksums(bytes: &mut [u8], (system, slot_1, slot_3): (u16, u32, u32)) {
        bytes[0x60..0x62].copy_from_slice(&system.to_le_bytes());
        bytes[0x70..0x74].copy_from_slice(&slot_1.to_le_bytes());
        bytes[0x90..0x94].copy_from_slice(&slot_3.to_le_bytes());
    }

    // Reference values computed outside Rust from the upstream algorithm over the template above
    // and the edits below: one pass of `sum += word; xor ^= word` over little-endian 16-bit words,
    // system `(sum + xor) & 0xffff`, slots `(sum & 0xffff) | (xor << 16)`.
    const BEFORE: (u16, u32, u32) = (0xb7e2, 0x163a_5a02, 0x12c2_3ce4);
    const AFTER: (u16, u32, u32) = (0xb7de, 0x1a48_0bfe, 0xd080_5136);

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    fn input(bytes: Vec<u8>, identity: &SaveGameIdentity) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        }
    }

    fn valid_template() -> Vec<u8> {
        let mut bytes = template();
        set_checksums(&mut bytes, BEFORE);
        bytes
    }

    #[test]
    fn edits_repair_system_and_slot_checksums_and_preserve_other_bytes() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let bytes = valid_template();
        assert_eq!(system_checksum(&bytes), BEFORE.0);
        assert_eq!(slot_checksum(&bytes, 0), BEFORE.1);
        assert_eq!(slot_checksum(&bytes, 2), BEFORE.2);
        let input = input(bytes, &identity);
        let edits = [
            edit("slot_1.funds", SaveValue::U32(999_999)),
            edit("slot_3.playtime_frames", SaveValue::U32(u32::MAX)),
            edit("slot_3.hard_mode", SaveValue::Bool(false)),
            edit("system.lyn_tale_cleared", SaveValue::Bool(false)),
        ];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[SLOT_START + 8..SLOT_START + 12].copy_from_slice(&999_999u32.to_le_bytes());
        let slot_3 = SLOT_START + 2 * SLOT_SIZE;
        expected[slot_3..slot_3 + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        expected[slot_3 + 0x14] &= !0x40;
        expected[0xe] &= !2;
        set_checksums(&mut expected, AFTER);
        assert_eq!(out, expected);
        assert_eq!(system_checksum(&out), AFTER.0);
        assert_eq!(slot_checksum(&out, 0), AFTER.1);
        assert_eq!(slot_checksum(&out, 2), AFTER.2);
        let invalid_slot = SLOT_START + SLOT_SIZE..SLOT_START + 2 * SLOT_SIZE;
        assert_eq!(input.bytes[invalid_slot.clone()], out[invalid_slot]);
        assert_eq!(
            handler.apply(&input, &identity, &[], false).unwrap().bytes,
            None
        );
        let noop = SaveDetectionInput {
            bytes: out,
            ..input
        };
        assert!(
            handler
                .apply(&noop, &identity, &edits, false)
                .unwrap()
                .bytes
                .is_none()
        );
    }

    #[test]
    fn corrupt_unselectable_or_out_of_range_input_is_rejected() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let edits = [edit("slot_1.funds", SaveValue::U32(1))];
        let valid = input(valid_template(), &identity);
        assert!(handler.apply(&valid, &identity, &edits, false).is_ok());
        // Offsets in the system block, each valid slot, and each checksum field.
        for offset in [
            0x12,
            0x60,
            0x70,
            0x90,
            SLOT_START + 0x40,
            SLOT_START + 2 * SLOT_SIZE + 9,
        ] {
            let mut bad = valid.clone();
            // A single-bit flip can leave sum plus XOR unchanged, so invert the byte.
            bad.bytes[offset] ^= 0xff;
            assert!(
                handler.apply(&bad, &identity, &edits, false).is_err(),
                "offset {offset:#x}"
            );
        }
        // An invalid slot is neither validated nor editable.
        let mut junk = valid.clone();
        junk.bytes[SLOT_START + SLOT_SIZE + 5] ^= 0xff;
        assert!(handler.apply(&junk, &identity, &edits, false).is_ok());
        let invalid = [edit("slot_2.funds", SaveValue::U32(1))];
        assert!(handler.apply(&junk, &identity, &invalid, false).is_err());
        let too_high = [edit("slot_1.funds", SaveValue::U32(1_000_000))];
        assert!(handler.apply(&valid, &identity, &too_high, false).is_err());
        let mut none = valid.clone();
        for slot in 0..SLOT_COUNT {
            let offset = magic_offset(slot);
            none.bytes[offset..offset + 4].fill(0xff);
        }
        let system = system_checksum(&none.bytes);
        none.bytes[0x60..0x62].copy_from_slice(&system.to_le_bytes());
        assert!(handler.apply(&none, &identity, &edits, false).is_err());
        for size in [0, SAVE_SIZE - 1, SAVE_SIZE + 1] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..valid.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
    }
}
