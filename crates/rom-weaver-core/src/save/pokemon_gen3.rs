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
const MAX_COINS: u32 = 9_999;
const MAX_BATTLE_POINTS: u32 = 9_999;
const MAX_MONEY: u32 = 999_999;

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

    fn supports_generation(&self, _game: &SaveGameIdentity) -> bool {
        true
    }

    fn generate(&self, game: &SaveGameIdentity) -> Result<Vec<u8>> {
        generate_save(family_for_game(game)?)
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

fn generate_save(family: Family) -> Result<Vec<u8>> {
    let mut bytes = vec![0xFF; GEN3_SAVE_SIZE];
    for (slot, counter) in [(0u8, 0u32), (1u8, 1u32)] {
        let base = usize::from(slot) * SLOT_SIZE;
        for id in 0..14u8 {
            // The games rotate section positions on each save. Keeping the same
            // rotation as the counter exercises the physical layout used on hardware.
            let physical = (usize::from(id) + counter as usize) % 14;
            let offset = base + physical * SECTION_SIZE;
            let data = &mut bytes[offset..offset + SECTION_SIZE];
            data[..0xFF4].fill(0);
            if id == 0 {
                data[..7].copy_from_slice(&encode_text("PLAYER")?);
            }
            let checksum_value = checksum(&data[..family.checksum_size(id)]);
            data[0xFF4..0xFF6].copy_from_slice(&u16::from(id).to_le_bytes());
            data[0xFF6..0xFF8].copy_from_slice(&checksum_value.to_le_bytes());
            data[0xFF8..0xFFC].copy_from_slice(&SIGNATURE.to_le_bytes());
            data[0xFFC..].copy_from_slice(&counter.to_le_bytes());
        }
    }

    let active = parse_slot(&bytes, 1, family)?;
    let identity = family.all_definitions().remove(0).identity;
    build_document(
        &bytes,
        family,
        &identity,
        &active,
        RedundancyState::Complete,
    )?;
    Ok(bytes)
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
    if money > MAX_MONEY {
        return Err(validation(
            "save_money",
            "the save has a money value above the game limit",
        ));
    }
    let coin_offset = match family {
        Family::Frlg => 0x294,
        _ => 0x494,
    };
    let coins = u32::from(u16::from_le_bytes([
        large[coin_offset],
        large[coin_offset + 1],
    ])) ^ security_key.unwrap_or(0) as u16 as u32;
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
                max: Some(i64::from(MAX_MONEY)),
                ..Default::default()
            },
            description: "Money carried by the player".into(),
            warnings: Vec::new(),
            step: Some(1),
            encoding: None,
        },
        scalar_field(
            "trainer.coins",
            "Coins",
            (1, coin_offset),
            SaveValue::U32(coins),
            editable,
            (0, MAX_COINS),
            "Game Corner coins",
        ),
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
    append_play_time_fields(&mut fields, small, editable)?;
    append_option_fields(&mut fields, small, editable)?;
    append_inventory_fields(&mut fields, family, &large, security_key, editable)?;
    if matches!(family, Family::Emerald) {
        let battle_points = u16::from_le_bytes([small[0xEB8], small[0xEB9]]) as u32;
        if battle_points > MAX_BATTLE_POINTS {
            return Err(validation(
                "save_battle_points",
                "the save has battle points above the game limit",
            ));
        }
        fields.push(scalar_field(
            "progress.battle_points",
            "Battle Points",
            (0, 0xEB8),
            SaveValue::U32(battle_points),
            editable,
            (0, MAX_BATTLE_POINTS),
            "Battle Frontier points",
        ));
    }
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
            label: badge_label(family, index),
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

/// Badge flag order follows FLAG_BADGE01_GET..FLAG_BADGE08_GET in each decompilation.
/// https://github.com/pret/pokeemerald/blob/master/include/constants/flags.h
/// https://github.com/pret/pokefirered/blob/master/include/constants/flags.h
const HOENN_BADGE_NAMES: [&str; 8] = [
    "Stone", "Knuckle", "Dynamo", "Heat", "Balance", "Feather", "Mind", "Rain",
];
const KANTO_BADGE_NAMES: [&str; 8] = [
    "Boulder", "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth",
];

