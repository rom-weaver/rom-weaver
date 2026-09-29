use super::schema::{SchemaSaveHandler, catalog};
use super::{SaveDetectionInput, SaveEdit, SaveIntegrityState, SaveValue};

const SAVE_SIZE: usize = 0x20_000;
const SLOT_SIZE: usize = 0xe000;
const SECTION_SIZE: usize = 0x1000;
const SECTION_DATA_SIZE: usize = 0xf80;
pub(super) const SIGNATURE: u32 = 0x0801_2025;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Family {
    Rs,
    Emerald,
    Frlg,
}

impl Family {
    pub(super) fn identity(self, id: &str) -> super::SaveGameIdentity {
        catalog::builtin_pokemon_gen3::schemas()
            .into_iter()
            .flat_map(|handler| handler.definitions())
            .find(|definition| definition.identity.id == id)
            .unwrap()
            .identity
    }

    fn id(self) -> &'static str {
        match self {
            Self::Rs => "pokemon-ruby",
            Self::Emerald => "pokemon-emerald",
            Self::Frlg => "pokemon-firered",
        }
    }

    pub(super) fn checksum_size(self, section: u8) -> usize {
        const RS: [usize; 14] = [
            0x890, 0xf80, 0xf80, 0xf80, 0xc40, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80,
            0xf80, 0x7d0,
        ];
        const EMERALD: [usize; 14] = [
            0xf2c, 0xf80, 0xf80, 0xf80, 0xf08, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80,
            0xf80, 0x7d0,
        ];
        const FRLG: [usize; 14] = [
            0xf24, 0xf80, 0xf80, 0xf80, 0xee8, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80, 0xf80,
            0xf80, 0x7d0,
        ];
        (match self {
            Self::Rs => RS,
            Self::Emerald => EMERALD,
            Self::Frlg => FRLG,
        })[usize::from(section)]
    }
}

pub(super) fn checksum(data: &[u8]) -> u16 {
    let sum = data.chunks_exact(4).fold(0u32, |sum, word| {
        sum.wrapping_add(u32::from_le_bytes(word.try_into().unwrap()))
    });
    (sum as u16).wrapping_add((sum >> 16) as u16)
}

fn section_offset(slot: u8, id: u8) -> usize {
    usize::from(slot) * SLOT_SIZE + ((usize::from(id) + 1) % 14) * SECTION_SIZE
}

fn logical_offset(slot: u8, offset: usize) -> usize {
    section_offset(slot, (1 + offset / SECTION_DATA_SIZE) as u8) + offset % SECTION_DATA_SIZE
}

fn fixture(family: Family, left: u32, right: u32) -> Vec<u8> {
    let mut bytes = vec![0; SAVE_SIZE];
    for (slot, counter) in [(0, left), (1, right)] {
        for id in 0..14 {
            let offset = section_offset(slot, id);
            bytes[offset + 0xff4..offset + 0xff6].copy_from_slice(&(id as u16).to_le_bytes());
            bytes[offset + 0xff8..offset + 0xffc].copy_from_slice(&SIGNATURE.to_le_bytes());
            bytes[offset + 0xffc..offset + 0x1000].copy_from_slice(&counter.to_le_bytes());
        }
        let small = section_offset(slot, 0);
        bytes[small..small + 7].copy_from_slice(&[0xcc, 0xbf, 0xbe, 0xff, 0xff, 0xff, 0xff]);
        bytes[small + 10..small + 14].copy_from_slice(&[0x39, 0x30, 0x31, 0xd4]);
        bytes[small + 14..small + 19].copy_from_slice(&[32, 0, 14, 22, 3]);
        let key = match family {
            Family::Rs => 0,
            Family::Emerald => {
                bytes[small + 0xac..small + 0xb0].copy_from_slice(&0x1234_5678u32.to_le_bytes());
                0x1234_5678
            }
            Family::Frlg => {
                bytes[small + 0xf20..small + 0xf24].copy_from_slice(&0x8765_4321u32.to_le_bytes());
                0x8765_4321
            }
        };
        let money = if family == Family::Frlg { 0x290 } else { 0x490 };
        let offset = logical_offset(slot, money);
        bytes[offset..offset + 4].copy_from_slice(&(5_000u32 ^ key).to_le_bytes());
        bytes[offset + 4..offset + 6].copy_from_slice(&(100u16 ^ key as u16).to_le_bytes());
    }
    repair(&mut bytes, family);
    bytes
}

