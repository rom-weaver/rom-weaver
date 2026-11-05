use super::rules::{ReadValue, Scalar, Store};
use super::*;

// Record tags, flag offsets, and the CRC range:
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/donkey-kong-64/saveEditor
// Only flags stored in whole bytes are exposed. The game packs counters and per-level flags into
// word-swapped bit streams (upstream's merged integers), and that packing is not reproduced.
const FILES: usize = 3;
const RECORDS: usize = 4;
const RECORD_SIZE: usize = 0x1ac;
const CHECKSUM_OFFSET: usize = 0x1a8;
const TAG_OFFSET: usize = 0x1a0;
const HEALTH_OFFSET: usize = 0x19e;

const CHARACTERS: [(&str, &str, usize, u8); 4] = [
    ("diddy_kong", "Diddy Kong", 0x0, 6),
    ("lanky_kong", "Lanky Kong", 0x8, 6),
    ("tiny_kong", "Tiny Kong", 0x8, 2),
    ("chunky_kong", "Chunky Kong", 0xe, 5),
];
const MOVES: [(&str, &str, usize, u8); 4] = [
    ("diving", "Diving", 0x30, 2),
    ("vine_leaping", "Vine leaping", 0x30, 3),
    ("grenades_throwing", "Grenades throwing", 0x30, 4),
    ("barrels_pickup", "Barrels pickup", 0x30, 5),
];
const ITEMS: [(&str, &str, usize, u8); 2] = [
    ("nintendo_coin", "Nintendo Coin", 0x10, 4),
    ("rareware_coin", "Rareware Coin", 0x2f, 3),
];
const BANANA_FAIRIES: [(&str, &str, usize, u8); 20] = [
    (
        "dk_isles_1",
        "DK Isles: around a tree near Banana Fairy Island",
        0x4b,
        6,
    ),
    (
        "dk_isles_2",
        "DK Isles: inside a box in the Frantic Factory lobby",
        0x4a,
        1,
    ),
    (
        "dk_isles_3",
        "DK Isles: inside the Fungi Forest lobby",
        0x4a,
        2,
    ),
    (
        "dk_isles_4",
        "DK Isles: at the top of Crocodile Isle",
        0x4b,
        7,
    ),
    (
        "jungle_japes_1",
        "Jungle Japes: above the lake in the cave",
        0x49,
        5,
    ),
    (
        "jungle_japes_2",
        "Jungle Japes: inside the painting cave",
        0x49,
        6,
    ),
    (
        "angry_aztec_1",
        "Angry Aztec: inside Llama's Temple",
        0x4b,
        0,
    ),
    (
        "angry_aztec_2",
        "Angry Aztec: inside Tiny's section in the 5 Doors Temple",
        0x4b,
        1,
    ),
    (
        "frantic_factory_1",
        "Frantic Factory: near Funky's Store",
        0x49,
        7,
    ),
    (
        "frantic_factory_2",
        "Frantic Factory: inside the tunnel to the numbered blocks room",
        0x4b,
        2,
    ),
    (
        "gloomy_galleon_1",
        "Gloomy Galleon: inside one of the three chests",
        0x4a,
        0,
    ),
    (
        "gloomy_galleon_2",
        "Gloomy Galleon: inside Tiny's section in the sunken ship",
        0x4b,
        3,
    ),
    (
        "fungi_forest_1",
        "Fungi Forest: inside the dark attic",
        0x4a,
        3,
    ),
    (
        "fungi_forest_2",
        "Fungi Forest: inside a box in the barn",
        0x4a,
        4,
    ),
    (
        "crystal_caves_1",
        "Crystal Caves: inside Tiny's section in the igloo",
        0x4a,
        5,
    ),
    (
        "crystal_caves_2",
        "Crystal Caves: inside the candles cabin",
        0x4c,
        0,
    ),
    (
        "creepy_castle_1",
        "Creepy Castle: inside the museum",
        0x4b,
        4,
    ),
    (
        "creepy_castle_2",
        "Creepy Castle: inside the tree at the water raising section",
        0x4b,
        5,
    ),
    ("hideout_helm_1", "Hideout Helm: near the Boss Key", 0x4a, 6),
    (
        "hideout_helm_2",
        "Hideout Helm: near the Boss Key, second fairy",
        0x4a,
        7,
    ),
];
const BATTLE_CROWNS: [(&str, &str, usize, u8); 10] = [
    ("dk_isles_1", "DK Isles 1", 0x4c, 6),
    ("dk_isles_2", "DK Isles 2", 0x4c, 7),
    ("jungle_japes", "Jungle Japes", 0x4c, 1),
    ("angry_aztec", "Angry Aztec", 0x4c, 2),
    ("frantic_factory", "Frantic Factory", 0x4c, 3),
    ("gloomy_galleon", "Gloomy Galleon", 0x4c, 4),
    ("fungi_forest", "Fungi Forest", 0x4c, 5),
    ("crystal_caves", "Crystal Caves", 0x4d, 0),
    ("creepy_castle", "Creepy Castle", 0x4d, 1),
    ("hideout_helm", "Hideout Helm", 0x4d, 2),
];
const BOSS_KEYS: [(&str, &str, usize, u8); 8] = [
    ("jungle_japes", "Jungle Japes", 0x3, 2),
    ("angry_aztec", "Angry Aztec", 0x9, 2),
    ("frantic_factory", "Frantic Factory", 0x11, 2),
    ("gloomy_galleon", "Gloomy Galleon", 0x15, 0),
    ("fungi_forest", "Fungi Forest", 0x1d, 4),
    ("crystal_caves", "Crystal Caves", 0x24, 4),
    ("creepy_castle", "Creepy Castle", 0x27, 5),
    ("hideout_helm", "Hideout Helm", 0x2f, 4),
];
const LOCKS: [(&str, &str, usize, u8); 8] = [
    ("lock_1", "Lock 1 unlocked", 0x37, 4),
    ("lock_2", "Lock 2 unlocked", 0x37, 5),
    ("lock_3", "Lock 3 unlocked", 0x37, 6),
    ("lock_4", "Lock 4 unlocked", 0x37, 7),
    ("lock_5", "Lock 5 unlocked", 0x38, 0),
    ("lock_6", "Lock 6 unlocked", 0x38, 1),
    ("lock_7", "Lock 7 unlocked", 0x38, 2),
    ("lock_8", "Lock 8 unlocked", 0x38, 3),
];

