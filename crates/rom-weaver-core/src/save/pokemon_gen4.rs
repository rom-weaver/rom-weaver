use tracing::{debug, trace};

use super::formats::NINTENDO_DS_512K;
use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityIssue, SaveIntegrityState, SaveRecognition,
    SaveRecognitionConfidence, SaveRecognitionOutcome, SaveRecognitionReason, SaveSection,
    SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

pub const GEN4_SAVE_SIZE: usize = NINTENDO_DS_512K.supported_sizes[0];
const COPY_SIZE: usize = 0x40000;
const FOOTER_SIZE: usize = 16;
const FOOTER_MAGIC: u32 = 0x2006_0623;
const MAIN_BLOCK_SIZE: usize = 0xF628;
const MAIN_FOOTER_OFFSET: usize = MAIN_BLOCK_SIZE - FOOTER_SIZE;
const PC_BLOCK_OFFSET: usize = 0xF700;
const PC_BLOCK_SIZE: usize = 0x12310;
const PC_FOOTER_OFFSET: usize = PC_BLOCK_OFFSET + PC_BLOCK_SIZE - FOOTER_SIZE;
const SYS_INFO_SIZE: usize = 0x5c;
const ARRAY_CRC_SIZE: usize = 4;
const PLAYER_DATA_OFFSET: usize = SYS_INFO_SIZE + ARRAY_CRC_SIZE;
const PROFILE_OFFSET: usize = PLAYER_DATA_OFFSET + 4;
const PROFILE_ID_OFFSET: usize = PROFILE_OFFSET + 16;
const PROFILE_MONEY_OFFSET: usize = PROFILE_OFFSET + 20;
const PROFILE_GENDER_OFFSET: usize = PROFILE_OFFSET + 24;
const PROFILE_JOHTO_BADGES_OFFSET: usize = PROFILE_OFFSET + 26;
const PROFILE_VERSION_OFFSET: usize = PROFILE_OFFSET + 28;
const PROFILE_KANTO_BADGES_OFFSET: usize = PROFILE_OFFSET + 31;
const PLAY_TIME_OFFSET: usize = PROFILE_OFFSET + 0x22;
const MAX_MONEY: u32 = 999_999;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Title {
    HeartGold,
    SoulSilver,
}

impl Title {
    const ALL: [Self; 2] = [Self::HeartGold, Self::SoulSilver];

