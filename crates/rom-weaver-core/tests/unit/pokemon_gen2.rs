use super::{
    SaveDetectionInput, SaveEdit, SaveIntegrityState, SaveRecognitionOutcome, SaveValue,
    schema::{SchemaSaveHandler, catalog},
};

#[derive(Clone, Copy)]
pub(super) enum Family {
    GoldSilver,
    Crystal,
}

#[derive(Clone, Copy)]
struct Span {
    offset: usize,
    len: usize,
}

#[derive(Clone, Copy)]
struct Layout {
    player_one: Span,
    player_three: Span,
    checksum_data: &'static [Span],
    checksum_offset: usize,
    check_one: usize,
    check_two: usize,
}

const GS_MAIN_DATA: [Span; 1] = [Span {
    offset: 0x2009,
    len: 0xd60,
}];
const GS_BACKUP_DATA: [Span; 5] = [
    Span {
        offset: 0x10e8,
        len: 0x4df,
    },
    Span {
        offset: 0x0c6b,
        len: 0x47d,
    },
    Span {
        offset: 0x15c7,
        len: 0x226,
    },
    Span {
        offset: 0x3d96,
        len: 0x1aa,
    },
    Span {
        offset: 0x7e39,
        len: 0x34,
    },
];
const CRYSTAL_MAIN_DATA: [Span; 1] = [Span {
    offset: 0x2009,
    len: 0xb7a,
}];
const CRYSTAL_BACKUP_DATA: [Span; 1] = [Span {
    offset: 0x1209,
    len: 0xb7a,
}];
const GS: [Layout; 2] = [
    Layout {
        player_one: Span {
            offset: 0x2009,
            len: 0x226,
        },
        player_three: Span {
            offset: 0x23d9,
            len: 0x47d,
        },
        checksum_data: &GS_MAIN_DATA,
        checksum_offset: 0x2d69,
        check_one: 0x2008,
        check_two: 0x2d6b,
    },
    Layout {
        player_one: Span {
            offset: 0x15c7,
            len: 0x226,
        },
        player_three: Span {
            offset: 0x0c6b,
            len: 0x47d,
        },
        checksum_data: &GS_BACKUP_DATA,
        checksum_offset: 0x7e6d,
        check_one: 0x7e38,
        check_two: 0x7e6f,
    },
];
const CRYSTAL: [Layout; 2] = [
    Layout {
        player_one: Span {
            offset: 0x2009,
            len: 0x3cf,
        },
        player_three: Span {
            offset: 0x2009,
            len: 0xb7a,
        },
        checksum_data: &CRYSTAL_MAIN_DATA,
        checksum_offset: 0x2d0d,
        check_one: 0x2008,
        check_two: 0x2d0f,
    },
    Layout {
        player_one: Span {
            offset: 0x1209,
            len: 0x3cf,
        },
        player_three: Span {
            offset: 0x1209,
            len: 0xb7a,
        },
        checksum_data: &CRYSTAL_BACKUP_DATA,
        checksum_offset: 0x1f0d,
        check_one: 0x1208,
        check_two: 0x1f0f,
    },
];

fn layouts(family: Family) -> &'static [Layout; 2] {
    match family {
        Family::GoldSilver => &GS,
        Family::Crystal => &CRYSTAL,
    }
}

fn slot_offset(family: Family, layout: Layout, offset: usize) -> usize {
    match family {
        Family::Crystal => layout.player_three.offset + offset - 0x2009,
        Family::GoldSilver if layout.player_one.offset == 0x2009 => offset,
        Family::GoldSilver => match offset {
            0x2009..=0x222e => 0x15c7 + offset - 0x2009,
            0x222f..=0x23d8 => 0x3d96 + offset - 0x222f,
            0x23d9..=0x2855 => 0x0c6b + offset - 0x23d9,
            0x2856..=0x2d34 => 0x10e8 + offset - 0x2856,
            0x2d35..=0x2d68 => 0x7e39 + offset - 0x2d35,
            _ => panic!("fixture offset is outside checksummed data"),
        },
    }
}

fn checksum(bytes: &[u8], spans: &[Span]) -> u16 {
    spans.iter().fold(0u16, |sum, span| {
        bytes[span.offset..span.offset + span.len]
            .iter()
            .fold(sum, |sum, byte| sum.wrapping_add(u16::from(*byte)))
    })
}

fn repair(bytes: &mut [u8], layout: Layout) {
    let checksum = checksum(bytes, layout.checksum_data);
    bytes[layout.checksum_offset..layout.checksum_offset + 2]
        .copy_from_slice(&checksum.to_le_bytes());
}

