use super::*;

// Layout, fields, and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/konami-krazy-racers/saveEditor (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut game = GameDefinition::new(
        "konami-krazy-racers".into(),
        "Konami Krazy Racers (Europe/USA)".into(),
        "game-boy-advance".into(),
        0x2000,
    );
    game.description = "Edits coins, item quantities, and character unlock flags in initialized files of raw 8 KiB Europe/USA saves. Empty files are preserved. Each initialized file uses a complemented byte sum with its checksum word zeroed. Names, race records, progression, and Japanese layouts are unsupported; requires a game-made template.".into();
    game.signatures = vec![SignatureDefinition {
        offset: 0,
        bytes: b"KRAZY  ACERS    ".to_vec(),
    }];
    game.runtime.checks.push(rules::Check {
        when: None,
        assert: rules::Condition::new(|bytes| {
            Ok((0..3).any(|slot| {
                bytes[0x45c + slot * 0x110..0x45e + slot * 0x110]
                    .iter()
                    .any(|byte| *byte != 0)
            }))
        }),
        code: "save_empty".into(),
        message: "no Konami Krazy Racers file is initialized".into(),
        section_id: None,
        warning: None,
    });
    let mut groups = Vec::new();
    for slot in 0..3 {
        let base = slot * 0x110;
        let active = rules::Condition::new(move |bytes| {
            Ok(bytes[base + 0x45c] != 0 || bytes[base + 0x45d] != 0)
        });
        let id = format!("slot_{}", slot + 1);
        let behavior = field::FieldBehavior {
            group: Some(id.clone()),
            present_when: Some(active.clone()),
            editable_when: Some(active.clone()),
            ..Default::default()
        };
        game.fields.push(
            FieldDefinition::new(
                format!("{id}.coins"),
                format!("Slot {} coins", slot + 1),
                base + 0x48c,
                Storage::U16Le,
            )
            .max(999)
            .behavior(behavior.clone()),
        );
        for (offset, item) in [
            (0x49a, "eye_wrap"),
            (0x49b, "time_bomber"),
            (0x49c, "scooper_drill"),
            (0x49d, "barrier"),
            (0x49e, "blue_missile"),
            (0x49f, "red_missile"),
            (0x4a0, "ice_crash"),
            (0x4a2, "electric_battery"),
            (0x4a3, "pigs"),
        ] {
            game.fields.push(
                FieldDefinition::new(
                    format!("{id}.items.{item}"),
                    format!("Slot {} {item} quantity", slot + 1),
                    base + offset,
                    Storage::U8,
                )
                .max(2)
                .behavior(behavior.clone()),
            );
        }
        for (bit, character) in [
            (6, "ebisumaru"),
            (5, "king"),
            (4, "vic_viper"),
            (3, "bear_tank"),
        ] {
            game.fields.push(
                FieldDefinition::new(
                    format!("{id}.unlocks.{character}"),
                    format!("Slot {} {character} unlocked", slot + 1),
                    base + 0x3df,
                    Storage::Bit,
                )
                .bit(bit)
                .behavior(behavior.clone()),
            );
        }
        let span = layout::Span {
            logical_offset: base + 0x3dc,
            physical_offset: base + 0x3dc,
            length: 0x110,
        };
        let checksum = ChecksumDefinition {
            start: Some(base + 0x3dc),
            length: Some(0x110),
            target: Some(0xffff),
            exclude: vec![ChecksumExclusion {
                offset: base + 0x4e8,
                length: 2,
            }],
            ..ChecksumDefinition::new(ChecksumAlgorithm::Sum16Le, base + 0x4e8)
        };
        groups.push(layout::Group {
            id,
            logical_offset: span.logical_offset,
            logical_length: span.length,
            copies: layout::Copies::Fixed {
                candidates: vec![
                    layout::Candidate {
                        spans: vec![span],
                        predicates: vec![rules::Condition::new(move |bytes| {
                            Ok(bytes[base + 0x45c] == 0 && bytes[base + 0x45d] == 0)
                        })],
                        ..Default::default()
                    },
                    layout::Candidate {
                        spans: vec![span],
                        predicates: vec![active],
                        checksums: vec![checksum.clone()],
                        repairs: vec![layout::Repair::Checksum { checksum }],
                        ..Default::default()
                    },
                ],
            },
            selection: layout::Selection::FirstValid,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        });
    }
    game.runtime.layout = Some(layout::Layout { groups });
    let failure = runtime::Failure {
        code: "save_checksum".into(),
        message: "an initialized Konami Krazy Racers file has an invalid checksum".into(),
    };
    game.runtime.recovery = Some(runtime::Recovery {
        no_valid: failure.clone(),
        incomplete: None,
        damaged: None,
        differing: None,
        unrecoverable: Some(runtime::RecoveryOutcome {
            state: SaveIntegrityState::Invalid,
            disable_editing: true,
            issue: Some(failure.clone()),
            warning: None,
            field_warning: None,
            edit_error: Some(failure.clone()),
            parse_error: Some(failure),
            section_id: false,
        }),
        active_group: false,
        zero_counter: false,
    });
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], slot: usize) {
        let base = slot * 0x110;
        let sum: u16 = bytes[base + 0x3dc..base + 0x4ec]
            .iter()
            .enumerate()
            .filter(|(index, _)| !matches!(*index, 0x10c | 0x10d))
            .map(|(_, byte)| u16::from(*byte))
            .sum();
        bytes[base + 0x4e8..base + 0x4ea].copy_from_slice(&(sum ^ 0xffff).to_le_bytes());
    }

    #[test]
    fn exact_coin_and_checksum_footprint_with_empty_file_preserved() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0xa5; 0x2000];
        bytes[..16].copy_from_slice(b"KRAZY  ACERS    ");
        bytes[0x45c..0x45e].fill(0);
        repair(&mut bytes, 1);
        repair(&mut bytes, 2);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let edits = [SaveEdit {
            field: "slot_2.coins".into(),
            value: SaveValue::U32(999),
        }];
        let out = handler
            .apply(&input, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = input.bytes.clone();
        expected[0x59c..0x59e].copy_from_slice(&999u16.to_le_bytes());
        repair(&mut expected, 1);
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
        for position in [0, 0x5f8, 0x708] {
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
        assert!(
            handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "slot_1.coins".into(),
                        value: SaveValue::U32(1)
                    }],
                    false
                )
                .is_err()
        );
        let mut empty = input;
        for slot in 0..3 {
            empty.bytes[0x45c + slot * 0x110..0x45e + slot * 0x110].fill(0);
        }
        assert!(handler.apply(&empty, &identity, &edits, false).is_err());
    }
}
