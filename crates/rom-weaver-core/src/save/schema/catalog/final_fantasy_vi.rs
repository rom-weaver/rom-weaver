use super::super::rules::{ReadValue, Scalar, Store};
use super::*;
use tracing::trace;

const SLOT_SIZE: usize = 0xa00;
const PARTY_SIZE: usize = 16;
const CHARACTER_STRIDE: usize = 0x25;

// Characters are stored as consecutive blocks; group membership lives in a separate per-character byte array.
fn character_fields(index: usize, base: usize) -> Vec<FieldDefinition> {
    let block = base + index * CHARACTER_STRIDE;
    let group = base + 0x250 + index;
    let prefix = format!("party.{:02}", index + 1);
    let name = format!("Character {}", index + 1);
    let id = |suffix: &str| format!("{prefix}.{suffix}");
    let label = |suffix: &str| format!("{name} {suffix}");
    let mut fields = vec![
        catalog_field(&id("level"), &label("level"), block + 0x8, Storage::U8)
            .min(1)
            .max(99),
        catalog_field(&id("hp"), &label("current HP"), block + 0x9, Storage::U16Le)
            .min(0)
            .max(9999),
        catalog_field(
            &id("max_hp"),
            &label("maximum HP"),
            block + 0xb,
            Storage::U16Le,
        )
        .mask(0x3fff)
        .min(1)
        .max(9999),
        catalog_field(&id("mp"), &label("current MP"), block + 0xd, Storage::U16Le)
            .min(0)
            .max(999),
        catalog_field(
            &id("max_mp"),
            &label("maximum MP"),
            block + 0xf,
            Storage::U16Le,
        )
        .mask(0x3fff)
        .min(0)
        .max(999),
        catalog_field(
            &id("experience"),
            &label("experience"),
            block + 0x11,
            Storage::U24Le,
        )
        .min(0)
        .max(15_000_000),
        catalog_field(&id("vigor"), &label("vigor"), block + 0x1a, Storage::U8)
            .min(0)
            .max(128),
        catalog_field(&id("speed"), &label("speed"), block + 0x1b, Storage::U8)
            .min(0)
            .max(128),
        catalog_field(&id("stamina"), &label("stamina"), block + 0x1c, Storage::U8)
            .min(0)
            .max(128),
        catalog_field(
            &id("magic_power"),
            &label("magic power"),
            block + 0x1d,
            Storage::U8,
        )
        .min(0)
        .max(128),
        // The game keeps a separate "assigned" flag in bit 6 that must follow the group.
        catalog_field(&id("group"), &label("party group"), group, Storage::U8)
            .mask(0x07)
            .choices(choices(&[
                ("None", 0),
                ("Group 1", 1),
                ("Group 2", 2),
                ("Group 3", 3),
            ]))
            .behavior(field::FieldBehavior {
                on_edit: vec![Store {
                    when: None,
                    destination: Scalar {
                        offset: group,
                        storage: Storage::U8,
                        mask: Some(0x40),
                    },
                    value: ReadValue::new(move |bytes| Ok(i64::from(bytes[group] & 0x07 != 0))),
                }],
                ..Default::default()
            }),
        catalog_field(
            &id("group_position"),
            &label("position in group (stored 0-3)"),
            group,
            Storage::U8,
        )
        .mask(0x18),
    ];
    for (suffix, text, offset, bit) in [
        ("condition.dark", "Dark", 0x14, 0),
        ("condition.zombie", "Zombie", 0x14, 1),
        ("condition.poison", "Poison", 0x14, 2),
        ("condition.clear", "Clear", 0x14, 4),
        ("condition.imp", "Imp", 0x14, 5),
        ("condition.petrify", "Petrify", 0x14, 6),
        ("condition.wounded", "Wounded", 0x14, 7),
        ("condition.float", "Float", 0x15, 7),
    ] {
        fields.push(
            catalog_field(
                &id(suffix),
                &label(&format!("{text} status")),
                block + offset,
                Storage::Bit,
            )
            .bit(bit),
        );
    }
    fields
}

