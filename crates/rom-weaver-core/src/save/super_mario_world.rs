use tracing::{debug, trace};

use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityIssue, SaveIntegrityState, SaveRecognition,
    SaveRecognitionConfidence, SaveRecognitionOutcome, SaveRecognitionReason, SaveSection,
    SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

/// The original cartridge exposes 2 KiB of battery-backed SRAM.
pub const SUPER_MARIO_WORLD_SRAM_SIZE: usize = 0x800;
const FILE_SIZE: usize = 143;
const DATA_SIZE: usize = FILE_SIZE - 2;
const FILE_COUNT: usize = 3;
const BACKUP_OFFSET: usize = FILE_COUNT * FILE_SIZE;
const CHECKSUM_OFFSET: usize = DATA_SIZE;
const CHECKSUM_TARGET: u16 = 0x5A5A;

const LEVEL_FLAGS_OFFSET: usize = 0;
const LEVEL_FLAGS_LENGTH: usize = 96;
const EVENTS_OFFSET: usize = 96;
const EVENTS_LENGTH: usize = 15;
const SUBMAP_OFFSET: usize = 111;
const ANIMATION_OFFSET: usize = 113;
const POSITION_OFFSET: usize = 117;
const POSITION_POINTER_OFFSET: usize = 125;
const SWITCHES_OFFSET: usize = 133;
const EXIT_COUNT_OFFSET: usize = 140;

// The layout, checksum, backup behavior, and initialization values come from
// https://github.com/IsoFrieze/SMWDisX/blob/30643c7595a7d097d731de69476f8059c7cf98c3/rammap.asm
// and https://github.com/IsoFrieze/SMWDisX/blob/30643c7595a7d097d731de69476f8059c7cf98c3/bank_00.asm.

#[derive(Clone, Debug)]
struct ParsedSlot {
    slot: u8,
    primary_valid: bool,
    backup_valid: bool,
    primary_empty: bool,
    backup_empty: bool,
}

impl ParsedSlot {
    fn canonical_offset(&self) -> Option<usize> {
        self.primary_valid
            .then_some(primary_offset(self.slot))
            .or_else(|| self.backup_valid.then_some(backup_offset(self.slot)))
    }

    fn is_empty(&self) -> bool {
        self.primary_empty && self.backup_empty
    }

    fn is_recoverable(&self) -> bool {
        self.canonical_offset().is_some()
    }

    fn copies_differ(&self, bytes: &[u8]) -> bool {
        self.primary_valid
            && self.backup_valid
            && bytes[primary_offset(self.slot)..primary_offset(self.slot) + FILE_SIZE]
                != bytes[backup_offset(self.slot)..backup_offset(self.slot) + FILE_SIZE]
    }
}

/// Handles raw SNES SRAM for Super Mario World.
pub struct SuperMarioWorldHandler;

impl SuperMarioWorldHandler {
    /// Creates one initialized file and its exact backup in otherwise cleared SRAM.
    pub fn generate() -> Result<Vec<u8>> {
        let mut bytes = vec![0; SUPER_MARIO_WORLD_SRAM_SIZE];
        let data = &mut bytes[..FILE_SIZE];
        for (level, flags) in [
            (0x28, 0x03),
            (0x4D, 0x01),
            (0x52, 0x01),
            (0x53, 0x01),
            (0x5B, 0x08),
            (0x5C, 0x02),
            (0x57, 0x04),
            (0x30, 0x01),
        ] {
            data[level] = flags;
        }
        data[SUBMAP_OFFSET..SUBMAP_OFFSET + 2].fill(1);
        write_word(data, ANIMATION_OFFSET, 2);
        write_word(data, ANIMATION_OFFSET + 2, 2);
        for player in 0..2 {
            write_word(data, POSITION_OFFSET + player * 4, 0x68);
            write_word(data, POSITION_OFFSET + player * 4 + 2, 0x78);
            write_word(data, POSITION_POINTER_OFFSET + player * 4, 6);
            write_word(data, POSITION_POINTER_OFFSET + player * 4 + 2, 7);
        }
        repair_checksum(data);
        let initialized = data.to_vec();
        bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE].copy_from_slice(&initialized);
        let slots = parse_slots(&bytes)?;
        build_document(&bytes, &definition().identity, &slots)?;
        Ok(bytes)
    }
}