fn fields() -> Vec<FieldDefinition> {
    let mut fields = vec![
        catalog_field(
            "progression_cleared",
            "Progression cleared",
            0x36,
            Storage::Bit,
        )
        .bit(0),
        catalog_field("max_health", "Max health", HEALTH_OFFSET, Storage::U8).mask(0x06),
    ];
    for (prefix, flags) in [
        ("characters", &CHARACTERS[..]),
        ("moves", &MOVES),
        ("items", &ITEMS),
        ("banana_fairies", &BANANA_FAIRIES),
        ("battle_crowns", &BATTLE_CROWNS),
        ("boss_keys", &BOSS_KEYS),
        ("locks", &LOCKS),
    ] {
        for (id, label, offset, bit) in flags {
            fields.push(
                catalog_field(&format!("{prefix}.{id}"), label, *offset, Storage::Bit).bit(*bit),
            );
        }
    }
    for field in &mut fields {
        field.behavior.group = Some("file".into());
    }
    fields
}

// Reflected CRC-32 with the final inversion applied, as the upstream table loop computes it.
fn record_crc(bytes: &[u8]) -> u32 {
    trace!(length = bytes.len(), "computing Donkey Kong 64 record CRC");
    crc32(&bytes[..CHECKSUM_OFFSET])
}

fn owns(bytes: &[u8], file: usize, record: usize) -> bool {
    let base = record * RECORD_SIZE;
    // Bit 3 of the health byte marks a file whose Donkey Kong slot is in use.
    usize::from(bytes[base + TAG_OFFSET] >> 2 & 3) == file && bytes[base + HEALTH_OFFSET] & 8 != 0
}

