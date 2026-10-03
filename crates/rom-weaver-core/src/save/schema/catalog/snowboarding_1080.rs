use super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

const BLOCKS: [(usize, usize, usize); 3] = [
    (8, 0x188, 0x188),
    (0x190, 0x1f0, 0x1f0),
    (0x1f8, 0x210, 0x210),
];
const MASTER_PARTS: [usize; 4] = [0x188, 0x1f0, 0x210, 0x228];

fn sum(bytes: &[u8], offset: usize) -> u32 {
    let ranges = if offset == 0 {
        MASTER_PARTS.map(|start| (start, start + 8)).to_vec()
    } else {
        BLOCKS
            .iter()
            .filter(|block| block.2 == offset)
            .map(|block| (block.0, block.1))
            .collect()
    };
    ranges
        .into_iter()
        .flat_map(|(start, end)| bytes[start..end].chunks_exact(4))
        .fold(0u32, |sum, word| {
            sum.wrapping_add(u32::from_be_bytes(word.try_into().unwrap()))
        })
}

fn checksum(bytes: &[u8], offset: usize) -> [u32; 2] {
    let sum = sum(bytes, offset);
    let base: u32 = if offset == 0 {
        0xded4_6000
    } else {
        0xec5b_c9a8
    };
    [
        0xf251_f205u32.wrapping_sub(sum),
        base.wrapping_add(sum.wrapping_mul(2)),
    ]
}

