use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_mario_party_canonical_eeprom()];

    build(games, codecs, true)
}

fn game_mario_party_canonical_eeprom() -> GameDefinition {
    let fields = vec![
        FieldDefinition::new("coins".into(), "Coins".into(), 72, Storage::U32Be),
        FieldDefinition::new("stars".into(), "Stars".into(), 76, Storage::U16Be),
        FieldDefinition::new(
            "title_background".into(),
            "Title screen background".into(),
            78,
            Storage::U8,
        ),
        FieldDefinition::new("coin_box".into(), "Coin box".into(), 79, Storage::U8),
        FieldDefinition::new(
            "events.rules_heard".into(),
            "Game rules heard".into(),
            80,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "events.toad_first_talk".into(),
            "Toad first talk".into(),
            80,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "events.bowser_note".into(),
            "Bowser note read".into(),
            80,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "unlocked.plus_block".into(),
            "Plus Block unlocked".into(),
            83,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "unlocked.minus_block".into(),
            "Minus Block unlocked".into(),
            83,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "unlocked.speed_block".into(),
            "Speed Block unlocked".into(),
            83,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "unlocked.slow_block".into(),
            "Slow Block unlocked".into(),
            83,
            Storage::Bit,
        )
        .bit(4),
        FieldDefinition::new(
            "unlocked.warp_block".into(),
            "Warp Block unlocked".into(),
            83,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "unlocked.event_block".into(),
            "Event Block unlocked".into(),
            83,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "unlocked.magma_mountain".into(),
            "Magma Mountain unlocked".into(),
            84,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "unlocked.credits".into(),
            "Credits unlocked".into(),
            85,
            Storage::Bit,
        )
        .bit(0),
    ];
    GameDefinition {
        fields,
        description: concat!(
            "Edits global progression in a canonical 2 KiB EEPROM. Board ",
            "records, minigame records, and byte-swapped emulator images are ",
            "omitted."
        )
        .into(),
        signatures: vec![SignatureDefinition {
            offset: 0,
            bytes: vec![72, 85, 68, 83, 79, 78],
        }],
        checksums: vec![ChecksumDefinition {
            start: Some(8),
            length: Some(498),
            unit: ChecksumUnit::U8,
            exclude: vec![ChecksumExclusion {
                offset: 504,
                length: 2,
            }],
            ..ChecksumDefinition::new(ChecksumAlgorithm::Add16Be, 504)
        }],
        ..GameDefinition::new(
            "mario-party-canonical-eeprom".into(),
            "Mario Party (canonical EEPROM)".into(),
            "n64".into(),
            2048,
        )
    }
}
