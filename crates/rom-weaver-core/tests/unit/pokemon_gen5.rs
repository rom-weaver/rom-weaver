use super::schema::{ChecksumAlgorithm, SchemaSaveHandler, catalog, layout};
use super::{SaveDetectionInput, SaveEdit, SaveIntegrityState, SaveValue};

const SAVE_SIZE: usize = 0x80000;
const TRAINER_OFFSET: usize = 0x19400;
const INVENTORY_OFFSET: usize = 0x18400;

#[derive(Clone, Copy)]
enum Title {
    Black,
    White,
    Black2,
    White2,
}
impl Title {
    const ALL: [Self; 4] = [Self::Black, Self::White, Self::Black2, Self::White2];
    fn id(self) -> &'static str {
        match self {
            Self::Black => "pokemon-black",
            Self::White => "pokemon-white",
            Self::Black2 => "pokemon-black-2",
            Self::White2 => "pokemon-white-2",
        }
    }
    fn version(self) -> u8 {
        match self {
            Self::White => 20,
            Self::Black => 21,
            Self::White2 => 22,
            Self::Black2 => 23,
        }
    }
    fn misc(self) -> usize {
        if matches!(self, Self::Black | Self::White) {
            0x21200
        } else {
            0x21100
        }
    }
    fn bp(self) -> usize {
        if matches!(self, Self::Black | Self::White) {
            0x21d00
        } else {
            0x21b00
        }
    }
    fn key_items(self) -> usize {
        if matches!(self, Self::Black | Self::White) {
            19
        } else {
            27
        }
    }
}

fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0xffffu16;
    for byte in data {
        crc ^= u16::from(*byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

fn handler(title: Title) -> SchemaSaveHandler {
    catalog::builtin_pokemon_gen5::schemas()
        .into_iter()
        .find(|h| h.definitions()[0].identity.id == title.id())
        .unwrap()
}

fn fixture(title: Title, handler: &SchemaSaveHandler) -> Vec<u8> {
    let mut bytes = vec![0xff; SAVE_SIZE];
    let layout = handler.layout_for_test().unwrap();
    let layout::Copies::Fixed { candidates } = &layout.groups[0].copies else {
        panic!("Gen V uses a fixed layout")
    };
    let candidate = &candidates[0];
    for checksum in &candidate.checksums {
        let start = checksum.start.unwrap();
        let length = checksum.length.unwrap();
        bytes[start..start + length].fill(0);
    }
    for (index, unit) in "Hilbert"
        .encode_utf16()
        .chain(std::iter::once(0xffff))
        .enumerate()
    {
        bytes[TRAINER_OFFSET + 4 + index * 2..TRAINER_OFFSET + 6 + index * 2]
            .copy_from_slice(&unit.to_le_bytes());
    }
    bytes[TRAINER_OFFSET + 0x14..TRAINER_OFFSET + 0x18]
        .copy_from_slice(&0x5678_1234u32.to_le_bytes());
    bytes[TRAINER_OFFSET + 0x1f] = title.version();
    bytes[TRAINER_OFFSET + 0x24..TRAINER_OFFSET + 0x26].copy_from_slice(&12u16.to_le_bytes());
    bytes[TRAINER_OFFSET + 0x26] = 34;
    bytes[TRAINER_OFFSET + 0x27] = 56;
    bytes[title.misc()..title.misc() + 4].copy_from_slice(&123_456u32.to_le_bytes());
    bytes[title.misc() + 4] = 5;
    bytes[title.bp()..title.bp() + 2].copy_from_slice(&789u16.to_le_bytes());
    bytes[INVENTORY_OFFSET..INVENTORY_OFFSET + 2].copy_from_slice(&1u16.to_le_bytes());
    bytes[INVENTORY_OFFSET + 2..INVENTORY_OFFSET + 4].copy_from_slice(&20u16.to_le_bytes());
    repair_integrity(handler, &mut bytes);
    bytes
}

fn repair_integrity(handler: &SchemaSaveHandler, bytes: &mut [u8]) {
    let layout = handler.layout_for_test().unwrap();
    let layout::Copies::Fixed { candidates } = &layout.groups[0].copies else {
        panic!("Gen V uses a fixed layout")
    };
    for repair in &candidates[0].repairs {
        match repair {
            layout::Repair::Checksum { checksum } => {
                assert!(matches!(
                    checksum.algorithm,
                    ChecksumAlgorithm::Crc16CcittFalseLe
                ));
                let start = checksum.start.unwrap();
                let length = checksum.length.unwrap();
                let value = crc16(&bytes[start..start + length]);
                bytes[checksum.offset..checksum.offset + 2].copy_from_slice(&value.to_le_bytes());
            }
            layout::Repair::Mirror {
                source,
                target,
                length,
            } => {
                let value = bytes[*source..*source + *length].to_vec();
                bytes[*target..*target + *length].copy_from_slice(&value);
            }
        }
    }
}

fn input(title: Title, bytes: Vec<u8>) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(title.id().into()),
        rom_sha1: None,
    }
}
fn value(document: &super::SaveDocument, id: &str) -> SaveValue {
    document
        .fields
        .iter()
        .find(|f| f.id == id)
        .unwrap()
        .value
        .clone()
}

