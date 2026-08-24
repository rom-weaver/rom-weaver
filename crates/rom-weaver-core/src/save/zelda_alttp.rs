use tracing::{debug, trace};

use super::formats::SNES_SRAM_8K;
use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityIssue, SaveIntegrityState, SaveRecognition,
    SaveRecognitionConfidence, SaveRecognitionOutcome, SaveRecognitionReason, SaveSection,
    SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

/// The native SNES cartridge save is 8 KiB of battery-backed SRAM.
pub const ALTT_P_SRAM_SIZE: usize = 0x2000;
const FILE_SIZE: usize = 0x500;
const FILE_COUNT: usize = 3;
const BACKUP_OFFSET: usize = 0xF00;
const CHECKSUM_OFFSET: usize = 0x4FE;
const CHECKSUM_TARGET: u16 = 0x5A5A;
const FILE_MARKER_OFFSET: usize = 0x3E5;
const FILE_MARKER: u16 = 0x55AA;
const NAME_OFFSET: usize = 0x3D9;
const NAME_LENGTH: usize = 6;

const ITEM_FIELDS: &[(&str, &str, usize)] = &[
    ("hookshot", "Hookshot", 0x342),
    ("fire_rod", "Fire Rod", 0x345),
    ("ice_rod", "Ice Rod", 0x346),
    ("bombos", "Bombos", 0x347),
    ("ether", "Ether", 0x348),
    ("quake", "Quake", 0x349),
    ("lantern", "Lantern", 0x34A),
    ("hammer", "Hammer", 0x34B),
    ("bug_net", "Bug-Catching Net", 0x34D),
    ("book_of_mudora", "Book of Mudora", 0x34E),
    ("cane_of_somaria", "Cane of Somaria", 0x350),
    ("cane_of_byrna", "Cane of Byrna", 0x351),
    ("cape", "Magic Cape", 0x352),
    ("pegasus_boots", "Pegasus Boots", 0x355),
    ("flippers", "Zora's Flippers", 0x356),
    ("moon_pearl", "Moon Pearl", 0x357),
];

#[derive(Clone, Debug)]
struct ParsedFile {
    slot: u8,
    primary_valid: bool,
    backup_valid: bool,
    primary_empty: bool,
    backup_empty: bool,
}

