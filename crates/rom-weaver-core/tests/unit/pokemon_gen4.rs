use super::schema::{SchemaSaveHandler, catalog};
use super::{SaveDetectionInput, SaveEdit, SaveIntegrityState, SaveValue};

const SAVE_SIZE: usize = 0x80000;
const COPY_SIZE: usize = 0x40000;
const FOOTER_SIZE: usize = 16;
const FOOTER_MAGIC: u32 = 0x2006_0623;

#[derive(Clone, Copy)]
enum Title {
    Diamond,
    Pearl,
    Platinum,
    HeartGold,
    SoulSilver,
}

impl Title {
    const ALL: [Self; 5] = [
        Self::Diamond,
        Self::Pearl,
        Self::Platinum,
        Self::HeartGold,
        Self::SoulSilver,
    ];
    fn id(self) -> &'static str {
        match self {
            Self::Diamond => "pokemon-diamond",
            Self::Pearl => "pokemon-pearl",
            Self::Platinum => "pokemon-platinum",
            Self::HeartGold => "pokemon-heartgold",
            Self::SoulSilver => "pokemon-soulsilver",
        }
    }
    fn version(self) -> u8 {
        match self {
            Self::HeartGold => 7,
            Self::SoulSilver => 8,
            _ => 0,
        }
    }
    fn layout(self) -> (usize, usize, usize, usize, usize) {
        match self {
            Self::Diamond | Self::Pearl => (0xc100, 0xc100, 0x121e0, 0x64, 0x65f8),
            Self::Platinum => (0xcf2c, 0xcf2c, 0x121e4, 0x68, 0x7234),
            Self::HeartGold | Self::SoulSilver => (0xf628, 0xf700, 0x12310, 0x64, 0x5bb8),
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

fn write_footer(copy: &mut [u8], end: usize, start: usize, count: u32, index: u16) {
    let footer = end - FOOTER_SIZE;
    copy[footer..footer + 4].copy_from_slice(&count.to_le_bytes());
    copy[footer + 4..footer + 8]
        .copy_from_slice(&u32::try_from(end - start).unwrap().to_le_bytes());
    copy[footer + 8..footer + 12].copy_from_slice(&FOOTER_MAGIC.to_le_bytes());
    copy[footer + 12..footer + 14].copy_from_slice(&index.to_le_bytes());
    let crc = crc16(&copy[start..footer]);
    copy[footer + 14..footer + 16].copy_from_slice(&crc.to_le_bytes());
}

fn fixture(title: Title, left: u32, right: u32) -> Vec<u8> {
    let (main, pc, pc_size, trainer, bp) = title.layout();
    let mut bytes = vec![0xff; SAVE_SIZE];
    for (slot, count, money) in [(0, left, 100u32), (1, right, 200)] {
        let copy = &mut bytes[slot * COPY_SIZE..(slot + 1) * COPY_SIZE];
        copy[..pc + pc_size].fill(0);
        copy[trainer + 0x10..trainer + 0x14].copy_from_slice(&0x1234_5678u32.to_le_bytes());
        copy[trainer + 0x14..trainer + 0x18].copy_from_slice(&money.to_le_bytes());
        copy[trainer + 0x1a] = 5;
        copy[trainer + 0x1c] = title.version();
        copy[trainer + 0x20..trainer + 0x22].copy_from_slice(&77u16.to_le_bytes());
        copy[trainer + 0x22..trainer + 0x24].copy_from_slice(&12u16.to_le_bytes());
        copy[trainer + 0x24] = 34;
        copy[trainer + 0x25] = 56;
        copy[bp..bp + 2].copy_from_slice(&88u16.to_le_bytes());
        write_footer(copy, main, 0, count, 0);
        write_footer(copy, pc + pc_size, pc, count, 1);
    }
    bytes
}

fn handler(title: Title) -> SchemaSaveHandler {
    catalog::builtin_pokemon_gen4::schemas()
        .into_iter()
        .find(|h| h.definitions()[0].identity.id == title.id())
        .unwrap()
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
fn parses_all_layouts_and_selects_counters_with_rollover() {
    for title in Title::ALL {
        let handler = handler(title);
        let identity = handler.definitions().remove(0).identity;
        let document = handler
            .parse(&input(title, fixture(title, u32::MAX, 0)), &identity)
            .unwrap();
        assert_eq!(document.active_slot, 1);
        assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
        assert_eq!(value(&document, "trainer.id"), SaveValue::U32(0x5678));
        assert_eq!(
            value(&document, "trainer.secret_id"),
            SaveValue::U32(0x1234)
        );
    }
}

#[test]
fn edits_only_the_selected_copy_and_repairs_its_crc() {
    for title in Title::ALL {
        let handler = handler(title);
        let identity = handler.definitions().remove(0).identity;
        let source = input(title, fixture(title, 10, 11));
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
                        field: "trainer.coins".into(),
                        value: SaveValue::U32(50_000),
                    },
                    SaveEdit {
                        field: "progress.battle_points".into(),
                        value: SaveValue::U32(9_999),
                    },
                ],
                false,
            )
            .unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(&output[..COPY_SIZE], &before[..COPY_SIZE]);
        assert_eq!(
            value(&result.document, "trainer.money"),
            SaveValue::U32(999_999)
        );
        let (main, _, _, _, _) = title.layout();
        let footer = COPY_SIZE + main - FOOTER_SIZE;
        assert_eq!(
            crc16(&output[COPY_SIZE..footer]),
            u16::from_le_bytes(output[footer + 14..footer + 16].try_into().unwrap())
        );
    }
}

