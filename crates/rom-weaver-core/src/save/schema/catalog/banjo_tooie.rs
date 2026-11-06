use super::rare_eeprom;
use super::*;

// Record tags and checksum range:
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/banjo-tooie/saveEditor
// The checksum hash follows https://github.com/bryc/rare-n64-chksm (see `rare_eeprom`).
// Only counters stored before offset 0xa6 are exposed: later fields move by 30 bits in the
// US version, and that per-version shifting is not reproduced here.
const FILES: usize = 3;
const RECORDS: usize = 4;
const FIRST_RECORD: usize = 0x100;
const RECORD_SIZE: usize = 0x1c0;
const CHECKSUM_OFFSET: usize = 0x1b8;
const COUNTERS: [(&str, &str, usize, i64); 15] = [
    ("eggs", "Blue eggs", 0x2b, 999),
    ("fire_eggs", "Fire eggs", 0x2d, 999),
    ("ice_eggs", "Ice eggs", 0x2f, 999),
    ("grenade_eggs", "Grenade eggs", 0x31, 999),
    (
        "clockwork_kazooie_eggs",
        "Clockwork Kazooie eggs",
        0x33,
        999,
    ),
    ("red_feathers", "Red feathers", 0x37, 999),
    ("gold_feathers", "Gold feathers", 0x39, 999),
    ("glowbos", "Glowbos", 0x3b, 17),
    ("extra_honeycombs", "Extra honeycombs", 0x3d, 25),
    ("cheato_pages", "Cheato's pages", 0x3f, 25),
    ("doubloons", "Doubloons", 0x47, 30),
    ("strange_looking_seed", "Strange-looking seed", 0x4b, 2),
    ("fish", "Fish", 0x4d, 1),
    ("ice_key", "Ice key", 0x51, 1),
    ("mega_glowbos", "Mega glowbos", 0x53, 1),
];

fn owns(bytes: &[u8], file: usize, record: usize) -> bool {
    let base = FIRST_RECORD + record * RECORD_SIZE;
    bytes[base..base + 4] == *b"KHJC" && usize::from(bytes[base + 0xa]) == file + 1
}

