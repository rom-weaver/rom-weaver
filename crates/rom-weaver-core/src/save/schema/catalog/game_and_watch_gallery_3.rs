use super::*;

use super::super::rules::{Condition, ReadValue, Scalar, Store};

// Layout and checksum: https://github.com/RyudoSynbios/game-tools-collection/tree/75ce8f848b628f202c50daa75d95dda58eb1f3a5/src/lib/templates/game-and-watch-gallery-3/saveEditor
// Deepened against: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/game-and-watch-gallery-3/saveEditor

const PENDING_FLAG_OFFSET: usize = 0x310;

// (id, label, [(difficulty id, offset)], digits): records store one decimal digit per byte.
type Record = (
    &'static str,
    &'static str,
    &'static [(&'static str, usize)],
    usize,
);

const RECORDS: [Record; 10] = [
    (
        "egg_classic",
        "Egg Classic",
        &[("easy", 0x33b), ("hard", 0x33f)],
        4,
    ),
    (
        "egg_modern",
        "Egg Modern",
        &[("easy", 0x343), ("hard", 0x347), ("very_hard", 0x34b)],
        4,
    ),
    (
        "greenhouse_classic",
        "Greenhouse Classic",
        &[("easy", 0x377), ("hard", 0x37b)],
        4,
    ),
    (
        "greenhouse_modern",
        "Greenhouse Modern",
        &[("easy", 0x37f), ("hard", 0x383), ("very_hard", 0x387)],
        4,
    ),
    (
        "turtle_bridge_classic",
        "Turtle Bridge Classic",
        &[("easy", 0x34f), ("hard", 0x353)],
        4,
    ),
    (
        "turtle_bridge_modern",
        "Turtle Bridge Modern",
        &[("easy", 0x357), ("hard", 0x35b), ("very_hard", 0x35f)],
        4,
    ),
    (
        "mario_bros_classic",
        "Mario Bros. Classic",
        &[("easy", 0x38b), ("hard", 0x38f)],
        4,
    ),
    (
        "mario_bros_modern",
        "Mario Bros. Modern",
        &[("easy", 0x393), ("hard", 0x397), ("very_hard", 0x39b)],
        4,
    ),
    (
        "donkey_kong_jr_classic",
        "Donkey Kong Jr. Classic",
        &[("easy", 0x363), ("hard", 0x367)],
        4,
    ),
    (
        "donkey_kong_jr_modern",
        "Donkey Kong Jr. Modern",
        &[("easy", 0x36b), ("hard", 0x36f), ("very_hard", 0x373)],
        4,
    ),
];

// The single-mode games only have Classic Easy and Classic Hard records; Judge keeps two digits.
const SINGLE_RECORDS: [Record; 5] = [
    ("flagman", "Flagman", &[("easy", 0x3af), ("hard", 0x3b3)], 4),
    ("judge", "Judge", &[("easy", 0x39f), ("hard", 0x3a3)], 2),
    ("lion", "Lion", &[("easy", 0x3bf), ("hard", 0x3c3)], 4),
    (
        "spitball_sparky",
        "Spitball Sparky",
        &[("easy", 0x3a7), ("hard", 0x3ab)],
        4,
    ),
    (
        "donkey_kong_ii",
        "Donkey Kong II",
        &[("easy", 0x3b7), ("hard", 0x3bb)],
        4,
    ),
];

fn digits_value(bytes: &[u8], offset: usize, digits: usize) -> i64 {
    bytes[offset..offset + digits]
        .iter()
        .fold(0i64, |sum, digit| sum * 10 + i64::from(*digit))
}

