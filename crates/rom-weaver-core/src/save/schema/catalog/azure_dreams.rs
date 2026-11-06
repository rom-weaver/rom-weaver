use super::*;
use tracing::{debug, trace};

const SAVE_SIZE: usize = 0x2000;
const SLOT_COUNT: usize = 2;
const SLOT_SIZE: usize = 0x1000;
const DATA_START: usize = 0x10;
const CHECKSUM_OFFSET: usize = 0xf0e;
const EMPTY_CHECKSUM: u16 = 0xffff;
const SYSTEM_CHECKSUM: usize = 0x1ffe;
const SYSTEM_BYTE: usize = 0xffe;
/// The save preview block repeats these live values at a fixed distance below each one.
const PREVIEW_PLAYTIME: usize = 0x73;
const PREVIEW_ADVENTURES: usize = 0x83;
const PREVIEW_FUNDS: usize = 0x8d;

// Layout, save preview copies, and checksums: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/azure-dreams/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(vec![game()], BTreeMap::new(), true)
}

fn checksum_at(slot: usize) -> usize {
    slot * SLOT_SIZE + CHECKSUM_OFFSET
}

/// The complement of the byte sum of a slot's data, truncated to 16 bits.
fn slot_checksum(bytes: &[u8], slot: usize) -> u16 {
    let start = slot * SLOT_SIZE + DATA_START;
    let sum = bytes[start..checksum_at(slot)]
        .iter()
        .fold(0u32, |sum, byte| sum.wrapping_add(u32::from(*byte)));
    trace!(slot, sum, "azure dreams slot checksum");
    !sum as u16
}

fn stored_checksum(bytes: &[u8], slot: usize) -> u16 {
    let offset = checksum_at(slot);
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

/// The game marks an unused slot with an all-ones checksum.
fn slot_active(bytes: &[u8], slot: usize) -> bool {
    stored_checksum(bytes, slot) != EMPTY_CHECKSUM
}

fn game() -> GameDefinition {
    let mut game = GameDefinition::new(
        "azure-dreams".into(),
        "Azure Dreams".into(),
        "game-boy-color".into(),
        SAVE_SIZE,
    );
    game.description = concat!(
        "Edits playtime, adventure count, and funds in each initialized slot of a raw 8 KiB Game Boy Color save, ",
        "including the save preview copies. Validates the system and slot checksums, then repairs the slot checksum. ",
        "Monsters, items, floor, and names are omitted. Europe/USA/Japan layout; requires a game-made template."
    )
    .into();
    game.signatures = vec![SignatureDefinition {
        offset: 0x1ff0,
        bytes: b"AzureDreamsGB ".to_vec(),
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok((0..SLOT_COUNT).any(|slot| slot_active(bytes, slot)))
        }),
        code: "save_empty".into(),
        message: "no Azure Dreams slot is initialized".into(),
        section_id: None,
        warning: None,
    });
    // The system checksum covers a single slot identifier byte that no editable field touches.
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok(
                u16::from_le_bytes([bytes[SYSTEM_CHECKSUM], bytes[SYSTEM_CHECKSUM + 1]])
                    == !u16::from(bytes[SYSTEM_BYTE]),
            )
        }),
        code: "save_checksum".into(),
        message: "the Azure Dreams system checksum is invalid".into(),
        section_id: None,
        warning: None,
    });
    for slot in 0..SLOT_COUNT {
        slot_rules(&mut game, slot);
    }
    debug!(fields = game.fields.len(), "built Azure Dreams save schema");
    game
}