// Layout, linked contest totals, and checksums:
// https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/1080-snowboarding/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = vec![
        FieldDefinition::new(
            "progression".into(),
            "Progression".into(),
            0x1fb,
            Storage::U8,
        )
        .choices(choices(&[
            ("Not cleared", 1),
            ("Normal cleared", 2),
            ("Hard cleared", 3),
            ("Expert cleared", 4),
            ("Gold Boarder unlocked", 5),
        ])),
    ];
    let courses = [
        "Air Make",
        "Half Pipe",
        "Crystal Lake",
        "Crystal Peak",
        "Golden Forest",
        "Mountain Village",
        "Dragon Cave",
        "Deadly Fall",
    ];
    for (group, offset, first) in [
        ("unlocked", 0x1f9, 0),
        ("time_attack", 0x206, 2),
        ("trick_attack", 0x207, 0),
    ] {
        for (index, course) in courses.iter().enumerate().skip(first) {
            fields.push(
                FieldDefinition::new(
                    format!("{group}.course_{}", index + 1),
                    format!("{course} {group}"),
                    offset,
                    Storage::Bit,
                )
                .bit(index as u8),
            );
        }
    }
    for (index, trick) in [
        "Melancholy",
        "Lien Air",
        "Method",
        "Shifty",
        "Indy",
        "Tweak",
        "Nose Grab",
        "Tail Grab",
        "Stiffy",
        "Mute Grab",
        "Stalefish",
        "Indy Nosebone",
        "180 Air 1",
        "180 Air 2",
        "360 Air 1",
        "360 Air 2",
        "540 Air 1",
        "540 Air 2",
        "720 Air 1",
        "720 Air 2",
        "900 Air 1",
        "900 Air 2",
        "1080 Air 1",
        "1080 Air 2",
        "Front Flip",
        "Back Flip",
        "Panda Tweak 1",
        "Panda Tweak 2",
        "One Foot",
    ]
    .iter()
    .enumerate()
    {
        fields.push(
            FieldDefinition::new(
                format!("tricks.trick_{}", index + 1),
                (*trick).into(),
                0x1fe + index / 8,
                Storage::Bit,
            )
            .bit((index % 8) as u8),
        );
    }
    for rank in 0..3 {
        let base = 0x198 + rank * 0x20;
        for (index, course) in [
            "Crystal Lake",
            "Air Make",
            "Crystal Peak",
            "Half Pipe",
            "Golden Forest",
        ]
        .iter()
        .enumerate()
        {
            fields.push(
                FieldDefinition::new(
                    format!("contest.rank_{}.course_{}", rank + 1, index + 1),
                    format!("Rank {} {course} score", rank + 1),
                    base + index * 4,
                    Storage::U32Be,
                )
                .min(0)
                .max(999_999)
                .behavior(field::FieldBehavior {
                    on_edit: vec![Store {
                        when: None,
                        destination: Scalar {
                            offset: base + 0x14,
                            storage: Storage::U32Be,
                            mask: None,
                        },
                        value: ReadValue::new(move |bytes| {
                            Ok((0..5)
                                .map(|i| {
                                    u32::from_be_bytes(
                                        bytes[base + i * 4..base + i * 4 + 4].try_into().unwrap(),
                                    )
                                })
                                .fold(0u32, u32::wrapping_add)
                                .into())
                        }),
                    }],
                    ..Default::default()
                }),
            );
        }
        fields.push(
            FieldDefinition::new(
                format!("contest.rank_{}.total", rank + 1),
                format!("Rank {} total", rank + 1),
                base + 0x14,
                Storage::U32Be,
            )
            .editable(false),
        );
    }
    for (id, label, offset) in [
        ("music", "Music volume", 0x20a),
        ("effects", "Sound effect volume", 0x20b),
        ("voice", "Voice volume", 0x20c),
    ] {
        fields.push(
            FieldDefinition::new(format!("audio.{id}"), label.into(), offset, Storage::U8)
                .min(0)
                .max(10),
        );
    }
    fields.push(
        FieldDefinition::new("audio.mode".into(), "Sound mode".into(), 0x1fd, Storage::U8)
            .mask(3)
            .choices(choices(&[("Stereo", 0), ("Headset", 1), ("Mono", 2)])),
    );

    let mut checks = Vec::new();
    let mut after_edit = Vec::new();
    // The master checksum MUST be repaired after the section checksums it covers.
    for offset in [0x188, 0x1f0, 0x210, 0] {
        checks.push(Check {
            when: None,
            assert: Condition::new(move |bytes| {
                Ok((0..2).all(|half| {
                    bytes[offset + half * 4..offset + half * 4 + 4]
                        == checksum(bytes, offset)[half].to_be_bytes()
                }))
            }),
            code: "save_checksum_mismatch".into(),
            message: "1080 Snowboarding checksum does not match".into(),
            section_id: None,
            warning: None,
        });
        for half in 0..2 {
            after_edit.push(Store {
                when: None,
                destination: Scalar {
                    offset: offset + half * 4,
                    storage: Storage::U32Be,
                    mask: None,
                },
                value: ReadValue::new(move |bytes| Ok(checksum(bytes, offset)[half].into())),
            });
        }
    }
    build(vec![GameDefinition {
        fields,
        description: "Edits progression, course unlocks, tricks, contest scores, and audio in 32 KiB SRAM. Detects and preserves canonical or byte-swapped word order. Requires a game-made template.".into(),
        runtime: runtime::Runtime { checks: checks.clone(), after_edit,
            layout: Some(layout::Layout { groups: vec![layout::Group {
                id: "save".into(), logical_offset: 0, logical_length: 0x230,
                copies: layout::Copies::Fixed { candidates: vec![layout::Candidate {
                    spans: vec![layout::Span { logical_offset: 0, physical_offset: 0, length: 0x230 }],
                    predicates: checks.iter().map(|check| check.assert.clone()).collect(),
                    ..Default::default()
                }, swapped_candidate()] }, selection: layout::Selection::FirstValid, write: layout::WritePolicy::Selected,
                empty: vec![], empty_if_no_signature: false,
            }] }),
            recognition: Some(runtime::Recognition { checks,
                reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High,
                incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }),
            ..Default::default() },
        ..GameDefinition::new("1080-snowboarding".into(), "1080° Snowboarding".into(), "n64".into(), 0x8000)
    }], BTreeMap::new(), true)
}

