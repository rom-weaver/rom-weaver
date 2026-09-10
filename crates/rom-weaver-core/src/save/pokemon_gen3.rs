use tracing::{debug, trace};

use super::formats::GBA_FLASH_128K;
use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityState, SaveRecognition, SaveRecognitionConfidence,
    SaveRecognitionOutcome, SaveRecognitionReason, SaveSection, SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

pub const GEN3_SAVE_SIZE: usize = GBA_FLASH_128K.supported_sizes[0];
const SLOT_SIZE: usize = 14 * 0x1000;
const SECTION_SIZE: usize = 0x1000;
const SECTION_DATA_SIZE: usize = 0xF80;
pub(crate) const SIGNATURE: u32 = 0x0801_2025;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Family {
    Rs,
    Emerald,
    Frlg,
}

impl Family {
    fn definition(self, id: &str, name: &str) -> SaveGameDefinition {
        SaveGameDefinition {
            identity: SaveGameIdentity {
                id: id.to_owned(),
                name: name.to_owned(),
                family: match self {
                    Self::Rs => "pokemon-gen3-rs",
                    Self::Emerald => "pokemon-gen3-emerald",
                    Self::Frlg => "pokemon-gen3-frlg",
                }
                .to_owned(),
            },
            platform: "gba".to_owned(),
            save_format: GBA_FLASH_128K.id.to_owned(),
            save_format_name: GBA_FLASH_128K.display_name.to_owned(),
            handler_id: "pokemon-gen3".to_owned(),
            supported_save_sizes: vec![GEN3_SAVE_SIZE as u32],
            known_rom_sha1: Vec::new(),
            checksum_sizes: (0..14)
                .map(|section| self.checksum_size(section) as u16)
                .collect(),
        }
    }

    pub(crate) fn checksum_size(self, section: u8) -> usize {
        // These sizes follow each game's sSaveSlotLayout definition.
        // https://github.com/pret/pokeemerald/blob/master/src/save.c
        match section {
            0 => match self {
                Self::Rs => 0x890,
                Self::Emerald => 0xF2C,
                Self::Frlg => 0xF24,
            },
            1..=3 => 0xF80,
            4 => match self {
                Self::Rs => 0xC40,
                Self::Emerald => 0xF08,
                Self::Frlg => 0xEE8,
            },
            5..=12 => 0xF80,
            13 => 0x7D0,
            _ => 0,
        }
    }

    pub(crate) fn identity(self, id: &str) -> SaveGameIdentity {
        self.all_definitions()
            .into_iter()
            .find(|definition| definition.identity.id == id)
            .unwrap_or_else(|| {
                self.definition(
                    id,
                    match self {
                        Self::Rs => "Pokémon Ruby / Sapphire",
                        Self::Emerald => "Pokémon Emerald",
                        Self::Frlg => "Pokémon FireRed / LeafGreen",
                    },
                )
            })
            .identity
    }

    fn all_definitions(self) -> Vec<SaveGameDefinition> {
        match self {
            Self::Rs => vec![
                self.definition("pokemon-ruby", "Pokémon Ruby"),
                self.definition("pokemon-sapphire", "Pokémon Sapphire"),
            ],
            Self::Emerald => vec![self.definition("pokemon-emerald", "Pokémon Emerald")],
            Self::Frlg => vec![
                self.definition("pokemon-firered", "Pokémon FireRed"),
                self.definition("pokemon-leafgreen", "Pokémon LeafGreen"),
            ],
        }
    }

    fn matches_id(self, id: &str) -> bool {
        match self {
            Self::Rs => matches!(id, "pokemon-ruby" | "pokemon-sapphire"),
            Self::Emerald => id == "pokemon-emerald",
            Self::Frlg => matches!(id, "pokemon-firered" | "pokemon-leafgreen"),
        }
    }
}

