use super::*;

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/donkey-kong-land/saveEditor
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/donkey-kong-land/saveEditor

// Slot-relative (byte offset, bit, label) flags from the upstream template.
const UNLOCKED_LEVELS: [(usize, u8, &str); 34] = [
    (0x0e, 0, "Level 1-1"),
    (0x0e, 1, "Level 1-2"),
    (0x0e, 2, "Level 1-3"),
    (0x0e, 3, "Level 1-4"),
    (0x0e, 4, "Level 1-5"),
    (0x0e, 5, "Level 1-6"),
    (0x0e, 6, "Level 1-7"),
    (0x0e, 7, "Level 1-8"),
    (0x0f, 0, "Level 1-9"),
    (0x0f, 1, "Level 1-10"),
    (0x10, 0, "Level 2-1"),
    (0x10, 1, "Level 2-2"),
    (0x10, 2, "Level 2-3"),
    (0x10, 3, "Level 2-4"),
    (0x10, 4, "Level 2-5"),
    (0x10, 5, "Level 2-6"),
    (0x10, 6, "Level 2-7"),
    (0x10, 7, "Level 2-8"),
    (0x12, 0, "Level 3-1"),
    (0x12, 1, "Level 3-2"),
    (0x12, 2, "Level 3-3"),
    (0x12, 3, "Level 3-4"),
    (0x12, 4, "Level 3-5"),
    (0x12, 5, "Level 3-6"),
    (0x12, 6, "Level 3-7"),
    (0x12, 7, "Level 3-8"),
    (0x14, 0, "Level 4-1"),
    (0x14, 1, "Level 4-2"),
    (0x14, 2, "Level 4-3"),
    (0x14, 3, "Level 4-4"),
    (0x14, 4, "Level 4-5"),
    (0x14, 5, "Level 4-6"),
    (0x14, 6, "Level 4-7"),
    (0x14, 7, "Level 4-8"),
];

