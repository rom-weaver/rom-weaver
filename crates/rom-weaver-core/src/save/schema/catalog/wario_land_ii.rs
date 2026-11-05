use super::*;

// Source layout and rolling-section checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/wario-land-ii/saveEditor
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/wario-land-ii/saveEditor
const SAVE_SIZE: usize = 32768;
const SECTION_COUNT: usize = 6;
const SECTION_STRIDE: usize = 0x200;
const DATA_OFFSET: usize = 0x404;
const LOGICAL_SIZE: usize = 0x159;
const STAGES: usize = 50;
// Per-stage flag bitfields, relative to the section start (upstream offset - 0x404).
const TREASURE_OFFSET: usize = 0x04;
const PICTURE_PANEL_OFFSET: usize = 0x13;
const UNLOCKED_OFFSET: usize = 0x1a;
const CLEARED_OFFSET: usize = 0x22;
const ENDING_OFFSET: usize = 0x21;

const CHAPTERS: [&str; 10] = [
    "Chapter 1: One Noisy Morning",
    "Chapter 2: SS Tea Cup",
    "Chapter 3: Maze Woods",
    "Chapter 4: In Town",
    "Final Chapter: Syrup Castle",
    "Chapter 2: Invade Wario Castle",
    "Chapter 2: Go to the cellar",
    "Chapter 3: Ruins at the Bottom...",
    "Final Chapter: Uncanny Mansion",
    "Final Chapter: Mysterious Factory!",
];

// Chapters whose last stage also sets a hidden "ending" bit (bit index in the ending byte) when
// it is cleared. The game checks it, so clearing the last stage MUST keep the bit in sync.
const ENDINGS: [(usize, u8); 5] = [(4, 0), (5, 1), (7, 2), (8, 3), (9, 4)];

const TREASURES: [&str; STAGES] = [
    "Viking Helmet",
    "Bed",
    "Purple Thing",
    "Red Jar",
    "Glove",
    "Winged Boot",
    "Sword",
    "Gem",
    "Wing",
    "Scroll",
    "Seed",
    "Bow",
    "Apple",
    "Mask",
    "Bananas",
    "Ocarina",
    "CD",
    "Yo-yo",
    "Pipe",
    "Moped",
    "Cane",
    "Cloak",
    "Crystal Ball",
    "Pendant",
    "Crown",
    "Pill",
    "Lens",
    "Egg",
    "Brush",
    "Daruma",
    "Torch",
    "Green Star",
    "Crescent",
    "Amulet",
    "Horn",
    "Relic",
    "Trident",
    "Coral",
    "Lightning Bolt",
    "Whale",
    "Clock",
    "Book",
    "Wine Glass",
    "Wine Bottle",
    "Skull",
    "Computer",
    "Gear",
    "Hourglass",
    "Snow Globe",
    "Game Boy",
];

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    build(vec![game()], BTreeMap::new(), true)
}

