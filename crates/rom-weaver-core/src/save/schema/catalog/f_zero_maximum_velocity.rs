use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;

// Layout and checksum algorithms: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/f-zero-maximum-velocity/saveEditor
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/f-zero-maximum-velocity/saveEditor

const SERIES: [&str; 4] = ["pawn", "knight", "bishop", "queen"];
const DIFFICULTIES: [&str; 4] = ["beginner", "standard", "expert", "master"];

// (machine index stored in the save, name); the Beginner/Standard/Expert/Master clear flags of
// machine N live at two bytes starting at `0x18 + 2 + 2 * N` in the slot.
const MACHINES: [(i64, &str); 10] = [
    (4, "Hot Violet"),
    (0, "Fire Ball"),
    (3, "J.B.Crystal"),
    (2, "Wind Walker"),
    (1, "Sly Joker"),
    (7, "The Stringray"),
    (6, "Silver Thunder"),
    (5, "Falcon Mk-II"),
    (8, "Fighting Comet"),
    (9, "Jet Vermilion"),
];

// (course index in the save, course name); ranking data is addressed by this index.
const COURSES: [(usize, &str); 21] = [
    (0x0b, "Pawn: Bianca City 1"),
    (0x08, "Pawn: Stark Farm 1"),
    (0x0c, "Pawn: Empyrean Colony 1"),
    (0x0e, "Pawn: Stark Farm 2"),
    (0x03, "Pawn: Cloud Carpet 1"),
    (0x00, "Knight: Tenth Zone East 1"),
    (0x01, "Knight: Beacon Port"),
    (0x09, "Knight: Synobazz"),
    (0x0f, "Knight: Ancient Mesa 1"),
    (0x12, "Knight: Stark Farm 3"),
    (0x06, "Bishop: Bianca City 2"),
    (0x05, "Bishop: Ancient Mesa 2"),
    (0x0a, "Bishop: Crater Land 1"),
    (0x04, "Bishop: Cloud Carpet 2"),
    (0x13, "Bishop: Bianca City 3"),
    (0x07, "Queen: Crater Land 2"),
    (0x10, "Queen: Tenth Zone East 2"),
    (0x0d, "Queen: Empyrean Colony 2"),
    (0x02, "Queen: Fire Field 1"),
    (0x11, "Queen: Fire Field 2"),
    (0x14, "Championship: Synobazz"),
];

fn machine_choices() -> Vec<FieldChoice> {
    MACHINES
        .iter()
        .map(|(value, name)| FieldChoice {
            name: id_part(name),
            value: *value,
        })
        .collect()
}

fn id_part(label: &str) -> String {
    let mut out = String::new();
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    out.trim_end_matches('_').to_string()
}

// A ranking entry is a 1/100 s time (u16) followed by a byte whose high nibble is the machine.
// The machine is only meaningful, and only editable, when the entry holds a time.
fn ranking_fields(prefix: &str, label: &str, offset: usize) -> [FieldDefinition; 2] {
    trace!(prefix, offset, "adding F-Zero ranking entry fields");
    [
        catalog_field(
            &format!("{prefix}.time"),
            &format!("{label} time (1/100 s)"),
            offset,
            Storage::U16Le,
        )
        .min(0)
        .max(59_999),
        catalog_field(
            &format!("{prefix}.machine"),
            &format!("{label} machine (needs a time)"),
            offset + 2,
            Storage::U8,
        )
        .mask(0xf0)
        .choices(machine_choices())
        .behavior(field::FieldBehavior {
            editable_when: Some(Condition::new(move |bytes| {
                Ok(u16::from_le_bytes([bytes[offset], bytes[offset + 1]]) != 0)
            })),
            ..Default::default()
        }),
    ]
}

