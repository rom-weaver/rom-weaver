use tracing::{debug, trace};

use super::formats::GAME_BOY_SRAM_32K;
use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityState, SaveRecognition, SaveRecognitionConfidence,
    SaveRecognitionOutcome, SaveRecognitionReason, SaveSection, SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

pub const GEN1_SAVE_SIZE: usize = GAME_BOY_SRAM_32K.supported_sizes[0];

const TRAINER_NAME: usize = 0x2598;
const DEX_OWNED: usize = 0x25A3;
const DEX_SEEN: usize = 0x25B6;
const BAG_COUNT: usize = 0x25C9;
const MONEY: usize = 0x25F3;
const RIVAL_NAME: usize = 0x25F6;
const OPTIONS: usize = 0x2601;
const BADGES: usize = 0x2602;
const TRAINER_ID: usize = 0x2605;
const YELLOW_PIKACHU_FRIENDSHIP: usize = 0x271C;
const YELLOW_BEACH_SCORE: usize = 0x2741;
const YELLOW_PRINTER_BRIGHTNESS: usize = 0x2744;
const CURRENT_BOX: usize = 0x284C;
const COINS: usize = 0x2850;
const PLAY_TIME: usize = 0x2CED;
const CHECKSUM: usize = 0x3523;
const CHECKSUM_START: usize = TRAINER_NAME;
const CHECKSUM_END: usize = CHECKSUM;
const YELLOW_STARTER: usize = 0x29C3;
const YELLOW_STARTER_ID: u8 = 0x54;
const BAG_CAPACITY: u8 = 20;
const MAX_MONEY: u32 = 999_999;
const MAX_COINS: u32 = 9_999;

// English offsets are cross-checked against pret/pokered's linked SRAM layout
// and PKHeX's SAV1Offsets. Japanese and Virtual Console layouts stay outside
// this handler because their field positions differ.
// https://github.com/pret/pokered/tree/a1a22aaf84d1675bcdbaeb194592379d586d838e
// https://github.com/kwsch/PKHeX/blob/e0e63bc87837ad2d9c8f8fda4efdbf5f2933db08/PKHeX.Core/Saves/Substructures/Gen12/SAV1Offsets.cs

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Game {
    Red,
    Blue,
    Yellow,
}

pub struct PokemonGen1Handler;

impl SaveGameHandler for PokemonGen1Handler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        [
            definition("pokemon-red", "Pokémon Red"),
            definition("pokemon-blue", "Pokémon Blue"),
            definition("pokemon-yellow", "Pokémon Yellow"),
        ]
        .into()
    }

    fn supports_generation(&self, _game: &SaveGameIdentity) -> bool {
        true
    }

    fn generate(&self, game: &SaveGameIdentity) -> Result<Vec<u8>> {
        generate(game_for_identity(game)?)
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        if !GAME_BOY_SRAM_32K.accepts(&input.bytes) {
            return unsupported(SaveRecognitionReason::WrongSize);
        }
        if !valid_checksum(&input.bytes) || !valid_structure(&input.bytes) {
            return unsupported(SaveRecognitionReason::ChecksumMismatch);
        }
        let yellow = is_yellow(&input.bytes);
        let requested = input.selected_game.as_deref();
        let ids = if yellow {
            [Some("pokemon-yellow"), None, None]
        } else {
            [Some("pokemon-red"), Some("pokemon-blue"), None]
        };
        let candidates = ids
            .into_iter()
            .flatten()
            .filter(|id| requested.is_none() || requested == Some(*id))
            .map(|id| SaveGameCandidate {
                identity: identity(id),
                confidence: SaveRecognitionConfidence::High,
                reasons: vec![SaveRecognitionReason::ChecksumValid],
            })
            .collect::<Vec<_>>();
        let outcome = match candidates.as_slice() {
            [candidate] => SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            [] => SaveRecognitionOutcome::Unsupported {
                reasons: vec![SaveRecognitionReason::UnsupportedLayout],
            },
            _ => SaveRecognitionOutcome::Ambiguous {
                candidates: candidates.clone(),
            },
        };
        SaveRecognition {
            outcome,
            candidates,
            reasons: Vec::new(),
        }
    }

    fn parse(&self, input: &SaveDetectionInput, game: &SaveGameIdentity) -> Result<SaveDocument> {
        let game = game_for_identity(game)?;
        validate_layout(&input.bytes, game)?;
        build_document(&input.bytes, game, &identity(game.id()))
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        let game = game_for_identity(game)?;
        validate_layout(&input.bytes, game)?;
        let document = build_document(&input.bytes, game, &identity(game.id()))?;
        let preview = validate_save_edits(&document, edits)?;
        if !preview.changed {
            return Ok(SaveEditResult {
                preview,
                bytes: None,
                document,
            });
        }
        let mut bytes = input.bytes.clone();
        for edit in edits {
            apply_edit(&mut bytes, edit)?;
        }
        bytes[CHECKSUM] = checksum(&bytes);
        validate_layout(&bytes, game)?;
        let reparsed = build_document(&bytes, game, &identity(game.id()))?;
        for edit in edits {
            if field_value(&reparsed, &edit.field) != Some(&edit.value) {
                return Err(validation(
                    "save_edit_reparse_mismatch",
                    "the edited save did not produce the requested value",
                ));
            }
        }
        trace!(game = %game.id(), "validated edited Pokémon Gen I save");
        Ok(SaveEditResult {
            preview,
            bytes: (!dry_run).then_some(bytes),
            document: reparsed,
        })
    }
}