fn repair(bytes: &mut [u8], family: Family) {
    for slot in 0..2 {
        for id in 0..14 {
            let offset = section_offset(slot, id);
            let value = checksum(&bytes[offset..offset + family.checksum_size(id)]);
            bytes[offset + 0xff6..offset + 0xff8].copy_from_slice(&value.to_le_bytes());
        }
    }
}

fn handler(id: &str) -> SchemaSaveHandler {
    catalog::builtin_pokemon_gen3::schemas()
        .into_iter()
        .find(|handler| handler.definitions()[0].identity.id == id)
        .unwrap()
}

fn input(bytes: Vec<u8>, id: &str) -> SaveDetectionInput {
    SaveDetectionInput {
        bytes,
        selected_game: Some(id.into()),
        rom_sha1: None,
    }
}

fn value(document: &super::SaveDocument, id: &str) -> SaveValue {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .unwrap()
        .value
        .clone()
}

#[test]
fn parses_each_family_and_selects_rollover_counters() {
    for family in [Family::Rs, Family::Emerald, Family::Frlg] {
        let handler = handler(family.id());
        let identity = handler.definitions().remove(0).identity;
        let document = handler
            .parse(&input(fixture(family, u32::MAX, 0), family.id()), &identity)
            .unwrap();
        assert_eq!(document.active_slot, 1);
        assert_eq!(value(&document, "trainer.money"), SaveValue::U32(5_000));
        assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
    }
}

#[test]
fn edits_fields_without_changing_the_backup_or_unrelated_bytes() {
    for family in [Family::Rs, Family::Emerald, Family::Frlg] {
        let handler = handler(family.id());
        let identity = handler.definitions().remove(0).identity;
        let source = input(fixture(family, 7, 8), family.id());
        let before = source.bytes.clone();
        let result = handler
            .apply(
                &source,
                &identity,
                &[
                    SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(999_999),
                    },
                    SaveEdit {
                        field: "trainer.name".into(),
                        value: SaveValue::Text("A♀".into()),
                    },
                    SaveEdit {
                        field: "inventory.items_1.item_id".into(),
                        value: SaveValue::U32(1),
                    },
                    SaveEdit {
                        field: "inventory.items_1.quantity".into(),
                        value: SaveValue::U32(99),
                    },
                ],
                false,
            )
            .unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(&output[..SLOT_SIZE], &before[..SLOT_SIZE]);
        assert_eq!(&output[2 * SLOT_SIZE..], &before[2 * SLOT_SIZE..]);
        assert_eq!(
            value(&result.document, "trainer.money"),
            SaveValue::U32(999_999)
        );
        assert_eq!(
            value(&result.document, "trainer.name"),
            SaveValue::Text("A♀".into())
        );
        for section in result.document.sections {
            assert_eq!(section.checksum_actual, section.checksum_expected);
        }
    }
}

#[test]
fn corruption_blocks_edits_and_field_ranges_are_enforced() {
    let family = Family::Emerald;
    let handler = handler(family.id());
    let identity = handler.definitions().remove(0).identity;
    let mut bytes = fixture(family, 7, 8);
    bytes[section_offset(1, 1)] ^= 1;
    let damaged = input(bytes, family.id());
    let document = handler.parse(&damaged, &identity).unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::PartiallyRecoverable
    );
    assert!(
        handler
            .apply(
                &damaged,
                &identity,
                &[SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(1)
                }],
                false
            )
            .is_err()
    );

    let valid = input(fixture(family, 7, 8), family.id());
    for (field, value) in [
        ("trainer.money", 1_000_000),
        ("trainer.coins", 10_000),
        ("inventory.items_1.item_id", 65_535),
    ] {
        assert!(
            handler
                .apply(
                    &valid,
                    &identity,
                    &[SaveEdit {
                        field: field.into(),
                        value: SaveValue::U32(value)
                    }],
                    false
                )
                .is_err()
        );
    }
}