// Visited flags for levels and their bonus rooms; the game's completion rate counts these 80 bits.
const VISITED_LEVELS: [(usize, u8, &str); 80] = [
    (0x1f, 6, "Level 1-1"),
    (0x24, 7, "Level 1-1 (Bonus Room 1)"),
    (0x25, 4, "Level 1-1 (Bonus Room 2)"),
    (0x1f, 7, "Level 1-2"),
    (0x23, 6, "Level 1-2 (Bonus Room)"),
    (0x20, 6, "Level 1-3"),
    (0x23, 1, "Level 1-3 (Bonus Room 1)"),
    (0x29, 6, "Level 1-3 (Bonus Room 2)"),
    (0x20, 4, "Level 1-4"),
    (0x24, 0, "Level 1-4 (Bonus Room 1)"),
    (0x23, 4, "Level 1-4 (Bonus Room 2)"),
    (0x20, 2, "Level 1-5"),
    (0x29, 4, "Level 1-5 (Bonus Room 1)"),
    (0x23, 0, "Level 1-5 (Bonus Room 3)"),
    (0x23, 2, "Level 1-5 (Bonus Room 2)"),
    (0x20, 5, "Level 1-6"),
    (0x29, 5, "Level 1-6 (Bonus Room 1)"),
    (0x25, 3, "Level 1-6 (Bonus Room 2)"),
    (0x1f, 2, "Level 1-7"),
    (0x26, 2, "Level 1-7 (Bonus Room 1)"),
    (0x23, 3, "Level 1-7 (Bonus Room 2)"),
    (0x1f, 5, "Level 1-8"),
    (0x24, 6, "Level 1-8 (Bonus Room 1)"),
    (0x29, 3, "Level 1-8 (Bonus Room 2)"),
    (0x22, 7, "Level 1-9"),
    (0x29, 2, "Level 1-9 (Bonus Room 1)"),
    (0x24, 1, "Level 1-9 (Bonus Room 2)"),
    (0x24, 4, "Level 1-10"),
    (0x1f, 4, "Level 2-1"),
    (0x24, 3, "Level 2-1 (Bonus Room 1)"),
    (0x21, 7, "Level 2-2"),
    (0x1f, 3, "Level 2-3"),
    (0x1f, 0, "Level 2-4"),
    (0x25, 6, "Level 2-4 (Bonus Room 1)"),
    (0x22, 2, "Level 2-5"),
    (0x1f, 1, "Level 2-6"),
    (0x20, 7, "Level 2-7"),
    (0x24, 2, "Level 2-7 (Bonus Room 1)"),
    (0x25, 0, "Level 2-8"),
    (0x21, 5, "Level 3-1"),
    (0x26, 5, "Level 3-1 (Bonus Room 1)"),
    (0x27, 6, "Level 3-1 (Bonus Room 2)"),
    (0x21, 4, "Level 3-2"),
    (0x24, 5, "Level 3-2 (Bonus Room 1)"),
    (0x27, 3, "Level 3-2 (Bonus Room 2)"),
    (0x21, 1, "Level 3-3"),
    (0x27, 7, "Level 3-3 (Bonus Room 1)"),
    (0x26, 4, "Level 3-4 (Bonus Room 2)"),
    (0x22, 0, "Level 3-4"),
    (0x26, 0, "Level 3-4 (Bonus Room 1)"),
    (0x29, 1, "Level 3-5 (Bonus Room 2)"),
    (0x21, 0, "Level 3-5"),
    (0x25, 1, "Level 3-5 (Bonus Room 1)"),
    (0x22, 3, "Level 3-6"),
    (0x28, 6, "Level 3-6 (Bonus Room 1)"),
    (0x26, 3, "Level 3-6 (Bonus Room 2)"),
    (0x22, 5, "Level 3-7"),
    (0x27, 1, "Level 3-7 (Bonus Room 1)"),
    (0x29, 0, "Level 3-7 (Bonus Room 2)"),
    (0x23, 7, "Level 3-8"),
    (0x21, 6, "Level 4-1"),
    (0x25, 5, "Level 4-1 (Bonus Room 1)"),
    (0x25, 7, "Level 4-1 (Bonus Room 2)"),
    (0x20, 0, "Level 4-2"),
    (0x27, 5, "Level 4-2 (Bonus Room 1)"),
    (0x21, 2, "Level 4-3"),
    (0x27, 2, "Level 4-3 (Bonus Room 1)"),
    (0x26, 1, "Level 4-3 (Bonus Room 2)"),
    (0x22, 6, "Level 4-4"),
    (0x29, 7, "Level 4-4 (Bonus Room 1)"),
    (0x23, 5, "Level 4-4 (Bonus Room 2)"),
    (0x21, 3, "Level 4-5"),
    (0x27, 4, "Level 4-5 (Bonus Room 1)"),
    (0x22, 1, "Level 4-6"),
    (0x28, 7, "Level 4-6 (Bonus Room 1)"),
    (0x20, 3, "Level 4-6 (Bonus Room 2)"),
    (0x22, 4, "Level 4-7"),
    (0x25, 2, "Level 4-7 (Bonus Room 1)"),
    (0x27, 0, "Level 4-7 (Bonus Room 2)"),
    (0x26, 6, "Level 4-8"),
];