fn slot_extra_fields(slot: usize, base: usize) -> Vec<FieldDefinition> {
    let prefix = format!("slot_{}", slot + 1);
    let mut fields = vec![
        catalog_field(
            &format!("{prefix}.unlocked_machines"),
            &format!(
                "Slot {} unlocked machine count (Sly Joker to Fighting Comet)",
                slot + 1
            ),
            base + 0x17,
            Storage::U8,
        )
        .mask(0x07)
        .max(5),
        catalog_field(
            &format!("{prefix}.options.spare_machines"),
            &format!("Slot {} spare machines", slot + 1),
            base + 0x16,
            Storage::U8,
        )
        .mask(0x70)
        .choices(choices(&[("x5", 0), ("x3", 1), ("x1", 2)])),
        catalog_field(
            &format!("{prefix}.options.controller"),
            &format!("Slot {} controller type", slot + 1),
            base + 0x16,
            Storage::U8,
        )
        .mask(0x0f)
        .choices(choices(&[
            ("type-1", 0),
            ("type-2", 1),
            ("type-3", 2),
            ("type-4", 3),
            ("type-5", 4),
            ("type-6", 5),
        ])),
        catalog_field(
            &format!("{prefix}.options.music"),
            &format!("Slot {} music enabled", slot + 1),
            base + 0x16,
            Storage::Bit,
        )
        .bit(7)
        .inverted(true),
    ];
    for (series, name) in SERIES.iter().enumerate() {
        for circuit in 0..4 {
            let index = series * 4 + circuit;
            fields.push(
                catalog_field(
                    &format!("{prefix}.circuit.{name}_{}", circuit + 1),
                    &format!("Slot {} cleared circuit: {name} {}", slot + 1, circuit + 1),
                    base + 0x18 + index / 8,
                    Storage::Bit,
                )
                .bit((index % 8) as u8),
            );
        }
    }
    for (machine, machine_name) in MACHINES {
        for (difficulty, difficulty_name) in DIFFICULTIES.iter().enumerate() {
            for (series, series_name) in SERIES.iter().enumerate() {
                fields.push(
                    catalog_field(
                        &format!(
                            "{prefix}.clear.{difficulty_name}.{}.{series_name}",
                            id_part(machine_name)
                        ),
                        &format!(
                            "Slot {} {difficulty_name} {series_name} cleared with {machine_name}",
                            slot + 1
                        ),
                        base + 0x1a + machine as usize * 2 + series / 2,
                        Storage::Bit,
                    )
                    .bit((difficulty + (series % 2) * 4) as u8),
                );
            }
        }
    }
    for (course, name) in COURSES {
        let course_prefix = format!("{prefix}.ranking.course_{course:02}");
        let label = format!("Slot {} {name}", slot + 1);
        fields.extend(ranking_fields(
            &format!("{course_prefix}.best_lap"),
            &format!("{label} best lap"),
            base + 0x2a6 + course * 3,
        ));
        for place in 0..10 {
            fields.extend(ranking_fields(
                &format!("{course_prefix}.place_{:02}", place + 1),
                &format!("{label} place {}", place + 1),
                base + 0x30 + course * 0x1e + place * 3,
            ));
        }
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for slot in 0..3 {
        let base = 0x48b0 + slot * 0x330;
        let prefix = format!("slot_{}", slot + 1);
        fields.push(FieldDefinition::new(
            format!("{prefix}.championship_clear_count"),
            format!("Slot {} Championship clear count", slot + 1),
            base + 0x2e,
            Storage::U8,
        ));
        fields.push(
            FieldDefinition::new(
                format!("{prefix}.queen_class"),
                format!("Slot {} Queen Class unlocked", slot + 1),
                base + 0x17,
                Storage::Bit,
            )
            .bit(6),
        );
        fields.push(
            FieldDefinition::new(
                format!("{prefix}.championship"),
                format!("Slot {} Championship unlocked", slot + 1),
                base + 0x17,
                Storage::Bit,
            )
            .bit(7),
        );
        fields.push(
            FieldDefinition::new(
                format!("{prefix}.jet_vermilion"),
                format!("Slot {} Jet Vermilion unlocked", slot + 1),
                base + 0x17,
                Storage::Bit,
            )
            .bit(5),
        );
    }
    for slot in 0..3 {
        fields.extend(slot_extra_fields(slot, 0x48b0 + slot * 0x330));
    }
    let ranges = [
        (0x4010, 0x48b0, 0x4008, 0x400c),
        (0x48c0, 0x4be0, 0x48b8, 0x48bc),
        (0x4bf0, 0x4f10, 0x4be8, 0x4bec),
        (0x4f20, 0x5240, 0x4f18, 0x4f1c),
    ];
    let mut checks = Vec::new();
    let mut stores = Vec::new();
    for (start, end, sum_offset, count_offset) in ranges {
        checks.push(check(
            sum_offset,
            move |bytes| sum_words(bytes, start, end),
            "sum",
        ));
        checks.push(check(
            count_offset,
            move |bytes| count_words(bytes, start, end),
            "count",
        ));
        stores.push(store(sum_offset, move |bytes| sum_words(bytes, start, end)));
        stores.push(store(count_offset, move |bytes| {
            count_words(bytes, start, end)
        }));
    }
    for (offset, starts) in [
        (0x7658, [0x4008, 0x48b8, 0x4be8, 0x4f18, 0x5248]),
        (0x765c, [0x400c, 0x48bc, 0x4bec, 0x4f1c, 0x524c]),
    ] {
        checks.push(check(
            offset,
            move |bytes| sparse_sum(bytes, starts),
            "summary",
        ));
        stores.push(store(offset, move |bytes| sparse_sum(bytes, starts)));
    }
    let mut game = GameDefinition { fields, description: "Edits unlocks, Championship clear counts, circuit and machine clears, options, and ranking times with machines in three save slots. Packed player names and the mixed rankings are omitted.".into(), signatures: vec![SignatureDefinition { offset: 4, bytes: vec![0xe8, 0xb4, 0xa6, 0x19] }], ..GameDefinition::new("f-zero-maximum-velocity".into(), "F-Zero: Maximum Velocity".into(), "game-boy-advance".into(), 32768) };
    game.runtime.checks = checks.clone();
    game.runtime.recognition = Some(runtime::Recognition {
        checks,
        reasons: vec![
            SaveRecognitionReason::ChecksumValid,
            SaveRecognitionReason::SignatureValid,
        ],
        confidence: SaveRecognitionConfidence::High,
        incomplete_confidence: None,
        selected_reason: true,
        empty_top_level_reasons: false,
    });
    game.runtime.after_edit = stores;
    build(vec![game], BTreeMap::new(), true)
}

fn sum_words(bytes: &[u8], start: usize, end: usize) -> Result<i64> {
    Ok(i64::from(
        bytes[start..end].chunks_exact(4).fold(0u32, |sum, word| {
            sum.wrapping_add(u32::from_le_bytes(word.try_into().unwrap()))
        }),
    ))
}
fn count_words(bytes: &[u8], start: usize, end: usize) -> Result<i64> {
    Ok(bytes[start..end]
        .chunks_exact(4)
        .filter(|word| word.iter().any(|byte| *byte != 0))
        .count() as i64)
}
fn sparse_sum(bytes: &[u8], starts: [usize; 5]) -> Result<i64> {
    Ok(i64::from(starts.into_iter().fold(0u32, |sum, offset| {
        sum.wrapping_add(u32::from_le_bytes(
            bytes[offset..offset + 4].try_into().unwrap(),
        ))
    })))
}
fn check(
    offset: usize,
    expected: impl Fn(&[u8]) -> Result<i64> + Send + Sync + 'static,
    label: &str,
) -> Check {
    Check {
        when: None,
        assert: Condition::new(move |bytes| {
            Ok(i64::from(u32::from_le_bytes(
                bytes[offset..offset + 4].try_into().unwrap(),
            )) == expected(bytes)?)
        }),
        code: "save_checksum".into(),
        message: format!("the F-Zero {label} checksum is invalid"),
        section_id: None,
        warning: None,
    }
}
fn store(offset: usize, value: impl Fn(&[u8]) -> Result<i64> + Send + Sync + 'static) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset,
            storage: Storage::U32Le,
            mask: None,
        },
        value: ReadValue::new(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn repair(bytes: &mut [u8]) {
        for (start, end, sum, count) in [
            (0x4010, 0x48b0, 0x4008, 0x400c),
            (0x48c0, 0x4be0, 0x48b8, 0x48bc),
            (0x4bf0, 0x4f10, 0x4be8, 0x4bec),
            (0x4f20, 0x5240, 0x4f18, 0x4f1c),
        ] {
            let a = sum_words(bytes, start, end).unwrap() as u32;
            let c = count_words(bytes, start, end).unwrap() as u32;
            bytes[sum..sum + 4].copy_from_slice(&a.to_le_bytes());
            bytes[count..count + 4].copy_from_slice(&c.to_le_bytes());
        }
        for (o, s) in [
            (0x7658, [0x4008, 0x48b8, 0x4be8, 0x4f18, 0x5248]),
            (0x765c, [0x400c, 0x48bc, 0x4bec, 0x4f1c, 0x524c]),
        ] {
            let v = sparse_sum(bytes, s).unwrap() as u32;
            bytes[o..o + 4].copy_from_slice(&v.to_le_bytes());
        }
    }
    #[test]
    fn repairs_word_sum_nonzero_count_and_summary_checksums() {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0; 32768];
        bytes[4..8].copy_from_slice(&[0xe8, 0xb4, 0xa6, 0x19]);
        bytes[0x4010..0x5240].fill(1);
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
                    field: "slot_2.championship_clear_count".into(),
                    value: SaveValue::U32(9),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(out[0x4c0e], 9);
        let mut expected = input.bytes.clone();
        expected[0x4c0e] = 9;
        repair(&mut expected);
        assert_eq!(out, expected);
        assert!(h.apply(&input, &id, &[], false).unwrap().bytes.is_none());
        let mut bad = input;
        bad.bytes[0x4008] ^= 1;
        let recognition = h.recognize(&bad);
        assert!(matches!(
            recognition.outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
        assert!(
            recognition
                .reasons
                .contains(&SaveRecognitionReason::ChecksumMismatch)
        );
        assert!(h.apply(&bad, &id, &[], false).is_err());
    }

    fn fixture(fill: u8) -> (SchemaSaveHandler, SaveGameIdentity, SaveDetectionInput) {
        let h = schemas().remove(0);
        let id = h.definitions().remove(0).identity;
        let mut bytes = vec![0; 32768];
        bytes[4..8].copy_from_slice(&[0xe8, 0xb4, 0xa6, 0x19]);
        bytes[0x4010..0x5240].fill(fill);
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(id.id.clone()),
            rom_sha1: None,
        };
        (h, id, input)
    }

    fn run(
        fixture: &(SchemaSaveHandler, SaveGameIdentity, SaveDetectionInput),
        edits: &[(&str, SaveValue)],
    ) -> Result<Vec<u8>> {
        let (h, id, input) = fixture;
        let edits: Vec<_> = edits
            .iter()
            .map(|(field, value)| SaveEdit {
                field: (*field).into(),
                value: value.clone(),
            })
            .collect();
        Ok(h.apply(input, id, &edits, false)?
            .bytes
            .expect("edit changes the save"))
    }

    #[test]
    fn slot_values_edit_their_bits_and_repair_every_checksum() {
        let fixture = fixture(0x01);
        let out = run(
            &fixture,
            &[
                ("slot_2.unlocked_machines", SaveValue::U32(5)),
                (
                    "slot_2.options.spare_machines",
                    SaveValue::Enum("x1".into()),
                ),
                (
                    "slot_2.options.controller",
                    SaveValue::Enum("type-6".into()),
                ),
                ("slot_2.options.music", SaveValue::Bool(false)),
                ("slot_2.circuit.knight_2", SaveValue::Bool(true)),
                (
                    "slot_2.clear.master.jet_vermilion.queen",
                    SaveValue::Bool(true),
                ),
                (
                    "slot_2.ranking.course_20.place_10.time",
                    SaveValue::U32(59_999),
                ),
                (
                    "slot_2.ranking.course_20.place_10.machine",
                    SaveValue::Enum("jet_vermilion".into()),
                ),
                (
                    "slot_2.ranking.course_00.best_lap.time",
                    SaveValue::U32(12_345),
                ),
            ],
        )
        .unwrap();
        let slot = 0x330;
        let mut expected = fixture.2.bytes.clone();
        expected[0x48c7 + slot] = 0x05;
        expected[0x48c6 + slot] = 0x20 | 0x05 | 0x80;
        expected[0x48c8 + slot] = 0x01 | 1 << 5;
        expected[0x48dd + slot] = 0x01 | 1 << 7;
        let place_10 = 0x48e0 + 0x14 * 0x1e + 9 * 3 + slot;
        expected[place_10..place_10 + 2].copy_from_slice(&59_999u16.to_le_bytes());
        expected[place_10 + 2] = 0x91;
        let best_lap = 0x4b56 + slot;
        expected[best_lap..best_lap + 2].copy_from_slice(&12_345u16.to_le_bytes());
        repair(&mut expected);
        assert_eq!(out, expected);
        // Slots are independent: a slot 1 edit leaves slots 2 and 3 byte-identical.
        let first = run(
            &fixture,
            &[("slot_1.circuit.pawn_1", SaveValue::Bool(false))],
        )
        .unwrap();
        assert_eq!(
            &first[0x48c0 + 0x330..0x4be0 + 0x330 * 2],
            &fixture.2.bytes[0x48c0 + 0x330..0x4be0 + 0x330 * 2]
        );
    }

    #[test]
    fn ranking_machine_needs_a_time_and_times_are_bounded() {
        let fixture = fixture(0x00);
        assert!(
            run(
                &fixture,
                &[(
                    "slot_1.ranking.course_00.place_01.machine",
                    SaveValue::Enum("fire_ball".into())
                )]
            )
            .is_err()
        );
        assert!(
            run(
                &fixture,
                &[(
                    "slot_1.ranking.course_00.place_01.time",
                    SaveValue::U32(60_000)
                )]
            )
            .is_err()
        );
        assert!(run(&fixture, &[("slot_1.unlocked_machines", SaveValue::U32(6))]).is_err());
        // The machine becomes editable once a previous edit stored a time.
        let timed = run(
            &fixture,
            &[("slot_1.ranking.course_00.place_01.time", SaveValue::U32(1))],
        )
        .unwrap();
        assert_eq!(timed[0x48e0], 1);
        let reopened = (
            fixture.0.clone(),
            fixture.1.clone(),
            SaveDetectionInput {
                bytes: timed,
                ..fixture.2.clone()
            },
        );
        let out = run(
            &reopened,
            &[(
                "slot_1.ranking.course_00.place_01.machine",
                SaveValue::Enum("hot_violet".into()),
            )],
        )
        .unwrap();
        assert_eq!(out[0x48e2], 0x40);
        let mut expected = reopened.2.bytes.clone();
        expected[0x48e2] = 0x40;
        repair(&mut expected);
        assert_eq!(out, expected);
    }
}
