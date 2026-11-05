use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;
use tracing::{debug, trace};

const COURSES: [(&str, &str); 16] = [
    ("luigi_raceway", "Luigi Raceway"),
    ("moo_moo_farm", "Moo Moo Farm"),
    ("koopa_troopa_beach", "Koopa Troopa Beach"),
    ("kalimari_desert", "Kalimari Desert"),
    ("toads_turnpike", "Toad's Turnpike"),
    ("frappe_snowland", "Frappe Snowland"),
    ("choco_mountain", "Choco Mountain"),
    ("mario_raceway", "Mario Raceway"),
    ("wario_stadium", "Wario Stadium"),
    ("sherbet_land", "Sherbet Land"),
    ("royal_raceway", "Royal Raceway"),
    ("bowsers_castle", "Bowser's Castle"),
    ("dks_jungle_parkway", "D.K.'s Jungle Parkway"),
    ("yoshi_valley", "Yoshi Valley"),
    ("banshee_boardwalk", "Banshee Boardwalk"),
    ("rainbow_road", "Rainbow Road"),
];
const CHARACTERS: [(&str, i64); 9] = [
    ("none", 0),
    ("mario", 1),
    ("luigi", 2),
    ("yoshi", 3),
    ("toad", 4),
    ("dk", 5),
    ("wario", 6),
    ("peach", 7),
    ("bowser", 8),
];
// A time-trial record the player never set stores this value in its whole 24-bit word.
const UNCLEARED: u32 = 0x0927c0;
const TIME_TRIAL_SIZE: usize = 0x18;
const BEST_RECORD_BLOCKS: [(usize, usize); 2] = [(0x188, 0x1be), (0x1c0, 0x1f6)];

fn gp_checksum(bytes: &[u8]) -> u16 {
    let sum = bytes[0x180..0x185]
        .iter()
        .enumerate()
        .fold(0u32, |sum, (index, byte)| {
            sum.wrapping_add((u32::from(*byte) + 1) * (index as u32 + 1) + index as u32)
        });
    finish_checksum(sum)
}

fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], 0])
}

// The 16-bit checksums store the low sum byte in the high byte and `0x5a` plus that byte, modulo
// 256, below. The game keeps the second byte separate, so the addition never carries upward.
fn finish_checksum(sum: u32) -> u16 {
    let low = sum & 0xff;
    ((low << 8) | ((0x5a + low) & 0xff)) as u16
}

fn time_trial_checksum(bytes: &[u8], base: usize) -> u8 {
    let checksum = bytes[base..base + 0x15]
        .iter()
        .enumerate()
        .fold(0u32, |sum, (index, byte)| {
            sum.wrapping_add(u32::from(*byte) * (index as u32 % 3 + 1) + index as u32 / 3)
        }) as u8;
    trace!(base, checksum, "computed Mario Kart 64 time-trial checksum");
    checksum
}

fn best_records_checksum(bytes: &[u8], start: usize) -> u16 {
    let sum = bytes[start..start + 0x33]
        .iter()
        .enumerate()
        .fold(0u32, |sum, (index, byte)| {
            let cup = index as u32 / 0x11;
            sum.wrapping_add((u32::from(*byte) + 1) * (cup + 1) + index as u32 % 0x11)
        });
    let checksum = finish_checksum(sum);
    trace!(
        start,
        checksum, "computed Mario Kart 64 best-record checksum"
    );
    checksum
}

// Course records past the eighth sit 0x20 bytes later; each block holds eight times then eight laps.
fn best_record_offset(course: usize, lap: bool) -> usize {
    let start = if course < 8 { 0x188 } else { 0x1c0 };
    start + course % 8 * 3 + if lap { 0x18 } else { 0 }
}

fn checksum_check(code: &str, message: &str, assert: Condition) -> Check {
    Check {
        when: None,
        assert,
        code: code.into(),
        message: message.into(),
        section_id: None,
        warning: None,
    }
}

fn record_store(destination: usize, value: ReadValue) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset: destination,
            storage: Storage::U24Le,
            mask: None,
        },
        value,
    }
}