fn candidate(file: usize, record: usize) -> layout::Candidate {
    let base = record * RECORD_SIZE;
    tagged_record_candidate(
        base,
        RECORD_SIZE,
        record,
        move |bytes, record| owns(bytes, file, record),
        move |bytes| {
            bytes[base + CHECKSUM_OFFSET..base + RECORD_SIZE]
                == record_crc(&bytes[base..base + RECORD_SIZE]).to_be_bytes()
        },
    )
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..FILES)
        .map(|file| GameDefinition {
            fields: fields(),
            description: "Edits health, characters, basic moves, coins, fairies, battle crowns, boss keys, and locks in one occupied file of canonical 2 KiB EEPROM. Selects the first record tagged for the file and rejects it if its CRC is damaged; preserves the other records and the system block. Counters, per-level flags, special moves, options and byte-swapped images are unsupported. Requires a game-made template.".into(),
            runtime: runtime::Runtime {
                logical_size: Some(RECORD_SIZE),
                layout: Some(single_file_layout(
                    RECORD_SIZE,
                    (0..RECORDS).map(|record| candidate(file, record)).collect(),
                )),
                after_edit: vec![Store {
                    when: None,
                    destination: Scalar {
                        offset: CHECKSUM_OFFSET,
                        storage: Storage::U32Be,
                        mask: None,
                    },
                    value: ReadValue::new(|bytes| Ok(i64::from(record_crc(bytes)))),
                }],
                save_format: Some("n64_eeprom_2k".into()),
                ..Default::default()
            },
            ..GameDefinition::new(
                format!("donkey-kong-64-canonical-eeprom-file-{}", file + 1),
                format!("Donkey Kong 64 (canonical EEPROM, File {})", file + 1),
                "nintendo-64".into(),
                2048,
            )
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bitwise CRC-32 (reflected 0xedb88320), independent of the production implementation.
    fn reference_crc(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in data {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    crc >> 1 ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    // File index and occupancy per record: file 2, file 1, file 3, and an unoccupied file 1 tag.
    const TAGS: [(u8, bool); RECORDS] = [(1, true), (0, true), (2, true), (0, false)];
    const LIVE: [usize; FILES] = [1, 0, 2];

    fn repair(bytes: &mut [u8], record: usize) {
        let base = record * RECORD_SIZE;
        let crc = reference_crc(&bytes[base..base + CHECKSUM_OFFSET]);
        bytes[base + CHECKSUM_OFFSET..base + RECORD_SIZE].copy_from_slice(&crc.to_be_bytes());
    }

    fn template(file: usize) -> SaveDetectionInput {
        let mut bytes: Vec<u8> = (0..2048).map(|index| (index * 53 + 3) as u8).collect();
        for (record, (index, occupied)) in TAGS.iter().enumerate() {
            let base = record * RECORD_SIZE;
            bytes[base + TAG_OFFSET] = bytes[base + TAG_OFFSET] & !0x0c | index << 2;
            bytes[base + HEALTH_OFFSET] =
                bytes[base + HEALTH_OFFSET] & !0x08 | u8::from(*occupied) << 3;
            repair(&mut bytes, record);
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some(format!("donkey-kong-64-canonical-eeprom-file-{}", file + 1)),
            rom_sha1: None,
        }
    }

    #[test]
    fn crc_matches_the_standard_check_value() {
        assert_eq!(reference_crc(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn every_field_round_trips_and_repairs_only_its_record() {
        for (file, live) in LIVE.into_iter().enumerate() {
            let (handler, identity) = test_handler(schemas, file);
            let input = template(file);
            let base = live * RECORD_SIZE;
            let document = handler.parse(&input, &identity).unwrap();
            assert_eq!(document.fields.len(), 2 + 4 + 4 + 2 + 20 + 10 + 8 + 8);
            for field in &document.fields {
                let values = match &field.value {
                    SaveValue::Bool(value) => vec![SaveValue::Bool(!value)],
                    SaveValue::U32(_) => (0..=3).map(SaveValue::U32).collect(),
                    other => panic!("unexpected value {other:?}"),
                };
                for value in values {
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
                    assert_eq!(output[..base], input.bytes[..base], "{}", field.id);
                    assert_eq!(
                        output[base + RECORD_SIZE..],
                        input.bytes[base + RECORD_SIZE..],
                        "{}",
                        field.id
                    );
                    assert_eq!(
                        output[base + CHECKSUM_OFFSET..base + RECORD_SIZE],
                        reference_crc(&output[base..base + CHECKSUM_OFFSET]).to_be_bytes(),
                        "{}",
                        field.id
                    );
                    let before = &input.bytes[base..base + CHECKSUM_OFFSET];
                    let after = &output[base..base + CHECKSUM_OFFSET];
                    let changed_bytes = before.iter().zip(after).filter(|(a, b)| a != b).count();
                    assert!(
                        changed_bytes <= 1,
                        "{} changed {changed_bytes} bytes",
                        field.id
                    );
                }
            }
        }
    }

    #[test]
    fn known_offsets_match_the_upstream_layout() {
        let input = template(2);
        let base = 2 * RECORD_SIZE;
        let output = test_run(
            schemas,
            2,
            &input,
            &[
                ("max_health", SaveValue::U32(3)),
                ("characters.chunky_kong", SaveValue::Bool(true)),
                ("moves.diving", SaveValue::Bool(true)),
                ("banana_fairies.crystal_caves_2", SaveValue::Bool(true)),
                ("battle_crowns.hideout_helm", SaveValue::Bool(true)),
                ("boss_keys.creepy_castle", SaveValue::Bool(true)),
                ("locks.lock_5", SaveValue::Bool(true)),
                ("progression_cleared", SaveValue::Bool(true)),
            ],
        )
        .unwrap();
        let mut expected = input.bytes.clone();
        expected[base + 0x19e] |= 0x06;
        expected[base + 0xe] |= 1 << 5;
        expected[base + 0x30] |= 1 << 2;
        expected[base + 0x4c] |= 1;
        expected[base + 0x4d] |= 1 << 2;
        expected[base + 0x27] |= 1 << 5;
        expected[base + 0x38] |= 1;
        expected[base + 0x36] |= 1;
        repair(&mut expected, 2);
        assert_eq!(output, expected);
        let output = test_run(schemas, 2, &input, &[("max_health", SaveValue::U32(0))]).unwrap();
        let mut expected = input.bytes.clone();
        expected[base + 0x19e] &= !0x06;
        repair(&mut expected, 2);
        assert_eq!(output, expected);
        assert!(test_run(schemas, 2, &input, &[("max_health", SaveValue::U32(4))]).is_err());
    }

    #[test]
    fn selects_the_occupied_tagged_record_and_rejects_damage() {
        let (handler, identity) = test_handler(schemas, 0);
        let input = template(0);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let live = LIVE[0] * RECORD_SIZE;
        for position in [0, 0x19e, 0x1a0, 0x1a7, 0x1a8, 0x1ab] {
            let mut damaged = input.clone();
            damaged.bytes[live + position] ^= 0x01;
            assert!(
                handler.apply(&damaged, &identity, &[], false).is_err(),
                "byte {position:#x}"
            );
        }
        // An empty file has no owner, and a spare record never takes over a damaged one.
        let mut empty = input.clone();
        empty.bytes[live + HEALTH_OFFSET] &= !0x08;
        repair(&mut empty.bytes, LIVE[0]);
        assert!(handler.apply(&empty, &identity, &[], false).is_err());
        let mut spare = input.clone();
        let spare_base = 3 * RECORD_SIZE;
        spare.bytes[spare_base + HEALTH_OFFSET] |= 0x08;
        repair(&mut spare.bytes, 3);
        assert!(
            test_run(
                schemas,
                0,
                &spare,
                &[("locks.lock_1", SaveValue::Bool(true))]
            )
            .is_ok()
        );
        spare.bytes[live + 0x20] ^= 0x80;
        assert!(handler.apply(&spare, &identity, &[], false).is_err());
        for bytes in [
            vec![0; 2048],
            vec![0xff; 2048],
            vec![0; 2047],
            vec![0; 1024],
        ] {
            let input = SaveDetectionInput {
                bytes,
                ..input.clone()
            };
            assert!(handler.apply(&input, &identity, &[], false).is_err());
        }
    }
}