fn generate(game: Game) -> Result<Vec<u8>> {
    let mut bytes = vec![0; GEN1_SAVE_SIZE];

    // The generated image contains a minimal initialized English save block.
    // Empty variable-length lists MUST carry their terminator before a game reads them.
    bytes[TRAINER_NAME..TRAINER_NAME + 7]
        .copy_from_slice(&[0x8f, 0x8b, 0x80, 0x98, 0x84, 0x91, 0x50]);
    bytes[RIVAL_NAME..RIVAL_NAME + 6].copy_from_slice(&[0x91, 0x88, 0x95, 0x80, 0x8b, 0x50]);
    bytes[BAG_COUNT + 1] = 0xff;
    bytes[OPTIONS] = 3;
    if game == Game::Yellow {
        bytes[YELLOW_STARTER] = YELLOW_STARTER_ID;
    }
    bytes[CHECKSUM] = checksum(&bytes);

    validate_layout(&bytes, game)?;
    build_document(&bytes, game, &identity(game.id()))?;
    Ok(bytes)
}

fn definition(id: &str, name: &str) -> SaveGameDefinition {
    SaveGameDefinition {
        identity: SaveGameIdentity {
            id: id.into(),
            name: name.into(),
            family: "pokemon-gen1".into(),
        },
        platform: "game-boy".into(),
        save_format: GAME_BOY_SRAM_32K.id.into(),
        save_format_name: GAME_BOY_SRAM_32K.display_name.into(),
        handler_id: "pokemon-gen1".into(),
        supported_save_sizes: vec![GEN1_SAVE_SIZE as u32],
        known_rom_sha1: Vec::new(),
        checksum_sizes: Vec::new(),
    }
}

fn identity(id: &str) -> SaveGameIdentity {
    match id {
        "pokemon-red" => definition(id, "Pokémon Red").identity,
        "pokemon-blue" => definition(id, "Pokémon Blue").identity,
        "pokemon-yellow" => definition(id, "Pokémon Yellow").identity,
        _ => unreachable!("only defined Pokémon Gen I games reach this function"),
    }
}

fn game_for_identity(game: &SaveGameIdentity) -> Result<Game> {
    match game.id.as_str() {
        "pokemon-red" => Ok(Game::Red),
        "pokemon-blue" => Ok(Game::Blue),
        "pokemon-yellow" => Ok(Game::Yellow),
        _ => Err(validation(
            "save_game_unsupported",
            "the selected save game is unsupported",
        )),
    }
}

impl Game {
    fn id(self) -> &'static str {
        match self {
            Self::Red => "pokemon-red",
            Self::Blue => "pokemon-blue",
            Self::Yellow => "pokemon-yellow",
        }
    }
}

fn validate_layout(bytes: &[u8], game: Game) -> Result<()> {
    if !GAME_BOY_SRAM_32K.accepts(bytes) {
        return Err(validation(
            "save_wrong_size",
            "a Pokémon Gen I save must be exactly 32 KiB",
        ));
    }
    if !valid_checksum(bytes) {
        return Err(validation("save_checksum", "the save checksum is invalid"));
    }
    if !valid_structure(bytes) {
        return Err(validation(
            "save_layout",
            "the save does not contain valid English inventory layout markers",
        ));
    }
    if bytes[PLAY_TIME + 2..PLAY_TIME + 5]
        .iter()
        .any(|value| *value >= 60)
        || (bytes[PLAY_TIME] == 255
            && bytes[PLAY_TIME + 2..PLAY_TIME + 5]
                .iter()
                .any(|value| *value != 0))
    {
        return Err(validation(
            "save_play_time",
            "play time must use values below 60 and stop at 255:00:00",
        ));
    }
    if game == Game::Yellow && !is_yellow(bytes) {
        return Err(validation(
            "save_game_mismatch",
            "the save does not contain the Pokémon Yellow starter marker",
        ));
    }
    if game != Game::Yellow && is_yellow(bytes) {
        return Err(validation(
            "save_game_mismatch",
            "the save contains the Pokémon Yellow starter marker",
        ));
    }
    Ok(())
}

