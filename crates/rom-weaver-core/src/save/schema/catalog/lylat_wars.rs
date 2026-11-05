use super::super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;
use tracing::{debug, trace};

fn checksum(bytes: &[u8]) -> u16 {
    let mut value = 0u16;
    for byte in &bytes[..0xfe] {
        value ^= u16::from(*byte);
        value = ((value << 1) & 0xfe) | ((value >> 7) & 1);
    }
    let checksum = (value & 0xff) | 0x9500;
    trace!(checksum, "computed Lylat Wars save checksum");
    checksum
}

// Layout and checksum rules: https://github.com/RyudoSynbios/game-tools-collection/tree/8fb075e7c130da9e72c3c46ec8efa447a252ad88/src/lib/templates/lylat-wars/saveEditor
// Ranking, sound, and language fields, unchanged at: https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/lylat-wars/saveEditor
const NAME_CODEC: &str = "lylat_wars_ranking_name";
const RANKING_ENTRIES: usize = 10;
const MISSIONS_PER_ENTRY: usize = 7;
const PLANETS: [&str; 16] = [
    "meteo", "area_6", "bolse", "sector_z", "sector_x", "sector_y", "katina", "macbeth", "zoness",
    "corneria", "titania", "aquas", "fortuna", "solar", "venom", "venom_2",
];

fn mission_flags() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    // The first three planets keep the original field order.
    for (id, label, offset) in [
        ("corneria", "Corneria", 0x9),
        ("meteo", "Meteo", 0x0),
        ("sector_y", "Sector Y", 0x5),
        ("fortuna", "Fortuna", 0xc),
        ("katina", "Katina", 0x6),
        ("aquas", "Aquas", 0xb),
        ("sector_x", "Sector X", 0x4),
        ("solar", "Solar", 0xd),
        ("zoness", "Zoness", 0x8),
        ("titania", "Titania", 0xa),
        ("macbeth", "Macbeth", 0x7),
        ("sector_z", "Sector Z", 0x3),
        ("bolse", "Bolse", 0x2),
        ("area_6", "Area 6", 0x1),
        ("venom", "Venom", 0xf),
    ] {
        for (suffix, bit) in [
            ("played", 2),
            ("complete", 0),
            ("medal", 1),
            ("expert_complete", 3),
            ("expert_medal", 4),
        ] {
            fields.push(
                catalog_field(
                    &format!("{id}.{suffix}"),
                    &format!("{label} {suffix}"),
                    offset,
                    Storage::Bit,
                )
                .bit(bit),
            );
        }
    }
    fields
}

fn option_fields() -> Vec<FieldDefinition> {
    let mut sound = catalog_field("sound.mode", "Sound mode", 0x14, Storage::U8)
        .choices(choices(&[("stereo", 0), ("mono", 1), ("headphone", 2)]))
        .min(0)
        .max(2);
    sound.description = "Sound output mode".into();
    let mut fields = vec![sound];
    for (id, label, offset) in [
        ("sound.music", "Music volume", 0x15),
        ("sound.voice", "Voice volume", 0x16),
        ("sound.effects", "Sound effect volume", 0x17),
    ] {
        fields.push(catalog_field(id, label, offset, Storage::U8).min(0).max(99));
    }
    // The upstream editor hides these two bytes for the NTSC releases.
    let pal_only = "Used by the PAL release only".to_string();
    fields.push(
        catalog_field("language.text", "Text language", 0xeb, Storage::U8)
            .choices(choices(&[("english", 0), ("french", 1), ("german", 2)]))
            .min(0)
            .max(2)
            .description(pal_only.clone()),
    );
    fields.push(
        catalog_field("language.voice", "Voice language", 0xec, Storage::U8)
            .choices(choices(&[("english", 0), ("lylat", 1)]))
            .min(0)
            .max(1)
            .description(pal_only),
    );
    fields
}