// Boost and cap rule: CalcMaxHPMP and ValidateMaxHP in https://github.com/everything8215/ff6/blob/813013276c952fdd27edcf7b8b86f17291542cbf/src/menu/menu_common.asm
/// In-game maximum for a stored HP or MP word: bits 14-15 add a 25%, 50%, or 12.5% equipment boost to the 14-bit base, capped at `cap`.
fn effective_maximum(word: u16, cap: u16) -> u16 {
    let base = word & 0x3fff;
    let boost = match word >> 14 {
        0 => 0,
        1 => base >> 2,
        2 => base >> 1,
        _ => base >> 3,
    };
    (base + boost).min(cap)
}

// The game clamps current HP and MP to the boosted maximum (CheckMaxHP and CheckMaxMP in src/menu/field_menu.asm of the same disassembly).
fn party_capacity_check(slot: usize, base: usize) -> rules::Check {
    rules::Check {
        when: None,
        assert: rules::Condition::new(move |bytes| {
            let word = |offset: usize| u16::from_le_bytes([bytes[offset], bytes[offset + 1]]);
            Ok((0..PARTY_SIZE).all(|index| {
                let block = base + index * CHARACTER_STRIDE;
                word(block + 0x9) <= effective_maximum(word(block + 0xb), 9999)
                    && word(block + 0xd) <= effective_maximum(word(block + 0xf), 999)
            }))
        }),
        code: "save_resource_capacity".into(),
        message: format!(
            "a slot {} character's current HP or MP exceeds its maximum",
            slot + 1
        ),
        section_id: None,
        warning: None,
    }
}

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/final-fantasy-vi/saveEditor
// Current layout and character fields: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/final-fantasy-vi/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..3)
        .map(|slot| {
            let base = slot * SLOT_SIZE;
            let mut fields = vec![
                    catalog_field("money", "Money", base + 0x260, Storage::U24Le)
                        .min(0).max(9_999_999),
                    catalog_field("location", "Location code", base + 0x964, Storage::U16Le)
                        .mask(0x1ff).editable(false)
                        .description("Read-only because changing locations also requires matching map coordinates.".into()),
                    catalog_field("config.battle_speed", "Battle speed (stored 0-5)", base + 0x74d, Storage::U8)
                        .mask(0x7).min(0).max(5),
                    catalog_field("steps", "Steps", base + 0x266, Storage::U24Le).min(0).max(9_999_999),
                    catalog_field("play_time.hours", "Play time hours", base + 0x263, Storage::U8).min(0).max(99),
                    catalog_field("play_time.minutes", "Play time minutes", base + 0x264, Storage::U8).min(0).max(59),
                    catalog_field("play_time.seconds", "Play time seconds", base + 0x265, Storage::U8).min(0).max(59),
                    catalog_field("party.current_group", "Current party group", base + 0x46d, Storage::U8).min(1).max(3),
                    catalog_field("airship.enabled", "Airship available", base + 0x8b7, Storage::Bit).bit(1),
                    catalog_field("airship.x", "Airship position X", base + 0x962, Storage::U8),
                    catalog_field("airship.y", "Airship position Y", base + 0x963, Storage::U8),
                ];
            for index in 0..PARTY_SIZE {
                fields.extend(character_fields(index, base));
            }
            trace!(slot, fields = fields.len(), "built Final Fantasy VI slot fields");
            GameDefinition {
                fields,
                description: format!("Edits SNES save slot {}: money, steps, play time, current party group, airship, and per-character level, HP/MP, experience, base stats, party group, and status flags. Current HP and MP cannot exceed the maximum after its stored equipment boost. Names, equipment, espers, abilities, spells, inventory, locations, and progression are omitted because they need name tables or have coupled write rules.", slot + 1),
                checksums: vec![ChecksumDefinition {
                    start: Some(base), length: Some(0x9fe),
                    ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, base + 0x9fe)
                }],
                runtime: runtime::Runtime {
                    edit_checks: vec![party_capacity_check(slot, base)],
                    ..Default::default()
                },
                ..GameDefinition::new(format!("final-fantasy-vi-slot-{}", slot + 1), format!("Final Fantasy VI (SNES Slot {})", slot + 1), "snes".into(), 8192)
            }
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], base: usize) {
        let sum = bytes[base..base + 0x9fe]
            .iter()
            .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
        bytes[base + 0x9fe..base + 0xa00].copy_from_slice(&sum.to_le_bytes());
    }

    // A 0x5a fill with every character's current HP and MP cleared so they stay within their maximums.
    fn filled() -> Vec<u8> {
        let mut bytes = vec![0x5a; 8192];
        for slot in 0..3 {
            for index in 0..PARTY_SIZE {
                let block = slot * SLOT_SIZE + index * CHARACTER_STRIDE;
                for offset in [0x9, 0xa, 0xd, 0xe] {
                    bytes[block + offset] = 0;
                }
            }
        }
        bytes
    }

    #[test]
    fn edits_only_selected_slot_and_repairs_checksum() {
        let handler = schemas().remove(1);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = filled();
        for slot in 0..3 {
            repair(&mut bytes, slot * SLOT_SIZE);
        }
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0xc60..0xc63].copy_from_slice(&0x345678u32.to_le_bytes()[..3]);
        repair(&mut expected, SLOT_SIZE);
        let result = handler
            .apply(
                &input,
                &identity,
                &[SaveEdit {
                    field: "money".into(),
                    value: SaveValue::U32(0x345678),
                }],
                false,
            )
            .unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
        assert!(
            handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "location".into(),
                        value: SaveValue::U32(1),
                    }],
                    false,
                )
                .is_err()
        );
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input.clone();
        bad.bytes[SLOT_SIZE + 7] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    fn apply(handler: &SchemaSaveHandler, bytes: Vec<u8>, edits: &[SaveEdit]) -> Result<Vec<u8>> {
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        Ok(handler
            .apply(&input, &identity, edits, false)?
            .bytes
            .expect("edited bytes"))
    }

    #[test]
    fn global_and_party_fields_write_only_their_bytes_and_repair_the_checksum() {
        let handler = schemas().remove(2);
        let base = 2 * SLOT_SIZE;
        let first = base;
        let last = base + 15 * 0x25;
        let mut bytes = filled();
        bytes[base + 0x250] = 0;
        for slot in 0..3 {
            repair(&mut bytes, slot * SLOT_SIZE);
        }
        let choice = |name: &str| SaveValue::Enum(name.into());
        let edits = [
            edit("steps", SaveValue::U32(9_999_999)),
            edit("play_time.hours", SaveValue::U32(99)),
            edit("play_time.minutes", SaveValue::U32(59)),
            edit("play_time.seconds", SaveValue::U32(0)),
            edit("party.current_group", SaveValue::U32(3)),
            edit("airship.enabled", SaveValue::Bool(false)),
            edit("airship.x", SaveValue::U32(0x12)),
            edit("airship.y", SaveValue::U32(0x34)),
            edit("party.01.level", SaveValue::U32(99)),
            // 0x5a5a stores base 6746 with a 25% boost, so 8432 is the in-game maximum.
            edit("party.01.hp", SaveValue::U32(8432)),
            edit("party.01.max_mp", SaveValue::U32(999)),
            edit("party.01.experience", SaveValue::U32(15_000_000)),
            edit("party.01.vigor", SaveValue::U32(128)),
            edit("party.01.group", choice("Group 3")),
            edit("party.01.group_position", SaveValue::U32(3)),
            edit("party.01.condition.poison", SaveValue::Bool(true)),
            edit("party.01.condition.float", SaveValue::Bool(true)),
            edit("party.16.max_hp", SaveValue::U32(9999)),
            edit("party.16.mp", SaveValue::U32(0)),
            edit("party.16.group", choice("None")),
            edit("party.16.group_position", SaveValue::U32(1)),
            edit("party.16.condition.dark", SaveValue::Bool(false)),
        ];
        let mut expected = bytes.clone();
        expected[base + 0x266..base + 0x269].copy_from_slice(&9_999_999u32.to_le_bytes()[..3]);
        expected[base + 0x263..base + 0x266].copy_from_slice(&[99, 59, 0]);
        expected[base + 0x46d] = 3;
        expected[base + 0x8b7] = 0x5a & !0x02;
        expected[base + 0x962..base + 0x964].copy_from_slice(&[0x12, 0x34]);
        expected[first + 8] = 99;
        expected[first + 9..first + 11].copy_from_slice(&8432u16.to_le_bytes());
        // The two high bits of the maximum-MP word are not part of the value.
        expected[first + 0xf..first + 0x11].copy_from_slice(&0x43e7u16.to_le_bytes());
        expected[first + 0x11..first + 0x14].copy_from_slice(&15_000_000u32.to_le_bytes()[..3]);
        expected[first + 0x1a] = 128;
        expected[base + 0x250] = 0x03 | 0x40 | 0x18;
        expected[first + 0x14] |= 0x04;
        expected[first + 0x15] |= 0x80;
        expected[last + 0xb..last + 0xd].copy_from_slice(&0x670fu16.to_le_bytes());
        expected[last + 0xd..last + 0xf].copy_from_slice(&[0, 0]);
        expected[base + 0x25f] = 0x08;
        expected[last + 0x14] &= !0x01;
        repair(&mut expected, base);
        assert_eq!(apply(&handler, bytes.clone(), &edits).unwrap(), expected);
        for (field, value) in [
            ("party.01.level", SaveValue::U32(100)),
            ("party.01.level", SaveValue::U32(0)),
            ("party.01.max_hp", SaveValue::U32(10_000)),
            ("party.01.mp", SaveValue::U32(1000)),
            ("party.01.vigor", SaveValue::U32(129)),
            ("play_time.minutes", SaveValue::U32(60)),
            ("party.current_group", SaveValue::U32(4)),
            ("party.01.group", choice("Group 4")),
        ] {
            assert!(
                apply(&handler, bytes.clone(), &[edit(field, value)]).is_err(),
                "{field}"
            );
        }
        assert!(
            apply(
                &handler,
                bytes,
                &[edit("party.17.level", SaveValue::U32(1))]
            )
            .is_err()
        );
    }

    #[test]
    fn current_hp_and_mp_cannot_exceed_the_boosted_maximum() {
        let handler = schemas().remove(0);
        let block = 4 * CHARACTER_STRIDE;
        let mut bytes = vec![0; 8192];
        // Base HP 1000 with a 12.5% boost; base MP 800 with a 50% boost that the 999 cap limits.
        bytes[block + 0xb..block + 0xd].copy_from_slice(&(0xc000u16 | 1000).to_le_bytes());
        bytes[block + 0xf..block + 0x11].copy_from_slice(&(0x8000u16 | 800).to_le_bytes());
        repair(&mut bytes, 0);
        let capacity_error = |edits: &[SaveEdit]| {
            matches!(
                apply(&handler, bytes.clone(), edits),
                Err(crate::RomWeaverError::ValidationCode(error))
                    if error.code() == "save_resource_capacity"
            )
        };
        let output = apply(
            &handler,
            bytes.clone(),
            &[
                edit("party.05.hp", SaveValue::U32(1125)),
                edit("party.05.mp", SaveValue::U32(999)),
            ],
        )
        .unwrap();
        assert_eq!(output[block + 0x9..block + 0xb], 1125u16.to_le_bytes());
        assert_eq!(output[block + 0xd..block + 0xf], 999u16.to_le_bytes());
        assert!(capacity_error(&[edit("party.05.hp", SaveValue::U32(1126))]));
        assert!(capacity_error(&[
            edit("party.05.hp", SaveValue::U32(1125)),
            edit("party.05.max_hp", SaveValue::U32(999)),
        ]));
        assert!(capacity_error(&[
            edit("party.05.mp", SaveValue::U32(900)),
            edit("party.05.max_mp", SaveValue::U32(599)),
        ]));
        let mut over = bytes.clone();
        over[block + 0x9..block + 0xb].copy_from_slice(&1126u16.to_le_bytes());
        repair(&mut over, 0);
        assert!(matches!(
            apply(&handler, over, &[edit("money", SaveValue::U32(1))]),
            Err(crate::RomWeaverError::ValidationCode(error))
                if error.code() == "save_resource_capacity"
        ));
    }
}
