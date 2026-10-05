use super::*;

// Layout, slot tags, linked gold preview, and byte sums: https://github.com/RyudoSynbios/game-tools-collection/tree/6f5d8064050eec83eb4f2a910743c121a70655c9/src/lib/templates/golden-sun/saveEditor
// The adjacent golden-sun-the-lost-age template at the same revision defines its 0x3000-byte records (MIT; LICENSE-GAME-TOOLS-COLLECTION).
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(
        (0..2)
            .flat_map(|version| (0..3).map(move |slot| game(version, slot)))
            .collect(),
        BTreeMap::new(),
        true,
    )
}

fn game(version: usize, slot: usize) -> GameDefinition {
    let title = if version == 0 {
        "Golden Sun"
    } else {
        "Golden Sun: The Lost Age"
    };
    let id = if version == 0 {
        "golden-sun"
    } else {
        "golden-sun-the-lost-age"
    };
    let mut game = GameDefinition::new(
        format!("{id}-file-{}", slot + 1),
        format!("{title} — File {}", slot + 1),
        "game-boy-advance".into(),
        0x10000,
    );
    game.description = "Edits gold with its save preview and the current step count in the selected initialized file of a raw 64 KiB Europe/USA/localized-Europe/Japan save. Uses the first matching physical slot tag, validates complete record byte sums, and preserves other files and records. Requires a game-made template; names, party, inventory, and wrappers are omitted.".into();
    let record_size = if version == 0 { 0x1000 } else { 0x3000 };
    game.fields = vec![
        FieldDefinition::new("gold".into(), "Gold".into(), 0x260, Storage::U32Le)
            .max(999999)
            .copies(vec![0x24]),
        FieldDefinition::new(
            "current_steps".into(),
            "Current steps".into(),
            if version == 0 { 0x48a } else { 0x4aa },
            Storage::U16Le,
        ),
    ];
    for field in &mut game.fields {
        field.behavior.group = Some("primary".into());
    }
    let mut groups = vec![group(
        "primary",
        0,
        record_size,
        slot,
        if version == 0 { 16 } else { 5 },
    )];
    if version == 0 {
        // The first game stores each file's second section under tag slot + 3; both sections MUST validate before an edit.
        groups.push(group("secondary", record_size, record_size, slot + 3, 16));
    }
    game.runtime.layout = Some(layout::Layout { groups });
    let failure = runtime::Failure {
        code: "save_checksum".into(),
        message: "the selected Golden Sun file has a missing or invalid section".into(),
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
    game
}

fn group(id: &str, logical: usize, length: usize, tag: usize, records: usize) -> layout::Group {
    let candidates = (0..records)
        .map(|record| {
            let base = record * length;
            let checksum = ChecksumDefinition {
                start: Some(base + 0x10),
                length: Some(length - 0x10),
                ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, base + 8)
            };
            layout::Candidate {
                spans: vec![layout::Span {
                    logical_offset: logical,
                    physical_offset: base,
                    length,
                }],
                signatures: vec![layout::Signature {
                    offset: base,
                    bytes: b"CAMELOT".to_vec(),
                }],
                predicates: vec![rules::Condition::new(move |bytes| {
                    Ok(usize::from(bytes[base + 7]) == tag
                        && (0..record)
                            .all(|previous| usize::from(bytes[previous * length + 7]) != tag))
                })],
                checksums: vec![checksum.clone()],
                repairs: vec![layout::Repair::Checksum { checksum }],
                ..Default::default()
            }
        })
        .collect();
    layout::Group {
        id: id.into(),
        logical_offset: logical,
        logical_length: length,
        copies: layout::Copies::Fixed { candidates },
        selection: layout::Selection::FirstValid,
        write: layout::WritePolicy::Selected,
        empty: Vec::new(),
        empty_if_no_signature: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(bytes: &mut [u8], base: usize, length: usize, tag: usize) {
        bytes[base..base + 7].copy_from_slice(b"CAMELOT");
        bytes[base + 7] = tag as u8;
        let sum = bytes[base + 0x10..base + length]
            .iter()
            .fold(0u32, |sum, byte| sum + u32::from(*byte)) as u16;
        bytes[base + 8..base + 10].copy_from_slice(&sum.to_le_bytes());
    }

    #[test]
    fn all_selected_files_update_gold_preview_and_only_primary_checksum() {
        for version in 0..2 {
            for slot in 0..3 {
                let handler = schemas().remove(version * 3 + slot);
                let identity = handler.definitions().remove(0).identity;
                let length = if version == 0 { 0x1000 } else { 0x3000 };
                let mut bytes = vec![0xff; 0x10000];
                bytes[..length].fill(0);
                record(&mut bytes, 0, length, slot);
                if version == 0 {
                    bytes[length..length * 2].fill(0);
                    record(&mut bytes, length, length, slot + 3);
                }
                let input = SaveDetectionInput {
                    bytes,
                    selected_game: Some(identity.id.clone()),
                    rom_sha1: None,
                };
                let edits = [SaveEdit {
                    field: "gold".into(),
                    value: SaveValue::U32(987654),
                }];
                let out = handler
                    .apply(&input, &identity, &edits, false)
                    .unwrap()
                    .bytes
                    .unwrap();
                let mut expected = input.bytes.clone();
                for offset in [0x24, 0x260] {
                    expected[offset..offset + 4].copy_from_slice(&987654u32.to_le_bytes());
                }
                record(&mut expected, 0, length, slot);
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
                for offset in if version == 0 {
                    vec![0, 8, length + 8, length + 7]
                } else {
                    vec![0, 8, 7]
                } {
                    let mut bad = input.clone();
                    bad.bytes[offset] ^= 0x80;
                    assert!(handler.apply(&bad, &identity, &edits, false).is_err());
                }
                for size in [0, 0xffff, 0x10001] {
                    let bad = SaveDetectionInput {
                        bytes: vec![0; size],
                        ..input.clone()
                    };
                    assert!(handler.apply(&bad, &identity, &edits, false).is_err());
                }
                let empty = SaveDetectionInput {
                    bytes: vec![0xff; 0x10000],
                    ..input
                };
                assert!(handler.apply(&empty, &identity, &edits, false).is_err());
            }
        }
    }
}
