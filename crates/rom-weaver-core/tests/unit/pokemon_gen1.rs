use super::{
    SaveDetectionInput, SaveEdit, SaveIntegrityState, SaveRecognitionOutcome, SaveValue,
    schema::{SchemaSaveHandler, catalog},
};

const SIZE: usize = 32 * 1024;
const TRAINER_NAME: usize = 0x2598;
const BAG_COUNT: usize = 0x25c9;
const MONEY: usize = 0x25f3;
const RIVAL_NAME: usize = 0x25f6;
const OPTIONS: usize = 0x2601;
const TRAINER_ID: usize = 0x2605;
const CURRENT_BOX: usize = 0x284c;
const COINS: usize = 0x2850;
const CHECKSUM: usize = 0x3523;

pub(super) fn fixture(yellow: bool) -> Vec<u8> {
    let mut bytes = vec![0; SIZE];
    bytes[TRAINER_NAME..TRAINER_NAME + 7]
        .copy_from_slice(&[0x8f, 0x8b, 0x80, 0x98, 0x84, 0x91, 0x50]);
    bytes[RIVAL_NAME..RIVAL_NAME + 6].copy_from_slice(&[0x91, 0x88, 0x95, 0x80, 0x8b, 0x50]);
    bytes[BAG_COUNT..BAG_COUNT + 4].copy_from_slice(&[1, 1, 2, 0xff]);
    bytes[0x27e7] = 0xff;
    bytes[OPTIONS] = 3;
    if yellow {
        bytes[0x29c3] = 0x54;
    }
    repair_checksum(&mut bytes);
    bytes
}

fn repair_checksum(bytes: &mut [u8]) {
    let sum = bytes[TRAINER_NAME..CHECKSUM]
        .iter()
        .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
    bytes[CHECKSUM] = !sum;
}