fn badge_label(family: Family, index: usize) -> String {
    let names = match family {
        Family::Rs | Family::Emerald => HOENN_BADGE_NAMES,
        Family::Frlg => KANTO_BADGE_NAMES,
    };
    format!("{} Badge", names[index])
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

fn scalar_field(
    id: &str,
    label: &str,
    location: (u8, usize),
    value: SaveValue,
    editable: bool,
    range: (u32, u32),
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: location.0,
        offset: location.1 as u16,
        kind: SaveFieldKind::UnsignedInteger,
        value,
        editable,
        constraints: SaveConstraint {
            min: Some(i64::from(range.0)),
            max: Some(i64::from(range.1)),
            ..Default::default()
        },
        description: description.into(),
        warnings: Vec::new(),
        step: Some(1),
        encoding: None,
    }
}

fn append_play_time_fields(
    fields: &mut Vec<SaveField>,
    small: &[u8],
    editable: bool,
) -> Result<()> {
    let hours = u16::from_le_bytes([small[14], small[15]]) as u32;
    let minutes = u32::from(small[16]);
    let seconds = u32::from(small[17]);
    if minutes > 59 || seconds > 59 {
        return Err(validation(
            "save_play_time",
            "the save has an invalid play-time minute or second value",
        ));
    }
    fields.push(scalar_field(
        "trainer.play_time_hours",
        "Play time hours",
        (0, 14),
        SaveValue::U32(hours),
        editable,
        (0, u32::from(u16::MAX)),
        "Hours played",
    ));
    fields.push(scalar_field(
        "trainer.play_time_minutes",
        "Play time minutes",
        (0, 16),
        SaveValue::U32(minutes),
        editable,
        (0, 59),
        "Minutes in the current hour",
    ));
    fields.push(scalar_field(
        "trainer.play_time_seconds",
        "Play time seconds",
        (0, 17),
        SaveValue::U32(seconds),
        editable,
        (0, 59),
        "Seconds in the current minute",
    ));
    Ok(())
}

fn append_option_fields(fields: &mut Vec<SaveField>, small: &[u8], editable: bool) -> Result<()> {
    let config = u16::from_le_bytes([small[0x14], small[0x15]]);
    let text_speed = u32::from(config & 0x7);
    let window_frame = u32::from((config >> 3) & 0x1f);
    let sound = (config >> 8) & 1;
    let battle_style = (config >> 9) & 1;
    let battle_scene_off = (config >> 10) & 1;
    let map_zoom = (config >> 11) & 1;
    if text_speed > 2 || window_frame >= 20 || small[0x13] > 2 {
        return Err(validation(
            "save_options",
            "the save has an invalid Generation III option value",
        ));
    }
    fields.push(enum_field(
        "options.button_mode",
        "Button mode",
        0x13,
        match small[0x13] {
            0 => "help",
            1 => "lr",
            _ => "l_equals_a",
        },
        editable,
        &["help", "lr", "l_equals_a"],
        "A-button and shoulder-button behavior",
    ));
    fields.push(scalar_field(
        "options.text_speed",
        "Text speed",
        (0, 0x14),
        SaveValue::U32(text_speed),
        editable,
        (0, 2),
        "Text speed: 0 slow, 1 medium, 2 fast",
    ));
    fields.push(scalar_field(
        "options.window_frame",
        "Window frame",
        (0, 0x14),
        SaveValue::U32(window_frame),
        editable,
        (0, 19),
        "Text window frame type",
    ));
    fields.push(enum_field(
        "options.sound",
        "Sound",
        0x14,
        if sound == 0 { "mono" } else { "stereo" },
        editable,
        &["mono", "stereo"],
        "Sound output mode",
    ));
    fields.push(enum_field(
        "options.battle_style",
        "Battle style",
        0x14,
        if battle_style == 0 { "shift" } else { "set" },
        editable,
        &["shift", "set"],
        "Whether the game offers a switch after a foe faints",
    ));
    fields.push(enum_field(
        "options.battle_scene",
        "Battle scene",
        0x14,
        if battle_scene_off == 0 { "on" } else { "off" },
        editable,
        &["on", "off"],
        "Battle animation mode",
    ));
    fields.push(SaveField {
        id: "options.region_map_zoom".into(),
        label: "Region map zoom".into(),
        section_id: 0,
        offset: 0x14,
        kind: SaveFieldKind::Boolean,
        value: SaveValue::Bool(map_zoom != 0),
        editable,
        constraints: SaveConstraint::default(),
        description: "Region map zoom state".into(),
        warnings: Vec::new(),
        step: None,
        encoding: None,
    });
    Ok(())
}