fn game() -> GameDefinition {
    let mut fields = vec![
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
    fields.extend(stage_fields());
    let mut game = GameDefinition {
        fields,
        description: concat!(
            "Edits counters, stage unlock/clear flags, treasures, picture panels, and the ",
            "final-chapter best time in the newest rolling save section and repairs its ",
            "additive checksum. Clearing a chapter's final stage also sets its hidden ending ",
            "bit. The derived completion percentages are not editable. Europe/USA/Japan layout."
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

fn bit_field(id: &str, label: &str, offset: usize, bit: usize) -> FieldDefinition {
    field(id, label, offset + bit / 8, Storage::Bit).bit((bit % 8) as u8)
}

// Fields address stages linearly: stage N uses bit N of each flag bitfield.
fn stage_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for (stage, treasure) in TREASURES.iter().enumerate() {
        let (chapter, step) = (stage / 5, stage % 5);
        let story = if step == 4 && ENDINGS.iter().any(|(index, _)| *index == chapter) {
            "Final Story".to_string()
        } else {
            format!("Story {}", step + 1)
        };
        let name = format!("{} - {story}", CHAPTERS[chapter]);
        let id = format!("stage_{:02}", stage + 1);
        fields.push(bit_field(
            &format!("{id}.unlocked"),
            &format!("{name} unlocked"),
            UNLOCKED_OFFSET,
            stage,
        ));
        let mut cleared = bit_field(
            &format!("{id}.cleared"),
            &format!("{name} cleared"),
            CLEARED_OFFSET,
            stage,
        );
        if let Some((_, ending)) = ENDINGS
            .iter()
            .find(|(index, _)| step == 4 && *index == chapter)
        {
            let (offset, bit, ending) = (CLEARED_OFFSET + stage / 8, stage % 8, *ending);
            cleared.behavior.on_edit.push(rules::Store {
                when: None,
                destination: rules::Scalar {
                    offset: ENDING_OFFSET,
                    storage: Storage::U8,
                    mask: Some(1 << ending),
                },
                value: rules::ReadValue::new(move |bytes| {
                    trace!(chapter, "synchronized Wario Land II ending bit");
                    Ok(i64::from(bytes[offset] >> bit & 1))
                }),
            });
        }
        fields.push(cleared);
        fields.push(bit_field(
            &format!("treasure.{}", id_part(treasure)),
            &format!("Treasure: {treasure}"),
            TREASURE_OFFSET,
            stage,
        ));
        let panel = format!(
            "{}{}",
            ['a', 'b', 'c', 'd', 'e'][chapter / 2],
            stage % 10 + 1
        );
        fields.push(bit_field(
            &format!("picture_panel.{panel}"),
            &format!("Picture panel {}", panel.to_uppercase()),
            PICTURE_PANEL_OFFSET,
            stage,
        ));
    }
    fields.push(bit_field(
        "time_attack_unlocked",
        "Really Final Chapter Time Attack unlocked",
        0x20,
        2,
    ));
    for (index, part) in ["first", "second", "third"].into_iter().enumerate() {
        fields.push(best_time(part, 0x2c + index));
    }
    fields
}

// A best-time byte that is not valid BCD reads as its raw value instead of making the whole
// document unreadable; writing a valid time replaces it. The raw write stores the binary value,
// then the store re-encodes it as BCD.
fn best_time(part: &str, offset: usize) -> FieldDefinition {
    let mut time = field(
        &format!("best_time.{part}"),
        &format!("Really Final Chapter best time {part} part"),
        offset,
        Storage::U8,
    )
    .min(0)
    .max(59);
    time.behavior.read = Some(rules::ReadValue::new(move |bytes| {
        let byte = bytes[offset];
        Ok(if byte >> 4 > 9 || byte & 15 > 9 {
            i64::from(byte)
        } else {
            i64::from(byte >> 4) * 10 + i64::from(byte & 15)
        })
    }));
    time.behavior.on_edit = vec![byte_store(offset, None, move |bytes| {
        bcd(i64::from(bytes[offset]))
    })];
    time
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

    fn edit(
        handler: &SchemaSaveHandler,
        input: &SaveDetectionInput,
        edits: &[(&str, SaveValue)],
    ) -> Result<Vec<u8>> {
        let identity = handler.definitions().remove(0).identity;
        let edits: Vec<_> = edits
            .iter()
            .map(|(field, value)| SaveEdit {
                field: (*field).into(),
                value: value.clone(),
            })
            .collect();
        Ok(handler
            .apply(input, &identity, &edits, false)?
            .bytes
            .expect("edit changes the save"))
    }

    // Independent of the module tables: upstream absolute offsets plus the section shift.
    fn set_bit(bytes: &mut [u8], section: usize, offset: usize, bit: u8, on: bool) {
        let at = offset + section * SECTION_STRIDE;
        if on {
            bytes[at] |= 1 << bit;
        } else {
            bytes[at] &= !(1 << bit);
        }
    }

    #[test]
    fn stage_treasure_panel_and_time_flags_edit_each_newest_section() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        for active in 0..SECTION_COUNT {
            let input = input(&identity, active);
            let out = edit(
                &handler,
                &input,
                &[
                    ("stage_01.unlocked", SaveValue::Bool(true)),
                    ("stage_06.unlocked", SaveValue::Bool(true)),
                    ("stage_50.unlocked", SaveValue::Bool(true)),
                    ("stage_02.cleared", SaveValue::Bool(true)),
                    ("stage_09.cleared", SaveValue::Bool(true)),
                    ("treasure.viking_helmet", SaveValue::Bool(true)),
                    ("treasure.game_boy", SaveValue::Bool(true)),
                    ("picture_panel.a10", SaveValue::Bool(true)),
                    ("picture_panel.e10", SaveValue::Bool(true)),
                    ("time_attack_unlocked", SaveValue::Bool(true)),
                    ("best_time.first", SaveValue::U32(59)),
                    ("best_time.second", SaveValue::U32(7)),
                    ("best_time.third", SaveValue::U32(0)),
                ],
            )
            .unwrap();
            let mut expected = input.bytes.clone();
            for (offset, bit) in [
                (0x41e, 0),
                (0x41e, 5),
                (0x424, 1),
                (0x426, 1),
                (0x427, 0),
                (0x408, 0),
                (0x40e, 1),
                (0x418, 1),
                (0x41d, 1),
                (0x424, 2),
            ] {
                set_bit(&mut expected, active, offset, bit, true);
            }
            let time = DATA_OFFSET + active * SECTION_STRIDE + 0x2c;
            expected[time..time + 3].copy_from_slice(&[0x59, 0x07, 0x00]);
            repair(&mut expected, active);
            assert_eq!(out, expected, "section {active}");
        }
    }

    #[test]
    fn clearing_a_chapter_final_stage_sets_and_clears_its_hidden_ending_bit() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        // (field, cleared byte, cleared bit, ending bit)
        let cases = [
            ("stage_25.cleared", 0x429, 0, 0),
            ("stage_30.cleared", 0x429, 5, 1),
            ("stage_40.cleared", 0x42a, 7, 2),
            ("stage_45.cleared", 0x42b, 4, 3),
            ("stage_50.cleared", 0x42c, 1, 4),
        ];
        for (field, byte, bit, ending) in cases {
            let input = input(&identity, 2);
            let out = edit(&handler, &input, &[(field, SaveValue::Bool(true))]).unwrap();
            let mut expected = input.bytes.clone();
            set_bit(&mut expected, 2, byte, bit, true);
            set_bit(&mut expected, 2, 0x425, ending, true);
            repair(&mut expected, 2);
            assert_eq!(out, expected, "{field} on");
            let reopened = SaveDetectionInput {
                bytes: out,
                ..input.clone()
            };
            let out = edit(&handler, &reopened, &[(field, SaveValue::Bool(false))]).unwrap();
            assert_eq!(out, input.bytes, "{field} off");
        }
        // A non-final stage leaves the ending bits alone.
        let input = input(&identity, 2);
        let out = edit(
            &handler,
            &input,
            &[("stage_24.cleared", SaveValue::Bool(true))],
        )
        .unwrap();
        assert_eq!(out[DATA_OFFSET + 2 * SECTION_STRIDE + 0x21], 0);
    }

    #[test]
    fn treasure_ids_keep_the_one_underscore_per_separator_form() {
        for treasure in TREASURES {
            let per_character: String = treasure
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() {
                        ch.to_ascii_lowercase()
                    } else {
                        '_'
                    }
                })
                .collect();
            assert_eq!(id_part(treasure), per_character, "{treasure}");
        }
    }

    #[test]
    fn invalid_bcd_best_time_keeps_the_document_readable_until_a_valid_time_is_written() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let input = input(&identity, 0);
        assert!(edit(&handler, &input, &[("best_time.first", SaveValue::U32(60))]).is_err());
        assert!(
            edit(
                &handler,
                &input,
                &[("best_time.third", SaveValue::U32(100))]
            )
            .is_err()
        );

        let time = DATA_OFFSET + 0x2c;
        let mut bad = input.clone();
        bad.bytes[time..time + 3].copy_from_slice(&[0x7a, 0x07, 0xff]);
        repair(&mut bad.bytes, 0);
        let document = handler.parse(&bad, &identity).unwrap();
        let value = |name: &str| {
            document
                .fields
                .iter()
                .find(|field| field.id == name)
                .unwrap_or_else(|| panic!("missing field {name}"))
                .value
                .clone()
        };
        assert_eq!(value("best_time.first"), SaveValue::U32(0x7a));
        assert_eq!(value("best_time.second"), SaveValue::U32(7));
        assert_eq!(value("best_time.third"), SaveValue::U32(0xff));
        assert_eq!(value("stage_coins"), SaveValue::U32(0));

        let out = edit(
            &handler,
            &bad,
            &[
                ("stage_coins", SaveValue::U32(12)),
                ("best_time.first", SaveValue::U32(45)),
            ],
        )
        .unwrap();
        let mut expected = bad.bytes.clone();
        expected[DATA_OFFSET + 0x0e..DATA_OFFSET + 0x10].copy_from_slice(&[0x00, 0x12]);
        expected[time..time + 3].copy_from_slice(&[0x45, 0x07, 0xff]);
        repair(&mut expected, 0);
        assert_eq!(out, expected);
        assert!(edit(&handler, &bad, &[("best_time.third", SaveValue::U32(60))]).is_err());
    }
}
