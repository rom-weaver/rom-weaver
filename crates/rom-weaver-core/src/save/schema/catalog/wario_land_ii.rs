use super::*;

// Source layout and rolling-section checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/wario-land-ii/saveEditor
const SAVE_SIZE: usize = 32768;
const SECTION_COUNT: usize = 6;
const SECTION_STRIDE: usize = 0x200;
const DATA_OFFSET: usize = 0x404;
const LOGICAL_SIZE: usize = 0x159;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(vec![game()], BTreeMap::new(), true)
}

fn game() -> GameDefinition {
    let fields = vec![
        field("progression", "Progression", 0x12, Storage::U8).choices(choices(&[
            ("in-progress", 0),
            ("game-clear", 1),
            ("100-percent", 2),
        ])),
        field("stage_coins", "Stage coins", 0x0e, Storage::BcdBe)
            .length(2)
            .max(999),
        field("total_coins", "Total coins", 0x0b, Storage::BcdBe)
            .length(3)
            .max(99_999),
        field(
            "flagman_dd_high_score",
            "Flagman D.D high score",
            0x31,
            Storage::BcdBe,
        )
        .length(2)
        .max(9999),
    ];
    let mut game = GameDefinition {
        fields,
        description: concat!(
            "Edits counters in the newest rolling save section and repairs its ",
            "additive checksum. Level, treasure, and picture-panel flags are omitted ",
            "because hidden-flag propagation is unsupported. Europe/USA/Japan layout."
        )
        .into(),
        ..GameDefinition::new(
            "wario-land-ii".into(),
            "Wario Land II".into(),
            "game-boy-color".into(),
            SAVE_SIZE,
        )
    };
    game.runtime.logical_size = Some(LOGICAL_SIZE);
    game.runtime.layout = Some(layout::Layout {
        groups: vec![layout::Group {
            id: "active".into(),
            logical_offset: 0,
            logical_length: LOGICAL_SIZE,
            copies: layout::Copies::Fixed {
                candidates: (0..SECTION_COUNT).map(candidate).collect(),
            },
            selection: layout::Selection::NewestCounter,
            write: layout::WritePolicy::Selected,
            empty: Vec::new(),
            empty_if_no_signature: false,
        }],
    });
    game
}

fn field(id: &str, label: &str, offset: usize, storage: Storage) -> FieldDefinition {
    FieldDefinition::new(id.into(), label.into(), offset, storage).behavior(field::FieldBehavior {
        group: Some("active".into()),
        ..Default::default()
    })
}

fn candidate(section: usize) -> layout::Candidate {
    let physical_offset = DATA_OFFSET + section * SECTION_STRIDE;
    let checksum_offset = [1, 5, 9, 3, 7, 11][section];
    let checksum_length = if matches!(section, 0 | 3) {
        0x33
    } else {
        LOGICAL_SIZE
    };
    layout::Candidate {
        spans: vec![layout::Span {
            logical_offset: 0,
            physical_offset,
            length: LOGICAL_SIZE,
        }],
        checksums: vec![ChecksumDefinition {
            start: Some(physical_offset),
            length: Some(checksum_length),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, checksum_offset)
        }],
        predicates: vec![rules::Condition::new(move |bytes| {
            let marker = bytes.get(0x400..0x404);
            if !matches!(
                marker,
                Some([5, 7, 5, 0x12] | [0x19, 0x64, 5, 7] | [0x1a, 0x65, 6, 8])
            ) {
                return Ok(false);
            }
            let mut best_section = 0;
            let mut best_count = 0;
            for index in 0..SECTION_COUNT {
                let offset = DATA_OFFSET + index * SECTION_STRIDE;
                let count = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap());
                if count != u32::MAX && count > best_count {
                    best_section = index;
                    best_count = count;
                }
            }
            Ok(best_section == section)
        })],
        counter: Some(rules::Scalar {
            offset: physical_offset,
            storage: Storage::U32Be,
            mask: None,
        }),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8], section: usize) {
        let base = DATA_OFFSET + section * SECTION_STRIDE;
        let length = if matches!(section, 0 | 3) {
            0x33
        } else {
            LOGICAL_SIZE
        };
        let sum = bytes[base..base + length]
            .iter()
            .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
        let offset = [1, 5, 9, 3, 7, 11][section];
        bytes[offset..offset + 2].copy_from_slice(&sum.to_be_bytes());
    }

    fn input(identity: &SaveGameIdentity, active: usize) -> SaveDetectionInput {
        let mut bytes = vec![0; SAVE_SIZE];
        bytes[0x400..0x404].copy_from_slice(&[5, 7, 5, 0x12]);
        for section in 0..SECTION_COUNT {
            let offset = DATA_OFFSET + section * SECTION_STRIDE;
            bytes[offset..offset + 4].copy_from_slice(&(section as u32 + 1).to_be_bytes());
        }
        let offset = DATA_OFFSET + active * SECTION_STRIDE;
        bytes[offset..offset + 4].copy_from_slice(&100u32.to_be_bytes());
        for section in 0..SECTION_COUNT {
            repair(&mut bytes, section);
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        }
    }

    #[test]
    fn edits_each_newest_section_and_repairs_its_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        for active in 0..SECTION_COUNT {
            let input = input(&identity, active);
            let mut expected = input.bytes.clone();
            let offset = DATA_OFFSET + active * SECTION_STRIDE + 0x0e;
            expected[offset..offset + 2].copy_from_slice(&[0x09, 0x99]);
            repair(&mut expected, active);
            let result = handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "stage_coins".into(),
                        value: SaveValue::U32(999),
                    }],
                    false,
                )
                .unwrap();
            assert_eq!(result.bytes.unwrap(), expected, "section {active}");
        }
    }

    #[test]
    fn rejects_corrupt_newest_unknown_marker_and_short_saves() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bad = input(&identity, 1);
        bad.bytes[DATA_OFFSET + SECTION_STRIDE + 4] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input(&identity, 1);
        bad.bytes[0x400] = 0;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input(&identity, 1);
        bad.bytes.pop();
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }
}