fn valid_checksum(bytes: &[u8]) -> bool {
    bytes.get(CHECKSUM) == Some(&checksum(bytes))
}

fn is_yellow(bytes: &[u8]) -> bool {
    let starter = bytes[YELLOW_STARTER];
    starter == YELLOW_STARTER_ID || (starter == 0 && bytes[YELLOW_PIKACHU_FRIENDSHIP] > 0)
}

fn valid_structure(bytes: &[u8]) -> bool {
    let bag_count = usize::from(bytes[BAG_COUNT]);
    bag_count <= usize::from(BAG_CAPACITY)
        && bytes[BAG_COUNT + 1 + bag_count * 2] == 0xff
        && bytes[CURRENT_BOX] & 0x7f < 12
        && read_bcd(bytes, MONEY, 3).is_ok_and(|value| value <= MAX_MONEY)
        && read_bcd(bytes, COINS, 2).is_ok_and(|value| value <= MAX_COINS)
}

fn checksum(bytes: &[u8]) -> u8 {
    let sum = bytes[CHECKSUM_START..CHECKSUM_END]
        .iter()
        .fold(0u8, |sum, byte| sum.wrapping_add(*byte));
    !sum
}

fn build_document(bytes: &[u8], game: Game, identity: &SaveGameIdentity) -> Result<SaveDocument> {
    let money = read_bcd(bytes, MONEY, 3)?;
    if money > MAX_MONEY {
        return Err(validation(
            "save_money",
            "the save has a money value above the game limit",
        ));
    }
    let coins = read_bcd(bytes, COINS, 2)?;
    if coins > MAX_COINS {
        return Err(validation(
            "save_coins",
            "the save has a coin value above the game limit",
        ));
    }
    let mut fields = vec![read_only_text(
        "trainer.name",
        "Trainer name",
        TRAINER_NAME,
        decode_name(&bytes[TRAINER_NAME..TRAINER_NAME + 11]),
        "Trainer text. This layout does not edit names.",
    )];
    fields.push(read_only_text(
        "trainer.rival_name",
        "Rival name",
        RIVAL_NAME,
        decode_name(&bytes[RIVAL_NAME..RIVAL_NAME + 11]),
        "Rival text. This layout does not edit names.",
    ));
    fields.push(integer_field(
        "trainer.id",
        "Trainer ID",
        TRAINER_ID,
        u32::from(u16::from_be_bytes([
            bytes[TRAINER_ID],
            bytes[TRAINER_ID + 1],
        ])),
        true,
        (0, 65_535),
        "Public trainer identifier",
    ));
    fields.push(integer_field(
        "trainer.money",
        "Money",
        MONEY,
        money,
        true,
        (0, i64::from(MAX_MONEY)),
        "Money carried by the player",
    ));
    fields.last_mut().unwrap().encoding = Some("pokemon_gen1_bcd_be_u24".into());
    fields.push(integer_field(
        "trainer.coins",
        "Coins",
        COINS,
        coins,
        true,
        (0, i64::from(MAX_COINS)),
        "Coins carried by the player",
    ));
    fields.last_mut().unwrap().encoding = Some("pokemon_gen1_bcd_be_u16".into());
    add_play_time_fields(&mut fields, bytes);
    add_option_fields(&mut fields, bytes, game);
    add_progress_fields(&mut fields, bytes);
    fields.push(integer_field(
        "storage.current_box",
        "Current PC box",
        CURRENT_BOX,
        u32::from(bytes[CURRENT_BOX] & 0x7f),
        false,
        (0, 11),
        "Current PC box number. Changing boxes requires moving their Pokémon data.",
    ));
    if game == Game::Yellow {
        fields.push(integer_field(
            "yellow.pikachu_friendship",
            "Pikachu friendship",
            YELLOW_PIKACHU_FRIENDSHIP,
            u32::from(bytes[YELLOW_PIKACHU_FRIENDSHIP]),
            true,
            (0, 255),
            "Yellow's starter Pikachu friendship",
        ));
        fields.push(integer_field(
            "yellow.pikachu_beach_score",
            "Pikachu Beach score",
            YELLOW_BEACH_SCORE,
            read_bcd(
                &[bytes[YELLOW_BEACH_SCORE + 1], bytes[YELLOW_BEACH_SCORE]],
                0,
                2,
            )?,
            true,
            (0, 9_999),
            "Pokémon Yellow Pikachu Beach high score",
        ));
        fields.push(integer_field(
            "yellow.printer_brightness",
            "Printer brightness",
            YELLOW_PRINTER_BRIGHTNESS,
            u32::from(bytes[YELLOW_PRINTER_BRIGHTNESS]),
            true,
            (0, 127),
            "Game Boy Printer brightness",
        ));
    }
    let section = SaveSection {
        id: 0,
        physical_offset: CHECKSUM_START as u32,
        checksum_expected: u16::from(bytes[CHECKSUM]),
        checksum_actual: u16::from(checksum(bytes)),
        signature: 0,
        counter: 0,
        valid: true,
    };
    trace!(game = %identity.id, "validated Pokémon Gen I save");
    debug!(game = %identity.id, "parsed Pokémon Gen I save");
    Ok(SaveDocument {
        identity: identity.clone(),
        active_slot: 0,
        counter: 0,
        integrity: SaveIntegrity {
            state: SaveIntegrityState::Valid,
            issues: Vec::new(),
        },
        sections: vec![section],
        fields,
        platform: "game-boy".into(),
        save_format: GAME_BOY_SRAM_32K.id.into(),
        save_format_name: GAME_BOY_SRAM_32K.display_name.into(),
        handler_id: "pokemon-gen1".into(),
        save_size: GEN1_SAVE_SIZE as u32,
        warnings: Vec::new(),
    })
}