#[test]
fn parses_each_title_and_exposes_each_inventory_boundary() {
    for title in Title::ALL {
        let handler = handler(title);
        let identity = handler.definitions().remove(0).identity;
        let document = handler
            .parse(&input(title, fixture(title, &handler)), &identity)
            .unwrap();
        assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
        assert_eq!(
            value(&document, "trainer.name"),
            SaveValue::Text("Hilbert".into())
        );
        assert_eq!(
            value(&document, "inventory.items.slot_0.item_id"),
            SaveValue::U32(1)
        );
        assert_eq!(
            value(&document, "inventory.items.slot_0.quantity"),
            SaveValue::U32(20)
        );
        assert!(document.fields.iter().any(|f| f.id
            == format!(
                "inventory.key_items.slot_{}.quantity",
                title.key_items() - 1
            )));
        assert!(!document.fields.iter().any(|f| f.id == format!("inventory.key_items.slot_{}.quantity", title.key_items())));
    }
}

#[test]
fn edits_inventory_text_and_scalars_while_preserving_padding() {
    for title in Title::ALL {
        let handler = handler(title);
        let identity = handler.definitions().remove(0).identity;
        let mut bytes = fixture(title, &handler);
        bytes[INVENTORY_OFFSET + 0x418] = 0xa5;
        repair_integrity(&handler, &mut bytes);
        let source = input(title, bytes.clone());
        let result = handler
            .apply(
                &source,
                &identity,
                &[
                    SaveEdit {
                        field: "trainer.name".into(),
                        value: SaveValue::Text("A♀é".into()),
                    },
                    SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(9_999_999),
                    },
                    SaveEdit {
                        field: "inventory.items.slot_0.item_id".into(),
                        value: SaveValue::U32(1),
                    },
                    SaveEdit {
                        field: "inventory.items.slot_0.quantity".into(),
                        value: SaveValue::U32(999),
                    },
                ],
                false,
            )
            .unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(output[INVENTORY_OFFSET + 0x418], 0xa5);
        assert_eq!(
            value(&result.document, "trainer.name"),
            SaveValue::Text("A♀é".into())
        );
        assert_eq!(
            &output[INVENTORY_OFFSET..INVENTORY_OFFSET + 2],
            &1u16.to_le_bytes()
        );
        assert_eq!(
            &output[INVENTORY_OFFSET + 2..INVENTORY_OFFSET + 4],
            &999u16.to_le_bytes()
        );
    }
}

#[test]
fn corruption_and_ranges_are_rejected() {
    let title = Title::Black2;
    let handler = handler(title);
    let identity = handler.definitions().remove(0).identity;
    let mut bytes = fixture(title, &handler);
    bytes[TRAINER_OFFSET] ^= 1;
    assert!(handler.parse(&input(title, bytes), &identity).is_err());
    let source = input(title, fixture(title, &handler));
    for (field, number) in [
        ("trainer.money", 10_000_000),
        ("inventory.items.slot_0.item_id", 639),
        ("inventory.key_items.slot_0.quantity", 2),
    ] {
        assert!(
            handler
                .apply(
                    &source,
                    &identity,
                    &[SaveEdit {
                        field: field.into(),
                        value: SaveValue::U32(number)
                    }],
                    false
                )
                .is_err()
        );
    }
    assert!(
        handler
            .apply(
                &source,
                &identity,
                &[SaveEdit {
                    field: "trainer.name".into(),
                    value: SaveValue::Text("😀😀😀😀".into())
                }],
                false
            )
            .is_err()
    );
}

#[test]
fn full_trainer_id_range_and_independent_checksum_vector_are_supported() {
    assert_eq!(crc16(b"123456789"), 0x29b1);
    for title in Title::ALL {
        let handler = handler(title);
        let identity = handler.definitions().remove(0).identity;
        let source = input(title, fixture(title, &handler));
        for boundary in [0, 65_535] {
            let result = handler
                .apply(
                    &source,
                    &identity,
                    &[
                        SaveEdit {
                            field: "trainer.id".into(),
                            value: SaveValue::U32(boundary),
                        },
                        SaveEdit {
                            field: "trainer.secret_id".into(),
                            value: SaveValue::U32(boundary),
                        },
                    ],
                    false,
                )
                .unwrap();
            assert_eq!(
                value(&result.document, "trainer.id"),
                SaveValue::U32(boundary)
            );
            assert_eq!(
                value(&result.document, "trainer.secret_id"),
                SaveValue::U32(boundary)
            );
        }
    }
}