impl ParsedFile {
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

/// Handles the original SNES battery SRAM for The Legend of Zelda: A Link to the Past.
pub struct ZeldaAlttpHandler;

impl SaveGameHandler for ZeldaAlttpHandler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        vec![definition()]
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        if input
            .selected_game
            .as_deref()
            .is_some_and(|id| id != definition().identity.id)
        {
            return unsupported(vec![SaveRecognitionReason::UnsupportedLayout]);
        }
        let Ok(files) = parse_files(&input.bytes) else {
            return unsupported(vec![SaveRecognitionReason::WrongSize]);
        };
        if !files.iter().any(ParsedFile::is_recoverable) {
            return unsupported(vec![SaveRecognitionReason::UnsupportedLayout]);
        }
        let confidence = if files
            .iter()
            .filter(|file| !file.is_empty())
            .all(|file| file.primary_valid && file.backup_valid)
        {
            SaveRecognitionConfidence::High
        } else {
            SaveRecognitionConfidence::Medium
        };
        let mut reasons = vec![SaveRecognitionReason::ChecksumValid];
        if files
            .iter()
            .any(|file| file.primary_valid && file.backup_valid)
        {
            reasons.push(SaveRecognitionReason::SignatureValid);
        }
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
        let files = parse_files(&input.bytes)?;
        build_document(&input.bytes, game, &files)
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        check_game(game)?;
        let files = parse_files(&input.bytes)?;
        if has_unrecoverable_file(&files) {
            return Err(validation(
                "save_integrity_partial",
                "normal edits need every nonempty Zelda file to have one valid copy",
            ));
        }
        let document = build_document(&input.bytes, game, &files)?;
        if document.integrity.state == SaveIntegrityState::Invalid {
            return Err(validation(
                "save_integrity_invalid",
                "normal edits need every exposed Zelda value to be in the original game range",
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

        let mut copies: [Option<Vec<u8>>; FILE_COUNT] = std::array::from_fn(|slot| {
            files[slot]
                .canonical_offset()
                .map(|offset| input.bytes[offset..offset + FILE_SIZE].to_vec())
        });
        let mut touched = [false; FILE_COUNT];
        for edit in edits {
            let (slot, field) = split_slot_field(&edit.field)?;
            let data = copies[slot].as_deref_mut().ok_or_else(|| {
                validation("save_slot_invalid", "the requested file has no valid copy")
            })?;
            apply_edit(data, field, &edit.value)?;
            touched[slot] = true;
        }
        for slot in 0..FILE_COUNT {
            if !touched[slot] {
                continue;
            }
            let data = copies[slot]
                .as_deref_mut()
                .expect("validated edits always target a recoverable file");
            validate_file_values(data)?;
            repair_checksum(data);
        }

        let mut bytes = input.bytes.clone();
        for slot in 0..FILE_COUNT {
            if !touched[slot] {
                continue;
            }
            let data = copies[slot]
                .as_deref()
                .expect("validated edits always target a recoverable file");
            let primary = primary_offset(slot as u8);
            let backup = backup_offset(slot as u8);
            // Nintendo's save routine writes the complete canonical file to both copies.
            // https://github.com/snesrev/zelda3/blob/master/src/messaging.c
            bytes[primary..primary + FILE_SIZE].copy_from_slice(data);
            bytes[backup..backup + FILE_SIZE].copy_from_slice(data);
        }

        let reparsed_files = parse_files(&bytes)?;
        let reparsed = build_document(&bytes, game, &reparsed_files)?;
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
            id: "zelda-a-link-to-the-past".into(),
            name: "The Legend of Zelda: A Link to the Past".into(),
            family: "zelda-alttp".into(),
        },
        platform: "snes".into(),
        save_format: "snes_sram_8k".into(),
        save_format_name: "Battery SRAM 8 KiB".into(),
        handler_id: "zelda-alttp".into(),
        supported_save_sizes: SNES_SRAM_8K
            .supported_sizes
            .iter()
            .map(|size| *size as u32)
            .collect(),
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

fn parse_files(bytes: &[u8]) -> Result<[ParsedFile; FILE_COUNT]> {
    if bytes.len() != ALTT_P_SRAM_SIZE {
        return Err(validation(
            "save_wrong_size",
            "a Zelda: A Link to the Past save must be exactly 8 KiB",
        ));
    }
    let files = std::array::from_fn(|slot| {
        let slot = slot as u8;
        let primary = &bytes[primary_offset(slot)..primary_offset(slot) + FILE_SIZE];
        let backup = &bytes[backup_offset(slot)..backup_offset(slot) + FILE_SIZE];
        ParsedFile {
            slot,
            primary_valid: is_valid_copy(primary),
            backup_valid: is_valid_copy(backup),
            primary_empty: primary.iter().all(|byte| *byte == 0),
            backup_empty: backup.iter().all(|byte| *byte == 0),
        }
    });
    trace!("parsed Zelda: A Link to the Past SRAM files");
    Ok(files)
}

fn has_unrecoverable_file(files: &[ParsedFile; FILE_COUNT]) -> bool {
    files
        .iter()
        .any(|file| !file.is_empty() && !file.is_recoverable())
}

fn primary_offset(slot: u8) -> usize {
    usize::from(slot) * FILE_SIZE
}

fn backup_offset(slot: u8) -> usize {
    BACKUP_OFFSET + primary_offset(slot)
}

fn is_valid_copy(data: &[u8]) -> bool {
    data.len() == FILE_SIZE
        && word_at(data, FILE_MARKER_OFFSET) == FILE_MARKER
        && checksum_word(data) == CHECKSUM_TARGET
}

fn checksum_word(data: &[u8]) -> u16 {
    data.chunks_exact(2).fold(0u16, |sum, word| {
        sum.wrapping_add(u16::from_le_bytes([word[0], word[1]]))
    })
}

fn required_checksum(data: &[u8]) -> u16 {
    data[..CHECKSUM_OFFSET]
        .chunks_exact(2)
        .fold(CHECKSUM_TARGET, |sum, word| {
            sum.wrapping_sub(u16::from_le_bytes([word[0], word[1]]))
        })
}

fn repair_checksum(data: &mut [u8]) {
    let checksum = required_checksum(data);
    data[CHECKSUM_OFFSET..CHECKSUM_OFFSET + 2].copy_from_slice(&checksum.to_le_bytes());
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
    files: &[ParsedFile; FILE_COUNT],
) -> Result<SaveDocument> {
    if !files.iter().any(ParsedFile::is_recoverable) {
        return Err(validation(
            "save_integrity_invalid",
            "the save has no valid Zelda file copy",
        ));
    }
    let mut fields = Vec::new();
    let mut sections = Vec::new();
    let mut issues = Vec::new();
    let mut warnings = Vec::new();
    let mut invalid_values = false;
    for file in files {
        let section_id = file.slot;
        if let Some(offset) = file.canonical_offset() {
            let data = &bytes[offset..offset + FILE_SIZE];
            add_fields(&mut fields, section_id, data);
            if validate_file_values(data).is_err() {
                invalid_values = true;
                issues.push(SaveIntegrityIssue {
                    code: "exposed_value_invalid".into(),
                    message: format!(
                        "File {} has a value outside the original game range",
                        section_id + 1
                    ),
                    section_id: Some(section_id),
                });
            }
            sections.push(SaveSection {
                id: section_id,
                physical_offset: offset as u32,
                checksum_expected: word_at(data, CHECKSUM_OFFSET),
                checksum_actual: required_checksum(data),
                signature: u32::from(FILE_MARKER),
                counter: 0,
                valid: true,
            });
            if file.primary_valid != file.backup_valid {
                issues.push(SaveIntegrityIssue {
                    code: "duplicate_copy_invalid".into(),
                    message: format!("File {} has one invalid duplicate copy", section_id + 1),
                    section_id: Some(section_id),
                });
            }
            if file.copies_differ(bytes) {
                issues.push(SaveIntegrityIssue {
                    code: "duplicate_copy_mismatch".into(),
                    message: format!(
                        "File {} duplicate copies differ; the primary copy is used",
                        section_id + 1
                    ),
                    section_id: Some(section_id),
                });
            }
        } else if !file.is_empty() {
            issues.push(SaveIntegrityIssue {
                code: "file_invalid".into(),
                message: format!("File {} has no valid copy", section_id + 1),
                section_id: Some(section_id),
            });
        }
    }
    let unrecoverable = has_unrecoverable_file(files);
    if unrecoverable || invalid_values {
        for field in &mut fields {
            field.editable = false;
        }
    }
    if invalid_values {
        warnings.push("Normal editing is disabled because one file has an invalid value".into());
    } else if unrecoverable {
        warnings.push("Normal editing is disabled because one file has no valid copy".into());
    } else if !issues.is_empty() {
        warnings.push("An edit repairs both copies of its target file".into());
    }
    let state = if invalid_values {
        SaveIntegrityState::Invalid
    } else if unrecoverable {
        SaveIntegrityState::PartiallyRecoverable
    } else if issues.is_empty() {
        SaveIntegrityState::Valid
    } else {
        SaveIntegrityState::ValidWithWarnings
    };
    let active_slot = files
        .iter()
        .find(|file| file.is_recoverable())
        .map_or(0, |file| file.slot);
    debug!(game = %identity.id, active_slot, "parsed Zelda: A Link to the Past save");
    Ok(SaveDocument {
        identity: identity.clone(),
        active_slot,
        counter: 0,
        integrity: SaveIntegrity { state, issues },
        sections,
        fields,
        platform: "snes".into(),
        save_format: "snes_sram_8k".into(),
        save_format_name: "Battery SRAM 8 KiB".into(),
        handler_id: "zelda-alttp".into(),
        save_size: ALTT_P_SRAM_SIZE as u32,
        warnings,
    })
}

fn add_fields(fields: &mut Vec<SaveField>, slot: u8, data: &[u8]) {
    let prefix = format!("slot_{}", slot + 1);
    fields.push(SaveField {
        id: format!("{prefix}.player.name"),
        label: format!("File {} player name", slot + 1),
        section_id: slot,
        offset: NAME_OFFSET as u16,
        kind: SaveFieldKind::ReadOnlyText,
        value: SaveValue::Text(decode_name(data)),
        editable: false,
        constraints: SaveConstraint {
            max_length: Some(NAME_LENGTH as u8),
            ..Default::default()
        },
        description: "Player name from the original English naming screen".into(),
        warnings: Vec::new(),
        step: None,
        encoding: Some("zelda_alttp_english_name".into()),
    });
    fields.push(unsigned_field(
        &format!("{prefix}.resources.rupees"),
        "Rupees",
        slot,
        0x360,
        u32::from(word_at(data, 0x362)),
        999,
        "Rupees shown by the HUD",
    ));
    fields.push(unsigned_field(
        &format!("{prefix}.resources.bombs"),
        "Bombs",
        slot,
        0x343,
        u32::from(data[0x343]),
        50,
        "Bombs carried by the player",
    ));
    fields.push(unsigned_field(
        &format!("{prefix}.resources.arrows"),
        "Arrows",
        slot,
        0x377,
        u32::from(data[0x377]),
        70,
        "Arrows carried by the player",
    ));
    let mut capacity = unsigned_field(
        &format!("{prefix}.hearts.capacity_eighths"),
        "Heart capacity (eighths)",
        slot,
        0x36C,
        u32::from(data[0x36C]),
        160,
        "Maximum health. Eight units equal one heart.",
    );
    capacity.constraints.min = Some(24);
    capacity.step = Some(8);
    fields.push(capacity);
    fields.push(unsigned_field(
        &format!("{prefix}.hearts.current_eighths"),
        "Current health (eighths)",
        slot,
        0x36D,
        u32::from(data[0x36D]),
        160,
        "Current health. Eight units equal one heart.",
    ));
    fields.extend([
        sword_field(&format!("{prefix}.equipment.sword"), slot, data[0x359]),
        enum_field(
            &format!("{prefix}.equipment.shield"),
            "Shield",
            slot,
            0x35A,
            data[0x35A],
            &["none", "fighter", "red", "mirror"],
            "Shield level",
        ),
        enum_field(
            &format!("{prefix}.equipment.armor"),
            "Armor",
            slot,
            0x35B,
            data[0x35B],
            &["green", "blue", "red"],
            "Tunic color and defense level",
        ),
        enum_field(
            &format!("{prefix}.equipment.gloves"),
            "Gloves",
            slot,
            0x354,
            data[0x354],
            &["none", "power", "titan"],
            "Strength glove level",
        ),
    ]);
    for (name, label, offset) in ITEM_FIELDS {
        fields.push(boolean_field(
            &format!("{prefix}.inventory.{name}"),
            label,
            slot,
            *offset,
            data[*offset] != 0,
            "Inventory item",
        ));
    }
    for bit in 0..3u8 {
        fields.push(boolean_field(
            &format!("{prefix}.progress.pendant_{}", bit + 1),
            &format!("Pendant {}", bit + 1),
            slot,
            0x374,
            data[0x374] & (1 << bit) != 0,
            "Progress bit from the pendant state byte",
        ));
    }
    for bit in 0..7u8 {
        fields.push(boolean_field(
            &format!("{prefix}.progress.crystal_{}", bit + 1),
            &format!("Crystal {}", bit + 1),
            slot,
            0x37A,
            data[0x37A] & (1 << bit) != 0,
            "Progress bit from the crystal state byte",
        ));
    }
}

fn unsigned_field(
    id: &str,
    label: &str,
    section_id: u8,
    offset: usize,
    value: u32,
    max: u32,
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
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

fn enum_field(
    id: &str,
    label: &str,
    section_id: u8,
    offset: usize,
    value: u8,
    choices: &[&str],
    description: &str,
) -> SaveField {
    let value = choices
        .get(usize::from(value))
        .copied()
        .unwrap_or("unknown");
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id,
        offset: offset as u16,
        kind: SaveFieldKind::Enum,
        value: SaveValue::Enum(value.into()),
        editable: value != "unknown",
        constraints: SaveConstraint {
            choices: choices.iter().map(|choice| (*choice).into()).collect(),
            ..Default::default()
        },
        description: description.into(),
        warnings: (value == "unknown")
            .then_some("The stored value is outside the original game range".into())
            .into_iter()
            .collect(),
        step: None,
        encoding: None,
    }
}

fn sword_field(id: &str, section_id: u8, value: u8) -> SaveField {
    if value != 0xff {
        return enum_field(
            id,
            "Sword",
            section_id,
            0x359,
            value,
            &["none", "fighter", "master", "tempered", "golden"],
            "Sword level",
        );
    }
    SaveField {
        id: id.into(),
        label: "Sword".into(),
        section_id,
        offset: 0x359,
        kind: SaveFieldKind::Enum,
        value: SaveValue::Enum("tempering".into()),
        editable: false,
        constraints: SaveConstraint {
            choices: vec![
                "none".into(),
                "fighter".into(),
                "master".into(),
                "tempered".into(),
                "golden".into(),
            ],
            ..Default::default()
        },
        description: "The smiths temporarily hold the sword".into(),
        warnings: vec!["Finish the in-game tempering event before you edit this field".into()],
        step: None,
        encoding: None,
    }
}

fn boolean_field(
    id: &str,
    label: &str,
    section_id: u8,
    offset: usize,
    value: bool,
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id,
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

fn decode_name(data: &[u8]) -> String {
    let mut name = String::new();
    for index in 0..NAME_LENGTH {
        let word = word_at(data, NAME_OFFSET + index * 2);
        let character = (word & 0x000F) as u8 | ((word >> 1) & 0x00F0) as u8;
        if character == 0x59 {
            continue;
        }
        let decoded = match character {
            0x00..=0x19 => char::from(b'A' + character),
            0x1A..=0x33 => char::from(b'a' + character - 0x1A),
            0x5F => ' ',
            _ => '\u{FFFD}',
        };
        name.push(decoded);
    }
    name
}

fn split_slot_field(field: &str) -> Result<(usize, &str)> {
    let (slot, field) = field
        .split_once('.')
        .ok_or_else(|| validation("save_field_unknown", "the requested save field is unknown"))?;
    let slot = slot
        .strip_prefix("slot_")
        .and_then(|value| value.parse::<usize>().ok())
        .and_then(|value| value.checked_sub(1))
        .filter(|slot| *slot < FILE_COUNT)
        .ok_or_else(|| validation("save_field_unknown", "the requested save field is unknown"))?;
    Ok((slot, field))
}

fn apply_edit(data: &mut [u8], field: &str, value: &SaveValue) -> Result<()> {
    match (field, value) {
        ("resources.rupees", SaveValue::U32(value)) => {
            let value = u16::try_from(*value)
                .map_err(|_| validation("save_value_range", "the rupee value is out of range"))?;
            write_word(data, 0x360, value);
            write_word(data, 0x362, value);
        }
        ("resources.bombs", SaveValue::U32(value)) => {
            data[0x343] = u8::try_from(*value)
                .map_err(|_| validation("save_value_range", "the bomb value is out of range"))?
        }
        ("resources.arrows", SaveValue::U32(value)) => {
            data[0x377] = u8::try_from(*value)
                .map_err(|_| validation("save_value_range", "the arrow value is out of range"))?
        }
        ("hearts.capacity_eighths", SaveValue::U32(value)) => {
            data[0x36C] = u8::try_from(*value)
                .map_err(|_| validation("save_value_range", "the heart capacity is out of range"))?
        }
        ("hearts.current_eighths", SaveValue::U32(value)) => {
            data[0x36D] = u8::try_from(*value)
                .map_err(|_| validation("save_value_range", "the current health is out of range"))?
        }
        ("equipment.sword", SaveValue::Enum(value)) => {
            data[0x359] = enum_index(value, &["none", "fighter", "master", "tempered", "golden"])?
        }
        ("equipment.shield", SaveValue::Enum(value)) => {
            data[0x35A] = enum_index(value, &["none", "fighter", "red", "mirror"])?
        }
        ("equipment.armor", SaveValue::Enum(value)) => {
            data[0x35B] = enum_index(value, &["green", "blue", "red"])?
        }
        ("equipment.gloves", SaveValue::Enum(value)) => {
            data[0x354] = enum_index(value, &["none", "power", "titan"])?
        }
        (field, SaveValue::Bool(value)) => {
            if let Some((_, _, offset)) = ITEM_FIELDS
                .iter()
                .find(|(name, _, _)| field == format!("inventory.{name}"))
            {
                data[*offset] = u8::from(*value);
            } else if let Some(bit) = field
                .strip_prefix("progress.pendant_")
                .and_then(|value| value.parse::<u8>().ok())
                .and_then(|value| value.checked_sub(1))
                .filter(|bit| *bit < 3)
            {
                set_bit(&mut data[0x374], bit, *value);
            } else if let Some(bit) = field
                .strip_prefix("progress.crystal_")
                .and_then(|value| value.parse::<u8>().ok())
                .and_then(|value| value.checked_sub(1))
                .filter(|bit| *bit < 7)
            {
                set_bit(&mut data[0x37A], bit, *value);
            } else {
                return Err(validation(
                    "save_field_unknown",
                    "the requested save field is unknown",
                ));
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

fn enum_index(value: &str, choices: &[&str]) -> Result<u8> {
    choices
        .iter()
        .position(|choice| *choice == value)
        .map(|index| index as u8)
        .ok_or_else(|| validation("save_value_choice", "the requested value is not allowed"))
}

fn set_bit(byte: &mut u8, bit: u8, value: bool) {
    if value {
        *byte |= 1 << bit;
    } else {
        *byte &= !(1 << bit);
    }
}

fn validate_file_values(data: &[u8]) -> Result<()> {
    if word_at(data, 0x360) > 999 || word_at(data, 0x362) > 999 {
        return Err(validation(
            "save_rupees",
            "the rupee value is above the original game limit",
        ));
    }
    if data[0x343] > 50 {
        return Err(validation(
            "save_bombs",
            "the bomb value is above the original game limit",
        ));
    }
    if data[0x377] > 70 {
        return Err(validation(
            "save_arrows",
            "the arrow value is above the original game limit",
        ));
    }
    if !(24..=160).contains(&data[0x36C]) || !data[0x36C].is_multiple_of(8) {
        return Err(validation(
            "save_heart_capacity",
            "heart capacity must be from three through twenty whole hearts",
        ));
    }
    if data[0x36D] > data[0x36C] {
        return Err(validation(
            "save_current_health",
            "current health cannot exceed heart capacity",
        ));
    }
    let sword_tempering = data[0x359] == 0xff;
    let tempering_flag = data[0x3C9] & 0x80 != 0;
    if (data[0x359] > 4 && !sword_tempering) || sword_tempering != tempering_flag {
        return Err(validation(
            "save_equipment",
            "the sword and smith progress values are inconsistent",
        ));
    }
    for (offset, choice_count) in [(0x35A, 4), (0x35B, 3), (0x354, 3)] {
        if usize::from(data[offset]) >= choice_count {
            return Err(validation(
                "save_equipment",
                "an equipment value is outside the original game range",
            ));
        }
    }
    if ITEM_FIELDS.iter().any(|(_, _, offset)| data[*offset] > 1) {
        return Err(validation(
            "save_inventory",
            "an inventory flag is outside the original game range",
        ));
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

    fn fixture() -> Vec<u8> {
        let mut bytes = vec![0; ALTT_P_SRAM_SIZE];
        for slot in 0..FILE_COUNT as u8 {
            let offset = primary_offset(slot);
            {
                let data = &mut bytes[offset..offset + FILE_SIZE];
                write_word(data, FILE_MARKER_OFFSET, FILE_MARKER);
                for (index, letter) in b"LINK".iter().copied().enumerate() {
                    let code = letter - b'A';
                    write_word(data, NAME_OFFSET + index * 2, code as u16);
                }
                for index in 4..NAME_LENGTH {
                    write_word(data, NAME_OFFSET + index * 2, 0x00A9);
                }
                write_word(data, 0x360, 123);
                write_word(data, 0x362, 123);
                data[0x343] = 10;
                data[0x377] = 30;
                data[0x36C] = 24;
                data[0x36D] = 24;
                data[0x359] = 1;
                repair_checksum(data);
            }
            let backup = backup_offset(slot);
            let copy = bytes[offset..offset + FILE_SIZE].to_vec();
            bytes[backup..backup + FILE_SIZE].copy_from_slice(&copy);
        }
        bytes
    }

    fn input(bytes: Vec<u8>) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes,
            selected_game: Some(definition().identity.id),
            rom_sha1: None,
        }
    }

    #[test]
    fn parses_three_valid_files_and_decodes_english_names() {
        let document = ZeldaAlttpHandler
            .parse(&input(fixture()), &definition().identity)
            .unwrap();
        assert_eq!(document.sections.len(), 3);
        assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
        assert_eq!(
            field_value(&document, "slot_1.player.name"),
            Some(&SaveValue::Text("LINK".into()))
        );
        assert_eq!(
            field_value(&document, "slot_1.resources.rupees"),
            Some(&SaveValue::U32(123))
        );
    }

    #[test]
    fn edits_both_copies_and_repairs_the_checksum() {
        let original = fixture();
        let result = ZeldaAlttpHandler
            .apply(
                &input(original.clone()),
                &definition().identity,
                &[
                    SaveEdit {
                        field: "slot_2.resources.rupees".into(),
                        value: SaveValue::U32(999),
                    },
                    SaveEdit {
                        field: "slot_2.progress.crystal_7".into(),
                        value: SaveValue::Bool(true),
                    },
                ],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        let primary = primary_offset(1);
        let backup = backup_offset(1);
        assert_eq!(
            &bytes[primary..primary + FILE_SIZE],
            &bytes[backup..backup + FILE_SIZE]
        );
        assert!(is_valid_copy(&bytes[primary..primary + FILE_SIZE]));
        assert_eq!(
            field_value(&result.document, "slot_2.resources.rupees"),
            Some(&SaveValue::U32(999))
        );
        assert_eq!(&bytes[..FILE_SIZE], &original[..FILE_SIZE]);
    }

    #[test]
    fn repairs_a_file_from_its_valid_backup_when_an_edit_targets_it() {
        let mut bytes = fixture();
        bytes[primary_offset(0) + 0x343] ^= 1;
        let result = ZeldaAlttpHandler
            .apply(
                &input(bytes),
                &definition().identity,
                &[SaveEdit {
                    field: "slot_1.resources.bombs".into(),
                    value: SaveValue::U32(12),
                }],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        assert_eq!(
            &bytes[primary_offset(0)..primary_offset(0) + FILE_SIZE],
            &bytes[backup_offset(0)..backup_offset(0) + FILE_SIZE]
        );
        assert!(is_valid_copy(
            &bytes[primary_offset(0)..primary_offset(0) + FILE_SIZE]
        ));
    }

    #[test]
    fn rejects_invalid_heart_combinations_without_writing() {
        let error = ZeldaAlttpHandler
            .apply(
                &input(fixture()),
                &definition().identity,
                &[SaveEdit {
                    field: "slot_1.hearts.current_eighths".into(),
                    value: SaveValue::U32(25),
                }],
                false,
            )
            .unwrap_err();
        match error {
            RomWeaverError::ValidationCode(error) => {
                assert_eq!(error.code(), "save_current_health")
            }
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn rejects_all_edits_when_another_file_has_no_valid_copy() {
        let mut bytes = fixture();
        bytes[primary_offset(2) + 0x343] ^= 1;
        bytes[backup_offset(2) + 0x343] ^= 1;
        let input = input(bytes);
        let document = ZeldaAlttpHandler
            .parse(&input, &definition().identity)
            .unwrap();
        assert_eq!(
            document.integrity.state,
            SaveIntegrityState::PartiallyRecoverable
        );
        assert!(document.fields.iter().all(|field| !field.editable));
        assert!(
            ZeldaAlttpHandler
                .apply(
                    &input,
                    &definition().identity,
                    &[SaveEdit {
                        field: "slot_1.resources.rupees".into(),
                        value: SaveValue::U32(999),
                    }],
                    false,
                )
                .is_err()
        );
    }

    #[test]
    fn rejects_unrelated_edits_when_an_exposed_value_is_invalid() {
        let mut bytes = fixture();
        for offset in [primary_offset(1), backup_offset(1)] {
            bytes[offset + 0x355] = 2;
            repair_checksum(&mut bytes[offset..offset + FILE_SIZE]);
        }
        let input = input(bytes);
        let document = ZeldaAlttpHandler
            .parse(&input, &definition().identity)
            .unwrap();
        assert_eq!(document.integrity.state, SaveIntegrityState::Invalid);
        assert!(document.fields.iter().all(|field| !field.editable));
        assert!(
            ZeldaAlttpHandler
                .apply(
                    &input,
                    &definition().identity,
                    &[SaveEdit {
                        field: "slot_1.resources.rupees".into(),
                        value: SaveValue::U32(999),
                    }],
                    false,
                )
                .is_err()
        );
    }

    #[test]
    fn preserves_the_temporarily_removed_sword_during_other_edits() {
        let mut bytes = fixture();
        for offset in [primary_offset(0), backup_offset(0)] {
            bytes[offset + 0x359] = 0xff;
            bytes[offset + 0x3C9] |= 0x80;
            repair_checksum(&mut bytes[offset..offset + FILE_SIZE]);
        }
        let input = input(bytes);
        let document = ZeldaAlttpHandler
            .parse(&input, &definition().identity)
            .unwrap();
        let sword = document
            .fields
            .iter()
            .find(|field| field.id == "slot_1.equipment.sword")
            .unwrap();
        assert_eq!(sword.value, SaveValue::Enum("tempering".into()));
        assert!(!sword.editable);

        let output = ZeldaAlttpHandler
            .apply(
                &input,
                &definition().identity,
                &[SaveEdit {
                    field: "slot_1.resources.rupees".into(),
                    value: SaveValue::U32(999),
                }],
                false,
            )
            .unwrap()
            .bytes
            .unwrap();
        for offset in [primary_offset(0), backup_offset(0)] {
            assert_eq!(output[offset + 0x359], 0xff);
            assert_eq!(output[offset + 0x3C9] & 0x80, 0x80);
        }
    }

    #[test]
    fn rejects_a_smith_flag_without_the_temporarily_removed_sword() {
        let mut bytes = fixture();
        for offset in [primary_offset(0), backup_offset(0)] {
            bytes[offset + 0x3C9] |= 0x80;
            repair_checksum(&mut bytes[offset..offset + FILE_SIZE]);
        }
        let document = ZeldaAlttpHandler
            .parse(&input(bytes), &definition().identity)
            .unwrap();
        assert_eq!(document.integrity.state, SaveIntegrityState::Invalid);
        assert!(document.fields.iter().all(|field| !field.editable));
    }
}