fn enum_field(
    id: &str,
    label: &str,
    offset: usize,
    value: &str,
    editable: bool,
    choices: &[&str],
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
            choices: choices.iter().map(|choice| (*choice).into()).collect(),
            ..Default::default()
        },
        description: description.into(),
        warnings: Vec::new(),
        step: None,
        encoding: None,
    }
}

fn append_inventory_fields(
    fields: &mut Vec<SaveField>,
    family: Family,
    large: &[u8],
    security_key: Option<u32>,
    editable: bool,
) -> Result<()> {
    let pockets = inventory_pockets(family);
    let key = security_key.unwrap_or(0) as u16;
    for (pocket, base, count, max) in pockets {
        for index in 0..*count {
            let offset = base + index * 4 + 2;
            let item_id = u16::from_le_bytes([large[offset - 2], large[offset - 1]]);
            if item_id == 0 {
                continue;
            }
            let raw = u16::from_le_bytes([large[offset], large[offset + 1]]);
            let quantity = u32::from(raw ^ key);
            if quantity == 0 || quantity > *max {
                return Err(validation(
                    "save_inventory_quantity",
                    "an occupied inventory slot has an invalid quantity",
                ));
            }
            fields.push(scalar_field(
                &format!("inventory.{pocket}_{}.quantity", index + 1),
                &format!("{} slot {} quantity", pocket.replace('_', " "), index + 1),
                (1, offset),
                SaveValue::U32(quantity),
                editable,
                (1, *max),
                &format!("Quantity of item ID {item_id}. The item ID stays unchanged."),
            ));
        }
    }
    Ok(())
}

fn inventory_pockets(family: Family) -> &'static [(&'static str, usize, usize, u32)] {
    match family {
        Family::Rs => &[
            ("items", 0x560, 20, 99),
            ("key_items", 0x5b0, 20, 1),
            ("balls", 0x600, 16, 99),
            ("tm_hm", 0x640, 64, 99),
            ("berries", 0x740, 46, 999),
        ],
        Family::Emerald => &[
            ("items", 0x560, 30, 99),
            ("key_items", 0x5d8, 30, 1),
            ("balls", 0x650, 16, 99),
            ("tm_hm", 0x690, 64, 99),
            ("berries", 0x790, 46, 999),
        ],
        Family::Frlg => &[
            ("items", 0x310, 42, 999),
            ("key_items", 0x3b8, 30, 1),
            ("balls", 0x430, 13, 999),
            ("tm_hm", 0x464, 58, 999),
            ("berries", 0x54c, 43, 999),
        ],
    }
}