fn swapped_candidate() -> layout::Candidate {
    layout::Candidate {
        spans: (0..0x230)
            .map(|offset| layout::Span {
                logical_offset: offset,
                physical_offset: offset ^ 3,
                length: 1,
            })
            .collect(),
        predicates: vec![Condition::new(|bytes| {
            let mut canonical = bytes[..0x230].to_vec();
            for word in canonical.chunks_exact_mut(4) {
                word.reverse();
            }
            Ok([0x188, 0x1f0, 0x210, 0].into_iter().all(|offset| {
                (0..2).all(|half| {
                    canonical[offset + half * 4..offset + half * 4 + 4]
                        == checksum(&canonical, offset)[half].to_be_bytes()
                })
            }))
        })],
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        for (start, end, offset) in BLOCKS.into_iter().chain([(0, 0, 0)]) {
            let words: Vec<_> = if offset == 0 {
                MASTER_PARTS.into_iter().flat_map(|i| [i, i + 4]).collect()
            } else {
                (start..end).step_by(4).collect()
            };
            let total: u64 = words
                .into_iter()
                .map(|i| u64::from(u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap())))
                .sum();
            bytes[offset..offset + 4]
                .copy_from_slice(&((0xf251_f205u64.wrapping_sub(total)) as u32).to_be_bytes());
            let base = if offset == 0 {
                0xded4_6000u64
            } else {
                0xec5b_c9a8u64
            };
            bytes[offset + 4..offset + 8]
                .copy_from_slice(&((base + 2 * total) as u32).to_be_bytes());
        }
    }

    #[test]
    fn edits_repair_sections_master_and_contest_total_without_changing_other_bytes() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0xa5; 0x8000];
        bytes[0x198..0x1b0].fill(0);
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x198..0x19c].copy_from_slice(&1234u32.to_be_bytes());
        expected[0x19c..0x1a0].copy_from_slice(&5678u32.to_be_bytes());
        expected[0x1ac..0x1b0].copy_from_slice(&6912u32.to_be_bytes());
        expected[0x1f9] |= 2;
        expected[0x20a] = 9;
        repair(&mut expected);
        let edits = [
            SaveEdit {
                field: "contest.rank_1.course_1".into(),
                value: SaveValue::U32(1234),
            },
            SaveEdit {
                field: "contest.rank_1.course_2".into(),
                value: SaveValue::U32(5678),
            },
            SaveEdit {
                field: "unlocked.course_2".into(),
                value: SaveValue::Bool(true),
            },
            SaveEdit {
                field: "audio.music".into(),
                value: SaveValue::U32(9),
            },
        ];
        assert!(
            handler
                .apply(&input, &identity, &edits, true)
                .unwrap()
                .bytes
                .is_none()
        );
        let result = handler.apply(&input, &identity, &edits, false).unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
        assert_eq!(result.document.integrity.state, SaveIntegrityState::Valid);
        assert!(handler.generate(&identity).is_err());
        assert!(
            handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "audio.music".into(),
                        value: SaveValue::U32(11),
                    }],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn rejects_corruption_and_wrong_sizes_and_preserves_word_order() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 0x8000];
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        assert!(matches!(
            handler.recognize(&input).outcome,
            SaveRecognitionOutcome::Recognized { .. }
        ));
        for offset in [0, 4, 0x188, 0x18c, 0x1f0, 0x1f4, 0x210, 0x214, 0x228, 0x1f9] {
            let mut bad = input.clone();
            bad.bytes[offset] ^= 1;
            assert!(matches!(
                handler.recognize(&bad).outcome,
                SaveRecognitionOutcome::Unsupported { .. }
            ));
            assert!(handler.apply(&bad, &identity, &[], false).is_err());
        }
        for size in [0, 0x230, 0x7fff, 0x8001] {
            let mut bad = input.clone();
            bad.bytes.resize(size, 0);
            assert!(handler.parse(&bad, &identity).is_err());
        }
        let mut swapped = input.clone();
        for word in swapped.bytes.chunks_exact_mut(4) {
            word.reverse();
        }
        let edit = [SaveEdit {
            field: "audio.music".into(),
            value: SaveValue::U32(7),
        }];
        let canonical_output = handler
            .apply(&input, &identity, &edit, false)
            .unwrap()
            .bytes
            .unwrap();
        let mut expected = canonical_output;
        for word in expected.chunks_exact_mut(4) {
            word.reverse();
        }
        assert_eq!(
            handler
                .apply(&swapped, &identity, &edit, false)
                .unwrap()
                .bytes
                .unwrap(),
            expected
        );
        let mut unselected = input;
        unselected.selected_game = None;
        assert!(matches!(
            handler.recognize(&unselected).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
    }
}