// Writes the value as `digits` decimal digit bytes; the field's own raw write is overwritten.
fn digit_score(id: &str, label: &str, offset: usize, digits: usize) -> FieldDefinition {
    let (storage, max) = if digits == 4 {
        (Storage::U32Be, 9999)
    } else {
        (Storage::U16Be, 99)
    };
    FieldDefinition::new(id.into(), label.into(), offset, storage)
        .min(0)
        .max(max)
        .behavior(field::FieldBehavior {
            read: Some(ReadValue::new(move |bytes| {
                Ok(digits_value(bytes, offset, digits))
            })),
            on_edit: vec![Store {
                when: None,
                destination: Scalar {
                    offset,
                    storage,
                    mask: None,
                },
                value: ReadValue::new(move |bytes| {
                    let value = bytes[offset..offset + digits]
                        .iter()
                        .fold(0i64, |sum, byte| (sum << 8) | i64::from(*byte));
                    trace!(offset, value, "storing Game & Watch Gallery 3 score digits");
                    Ok((0..digits).fold(0i64, |packed, index| {
                        let place = 10i64.pow((digits - 1 - index) as u32);
                        (packed << 8) | (value / place % 10)
                    }))
                }),
            }],
            ..Default::default()
        })
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = Vec::new();
    for (id, label, bit) in [
        ("flagman", "Flagman", 2),
        ("judge", "Judge", 0),
        ("lion", "Lion", 4),
        ("spitball_sparky", "Spitball Sparky", 1),
        ("donkey_kong_ii", "Donkey Kong II", 3),
    ] {
        fields.push(
            FieldDefinition::new(
                format!("unlocked.{id}"),
                format!("{label} unlocked"),
                0x3d4,
                Storage::Bit,
            )
            .bit(bit),
        );
    }
    for (id, label, offset) in [
        ("egg", "Egg", 0x32d),
        ("greenhouse", "Greenhouse", 0x333),
        ("turtle_bridge", "Turtle Bridge", 0x32f),
        ("mario_bros", "Mario Bros.", 0x335),
        ("donkey_kong_jr", "Donkey Kong Jr.", 0x331),
    ] {
        fields.push(
            FieldDefinition::new(
                format!("very_hard.{id}"),
                format!("{label} Very Hard mode available"),
                offset,
                Storage::Bit,
            )
            .bit(0),
        );
    }
    for (id, label, difficulties, digits) in RECORDS.iter().chain(&SINGLE_RECORDS) {
        for (difficulty, offset) in *difficulties {
            fields.push(digit_score(
                &format!("record.{id}.{difficulty}"),
                &format!("{label} {} record", difficulty.replace('_', " ")),
                *offset,
                *digits,
            ));
        }
    }
    // The pending-game block only holds data while a game is suspended.
    let pending = |mut field: FieldDefinition| {
        field.behavior.editable_when =
            Some(Condition::new(|bytes| Ok(bytes[PENDING_FLAG_OFFSET] != 0)));
        field
    };
    fields.push(pending(digit_score(
        "pending.score",
        "Pending game score",
        0x211,
        4,
    )));
    fields.push(pending(
        FieldDefinition::new(
            "pending.misses".into(),
            "Pending game misses".into(),
            0x215,
            Storage::U8,
        )
        .min(0)
        .max(2),
    ));
    build(vec![GameDefinition {
        fields,
        description: "Edits game unlocks, Very Hard mode flags, high scores for every game and mode, and the suspended game's score and misses. Requires a game-made template.".into(),
        signatures: vec![SignatureDefinition { offset: 0, bytes: vec![0x19, 0x97, 8, 0x19, 2] }],
        checksums: vec![ChecksumDefinition {
            start: Some(0), length: Some(0x600),
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Le, 0x600)
        }],
        ..GameDefinition::new("game-and-watch-gallery-3".into(), "Game & Watch Gallery 3".into(), "game-boy-color".into(), 8192)
    }], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repair(bytes: &mut [u8]) {
        let sum = bytes[..0x600]
            .iter()
            .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)));
        bytes[0x600..0x602].copy_from_slice(&sum.to_le_bytes());
    }

    #[test]
    fn flags_preserve_other_bits_and_repair_additive_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0xa5; 8192];
        bytes[..5].copy_from_slice(&[0x19, 0x97, 8, 0x19, 2]);
        repair(&mut bytes);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        let mut expected = input.bytes.clone();
        expected[0x3d4] &= !(1 << 2);
        expected[0x32d] &= !1;
        repair(&mut expected);
        let result = handler
            .apply(
                &input,
                &identity,
                &[
                    SaveEdit {
                        field: "unlocked.flagman".into(),
                        value: SaveValue::Bool(false),
                    },
                    SaveEdit {
                        field: "very_hard.egg".into(),
                        value: SaveValue::Bool(false),
                    },
                ],
                false,
            )
            .unwrap();
        assert_eq!(result.bytes.unwrap(), expected);
        let mut bad = input.clone();
        bad.bytes[0x600] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        bad = input.clone();
        bad.bytes[0] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
        assert!(
            handler
                .apply(&input, &identity, &[], true)
                .unwrap()
                .bytes
                .is_none()
        );
        assert!(handler.generate(&identity).is_err());
    }

    fn input(fill: u8) -> SaveDetectionInput {
        let mut bytes = vec![fill; 8192];
        bytes[..5].copy_from_slice(&[0x19, 0x97, 8, 0x19, 2]);
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("game-and-watch-gallery-3".into()),
            rom_sha1: None,
        }
    }

    fn run(input: &SaveDetectionInput, edits: &[(&str, SaveValue)]) -> Result<Vec<u8>> {
        let handler = schemas().remove(0);
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

    #[test]
    fn records_store_one_decimal_digit_per_byte_and_repair_the_checksum() {
        let mut start = input(0);
        start.bytes[0x310] = 1;
        start.bytes[0x33b..0x33f].copy_from_slice(&[9, 9, 9, 9]);
        repair(&mut start.bytes);
        let out = run(
            &start,
            &[
                ("record.egg_classic.easy", SaveValue::U32(7)),
                ("record.egg_modern.very_hard", SaveValue::U32(9999)),
                ("record.donkey_kong_ii.hard", SaveValue::U32(1000)),
                ("record.flagman.easy", SaveValue::U32(305)),
                ("record.judge.easy", SaveValue::U32(42)),
                ("record.judge.hard", SaveValue::U32(9)),
                ("pending.score", SaveValue::U32(120)),
                ("pending.misses", SaveValue::U32(2)),
            ],
        )
        .unwrap();
        let mut expected = start.bytes.clone();
        for (offset, digits) in [
            (0x33b, &[0, 0, 0, 7][..]),
            (0x34b, &[9, 9, 9, 9]),
            (0x3bb, &[1, 0, 0, 0]),
            (0x3af, &[0, 3, 0, 5]),
            (0x39f, &[4, 2]),
            (0x3a3, &[0, 9]),
            (0x211, &[0, 1, 2, 0]),
            (0x215, &[2]),
        ] {
            expected[offset..offset + digits.len()].copy_from_slice(digits);
        }
        repair(&mut expected);
        assert_eq!(out, expected);
        // Reading the edited save back reports the same scores.
        let reread = run(
            &SaveDetectionInput {
                bytes: out,
                ..start.clone()
            },
            &[("record.egg_classic.easy", SaveValue::U32(8))],
        )
        .unwrap();
        assert_eq!(&reread[0x33b..0x33f], &[0, 0, 0, 8]);
    }

    #[test]
    fn scores_reject_values_past_their_digit_width_and_idle_pending_edits() {
        let idle = input(0);
        assert!(run(&idle, &[("record.lion.easy", SaveValue::U32(10_000))]).is_err());
        assert!(run(&idle, &[("record.judge.easy", SaveValue::U32(100))]).is_err());
        assert!(run(&idle, &[("pending.score", SaveValue::U32(5))]).is_err());
        assert!(run(&idle, &[("pending.misses", SaveValue::U32(1))]).is_err());
        let mut busy = input(0);
        busy.bytes[0x310] = 1;
        repair(&mut busy.bytes);
        assert!(run(&busy, &[("pending.misses", SaveValue::U32(3))]).is_err());
    }
}