fn candidate(file: usize, record: usize) -> layout::Candidate {
    let base = FIRST_RECORD + record * RECORD_SIZE;
    tagged_record_candidate(
        base,
        RECORD_SIZE,
        record,
        move |bytes, record| owns(bytes, file, record),
        move |bytes| {
            rare_eeprom::valid(bytes, base + CHECKSUM_OFFSET, base..base + CHECKSUM_OFFSET)
        },
    )
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = (0..FILES)
        .map(|file| GameDefinition {
            fields: COUNTERS
                .iter()
                .map(|(id, label, offset, max)| {
                    catalog_field(id, label, *offset, Storage::U16Be)
                        .max(*max)
                        .behavior(field::FieldBehavior {
                            group: Some("file".into()),
                            ..Default::default()
                        })
                })
                .collect(),
            description: "Edits inventory counters within their game limits in one occupied file of canonical 2 KiB EEPROM. Selects the first record tagged for the file and rejects it if its checksum is damaged; preserves the other records and the shared settings header. Collection flags, per-version bit-shifted fields and byte-swapped images are unsupported. Requires a game-made template.".into(),
            runtime: runtime::Runtime {
                logical_size: Some(RECORD_SIZE),
                layout: Some(single_file_layout(
                    RECORD_SIZE,
                    (0..RECORDS).map(|record| candidate(file, record)).collect(),
                )),
                after_edit: rare_eeprom::stores(CHECKSUM_OFFSET, 0..CHECKSUM_OFFSET),
                save_format: Some("n64_eeprom_2k".into()),
                ..Default::default()
            },
            ..GameDefinition::new(
                format!("banjo-tooie-canonical-eeprom-file-{}", file + 1),
                format!("Banjo-Tooie (canonical EEPROM, File {})", file + 1),
                "nintendo-64".into(),
                2048,
            )
        })
        .collect();
    build(games, BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::rare_eeprom::reference_checksum;
    use super::*;

    // Save-index bytes per record: file 2, file 1, file 3, and a record without the KHJC tag.
    const TAGS: [Option<u8>; RECORDS] = [Some(2), Some(1), Some(3), None];

    fn repair(bytes: &mut [u8], record: usize) {
        let base = FIRST_RECORD + record * RECORD_SIZE;
        let [high, low] = reference_checksum(&bytes[base..base + CHECKSUM_OFFSET]);
        bytes[base + CHECKSUM_OFFSET..base + CHECKSUM_OFFSET + 4]
            .copy_from_slice(&high.to_be_bytes());
        bytes[base + CHECKSUM_OFFSET + 4..base + RECORD_SIZE].copy_from_slice(&low.to_be_bytes());
    }

    fn template(file: usize) -> SaveDetectionInput {
        let mut bytes: Vec<u8> = (0..2048).map(|index| (index * 29 + 7) as u8).collect();
        for (record, tag) in TAGS.iter().enumerate() {
            let base = FIRST_RECORD + record * RECORD_SIZE;
            if let Some(tag) = tag {
                bytes[base..base + 4].copy_from_slice(b"KHJC");
                bytes[base + 0xa] = *tag;
            }
            repair(&mut bytes, record);
        }
        SaveDetectionInput {
            bytes,
            selected_game: Some(format!("banjo-tooie-canonical-eeprom-file-{}", file + 1)),
            rom_sha1: None,
        }
    }

    // Record holding each file in the template.
    const LIVE: [usize; FILES] = [1, 0, 2];

    #[test]
    fn every_counter_round_trips_and_repairs_only_its_record() {
        for (file, live) in LIVE.into_iter().enumerate() {
            let (handler, identity) = test_handler(schemas, file);
            let input = template(file);
            let base = FIRST_RECORD + live * RECORD_SIZE;
            let document = handler.parse(&input, &identity).unwrap();
            assert_eq!(document.fields.len(), COUNTERS.len());
            for (field, (id, _, offset, max)) in document.fields.iter().zip(COUNTERS) {
                assert_eq!(field.id, id);
                for value in [0, 1, max as u32] {
                    let output =
                        test_run(schemas, file, &input, &[(id, SaveValue::U32(value))]).unwrap();
                    let mut expected = input.bytes.clone();
                    expected[base + offset..base + offset + 2]
                        .copy_from_slice(&(value as u16).to_be_bytes());
                    repair(&mut expected, live);
                    assert_eq!(output, expected, "{id} = {value}");
                    let reread = handler
                        .parse(
                            &SaveDetectionInput {
                                bytes: output,
                                ..input.clone()
                            },
                            &identity,
                        )
                        .unwrap();
                    let changed = reread.fields.iter().find(|f| f.id == id).unwrap();
                    assert_eq!(changed.value, SaveValue::U32(value));
                }
                assert!(
                    test_run(
                        schemas,
                        file,
                        &input,
                        &[(id, SaveValue::U32(max as u32 + 1))]
                    )
                    .is_err()
                );
            }
        }
    }

    #[test]
    fn edits_combine_in_one_checksum_pass() {
        let input = template(1);
        let base = FIRST_RECORD;
        let output = test_run(
            schemas,
            1,
            &input,
            &[
                ("red_feathers", SaveValue::U32(0x3e7)),
                ("gold_feathers", SaveValue::U32(0x100)),
                ("eggs", SaveValue::U32(999)),
            ],
        )
        .unwrap();
        let mut expected = input.bytes.clone();
        expected[base + 0x37..base + 0x3b].copy_from_slice(&[0x03, 0xe7, 0x01, 0x00]);
        expected[base + 0x2b..base + 0x2d].copy_from_slice(&[0x03, 0xe7]);
        repair(&mut expected, 0);
        assert_eq!(output, expected);
    }

    #[test]
    fn selects_the_tagged_record_and_rejects_damage() {
        let (handler, identity) = test_handler(schemas, 0);
        let input = template(0);
        assert!(
            handler
                .apply(&input, &identity, &[], false)
                .unwrap()
                .bytes
                .is_none()
        );
        let live = FIRST_RECORD + RECORD_SIZE;
        // A later record carrying the same tag never replaces a damaged first one.
        let mut duplicate = input.clone();
        let spare = FIRST_RECORD + 3 * RECORD_SIZE;
        duplicate.bytes[spare..spare + 4].copy_from_slice(b"KHJC");
        duplicate.bytes[spare + 0xa] = 1;
        repair(&mut duplicate.bytes, 3);
        assert!(test_run(schemas, 0, &duplicate, &[("eggs", SaveValue::U32(5))]).is_ok());
        for position in [0x10, 0x1b7, 0x1b8, 0x1bf] {
            let mut damaged = duplicate.clone();
            damaged.bytes[live + position] ^= 0x40;
            assert!(handler.apply(&damaged, &identity, &[], false).is_err());
        }
        // The tag, not the position, decides ownership.
        let mut retagged = input.clone();
        retagged.bytes[live + 0xa] = 2;
        repair(&mut retagged.bytes, 1);
        assert!(handler.apply(&retagged, &identity, &[], false).is_err());
        let mut untagged = input.clone();
        untagged.bytes[live] = b'X';
        repair(&mut untagged.bytes, 1);
        assert!(handler.apply(&untagged, &identity, &[], false).is_err());
        for bytes in [
            vec![0; 2048],
            vec![0xff; 2048],
            vec![0; 2047],
            vec![0; 4096],
        ] {
            let input = SaveDetectionInput {
                bytes,
                ..input.clone()
            };
            assert!(handler.apply(&input, &identity, &[], false).is_err());
        }
    }
}