fn apply_edit(bytes: &mut [u8], edit: &SaveEdit) -> Result<()> {
    match (&*edit.field, &edit.value) {
        ("trainer.id", SaveValue::U32(value)) => {
            bytes[TRAINER_ID..TRAINER_ID + 2].copy_from_slice(&(*value as u16).to_be_bytes());
        }
        ("trainer.money", SaveValue::U32(value)) => write_bcd(bytes, MONEY, 3, *value),
        ("trainer.coins", SaveValue::U32(value)) => write_bcd(bytes, COINS, 2, *value),
        ("trainer.play_time.hours", SaveValue::U32(value)) => {
            bytes[PLAY_TIME] = *value as u8;
            bytes[PLAY_TIME + 1] = if *value == 255 { 0xff } else { 0 };
        }
        ("trainer.play_time.minutes", SaveValue::U32(value)) => bytes[PLAY_TIME + 2] = *value as u8,
        ("trainer.play_time.seconds", SaveValue::U32(value)) => bytes[PLAY_TIME + 3] = *value as u8,
        ("trainer.play_time.frames", SaveValue::U32(value)) => bytes[PLAY_TIME + 4] = *value as u8,
        ("options.text_speed", SaveValue::Enum(value)) => {
            let value = match value.as_str() {
                "fast" => 1,
                "medium" => 3,
                "slow" => 5,
                _ => return Err(validation("save_value_choice", "unknown text speed")),
            };
            bytes[OPTIONS] = (bytes[OPTIONS] & !0x07) | value;
        }
        ("options.battle_scene", SaveValue::Bool(value)) => {
            bytes[OPTIONS] = (bytes[OPTIONS] & !0x80) | if *value { 0 } else { 0x80 };
        }
        ("options.battle_style", SaveValue::Bool(value)) => {
            bytes[OPTIONS] = (bytes[OPTIONS] & !0x40) | if *value { 0 } else { 0x40 };
        }
        ("options.sound", SaveValue::Enum(value)) => {
            let value = match value.as_str() {
                "mono" => 0,
                "earphone_1" => 1,
                "earphone_2" => 2,
                "earphone_3" => 3,
                _ => return Err(validation("save_value_choice", "unknown sound mode")),
            };
            bytes[OPTIONS] = (bytes[OPTIONS] & !0x30) | (value << 4);
        }
        (_, SaveValue::Bool(_))
            if edit.field.starts_with("progress.badge_")
                || edit.field.starts_with("progress.pokedex_owned_")
                || edit.field.starts_with("progress.pokedex_seen_") =>
        {
            apply_progress_edit(bytes, edit)?;
        }
        ("yellow.pikachu_friendship", SaveValue::U32(value)) => {
            bytes[YELLOW_PIKACHU_FRIENDSHIP] = *value as u8;
        }
        ("yellow.pikachu_beach_score", SaveValue::U32(value)) => {
            let mut encoded = [0; 2];
            write_bcd(&mut encoded, 0, 2, *value);
            bytes[YELLOW_BEACH_SCORE..YELLOW_BEACH_SCORE + 2]
                .copy_from_slice(&[encoded[1], encoded[0]]);
        }
        ("yellow.printer_brightness", SaveValue::U32(value)) => {
            bytes[YELLOW_PRINTER_BRIGHTNESS] = *value as u8;
        }
        _ => {
            return Err(validation(
                "save_value_kind",
                "the requested value has the wrong type",
            ));
        }
    }
    Ok(())
}

