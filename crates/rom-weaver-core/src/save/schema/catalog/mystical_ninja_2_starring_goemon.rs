use super::rules::{Check, Condition, ReadValue, Scalar, Store};
use super::*;
use tracing::trace;

// The Japanese cartridge-SRAM layout, linked costume and character writes, and CRC MUST follow this MIT-licensed source.
// https://github.com/RyudoSynbios/game-tools-collection/tree/15d71340c3f1717745139c2e0774510cd37dfbdd/src/lib/templates/mystical-ninja-2-starring-goemon/saveEditor
// The USA and Europe versions keep the same records in a Controller Pak note, which has no schema container, so only Japan is exposed.
const OPTIONS_SIZE: usize = 0x10;
const SLOT_START: usize = 0x10;
const SLOT_SIZE: usize = 0x130;
const SLOTS: usize = 3;
const PLAYERS: usize = 4;
const PLAYER_START: usize = 0x7a;
const PLAYER_SIZE: usize = 0xa;

/// CRC-32/BZIP2 (polynomial `0x04c11db7`, init and xorout `0xffffffff`, no reflection) over one
/// record. The game ignores the record's first eight bytes when computing it; the checksum itself
/// is stored in bytes 4..8.
fn checksum(record: &[u8]) -> u32 {
    let crc = record
        .iter()
        .enumerate()
        .fold(0xffff_ffffu32, |mut crc, (index, byte)| {
            crc ^= u32::from(if index < 8 { 0 } else { *byte }) << 24;
            for _ in 0..8 {
                crc = if crc & 0x8000_0000 != 0 {
                    (crc << 1) ^ 0x04c1_1db7
                } else {
                    crc << 1
                };
            }
            crc
        });
    trace!(
        length = record.len(),
        crc = !crc,
        "computed Mystical Ninja 2 record CRC"
    );
    !crc
}

/// Slot `None` is the options record; `Some(index)` is one of the three save slots.
fn record(slot: Option<usize>) -> (usize, usize) {
    slot.map_or((0, OPTIONS_SIZE), |index| {
        (SLOT_START + index * SLOT_SIZE, SLOT_SIZE)
    })
}

fn bit_field(id: &str, label: &str, offset: usize, bit: u8) -> FieldDefinition {
    catalog_field(id, label, offset, Storage::Bit).bit(bit)
}

fn copy_bit(
    offset: usize,
    mask: u32,
    value: impl Fn(&[u8]) -> bool + Send + Sync + 'static,
) -> Store {
    Store {
        when: None,
        destination: Scalar {
            offset,
            storage: Storage::U8,
            mask: Some(mask),
        },
        value: ReadValue::new(move |bytes| Ok(i64::from(value(bytes)))),
    }
}

