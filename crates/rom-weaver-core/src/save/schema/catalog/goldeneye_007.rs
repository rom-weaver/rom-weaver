use super::rare_eeprom;
use super::rules::{Condition, ReadValue, Scalar, Store};
use super::*;

// Record selection, mission-time packing, and checksum rules:
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/goldeneye-007/saveEditor
// The checksum hash follows https://github.com/bryc/rare-n64-chksm (see `rare_eeprom`).
const FILES: usize = 4;
const RECORDS: usize = 5;
const FIRST_RECORD: usize = 0x20;
const RECORD_SIZE: usize = 0x60;
const DIFFICULTY_STRIDE: usize = 0x19;
// Upstream offsets are relative to the record's 0x20-byte header slot, so logical offsets drop it.
const UPSTREAM_SHIFT: usize = 0x20;
const SECONDS_MAX: i64 = 0x3ff;

const MISSIONS: [(&str, &str, usize, u32); 20] = [
    ("dam", "Dam", 0x32, 6),
    ("facility", "Facility", 0x33, 4),
    ("runaway", "Runaway", 0x34, 2),
    ("surface_1", "Surface 1", 0x35, 0),
    ("bunker_1", "Bunker 1", 0x37, 6),
    ("silo", "Silo", 0x38, 4),
    ("frigate", "Frigate", 0x39, 2),
    ("surface_2", "Surface 2", 0x3a, 0),
    ("bunker_2", "Bunker 2", 0x3c, 6),
    ("statue", "Statue", 0x3d, 4),
    ("archives", "Archives", 0x3e, 2),
    ("streets", "Streets", 0x3f, 0),
    ("depot", "Depot", 0x41, 6),
    ("train", "Train", 0x42, 4),
    ("jungle", "Jungle", 0x43, 2),
    ("control", "Control", 0x44, 0),
    ("caverns", "Caverns", 0x46, 6),
    ("cradle", "Cradle", 0x47, 4),
    ("aztec", "Aztec", 0x48, 2),
    ("egyptian", "Egyptian", 0x49, 0),
];
const DIFFICULTIES: [(&str, &str); 3] = [
    ("agent", "Agent"),
    ("secret_agent", "Secret Agent"),
    ("00_agent", "00 Agent"),
];
const CHEATS: [(&str, &str, usize, u8); 20] = [
    ("invincible", "Invincible", 0x2e, 1),
    ("all_guns", "All Guns", 0x30, 3),
    ("bond_invisible", "Bond Invisible", 0x2f, 2),
    ("infinite_ammo", "Infinite Ammo", 0x2f, 7),
    ("dk_mode", "DK Mode", 0x2e, 2),
    ("tiny_bond", "Tiny Bond", 0x2e, 7),
    ("paintball_mode", "Paintball Mode", 0x2e, 0),
    ("silver_pp7", "Silver PP7", 0x2f, 5),
    ("gold_pp7", "Gold PP7", 0x30, 1),
    ("no_radar_multi", "No Radar (multiplayer)", 0x2e, 6),
    ("turbo_mode", "Turbo Mode", 0x2e, 5),
    ("fast_animation", "Fast Animation", 0x2f, 1),
    ("slow_animation", "Slow Animation", 0x2f, 4),
    ("enemy_rockets", "Enemy Rockets", 0x2f, 3),
    ("double_rocket_launcher", "2x Rocket Launcher", 0x2e, 4),
    ("double_grenade_launcher", "2x Grenade Launcher", 0x2e, 3),
    ("double_rc_p90", "2x RC-P90", 0x30, 0),
    ("double_throwing_knife", "2x Throwing Knife", 0x2f, 0),
    ("double_hunting_knife", "2x Hunting Knife", 0x2f, 6),
    ("double_laser", "2x Laser", 0x30, 2),
];
const OPTIONS: [(&str, &str, usize, u8); 7] = [
    ("look_up_down_upright", "Look up/down upright", 0x2d, 0),
    ("auto_aim", "Auto-aim", 0x2d, 1),
    ("aim_control_toggle", "Aim control toggles", 0x2d, 2),
    ("sight_on_screen", "Sight on-screen", 0x2d, 3),
    ("look_ahead", "Look ahead", 0x2d, 4),
    ("ammo_on_screen", "Ammo on-screen", 0x2d, 5),
    ("screen_wide", "Wide screen", 0x2d, 6),
];

