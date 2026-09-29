use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_mario_party_2_canonical_eeprom()];

    build(games, codecs, true)
}

fn game_mario_party_2_canonical_eeprom() -> GameDefinition {
    let fields = vec![
        FieldDefinition::new("coins".into(), "Coins".into(), 120, Storage::U32Be),
        FieldDefinition::new(
            "bowser_land".into(),
            "Bowser Land unlocked".into(),
            128,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "credits_machine".into(),
            "Credits Machine unlocked".into(),
            129,
            Storage::Bit,
        )
        .bit(3),
        FieldDefinition::new(
            "boards.western_land".into(),
            "Western Land played".into(),
            128,
            Storage::Bit,
        )
        .bit(5),
        FieldDefinition::new(
            "boards.pirate_land".into(),
            "Pirate Land played".into(),
            128,
            Storage::Bit,
        )
        .bit(6),
        FieldDefinition::new(
            "boards.horror_land".into(),
            "Horror Land played".into(),
            128,
            Storage::Bit,
        )
        .bit(7),
        FieldDefinition::new(
            "boards.space_land".into(),
            "Space Land played".into(),
            129,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "boards.mystery_land".into(),
            "Mystery Land played".into(),
            129,
            Storage::Bit,
        )
        .bit(1),
        FieldDefinition::new(
            "boards.bowser_land".into(),
            "Bowser Land played".into(),
            129,
            Storage::Bit,
        )
        .bit(2),
        FieldDefinition::new(
            "drivers_ed.played".into(),
            "Driver's Ed played".into(),
            43,
            Storage::Bit,
        )
        .bit(0),
        FieldDefinition::new(
            "drivers_ed.unlocked".into(),
            "Driver's Ed unlocked".into(),
            52,
            Storage::Bit,
        )
        .bit(0),
    ];
    GameDefinition {
        fields,
        description: concat!(
            "Edits global progression and board play counts in a canonical 2 ",
            "KiB EEPROM. Minigame records, Mini-Game Coaster state, and ",
            "byte-swapped emulator images are omitted."
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
            "mario-party-2-canonical-eeprom".into(),
            "Mario Party 2 (canonical EEPROM)".into(),
            "n64".into(),
            2048,
        )
    }
}