// Characters are stored as the placing character minus one inside the time word, so a
// "none" record resets the whole word to the uncleared marker.
fn rewrite_word(offset: usize) -> Store {
    record_store(
        offset,
        ReadValue::new(move |bytes| {
            let raw = word(bytes, offset);
            let character = raw >> 20 & 0xf;
            let time = raw & 0xf_ffff;
            Ok(i64::from(if character == 0 {
                UNCLEARED
            } else {
                let time = if time == UNCLEARED { 0 } else { time };
                (character - 1) << 20 | time
            }))
        }),
    )
}

fn has_records(base: usize) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset: base + 0x12,
            storage: Storage::U8,
            mask: None,
        },
        value: ReadValue::new(move |bytes| {
            Ok(i64::from(
                (0..6).any(|slot| word(bytes, base + slot * 3) != UNCLEARED),
            ))
        }),
    }
}

fn copy_to_best(source: usize, destination: usize) -> Store {
    record_store(
        destination,
        ReadValue::new(move |bytes| Ok(i64::from(word(bytes, source)))),
    )
}

fn record_fields(
    course: usize,
    id: &str,
    label: &str,
    base: usize,
    slot: usize,
) -> Vec<FieldDefinition> {
    let offset = base + slot * 3;
    let mut writes = Vec::new();
    // Only the best time (first place) and the best lap mirror into the best-records area.
    let mirror = match slot {
        0 => Some(best_record_offset(course, false)),
        5 => Some(best_record_offset(course, true)),
        _ => None,
    };
    if let Some(destination) = mirror {
        writes.push(copy_to_best(offset, destination));
    }
    let mut character_writes = vec![rewrite_word(offset), has_records(base)];
    character_writes.extend(writes.clone());
    let character = catalog_field(
        &format!("{id}.character"),
        &format!("{label} character"),
        offset,
        Storage::U24Le,
    )
    .mask(0xf0_0000)
    .choices(choices(&CHARACTERS))
    .min(0)
    .max(8)
    .behavior(field::FieldBehavior {
        read: Some(ReadValue::new(move |bytes| {
            let raw = word(bytes, offset);
            Ok(if raw == UNCLEARED {
                0
            } else {
                i64::from(raw >> 20 & 7) + 1
            })
        })),
        on_edit: character_writes,
        ..Default::default()
    });
    let time = catalog_field(
        &format!("{id}.time"),
        &format!("{label} time (1/100 s)"),
        offset,
        Storage::U24Le,
    )
    .mask(0x0f_ffff)
    .min(0)
    .max(if slot == 5 { 599_999 } else { 359_999 })
    .behavior(field::FieldBehavior {
        read: Some(ReadValue::new(move |bytes| {
            let raw = word(bytes, offset);
            Ok(if raw == UNCLEARED {
                0
            } else {
                i64::from(raw & 0xf_ffff)
            })
        })),
        editable_when: Some(Condition::new(move |bytes| {
            Ok(word(bytes, offset) != UNCLEARED)
        })),
        on_edit: writes,
        ..Default::default()
    });
    vec![character, time]
}