fn handler(id: &str) -> SchemaSaveHandler {
    catalog::builtin_pokemon_gen1::schemas()
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
fn parses_and_recognizes_each_generation_one_game() {
    for (id, yellow) in [
        ("pokemon-red", false),
        ("pokemon-blue", false),
        ("pokemon-yellow", true),
    ] {
        let handler = handler(id);
        let game = handler.definitions()[0].identity.clone();
        let source = input(fixture(yellow), id);
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
fn edits_names_numbers_options_inventory_and_repairs_checksum() {
    let handler = handler("pokemon-red");
    let game = handler.definitions()[0].identity.clone();
    let source = input(fixture(false), &game.id);
    let edits = [
        ("trainer.name", SaveValue::Text("A♀".into())),
        ("trainer.rival_name", SaveValue::Text("{}".into())),
        ("trainer.id", SaveValue::U32(0xabcd)),
        ("trainer.money", SaveValue::U32(123_456)),
        ("trainer.coins", SaveValue::U32(1234)),
        ("options.text_speed", SaveValue::Enum("slow".into())),
        ("options.battle_scene", SaveValue::Bool(false)),
        ("options.battle_style", SaveValue::Bool(false)),
        ("inventory.bag.1.item_id", SaveValue::U32(2)),
        ("inventory.bag.1.quantity", SaveValue::U32(3)),
    ]
    .map(|(field, value)| SaveEdit {
        field: field.into(),
        value,
    });
    let result = handler.apply(&source, &game, &edits, false).unwrap();
    let bytes = result.bytes.unwrap();
    assert_eq!(&bytes[TRAINER_NAME..TRAINER_NAME + 3], &[0x80, 0xf5, 0x50]);
    assert_eq!(&bytes[RIVAL_NAME..RIVAL_NAME + 3], &[0xe1, 0xe2, 0x50]);
    assert_eq!(&bytes[TRAINER_ID..TRAINER_ID + 2], &[0xab, 0xcd]);
    assert_eq!(&bytes[MONEY..MONEY + 3], &[0x12, 0x34, 0x56]);
    assert_eq!(&bytes[COINS..COINS + 2], &[0x12, 0x34]);
    assert_eq!(bytes[BAG_COUNT..BAG_COUNT + 4], [1, 2, 3, 0xff]);
    assert_eq!(bytes[CHECKSUM], {
        let sum = bytes[TRAINER_NAME..CHECKSUM]
            .iter()
            .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
        !sum
    });
}

#[test]
fn rejects_invalid_text_values_and_corrupt_saves() {
    let handler = handler("pokemon-red");
    let game = handler.definitions()[0].identity.clone();
    let source = input(fixture(false), &game.id);
    for name in ["ABCDEFGH", "ABC☃"] {
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

    let mut bytes = fixture(false);
    bytes[TRAINER_NAME] ^= 1;
    let corrupt = input(bytes, &game.id);
    assert!(handler.parse(&corrupt, &game).is_err());
    assert!(matches!(
        handler.recognize(&corrupt).outcome,
        SaveRecognitionOutcome::Unsupported { .. }
    ));
}

#[test]
fn names_round_trip_the_supported_keyboard() {
    let handler = handler("pokemon-red");
    let game = handler.definitions()[0].identity.clone();
    let source = input(fixture(false), &game.id);
    for name in ["Azé0♂♀!", "()[]:; ", "{}-,./?"] {
        let result = handler
            .apply(
                &source,
                &game,
                &[
                    SaveEdit {
                        field: "trainer.name".into(),
                        value: SaveValue::Text(name.into()),
                    },
                    SaveEdit {
                        field: "trainer.rival_name".into(),
                        value: SaveValue::Text(name.into()),
                    },
                ],
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
}

#[test]
fn yellow_fields_require_the_verified_starter_marker() {
    let yellow_handler = handler("pokemon-yellow");
    let game = yellow_handler.definitions()[0].identity.clone();
    let source = input(fixture(true), &game.id);
    let result = yellow_handler
        .apply(
            &source,
            &game,
            &[
                SaveEdit {
                    field: "yellow.pikachu_beach_score".into(),
                    value: SaveValue::U32(9876),
                },
                SaveEdit {
                    field: "options.sound".into(),
                    value: SaveValue::Enum("earphone_3".into()),
                },
            ],
            false,
        )
        .unwrap();
    let bytes = result.bytes.unwrap();
    assert_eq!(&bytes[0x2741..0x2743], &[0x76, 0x98]);
    assert_eq!(bytes[OPTIONS], 0x33);

    let red = handler("pokemon-red");
    let red_game = red.definitions()[0].identity.clone();
    assert!(red.parse(&source, &red_game).is_err());
}

#[test]
fn rejects_invalid_bcd_counts_clock_values_and_box_switches() {
    let handler = handler("pokemon-red");
    let game = handler.definitions()[0].identity.clone();
    for mut bytes in {
        let mut bad_bcd = fixture(false);
        bad_bcd[MONEY] = 0xfa;
        repair_checksum(&mut bad_bcd);
        let mut bad_count = fixture(false);
        bad_count[BAG_COUNT] = 21;
        repair_checksum(&mut bad_count);
        [bad_bcd, bad_count]
    } {
        repair_checksum(&mut bytes);
        assert!(handler.parse(&input(bytes, &game.id), &game).is_err());
    }

    let source = input(fixture(false), &game.id);
    for (field, value) in [
        ("storage.current_box", 3),
        ("trainer.play_time.minutes", 60),
        ("trainer.play_time.seconds", 60),
        ("trainer.play_time.frames", 60),
    ] {
        assert!(
            handler
                .apply(
                    &source,
                    &game,
                    &[SaveEdit {
                        field: field.into(),
                        value: SaveValue::U32(value),
                    }],
                    false,
                )
                .is_err()
        );
    }
    assert_eq!(source.bytes[CURRENT_BOX], 0);
}
