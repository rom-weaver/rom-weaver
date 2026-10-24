use super::*;

// Layout and linked preview writes: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/castlevania-harmony-of-dissonance/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "castlevania-harmony-of-dissonance".into(),
        "Castlevania: Harmony of Dissonance".into(),
        "game-boy-advance".into(),
        0x8000,
    );
    game.description = "Edits documented scalar fields in initialized files of raw 32 KiB Europe/USA/Japan saves. Gold and Juste level preview values are updated together. This source layout has no checksum; signature and initialized-file markers are checked. Collection saves and wrappers are unsupported; requires a game-made template.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0,
        bytes: b"CASTLEVANIA1.00".to_vec(),
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok((0..3).any(|slot| bytes[0x10 + slot * 0x3f8] != 0))
        }),
        code: "save_empty".into(),
        message: "no Harmony of Dissonance file is initialized".into(),
        section_id: None,
        warning: None,
    });
    for slot in 0..3 {
        let base = slot * 0x3f8;
        let active = rules::Condition::new(move |bytes| Ok(bytes[base + 0x10] != 0));
        for (id, label, offset, storage, max) in [
            ("gold", "Gold", 0x3c, Storage::U32Le, 9999999),
            ("experience", "Experience", 0x38, Storage::U32Le, 9999999),
            ("max_hp", "Maximum HP", 0x26, Storage::U16Le, 999),
            ("max_mp", "Maximum MP", 0x28, Storage::U16Le, 999),
            ("level", "Level", 0x1c, Storage::U8, 99),
        ] {
            let mut field = FieldDefinition::new(
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
            });
            if id == "gold" {
                field = field.copies(vec![base + 0x130]);
            }
            if id == "level" {
                field = field.min(1);
                field.behavior.on_edit.push(rules::Store {
                    when: Some(rules::Condition::new(move |bytes| {
                        Ok(bytes[base + 0x12d] != 0xff)
                    })),
                    destination: rules::Scalar {
                        offset: base + 0x12d,
                        storage: Storage::U8,
                        mask: None,
                    },
                    value: rules::ReadValue::new(move |bytes| Ok(i64::from(bytes[base + 0x1c]))),
                });
            }
            game.fields.push(field);
        }
    }
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_and_linked_preview_writes_preserve_other_slots() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 0x8000];
        bytes[..15].copy_from_slice(b"CASTLEVANIA1.00");
        bytes[0x408] = 1;
        bytes[0x525] = 10;
        bytes[0x414] = 10;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [
            SaveEdit {
                field: "slot_2.gold".into(),
                value: SaveValue::U32(654321),
            },
            SaveEdit {
                field: "slot_2.level".into(),
                value: SaveValue::U32(50),
            },
        ];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x434..0x438].copy_from_slice(&654321u32.to_le_bytes());
        expected[0x528..0x52c].copy_from_slice(&654321u32.to_le_bytes());
        expected[0x414] = 50;
        expected[0x525] = 50;
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
        let mut maxime = input.clone();
        maxime.bytes[0x525] = 0xff;
        let out = handler
            .apply(&maxime, &identity, &edits[1..], false)
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(out[0x525], 0xff);
        let mut bad = input.clone();
        bad.bytes[0] ^= 1;
        assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        let mut empty = input.clone();
        empty.bytes[0x408] = 0;
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
        assert!(
            handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.gold".into(),
                        value: SaveValue::U32(1)
                    }],
                    false
                )
                .is_err()
        );
        for size in [0, 0x7fff, 0x8001] {
            let bad = SaveDetectionInput {
                bytes: vec![0; size],
                ..input.clone()
            };
            assert!(handler.apply(&bad, &identity, &edits, false).is_err());
        }
    }
}