    fn id(self) -> &'static str {
        match self {
            Self::HeartGold => "pokemon-heartgold",
            Self::SoulSilver => "pokemon-soulsilver",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::HeartGold => "Pokémon HeartGold",
            Self::SoulSilver => "Pokémon SoulSilver",
        }
    }

    fn version(self) -> u8 {
        // https://github.com/pret/pokeheartgold/blob/master/include/config.h
        match self {
            Self::HeartGold => 7,
            Self::SoulSilver => 8,
        }
    }

    fn identity(self) -> SaveGameIdentity {
        SaveGameIdentity {
            id: self.id().into(),
            name: self.name().into(),
            family: "pokemon-gen4-hgss".into(),
        }
    }

    fn definition(self) -> SaveGameDefinition {
        SaveGameDefinition {
            identity: self.identity(),
            platform: "nds".into(),
            save_format: NINTENDO_DS_512K.id.into(),
            save_format_name: NINTENDO_DS_512K.display_name.into(),
            handler_id: "pokemon-gen4".into(),
            supported_save_sizes: vec![GEN4_SAVE_SIZE as u32],
            known_rom_sha1: Vec::new(),
            checksum_sizes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct Footer {
    offset: usize,
    count: u32,
    crc: u16,
}

#[derive(Clone, Debug)]
struct ParsedSlot {
    slot: u8,
    base: usize,
    counter: u32,
    main: Footer,
    pc: Footer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RedundancyState {
    Complete,
    EmptyBackup,
    DamagedBackup,
}

pub struct PokemonGen4Handler;

impl SaveGameHandler for PokemonGen4Handler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        Title::ALL.into_iter().map(Title::definition).collect()
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        if input.bytes.len() != GEN4_SAVE_SIZE {
            let reasons = vec![SaveRecognitionReason::WrongSize];
            return SaveRecognition {
                outcome: SaveRecognitionOutcome::Unsupported {
                    reasons: reasons.clone(),
                },
                candidates: Vec::new(),
                reasons,
            };
        }

        let titles: Vec<Title> = match input.selected_game.as_deref() {
            Some(id) => title_for_id(id).into_iter().collect(),
            None => Title::ALL.to_vec(),
        };
        let candidates: Vec<SaveGameCandidate> = titles
            .into_iter()
            .filter(|title| active_slot(&input.bytes, *title).is_ok())
            .map(|title| SaveGameCandidate {
                identity: title.identity(),
                confidence: SaveRecognitionConfidence::High,
                reasons: {
                    let mut reasons = vec![
                        SaveRecognitionReason::ChecksumValid,
                        SaveRecognitionReason::SignatureValid,
                        SaveRecognitionReason::CounterUniform,
                    ];
                    if input.selected_game.is_some() {
                        reasons.push(SaveRecognitionReason::SelectedGame);
                    }
                    reasons
                },
            })
            .collect();
        let reasons = if candidates.is_empty() {
            vec![SaveRecognitionReason::UnsupportedLayout]
        } else {
            Vec::new()
        };
        let outcome = match candidates.as_slice() {
            [candidate] => SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            [] => SaveRecognitionOutcome::Unsupported {
                reasons: reasons.clone(),
            },
            candidates => SaveRecognitionOutcome::Ambiguous {
                candidates: candidates.to_vec(),
            },
        };
        SaveRecognition {
            outcome,
            candidates,
            reasons,
        }
    }

    fn parse(&self, input: &SaveDetectionInput, game: &SaveGameIdentity) -> Result<SaveDocument> {
        let title = title_for_game(game)?;
        let (active, redundancy) = active_slot(&input.bytes, title)?;
        build_document(&input.bytes, title, game, &active, redundancy)
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        let title = title_for_game(game)?;
        let (active, redundancy) = active_slot(&input.bytes, title)?;
        let document = build_document(&input.bytes, title, game, &active, redundancy)?;
        if redundancy != RedundancyState::Complete {
            return Err(validation(
                "save_integrity_partial",
                "normal edits need two valid Pokémon HeartGold or SoulSilver save copies",
            ));
        }
        let preview = validate_save_edits(&document, edits)?;
        if !preview.changed {
            return Ok(SaveEditResult {
                preview,
                bytes: None,
                document,
            });
        }

        let mut bytes = input.bytes.clone();
        apply_to_active(&mut bytes, &active, edits)?;
        repair_main_crc(&mut bytes, &active);

        let (reparsed_active, reparsed_redundancy) = active_slot(&bytes, title)?;
        let reparsed = build_document(&bytes, title, game, &reparsed_active, reparsed_redundancy)?;
        for edit in edits {
            if field_value(&reparsed, &edit.field) != Some(&edit.value) {
                return Err(validation(
                    "save_edit_reparse_mismatch",
                    "the edited save did not produce the requested value",
                ));
            }
        }
        Ok(SaveEditResult {
            preview,
            bytes: (!dry_run).then_some(bytes),
            document: reparsed,
        })
    }
}

fn title_for_id(id: &str) -> Option<Title> {
    Title::ALL.into_iter().find(|title| title.id() == id)
}

fn title_for_game(game: &SaveGameIdentity) -> Result<Title> {
    title_for_id(&game.id).ok_or_else(|| {
        validation(
            "save_game_unsupported",
            "the selected save game is unsupported",
        )
    })
}

fn active_slot(bytes: &[u8], title: Title) -> Result<(ParsedSlot, RedundancyState)> {
    if bytes.len() != GEN4_SAVE_SIZE {
        return Err(validation(
            "save_wrong_size",
            "a Pokémon HeartGold or SoulSilver save must be exactly 512 KiB",
        ));
    }
    let left = parse_slot(bytes, 0, title);
    let right = parse_slot(bytes, 1, title);
    match (left, right) {
        (Ok(left), Ok(right)) => Ok((
            if left.counter == right.counter || is_newer(left.counter, right.counter) {
                left
            } else {
                right
            },
            RedundancyState::Complete,
        )),
        (Ok(slot), Err(_)) => Ok((
            slot,
            if copy_is_empty(bytes, 1) {
                RedundancyState::EmptyBackup
            } else {
                RedundancyState::DamagedBackup
            },
        )),
        (Err(_), Ok(slot)) => Ok((
            slot,
            if copy_is_empty(bytes, 0) {
                RedundancyState::EmptyBackup
            } else {
                RedundancyState::DamagedBackup
            },
        )),
        (Err(error), Err(_)) => Err(error),
    }
}

fn parse_slot(bytes: &[u8], slot: u8, title: Title) -> Result<ParsedSlot> {
    let base = usize::from(slot) * COPY_SIZE;
    let copy = &bytes[base..base + COPY_SIZE];
    let main = parse_footer(copy, MAIN_FOOTER_OFFSET, 0, MAIN_BLOCK_SIZE, 0, "main")?;
    let pc = parse_footer(
        copy,
        PC_FOOTER_OFFSET,
        1,
        PC_BLOCK_SIZE,
        PC_BLOCK_OFFSET,
        "PC",
    )?;
    if main.count != pc.count {
        return Err(validation(
            "save_counter",
            "the main and PC blocks do not share one save counter",
        ));
    }
    validate_profile(copy, title)?;
    trace!(
        slot,
        counter = main.count,
        "validated Pokémon Gen IV save copy"
    );
    Ok(ParsedSlot {
        slot,
        base,
        counter: main.count,
        main,
        pc,
    })
}

fn parse_footer(
    copy: &[u8],
    offset: usize,
    slot: u16,
    size: usize,
    block_start: usize,
    block_name: &'static str,
) -> Result<Footer> {
    if footer_magic(copy, offset) != FOOTER_MAGIC
        || footer_slot(copy, offset) != slot
        || read_u32(copy, offset + 4) != size as u32
    {
        return Err(validation(
            "save_layout",
            if block_name == "main" {
                "the main save block footer does not match the HeartGold and SoulSilver layout"
            } else {
                "the PC save block footer does not match the HeartGold and SoulSilver layout"
            },
        ));
    }
    let crc = footer_crc(copy, offset);
    if crc16_ccitt(&copy[block_start..offset]) != crc {
        return Err(validation(
            "save_checksum",
            if block_name == "main" {
                "the main save block checksum is invalid"
            } else {
                "the PC save block checksum is invalid"
            },
        ));
    }
    Ok(Footer {
        offset,
        count: read_u32(copy, offset),
        crc,
    })
}

fn validate_profile(copy: &[u8], title: Title) -> Result<()> {
    if copy[PROFILE_VERSION_OFFSET] != title.version() {
        return Err(validation(
            "save_game_version",
            "the trainer profile does not match the selected game",
        ));
    }
    if copy[PROFILE_GENDER_OFFSET] > 1 {
        return Err(validation(
            "save_gender",
            "the save has an invalid player gender value",
        ));
    }
    if read_u32(copy, PROFILE_MONEY_OFFSET) > MAX_MONEY {
        return Err(validation(
            "save_money",
            "the save has a money value above the game limit",
        ));
    }
    Ok(())
}

fn build_document(
    bytes: &[u8],
    title: Title,
    identity: &SaveGameIdentity,
    active: &ParsedSlot,
    redundancy: RedundancyState,
) -> Result<SaveDocument> {
    let copy = &bytes[active.base..active.base + COPY_SIZE];
    validate_profile(copy, title)?;
    let editable = redundancy == RedundancyState::Complete;
    let trainer_id = read_u32(copy, PROFILE_ID_OFFSET);
    let mut fields = vec![
        SaveField {
            id: "trainer.id".into(),
            label: "Trainer ID".into(),
            section_id: 0,
            offset: PROFILE_ID_OFFSET as u16,
            kind: SaveFieldKind::ReadOnlyInteger,
            value: SaveValue::U32(trainer_id & 0xffff),
            editable: false,
            constraints: SaveConstraint::default(),
            description: "Public trainer identifier".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
        SaveField {
            id: "trainer.secret_id".into(),
            label: "Secret ID".into(),
            section_id: 0,
            offset: PROFILE_ID_OFFSET as u16,
            kind: SaveFieldKind::ReadOnlyInteger,
            value: SaveValue::U32(trainer_id >> 16),
            editable: false,
            constraints: SaveConstraint::default(),
            description: "Hidden trainer identifier".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
        SaveField {
            id: "trainer.gender".into(),
            label: "Gender".into(),
            section_id: 0,
            offset: PROFILE_GENDER_OFFSET as u16,
            kind: SaveFieldKind::Enum,
            value: SaveValue::Enum(
                if copy[PROFILE_GENDER_OFFSET] == 0 {
                    "male"
                } else {
                    "female"
                }
                .into(),
            ),
            editable,
            constraints: SaveConstraint {
                choices: vec!["male".into(), "female".into()],
                ..Default::default()
            },
            description: "Player gender".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
        SaveField {
            id: "trainer.money".into(),
            label: "Money".into(),
            section_id: 0,
            offset: PROFILE_MONEY_OFFSET as u16,
            kind: SaveFieldKind::UnsignedInteger,
            value: SaveValue::U32(read_u32(copy, PROFILE_MONEY_OFFSET)),
            editable,
            constraints: SaveConstraint {
                min: Some(0),
                max: Some(i64::from(MAX_MONEY)),
                ..Default::default()
            },
            description: "Money carried by the player".into(),
            warnings: Vec::new(),
            step: Some(1),
            encoding: None,
        },
        SaveField {
            id: "trainer.play_time".into(),
            label: "Play time".into(),
            section_id: 0,
            offset: PLAY_TIME_OFFSET as u16,
            kind: SaveFieldKind::ReadOnlyText,
            value: SaveValue::Text(format!(
                "{}:{:02}:{:02}",
                read_u16(copy, PLAY_TIME_OFFSET),
                copy[PLAY_TIME_OFFSET + 2],
                copy[PLAY_TIME_OFFSET + 3]
            )),
            editable: false,
            constraints: SaveConstraint::default(),
            description: "Time played".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
    ];
    for badge in 0..16u8 {
        let (offset, bit) = badge_location(badge);
        fields.push(SaveField {
            id: format!("progress.badge_{}", badge + 1),
            label: format!("Badge {}", badge + 1),
            section_id: 0,
            offset: offset as u16,
            kind: SaveFieldKind::BitfieldBoolean,
            value: SaveValue::Bool(copy[offset] & (1 << bit) != 0),
            editable,
            constraints: SaveConstraint::default(),
            description: "Gym badge flag".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        });
    }
    debug!(game = %identity.id, slot = active.slot, "parsed Pokémon Gen IV save");
    Ok(SaveDocument {
        identity: identity.clone(),
        active_slot: active.slot,
        counter: active.counter,
        integrity: SaveIntegrity {
            state: match redundancy {
                RedundancyState::Complete => SaveIntegrityState::Valid,
                RedundancyState::EmptyBackup => SaveIntegrityState::ValidWithWarnings,
                RedundancyState::DamagedBackup => SaveIntegrityState::PartiallyRecoverable,
            },
            issues: integrity_issues(redundancy),
        },
        sections: vec![
            SaveSection {
                id: 0,
                physical_offset: active.base as u32,
                checksum_expected: active.main.crc,
                checksum_actual: crc16_ccitt(&bytes[active.base..active.base + active.main.offset]),
                signature: FOOTER_MAGIC,
                counter: active.main.count,
                valid: true,
            },
            SaveSection {
                id: 1,
                physical_offset: (active.base + PC_BLOCK_OFFSET) as u32,
                checksum_expected: active.pc.crc,
                checksum_actual: crc16_ccitt(
                    &bytes[active.base + PC_BLOCK_OFFSET..active.base + active.pc.offset],
                ),
                signature: FOOTER_MAGIC,
                counter: active.pc.count,
                valid: true,
            },
        ],
        fields,
        platform: "nds".into(),
        save_format: NINTENDO_DS_512K.id.into(),
        save_format_name: NINTENDO_DS_512K.display_name.into(),
        handler_id: "pokemon-gen4".into(),
        save_size: GEN4_SAVE_SIZE as u32,
        warnings: match redundancy {
            RedundancyState::Complete => Vec::new(),
            RedundancyState::EmptyBackup => {
                vec!["The redundant save copy is empty; the editor preserves it".into()]
            }
            RedundancyState::DamagedBackup => {
                vec!["One redundant save copy is invalid; normal editing is disabled".into()]
            }
        },
    })
}

fn integrity_issues(redundancy: RedundancyState) -> Vec<SaveIntegrityIssue> {
    match redundancy {
        RedundancyState::Complete => Vec::new(),
        RedundancyState::EmptyBackup => vec![SaveIntegrityIssue {
            code: "redundant_slot_empty".into(),
            message: "The redundant save copy is empty".into(),
            section_id: None,
        }],
        RedundancyState::DamagedBackup => vec![SaveIntegrityIssue {
            code: "redundant_slot_invalid".into(),
            message: "One redundant save copy failed integrity checks".into(),
            section_id: None,
        }],
    }
}

fn apply_to_active(bytes: &mut [u8], active: &ParsedSlot, edits: &[SaveEdit]) -> Result<()> {
    let copy = &mut bytes[active.base..active.base + COPY_SIZE];
    for edit in edits {
        match (edit.field.as_str(), &edit.value) {
            ("trainer.gender", SaveValue::Enum(value)) => {
                copy[PROFILE_GENDER_OFFSET] = match value.as_str() {
                    "male" => 0,
                    "female" => 1,
                    _ => {
                        return Err(validation(
                            "save_value_choice",
                            "the requested gender is not allowed",
                        ));
                    }
                }
            }
            ("trainer.money", SaveValue::U32(value)) => {
                copy[PROFILE_MONEY_OFFSET..PROFILE_MONEY_OFFSET + 4]
                    .copy_from_slice(&value.to_le_bytes());
            }
            (field, SaveValue::Bool(value)) if field.starts_with("progress.badge_") => {
                let badge = field[15..]
                    .parse::<u8>()
                    .ok()
                    .and_then(|number| number.checked_sub(1))
                    .ok_or_else(|| {
                        validation("save_field_unknown", "the requested badge field is unknown")
                    })?;
                let (offset, bit) = badge_location_checked(badge)?;
                if *value {
                    copy[offset] |= 1 << bit;
                } else {
                    copy[offset] &= !(1 << bit);
                }
            }
            _ => {
                return Err(validation(
                    "save_value_kind",
                    "the requested value has the wrong type",
                ));
            }
        }
    }
    Ok(())
}

fn repair_main_crc(bytes: &mut [u8], active: &ParsedSlot) {
    let crc = crc16_ccitt(&bytes[active.base..active.base + active.main.offset]);
    let footer = active.base + active.main.offset;
    bytes[footer + 14..footer + 16].copy_from_slice(&crc.to_le_bytes());
}

fn badge_location(badge: u8) -> (usize, u8) {
    if badge < 8 {
        (PROFILE_JOHTO_BADGES_OFFSET, badge)
    } else {
        (PROFILE_KANTO_BADGES_OFFSET, badge - 8)
    }
}

fn badge_location_checked(badge: u8) -> Result<(usize, u8)> {
    (badge < 16)
        .then(|| badge_location(badge))
        .ok_or_else(|| validation("save_field_unknown", "the requested badge field is unknown"))
}

fn field_value<'a>(document: &'a SaveDocument, id: &str) -> Option<&'a SaveValue> {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| &field.value)
}

fn copy_is_empty(bytes: &[u8], slot: u8) -> bool {
    let base = usize::from(slot) * COPY_SIZE;
    bytes[base..base + COPY_SIZE]
        .iter()
        .all(|byte| *byte == 0xff)
}

fn is_newer(left: u32, right: u32) -> bool {
    // https://github.com/pret/pokeheartgold/blob/master/src/save.c
    if left == u32::MAX && right == 0 {
        return false;
    }
    if left == 0 && right == u32::MAX {
        return true;
    }
    left > right
}

fn footer_magic(copy: &[u8], offset: usize) -> u32 {
    read_u32(copy, offset + 8)
}

fn footer_slot(copy: &[u8], offset: usize) -> u16 {
    read_u16(copy, offset + 12)
}

fn footer_crc(copy: &[u8], offset: usize) -> u16 {
    read_u16(copy, offset + 14)
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn crc16_ccitt(data: &[u8]) -> u16 {
    // https://github.com/pret/pokeheartgold/blob/master/lib/include/nitro/math/crc.h
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

fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_PROFILE_OFFSET: usize = 0x64;
    const FIXTURE_ID_OFFSET: usize = FIXTURE_PROFILE_OFFSET + 0x10;
    const FIXTURE_MONEY_OFFSET: usize = FIXTURE_PROFILE_OFFSET + 0x14;
    const FIXTURE_GENDER_OFFSET: usize = FIXTURE_PROFILE_OFFSET + 0x18;
    const FIXTURE_JOHTO_BADGES_OFFSET: usize = FIXTURE_PROFILE_OFFSET + 0x1A;
    const FIXTURE_VERSION_OFFSET: usize = FIXTURE_PROFILE_OFFSET + 0x1C;
    const FIXTURE_PLAY_TIME_OFFSET: usize = FIXTURE_PROFILE_OFFSET + 0x22;

    fn synthetic_save(left_count: u32, right_count: u32, title: Title) -> Vec<u8> {
        let mut bytes = vec![0xff; GEN4_SAVE_SIZE];
        write_copy(&mut bytes, 0, left_count, title, 100, 0b0000_0011);
        write_copy(&mut bytes, 1, right_count, title, 200, 0b0000_0101);
        bytes
    }

    fn write_copy(
        bytes: &mut [u8],
        slot: u8,
        count: u32,
        title: Title,
        money: u32,
        johto_badges: u8,
    ) {
        let base = usize::from(slot) * COPY_SIZE;
        let copy = &mut bytes[base..base + COPY_SIZE];
        copy[..PC_BLOCK_OFFSET + PC_BLOCK_SIZE].fill(0);
        copy[FIXTURE_ID_OFFSET..FIXTURE_ID_OFFSET + 4]
            .copy_from_slice(&0x1234_5678u32.to_le_bytes());
        copy[FIXTURE_MONEY_OFFSET..FIXTURE_MONEY_OFFSET + 4].copy_from_slice(&money.to_le_bytes());
        copy[FIXTURE_GENDER_OFFSET] = 0;
        copy[FIXTURE_JOHTO_BADGES_OFFSET] = johto_badges;
        copy[FIXTURE_VERSION_OFFSET] = title.version();
        copy[FIXTURE_PLAY_TIME_OFFSET..FIXTURE_PLAY_TIME_OFFSET + 2]
            .copy_from_slice(&12u16.to_le_bytes());
        copy[FIXTURE_PLAY_TIME_OFFSET + 2] = 34;
        copy[FIXTURE_PLAY_TIME_OFFSET + 3] = 56;
        write_footer(copy, MAIN_BLOCK_SIZE, count, 0, 0);
        write_footer(
            copy,
            PC_BLOCK_OFFSET + PC_BLOCK_SIZE,
            count,
            1,
            PC_BLOCK_OFFSET,
        );
    }

    fn write_footer(copy: &mut [u8], end: usize, count: u32, slot: u16, start: usize) {
        let footer = end - FOOTER_SIZE;
        copy[footer..footer + 4].copy_from_slice(&count.to_le_bytes());
        copy[footer + 4..footer + 8]
            .copy_from_slice(&u32::try_from(end - start).unwrap().to_le_bytes());
        copy[footer + 8..footer + 12].copy_from_slice(&FOOTER_MAGIC.to_le_bytes());
        copy[footer + 12..footer + 14].copy_from_slice(&slot.to_le_bytes());
        let crc = crc16_ccitt(&copy[start..footer]);
        copy[footer + 14..footer + 16].copy_from_slice(&crc.to_le_bytes());
    }

    fn game(title: Title) -> SaveGameIdentity {
        title.identity()
    }

    #[test]
    fn selects_the_newest_complete_copy_and_edits_only_it() {
        let mut bytes = synthetic_save(10, 11, Title::HeartGold);
        bytes[COPY_SIZE + 0x800] = 0x6a;
        write_footer(&mut bytes[COPY_SIZE..], MAIN_BLOCK_SIZE, 11, 0, 0);
        let input = SaveDetectionInput {
            bytes: bytes.clone(),
            selected_game: Some(Title::HeartGold.id().into()),
            rom_sha1: None,
        };
        let result = PokemonGen4Handler
            .apply(
                &input,
                &game(Title::HeartGold),
                &[
                    SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(999_999),
                    },
                    SaveEdit {
                        field: "progress.badge_4".into(),
                        value: SaveValue::Bool(true),
                    },
                ],
                false,
            )
            .unwrap();
        let output = result.bytes.unwrap();
        assert_eq!(result.document.active_slot, 1);
        assert_eq!(
            read_u32(&output[COPY_SIZE..], FIXTURE_MONEY_OFFSET),
            MAX_MONEY
        );
        assert_eq!(
            output[COPY_SIZE + FIXTURE_JOHTO_BADGES_OFFSET] & (1 << 3),
            1 << 3
        );
        assert_eq!(read_u32(&output, FIXTURE_MONEY_OFFSET), 100);
        assert_eq!(output[COPY_SIZE + 0x800], 0x6a);
        assert_eq!(
            crc16_ccitt(&output[COPY_SIZE..COPY_SIZE + MAIN_FOOTER_OFFSET]),
            footer_crc(&output[COPY_SIZE..], MAIN_FOOTER_OFFSET)
        );
    }

    #[test]
    fn accepts_counter_rollover_like_the_game() {
        let bytes = synthetic_save(u32::MAX, 0, Title::SoulSilver);
        let (active, redundancy) = active_slot(&bytes, Title::SoulSilver).unwrap();
        assert_eq!(active.slot, 1);
        assert_eq!(redundancy, RedundancyState::Complete);
    }

    #[test]
    fn selects_the_first_copy_when_counters_match_like_the_game() {
        let bytes = synthetic_save(10, 10, Title::HeartGold);
        let (active, redundancy) = active_slot(&bytes, Title::HeartGold).unwrap();
        assert_eq!(active.slot, 0);
        assert_eq!(redundancy, RedundancyState::Complete);
    }

    #[test]
    fn reads_profile_fields_at_the_aligned_hgss_offsets() {
        let input = SaveDetectionInput {
            bytes: synthetic_save(10, 11, Title::SoulSilver),
            selected_game: Some(Title::SoulSilver.id().into()),
            rom_sha1: None,
        };
        let document = PokemonGen4Handler
            .parse(&input, &game(Title::SoulSilver))
            .unwrap();
        assert_eq!(
            field_value(&document, "trainer.id"),
            Some(&SaveValue::U32(0x5678))
        );
        assert_eq!(
            field_value(&document, "trainer.secret_id"),
            Some(&SaveValue::U32(0x1234))
        );
        assert_eq!(
            field_value(&document, "trainer.play_time"),
            Some(&SaveValue::Text("12:34:56".into()))
        );
    }

    #[test]
    fn rejects_a_copy_with_a_bad_main_crc() {
        let mut bytes = synthetic_save(10, 11, Title::HeartGold);
        bytes[MAIN_FOOTER_OFFSET + 14] ^= 0x80;
        bytes[COPY_SIZE + MAIN_FOOTER_OFFSET + 14] ^= 0x80;
        assert!(active_slot(&bytes, Title::HeartGold).is_err());
    }

    #[test]
    fn rejects_a_title_that_does_not_match_the_profile_version() {
        let bytes = synthetic_save(10, 11, Title::HeartGold);
        assert!(active_slot(&bytes, Title::SoulSilver).is_err());
    }

    #[test]
    fn damaged_redundant_copy_is_read_only() {
        let mut bytes = synthetic_save(10, 11, Title::HeartGold);
        bytes[COPY_SIZE + MAIN_BLOCK_SIZE - 2] ^= 0x80;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(Title::HeartGold.id().into()),
            rom_sha1: None,
        };
        let document = PokemonGen4Handler
            .parse(&input, &game(Title::HeartGold))
            .unwrap();
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
            PokemonGen4Handler
                .apply(
                    &input,
                    &game(Title::HeartGold),
                    &[SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(1),
                    }],
                    false,
                )
                .is_err()
        );
    }

    #[test]
    fn dry_run_reparses_without_returning_bytes() {
        let input = SaveDetectionInput {
            bytes: synthetic_save(10, 11, Title::SoulSilver),
            selected_game: Some(Title::SoulSilver.id().into()),
            rom_sha1: None,
        };
        let result = PokemonGen4Handler
            .apply(
                &input,
                &game(Title::SoulSilver),
                &[SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(42),
                }],
                true,
            )
            .unwrap();
        assert!(result.bytes.is_none());
        assert_eq!(
            field_value(&result.document, "trainer.money"),
            Some(&SaveValue::U32(42))
        );
        assert_eq!(
            read_u32(&input.bytes[COPY_SIZE..], PROFILE_MONEY_OFFSET),
            200
        );
    }

    #[test]
    fn matches_the_nitro_crc16_ccitt_test_vector() {
        assert_eq!(crc16_ccitt(b"123456789"), 0x29b1);
    }
}