fn apply_progress_edit(bytes: &mut [u8], edit: &SaveEdit) -> Result<()> {
    let (base, index) = if let Some(index) = edit.field.strip_prefix("progress.badge_") {
        let index = parse_index(index, 8)?;
        (BADGES, index)
    } else if let Some(index) = edit.field.strip_prefix("progress.pokedex_owned_") {
        let index = parse_index(index, 151)?;
        (DEX_OWNED, index)
    } else if let Some(index) = edit.field.strip_prefix("progress.pokedex_seen_") {
        let index = parse_index(index, 151)?;
        (DEX_SEEN, index)
    } else {
        return Err(validation(
            "save_field_unknown",
            "the requested progress field is unknown",
        ));
    };
    let SaveValue::Bool(value) = edit.value else {
        return Err(validation(
            "save_value_kind",
            "the requested value has the wrong type",
        ));
    };
    let byte = &mut bytes[base + index / 8];
    if value {
        *byte |= 1 << (index % 8);
    } else {
        *byte &= !(1 << (index % 8));
    }
    Ok(())
}

fn parse_index(value: &str, count: usize) -> Result<usize> {
    value
        .parse::<usize>()
        .ok()
        .and_then(|value| value.checked_sub(1))
        .filter(|value| *value < count)
        .ok_or_else(|| {
            validation(
                "save_field_unknown",
                "the requested progress field is unknown",
            )
        })
}

fn add_progress_fields(fields: &mut Vec<SaveField>, bytes: &[u8]) {
    for index in 0..8 {
        fields.push(bit_field(
            &format!("progress.badge_{}", index + 1),
            format!(
                "{} Badge",
                [
                    "Boulder", "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth"
                ][index]
            ),
            BADGES + index / 8,
            bytes[BADGES + index / 8] & (1 << (index % 8)) != 0,
            "Gym badge flag",
        ));
    }
    for (base, prefix, description) in [
        (DEX_OWNED, "pokedex_owned", "Pokédex owned flag"),
        (DEX_SEEN, "pokedex_seen", "Pokédex seen flag"),
    ] {
        for index in 0..151 {
            fields.push(bit_field(
                &format!("progress.{}_{:03}", prefix, index + 1),
                format!(
                    "Pokédex {} #{:03}",
                    if prefix.ends_with("owned") {
                        "owned"
                    } else {
                        "seen"
                    },
                    index + 1
                ),
                base + index / 8,
                bytes[base + index / 8] & (1 << (index % 8)) != 0,
                description,
            ));
        }
    }
}

fn add_option_fields(fields: &mut Vec<SaveField>, bytes: &[u8], game: Game) {
    let options = bytes[OPTIONS];
    fields.push(enum_field(
        "options.text_speed",
        "Text speed",
        OPTIONS,
        match options & 7 {
            1 => "fast",
            3 => "medium",
            5 => "slow",
            _ => "unknown",
        },
        matches!(options & 7, 1 | 3 | 5),
        ["fast", "medium", "slow"],
        "Text delay setting",
    ));
    fields.push(bool_field(
        "options.battle_scene",
        "Battle scene",
        OPTIONS,
        options & 0x80 == 0,
        "Show battle animations",
    ));
    fields.push(bool_field(
        "options.battle_style",
        "Battle style",
        OPTIONS,
        options & 0x40 == 0,
        "Prompt before switching Pokémon",
    ));
    if game != Game::Yellow {
        return;
    }
    fields.push(enum_field(
        "options.sound",
        "Sound",
        OPTIONS,
        ["mono", "earphone_1", "earphone_2", "earphone_3"][usize::from((options >> 4) & 3)],
        true,
        ["mono", "earphone_1", "earphone_2", "earphone_3"],
        "Sound output mode",
    ));
}