fn time_offset(difficulty: usize, mission: usize) -> usize {
    MISSIONS[mission].2 + difficulty * DIFFICULTY_STRIDE - UPSTREAM_SHIFT
}

fn time_scalar(difficulty: usize, mission: usize) -> Scalar {
    Scalar {
        offset: time_offset(difficulty, mission),
        storage: Storage::U16Be,
        mask: Some((SECONDS_MAX as u32) << MISSIONS[mission].3),
    }
}

// A harder difficulty implies the easier ones were cleared: an unset easier time becomes the
// 0x3ff sentinel when this time is set, and the sentinel returns to zero when it is cleared.
fn cascade(difficulty: usize, easier: usize, mission: usize) -> Store {
    let current = time_scalar(difficulty, mission);
    let target = time_scalar(easier, mission);
    let when = (current.clone(), target.clone());
    Store {
        when: Some(Condition::new(move |bytes| {
            let (time, other) = (when.0.read(bytes)?, when.1.read(bytes)?);
            Ok(time > 0 && other == 0 || time == 0 && other == SECONDS_MAX)
        })),
        value: ReadValue::new(move |bytes| {
            Ok(if current.read(bytes)? > 0 {
                SECONDS_MAX
            } else {
                0
            })
        }),
        destination: target,
    }
}

fn in_file(mut field: FieldDefinition) -> FieldDefinition {
    field.behavior.group = Some("file".into());
    field
}

fn bit_field(id: &str, label: &str, offset: usize, bit: u8) -> FieldDefinition {
    in_file(catalog_field(id, label, offset - UPSTREAM_SHIFT, Storage::Bit).bit(bit))
}

fn exclusive_screen_modes(widescreen: &mut FieldDefinition, cinema: &mut FieldDefinition) {
    // Cinema is a bit in the control-style byte and replaces the widescreen bit.
    let cinema_flag = Scalar {
        offset: 0x2c - UPSTREAM_SHIFT,
        storage: Storage::U8,
        mask: Some(0x08),
    };
    let wide_flag = Scalar {
        offset: 0x2d - UPSTREAM_SHIFT,
        storage: Storage::U8,
        mask: Some(0x80),
    };
    for (field, set, clear) in [
        (widescreen, wide_flag.clone(), cinema_flag.clone()),
        (cinema, cinema_flag, wide_flag),
    ] {
        field.behavior.on_edit.push(Store {
            when: Some(Condition::new(move |bytes| Ok(set.read(bytes)? == 1))),
            destination: clear,
            value: ReadValue::new(|_| Ok(0)),
        });
    }
}

fn fields() -> Vec<FieldDefinition> {
    let mut fields = vec![in_file(catalog_field(
        "all_unlocked",
        "All levels and 00 Agent difficulty unlocked",
        0x29 - UPSTREAM_SHIFT,
        Storage::Bool,
    ))];
    for (difficulty, (difficulty_id, difficulty_label)) in DIFFICULTIES.iter().enumerate() {
        for (mission, (id, label, _, _)) in MISSIONS.iter().enumerate() {
            let scalar = time_scalar(difficulty, mission);
            let mut field = catalog_field(
                &format!("{difficulty_id}.{id}_seconds"),
                &format!("{label} best time, {difficulty_label} (seconds)"),
                scalar.offset,
                Storage::U16Be,
            )
            .mask(scalar.mask.expect("time mask"))
            .max(SECONDS_MAX);
            field.behavior.on_edit = (0..difficulty)
                .map(|easier| cascade(difficulty, easier, mission))
                .collect();
            fields.push(in_file(field));
        }
    }
    for (id, label, offset, bit) in CHEATS {
        fields.push(bit_field(&format!("cheats.{id}"), label, offset, bit));
    }
    fields.push(in_file(catalog_field(
        "options.music",
        "Music volume",
        0x2a - UPSTREAM_SHIFT,
        Storage::U8,
    )));
    fields.push(in_file(catalog_field(
        "options.fx",
        "Sound effects volume",
        0x2b - UPSTREAM_SHIFT,
        Storage::U8,
    )));
    fields.push(in_file(
        catalog_field(
            "options.control_style",
            "Control style",
            0x2c - UPSTREAM_SHIFT,
            Storage::U8,
        )
        .mask(0x07)
        .choices(choices(&[
            ("1.1 Honey", 0),
            ("1.2 Solitaire", 1),
            ("1.3 Kissy", 2),
            ("1.4 Goodnight", 3),
            ("2.1 Plenty", 4),
            ("2.2 Galore", 5),
            ("2.3 Domino", 6),
            ("2.4 Goodhead", 7),
        ])),
    ));
    for (id, label, offset, bit) in OPTIONS {
        fields.push(bit_field(&format!("options.{id}"), label, offset, bit));
    }
    let mut widescreen = bit_field("options.screen_ratio_16_9", "Screen ratio 16:9", 0x2d, 7);
    let mut cinema = bit_field(
        "options.screen_ratio_cinema",
        "Screen ratio cinema",
        0x2c,
        3,
    );
    exclusive_screen_modes(&mut widescreen, &mut cinema);
    fields.extend([widescreen, cinema]);
    fields
}