fn slot_rules(game: &mut GameDefinition, slot: usize) {
    let active = rules::Condition::new(move |bytes| Ok(slot_active(bytes, slot)));
    game.runtime.checks.push(rules::Check {
        when: Some(active.clone()),
        assert: rules::Condition::new(move |bytes| {
            Ok(stored_checksum(bytes, slot) == slot_checksum(bytes, slot))
        }),
        code: "save_checksum".into(),
        message: "an Azure Dreams slot checksum is invalid".into(),
        section_id: None,
        warning: None,
    });
    game.runtime.after_edit.push(rules::Store {
        when: Some(active.clone()),
        destination: rules::Scalar {
            offset: checksum_at(slot),
            storage: Storage::U16Le,
            mask: None,
        },
        value: rules::ReadValue::new(move |bytes| Ok(i64::from(slot_checksum(bytes, slot)))),
    });
    let base = slot * SLOT_SIZE;
    let behavior = field::FieldBehavior {
        present_when: Some(active.clone()),
        editable_when: Some(active),
        ..Default::default()
    };
    let number = slot + 1;
    let hours = base + 0x93;
    let minutes = base + 0x92;
    let seconds = base + 0x91;
    let adventures = base + 0x9c;
    let funds = base + 0xa8;
    let fields = [
        FieldDefinition::new(
            format!("slot_{number}.playtime_hours"),
            format!("Slot {number} playtime hours"),
            hours,
            Storage::U16Le,
        )
        .max(999)
        .copies(vec![hours - PREVIEW_PLAYTIME]),
        FieldDefinition::new(
            format!("slot_{number}.playtime_minutes"),
            format!("Slot {number} playtime minutes"),
            minutes,
            Storage::U8,
        )
        .max(59)
        .copies(vec![minutes - PREVIEW_PLAYTIME]),
        FieldDefinition::new(
            format!("slot_{number}.playtime_seconds"),
            format!("Slot {number} playtime seconds"),
            seconds,
            Storage::U8,
        )
        .max(59)
        .copies(vec![seconds - PREVIEW_PLAYTIME]),
        FieldDefinition::new(
            format!("slot_{number}.adventures"),
            format!("Slot {number} adventures"),
            adventures,
            Storage::U8,
        )
        .copies(vec![adventures - PREVIEW_ADVENTURES]),
        FieldDefinition::new(
            format!("slot_{number}.funds"),
            format!("Slot {number} funds"),
            funds,
            Storage::U24Le,
        )
        .max(9_999_999)
        .copies(vec![funds - PREVIEW_FUNDS]),
    ];
    game.fields.extend(
        fields
            .into_iter()
            .map(|field| field.behavior(behavior.clone())),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template() -> Vec<u8> {
        let mut bytes: Vec<u8> = (0..SAVE_SIZE)
            .map(|index| ((index * 13 + (index >> 8) * 5 + 7) & 0xff) as u8)
            .collect();
        bytes[0x1ff0..0x1ffe].copy_from_slice(b"AzureDreamsGB ");
        bytes
    }

    fn set_checksums(bytes: &mut [u8], (system, slot_1, slot_2): (u16, u16, u16)) {
        bytes[SYSTEM_CHECKSUM..SYSTEM_CHECKSUM + 2].copy_from_slice(&system.to_le_bytes());
        bytes[checksum_at(0)..checksum_at(0) + 2].copy_from_slice(&slot_1.to_le_bytes());
        bytes[checksum_at(1)..checksum_at(1) + 2].copy_from_slice(&slot_2.to_le_bytes());
    }

    // Reference values computed outside Rust from the upstream algorithm over the template above
    // and the edits below: system `~byte[0xffe]` and slot `~sum(bytes[0x10..0xf0e])`, both
    // truncated to 16 bits.
    const BEFORE: (u16, u16, u16) = (0xffc7, 0x84ec, 0x888c);
    const AFTER: (u16, u16, u16) = (0xffc7, 0x85cf, 0x8a3f);

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
    fn edits_update_preview_copies_and_repair_slot_checksums() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let bytes = valid_template();
        assert_eq!(!u16::from(bytes[SYSTEM_BYTE]), BEFORE.0);
        assert_eq!(slot_checksum(&bytes, 0), BEFORE.1);
        assert_eq!(slot_checksum(&bytes, 1), BEFORE.2);
        let input = input(bytes, &identity);
        let edits = [
            edit("slot_1.playtime_hours", SaveValue::U32(999)),
            edit("slot_1.playtime_minutes", SaveValue::U32(59)),
            edit("slot_1.playtime_seconds", SaveValue::U32(58)),
            edit("slot_1.adventures", SaveValue::U32(255)),
            edit("slot_2.funds", SaveValue::U32(9_999_999)),
        ];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        for (offset, value) in [
            (0x93, 0xe7u8),
            (0x94, 0x03),
            (0x20, 0xe7),
            (0x21, 0x03),
            (0x92, 59),
            (0x1f, 59),
            (0x91, 58),
            (0x1e, 58),
            (0x9c, 255),
            (0x19, 255),
            (0x1000 + 0xa8, 0x7f),
            (0x1000 + 0xa9, 0x96),
            (0x1000 + 0xaa, 0x98),
            (0x1000 + 0x1b, 0x7f),
            (0x1000 + 0x1c, 0x96),
            (0x1000 + 0x1d, 0x98),
        ] {
            expected[offset] = value;
        }
        set_checksums(&mut expected, AFTER);
        assert_eq!(out, expected);
        assert_eq!(slot_checksum(&out, 0), AFTER.1);
        assert_eq!(slot_checksum(&out, 1), AFTER.2);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
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
    fn inactive_slots_are_untouched_and_corrupt_input_is_rejected() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let edits = [edit("slot_1.adventures", SaveValue::U32(1))];
        let valid = input(valid_template(), &identity);
        assert!(handler.apply(&valid, &identity, &edits, false).is_ok());
        for offset in [
            0xffe,
            0x1ffe,
            checksum_at(0),
            DATA_START + 0x40,
            0x1000 + 0x100,
        ] {
            let mut bad = valid.clone();
            bad.bytes[offset] ^= 1;
            assert!(
                handler.apply(&bad, &identity, &edits, false).is_err(),
                "offset {offset:#x}"
            );
        }
        let mut second_empty = valid.clone();
        let empty = checksum_at(1);
        second_empty.bytes[empty..empty + 2].fill(0xff);
        second_empty.bytes[0x1000 + 0x100] ^= 0xff;
        let out = handler
            .apply(&second_empty, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(out[0x1000..], second_empty.bytes[0x1000..]);
        let blocked = [edit("slot_2.adventures", SaveValue::U32(1))];
        assert!(
            handler
                .apply(&second_empty, &identity, &blocked, false)
                .is_err()
        );
        let range = [
            edit("slot_1.playtime_minutes", SaveValue::U32(60)),
            edit("slot_1.funds", SaveValue::U32(10_000_000)),
        ];
        for edit in range {
            assert!(handler.apply(&valid, &identity, &[edit], false).is_err());
        }
        let mut none = valid.clone();
        none.bytes[checksum_at(0)..checksum_at(0) + 2].fill(0xff);
        none.bytes[empty..empty + 2].fill(0xff);
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
