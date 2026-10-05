use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

// Layout, fields, and complementary word sums: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/wario-land-4/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "wario-land-4".into(),
        "Wario Land 4 (Europe/USA)".into(),
        "game-boy-advance".into(),
        0x2000,
    );
    game.description = "Edits medals, difficulty, stored money in tens, and Super Hard Mode in raw 8 KiB Europe/USA saves. Both complementary checksums are validated in each initialized slot. Requires a game-made template; Japanese and header-shifted layouts are unsupported.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0xc,
        bytes: b"AGBWarioLand".to_vec(),
    }];
    game.fields.push(
        FieldDefinition::new(
            "super_hard_mode".into(),
            "Super Hard Mode unlocked".into(),
            0xa,
            Storage::Bit,
        )
        .bit(0),
    );
    game.runtime.checks.push(Check {
        when: None,
        assert: Condition::new(|bytes| Ok(bytes[0x100] != 0 || bytes[0x500] != 0)),
        code: "save_empty".into(),
        message: "no Wario Land 4 file is initialized".into(),
        section_id: None,
        warning: None,
    });
    for slot in 0..2 {
        let base = slot * 0x400;
        let active = Condition::new(move |bytes| Ok(bytes[base + 0x100] != 0));
        for (id, label, offset, storage, max) in [
            ("difficulty", "Difficulty", 0x118, Storage::U8, 2),
            ("medals", "Medals", 0x11c, Storage::U16Le, 999),
            (
                "money_tens",
                "Money (stored tens)",
                0x120,
                Storage::U32Le,
                99999,
            ),
        ] {
            game.fields.push(
                FieldDefinition::new(
                    format!("slot_{}.{id}", slot + 1),
                    format!("Slot {} {label}", slot + 1),
                    base + offset,
                    storage,
                )
                .max(max)
                .behavior(field::FieldBehavior {
                    present_when: Some(active.clone()),
                    editable_when: Some(active.clone()),
                    ..Default::default()
                }),
            );
        }
        integrity(
            &mut game,
            base + 0x100,
            base + 0x2e0,
            base + 0x110,
            Some(active),
        );
    }
    integrity(&mut game, 8, 0x40, 0, None);
    build(vec![game], BTreeMap::new(), true)
}

fn word_sum(bytes: &[u8], start: usize, end: usize, offset: usize) -> u32 {
    (start..end)
        .step_by(4)
        .filter(|position| *position != offset && *position != offset + 4)
        .fold(u32::MAX, |sum, position| {
            sum.wrapping_add(u32::from_le_bytes(
                bytes[position..position + 4].try_into().unwrap(),
            ))
        })
}

fn integrity(
    game: &mut GameDefinition,
    start: usize,
    end: usize,
    offset: usize,
    active: Option<Condition>,
) {
    for (target, complemented) in [(offset, false), (offset + 4, true)] {
        game.runtime.checks.push(Check {
            when: active.clone(),
            assert: Condition::new(move |bytes| {
                let sum = word_sum(bytes, start, end, offset);
                let expected = if complemented { !sum } else { sum };
                Ok(u32::from_le_bytes(bytes[target..target + 4].try_into().unwrap()) == expected)
            }),
            code: "save_checksum".into(),
            message: "a Wario Land 4 complementary checksum is invalid".into(),
            section_id: None,
            warning: None,
        });
        game.runtime.after_edit.push(Store {
            when: active.clone(),
            destination: Scalar {
                offset: target,
                storage: Storage::U32Le,
                mask: None,
            },
            value: ReadValue::new(move |bytes| {
                let sum = word_sum(bytes, start, end, offset);
                Ok(i64::from(if complemented { !sum } else { sum }))
            }),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        for (start, end, checksum) in [(8, 0x40, 0), (0x100, 0x2e0, 0x110), (0x500, 0x6e0, 0x510)] {
            let mut sum = u32::MAX;
            for position in (start..end).step_by(4) {
                if position != checksum && position != checksum + 4 {
                    sum = sum.wrapping_add(u32::from_le_bytes(
                        bytes[position..position + 4].try_into().unwrap(),
                    ));
                }
            }
            bytes[checksum..checksum + 4].copy_from_slice(&sum.to_le_bytes());
            bytes[checksum + 4..checksum + 8].copy_from_slice(&(!sum).to_le_bytes());
        }
    }

    #[test]
    fn preserves_other_file_and_repairs_both_checksums() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0x5a; 0x2000];
        bytes[0xc..0x18].copy_from_slice(b"AGBWarioLand");
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "slot_2.medals".into(),
            value: SaveValue::U32(321),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x51c..0x51e].copy_from_slice(&321u16.to_le_bytes());
        repair(&mut expected);
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
        for position in [0, 4, 0x110, 0x114, 0x510, 0x514, 0xc] {
            let mut bad = input.clone();
            bad.bytes[position] ^= 1;
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        for size in [0, 0x1fff, 0x2001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
        let mut empty = input.clone();
        empty.bytes[0x100] = 0;
        empty.bytes[0x500] = 0;
        repair(&mut empty.bytes);
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
        let mut partial = input;
        partial.bytes[0x500] = 0;
        assert!(handler.apply(&partial, &identity, &edits, false).is_err());
    }
}