#[derive(Clone, Debug)]
struct ParsedSlot {
    slot: u8,
    counter: u32,
    sections: Vec<SaveSection>,
    positions: [usize; 14],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RedundancyState {
    Complete,
    EmptyBackup,
    DamagedBackup,
}

pub struct PokemonGen3Handler;

impl SaveGameHandler for PokemonGen3Handler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        Family::Rs
            .all_definitions()
            .into_iter()
            .chain(Family::Emerald.all_definitions())
            .chain(Family::Frlg.all_definitions())
            .collect()
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        let mut candidates = Vec::new();
        let mut reasons = Vec::new();
        if !GBA_FLASH_128K.accepts(&input.bytes) {
            reasons.push(SaveRecognitionReason::WrongSize);
            return SaveRecognition {
                outcome: SaveRecognitionOutcome::Unsupported {
                    reasons: reasons.clone(),
                },
                candidates,
                reasons,
            };
        }
        for family in [Family::Rs, Family::Emerald, Family::Frlg] {
            let Some(game) = input.selected_game.as_deref() else {
                for definition in family.all_definitions() {
                    if let Some(candidate) =
                        self.candidate_for(family, &definition.identity, &input.bytes)
                    {
                        candidates.push(candidate);
                    }
                }
                continue;
            };
            if family.matches_id(game)
                && let Some(candidate) =
                    self.candidate_for(family, &self.identity_for_selected(game), &input.bytes)
            {
                candidates.push(candidate);
            }
        }
        let outcome = match candidates.as_slice() {
            [candidate] => SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            [] => SaveRecognitionOutcome::Unsupported {
                reasons: vec![SaveRecognitionReason::UnsupportedLayout],
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
        let family = family_for_game(game)?;
        let (active, redundancy) = self.active_slot(&input.bytes, family)?;
        build_document(&input.bytes, family, game, &active, redundancy)
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        let family = family_for_game(game)?;
        let (active, redundancy) = self.active_slot(&input.bytes, family)?;
        let document = build_document(&input.bytes, family, game, &active, redundancy)?;
        if redundancy == RedundancyState::DamagedBackup {
            return Err(validation(
                "save_integrity_partial",
                "normal edits need two valid Pokémon save slots",
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
        apply_to_active(&mut bytes, family, &active, edits)?;
        for id in preview.touched_sections.iter().copied() {
            recompute_checksum(
                &mut bytes,
                active.positions[id as usize],
                family.checksum_size(id),
            );
        }
        let (reparsed_active, reparsed_redundancy) = self.active_slot(&bytes, family)?;
        let reparsed = build_document(&bytes, family, game, &reparsed_active, reparsed_redundancy)?;
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

impl PokemonGen3Handler {
    fn identity_for_selected(&self, id: &str) -> SaveGameIdentity {
        let family = if matches!(id, "pokemon-ruby" | "pokemon-sapphire") {
            Family::Rs
        } else if id == "pokemon-emerald" {
            Family::Emerald
        } else {
            Family::Frlg
        };
        family.identity(id)
    }

    fn candidate_for(
        &self,
        family: Family,
        identity: &SaveGameIdentity,
        bytes: &[u8],
    ) -> Option<SaveGameCandidate> {
        let slot_a = parse_slot(bytes, 0, family).ok();
        let slot_b = parse_slot(bytes, 1, family).ok();
        if slot_a.is_none() && slot_b.is_none() {
            return None;
        }
        Some(SaveGameCandidate {
            identity: identity.clone(),
            confidence: if slot_a.is_some() && slot_b.is_some() {
                SaveRecognitionConfidence::High
            } else {
                SaveRecognitionConfidence::Medium
            },
            reasons: vec![
                SaveRecognitionReason::ChecksumValid,
                SaveRecognitionReason::SignatureValid,
                SaveRecognitionReason::CounterUniform,
            ],
        })
    }

    fn active_slot(&self, bytes: &[u8], family: Family) -> Result<(ParsedSlot, RedundancyState)> {
        let a = parse_slot(bytes, 0, family);
        let b = parse_slot(bytes, 1, family);
        match (a, b) {
            (Ok(left), Ok(right)) => {
                if left.counter == right.counter {
                    return Err(validation(
                        "save_slot_counter",
                        "the save slots have the same counter, so the active slot is ambiguous",
                    ));
                }
                Ok((
                    if is_newer(left.counter, right.counter) {
                        left
                    } else {
                        right
                    },
                    RedundancyState::Complete,
                ))
            }
            (Ok(slot), Err(_)) => Ok((
                slot,
                if slot_has_signature(bytes, 1) {
                    RedundancyState::DamagedBackup
                } else {
                    RedundancyState::EmptyBackup
                },
            )),
            (Err(_), Ok(slot)) => Ok((
                slot,
                if slot_has_signature(bytes, 0) {
                    RedundancyState::DamagedBackup
                } else {
                    RedundancyState::EmptyBackup
                },
            )),
            (Err(left), Err(_right)) => Err(left),
        }
    }
}

fn slot_has_signature(bytes: &[u8], slot: u8) -> bool {
    let base = usize::from(slot) * SLOT_SIZE;
    (0..14usize).any(|physical| {
        let footer = base + physical * SECTION_SIZE + 0xFF8;
        u32::from_le_bytes([
            bytes[footer],
            bytes[footer + 1],
            bytes[footer + 2],
            bytes[footer + 3],
        ]) == SIGNATURE
    })
}

fn family_for_game(game: &SaveGameIdentity) -> Result<Family> {
    match game.id.as_str() {
        "pokemon-ruby" | "pokemon-sapphire" => Ok(Family::Rs),
        "pokemon-emerald" => Ok(Family::Emerald),
        "pokemon-firered" | "pokemon-leafgreen" => Ok(Family::Frlg),
        _ => Err(validation(
            "save_game_unsupported",
            "the selected save game is unsupported",
        )),
    }
}

fn parse_slot(bytes: &[u8], slot: u8, family: Family) -> Result<ParsedSlot> {
    if !GBA_FLASH_128K.accepts(bytes) {
        return Err(validation(
            "save_wrong_size",
            "a Pokémon Gen III save must be exactly 128 KiB",
        ));
    }
    let base = usize::from(slot) * SLOT_SIZE;
    let mut positions = [0usize; 14];
    let mut seen = [false; 14];
    let mut sections = Vec::with_capacity(14);
    let mut counter = None;
    for physical in 0..14usize {
        let offset = base + physical * SECTION_SIZE;
        let data = &bytes[offset..offset + SECTION_SIZE];
        let id = u16::from_le_bytes([data[0xFF4], data[0xFF5]]);
        if id >= 14 {
            return Err(validation(
                "save_section_id",
                "the save has an invalid section id",
            ));
        }
        let id = id as u8;
        if seen[id as usize] {
            return Err(validation(
                "save_duplicate_section",
                "the save has a duplicate section id",
            ));
        }
        seen[id as usize] = true;
        let actual = u16::from_le_bytes([data[0xFF6], data[0xFF7]]);
        let expected = checksum(&data[..family.checksum_size(id)]);
        let signature = u32::from_le_bytes([data[0xFF8], data[0xFF9], data[0xFFA], data[0xFFB]]);
        let current_counter =
            u32::from_le_bytes([data[0xFFC], data[0xFFD], data[0xFFE], data[0xFFF]]);
        if signature != SIGNATURE {
            return Err(validation(
                "save_signature",
                "the save has an invalid section signature",
            ));
        }
        if actual != expected {
            return Err(validation(
                "save_checksum",
                "the save has an invalid section checksum",
            ));
        }
        if let Some(previous) = counter {
            if previous != current_counter {
                return Err(validation(
                    "save_counter",
                    "the save sections do not share one counter",
                ));
            }
        } else {
            counter = Some(current_counter);
        }
        positions[id as usize] = offset;
        sections.push(SaveSection {
            id,
            physical_offset: offset as u32,
            checksum_expected: actual,
            checksum_actual: expected,
            signature,
            counter: current_counter,
            valid: true,
        });
    }
    if seen.iter().any(|value| !value) {
        return Err(validation(
            "save_missing_section",
            "the save is missing a section",
        ));
    }
    let counter = counter.ok_or_else(|| validation("save_counter", "the save has no counter"))?;
    sections.sort_by_key(|section| section.id);
    trace!(slot, counter, "validated Pokémon Gen III save slot");
    Ok(ParsedSlot {
        slot,
        counter,
        sections,
        positions,
    })
}

fn is_newer(left: u32, right: u32) -> bool {
    // The games special-case only the u32::MAX-to-zero rollover, then compare normally.
    // https://github.com/pret/pokeemerald/blob/master/src/save.c
    if left == u32::MAX && right == 0 {
        return false;
    }
    if left == 0 && right == u32::MAX {
        return true;
    }
    left > right
}

pub(crate) fn checksum(data: &[u8]) -> u16 {
    let mut sum = 0u32;
    for chunk in data.chunks_exact(4) {
        sum = sum.wrapping_add(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    (sum as u16).wrapping_add((sum >> 16) as u16)
}

fn recompute_checksum(bytes: &mut [u8], offset: usize, size: usize) {
    let value = checksum(&bytes[offset..offset + size]);
    bytes[offset + 0xFF6..offset + 0xFF8].copy_from_slice(&value.to_le_bytes());
}

fn section_data<'a>(bytes: &'a [u8], active: &ParsedSlot, id: u8) -> &'a [u8] {
    &bytes[active.positions[id as usize]..active.positions[id as usize] + SECTION_DATA_SIZE]
}
fn section_data_mut<'a>(bytes: &'a mut [u8], active: &ParsedSlot, id: u8) -> &'a mut [u8] {
    let offset = active.positions[id as usize];
    &mut bytes[offset..offset + SECTION_DATA_SIZE]
}

fn build_document(
    bytes: &[u8],
    family: Family,
    identity: &SaveGameIdentity,
    active: &ParsedSlot,
    redundancy: RedundancyState,
) -> Result<SaveDocument> {
    let editable = redundancy != RedundancyState::DamagedBackup;
    let small = section_data(bytes, active, 0);
    if small[8] > 1 {
        return Err(validation(
            "save_gender",
            "the save has an invalid player gender value",
        ));
    }
    let large = [1u8, 2, 3, 4]
        .iter()
        .flat_map(|id| section_data(bytes, active, *id))
        .copied()
        .collect::<Vec<_>>();
    let security_key = match family {
        Family::Emerald => Some(u32::from_le_bytes([
            small[0xAC],
            small[0xAD],
            small[0xAE],
            small[0xAF],
        ])),
        Family::Frlg => Some(u32::from_le_bytes([
            small[0xF20],
            small[0xF21],
            small[0xF22],
            small[0xF23],
        ])),
        Family::Rs => None,
    };
    let money_offset = match family {
        Family::Frlg => 0x290,
        _ => 0x490,
    };
    let money_raw = u32::from_le_bytes([
        large[money_offset],
        large[money_offset + 1],
        large[money_offset + 2],
        large[money_offset + 3],
    ]);
    let money = money_raw ^ security_key.unwrap_or(0);
    if money > 999_999 {
        return Err(validation(
            "save_money",
            "the save has a money value above the game limit",
        ));
    }
    let badges = badge_offsets(family);
    let mut fields = vec![
        text_field(
            "trainer.name",
            "Trainer name",
            0,
            0,
            decode_text(&small[..7])?,
            editable,
            7,
        ),
        SaveField {
            id: "trainer.gender".into(),
            label: "Gender".into(),
            section_id: 0,
            offset: 8,
            kind: SaveFieldKind::Enum,
            value: SaveValue::Enum(if small[8] == 0 { "male" } else { "female" }.into()),
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
            id: "trainer.id".into(),
            label: "Trainer ID".into(),
            section_id: 0,
            offset: 10,
            kind: SaveFieldKind::ReadOnlyInteger,
            value: SaveValue::U32(u16::from_le_bytes([small[10], small[11]]) as u32),
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
            offset: 12,
            kind: SaveFieldKind::ReadOnlyInteger,
            value: SaveValue::U32(u16::from_le_bytes([small[12], small[13]]) as u32),
            editable: false,
            constraints: SaveConstraint::default(),
            description: "Hidden trainer identifier".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
        SaveField {
            id: "trainer.money".into(),
            label: "Money".into(),
            section_id: 1,
            offset: money_offset as u16,
            kind: SaveFieldKind::UnsignedInteger,
            value: SaveValue::U32(money),
            editable,
            constraints: SaveConstraint {
                min: Some(0),
                max: Some(999_999),
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
            offset: 14,
            kind: SaveFieldKind::ReadOnlyText,
            value: SaveValue::Text(format!(
                "{}:{:02}:{:02}:{:02}",
                u16::from_le_bytes([small[14], small[15]]),
                small[16],
                small[17],
                small[18]
            )),
            editable: false,
            constraints: SaveConstraint::default(),
            description: "Time played".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
    ];
    if let Some(key) = security_key {
        fields.push(SaveField {
            id: "trainer.security_key".into(),
            label: "Security key".into(),
            section_id: 0,
            offset: if matches!(family, Family::Emerald) {
                0xAC
            } else {
                0xF20
            },
            kind: SaveFieldKind::ReadOnlyInteger,
            value: SaveValue::U32(key),
            editable: false,
            constraints: SaveConstraint::default(),
            description: "Key used to mask money".into(),
            warnings: vec!["Read-only".into()],
            step: None,
            encoding: None,
        });
    }
    for (index, (section, offset, bit)) in badges.into_iter().enumerate() {
        fields.push(SaveField {
            id: format!("progress.badge_{}", index + 1),
            label: format!("Badge {}", index + 1),
            section_id: section,
            offset: offset as u16,
            kind: SaveFieldKind::BitfieldBoolean,
            value: SaveValue::Bool(section_data(bytes, active, section)[offset] & (1 << bit) != 0),
            editable,
            constraints: SaveConstraint::default(),
            description: "Gym badge flag".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        });
    }
    debug!(game = %identity.id, slot = active.slot, "parsed Pokémon Gen III save");
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
            issues: match redundancy {
                RedundancyState::Complete => Vec::new(),
                RedundancyState::EmptyBackup => vec![super::SaveIntegrityIssue {
                    code: "redundant_slot_empty".into(),
                    message: "The redundant save slot is empty".into(),
                    section_id: None,
                }],
                RedundancyState::DamagedBackup => vec![super::SaveIntegrityIssue {
                    code: "redundant_slot_invalid".into(),
                    message: "One redundant save slot failed integrity checks".into(),
                    section_id: None,
                }],
            },
        },
        sections: active.sections.clone(),
        fields,
        platform: "gba".into(),
        save_format: GBA_FLASH_128K.id.into(),
        save_format_name: GBA_FLASH_128K.display_name.into(),
        handler_id: "pokemon-gen3".into(),
        save_size: GEN3_SAVE_SIZE as u32,
        warnings: match redundancy {
            RedundancyState::Complete => Vec::new(),
            RedundancyState::EmptyBackup => {
                vec!["The redundant save slot is empty; the editor preserves it".into()]
            }
            RedundancyState::DamagedBackup => {
                vec!["One redundant save slot is invalid; normal editing is disabled".into()]
            }
        },
    })
}

fn text_field(
    id: &str,
    label: &str,
    section: u8,
    offset: u16,
    value: String,
    editable: bool,
    max_length: u8,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: section,
        offset,
        kind: SaveFieldKind::Text,
        value: SaveValue::Text(value),
        editable,
        constraints: SaveConstraint {
            max_length: Some(max_length),
            ..Default::default()
        },
        description: "English trainer text".into(),
        warnings: Vec::new(),
        step: None,
        encoding: Some("pokemon_gen3_english".into()),
    }
}

fn badge_offsets(family: Family) -> [(u8, usize, u8); 8] {
    // The SaveBlock1 flags offsets and badge constants come from the matching decompilation.
    // https://github.com/pret/pokeemerald/blob/master/include/constants/flags.h
    let (event_offset, badge_flag): (usize, usize) = match family {
        Family::Rs => (0x1220, 0x807),
        Family::Emerald => (0x1270, 0x867),
        Family::Frlg => (0xEE0, 0x820),
    };
    std::array::from_fn(|index| {
        let flag = badge_flag + index;
        let base = event_offset + flag / 8;
        (
            (base / SECTION_DATA_SIZE) as u8 + 1,
            base % SECTION_DATA_SIZE,
            (flag % 8) as u8,
        )
    })
}

fn decode_text(data: &[u8]) -> Result<String> {
    // This set matches every character on the English player naming keyboard.
    // https://github.com/pret/pokeemerald/blob/master/src/naming_screen.c
    let mut output = String::new();
    for byte in data.iter().copied() {
        if byte == 0xFF {
            break;
        }
        let character = match byte {
            0x00 => ' ',
            0xA1..=0xAA => (byte - 0xA1 + b'0') as char,
            0xBB..=0xD4 => (byte - 0xBB + b'A') as char,
            0xD5..=0xEE => (byte - 0xD5 + b'a') as char,
            0xAB => '!',
            0xAC => '?',
            0xAD => '.',
            0xAE => '-',
            0xB0 => '…',
            0xB1 => '“',
            0xB2 => '”',
            0xB3 => '‘',
            0xB4 => '’',
            0xB5 => '♂',
            0xB6 => '♀',
            0xB8 => ',',
            0xBA => '/',
            _ => {
                return Err(validation(
                    "save_text_codec",
                    "the save has unsupported trainer text",
                ));
            }
        };
        output.push(character);
    }
    Ok(output)
}

fn encode_text(value: &str) -> Result<[u8; 7]> {
    let mut output = [0x00; 7];
    if value.chars().count() > 7 {
        return Err(validation(
            "save_name_length",
            "the trainer name is longer than seven characters",
        ));
    }
    for (index, character) in value.chars().enumerate() {
        output[index] = match character {
            ' ' => 0x00,
            '0'..='9' => character as u8 - b'0' + 0xA1,
            'A'..='Z' => character as u8 - b'A' + 0xBB,
            'a'..='z' => character as u8 - b'a' + 0xD5,
            '!' => 0xAB,
            '?' => 0xAC,
            '.' => 0xAD,
            '-' => 0xAE,
            '…' => 0xB0,
            '“' => 0xB1,
            '”' => 0xB2,
            '‘' => 0xB3,
            '’' | '\'' => 0xB4,
            '♂' => 0xB5,
            '♀' => 0xB6,
            ',' => 0xB8,
            '/' => 0xBA,
            _ => {
                return Err(validation(
                    "save_text_codec",
                    "the trainer name uses unsupported text",
                ));
            }
        };
    }
    if value.chars().count() < 7 {
        output[value.chars().count()] = 0xFF;
    }
    Ok(output)
}

fn field_value<'a>(document: &'a SaveDocument, id: &str) -> Option<&'a SaveValue> {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| &field.value)
}

fn apply_to_active(
    bytes: &mut [u8],
    family: Family,
    active: &ParsedSlot,
    edits: &[SaveEdit],
) -> Result<()> {
    let key = match family {
        Family::Emerald => {
            let data = section_data(bytes, active, 0);
            u32::from_le_bytes([data[0xAC], data[0xAD], data[0xAE], data[0xAF]])
        }
        Family::Frlg => {
            let data = section_data(bytes, active, 0);
            u32::from_le_bytes([data[0xF20], data[0xF21], data[0xF22], data[0xF23]])
        }
        Family::Rs => 0,
    };
    let money_offset = match family {
        Family::Frlg => 0x290,
        _ => 0x490,
    };
    for edit in edits {
        match (edit.field.as_str(), &edit.value) {
            ("trainer.name", SaveValue::Text(value)) => {
                section_data_mut(bytes, active, 0)[..7].copy_from_slice(&encode_text(value)?)
            }
            ("trainer.gender", SaveValue::Enum(value)) => {
                section_data_mut(bytes, active, 0)[8] = match value.as_str() {
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
            ("trainer.money", SaveValue::U32(value)) => section_data_mut(bytes, active, 1)
                [money_offset..money_offset + 4]
                .copy_from_slice(&(*value ^ key).to_le_bytes()),
            (field, SaveValue::Bool(value)) if field.starts_with("progress.badge_") => {
                let index = field[15..]
                    .parse::<usize>()
                    .map_err(|_| {
                        validation("save_field_unknown", "the requested badge field is unknown")
                    })?
                    .checked_sub(1)
                    .ok_or_else(|| {
                        validation("save_field_unknown", "the requested badge field is unknown")
                    })?;
                let (section, offset, bit) =
                    badge_offsets(family).get(index).copied().ok_or_else(|| {
                        validation("save_field_unknown", "the requested badge field is unknown")
                    })?;
                let byte = &mut section_data_mut(bytes, active, section)[offset];
                if *value {
                    *byte |= 1 << bit;
                } else {
                    *byte &= !(1 << bit);
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

fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}