fn add_play_time_fields(fields: &mut Vec<SaveField>, bytes: &[u8]) {
    fields.push(read_only_text(
        "trainer.play_time",
        "Play time",
        PLAY_TIME,
        play_time_value(bytes),
        "Time played",
    ));
    fields.push(integer_field(
        "trainer.play_time.hours",
        "Play time hours",
        PLAY_TIME,
        u32::from(bytes[PLAY_TIME]),
        true,
        (0, 255),
        "Hours played",
    ));
    fields.push(integer_field(
        "trainer.play_time.minutes",
        "Play time minutes",
        PLAY_TIME + 2,
        u32::from(bytes[PLAY_TIME + 2]),
        true,
        (0, 59),
        "Minutes played",
    ));
    fields.push(integer_field(
        "trainer.play_time.seconds",
        "Play time seconds",
        PLAY_TIME + 3,
        u32::from(bytes[PLAY_TIME + 3]),
        true,
        (0, 59),
        "Seconds played",
    ));
    fields.push(integer_field(
        "trainer.play_time.frames",
        "Play time frames",
        PLAY_TIME + 4,
        u32::from(bytes[PLAY_TIME + 4]),
        true,
        (0, 59),
        "Frames played",
    ));
}

fn play_time_value(bytes: &[u8]) -> String {
    format!(
        "{}:{:02}:{:02}:{:02}",
        bytes[PLAY_TIME],
        bytes[PLAY_TIME + 2],
        bytes[PLAY_TIME + 3],
        bytes[PLAY_TIME + 4]
    )
}

fn read_bcd(bytes: &[u8], offset: usize, len: usize) -> Result<u32> {
    let mut value = 0;
    for byte in &bytes[offset..offset + len] {
        if byte >> 4 > 9 || byte & 0x0f > 9 {
            return Err(validation(
                "save_bcd",
                "the save contains an invalid packed decimal value",
            ));
        }
        value = value * 100 + u32::from(byte >> 4) * 10 + u32::from(byte & 0x0f);
    }
    Ok(value)
}

fn write_bcd(bytes: &mut [u8], offset: usize, len: usize, mut value: u32) {
    for byte in bytes[offset..offset + len].iter_mut().rev() {
        *byte = (value % 10) as u8 | (((value / 10) % 10) as u8) << 4;
        value /= 100;
    }
}

fn integer_field(
    id: &str,
    label: &str,
    offset: usize,
    value: u32,
    editable: bool,
    range: (i64, i64),
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: 0,
        offset: offset as u16,
        kind: SaveFieldKind::UnsignedInteger,
        value: SaveValue::U32(value),
        editable,
        constraints: SaveConstraint {
            min: Some(range.0),
            max: Some(range.1),
            ..Default::default()
        },
        description: description.into(),
        warnings: Vec::new(),
        step: Some(1),
        encoding: None,
    }
}

fn bit_field(id: &str, label: String, offset: usize, value: bool, description: &str) -> SaveField {
    SaveField {
        id: id.into(),
        label,
        section_id: 0,
        offset: offset as u16,
        kind: SaveFieldKind::BitfieldBoolean,
        value: SaveValue::Bool(value),
        editable: true,
        constraints: SaveConstraint::default(),
        description: description.into(),
        warnings: Vec::new(),
        step: None,
        encoding: None,
    }
}

fn bool_field(id: &str, label: &str, offset: usize, value: bool, description: &str) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: 0,
        offset: offset as u16,
        kind: SaveFieldKind::Boolean,
        value: SaveValue::Bool(value),
        editable: true,
        constraints: SaveConstraint::default(),
        description: description.into(),
        warnings: Vec::new(),
        step: None,
        encoding: None,
    }
}

fn enum_field<const N: usize>(
    id: &str,
    label: &str,
    offset: usize,
    value: &str,
    editable: bool,
    choices: [&str; N],
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: 0,
        offset: offset as u16,
        kind: SaveFieldKind::Enum,
        value: SaveValue::Enum(value.into()),
        editable,
        constraints: SaveConstraint {
            choices: choices.into_iter().map(str::to_owned).collect(),
            ..Default::default()
        },
        description: description.into(),
        warnings: if editable {
            Vec::new()
        } else {
            vec!["Read-only: unknown encoded value".into()]
        },
        step: None,
        encoding: None,
    }
}