fn inventory_location(family: Family, field: &str) -> Option<(usize, u32)> {
    let remainder = field.strip_prefix("inventory.")?;
    let (pocket, slot) = remainder.rsplit_once("_")?;
    let slot = slot.strip_suffix(".quantity")?.parse::<usize>().ok()?;
    inventory_pockets(family)
        .iter()
        .find(|(name, _, count, _)| *name == pocket && (1..=*count).contains(&slot))
        .map(|(_, base, _, max)| (base + (slot - 1) * 4 + 2, *max))
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
    let coin_offset = match family {
        Family::Frlg => 0x294,
        _ => 0x494,
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
            ("trainer.coins", SaveValue::U32(value)) => section_data_mut(bytes, active, 1)
                [coin_offset..coin_offset + 2]
                .copy_from_slice(&((*value as u16 ^ key as u16).to_le_bytes())),
            ("trainer.play_time_hours", SaveValue::U32(value)) => {
                section_data_mut(bytes, active, 0)[14..16]
                    .copy_from_slice(&(*value as u16).to_le_bytes())
            }
            ("trainer.play_time_minutes", SaveValue::U32(value)) => {
                section_data_mut(bytes, active, 0)[16] = *value as u8
            }
            ("trainer.play_time_seconds", SaveValue::U32(value)) => {
                section_data_mut(bytes, active, 0)[17] = *value as u8
            }
            ("progress.battle_points", SaveValue::U32(value)) => section_data_mut(bytes, active, 0)
                [0xEB8..0xEBA]
                .copy_from_slice(&(*value as u16).to_le_bytes()),
            ("options.button_mode", SaveValue::Enum(value)) => {
                section_data_mut(bytes, active, 0)[0x13] = match value.as_str() {
                    "help" => 0,
                    "lr" => 1,
                    "l_equals_a" => 2,
                    _ => {
                        return Err(validation(
                            "save_value_choice",
                            "the requested button mode is not allowed",
                        ));
                    }
                }
            }
            ("options.text_speed", SaveValue::U32(value)) => {
                update_options_config(section_data_mut(bytes, active, 0), 0x7, 0, *value)?
            }
            ("options.window_frame", SaveValue::U32(value)) => {
                update_options_config(section_data_mut(bytes, active, 0), 0x1f, 3, *value)?
            }
            ("options.sound", SaveValue::Enum(value)) => {
                let bit = match value.as_str() {
                    "mono" => 0,
                    "stereo" => 1,
                    _ => {
                        return Err(validation(
                            "save_value_choice",
                            "the requested sound mode is not allowed",
                        ));
                    }
                };
                update_options_config(section_data_mut(bytes, active, 0), 1, 8, bit)?;
            }
            ("options.battle_style", SaveValue::Enum(value)) => {
                let bit = match value.as_str() {
                    "shift" => 0,
                    "set" => 1,
                    _ => {
                        return Err(validation(
                            "save_value_choice",
                            "the requested battle style is not allowed",
                        ));
                    }
                };
                update_options_config(section_data_mut(bytes, active, 0), 1, 9, bit)?;
            }
            ("options.battle_scene", SaveValue::Enum(value)) => {
                let bit = match value.as_str() {
                    "on" => 0,
                    "off" => 1,
                    _ => {
                        return Err(validation(
                            "save_value_choice",
                            "the requested battle scene mode is not allowed",
                        ));
                    }
                };
                update_options_config(section_data_mut(bytes, active, 0), 1, 10, bit)?;
            }
            ("options.region_map_zoom", SaveValue::Bool(value)) => {
                update_options_config(section_data_mut(bytes, active, 0), 1, 11, u32::from(*value))?
            }
            (field, SaveValue::U32(value)) if field.starts_with("inventory.") => {
                let (offset, max) = inventory_location(family, field).ok_or_else(|| {
                    validation(
                        "save_field_unknown",
                        "the requested inventory field is unknown",
                    )
                })?;
                if *value > max {
                    return Err(validation(
                        "save_value_range",
                        "the requested item quantity is outside its allowed range",
                    ));
                }
                section_data_mut(bytes, active, 1)[offset..offset + 2]
                    .copy_from_slice(&((*value as u16 ^ key as u16).to_le_bytes()));
            }
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

fn update_options_config(data: &mut [u8], mask: u16, shift: u8, value: u32) -> Result<()> {
    if value > u32::from(mask) {
        return Err(validation(
            "save_value_range",
            "the requested option value is outside its allowed range",
        ));
    }
    let mut config = u16::from_le_bytes([data[0x14], data[0x15]]);
    config = (config & !(mask << shift)) | ((value as u16 & mask) << shift);
    data[0x14..0x16].copy_from_slice(&config.to_le_bytes());
    Ok(())
}

fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(family: Family) -> Vec<u8> {
        let mut bytes = vec![0u8; GEN3_SAVE_SIZE];
        for slot in 0..2u8 {
            let base = usize::from(slot) * SLOT_SIZE;
            for id in 0..14u8 {
                let offset = base + usize::from(id) * SECTION_SIZE;
                let data = &mut bytes[offset..offset + SECTION_SIZE];
                data.fill(0);
                if id == 0 {
                    data[0x14..0x18].copy_from_slice(&0u32.to_le_bytes());
                    if family == Family::Emerald {
                        data[0xAC..0xB0].copy_from_slice(&0x1020_3040u32.to_le_bytes());
                        data[0xEB8..0xEBA].copy_from_slice(&7u16.to_le_bytes());
                    } else if family == Family::Frlg {
                        data[0xF20..0xF24].copy_from_slice(&0x1020_3040u32.to_le_bytes());
                    }
                }
                if id == 1 {
                    let key = if family == Family::Rs {
                        0u32
                    } else {
                        0x1020_3040u32
                    };
                    let money_offset = if family == Family::Frlg { 0x290 } else { 0x490 };
                    data[money_offset..money_offset + 4]
                        .copy_from_slice(&(100u32 ^ key).to_le_bytes());
                    let coin_offset = if family == Family::Frlg { 0x294 } else { 0x494 };
                    data[coin_offset..coin_offset + 2]
                        .copy_from_slice(&(7u16 ^ key as u16).to_le_bytes());
                    let item_offset = match family {
                        Family::Rs | Family::Emerald => 0x560,
                        Family::Frlg => 0x310,
                    };
                    data[item_offset..item_offset + 2].copy_from_slice(&13u16.to_le_bytes());
                    data[item_offset + 2..item_offset + 4]
                        .copy_from_slice(&(4u16 ^ key as u16).to_le_bytes());
                }
                let checksum_value = checksum(&data[..family.checksum_size(id)]);
                data[0xFF4..0xFF6].copy_from_slice(&u16::from(id).to_le_bytes());
                data[0xFF6..0xFF8].copy_from_slice(&checksum_value.to_le_bytes());
                data[0xff8..0xffc].copy_from_slice(&SIGNATURE.to_le_bytes());
                let counter: u32 = if slot == 0 { 10 } else { 11 };
                data[0xffc..].copy_from_slice(&counter.to_le_bytes());
            }
        }
        bytes
    }

    fn identity(family: Family) -> SaveGameIdentity {
        match family {
            Family::Rs => Family::Rs.identity("pokemon-ruby"),
            Family::Emerald => Family::Emerald.identity("pokemon-emerald"),
            Family::Frlg => Family::Frlg.identity("pokemon-firered"),
        }
    }

    #[test]
    fn generates_parseable_rotated_slots_for_every_registered_game() {
        let handler = PokemonGen3Handler;

        for definition in handler.definitions() {
            assert!(handler.supports_generation(&definition.identity));
            let family = family_for_game(&definition.identity).unwrap();
            let bytes = handler.generate(&definition.identity).unwrap();
            assert_eq!(bytes.len(), GEN3_SAVE_SIZE);
            assert!(bytes[2 * SLOT_SIZE..].iter().all(|byte| *byte == 0xFF));

            let first = parse_slot(&bytes, 0, family).unwrap();
            let second = parse_slot(&bytes, 1, family).unwrap();
            assert_eq!(first.counter, 0);
            assert_eq!(second.counter, 1);
            assert_eq!(first.positions[0], 0);
            assert_eq!(second.positions[0], SLOT_SIZE + SECTION_SIZE);
            assert_eq!(second.positions[13], SLOT_SIZE);

            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(definition.identity.id.clone()),
                rom_sha1: None,
            };
            let document = handler.parse(&input, &definition.identity).unwrap();
            assert_eq!(document.identity, definition.identity);
            assert_eq!(document.active_slot, 1);
            assert_eq!(document.counter, 1);
            assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
            assert_eq!(
                field_value(&document, "trainer.name"),
                Some(&SaveValue::Text("PLAYER".into()))
            );
            assert!(matches!(
                handler.recognize(&input).outcome,
                SaveRecognitionOutcome::Recognized { .. }
            ));
        }
    }

    #[test]
    fn rejects_generation_for_an_unregistered_game() {
        let unknown = SaveGameIdentity {
            id: "pokemon-platinum".into(),
            name: "Pokémon Platinum".into(),
            family: "pokemon-gen4".into(),
        };
        assert!(PokemonGen3Handler.generate(&unknown).is_err());
    }

    #[test]
    fn edits_currency_options_time_and_inventory_without_touching_backup() {
        for family in [Family::Rs, Family::Emerald, Family::Frlg] {
            let input_bytes = fixture(family);
            let input = SaveDetectionInput {
                bytes: input_bytes.clone(),
                selected_game: Some(identity(family).id.clone()),
                rom_sha1: None,
            };
            let result = PokemonGen3Handler
                .apply(
                    &input,
                    &identity(family),
                    &[
                        SaveEdit {
                            field: "trainer.coins".into(),
                            value: SaveValue::U32(9999),
                        },
                        SaveEdit {
                            field: "trainer.play_time_hours".into(),
                            value: SaveValue::U32(123),
                        },
                        SaveEdit {
                            field: "options.text_speed".into(),
                            value: SaveValue::U32(2),
                        },
                        SaveEdit {
                            field: "options.sound".into(),
                            value: SaveValue::Enum("stereo".into()),
                        },
                        SaveEdit {
                            field: "inventory.items_1.quantity".into(),
                            value: SaveValue::U32(9),
                        },
                    ],
                    false,
                )
                .unwrap();
            let output = result.bytes.unwrap();
            assert_eq!(result.document.active_slot, 1);
            assert_eq!(&output[..SLOT_SIZE], &input_bytes[..SLOT_SIZE]);
            assert_eq!(output[SLOT_SIZE + 0x14] & 7, 2);
            let inventory_offset = if family == Family::Frlg { 0x310 } else { 0x560 };
            let inventory = SLOT_SIZE + SECTION_SIZE + inventory_offset;
            assert_eq!(&output[inventory..inventory + 2], &13u16.to_le_bytes());
            let expected_quantity = 9u16 ^ if family == Family::Rs { 0 } else { 0x3040 };
            assert_eq!(
                &output[inventory + 2..inventory + 4],
                &expected_quantity.to_le_bytes()
            );
            assert_eq!(
                &output[SLOT_SIZE + SECTION_SIZE..SLOT_SIZE + SECTION_SIZE + 0x290],
                &input_bytes[SLOT_SIZE + SECTION_SIZE..SLOT_SIZE + SECTION_SIZE + 0x290]
            );
            let coin_offset = if family == Family::Frlg { 0x294 } else { 0x494 };
            assert_ne!(
                output[SLOT_SIZE + SECTION_SIZE + coin_offset],
                input_bytes[SLOT_SIZE + SECTION_SIZE + coin_offset],
                "coin byte did not change for {family:?}"
            );
            assert_eq!(
                field_value(&result.document, "trainer.coins"),
                Some(&SaveValue::U32(9999))
            );
            assert_eq!(
                field_value(&result.document, "inventory.items_1.quantity"),
                Some(&SaveValue::U32(9))
            );
        }
    }

    #[test]
    fn emerald_battle_points_and_encrypted_values_reparse() {
        let bytes = fixture(Family::Emerald);
        let game = identity(Family::Emerald);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(game.id.clone()),
            rom_sha1: None,
        };
        let result = PokemonGen3Handler
            .apply(
                &input,
                &game,
                &[SaveEdit {
                    field: "progress.battle_points".into(),
                    value: SaveValue::U32(9999),
                }],
                false,
            )
            .unwrap();
        assert_eq!(
            field_value(&result.document, "progress.battle_points"),
            Some(&SaveValue::U32(9999))
        );
    }

    #[test]
    fn rejects_invalid_option_and_quantity_values() {
        let bytes = fixture(Family::Rs);
        let game = identity(Family::Rs);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(game.id.clone()),
            rom_sha1: None,
        };
        let error = PokemonGen3Handler.apply(
            &input,
            &game,
            &[SaveEdit {
                field: "options.text_speed".into(),
                value: SaveValue::U32(3),
            }],
            false,
        );
        assert!(error.is_err());
        let error = PokemonGen3Handler.apply(
            &input,
            &game,
            &[SaveEdit {
                field: "inventory.key_items_1.quantity".into(),
                value: SaveValue::U32(2),
            }],
            false,
        );
        assert!(error.is_err());
    }

    #[test]
    fn reads_out_of_range_coins_but_rejects_writing_them() {
        let mut bytes = fixture(Family::Emerald);
        let active_section = SLOT_SIZE + SECTION_SIZE;
        bytes[active_section + 0x494..active_section + 0x496].copy_from_slice(&0u16.to_le_bytes());
        recompute_checksum(&mut bytes, active_section, Family::Emerald.checksum_size(1));
        let game = identity(Family::Emerald);
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some(game.id.clone()),
            rom_sha1: None,
        };

        let document = PokemonGen3Handler.parse(&input, &game).unwrap();
        assert_eq!(
            field_value(&document, "trainer.coins"),
            Some(&SaveValue::U32(0x3040))
        );
        PokemonGen3Handler
            .apply(
                &input,
                &game,
                &[SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(500),
                }],
                true,
            )
            .unwrap();
        assert!(
            PokemonGen3Handler
                .apply(
                    &input,
                    &game,
                    &[SaveEdit {
                        field: "trainer.coins".into(),
                        value: SaveValue::U32(MAX_COINS + 1),
                    }],
                    true,
                )
                .is_err()
        );
    }
}