const BOULDERS: [(&str, &str); 3] = [
    ("world_1_south", "World 1 South"),
    ("world_1_east", "World 1 East"),
    ("world_2", "World 2"),
];

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    let mut signatures = Vec::new();
    let mut checksums = Vec::new();
    for slot in 0..3 {
        let base = 0xa00 + slot * 0x40;
        let p = format!("slot_{}", slot + 1);
        fields.push(FieldDefinition::new(
            format!("{p}.progression_level"),
            format!("Slot {} progression level", slot + 1),
            base + 6,
            Storage::U16Be,
        ));
        fields.push(FieldDefinition::new(
            format!("{p}.current_level"),
            format!("Slot {} current level", slot + 1),
            base + 0x1a,
            Storage::U16Be,
        ));
        for (key, label, off, max) in [
            ("hours", "hours", 0x1c, 99),
            ("minutes", "minutes", 0x1d, 59),
            ("seconds", "seconds", 0x1e, 59),
        ] {
            fields.push(
                FieldDefinition::new(
                    format!("{p}.{key}"),
                    format!("Slot {} playtime {label}", slot + 1),
                    base + off,
                    Storage::U8,
                )
                .min(0)
                .max(max),
            );
        }
        fields.push(FieldDefinition::new(
            format!("{p}.has_bomb"),
            format!("Slot {} has bomb", slot + 1),
            base + 0xc,
            Storage::Bool,
        ));
        for (bit, (key, label)) in BOULDERS.into_iter().enumerate() {
            fields.push(
                FieldDefinition::new(
                    format!("{p}.boulder.{key}"),
                    format!("Slot {} destroyed boulder: {label}", slot + 1),
                    base + 0xd,
                    Storage::Bit,
                )
                .bit(bit as u8),
            );
        }
        for (kind, flags) in [
            ("unlocked", &UNLOCKED_LEVELS[..]),
            ("visited", &VISITED_LEVELS[..]),
        ] {
            for (offset, bit, label) in flags {
                fields.push(
                    FieldDefinition::new(
                        format!("{p}.{kind}.{}", id_part(label)),
                        format!("Slot {} {kind}: {label}", slot + 1),
                        base + offset,
                        Storage::Bit,
                    )
                    .bit(*bit),
                );
            }
        }
        signatures.push(SignatureDefinition {
            offset: base,
            bytes: b"PFLOYD".to_vec(),
        });
        let exclude = vec![ChecksumExclusion {
            offset: base + 0x3e,
            length: 2,
        }];
        checksums.push(ChecksumDefinition {
            start: Some(base),
            length: Some(0x40),
            exclude: exclude.clone(),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add8, base + 0x3e)
        });
        checksums.push(ChecksumDefinition {
            start: Some(base),
            length: Some(0x40),
            exclude,
            ..ChecksumDefinition::new(ChecksumAlgorithm::Xor8, base + 0x3f)
        });
    }
    build(
        vec![GameDefinition {
            fields,
            description: "Edits progression, playtime, the bomb and boulder flags, unlocked levels, and visited levels and bonus rooms in all three slots.".into(),
            signatures,
            checksums,
            ..GameDefinition::new(
                "donkey-kong-land".into(),
                "Donkey Kong Land".into(),
                "game-boy".into(),
                8192,
            )
        }],
        BTreeMap::new(),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(b: &mut [u8]) {
        for slot in 0..3 {
            let base = 0xa00 + slot * 0x40;
            let data = &b[base..base + 0x3e];
            let add = data.iter().fold(0u8, |s, v| s.wrapping_add(*v));
            let xor = data.iter().fold(0u8, |s, v| s ^ *v);
            b[base + 0x3e] = add;
            b[base + 0x3f] = xor;
        }
    }
    #[test]
    fn edits_slot_and_repairs_independent_sum_and_xor_bytes() {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0x35; 8192];
        for s in 0..3 {
            bytes[0xa00 + s * 0x40..0xa06 + s * 0x40].copy_from_slice(b"PFLOYD");
        }
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(id.id.clone()),
            rom_sha1: None,
        };
        let out = h
            .apply(
                &input,
                &id,
                &[SaveEdit {
                    field: "slot_3.minutes".into(),
                    value: SaveValue::U32(42),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(out[0xa9d], 42);
        let mut expected = input.bytes.clone();
        expected[0xa9d] = 42;
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(h.apply(&input, &id, &[], false).unwrap().bytes.is_none());
        let mut bad = input;
        bad.bytes[0xa3f] ^= 1;
        assert!(h.apply(&bad, &id, &[], false).is_err());
    }

    fn slot_input() -> (SchemaSaveHandler, SaveGameIdentity, SaveDetectionInput) {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0; 8192];
        for s in 0..3 {
            bytes[0xa00 + s * 0x40..0xa06 + s * 0x40].copy_from_slice(b"PFLOYD");
            bytes[0xa0e + s * 0x40] = 1;
        }
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(id.id.clone()),
            rom_sha1: None,
        };
        (h, id, input)
    }

    #[test]
    fn flags_edit_their_slot_bit_and_keep_both_checksums_valid() {
        let (h, id, input) = slot_input();
        for slot in 0..3usize {
            let p = format!("slot_{}", slot + 1);
            let edits = [
                ("has_bomb".to_string(), SaveValue::Bool(true)),
                ("boulder.world_2".to_string(), SaveValue::Bool(true)),
                ("unlocked.level_1_10".to_string(), SaveValue::Bool(true)),
                ("unlocked.level_4_8".to_string(), SaveValue::Bool(true)),
                ("visited.level_1_1".to_string(), SaveValue::Bool(true)),
                (
                    "visited.level_1_5_bonus_room_3".to_string(),
                    SaveValue::Bool(true),
                ),
                ("visited.level_4_8".to_string(), SaveValue::Bool(true)),
            ]
            .map(|(field, value)| SaveEdit {
                field: format!("{p}.{field}"),
                value,
            });
            let out = h.apply(&input, &id, &edits, false).unwrap().bytes.unwrap();
            let mut expected = input.bytes.clone();
            let base = 0xa00 + slot * 0x40;
            expected[base + 0xc] = 1;
            expected[base + 0xd] |= 1 << 2;
            expected[base + 0xf] |= 1 << 1;
            expected[base + 0x14] |= 1 << 7;
            expected[base + 0x1f] |= 1 << 6;
            expected[base + 0x23] |= 1;
            expected[base + 0x26] |= 1 << 6;
            repair(&mut expected);
            assert_eq!(out, expected, "slot {}", slot + 1);
            // Clearing the same bits restores the original save, checksums included.
            let cleared: Vec<_> = edits
                .iter()
                .map(|edit| SaveEdit {
                    field: edit.field.clone(),
                    value: SaveValue::Bool(false),
                })
                .collect();
            let reopened = SaveDetectionInput {
                bytes: out,
                ..input.clone()
            };
            let back = h
                .apply(&reopened, &id, &cleared, false)
                .unwrap()
                .bytes
                .unwrap();
            assert_eq!(back, input.bytes);
        }
    }

    #[test]
    fn every_flag_field_maps_to_a_distinct_bit_that_edits_alone() {
        let (h, id, input) = slot_input();
        let mut ids = vec!["slot_2.has_bomb".to_string()];
        ids.extend(
            BOULDERS
                .iter()
                .map(|(key, _)| format!("slot_2.boulder.{key}")),
        );
        for (kind, flags) in [
            ("unlocked", &UNLOCKED_LEVELS[..]),
            ("visited", &VISITED_LEVELS[..]),
        ] {
            ids.extend(
                flags
                    .iter()
                    .map(|(_, _, label)| format!("slot_2.{kind}.{}", id_part(label))),
            );
        }
        let edits: Vec<_> = ids
            .iter()
            .map(|field| SaveEdit {
                field: field.clone(),
                value: SaveValue::Bool(true),
            })
            .collect();
        let out = h.apply(&input, &id, &edits, false).unwrap().bytes.unwrap();
        // Slot 2 spans 0xa40..0xa80; each of the 118 flags is one distinct bit, and the fixture
        // already has "Level 1-1" unlocked (the byte that marks the slot as used).
        let changed: u32 = (0xa40..0xa7e)
            .map(|at| (out[at] ^ input.bytes[at]).count_ones())
            .sum();
        assert_eq!(changed, 117);
        assert_eq!(&out[..0xa40], &input.bytes[..0xa40]);
        assert_eq!(&out[0xa80..], &input.bytes[0xa80..]);
        let mut repaired = out.clone();
        repair(&mut repaired);
        assert_eq!(out, repaired);
    }
}
