use super::*;

pub(in crate::save) fn schemas() -> Vec<SchemaSaveHandler> {
    let codecs = BTreeMap::from([]);

    let games = vec![game_mario_party_2_canonical_eeprom()];

    build(games, codecs, true)
}

fn game_mario_party_2_canonical_eeprom() -> GameDefinition {
    let fields = vec![
        catalog_field("coins", "Coins", 120, Storage::U32Be),
        catalog_field("bowser_land", "Bowser Land unlocked", 128, Storage::Bit).bit(1),
        catalog_field(
            "credits_machine",
            "Credits Machine unlocked",
            129,
            Storage::Bit,
        )
        .bit(3),
        catalog_field(
            "boards.western_land",
            "Western Land played",
            128,
            Storage::Bit,
        )
        .bit(5),
        catalog_field(
            "boards.pirate_land",
            "Pirate Land played",
            128,
            Storage::Bit,
        )
        .bit(6),
        catalog_field(
            "boards.horror_land",
            "Horror Land played",
            128,
            Storage::Bit,
        )
        .bit(7),
        catalog_field("boards.space_land", "Space Land played", 129, Storage::Bit).bit(0),
        catalog_field(
            "boards.mystery_land",
            "Mystery Land played",
            129,
            Storage::Bit,
        )
        .bit(1),
        catalog_field(
            "boards.bowser_land",
            "Bowser Land played",
            129,
            Storage::Bit,
        )
        .bit(2),
        catalog_field("drivers_ed.played", "Driver's Ed played", 43, Storage::Bit).bit(0),
        catalog_field(
            "drivers_ed.unlocked",
            "Driver's Ed unlocked",
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
