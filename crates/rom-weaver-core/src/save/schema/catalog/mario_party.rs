use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_mario_party_canonical_eeprom()];

    build(games, codecs, true)
}

fn game_mario_party_canonical_eeprom() -> GameDefinition {
    let fields = vec![
        catalog_field("coins", "Coins", 72, Storage::U32Be),
        catalog_field("stars", "Stars", 76, Storage::U16Be),
        catalog_field(
            "title_background",
            "Title screen background",
            78,
            Storage::U8,
        ),
        catalog_field("coin_box", "Coin box", 79, Storage::U8),
        catalog_field("events.rules_heard", "Game rules heard", 80, Storage::Bit).bit(1),
        catalog_field(
            "events.toad_first_talk",
            "Toad first talk",
            80,
            Storage::Bit,
        )
        .bit(2),
        catalog_field("events.bowser_note", "Bowser note read", 80, Storage::Bit).bit(3),
        catalog_field(
            "unlocked.plus_block",
            "Plus Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "unlocked.minus_block",
            "Minus Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(2),
        catalog_field(
            "unlocked.speed_block",
            "Speed Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "unlocked.slow_block",
            "Slow Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(4),
        catalog_field(
            "unlocked.warp_block",
            "Warp Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "unlocked.event_block",
            "Event Block unlocked",
            83,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "unlocked.magma_mountain",
            "Magma Mountain unlocked",
            84,
            Storage::Bit,
        )
        .bit(7),
        catalog_field("unlocked.credits", "Credits unlocked", 85, Storage::Bit).bit(0),
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