pub(super) fn fixture(family: Family) -> Vec<u8> {
    let mut bytes = vec![0; 32 * 1024];
    bytes[0x2000] = 3;
    bytes[0x1200] = 3;
    for layout in layouts(family) {
        bytes[layout.check_one] = 99;
        bytes[layout.check_two] = 127;
        bytes[layout.player_one.offset + 2..layout.player_one.offset + 9]
            .copy_from_slice(&[0x8f, 0x8b, 0x80, 0x98, 0x84, 0x91, 0x50]);
        let shift = usize::from(matches!(family, Family::Crystal));
        for base in [0x241f, 0x2449, 0x2464, 0x247e] {
            bytes[slot_offset(family, *layout, base + shift + 1)] = 0xff;
        }
        let items = slot_offset(family, *layout, 0x241f + shift);
        bytes[items..items + 4].copy_from_slice(&[1, 1, 2, 0xff]);
        repair(&mut bytes, *layout);
    }
    bytes
}

fn handler(id: &str) -> SchemaSaveHandler {
    catalog::builtin_pokemon_gen2::schemas()
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

#[test]
fn parses_and_recognizes_both_generation_two_layouts() {
    for (id, family) in [
        ("pokemon-gold", Family::GoldSilver),
        ("pokemon-silver", Family::GoldSilver),
        ("pokemon-crystal", Family::Crystal),
    ] {
        let handler = handler(id);
        let game = handler.definitions()[0].identity.clone();
        let source = input(fixture(family), id);
        let document = handler.parse(&source, &game).unwrap();
        assert_eq!(document.identity.id, id);
        assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
        assert!(matches!(
            handler.recognize(&source).outcome,
            SaveRecognitionOutcome::Recognized { ref candidate } if candidate.identity.id == id
        ));
    }
}

#[test]
fn edits_both_copies_and_repairs_each_checksum() {
    for (id, family) in [
        ("pokemon-gold", Family::GoldSilver),
        ("pokemon-crystal", Family::Crystal),
    ] {
        let handler = handler(id);
        let game = handler.definitions()[0].identity.clone();
        let source = input(fixture(family), id);
        let edits = [
            ("trainer.name", SaveValue::Text("A♀".into())),
            ("trainer.money", SaveValue::U32(123_456)),
            ("trainer.coins", SaveValue::U32(1234)),
            ("options.text_speed", SaveValue::Enum("slow".into())),
            ("inventory.tm_hm.1.quantity", SaveValue::U32(1)),
            ("inventory.tm_hm.57.quantity", SaveValue::U32(99)),
            ("inventory.items.1.item_id", SaveValue::U32(2)),
            ("inventory.items.1.quantity", SaveValue::U32(3)),
        ]
        .map(|(field, value)| SaveEdit {
            field: field.into(),
            value,
        });
        let result = handler.apply(&source, &game, &edits, false).unwrap();
        assert_eq!(result.preview.touched_sections, [0, 1]);
        let bytes = result.bytes.unwrap();
        for layout in layouts(family) {
            assert_eq!(
                u16::from_le_bytes([
                    bytes[layout.checksum_offset],
                    bytes[layout.checksum_offset + 1],
                ]),
                checksum(&bytes, layout.checksum_data)
            );
            let money = match family {
                Family::GoldSilver => layout.player_three.offset + 2,
                Family::Crystal => layout.player_three.offset + 0x3d3,
            };
            assert_eq!(&bytes[money..money + 3], &[0x01, 0xe2, 0x40]);
            let shift = usize::from(matches!(family, Family::Crystal));
            let items = slot_offset(family, *layout, 0x241f + shift);
            assert_eq!(bytes[items..items + 4], [1, 2, 3, 0xff]);
        }
    }
}

#[test]
fn exposes_partial_recovery_read_only_and_rejects_edits() {
    for (id, family) in [
        ("pokemon-gold", Family::GoldSilver),
        ("pokemon-crystal", Family::Crystal),
    ] {
        let handler = handler(id);
        let game = handler.definitions()[0].identity.clone();
        let mut bytes = fixture(family);
        bytes[layouts(family)[1].checksum_offset] ^= 1;
        let source = input(bytes, id);
        let document = handler.parse(&source, &game).unwrap();
        assert_eq!(
            document.integrity.state,
            SaveIntegrityState::PartiallyRecoverable
        );
        assert!(document.fields.iter().all(|field| !field.editable));
        assert!(
            handler
                .apply(
                    &source,
                    &game,
                    &[SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(1),
                    }],
                    false,
                )
                .is_err()
        );
    }
}