fn read_only_text(
    id: &str,
    label: &str,
    offset: usize,
    value: String,
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: 0,
        offset: offset as u16,
        kind: SaveFieldKind::ReadOnlyText,
        value: SaveValue::Text(value),
        editable: false,
        constraints: SaveConstraint::default(),
        description: description.into(),
        warnings: vec!["Read-only".into()],
        step: None,
        encoding: Some("pokemon_gen1_english".into()),
    }
}

fn decode_name(bytes: &[u8]) -> String {
    let mut output = String::new();
    for byte in bytes {
        if *byte == 0x50 {
            break;
        }
        let character = match byte {
            0x80..=0x99 => (*byte - 0x80 + b'A') as char,
            0xA0..=0xB9 => (*byte - 0xA0 + b'a') as char,
            0xF6..=0xFF => (*byte - 0xF6 + b'0') as char,
            0x7F => ' ',
            0xE3 => '-',
            0xE6 => '?',
            0xE7 => '!',
            0xE8 => '.',
            _ => return format!("Unsupported Gen I character byte {byte:#04x}"),
        };
        output.push(character);
    }
    output
}

fn field_value<'a>(document: &'a SaveDocument, id: &str) -> Option<&'a SaveValue> {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| &field.value)
}

fn unsupported(reason: SaveRecognitionReason) -> SaveRecognition {
    SaveRecognition {
        outcome: SaveRecognitionOutcome::Unsupported {
            reasons: vec![reason.clone()],
        },
        candidates: Vec::new(),
        reasons: vec![reason],
    }
}

fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(yellow: bool) -> Vec<u8> {
        let mut bytes = vec![0; GEN1_SAVE_SIZE];
        bytes[TRAINER_NAME..TRAINER_NAME + 4].copy_from_slice(&[0x80, 0x81, 0x82, 0x50]);
        bytes[RIVAL_NAME..RIVAL_NAME + 4].copy_from_slice(&[0x86, 0x80, 0x93, 0x50]);
        write_bcd(&mut bytes, MONEY, 3, 12_345);
        write_bcd(&mut bytes, COINS, 2, 678);
        bytes[OPTIONS] = 3;
        bytes[PLAY_TIME..PLAY_TIME + 5].copy_from_slice(&[12, 0, 34, 56, 7]);
        bytes[BAG_COUNT] = 2;
        bytes[BAG_COUNT + 1 + 2 * 2] = 0xff;
        if yellow {
            bytes[YELLOW_STARTER] = YELLOW_STARTER_ID;
            bytes[YELLOW_PIKACHU_FRIENDSHIP] = 72;
            bytes[YELLOW_BEACH_SCORE..YELLOW_BEACH_SCORE + 2].copy_from_slice(&[0x34, 0x12]);
        }
        bytes[CHECKSUM] = checksum(&bytes);
        bytes
    }

    fn input(bytes: Vec<u8>, game: &str) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes,
            selected_game: Some(game.into()),
            rom_sha1: None,
        }
    }

    fn value<'a>(document: &'a SaveDocument, field: &str) -> &'a SaveValue {
        field_value(document, field).unwrap()
    }

    #[test]
    fn red_round_trips_safe_fields_and_preserves_unknown_bytes() {
        let handler = PokemonGen1Handler;
        let mut bytes = save(false);
        bytes[0x7000] = 0xa5;
        let input = input(bytes, "pokemon-red");
        let game = identity("pokemon-red");
        let document = handler.parse(&input, &game).unwrap();
        assert_eq!(value(&document, "trainer.money"), &SaveValue::U32(12_345));
        assert_eq!(value(&document, "trainer.coins"), &SaveValue::U32(678));
        assert_eq!(
            value(&document, "trainer.play_time"),
            &SaveValue::Text("12:34:56:07".into())
        );
        let result = handler
            .apply(
                &input,
                &game,
                &[
                    SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(999_999),
                    },
                    SaveEdit {
                        field: "trainer.coins".into(),
                        value: SaveValue::U32(9_999),
                    },
                    SaveEdit {
                        field: "progress.badge_8".into(),
                        value: SaveValue::Bool(true),
                    },
                    SaveEdit {
                        field: "progress.pokedex_owned_151".into(),
                        value: SaveValue::Bool(true),
                    },
                    SaveEdit {
                        field: "options.battle_scene".into(),
                        value: SaveValue::Bool(false),
                    },
                ],
                false,
            )
            .unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(output[0x7000], 0xa5);
        assert!(valid_checksum(&output));
        assert_eq!(
            value(&result.document, "trainer.money"),
            &SaveValue::U32(999_999)
        );
        assert_eq!(
            value(&result.document, "trainer.coins"),
            &SaveValue::U32(9_999)
        );
        assert_eq!(
            value(&result.document, "progress.badge_8"),
            &SaveValue::Bool(true)
        );
        assert_eq!(
            value(&result.document, "progress.pokedex_owned_151"),
            &SaveValue::Bool(true)
        );
        assert_eq!(
            value(&result.document, "options.battle_scene"),
            &SaveValue::Bool(false)
        );
    }

    #[test]
    fn yellow_is_distinguished_by_the_verified_starter_marker() {
        let handler = PokemonGen1Handler;
        let input = input(save(true), "pokemon-yellow");
        let document = handler.parse(&input, &identity("pokemon-yellow")).unwrap();
        assert_eq!(
            value(&document, "yellow.pikachu_beach_score"),
            &SaveValue::U32(1234)
        );
        let edited = handler
            .apply(
                &input,
                &identity("pokemon-yellow"),
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
            .unwrap()
            .bytes
            .unwrap();
        assert_eq!(
            &edited[YELLOW_BEACH_SCORE..YELLOW_BEACH_SCORE + 2],
            &[0x76, 0x98]
        );
        assert_eq!(edited[OPTIONS], 0x33);
        assert_eq!(
            value(&document, "yellow.pikachu_friendship"),
            &SaveValue::U32(72)
        );
        assert!(
            handler
                .recognize(&input)
                .candidates
                .iter()
                .any(|candidate| candidate.identity.id == "pokemon-yellow")
        );
        assert!(handler.parse(&input, &identity("pokemon-red")).is_err());
    }

    #[test]
    fn malformed_checksum_bcd_and_bag_count_are_rejected() {
        let handler = PokemonGen1Handler;
        let mut bytes = save(false);
        bytes[CHECKSUM] ^= 1;
        assert!(
            handler
                .parse(&input(bytes, "pokemon-red"), &identity("pokemon-red"))
                .is_err()
        );

        let mut bytes = save(false);
        bytes[MONEY] = 0xfa;
        bytes[CHECKSUM] = checksum(&bytes);
        assert!(
            handler
                .parse(&input(bytes, "pokemon-red"), &identity("pokemon-red"))
                .is_err()
        );

        let mut bytes = save(false);
        bytes[BAG_COUNT] = BAG_CAPACITY + 1;
        bytes[CHECKSUM] = checksum(&bytes);
        assert!(
            handler
                .parse(&input(bytes, "pokemon-red"), &identity("pokemon-red"))
                .is_err()
        );
    }

    #[test]
    fn box_switches_and_invalid_clock_values_do_not_produce_output() {
        let source = input(save(false), "pokemon-red");
        for (field, value) in [
            ("storage.current_box", 3),
            ("trainer.play_time.minutes", 60),
            ("trainer.play_time.seconds", 60),
            ("trainer.play_time.frames", 60),
        ] {
            assert!(
                PokemonGen1Handler
                    .apply(
                        &source,
                        &identity("pokemon-red"),
                        &[SaveEdit {
                            field: field.into(),
                            value: SaveValue::U32(value)
                        },],
                        false
                    )
                    .is_err()
            );
        }
    }

    #[test]
    fn generated_saves_parse_and_recognize_every_gen1_game() {
        let handler = PokemonGen1Handler;
        for id in ["pokemon-red", "pokemon-blue", "pokemon-yellow"] {
            let game = identity(id);
            let bytes = SaveGameHandler::generate(&handler, &game).unwrap();
            assert_eq!(bytes.len(), GEN1_SAVE_SIZE);
            assert!(valid_checksum(&bytes));
            assert_eq!(bytes[BAG_COUNT], 0);
            assert_eq!(bytes[BAG_COUNT + 1], 0xff);

            let input = input(bytes, id);
            let document = handler.parse(&input, &game).unwrap();
            assert_eq!(document.identity.id, id);
            assert!(matches!(
                handler.recognize(&input).outcome,
                SaveRecognitionOutcome::Recognized { ref candidate } if candidate.identity.id == id
            ));
        }
    }

    #[test]
    fn generation_rejects_an_identity_from_another_handler() {
        let game = SaveGameIdentity {
            id: "pokemon-gold".into(),
            name: "Pokémon Gold".into(),
            family: "pokemon-gen2-gs".into(),
        };
        assert!(SaveGameHandler::generate(&PokemonGen1Handler, &game).is_err());
    }
}