#[test]
fn corruption_and_field_ranges_are_rejected() {
    let title = Title::HeartGold;
    let handler = handler(title);
    let identity = handler.definitions().remove(0).identity;
    let mut bytes = fixture(title, 10, 11);
    let (main, _, _, _, _) = title.layout();
    bytes[main - 2] ^= 1;
    bytes[COPY_SIZE + main - 2] ^= 1;
    assert!(handler.parse(&input(title, bytes), &identity).is_err());
    let source = input(title, fixture(title, 10, 11));
    for (field, number) in [
        ("trainer.id", 65_536),
        ("trainer.money", 1_000_000),
        ("trainer.coins", 50_001),
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
    assert!(!handler.supports_generation(&identity));
}

#[test]
fn ties_choose_the_first_copy_and_damaged_backups_are_read_only() {
    let title = Title::HeartGold;
    let handler = handler(title);
    let identity = handler.definitions().remove(0).identity;
    let tied = handler
        .parse(&input(title, fixture(title, 10, 10)), &identity)
        .unwrap();
    assert_eq!(tied.active_slot, 0);
    let mut bytes = fixture(title, 10, 11);
    let (main, _, _, _, _) = title.layout();
    bytes[COPY_SIZE + main - 2] ^= 1;
    let damaged = input(title, bytes);
    let document = handler.parse(&damaged, &identity).unwrap();
    assert_eq!(
        document.integrity.state,
        SaveIntegrityState::PartiallyRecoverable
    );
    assert!(
        !document
            .fields
            .iter()
            .find(|field| field.id == "trainer.money")
            .unwrap()
            .editable
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
}

#[test]
fn version_checks_dry_runs_and_crc_vector_match_the_format() {
    assert_eq!(crc16(b"123456789"), 0x29b1);
    let title = Title::SoulSilver;
    let handler = handler(title);
    let identity = handler.definitions().remove(0).identity;
    assert!(
        handler
            .parse(&input(title, fixture(Title::HeartGold, 10, 11)), &identity)
            .is_err()
    );
    let source = input(title, fixture(title, 10, 11));
    let result = handler
        .apply(
            &source,
            &identity,
            &[SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(42),
            }],
            true,
        )
        .unwrap();
    assert!(result.bytes.is_none());
    assert_eq!(value(&result.document, "trainer.money"), SaveValue::U32(42));
    assert_eq!(
        value(&result.document, "trainer.play_time"),
        SaveValue::Text("12:34:56".into())
    );
}

pub(super) fn fixture_for_id(id: &str) -> Vec<u8> {
    let title = Title::ALL
        .into_iter()
        .find(|title| title.id() == id)
        .unwrap();
    fixture(title, 3, 4)
}