fn slot_fields(base: usize) -> Vec<FieldDefinition> {
    let characters = base + 9;
    let mut fields = vec![
        catalog_field("location", "Location", base + 8, Storage::U8).choices(choices(&[
            ("Lost'n Town", 1),
            ("Otohime Town", 2),
            ("Spook Village", 3),
            ("Tree Stump Village", 4),
            ("Floating World Town", 5),
            ("Creep Village", 6),
            ("Home of Wiseman", 7),
            ("Kappa Road", 8),
            ("Kokeshi Road", 9),
            ("Kaiware Road", 10),
            ("Cloud Fortress", 11),
        ])),
        // The count at +9 drives the character roster; Sasuke and Yae each also keep an unlock bit.
        catalog_field(
            "unlocked_characters",
            "Unlocked characters",
            characters,
            Storage::U8,
        )
        .choices(choices(&[
            ("Goemon and Ebisumaru", 2),
            ("Goemon, Ebisumaru and Sasuke", 3),
            ("Goemon, Ebisumaru, Sasuke and Yae", 4),
        ]))
        .behavior(field::FieldBehavior {
            on_edit: vec![
                copy_bit(base + 0x10f, 0x80, move |bytes| bytes[characters] >= 3),
                copy_bit(base + 0x112, 0x80, move |bytes| bytes[characters] == 4),
            ],
            ..Default::default()
        }),
        bit_field("chain_pipe", "Chain Pipe unlocked", base + 0x22, 2),
        bit_field(
            "underwater_device",
            "Underwater Device unlocked",
            base + 0x23,
            3,
        ),
        bit_field(
            "costumes_purchasable",
            "Alternative costumes can be bought",
            base + 0x30,
            5,
        ),
    ];
    let costumes = [
        ("goemon_impact", "Goemon: Impact", 0x11c),
        ("goemon_satchel", "Goemon: Satchel", 0x11d),
        ("goemon_turban", "Goemon: Turban", 0x11e),
        ("ebisumaru_sumo_belt", "Ebisumaru: Sumo belt", 0x120),
        ("ebisumaru_tights", "Ebisumaru: Tights", 0x121),
        ("ebisumaru_raccoon", "Ebisumaru: Raccoon", 0x122),
        ("sasuke_bloomers", "Sasuke: Bloomers", 0x124),
        ("sasuke_maid_outfit", "Sasuke: Maid outfit", 0x125),
        ("sasuke_fur_coat", "Sasuke: Fur coat", 0x126),
        ("yae_kirameki_uniform", "Yae: Kirameki Uniform", 0x128),
        ("yae_rabbit_fur", "Yae: Rabbit fur", 0x129),
        ("yae_swimsuit", "Yae: Swimsuit", 0x12a),
    ];
    for (index, (id, label, offset)) in costumes.into_iter().enumerate() {
        let source = base + offset;
        // Owning a costume also sets its "bought" bit.
        fields.push(
            bit_field(&format!("costume.{id}"), label, source, 0).behavior(field::FieldBehavior {
                on_edit: vec![copy_bit(
                    base + 0x31 + index / 8,
                    1 << (index % 8),
                    move |bytes| bytes[source] & 1 != 0,
                )],
                ..Default::default()
            }),
        );
    }
    for player in 0..PLAYERS {
        let start = base + PLAYER_START + player * PLAYER_SIZE;
        let prefix = format!("player_{}", player + 1);
        let name = format!("Player {}", player + 1);
        fields.extend([
            // Game Tools Collection shows lives as the stored byte minus one (2 to 99).
            catalog_field(
                &format!("{prefix}.lives"),
                &format!("{name} lives (stored value)"),
                start + 1,
                Storage::U8,
            )
            .min(3)
            .max(100),
            catalog_field(
                &format!("{prefix}.armor"),
                &format!("{name} armor"),
                start + 3,
                Storage::U8,
            )
            .max(3),
            catalog_field(
                &format!("{prefix}.coins"),
                &format!("{name} coins"),
                start + 4,
                Storage::U16Be,
            )
            .max(999),
            catalog_field(
                &format!("{prefix}.weapon_level"),
                &format!("{name} weapon level"),
                start + 7,
                Storage::U8,
            )
            .max(2),
            catalog_field(
                &format!("{prefix}.item"),
                &format!("{name} item"),
                start + 8,
                Storage::U8,
            )
            .choices(choices(&[
                ("None", 0),
                ("Rice balls", 1),
                ("Plum rice balls", 2),
                ("Fish rice balls", 3),
            ])),
        ]);
    }
    fields
}

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let games = std::iter::once(None).chain((0..SLOTS).map(Some)).map(|slot| {
        let (start, length) = record(slot);
        let valid = move |bytes: &[u8]| {
            checksum(&bytes[start..start + length])
                == u32::from_be_bytes(bytes[start + 4..start + 8].try_into().unwrap())
        };
        let mut checks = Vec::new();
        // An empty slot is reported first: its stored CRC is not meaningful.
        if slot.is_some() {
            checks.push(Check {
                when: None,
                assert: Condition::new(move |bytes| Ok(bytes[start + 8] != 0)),
                code: "save_slot_empty".into(),
                message: "The selected Mystical Ninja 2 slot is empty.".into(),
                section_id: None,
                warning: None,
            });
        }
        checks.push(Check {
            when: None,
            assert: Condition::new(move |bytes| Ok(valid(bytes))),
            code: "save_checksum_mismatch".into(),
            message: "The Mystical Ninja 2 record checksum is invalid.".into(),
            section_id: None,
            warning: None,
        });
        let (fields, id, name, description) = match slot {
            None => (
                vec![catalog_field("sound", "Sound", 9, Storage::U8).choices(choices(&[("Stereo", 0), ("Monaural", 1)]))],
                "mystical-ninja-2-starring-goemon-canonical-sram-japan-options".to_owned(),
                "Mystical Ninja 2 Starring Goemon (canonical SRAM, Japan, Options)".to_owned(),
                "Edits the sound setting in the options record of canonical 32 KiB Japanese cartridge SRAM and repairs its CRC. Slots and the other options bytes are preserved; the language byte is read-only. USA and Europe Controller Pak saves and byte-swapped images are unsupported. Requires a game-made template.",
            ),
            Some(index) => (
                slot_fields(start),
                format!("mystical-ninja-2-starring-goemon-canonical-sram-japan-slot-{}", index + 1),
                format!("Mystical Ninja 2 Starring Goemon (canonical SRAM, Japan, Slot {})", index + 1),
                "Edits the location, character roster, powers, costumes and per-player stats of one occupied slot in canonical 32 KiB Japanese cartridge SRAM and repairs the slot CRC. Linked unlock bits are written together. Stage, entry pass and flag data are unsupported, as are USA and Europe Controller Pak saves and byte-swapped images. Requires a game-made template.",
            ),
        };
        GameDefinition {
            fields,
            description: description.into(),
            runtime: runtime::Runtime {
                checks,
                after_edit: vec![Store {
                    when: None,
                    destination: Scalar { offset: start + 4, storage: Storage::U32Be, mask: None },
                    value: ReadValue::new(move |bytes| Ok(i64::from(checksum(&bytes[start..start + length])))),
                }],
                save_format: Some("n64_sram_32k".into()),
                ..Default::default()
            },
            ..GameDefinition::new(id, name, "nintendo-64".into(), 32768)
        }
    });
    build(games.collect(), BTreeMap::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Table-driven CRC-32/BZIP2, written independently of the production bit loop.
    fn crc_bzip2(data: &[u8]) -> u32 {
        let table: Vec<u32> = (0..256u32)
            .map(|byte| {
                (0..8).fold(byte << 24, |value, _| {
                    (value << 1) ^ if value >> 31 != 0 { 0x04c1_1db7 } else { 0 }
                })
            })
            .collect();
        !data.iter().fold(0xffff_ffffu32, |crc, byte| {
            (crc << 8) ^ table[usize::from((crc >> 24) as u8 ^ byte)]
        })
    }

    fn expected_crc(record: &[u8]) -> u32 {
        let mut zeroed = record.to_vec();
        zeroed[..8].fill(0);
        crc_bzip2(&zeroed)
    }

    fn repair(bytes: &mut [u8], start: usize, length: usize) {
        let crc = expected_crc(&bytes[start..start + length]);
        bytes[start + 4..start + 8].copy_from_slice(&crc.to_be_bytes());
    }

    fn fixture() -> Vec<u8> {
        let mut bytes: Vec<u8> = (0..32768).map(|index| (index * 7 + 3) as u8).collect();
        for slot in 0..SLOTS {
            let start = SLOT_START + slot * SLOT_SIZE;
            bytes[start + 8] = 1 + slot as u8;
            bytes[start + 9] = 2;
            bytes[start + 0x10f] &= 0x7f;
            bytes[start + 0x112] &= 0x7f;
            repair(&mut bytes, start, SLOT_SIZE);
        }
        repair(&mut bytes, 0, OPTIONS_SIZE);
        bytes
    }

    fn input(
        handler: &SchemaSaveHandler,
        bytes: Vec<u8>,
    ) -> (SaveDetectionInput, SaveGameIdentity) {
        let identity = handler.definitions().remove(0).identity;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(identity.id.clone()),
            rom_sha1: None,
        };
        (input, identity)
    }

    fn edit(field: &str, value: SaveValue) -> SaveEdit {
        SaveEdit {
            field: field.into(),
            value,
        }
    }

    fn apply(handler: &SchemaSaveHandler, bytes: &[u8], edits: &[SaveEdit]) -> Result<Vec<u8>> {
        let (input, identity) = input(handler, bytes.to_vec());
        Ok(handler
            .apply(&input, &identity, edits, false)?
            .bytes
            .unwrap_or_else(|| bytes.to_vec()))
    }

    fn value(handler: &SchemaSaveHandler, bytes: &[u8], field: &str) -> SaveValue {
        let (input, identity) = input(handler, bytes.to_vec());
        let document = handler.parse(&input, &identity).unwrap();
        document
            .fields
            .into_iter()
            .find(|candidate| candidate.id == field)
            .unwrap()
            .value
    }

    #[test]
    fn crc_matches_the_standard_check_value() {
        assert_eq!(crc_bzip2(b"123456789"), 0xfc89_1918);
        let mut record = [0u8; 9];
        record.copy_from_slice(b"123456789");
        // Production zeroes the first eight bytes, so only the last byte contributes.
        assert_eq!(
            checksum(&record),
            crc_bzip2(&[0, 0, 0, 0, 0, 0, 0, 0, b'9'])
        );
        assert_eq!(checksum(&[0xff; 0x130]), expected_crc(&[0xff; 0x130]));
    }

    #[test]
    fn profiles_cover_the_options_record_and_three_slots() {
        let ids: Vec<_> = schemas()
            .iter()
            .map(|handler| handler.definitions().remove(0).identity.id)
            .collect();
        assert_eq!(
            ids,
            [
                "mystical-ninja-2-starring-goemon-canonical-sram-japan-options",
                "mystical-ninja-2-starring-goemon-canonical-sram-japan-slot-1",
                "mystical-ninja-2-starring-goemon-canonical-sram-japan-slot-2",
                "mystical-ninja-2-starring-goemon-canonical-sram-japan-slot-3",
            ]
        );
    }

    #[test]
    fn slot_edits_write_linked_bits_and_repair_only_that_slot_crc() {
        for (index, handler) in schemas().into_iter().skip(1).enumerate() {
            let base = SLOT_START + index * SLOT_SIZE;
            let original = fixture();
            let edits = [
                edit("location", SaveValue::Enum("Kappa Road".into())),
                edit(
                    "unlocked_characters",
                    SaveValue::Enum("Goemon, Ebisumaru, Sasuke and Yae".into()),
                ),
                edit("chain_pipe", SaveValue::Bool(true)),
                edit("underwater_device", SaveValue::Bool(true)),
                edit("costumes_purchasable", SaveValue::Bool(true)),
                edit("costume.goemon_impact", SaveValue::Bool(true)),
                edit("costume.sasuke_fur_coat", SaveValue::Bool(true)),
                edit("costume.yae_swimsuit", SaveValue::Bool(true)),
                edit("player_1.lives", SaveValue::U32(100)),
                edit("player_2.armor", SaveValue::U32(3)),
                edit("player_3.coins", SaveValue::U32(999)),
                edit("player_4.weapon_level", SaveValue::U32(2)),
                edit("player_4.item", SaveValue::Enum("Fish rice balls".into())),
            ];
            let output = apply(&handler, &original, &edits).unwrap();
            let mut expected = original.clone();
            expected[base + 8] = 8;
            expected[base + 9] = 4;
            expected[base + 0x10f] |= 0x80;
            expected[base + 0x112] |= 0x80;
            expected[base + 0x22] |= 1 << 2;
            expected[base + 0x23] |= 1 << 3;
            expected[base + 0x30] |= 1 << 5;
            expected[base + 0x11c] |= 1;
            expected[base + 0x126] |= 1;
            expected[base + 0x12a] |= 1;
            expected[base + 0x31] |= 1 << 0;
            expected[base + 0x32] |= 1 << 0;
            expected[base + 0x32] |= 1 << 3;
            expected[base + 0x7a + 1] = 100;
            expected[base + 0x7a + 0xa + 3] = 3;
            expected[base + 0x7a + 2 * 0xa + 4..base + 0x7a + 2 * 0xa + 6]
                .copy_from_slice(&999u16.to_be_bytes());
            expected[base + 0x7a + 3 * 0xa + 7] = 2;
            expected[base + 0x7a + 3 * 0xa + 8] = 3;
            repair(&mut expected, base, SLOT_SIZE);
            assert_eq!(output, expected);
            assert_eq!(
                output[base + 4..base + 8],
                crc_bzip2(&{
                    let mut record = output[base..base + SLOT_SIZE].to_vec();
                    record[..8].fill(0);
                    record
                })
                .to_be_bytes()
            );
            assert_eq!(
                value(&handler, &output, "location"),
                SaveValue::Enum("Kappa Road".into())
            );
            assert_eq!(
                value(&handler, &output, "player_3.coins"),
                SaveValue::U32(999)
            );
            assert_eq!(
                value(&handler, &output, "costume.yae_swimsuit"),
                SaveValue::Bool(true)
            );
            for other in (0..SLOTS).filter(|other| *other != index) {
                let start = SLOT_START + other * SLOT_SIZE;
                assert_eq!(
                    output[start..start + SLOT_SIZE],
                    original[start..start + SLOT_SIZE]
                );
            }
            assert_eq!(output[..SLOT_START], original[..SLOT_START]);
        }
    }

    #[test]
    fn reverting_unlocks_clears_the_linked_bits() {
        let handler = schemas().remove(1);
        let mut start = fixture();
        start[SLOT_START + 9] = 4;
        start[SLOT_START + 0x10f] |= 0x80;
        start[SLOT_START + 0x112] |= 0x80;
        start[SLOT_START + 0x11d] |= 1;
        start[SLOT_START + 0x31] |= 0b10;
        start[SLOT_START + 0x32] |= 1;
        repair(&mut start, SLOT_START, SLOT_SIZE);
        let output = apply(
            &handler,
            &start,
            &[
                edit(
                    "unlocked_characters",
                    SaveValue::Enum("Goemon and Ebisumaru".into()),
                ),
                edit("costume.goemon_satchel", SaveValue::Bool(false)),
            ],
        )
        .unwrap();
        let mut expected = start.clone();
        expected[SLOT_START + 9] = 2;
        expected[SLOT_START + 0x10f] &= 0x7f;
        expected[SLOT_START + 0x112] &= 0x7f;
        expected[SLOT_START + 0x11d] &= !1;
        expected[SLOT_START + 0x31] &= !0b10;
        repair(&mut expected, SLOT_START, SLOT_SIZE);
        assert_eq!(output, expected);
        // Sasuke alone keeps his bit and leaves Yae's clear.
        let output = apply(
            &handler,
            &start,
            &[edit(
                "unlocked_characters",
                SaveValue::Enum("Goemon, Ebisumaru and Sasuke".into()),
            )],
        )
        .unwrap();
        assert_ne!(output[SLOT_START + 0x10f] & 0x80, 0);
        assert_eq!(output[SLOT_START + 0x112] & 0x80, 0);
    }

    #[test]
    fn options_edit_repairs_the_options_crc() {
        let handler = schemas().remove(0);
        let original = fixture();
        let output = apply(
            &handler,
            &original,
            &[edit("sound", SaveValue::Enum("Monaural".into()))],
        )
        .unwrap();
        let mut expected = original.clone();
        expected[9] = 1;
        repair(&mut expected, 0, OPTIONS_SIZE);
        assert_eq!(output, expected);
        assert_ne!(output[4..8], original[4..8]);
        assert_eq!(
            value(&handler, &output, "sound"),
            SaveValue::Enum("Monaural".into())
        );
    }

    #[test]
    fn damaged_empty_and_out_of_range_inputs_are_rejected() {
        let handlers = schemas();
        let original = fixture();
        for (profile, start, length) in [
            (0, 0, OPTIONS_SIZE),
            (1, SLOT_START, SLOT_SIZE),
            (3, SLOT_START + 2 * SLOT_SIZE, SLOT_SIZE),
        ] {
            let handler = &handlers[profile];
            let (input, identity) = input(handler, original.clone());
            assert!(
                handler
                    .apply(&input, &identity, &[], false)
                    .unwrap()
                    .bytes
                    .is_none()
            );
            for index in [start + 8, start + length - 1] {
                let mut damaged = original.clone();
                damaged[index] ^= 1;
                assert!(
                    apply(handler, &damaged, &[]).is_err(),
                    "profile {profile} byte {index}"
                );
            }
            // The first four bytes of a record are outside the stored CRC.
            let mut ignored = original.clone();
            ignored[start] ^= 0xff;
            assert!(apply(handler, &ignored, &[]).is_ok());
            assert!(apply(handler, &[0; 32768], &[]).is_err());
            assert!(apply(handler, &original[..32767], &[]).is_err());
        }
        let mut empty = original.clone();
        empty[SLOT_START + 8] = 0;
        repair(&mut empty, SLOT_START, SLOT_SIZE);
        assert!(apply(&handlers[1], &empty, &[]).is_err());
        // An empty slot with a stale CRC reports the empty slot, not a checksum mismatch.
        let mut stale = original.clone();
        stale[SLOT_START + 8] = 0;
        assert_ne!(
            u32::from_be_bytes(stale[SLOT_START + 4..SLOT_START + 8].try_into().unwrap()),
            expected_crc(&stale[SLOT_START..SLOT_START + SLOT_SIZE])
        );
        let Err(RomWeaverError::ValidationCode(error)) = apply(&handlers[1], &stale, &[]) else {
            panic!("expected a validation code error");
        };
        assert_eq!(error.code(), "save_slot_empty");
        // A damaged neighbouring slot does not block an edit of a healthy one.
        let mut neighbour = original.clone();
        neighbour[SLOT_START + SLOT_SIZE + 20] ^= 1;
        assert!(
            apply(
                &handlers[1],
                &neighbour,
                &[edit("chain_pipe", SaveValue::Bool(true))]
            )
            .is_ok()
        );
        for (field, bad) in [
            ("player_1.coins", 1000),
            ("player_1.lives", 2),
            ("player_1.lives", 101),
            ("player_1.armor", 4),
            ("player_1.weapon_level", 3),
        ] {
            assert!(
                apply(&handlers[1], &original, &[edit(field, SaveValue::U32(bad))]).is_err(),
                "{field} {bad}"
            );
        }
        assert!(
            apply(
                &handlers[1],
                &original,
                &[edit(
                    "unlocked_characters",
                    SaveValue::Enum("Nobody".into())
                )]
            )
            .is_err()
        );
    }
}