fn ranking_fields() -> Vec<FieldDefinition> {
    let mut fields = Vec::new();
    for entry in 0..RANKING_ENTRIES {
        let id = format!("ranking_{}", entry + 1);
        let label = format!("Ranking {}", entry + 1);
        let name_offset = 0x18 + entry * 3;
        fields.push(
            catalog_field(
                &format!("{id}.name"),
                &format!("{label} name"),
                name_offset,
                Storage::Ascii,
            )
            .length(3)
            .editable(true)
            .text_codec(NAME_CODEC)
            .presentation(
                field::Presentation::new(0, name_offset as u16)
                    .text_length(3)
                    .step(None)
                    .encoding(Some(NAME_CODEC)),
            ),
        );
        fields.push(
            catalog_field(
                &format!("{id}.arwings_left"),
                &format!("{label} Arwings left"),
                0x40 + entry,
                Storage::U8,
            )
            .min(0)
            .max(99),
        );
        let completed_offset = 0x36 + entry;
        fields.push(
            catalog_field(
                &format!("{id}.completed_missions"),
                &format!("{label} completed missions"),
                completed_offset,
                Storage::U8,
            )
            .min(1)
            .max(MISSIONS_PER_ENTRY as i64),
        );
        for mission in 0..MISSIONS_PER_ENTRY {
            let record = 0x5e + entry * 0xe + mission * 2;
            let mission_id = format!("{id}.mission_{}", mission + 1);
            let mission_label = format!("{label} mission {}", mission + 1);
            // Records past the completed-mission count are unused by the game.
            let behavior = move || field::FieldBehavior {
                present_when: Some(rules::Condition::new(move |bytes| {
                    Ok(mission < usize::from(bytes[completed_offset]))
                })),
                ..Default::default()
            };
            let planet = catalog_field(
                &format!("{mission_id}.planet"),
                &format!("{mission_label} planet"),
                record + 1,
                Storage::U8,
            )
            .mask(0xf0)
            .choices(choices(
                &PLANETS
                    .iter()
                    .enumerate()
                    .map(|(value, name)| (*name, value as i64))
                    .collect::<Vec<_>>(),
            ))
            .min(0)
            .max(15);
            fields.push(planet.behavior(behavior()));
            fields.push(
                catalog_field(
                    &format!("{mission_id}.hits"),
                    &format!("{mission_label} hits (low byte)"),
                    record,
                    Storage::U8,
                )
                .behavior(behavior()),
            );
            fields.push(
                catalog_field(
                    &format!("{mission_id}.hits_256"),
                    &format!("{mission_label} hits (+256)"),
                    record + 1,
                    Storage::Bit,
                )
                .bit(3)
                .behavior(behavior()),
            );
            for (ally, bit) in [("slippy", 0), ("falco", 1), ("peppy", 2)] {
                fields.push(
                    catalog_field(
                        &format!("{mission_id}.{ally}"),
                        &format!("{mission_label} {ally} survived"),
                        record + 1,
                        Storage::Bit,
                    )
                    .bit(bit)
                    .behavior(behavior()),
                );
            }
            fields.push(
                catalog_field(
                    &format!("{mission_id}.medal"),
                    &format!("{mission_label} medal obtained"),
                    0x4b + entry * 2,
                    Storage::Bit,
                )
                .bit(mission as u8)
                .behavior(behavior()),
            );
        }
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let mut fields = mission_flags();
    fields.extend(option_fields());
    fields.extend(ranking_fields());
    debug!(fields = fields.len(), "built Lylat Wars save fields");
    let check = Check {
        when: None,
        assert: Condition::new(|bytes| {
            Ok(u16::from_be_bytes([bytes[0xfe], bytes[0xff]]) == checksum(bytes))
        }),
        code: "lylat_wars_checksum".into(),
        message: "the Lylat Wars checksum is invalid".into(),
        section_id: None,
        warning: None,
    };
    let game = GameDefinition {
        fields,
        description: "Edits mission completion and medals, sound and language options, and ranking records in normalized 16 Kbit EEPROM. Requires a game-made template.".into(),
        runtime: runtime::Runtime { require_selection: true, recognition: Some(runtime::Recognition { checks: vec![check.clone()], reasons: vec![SaveRecognitionReason::ChecksumValid], confidence: SaveRecognitionConfidence::High, incomplete_confidence: None, selected_reason: true, empty_top_level_reasons: false }), checks: vec![check], after_edit: vec![Store { when: None, destination: Scalar { offset: 0xfe, storage: Storage::U16Be, mask: None }, value: ReadValue::new(|bytes| Ok(i64::from(checksum(bytes)))) }], save_format: Some("n64_eeprom_16k".into()), save_format_name: Some("Nintendo 64 EEPROM 16 Kbit".into()), ..Default::default() },
        ..GameDefinition::new("lylat-wars".into(), "Lylat Wars / Star Fox 64".into(), "nintendo-64".into(), 2048)
    };
    let codecs = BTreeMap::from([(
        NAME_CODEC.to_string(),
        ascii_name_codec(
            ".0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            3,
            0x41,
            false,
            "ranking name",
        ),
    )]);
    build(vec![game], codecs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> SaveDetectionInput {
        let mut bytes = vec![0x33; 2048];
        let sum = checksum(&bytes);
        bytes[0xfe..0x100].copy_from_slice(&sum.to_be_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some("lylat-wars".into()),
            rom_sha1: None,
        }
    }
    #[test]
    fn checksum_matches_independent_known_vector() {
        let mut bytes = vec![0; 2048];
        bytes[..4].copy_from_slice(&[1, 2, 3, 4]);
        assert_eq!(checksum(&bytes), 0x9510);
    }
    #[test]
    fn edit_repairs_checksum_and_preserves_tail() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = input();
        let bytes = handler
            .apply(
                &original,
                &identity,
                &[SaveEdit {
                    field: "corneria.medal".into(),
                    value: SaveValue::Bool(false),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(
            u16::from_be_bytes([bytes[0xfe], bytes[0xff]]),
            checksum(&bytes)
        );
        assert_eq!(&bytes[0x100..], &original.bytes[0x100..]);
        assert!(
            handler
                .apply(&original, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let mut bad = input();
        bad.bytes[4] ^= 1;
        assert!(handler.apply(&bad, &identity, &[], false).is_err());
    }

    // Direct port of the upstream rotate-and-xor loop, using unmasked intermediates.
    fn upstream_checksum(bytes: &[u8]) -> u16 {
        let mut checksum = 0u32;
        for byte in &bytes[..0xfe] {
            checksum ^= u32::from(*byte);
            checksum <<= 1;
            checksum = (checksum & 0xfe) | ((checksum >> 8) & 1);
        }
        ((checksum & 0xff) | 0x9500) as u16
    }

    fn ranking_input() -> SaveDetectionInput {
        let mut bytes: Vec<u8> = (0..2048).map(|index| (index * 7 % 251) as u8).collect();
        for (entry, completed) in [7, 3, 1, 7, 7, 7, 7, 7, 7, 7].into_iter().enumerate() {
            bytes[0x36 + entry] = completed;
        }
        let sum = upstream_checksum(&bytes);
        bytes[0xfe..0x100].copy_from_slice(&sum.to_be_bytes());
        SaveDetectionInput {
            bytes,
            selected_game: Some("lylat-wars".into()),
            rom_sha1: None,
        }
    }

    fn field_value(handler: &SchemaSaveHandler, input: &SaveDetectionInput, id: &str) -> SaveValue {
        let identity = handler.definitions().remove(0).identity;
        handler
            .parse(input, &identity)
            .unwrap()
            .fields
            .into_iter()
            .find(|field| field.id == id)
            .unwrap_or_else(|| panic!("missing field {id}"))
            .value
    }

    fn edit(id: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: id.into(),
            value,
        }
    }

    #[test]
    fn deepened_schema_exposes_every_template_field() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = ranking_input();
        let document = handler.parse(&original, &identity).unwrap();
        // 15 planets x 5 flags, 6 option bytes, then 10 rankings with a name, Arwings,
        // completed count, and 7 mission records of 7 fields; entries 2 and 3 only
        // show the records their completed count covers.
        let visible_missions = 7 * 8 + 3 + 1;
        assert_eq!(
            document.fields.len(),
            75 + 6 + 10 * 3 + visible_missions * 7
        );
        assert_eq!(handler.game.fields.len(), 75 + 6 + 10 * (3 + 7 * 7));
        assert_eq!(
            field_value(&handler, &original, "ranking_2.mission_3.planet"),
            SaveValue::Enum(PLANETS[usize::from(original.bytes[0x5e + 0xe + 5] >> 4)].into())
        );
        assert!(
            !document
                .fields
                .iter()
                .any(|field| field.id == "ranking_2.mission_4.hits")
        );
    }

    #[test]
    fn ranking_option_and_mission_edits_repair_the_checksum() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = ranking_input();
        let edits = [
            edit("ranking_1.name", SaveValue::Text("A.9".into())),
            edit("ranking_1.arwings_left", SaveValue::U32(99)),
            edit("ranking_1.completed_missions", SaveValue::U32(7)),
            edit("ranking_1.mission_2.hits", SaveValue::U32(200)),
            edit("ranking_1.mission_2.hits_256", SaveValue::Bool(true)),
            edit(
                "ranking_1.mission_2.planet",
                SaveValue::Enum("katina".into()),
            ),
            edit("ranking_1.mission_2.slippy", SaveValue::Bool(true)),
            edit("ranking_1.mission_2.falco", SaveValue::Bool(false)),
            edit("ranking_1.mission_2.peppy", SaveValue::Bool(true)),
            edit("ranking_1.mission_2.medal", SaveValue::Bool(true)),
            edit(
                "ranking_3.mission_1.planet",
                SaveValue::Enum("venom_2".into()),
            ),
            edit("sound.mode", SaveValue::Enum("headphone".into())),
            edit("sound.music", SaveValue::U32(99)),
            edit("sound.voice", SaveValue::U32(0)),
            edit("sound.effects", SaveValue::U32(7)),
            edit("language.text", SaveValue::Enum("german".into())),
            edit("language.voice", SaveValue::Enum("lylat".into())),
            edit("venom.expert_medal", SaveValue::Bool(true)),
            edit("area_6.played", SaveValue::Bool(false)),
        ];
        let result = handler.apply(&original, &identity, &edits, false).unwrap();
        let bytes = result.bytes.unwrap();
        let mut expected = original.bytes.clone();
        expected[0x18..0x1b].copy_from_slice(b"A.9");
        expected[0x40] = 99;
        expected[0x36] = 7;
        let record = 0x5e + 2;
        expected[record] = 200;
        // Katina planet nibble, +256 hits bit, and Slippy and Peppy without Falco.
        expected[record + 1] = 0x6d;
        expected[0x4b] |= 1 << 1;
        let third = 0x5e + 2 * 0xe;
        expected[third + 1] = (expected[third + 1] & 0x0f) | 0xf0;
        expected[0x14] = 2;
        expected[0x15] = 99;
        expected[0x16] = 0;
        expected[0x17] = 7;
        expected[0xeb] = 2;
        expected[0xec] = 1;
        expected[0xf] |= 1 << 4;
        expected[0x1] &= !(1 << 2);
        let sum = upstream_checksum(&expected);
        expected[0xfe..0x100].copy_from_slice(&sum.to_be_bytes());
        assert_eq!(bytes, expected);
        let saved = SaveDetectionInput {
            bytes,
            ..original.clone()
        };
        assert_eq!(
            field_value(&handler, &saved, "ranking_1.name"),
            SaveValue::Text("A.9".into())
        );
        assert_eq!(
            field_value(&handler, &saved, "ranking_1.mission_2.hits"),
            SaveValue::U32(200)
        );
        assert_eq!(
            field_value(&handler, &saved, "ranking_1.mission_2.planet"),
            SaveValue::Enum("katina".into())
        );
        assert_eq!(
            field_value(&handler, &saved, "sound.mode"),
            SaveValue::Enum("headphone".into())
        );
    }

    #[test]
    fn ranking_names_use_the_arcade_character_set_and_fixed_width() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = ranking_input();
        let apply = |name: &str| {
            handler.apply(
                &original,
                &identity,
                &[edit("ranking_4.name", SaveValue::Text(name.into()))],
                false,
            )
        };
        let bytes = apply("QZ.").unwrap().bytes.unwrap();
        assert_eq!(&bytes[0x18 + 9..0x18 + 12], b"QZ.");
        // The game always stores three letters, so a padded name would not read back.
        assert!(apply("QZ").is_err());
        assert!(apply("abc").is_err());
        assert!(apply("ABCD").is_err());
        assert!(apply("A B").is_err());
    }

    #[test]
    fn unused_mission_records_and_corrupt_saves_reject_edits() {
        let handler = schemas().remove(0);
        let identity = handler.definitions().remove(0).identity;
        let original = ranking_input();
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[edit("ranking_3.mission_2.hits", SaveValue::U32(1))],
                    false
                )
                .is_err()
        );
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[edit("ranking_1.arwings_left", SaveValue::U32(100))],
                    false
                )
                .is_err()
        );
        assert!(
            handler
                .apply(
                    &original,
                    &identity,
                    &[edit("ranking_1.completed_missions", SaveValue::U32(8))],
                    false
                )
                .is_err()
        );
        let mut corrupt = ranking_input();
        corrupt.bytes[0x50] ^= 1;
        assert!(
            handler
                .apply(
                    &corrupt,
                    &identity,
                    &[edit("ranking_1.arwings_left", SaveValue::U32(5))],
                    false
                )
                .is_err()
        );
    }

    #[test]
    fn checksum_wraps_through_the_rotate_for_every_byte_value() {
        for value in 0..=255u8 {
            let mut bytes = vec![value; 2048];
            bytes[0x7f] = !value;
            assert_eq!(checksum(&bytes), upstream_checksum(&bytes));
        }
    }
}