#[test]
fn rejects_invalid_values_and_two_corrupt_copies() {
    let handler = handler("pokemon-gold");
    let game = handler.definitions()[0].identity.clone();
    let source = input(fixture(Family::GoldSilver), &game.id);
    for (field, value) in [
        ("trainer.money", SaveValue::U32(1_000_000)),
        ("trainer.coins", SaveValue::U32(10_000)),
        ("inventory.tm_hm.1.quantity", SaveValue::U32(100)),
    ] {
        assert!(
            handler
                .apply(
                    &source,
                    &game,
                    &[SaveEdit {
                        field: field.into(),
                        value
                    }],
                    false,
                )
                .is_err()
        );
    }

    let mut bytes = fixture(Family::GoldSilver);
    for layout in GS {
        bytes[layout.checksum_offset] ^= 1;
    }
    assert!(handler.parse(&input(bytes, &game.id), &game).is_err());
}

#[test]
fn dry_run_names_options_clock_and_dex_keep_both_copies_consistent() {
    let handler = handler("pokemon-gold");
    let game = handler.definitions()[0].identity.clone();
    let source = input(fixture(Family::GoldSilver), &game.id);
    let dry_run = handler
        .apply(
            &source,
            &game,
            &[SaveEdit {
                field: "trainer.money".into(),
                value: SaveValue::U32(42),
            }],
            true,
        )
        .unwrap();
    assert!(dry_run.bytes.is_none());
    assert_eq!(source.bytes[0x23db..0x23de], [0, 0, 0]);

    let edits = [
        ("trainer.name", SaveValue::Text("Äzé→♂♀!".into())),
        ("trainer.id", SaveValue::U32(65_535)),
        ("trainer.coins", SaveValue::U32(9_999)),
        ("trainer.stored_money", SaveValue::U32(123)),
        ("trainer.play_time.hours", SaveValue::U32(999)),
        ("options.battle_scene", SaveValue::Bool(false)),
        ("progress.pokedex_owned_001", SaveValue::Bool(true)),
        ("progress.pokedex_owned_251", SaveValue::Bool(true)),
        ("progress.pokedex_seen_001", SaveValue::Bool(true)),
        ("progress.pokedex_seen_251", SaveValue::Bool(true)),
    ]
    .map(|(field, value)| SaveEdit {
        field: field.into(),
        value,
    });
    let bytes = handler
        .apply(&source, &game, &edits, false)
        .unwrap()
        .bytes
        .unwrap();
    assert_eq!(&bytes[0x2009..0x200b], &[0xff, 0xff]);
    assert_eq!(&bytes[0x15c7..0x15c9], &[0xff, 0xff]);
    assert_eq!(&bytes[0x23e2..0x23e4], &[0x27, 0x0f]);
    assert_eq!(&bytes[0x0c74..0x0c76], &[0x27, 0x0f]);
    assert_ne!(bytes[0x2000] & 0x80, 0);
    assert_ne!(bytes[0x1200] & 0x80, 0);
    for layout in GS {
        assert_eq!(
            u16::from_le_bytes([
                bytes[layout.checksum_offset],
                bytes[layout.checksum_offset + 1],
            ]),
            checksum(&bytes, layout.checksum_data)
        );
    }
}

#[test]
fn crystal_omits_secret_id_and_public_id_does_not_touch_old_false_offset() {
    let handler = handler("pokemon-crystal");
    let game = handler.definitions()[0].identity.clone();
    let source = input(fixture(Family::Crystal), &game.id);
    let document = handler.parse(&source, &game).unwrap();
    assert!(
        document
            .fields
            .iter()
            .all(|field| field.id != "trainer.secret_id")
    );
    let false_offsets = [0x23d8, 0x23d9, 0x15d8, 0x15d9];
    let before = false_offsets.map(|offset| source.bytes[offset]);
    let bytes = handler
        .apply(
            &source,
            &game,
            &[SaveEdit {
                field: "trainer.id".into(),
                value: SaveValue::U32(1),
            }],
            false,
        )
        .unwrap()
        .bytes
        .unwrap();
    assert_eq!(false_offsets.map(|offset| bytes[offset]), before);
}

#[test]
fn names_cover_supported_symbols_and_reject_invalid_text() {
    let handler = handler("pokemon-gold");
    let game = handler.definitions()[0].identity.clone();
    let source = input(fixture(Family::GoldSilver), &game.id);
    for name in ["Äzé→♂♀!", "()[]:; ", "{}-,./?"] {
        let result = handler
            .apply(
                &source,
                &game,
                &[SaveEdit {
                    field: "trainer.name".into(),
                    value: SaveValue::Text(name.into()),
                }],
                false,
            )
            .unwrap();
        assert_eq!(
            result
                .document
                .fields
                .iter()
                .find(|field| field.id == "trainer.name")
                .unwrap()
                .value,
            SaveValue::Text(name.into())
        );
    }
    for name in ["ABCDEFGHI", "ABC☃"] {
        assert!(
            handler
                .apply(
                    &source,
                    &game,
                    &[SaveEdit {
                        field: "trainer.name".into(),
                        value: SaveValue::Text(name.into()),
                    }],
                    false,
                )
                .is_err()
        );
    }
}