// Layout and checksum rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/mario-kart-64/saveEditor
// Options, time trials, and best records, unchanged at: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/mario-kart-64/saveEditor
pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let cups = [
        ("mushroom", 0x03),
        ("flower", 0x0c),
        ("star", 0x30),
        ("special", 0xc0),
    ];
    let mut fields: Vec<FieldDefinition> = (0..4)
        .flat_map(|class| {
            cups.into_iter().map(move |(cup, mask)| {
                FieldDefinition::new(
                    format!("class_{}.{}_cup", class + 1, cup),
                    format!("Class {} {} Cup trophy", class + 1, cup),
                    0x180 + class,
                    Storage::U8,
                )
                .mask(mask)
                .max(3)
            })
        })
        .collect();
    fields.push(
        catalog_field("options.sound_mode", "Sound mode", 0x184, Storage::U8)
            .choices(choices(&[("stereo", 0), ("headphone", 1), ("mono", 3)]))
            .min(0)
            .max(3),
    );
    for (course, (slug, name)) in COURSES.into_iter().enumerate() {
        let base = course * TIME_TRIAL_SIZE;
        for slot in 0..6 {
            let (id, label) = if slot == 5 {
                (
                    format!("time_trial.{slug}.best_lap"),
                    format!("{name} best lap"),
                )
            } else {
                (
                    format!("time_trial.{slug}.place_{}", slot + 1),
                    format!("{name} place {}", slot + 1),
                )
            };
            fields.extend(record_fields(course, &id, &label, base, slot));
        }
    }
    debug!(fields = fields.len(), "built Mario Kart 64 save fields");
    let mut checks = vec![checksum_check(
        "mario_kart_64_gp_checksum",
        "the Mario GP checksum is invalid",
        Condition::new(|bytes| {
            Ok(u16::from_be_bytes([bytes[0x186], bytes[0x187]]) == gp_checksum(bytes))
        }),
    )];
    let mut stores = vec![Store {
        when: None,
        destination: Scalar {
            offset: 0x186,
            storage: Storage::U16Be,
            mask: None,
        },
        value: ReadValue::new(|bytes| Ok(i64::from(gp_checksum(bytes)))),
    }];
    for course in 0..COURSES.len() {
        let base = course * TIME_TRIAL_SIZE;
        checks.push(checksum_check(
            "mario_kart_64_time_trial_checksum",
            "a Mario Kart 64 time-trial checksum is invalid",
            Condition::new(move |bytes| Ok(bytes[base + 0x17] == time_trial_checksum(bytes, base))),
        ));
        stores.push(Store {
            when: None,
            destination: Scalar {
                offset: base + 0x17,
                storage: Storage::U8,
                mask: None,
            },
            value: ReadValue::new(move |bytes| Ok(i64::from(time_trial_checksum(bytes, base)))),
        });
    }
    for (start, offset) in BEST_RECORD_BLOCKS {
        checks.push(checksum_check(
            "mario_kart_64_best_records_checksum",
            "a Mario Kart 64 best-records checksum is invalid",
            Condition::new(move |bytes| {
                Ok(u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
                    == best_records_checksum(bytes, start))
            }),
        ));
        stores.push(Store {
            when: None,
            destination: Scalar {
                offset,
                storage: Storage::U16Be,
                mask: None,
            },
            value: ReadValue::new(move |bytes| Ok(i64::from(best_records_checksum(bytes, start)))),
        });
    }
    let game = GameDefinition {
        fields,
        description: "Edits Mario GP cup trophies, sound mode, and Time Trial records in normalized 16 Kbit EEPROM. Requires a game-made template.".into(),
        runtime: runtime::Runtime { require_selection: true, recognition: Some(runtime::Recognition { checks: checks.clone(), reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }), checks, after_edit: stores, save_format: Some("n64_eeprom_16k".into()), save_format_name: Some("Nintendo 64 EEPROM 16 Kbit".into()), ..Default::default() },
        ..GameDefinition::new("mario-kart-64".into(), "Mario Kart 64".into(), "nintendo-64".into(), 2048)
    };
    build(vec![game], BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ports of the upstream checksum loops, written without the module's helper functions. The game
    // stores `(low + 90) % 256` as the second byte, so the addition must not carry into the first.
    fn finish_literal(checksum: u64) -> u16 {
        let low = (checksum & 0xff) as u16;
        (low << 8) | ((0x5a + low) % 0x100)
    }
    fn upstream_gp(bytes: &[u8]) -> u16 {
        let mut checksum = 0u64;
        for (iteration, byte) in bytes[0x180..0x185].iter().enumerate() {
            checksum += (u64::from(*byte) + 1) * (iteration as u64 + 1) + iteration as u64;
        }
        finish_literal(checksum)
    }
    fn upstream_time_trials(bytes: &[u8], course: usize) -> u8 {
        let mut checksum = 0u64;
        for iteration in 0..0x15usize {
            checksum += u64::from(bytes[course * 0x18 + iteration]) * (iteration as u64 % 3 + 1)
                + iteration as u64 / 3;
        }
        (checksum & 0xff) as u8
    }
    fn upstream_best(bytes: &[u8], start: usize) -> u16 {
        let mut checksum = 0u64;
        for iteration in 0..0x33usize {
            checksum += (u64::from(bytes[start + iteration]) + 1) * (iteration as u64 / 0x11 + 1)
                + iteration as u64 % 0x11;
        }
        finish_literal(checksum)
    }
    fn repair(bytes: &mut [u8]) {
        let gp = upstream_gp(bytes);
        bytes[0x186..0x188].copy_from_slice(&gp.to_be_bytes());
        for course in 0..16 {
            bytes[course * 0x18 + 0x17] = upstream_time_trials(bytes, course);
        }
        for (start, offset) in [(0x188, 0x1be), (0x1c0, 0x1f6)] {
            let sum = upstream_best(bytes, start);
            bytes[offset..offset + 2].copy_from_slice(&sum.to_be_bytes());
        }
    }
    fn put_word(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 3].copy_from_slice(&value.to_le_bytes()[..3]);
    }
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x42; 2048];
        // Course 1 holds two records, course 9 holds none, the rest are uncleared.
        for course in 0..16 {
            for slot in 0..6 {
                put_word(&mut bytes, course * 0x18 + slot * 3, 0x0927c0);
            }
            bytes[course * 0x18 + 0x12] = 0;
        }
        put_word(&mut bytes, 0, 7 << 20 | 12_345);
        put_word(&mut bytes, 3, 2 << 20 | 20_000);
        put_word(&mut bytes, 0xf, 3 << 20 | 4_321);
        bytes[0x12] = 1;
        bytes[0x184] = 0;
        for (offset, value) in [
            (0x188, 7 << 20 | 12_345),
            (0x1a0, 3 << 20 | 4_321),
            (0x1c0, 0x0927c0),
            (0x1d8, 0x0927c0),
        ] {
            put_word(&mut bytes, offset, value);
        }
        repair(&mut bytes);
        SaveDetectionInput {
            bytes,
            selected_game: Some("mario-kart-64".into()),
            rom_sha1: None,
        }
    }
    fn edit(id: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: id.into(),
            value,
        }
    }
    fn parsed(input: &SaveDetectionInput, id: &str) -> SaveValue {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        handler
            .parse(input, &identity)
            .unwrap()
            .fields
            .into_iter()
            .find(|field| field.id == id)
            .unwrap_or_else(|| panic!("missing {id}"))
            .value
    }
    fn assert_valid_checksums(bytes: &[u8]) {
        assert_eq!(
            u16::from_be_bytes([bytes[0x186], bytes[0x187]]),
            upstream_gp(bytes)
        );
        for course in 0..16 {
            assert_eq!(
                bytes[course * 0x18 + 0x17],
                upstream_time_trials(bytes, course)
            );
        }
        for (start, offset) in [(0x188, 0x1be), (0x1c0, 0x1f6)] {
            assert_eq!(
                u16::from_be_bytes([bytes[offset], bytes[offset + 1]]),
                upstream_best(bytes, start)
            );
        }
    }

    #[test]
    fn edit_repairs_gp_checksum_and_preserves_other_records() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "class_1.special_cup".into(),
                    value: SaveValue::U32(3),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(bytes[0x180] >> 6, 3);
        assert_valid_checksums(&bytes);
        assert_eq!(&bytes[..0x180], &original.bytes[..0x180]);
        assert_eq!(&bytes[0x188..], &original.bytes[0x188..]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[0x181] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    // Expected bytes below were derived from the game's checksum routines (mk64 decomp src/save.c,
    // func_800B578C and func_800B5888), where the second byte is `(low + 90) % 256`.
    #[test]
    fn best_records_checksum_wraps_the_second_byte_like_the_game() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut original = input();
        // Every record is `c0 27 09` (uncleared) except Luigi Raceway's best 3-lap, `13 2c 00`.
        for chunk in original.bytes[0x188..0x1b8].chunks_exact_mut(3) {
            chunk.copy_from_slice(&[0xc0, 0x27, 0x09]);
        }
        original.bytes[0x188..0x18b].copy_from_slice(&[0x13, 0x2c, 0x00]);
        original.bytes[0x1b8..0x1bb].fill(0);
        // The byte sum ends in 0xa6, and 0xa6 + 0x5a is 0x100, which the game stores as `00`.
        original.bytes[0x1be..0x1c0].copy_from_slice(&[0xa6, 0x00]);
        assert_eq!(best_records_checksum(&original.bytes, 0x188), 0xa600);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[edit("options.sound_mode", SaveValue::Enum("mono".into()))],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&bytes[0x1be..0x1c0], &[0xa6, 0x00]);
    }

    #[test]
    fn gp_checksum_wraps_the_second_byte_like_the_game() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = vec![0; 2048];
        bytes[0x180..0x185].copy_from_slice(&[0x00, 0x00, 0x3f, 0x00, 0x00]);
        // The byte sum is 0xd6, and 0xd6 + 0x5a is 0x130, which the game stores as `30`.
        assert_eq!(gp_checksum(&bytes), 0xd630);
        // Headphone sound mode sums to 0xdb, stored as `db 35`.
        let mut source = input();
        source.bytes[0x180..0x185].copy_from_slice(&[0x00, 0x00, 0x3f, 0x00, 0x01]);
        source.bytes[0x186..0x188].copy_from_slice(&[0xdb, 0x35]);
        assert_eq!(
            parsed(&source, "options.sound_mode"),
            SaveValue::Enum("headphone".into())
        );
        let stereo = handler
            .apply(
                &source,
                &identity,
                &[edit("options.sound_mode", SaveValue::Enum("stereo".into()))],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(&stereo[0x180..0x185], &[0x00, 0x00, 0x3f, 0x00, 0x00]);
        assert_eq!(&stereo[0x186..0x188], &[0xd6, 0x30]);
    }

    #[test]
    fn schema_exposes_cups_sound_and_every_time_trial_record() {
        let handler = schemas().remove(0);
        assert_eq!(handler.game.fields.len(), 16 + 1 + 16 * 6 * 2);
        let original = input();
        assert_eq!(
            parsed(&original, "time_trial.luigi_raceway.place_1.character"),
            SaveValue::Enum("bowser".into())
        );
        assert_eq!(
            parsed(&original, "time_trial.luigi_raceway.place_1.time"),
            SaveValue::U32(12_345)
        );
        assert_eq!(
            parsed(&original, "time_trial.luigi_raceway.place_3.character"),
            SaveValue::Enum("none".into())
        );
        assert_eq!(
            parsed(&original, "time_trial.luigi_raceway.place_3.time"),
            SaveValue::U32(0)
        );
        assert_eq!(
            parsed(&original, "time_trial.luigi_raceway.best_lap.character"),
            SaveValue::Enum("toad".into())
        );
        assert_eq!(
            parsed(&original, "options.sound_mode"),
            SaveValue::Enum("stereo".into())
        );
    }

    #[test]
    fn time_trial_edits_mirror_best_records_and_repair_every_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let creation = [
            edit("options.sound_mode", SaveValue::Enum("mono".into())),
            // Wario Stadium: a record is created in an uncleared slot (course 9, index 8).
            edit(
                "time_trial.wario_stadium.place_1.character",
                SaveValue::Enum("wario".into()),
            ),
            edit(
                "time_trial.wario_stadium.best_lap.character",
                SaveValue::Enum("peach".into()),
            ),
            edit(
                "time_trial.rainbow_road.place_5.character",
                SaveValue::Enum("toad".into()),
            ),
            // Luigi Raceway place 2 only changes the time and does not touch best records.
            edit("time_trial.luigi_raceway.place_2.time", SaveValue::U32(0)),
        ];
        // A time is only editable once the record exists in the loaded save.
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[edit(
                        "time_trial.wario_stadium.place_1.time",
                        SaveValue::U32(1)
                    )],
                    false
                )
                .is_err()
        );
        let created = handler
            .apply(&original, &identity, &creation, false)
            .unwrap()
            .bytes
            .unwrap();
        let timed = SaveDetectionInput {
            bytes: created,
            ..original.clone()
        };
        let bytes = handler
            .apply(
                &timed,
                &identity,
                &[
                    edit(
                        "time_trial.wario_stadium.place_1.time",
                        SaveValue::U32(359_999),
                    ),
                    edit(
                        "time_trial.wario_stadium.best_lap.time",
                        SaveValue::U32(599_999),
                    ),
                ],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_valid_checksums(&bytes);
        let mut expected = original.bytes.clone();
        expected[0x184] = 3;
        // Wario Stadium is course index 8, whose best records start the second block.
        put_word(&mut expected, 8 * 0x18, 5 << 20 | 359_999);
        put_word(&mut expected, 8 * 0x18 + 0xf, 6 << 20 | 599_999);
        expected[8 * 0x18 + 0x12] = 1;
        put_word(&mut expected, 0x1c0, 5 << 20 | 359_999);
        put_word(&mut expected, 0x1d8, 6 << 20 | 599_999);
        put_word(&mut expected, 3, 2 << 20);
        put_word(&mut expected, 15 * 0x18 + 12, 3 << 20);
        expected[15 * 0x18 + 0x12] = 1;
        repair(&mut expected);
        assert_eq!(bytes, expected);
        let saved = SaveDetectionInput { bytes, ..original };
        assert_eq!(
            parsed(&saved, "time_trial.wario_stadium.best_lap.character"),
            SaveValue::Enum("peach".into())
        );
        assert_eq!(
            parsed(&saved, "time_trial.wario_stadium.best_lap.time"),
            SaveValue::U32(599_999)
        );
    }

    #[test]
    fn clearing_the_last_character_resets_the_record_and_has_records_flag() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let edits = [
            edit(
                "time_trial.luigi_raceway.place_1.character",
                SaveValue::Enum("none".into()),
            ),
            edit(
                "time_trial.luigi_raceway.place_2.character",
                SaveValue::Enum("none".into()),
            ),
            edit(
                "time_trial.luigi_raceway.best_lap.character",
                SaveValue::Enum("none".into()),
            ),
        ];
        let bytes = handler
            .apply(&original, &identity, &edits, false)
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(word(&bytes, 0), 0x0927c0);
        assert_eq!(word(&bytes, 3), 0x0927c0);
        assert_eq!(word(&bytes, 0xf), 0x0927c0);
        assert_eq!(bytes[0x12], 0);
        assert_eq!(word(&bytes, 0x188), 0x0927c0);
        assert_eq!(word(&bytes, 0x1a0), 0x0927c0);
        assert_valid_checksums(&bytes);
    }

    #[test]
    fn uncleared_times_are_read_only_and_out_of_range_values_are_rejected() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        for (id, value) in [
            ("time_trial.luigi_raceway.place_4.time", SaveValue::U32(100)),
            (
                "time_trial.luigi_raceway.place_1.time",
                SaveValue::U32(360_000),
            ),
            (
                "time_trial.luigi_raceway.best_lap.time",
                SaveValue::U32(600_000),
            ),
        ] {
            assert!(
                handler
                    .apply(&original, &identity, &[edit(id, value)], false)
                    .is_err(),
                "{id} must reject the edit"
            );
        }
    }

    #[test]
    fn corrupt_time_trial_and_best_record_checksums_reject_edits() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        for offset in [0x40, 0x1b0, 0x1e0] {
            let mut corrupt = input();
            corrupt.bytes[offset] ^= 1;
            assert!(
                handler
                    .apply(
                        &corrupt,
                        &identity,
                        &[edit("options.sound_mode", SaveValue::Enum("mono".into()))],
                        false
                    )
                    .is_err(),
                "corruption at {offset:#x} must be rejected"
            );
        }
    }
}