fn owns(bytes: &[u8], file: usize, record: usize) -> bool {
    let index = bytes[FIRST_RECORD + record * RECORD_SIZE + 8];
    usize::from(index & 7) == file && index & 0x80 == 0
}

fn candidate(file: usize, record: usize) -> layout::Candidate {
    let base = FIRST_RECORD + record * RECORD_SIZE;
    tagged_record_candidate(
        base,
        RECORD_SIZE,
        record,
        move |bytes, record| owns(bytes, file, record),
        move |bytes| rare_eeprom::valid(bytes, base, base + 8..base + RECORD_SIZE),
    )
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..FILES)
        .map(|file| GameDefinition {
            fields: fields(),
            description: "Edits mission times, cheats, and options in one occupied file of a canonical 512-byte EEPROM or a copy padded to 2 KiB. Selects the first record tagged for the file and rejects it if its checksum is damaged; preserves the other records, the EEPROM header, and any trailing padding. Byte-swapped images are unsupported. Requires a game-made template.".into(),
            runtime: runtime::Runtime {
                logical_size: Some(RECORD_SIZE),
                layout: Some(single_file_layout(
                    RECORD_SIZE,
                    (0..RECORDS).map(|record| candidate(file, record)).collect(),
                )),
                after_edit: rare_eeprom::stores(0, 8..RECORD_SIZE),
                save_format: Some("n64_eeprom_512".into()),
                include_implicit_changes: true,
                ..Default::default()
            },
            padded_sizes: vec![2048],
            ..GameDefinition::new(
                format!("goldeneye-007-canonical-eeprom-file-{}", file + 1),
                format!("GoldenEye 007 (canonical EEPROM, File {})", file + 1),
                "nintendo-64".into(),
                512,
            )
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::rare_eeprom::reference_checksum;
    use super::*;

    // Save-index bytes per record: file 2, a deleted copy of file 4, file 1, file 4, file 3.
    const TAGS: [u8; RECORDS] = [0x01, 0x83, 0x00, 0x03, 0x02];

    fn repair(bytes: &mut [u8], record: usize) {
        let base = FIRST_RECORD + record * RECORD_SIZE;
        let [high, low] = reference_checksum(&bytes[base + 8..base + RECORD_SIZE]);
        bytes[base..base + 4].copy_from_slice(&high.to_be_bytes());
        bytes[base + 4..base + 8].copy_from_slice(&low.to_be_bytes());
    }

    fn template(file: usize) -> SaveDetectionInput {
        let mut bytes: Vec<u8> = (0..512).map(|index| (index * 37 + 11) as u8).collect();
        for (record, tag) in TAGS.iter().enumerate() {
            let base = FIRST_RECORD + record * RECORD_SIZE;
            bytes[base + 8] = *tag;
            // Known option bytes: control style 5, widescreen set, cinema clear.
            bytes[base + 0xc] = 0x05;
            bytes[base + 0xd] = 0x80;
            repair(&mut bytes, record);
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some(format!("goldeneye-007-canonical-eeprom-file-{}", file + 1)),
            rom_sha1: None,
        }
    }

    fn live(file: usize) -> usize {
        [2, 0, 4, 3][file]
    }

    fn time(record: &[u8], difficulty: usize, mission: usize) -> u16 {
        let (_, _, offset, start) = MISSIONS[mission];
        let at = offset - 0x20 + difficulty * 0x19;
        (u16::from_be_bytes([record[at], record[at + 1]]) >> start) & 0x3ff
    }

    fn set_time(record: &mut [u8], difficulty: usize, mission: usize, value: u16) {
        let (_, _, offset, start) = MISSIONS[mission];
        let at = offset - 0x20 + difficulty * 0x19;
        let word = u16::from_be_bytes([record[at], record[at + 1]]) & !(0x3ff << start);
        record[at..at + 2].copy_from_slice(&(word | value << start).to_be_bytes());
    }

    #[test]
    fn every_field_round_trips_and_repairs_only_its_record() {
        for file in 0..FILES {
            let (handler, identity) = test_handler(schemas, file);
            let input = template(file);
            let base = FIRST_RECORD + live(file) * RECORD_SIZE;
            let document = handler.parse(&input, &identity).unwrap();
            // Unlock flag, 60 times, 20 cheats, 2 volumes, control style, 7 options, 2 screen modes.
            assert_eq!(document.fields.len(), 1 + 60 + 20 + 2 + 1 + 7 + 2);
            for field in &document.fields {
                let value = match &field.value {
                    SaveValue::Bool(value) => SaveValue::Bool(!value),
                    SaveValue::Enum(name) => SaveValue::Enum(
                        field
                            .constraints
                            .choices
                            .iter()
                            .find(|choice| *choice != name)
                            .unwrap()
                            .clone(),
                    ),
                    SaveValue::U32(value) => {
                        let max = field.constraints.max.unwrap() as u32;
                        SaveValue::U32(if *value == max { 0 } else { max })
                    }
                    other => panic!("unexpected value {other:?}"),
                };
                let output =
                    test_run(schemas, file, &input, &[(&field.id, value.clone())]).unwrap();
                let reread = handler
                    .parse(
                        &SaveDetectionInput {
                            bytes: output.clone(),
                            ..input.clone()
                        },
                        &identity,
                    )
                    .unwrap();
                let changed = reread.fields.iter().find(|f| f.id == field.id).unwrap();
                assert_eq!(changed.value, value, "{}", field.id);
                assert_eq!(output.len(), 512);
                assert_eq!(output[..base], input.bytes[..base], "{}", field.id);
                assert_eq!(
                    output[base + RECORD_SIZE..],
                    input.bytes[base + RECORD_SIZE..],
                    "{}",
                    field.id
                );
                let [high, low] = reference_checksum(&output[base + 8..base + RECORD_SIZE]);
                assert_eq!(output[base..base + 4], high.to_be_bytes(), "{}", field.id);
                assert_eq!(
                    output[base + 4..base + 8],
                    low.to_be_bytes(),
                    "{}",
                    field.id
                );
            }
        }
    }

    #[test]
    fn known_offsets_match_the_upstream_layout() {
        let mut input = template(3);
        let base = FIRST_RECORD + 3 * RECORD_SIZE;
        // Clear the easier Egyptian times so the edit has to mark them as cleared.
        for difficulty in 0..3 {
            set_time(
                &mut input.bytes[base..base + RECORD_SIZE],
                difficulty,
                19,
                0,
            );
        }
        repair(&mut input.bytes, 3);
        let output = test_run(
            schemas,
            3,
            &input,
            &[
                ("00_agent.egyptian_seconds", SaveValue::U32(1023)),
                ("agent.dam_seconds", SaveValue::U32(341)),
                ("cheats.invincible", SaveValue::Bool(true)),
                ("cheats.double_laser", SaveValue::Bool(true)),
                ("options.music", SaveValue::U32(0x12)),
                (
                    "options.control_style",
                    SaveValue::Enum("2.3 Domino".into()),
                ),
                ("options.look_up_down_upright", SaveValue::Bool(true)),
                ("all_unlocked", SaveValue::Bool(true)),
            ],
        )
        .unwrap();
        let mut expected = input.bytes.clone();
        let record = &mut expected[base..base + RECORD_SIZE];
        // The upstream edit hooks, translated byte by byte.
        set_time(record, 2, 19, 1023);
        for easier in 0..2 {
            if time(record, easier, 19) == 0 {
                set_time(record, easier, 19, 0x3ff);
            }
        }
        set_time(record, 0, 0, 341);
        record[0xe] |= 1 << 1;
        record[0x10] |= 1 << 2;
        record[0xa] = 0x12;
        record[0xc] = (record[0xc] & !7) | 6;
        record[0xd] |= 1;
        record[0x9] = 1;
        repair(&mut expected, 3);
        assert_eq!(output, expected);
    }

    #[test]
    fn clearing_a_time_resets_only_the_easier_sentinels() {
        let mut input = template(0);
        let base = FIRST_RECORD + 2 * RECORD_SIZE;
        let record = &mut input.bytes[base..base + RECORD_SIZE];
        for (difficulty, value) in [(0, 0x155), (1, 0x3ff), (2, 77)] {
            set_time(record, difficulty, 5, value);
        }
        set_time(record, 0, 6, 0x155);
        set_time(record, 1, 6, 0x3ff);
        set_time(record, 2, 6, 9);
        repair(&mut input.bytes, 2);
        let output = test_run(
            schemas,
            0,
            &input,
            &[("00_agent.silo_seconds", SaveValue::U32(0))],
        )
        .unwrap();
        let mut expected = input.bytes.clone();
        let record = &mut expected[base..base + RECORD_SIZE];
        for difficulty in 1..3 {
            set_time(record, difficulty, 5, 0);
        }
        repair(&mut expected, 2);
        assert_eq!(output, expected);
    }

    #[test]
    fn screen_modes_exclude_each_other() {
        let input = template(1);
        let base = FIRST_RECORD;
        let cinema = test_run(
            schemas,
            1,
            &input,
            &[("options.screen_ratio_cinema", SaveValue::Bool(true))],
        )
        .unwrap();
        assert_eq!(cinema[base + 0xc], 0x05 | 0x08);
        assert_eq!(cinema[base + 0xd], 0x00);
        let mut again = input.clone();
        again.bytes = cinema;
        let wide = test_run(
            schemas,
            1,
            &again,
            &[("options.screen_ratio_16_9", SaveValue::Bool(true))],
        )
        .unwrap();
        assert_eq!(wide[base + 0xc], 0x05);
        assert_eq!(wide[base + 0xd], 0x80);
    }

    #[test]
    fn preview_lists_the_cascaded_and_exclusive_fields() {
        let (handler, identity) = test_handler(schemas, 0);
        let mut input = template(0);
        let base = FIRST_RECORD + 2 * RECORD_SIZE;
        for difficulty in 0..2 {
            set_time(&mut input.bytes[base..base + RECORD_SIZE], difficulty, 0, 0);
        }
        repair(&mut input.bytes, 2);
        let edit = |field: &str, value| SaveEdit {
            field: field.into(),
            value,
        };
        let result = handler
            .apply(
                &input,
                &identity,
                &[edit("00_agent.dam_seconds", SaveValue::U32(100))],
                true,
            )
            .unwrap();
        let changes: Vec<_> = result
            .preview
            .changes
            .iter()
            .map(|change| (change.field.as_str(), change.new_value.clone()))
            .collect();
        assert!(changes.contains(&("00_agent.dam_seconds", SaveValue::U32(100))));
        for field in ["agent.dam_seconds", "secret_agent.dam_seconds"] {
            assert!(
                changes.contains(&(field, SaveValue::U32(1023))),
                "{field}: {changes:?}"
            );
        }
        assert_eq!(changes.len(), 3, "{changes:?}");
        let result = handler
            .apply(
                &template(0),
                &identity,
                &[edit("options.screen_ratio_cinema", SaveValue::Bool(true))],
                true,
            )
            .unwrap();
        let changes: Vec<_> = result
            .preview
            .changes
            .iter()
            .map(|change| (change.field.as_str(), change.new_value.clone()))
            .collect();
        assert!(changes.contains(&("options.screen_ratio_cinema", SaveValue::Bool(true))));
        assert!(changes.contains(&("options.screen_ratio_16_9", SaveValue::Bool(false))));
        assert_eq!(changes.len(), 2, "{changes:?}");
    }

    #[test]
    fn padded_2_kib_images_edit_and_keep_their_padding() {
        let (handler, identity) = test_handler(schemas, 3);
        let canonical = template(3);
        let mut padded = canonical.clone();
        padded
            .bytes
            .extend((0..1536).map(|index| (index * 13 + 1) as u8 | 1));
        let edits = [
            ("options.music", SaveValue::U32(1)),
            ("agent.dam_seconds", SaveValue::U32(77)),
        ];
        let expected = test_run(schemas, 3, &canonical, &edits).unwrap();
        let output = test_run(schemas, 3, &padded, &edits).unwrap();
        assert_eq!(output.len(), 2048);
        assert_eq!(output[..512], expected[..]);
        assert_eq!(output[512..], padded.bytes[512..]);
        assert_ne!(output[..512], canonical.bytes[..]);
        let document = handler.parse(&padded, &identity).unwrap();
        assert_eq!(document.save_size, 2048);
        let reread = handler
            .parse(
                &SaveDetectionInput {
                    bytes: output,
                    ..padded.clone()
                },
                &identity,
            )
            .unwrap();
        let value = |id: &str| {
            reread
                .fields
                .iter()
                .find(|f| f.id == id)
                .unwrap()
                .value
                .clone()
        };
        assert_eq!(value("options.music"), SaveValue::U32(1));
        assert_eq!(value("agent.dam_seconds"), SaveValue::U32(77));
        // A damaged payload is still rejected when padding follows it.
        let mut damaged = padded.clone();
        damaged.bytes[FIRST_RECORD + 3 * RECORD_SIZE + 0x30] ^= 1;
        assert!(handler.apply(&damaged, &identity, &[], false).is_err());
    }

    #[test]
    fn selects_the_tagged_live_record_and_rejects_damage() {
        let (handler, identity) = test_handler(schemas, 3);
        let input = template(3);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        // The first record tagged for the file must be valid even when a later copy is intact.
        let mut duplicate = input.clone();
        let base = FIRST_RECORD + 4 * RECORD_SIZE;
        duplicate.bytes[base + 8] = 0x03;
        repair(&mut duplicate.bytes, 4);
        assert!(
            test_run(
                schemas,
                3,
                &duplicate,
                &[("options.music", SaveValue::U32(1))]
            )
            .is_ok()
        );
        let live_base = FIRST_RECORD + 3 * RECORD_SIZE;
        duplicate.bytes[live_base + 0x30] ^= 1;
        assert!(handler.apply(&duplicate, &identity, &[], false).is_err());
        // A deleted record and a tag for another file never match.
        let mut deleted = input.clone();
        deleted.bytes[live_base + 8] = 0x83;
        repair(&mut deleted.bytes, 3);
        assert!(handler.apply(&deleted, &identity, &[], false).is_err());
        let sizes = [511, 513, 1024, 2047, 2049];
        let sized = sizes.map(|size| {
            let mut bytes = input.bytes.clone();
            bytes.resize(size, 0x5a);
            bytes
        });
        let blank = [vec![0; 512], vec![0xff; 512], vec![0; 2048]];
        for bytes in blank.into_iter().chain(sized) {
            let input = SaveDetectionInput {
                bytes,
                ..input.clone()
            };
            assert!(handler.apply(&input, &identity, &[], false).is_err());
        }
        for field in ["agent.dam_seconds", "options.control_style"] {
            let value = if field.starts_with("agent") {
                SaveValue::U32(1024)
            } else {
                SaveValue::Enum("9.9".into())
            };
            assert!(
                test_run(schemas, 3, &input, &[(field, value)]).is_err(),
                "{field}"
            );
        }
    }
}