impl SaveGameHandler for SuperMarioWorldHandler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        vec![definition()]
    }

    fn supports_generation(&self, _game: &SaveGameIdentity) -> bool {
        true
    }

    fn generate(&self, game: &SaveGameIdentity) -> Result<Vec<u8>> {
        check_game(game)?;
        Self::generate()
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        if input
            .selected_game
            .as_deref()
            .is_some_and(|id| id != definition().identity.id)
        {
            return unsupported(vec![SaveRecognitionReason::UnsupportedLayout]);
        }
        let Ok(slots) = parse_slots(&input.bytes) else {
            return unsupported(vec![SaveRecognitionReason::WrongSize]);
        };
        if !slots.iter().any(ParsedSlot::is_recoverable) {
            return unsupported(vec![SaveRecognitionReason::ChecksumMismatch]);
        }
        let confidence = if slots
            .iter()
            .filter(|slot| !slot.is_empty())
            .all(|slot| slot.primary_valid && slot.backup_valid)
        {
            SaveRecognitionConfidence::High
        } else {
            SaveRecognitionConfidence::Medium
        };
        let reasons = vec![SaveRecognitionReason::ChecksumValid];
        let candidate = SaveGameCandidate {
            identity: definition().identity,
            confidence,
            reasons: reasons.clone(),
        };
        SaveRecognition {
            outcome: SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            candidates: vec![candidate],
            reasons,
        }
    }

    fn parse(&self, input: &SaveDetectionInput, game: &SaveGameIdentity) -> Result<SaveDocument> {
        check_game(game)?;
        let slots = parse_slots(&input.bytes)?;
        build_document(&input.bytes, game, &slots)
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        check_game(game)?;
        let slots = parse_slots(&input.bytes)?;
        if slots
            .iter()
            .any(|slot| !slot.is_empty() && !slot.is_recoverable())
        {
            return Err(validation(
                "save_integrity_partial",
                "normal edits need every nonempty Super Mario World slot to have a valid copy",
            ));
        }
        let document = build_document(&input.bytes, game, &slots)?;
        let preview = validate_save_edits(&document, edits)?;
        if !preview.changed {
            return Ok(SaveEditResult {
                preview,
                bytes: None,
                document,
            });
        }

        let mut copies: [Option<Vec<u8>>; FILE_COUNT] = std::array::from_fn(|slot| {
            slots[slot]
                .canonical_offset()
                .map(|offset| input.bytes[offset..offset + FILE_SIZE].to_vec())
        });
        let mut touched = [false; FILE_COUNT];
        for edit in edits {
            let (slot, field) = split_slot_field(&edit.field)?;
            let definition = document
                .fields
                .iter()
                .find(|candidate| candidate.id == edit.field)
                .expect("validated edit field exists");
            let data = copies[slot].as_deref_mut().ok_or_else(|| {
                validation("save_slot_invalid", "the requested slot has no valid copy")
            })?;
            apply_edit(data, field, definition, &edit.value)?;
            touched[slot] = true;
        }
        for slot in 0..FILE_COUNT {
            if !touched[slot] {
                continue;
            }
            repair_checksum(
                copies[slot]
                    .as_deref_mut()
                    .expect("validated edits target recoverable slots"),
            );
        }

        let mut bytes = input.bytes.clone();
        for slot in 0..FILE_COUNT {
            if !touched[slot] {
                continue;
            }
            let data = copies[slot]
                .as_deref()
                .expect("validated edits target recoverable slots");
            let primary = primary_offset(slot as u8);
            let backup = backup_offset(slot as u8);
            bytes[primary..primary + FILE_SIZE].copy_from_slice(data);
            bytes[backup..backup + FILE_SIZE].copy_from_slice(data);
        }

        let reparsed = build_document(&bytes, game, &parse_slots(&bytes)?)?;
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

fn definition() -> SaveGameDefinition {
    SaveGameDefinition {
        identity: SaveGameIdentity {
            id: "super-mario-world".into(),
            name: "Super Mario World".into(),
            family: "super-mario-world".into(),
        },
        platform: "snes".into(),
        save_format: "snes_sram_2k".into(),
        save_format_name: "Battery SRAM 2 KiB".into(),
        handler_id: "super-mario-world".into(),
        supported_save_sizes: vec![SUPER_MARIO_WORLD_SRAM_SIZE as u32],
        known_rom_sha1: Vec::new(),
        checksum_sizes: vec![FILE_SIZE as u16; FILE_COUNT],
    }
}

fn unsupported(reasons: Vec<SaveRecognitionReason>) -> SaveRecognition {
    SaveRecognition {
        outcome: SaveRecognitionOutcome::Unsupported {
            reasons: reasons.clone(),
        },
        candidates: Vec::new(),
        reasons,
    }
}

fn check_game(game: &SaveGameIdentity) -> Result<()> {
    (game.id == definition().identity.id)
        .then_some(())
        .ok_or_else(|| {
            validation(
                "save_game_unsupported",
                "the selected save game is unsupported",
            )
        })
}

fn parse_slots(bytes: &[u8]) -> Result<[ParsedSlot; FILE_COUNT]> {
    if bytes.len() != SUPER_MARIO_WORLD_SRAM_SIZE {
        return Err(validation(
            "save_wrong_size",
            "a Super Mario World save must be exactly 2 KiB",
        ));
    }
    let slots = std::array::from_fn(|slot| {
        let slot = slot as u8;
        let primary = &bytes[primary_offset(slot)..primary_offset(slot) + FILE_SIZE];
        let backup = &bytes[backup_offset(slot)..backup_offset(slot) + FILE_SIZE];
        ParsedSlot {
            slot,
            primary_valid: is_valid_copy(primary),
            backup_valid: is_valid_copy(backup),
            primary_empty: empty_copy(primary),
            backup_empty: empty_copy(backup),
        }
    });
    trace!("parsed Super Mario World SRAM slots");
    Ok(slots)
}

fn empty_copy(data: &[u8]) -> bool {
    data.iter().all(|byte| *byte == 0) || data.iter().all(|byte| *byte == 0xff)
}

fn primary_offset(slot: u8) -> usize {
    usize::from(slot) * FILE_SIZE
}

fn backup_offset(slot: u8) -> usize {
    BACKUP_OFFSET + primary_offset(slot)
}

fn is_valid_copy(data: &[u8]) -> bool {
    data.len() == FILE_SIZE && checksum_word(data) == CHECKSUM_TARGET
}

fn checksum_word(data: &[u8]) -> u16 {
    data[..DATA_SIZE]
        .iter()
        .fold(word_at(data, CHECKSUM_OFFSET), |sum, byte| {
            sum.wrapping_add(u16::from(*byte))
        })
}

fn required_checksum(data: &[u8]) -> u16 {
    data[..DATA_SIZE].iter().fold(CHECKSUM_TARGET, |sum, byte| {
        sum.wrapping_sub(u16::from(*byte))
    })
}

fn repair_checksum(data: &mut [u8]) {
    write_word(data, CHECKSUM_OFFSET, required_checksum(data));
}

fn word_at(data: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([data[offset], data[offset + 1]])
}

fn write_word(data: &mut [u8], offset: usize, value: u16) {
    data[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn build_document(
    bytes: &[u8],
    identity: &SaveGameIdentity,
    slots: &[ParsedSlot; FILE_COUNT],
) -> Result<SaveDocument> {
    if !slots.iter().any(ParsedSlot::is_recoverable) {
        return Err(validation(
            "save_integrity_invalid",
            "the save has no valid Super Mario World slot copy",
        ));
    }
    let mut fields = Vec::new();
    let mut sections = Vec::new();
    let mut issues = Vec::new();
    for slot in slots {
        if let Some(offset) = slot.canonical_offset() {
            let data = &bytes[offset..offset + FILE_SIZE];
            add_fields(&mut fields, slot.slot, data);
            sections.push(SaveSection {
                id: slot.slot,
                physical_offset: offset as u32,
                checksum_expected: word_at(data, CHECKSUM_OFFSET),
                checksum_actual: required_checksum(data),
                signature: 0,
                counter: u32::from(data[EXIT_COUNT_OFFSET]),
                valid: true,
            });
            if slot.primary_valid != slot.backup_valid {
                issues.push(SaveIntegrityIssue {
                    code: "duplicate_copy_invalid".into(),
                    message: format!("Slot {} has one invalid duplicate copy", slot.slot + 1),
                    section_id: Some(slot.slot),
                });
            }
            if slot.copies_differ(bytes) {
                issues.push(SaveIntegrityIssue {
                    code: "duplicate_copy_mismatch".into(),
                    message: format!(
                        "Slot {} duplicate copies differ; the primary copy is used",
                        slot.slot + 1
                    ),
                    section_id: Some(slot.slot),
                });
            }
        } else if !slot.is_empty() {
            issues.push(SaveIntegrityIssue {
                code: "slot_invalid".into(),
                message: format!("Slot {} has no valid copy", slot.slot + 1),
                section_id: Some(slot.slot),
            });
        }
    }
    let unrecoverable = slots
        .iter()
        .any(|slot| !slot.is_empty() && !slot.is_recoverable());
    if unrecoverable {
        for field in &mut fields {
            field.editable = false;
        }
    }
    let state = if unrecoverable {
        SaveIntegrityState::PartiallyRecoverable
    } else if issues.is_empty() {
        SaveIntegrityState::Valid
    } else {
        SaveIntegrityState::ValidWithWarnings
    };
    let warnings = if unrecoverable {
        vec!["Normal editing is disabled because one slot has no valid copy".into()]
    } else if issues.is_empty() {
        Vec::new()
    } else {
        vec!["An edit repairs both copies of its target slot".into()]
    };
    let active_slot = slots
        .iter()
        .find(|slot| slot.is_recoverable())
        .map_or(0, |slot| slot.slot);
    debug!(game = %identity.id, active_slot, "parsed Super Mario World save");
    Ok(SaveDocument {
        identity: identity.clone(),
        active_slot,
        counter: 0,
        integrity: SaveIntegrity { state, issues },
        sections,
        fields,
        platform: "snes".into(),
        save_format: "snes_sram_2k".into(),
        save_format_name: "Battery SRAM 2 KiB".into(),
        handler_id: "super-mario-world".into(),
        save_size: SUPER_MARIO_WORLD_SRAM_SIZE as u32,
        warnings,
    })
}

fn add_fields(fields: &mut Vec<SaveField>, slot: u8, data: &[u8]) {
    let prefix = format!("slot_{}", slot + 1);
    for level in 0..LEVEL_FLAGS_LENGTH {
        fields.push(unsigned_field(
            format!("{prefix}.levels.level_{level:02x}.flags"),
            format!("Level {level:02X} movement and completion flags"),
            slot,
            LEVEL_FLAGS_OFFSET + level,
            u32::from(data[LEVEL_FLAGS_OFFSET + level]),
            0xFF,
            "Overworld movement directions and level completion state",
        ));
    }
    for event in 0..EVENTS_LENGTH * 8 {
        let offset = EVENTS_OFFSET + event / 8;
        let mask = 0x80 >> (event % 8);
        fields.push(bit_field(
            format!("{prefix}.events.event_{event:03}"),
            format!("Overworld event {event}"),
            slot,
            offset,
            data[offset] & mask != 0,
            "Overworld event activation bit",
        ));
    }
    for player in 0..2 {
        let player_number = player + 1;
        fields.push(unsigned_field(
            format!("{prefix}.players.player_{player_number}.submap"),
            format!("Player {player_number} submap"),
            slot,
            SUBMAP_OFFSET + player,
            u32::from(data[SUBMAP_OFFSET + player]),
            0xFF,
            "Current overworld submap",
        ));
        fields.push(unsigned_field(
            format!("{prefix}.players.player_{player_number}.animation"),
            format!("Player {player_number} overworld animation"),
            slot,
            ANIMATION_OFFSET + player * 2,
            u32::from(word_at(data, ANIMATION_OFFSET + player * 2)),
            u32::from(u16::MAX),
            "Overworld animation state",
        ));
        for (name, label, base) in [
            ("x", "X position", POSITION_OFFSET),
            ("y", "Y position", POSITION_OFFSET + 2),
            ("x_tile", "X tile pointer", POSITION_POINTER_OFFSET),
            ("y_tile", "Y tile pointer", POSITION_POINTER_OFFSET + 2),
        ] {
            let offset = base + player * 4;
            fields.push(unsigned_field(
                format!("{prefix}.players.player_{player_number}.{name}"),
                format!("Player {player_number} {label}"),
                slot,
                offset,
                u32::from(word_at(data, offset)),
                u32::from(u16::MAX),
                "Overworld position state",
            ));
        }
    }
    for (index, name) in ["yellow", "green", "red", "blue"].iter().enumerate() {
        fields.push(boolean_field(
            format!("{prefix}.progress.switch_palaces.{name}"),
            format!("{} Switch Palace", title_case(name)),
            slot,
            SWITCHES_OFFSET + index,
            data[SWITCHES_OFFSET + index] != 0,
            "Switch Palace completion flag",
        ));
    }
    fields.push(unsigned_field(
        format!("{prefix}.progress.exits_completed"),
        "Exits completed".into(),
        slot,
        EXIT_COUNT_OFFSET,
        u32::from(data[EXIT_COUNT_OFFSET]),
        0xFF,
        "Exit count shown on the file-select screen",
    ));
}

fn unsigned_field(
    id: String,
    label: String,
    section_id: u8,
    offset: usize,
    value: u32,
    max: u32,
    description: &str,
) -> SaveField {
    SaveField {
        id,
        label,
        section_id,
        offset: offset as u16,
        kind: SaveFieldKind::UnsignedInteger,
        value: SaveValue::U32(value),
        editable: true,
        constraints: SaveConstraint {
            min: Some(0),
            max: Some(i64::from(max)),
            ..Default::default()
        },
        description: description.into(),
        warnings: Vec::new(),
        step: Some(1),
        encoding: None,
    }
}

fn bit_field(
    id: String,
    label: String,
    section_id: u8,
    offset: usize,
    value: bool,
    description: &str,
) -> SaveField {
    let mut field = boolean_field(id, label, section_id, offset, value, description);
    field.kind = SaveFieldKind::BitfieldBoolean;
    field
}

fn boolean_field(
    id: String,
    label: String,
    section_id: u8,
    offset: usize,
    value: bool,
    description: &str,
) -> SaveField {
    SaveField {
        id,
        label,
        section_id,
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

fn title_case(value: &str) -> String {
    let mut characters = value.chars();
    characters
        .next()
        .map(|first| first.to_uppercase().chain(characters).collect())
        .unwrap_or_default()
}

fn split_slot_field(id: &str) -> Result<(usize, &str)> {
    let Some(rest) = id.strip_prefix("slot_") else {
        return Err(validation(
            "save_field_unknown",
            "the requested save field is unknown",
        ));
    };
    let Some((slot, field)) = rest.split_once('.') else {
        return Err(validation(
            "save_field_unknown",
            "the requested save field is unknown",
        ));
    };
    let slot = slot
        .parse::<usize>()
        .ok()
        .and_then(|slot| slot.checked_sub(1))
        .filter(|slot| *slot < FILE_COUNT)
        .ok_or_else(|| validation("save_slot_invalid", "the requested slot is invalid"))?;
    Ok((slot, field))
}

fn apply_edit(
    data: &mut [u8],
    field: &str,
    definition: &SaveField,
    value: &SaveValue,
) -> Result<()> {
    let offset = usize::from(definition.offset);
    match (&definition.kind, value) {
        (SaveFieldKind::UnsignedInteger, SaveValue::U32(value)) => {
            if offset == ANIMATION_OFFSET
                || offset == ANIMATION_OFFSET + 2
                || (POSITION_OFFSET..POSITION_POINTER_OFFSET + 8).contains(&offset)
            {
                write_word(data, offset, *value as u16);
            } else {
                data[offset] = *value as u8;
            }
        }
        (SaveFieldKind::Boolean, SaveValue::Bool(value)) => data[offset] = u8::from(*value),
        (SaveFieldKind::BitfieldBoolean, SaveValue::Bool(value)) => {
            let event = field
                .strip_prefix("events.event_")
                .and_then(|value| value.parse::<usize>().ok())
                .ok_or_else(|| {
                    validation("save_field_unknown", "the requested event is invalid")
                })?;
            let mask = 0x80 >> (event % 8);
            if *value {
                data[offset] |= mask;
            } else {
                data[offset] &= !mask;
            }
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

fn field_value<'a>(document: &'a SaveDocument, id: &str) -> Option<&'a SaveValue> {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| &field.value)
}

fn validation(code: &'static str, message: &'static str) -> RomWeaverError {
    RomWeaverError::ValidationCode(ValidationCodeError::new(code).with_message(message))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> SaveGameIdentity {
        definition().identity
    }

    fn input(bytes: Vec<u8>) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes,
            selected_game: Some("super-mario-world".into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn generation_matches_the_original_initialization() {
        let bytes = SuperMarioWorldHandler::generate().unwrap();
        assert_eq!(bytes.len(), SUPER_MARIO_WORLD_SRAM_SIZE);
        let file = &bytes[..FILE_SIZE];
        assert_eq!(file[0x28], 0x03);
        assert_eq!(file[0x4D], 0x01);
        assert_eq!(&file[SUBMAP_OFFSET..SUBMAP_OFFSET + 2], &[1, 1]);
        assert_eq!(word_at(file, ANIMATION_OFFSET), 2);
        assert_eq!(word_at(file, POSITION_OFFSET), 0x68);
        assert_eq!(word_at(file, POSITION_OFFSET + 2), 0x78);
        assert_eq!(checksum_word(file), CHECKSUM_TARGET);
        assert_eq!(word_at(file, CHECKSUM_OFFSET), 0x5865);
        assert_eq!(file, &bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]);
        assert!(
            bytes[FILE_SIZE..BACKUP_OFFSET]
                .iter()
                .all(|byte| *byte == 0)
        );
        assert!(
            bytes[BACKUP_OFFSET + FILE_SIZE..]
                .iter()
                .all(|byte| *byte == 0)
        );
    }

    #[test]
    fn exposes_every_documented_persistent_byte() {
        let document = SuperMarioWorldHandler
            .parse(
                &input(SuperMarioWorldHandler::generate().unwrap()),
                &identity(),
            )
            .unwrap();
        assert_eq!(document.fields.len(), 96 + 120 + 2 * 6 + 4 + 1);
        assert!(document.fields.iter().any(|field| {
            field.id == "slot_1.players.player_2.y_tile" && field.value == SaveValue::U32(7)
        }));
        assert!(document.fields.iter().any(|field| {
            field.id == "slot_1.events.event_119" && field.value == SaveValue::Bool(false)
        }));
    }

    #[test]
    fn edits_full_ranges_repairs_both_copies_and_preserves_other_bytes() {
        let original = SuperMarioWorldHandler::generate().unwrap();
        let edits = vec![
            SaveEdit {
                field: "slot_1.levels.level_5f.flags".into(),
                value: SaveValue::U32(0xFF),
            },
            SaveEdit {
                field: "slot_1.events.event_119".into(),
                value: SaveValue::Bool(true),
            },
            SaveEdit {
                field: "slot_1.players.player_2.y".into(),
                value: SaveValue::U32(0xFFFF),
            },
            SaveEdit {
                field: "slot_1.progress.switch_palaces.blue".into(),
                value: SaveValue::Bool(true),
            },
            SaveEdit {
                field: "slot_1.progress.exits_completed".into(),
                value: SaveValue::U32(0xFF),
            },
        ];
        let result = SuperMarioWorldHandler
            .apply(&input(original.clone()), &identity(), &edits, false)
            .unwrap();
        let bytes = result.bytes.unwrap();
        assert_eq!(bytes[0x5F], 0xFF);
        assert_eq!(bytes[EVENTS_OFFSET + 14] & 0x01, 0x01);
        assert_eq!(word_at(&bytes, POSITION_OFFSET + 6), 0xFFFF);
        assert_eq!(bytes[SWITCHES_OFFSET + 3], 1);
        assert_eq!(bytes[EXIT_COUNT_OFFSET], 0xFF);
        assert_eq!(checksum_word(&bytes[..FILE_SIZE]), CHECKSUM_TARGET);
        assert_eq!(
            &bytes[..FILE_SIZE],
            &bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]
        );
        assert_eq!(
            &bytes[FILE_SIZE..BACKUP_OFFSET],
            &original[FILE_SIZE..BACKUP_OFFSET]
        );
        assert_eq!(
            &bytes[BACKUP_OFFSET + FILE_SIZE..],
            &original[BACKUP_OFFSET + FILE_SIZE..]
        );
    }

    #[test]
    fn dry_run_reports_changes_without_returning_bytes() {
        let bytes = SuperMarioWorldHandler::generate().unwrap();
        let result = SuperMarioWorldHandler
            .apply(
                &input(bytes),
                &identity(),
                &[SaveEdit {
                    field: "slot_1.progress.exits_completed".into(),
                    value: SaveValue::U32(1),
                }],
                true,
            )
            .unwrap();
        assert!(result.preview.changed);
        assert!(result.bytes.is_none());
        assert_eq!(
            field_value(&result.document, "slot_1.progress.exits_completed"),
            Some(&SaveValue::U32(1))
        );
    }

    #[test]
    fn uses_a_valid_backup_and_repairs_it_after_an_edit() {
        let mut bytes = SuperMarioWorldHandler::generate().unwrap();
        bytes[0] ^= 0x80;
        let document = SuperMarioWorldHandler
            .parse(&input(bytes.clone()), &identity())
            .unwrap();
        assert_eq!(
            document.integrity.state,
            SaveIntegrityState::ValidWithWarnings
        );
        let result = SuperMarioWorldHandler
            .apply(
                &input(bytes),
                &identity(),
                &[SaveEdit {
                    field: "slot_1.progress.exits_completed".into(),
                    value: SaveValue::U32(1),
                }],
                false,
            )
            .unwrap();
        let repaired = result.bytes.unwrap();
        assert_eq!(
            &repaired[..FILE_SIZE],
            &repaired[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]
        );
    }

    #[test]
    fn rejects_a_nonempty_slot_when_both_copies_are_corrupt() {
        let mut bytes = SuperMarioWorldHandler::generate().unwrap();
        bytes[FILE_SIZE] = 1;
        bytes[BACKUP_OFFSET + FILE_SIZE] = 1;
        let document = SuperMarioWorldHandler
            .parse(&input(bytes.clone()), &identity())
            .unwrap();
        assert_eq!(
            document.integrity.state,
            SaveIntegrityState::PartiallyRecoverable
        );
        assert!(document.fields.iter().all(|field| !field.editable));
        assert!(
            SuperMarioWorldHandler
                .apply(
                    &input(bytes),
                    &identity(),
                    &[SaveEdit {
                        field: "slot_1.progress.exits_completed".into(),
                        value: SaveValue::U32(1),
                    }],
                    false,
                )
                .is_err()
        );
    }

    #[test]
    fn edits_each_slot_and_accepts_erased_unused_slots() {
        let fresh = SuperMarioWorldHandler::generate().unwrap();
        for slot in 0..FILE_COUNT {
            let mut bytes = vec![0xff; SUPER_MARIO_WORLD_SRAM_SIZE];
            let primary = slot * FILE_SIZE;
            let backup = BACKUP_OFFSET + primary;
            bytes[primary..primary + FILE_SIZE].copy_from_slice(&fresh[..FILE_SIZE]);
            bytes[backup..backup + FILE_SIZE].copy_from_slice(&fresh[..FILE_SIZE]);
            let field = format!("slot_{}.events.event_000", slot + 1);
            let source = input(bytes.clone());
            let result = SuperMarioWorldHandler
                .apply(
                    &source,
                    &identity(),
                    &[SaveEdit {
                        field,
                        value: SaveValue::Bool(true),
                    }],
                    false,
                )
                .unwrap();
            let output = result.bytes.unwrap();
            assert_eq!(output[primary + EVENTS_OFFSET], 0x80);
            assert_eq!(
                &output[primary..primary + FILE_SIZE],
                &output[backup..backup + FILE_SIZE]
            );
            for offset in 0..SUPER_MARIO_WORLD_SRAM_SIZE {
                if !(primary..primary + FILE_SIZE).contains(&offset)
                    && !(backup..backup + FILE_SIZE).contains(&offset)
                {
                    assert_eq!(output[offset], bytes[offset]);
                }
            }
        }
    }

    #[test]
    fn rejects_blank_wrong_size_wrong_game_and_out_of_range_values() {
        for bytes in [
            vec![0; SUPER_MARIO_WORLD_SRAM_SIZE],
            vec![0xff; SUPER_MARIO_WORLD_SRAM_SIZE],
            vec![0; 100],
        ] {
            assert!(matches!(
                SuperMarioWorldHandler.recognize(&input(bytes)).outcome,
                SaveRecognitionOutcome::Unsupported { .. }
            ));
        }
        let mut source = input(SuperMarioWorldHandler::generate().unwrap());
        for (field, value) in [
            ("slot_1.levels.level_00.flags", 256),
            ("slot_1.players.player_1.x", 65536),
        ] {
            assert!(
                SuperMarioWorldHandler
                    .apply(
                        &source,
                        &identity(),
                        &[SaveEdit {
                            field: field.into(),
                            value: SaveValue::U32(value)
                        }],
                        false
                    )
                    .is_err()
            );
        }
        source.selected_game = Some("pokemon-red".into());
        assert!(matches!(
            SuperMarioWorldHandler.recognize(&source).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
    }
}
