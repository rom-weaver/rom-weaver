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
const DIED_COUNTER_OFFSET: usize = 0x405;
const NAME_OFFSET: usize = 0x3D9;
const NAME_LENGTH: usize = 6;

// The SRAM symbols and value tables come from the JP1.0 disassembly at
// https://github.com/spannerisms/jpdasm/blob/d078addd79e888c0d048fe5250d2c665ccf61628/symbols_sram.asm.
// The US reimplementation independently confirms the 0x340 save-RAM mapping
// and duplicate-copy/checksum flow:
// https://github.com/snesrev/zelda3/blob/fbbb3f967a51fafe642e6140d0753979e73b4090/src/select_file.c.

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

const ITEM_ENUM_FIELDS: &[(&str, &str, usize, &[&str], &str)] = &[
    (
        "bow",
        "Bow",
        0x340,
        &[
            "none",
            "bow",
            "bow_and_arrows",
            "silver_bow",
            "silver_bow_and_arrows",
        ],
        "Bow and silver-arrow upgrade state",
    ),
    (
        "boomerang",
        "Boomerang",
        0x341,
        &["none", "blue", "red"],
        "Boomerang upgrade state",
    ),
    (
        "mushroom_powder",
        "Mushroom or magic powder",
        0x344,
        &["none", "mushroom", "powder"],
        "Mushroom and magic powder state",
    ),
    (
        "flute",
        "Flute",
        0x34C,
        &["none", "shovel", "inactive", "active"],
        "Shovel and flute state",
    ),
    (
        "mirror",
        "Magic mirror",
        0x353,
        &["none", "letter", "mirror", "scrapped_triforce"],
        "Magic mirror item state",
    ),
];

const BOTTLE_CHOICES: &[&str] = &[
    "none",
    "mushroom",
    "empty",
    "red_potion",
    "green_potion",
    "blue_potion",
    "fairy",
    "bee",
    "good_bee",
];

const DUNGEONS: &[(&str, &str)] = &[
    ("sewers", "Sewers"),
    ("hyrule_castle", "Hyrule Castle"),
    ("eastern_palace", "Eastern Palace"),
    ("desert_palace", "Desert Palace"),
    ("agahnims_tower", "Agahnim's Tower"),
    ("swamp_palace", "Swamp Palace"),
    ("palace_of_darkness", "Palace of Darkness"),
    ("misery_mire", "Misery Mire"),
    ("skull_woods", "Skull Woods"),
    ("ice_palace", "Ice Palace"),
    ("tower_of_hera", "Tower of Hera"),
    ("thieves_town", "Thieves' Town"),
    ("turtle_rock", "Turtle Rock"),
    ("ganons_tower", "Ganon's Tower"),
];

const DUNGEON_KEY_OFFSETS: &[usize] = &[
    0x37C, 0x37D, 0x37E, 0x37F, 0x380, 0x381, 0x382, 0x383, 0x384, 0x385, 0x386, 0x387, 0x388,
    0x389,
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

impl ZeldaAlttpHandler {
    /// Creates the exact fresh-file image initialized by the original naming screen.
    pub fn generate() -> Result<Vec<u8>> {
        let mut bytes = vec![0; ALTT_P_SRAM_SIZE];
        let data = &mut bytes[..FILE_SIZE];
        write_word(data, FILE_MARKER_OFFSET, FILE_MARKER);
        write_word(data, 0x20C, 0xF000);
        write_word(data, 0x20E, 0xF000);
        write_word(data, DIED_COUNTER_OFFSET, 0xFFFF);
        data[0x36C] = 0x18;
        data[0x36D] = 0x18;
        data[0x379] = 0xF8;
        encode_name(data, "LINK")?;
        repair_checksum(data);
        let copy = data.to_vec();
        bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE].copy_from_slice(&copy);
        let files = parse_files(&bytes)?;
        build_document(&bytes, &definition().identity, &files)?;
        Ok(bytes)
    }
}

impl SaveGameHandler for ZeldaAlttpHandler {
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
        save_format: SNES_SRAM_8K.id.into(),
        save_format_name: SNES_SRAM_8K.display_name.into(),
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
        save_format: SNES_SRAM_8K.id.into(),
        save_format_name: SNES_SRAM_8K.display_name.into(),
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
        kind: SaveFieldKind::Text,
        value: SaveValue::Text(decode_name(data)),
        editable: true,
        constraints: SaveConstraint {
            max_length: Some(NAME_LENGTH as u8),
            ..Default::default()
        },
        description: "Player name from the original English naming screen".into(),
        warnings: Vec::new(),
        step: None,
        encoding: Some("zelda_alttp_english_name".into()),
    });
    for (name, label, offset, choices, description) in ITEM_ENUM_FIELDS {
        fields.push(enum_field(
            &format!("{prefix}.inventory.{name}"),
            label,
            slot,
            *offset,
            data[*offset],
            choices,
            description,
        ));
    }
    for index in 0..4 {
        fields.push(enum_field(
            &format!("{prefix}.inventory.bottle_{}", index + 1),
            &format!("Bottle {}", index + 1),
            slot,
            0x35C + index,
            data[0x35C + index],
            BOTTLE_CHOICES,
            "Bottle contents",
        ));
    }
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
    fields.push(unsigned_field(
        &format!("{prefix}.magic.current"),
        "Current magic",
        slot,
        0x36E,
        u32::from(data[0x36E]),
        128,
        "Current magic power. The original game caps this at 128.",
    ));
    fields.push(enum_field(
        &format!("{prefix}.magic.consumption"),
        "Magic consumption",
        slot,
        0x37B,
        data[0x37B],
        &["normal", "half", "quarter"],
        "Magic consumption mode",
    ));
    fields.push(unsigned_field(
        &format!("{prefix}.resources.bomb_capacity_upgrades"),
        "Bomb capacity upgrades",
        slot,
        0x370,
        u32::from(data[0x370]),
        3,
        "Number of bomb capacity upgrades received",
    ));
    fields.push(unsigned_field(
        &format!("{prefix}.resources.arrow_capacity_upgrades"),
        "Arrow capacity upgrades",
        slot,
        0x371,
        u32::from(data[0x371]),
        3,
        "Number of arrow capacity upgrades received",
    ));
    fields.push(unsigned_field(
        &format!("{prefix}.progress.heart_pieces"),
        "Heart pieces toward next container",
        slot,
        0x36B,
        u32::from(data[0x36B]),
        3,
        "Heart pieces collected toward the next container",
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
    add_dungeon_fields(fields, slot, data);
    add_progression_fields(fields, slot, data);
}

fn add_dungeon_fields(fields: &mut Vec<SaveField>, slot: u8, data: &[u8]) {
    for (index, (name, label)) in DUNGEONS.iter().enumerate() {
        let (byte_index, bit) = if index < 8 {
            (0, 7 - index)
        } else {
            (1, 15 - index)
        };
        let compass_offset = 0x364 + byte_index;
        let big_key_offset = 0x366 + byte_index;
        let map_offset = 0x368 + byte_index;
        fields.push(boolean_field(
            &format!("slot_{}.progress.dungeons.{name}.compass", slot + 1),
            &format!("{label} compass"),
            slot,
            compass_offset,
            data[compass_offset] & (1 << bit) != 0,
            "Dungeon compass ownership",
        ));
        fields.push(boolean_field(
            &format!("slot_{}.progress.dungeons.{name}.big_key", slot + 1),
            &format!("{label} big key"),
            slot,
            big_key_offset,
            data[big_key_offset] & (1 << bit) != 0,
            "Dungeon big key ownership",
        ));
        fields.push(boolean_field(
            &format!("slot_{}.progress.dungeons.{name}.map", slot + 1),
            &format!("{label} map"),
            slot,
            map_offset,
            data[map_offset] & (1 << bit) != 0,
            "Dungeon map ownership",
        ));
        fields.push(unsigned_field(
            &format!("slot_{}.progress.dungeons.{name}.keys_earned", slot + 1),
            &format!("{label} keys earned"),
            slot,
            DUNGEON_KEY_OFFSETS[index],
            u32::from(data[DUNGEON_KEY_OFFSETS[index]]),
            255,
            "Number of keys earned in this dungeon",
        ));
    }
}

fn add_progression_fields(fields: &mut Vec<SaveField>, slot: u8, data: &[u8]) {
    fields.push(enum_field(
        &format!("slot_{}.progress.game_state", slot + 1),
        "Game state",
        slot,
        0x3C5,
        data[0x3C5],
        &[
            "start",
            "uncle_reached",
            "zelda_rescued",
            "agahnim_defeated",
        ],
        "Main story state",
    ));
    fields.push(enum_field(
        &format!("slot_{}.progress.map_icon", slot + 1),
        "Map guidance icon",
        slot,
        0x3C7,
        data[0x3C7],
        &[
            "castle",
            "kakariko",
            "eastern_palace",
            "master_sword",
            "master_sword_light_world",
            "agahnim",
            "palace_of_darkness",
            "crystals",
            "ganons_tower",
        ],
        "Map icon guidance state",
    ));
    fields.push(enum_field(
        &format!("slot_{}.progress.spawn_point", slot + 1),
        "Save spawn point",
        slot,
        0x3C8,
        data[0x3C8],
        &[
            "links_house",
            "sanctuary",
            "prison",
            "uncle",
            "throne",
            "old_man_cave",
            "old_man_home",
        ],
        "Save and continue spawn point",
    ));
    fields.push(enum_field(
        &format!("slot_{}.progress.save_world", slot + 1),
        "Save world",
        slot,
        0x3CA,
        data[0x3CA],
        &["light", "dark"],
        "World selected after loading the save",
    ));
    for (name, bit, description) in [
        (
            "uncle_secret_passage",
            0,
            "Uncle visited in the secret passage",
        ),
        ("sanctuary_priest", 1, "Priest visited in the sanctuary"),
        ("zelda_sanctuary", 2, "Zelda brought to the sanctuary"),
        ("uncle_left_house", 4, "Uncle left Link's house"),
        ("book_progress", 5, "Book of Mudora progress"),
        ("fortune_teller_variant", 6, "Fortune teller dialog variant"),
    ] {
        fields.push(boolean_field(
            &format!("slot_{}.progress.early_story.{name}", slot + 1),
            name,
            slot,
            0x3C6,
            data[0x3C6] & (1 << bit) != 0,
            description,
        ));
    }
    for (name, bit, description) in [
        (
            "smith_tempering",
            7,
            "Smiths are currently tempering the sword",
        ),
        ("swordsmith_rescued", 5, "Swordsmith has been rescued"),
        ("purple_chest_opened", 4, "Purple chest has been opened"),
        ("stumpy_stumped", 3, "Stumpy has been stumped"),
        (
            "bottle_purchased",
            1,
            "Bottle was purchased from the vendor",
        ),
        ("hobo_bottle", 0, "Bottle was received from the hobo"),
    ] {
        fields.push(boolean_field(
            &format!("slot_{}.progress.side_quests.{name}", slot + 1),
            name,
            slot,
            0x3C9,
            data[0x3C9] & (1 << bit) != 0,
            description,
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

fn encode_name(data: &mut [u8], name: &str) -> Result<()> {
    let characters = name.chars().collect::<Vec<_>>();
    if characters.len() > NAME_LENGTH {
        return Err(validation(
            "save_name_length",
            "the player name is longer than six characters",
        ));
    }
    for index in 0..NAME_LENGTH {
        let word = match characters.get(index).copied() {
            None => 0x00A9,
            Some('A'..='Z') => {
                let code = characters[index] as u8 - b'A';
                u16::from((code & 0x0F) | ((code & 0xF0) << 1))
            }
            Some('a'..='z') => {
                let code = characters[index] as u8 - b'a' + 0x1A;
                u16::from((code & 0x0F) | ((code & 0xF0) << 1))
            }
            Some(' ') => 0x00AF,
            Some(_) => {
                return Err(validation(
                    "save_name_charset",
                    "the player name contains a character outside the original keyboard",
                ));
            }
        };
        write_word(data, NAME_OFFSET + index * 2, word);
    }
    Ok(())
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
        ("player.name", SaveValue::Text(value)) => encode_name(data, value)?,
        ("magic.current", SaveValue::U32(value)) => {
            data[0x36E] = u8::try_from(*value)
                .map_err(|_| validation("save_value_range", "the magic value is out of range"))?
        }
        ("magic.consumption", SaveValue::Enum(value)) => {
            data[0x37B] = enum_index(value, &["normal", "half", "quarter"])?
        }
        ("resources.bomb_capacity_upgrades", SaveValue::U32(value)) => {
            data[0x370] = u8::try_from(*value).map_err(|_| {
                validation(
                    "save_value_range",
                    "the bomb capacity upgrade count is out of range",
                )
            })?
        }
        ("resources.arrow_capacity_upgrades", SaveValue::U32(value)) => {
            data[0x371] = u8::try_from(*value).map_err(|_| {
                validation(
                    "save_value_range",
                    "the arrow capacity upgrade count is out of range",
                )
            })?
        }
        ("progress.heart_pieces", SaveValue::U32(value)) => {
            data[0x36B] = u8::try_from(*value).map_err(|_| {
                validation("save_value_range", "the heart piece count is out of range")
            })?
        }
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
        (field, SaveValue::Enum(value)) => {
            if let Some(name) = field.strip_prefix("inventory.") {
                if let Some((_, _, offset, choices, _)) =
                    ITEM_ENUM_FIELDS.iter().find(|(item, ..)| *item == name)
                {
                    data[*offset] = enum_index(value, choices)?;
                } else if let Some(index) = name
                    .strip_prefix("bottle_")
                    .and_then(|value| value.parse::<usize>().ok())
                    .filter(|index| (1..=4).contains(index))
                {
                    data[0x35B + index] = enum_index(value, BOTTLE_CHOICES)?;
                } else {
                    return Err(validation(
                        "save_field_unknown",
                        "the requested save field is unknown",
                    ));
                }
            } else if field == "progress.game_state" {
                data[0x3C5] = enum_index(
                    value,
                    &[
                        "start",
                        "uncle_reached",
                        "zelda_rescued",
                        "agahnim_defeated",
                    ],
                )?;
            } else if field == "progress.map_icon" {
                data[0x3C7] = enum_index(
                    value,
                    &[
                        "castle",
                        "kakariko",
                        "eastern_palace",
                        "master_sword",
                        "master_sword_light_world",
                        "agahnim",
                        "palace_of_darkness",
                        "crystals",
                        "ganons_tower",
                    ],
                )?;
            } else if field == "progress.spawn_point" {
                data[0x3C8] = enum_index(
                    value,
                    &[
                        "links_house",
                        "sanctuary",
                        "prison",
                        "uncle",
                        "throne",
                        "old_man_cave",
                        "old_man_home",
                    ],
                )?;
            } else if field == "progress.save_world" {
                data[0x3CA] = enum_index(value, &["light", "dark"])?;
            } else {
                return Err(validation(
                    "save_field_unknown",
                    "the requested save field is unknown",
                ));
            }
        }
        (field, SaveValue::U32(value)) if field.starts_with("progress.dungeons.") => {
            let dungeon = field
                .strip_prefix("progress.dungeons.")
                .and_then(|value| value.strip_suffix(".keys_earned"))
                .and_then(|name| DUNGEONS.iter().position(|(id, _)| *id == name))
                .ok_or_else(|| {
                    validation("save_field_unknown", "the requested save field is unknown")
                })?;
            data[DUNGEON_KEY_OFFSETS[dungeon]] = u8::try_from(*value).map_err(|_| {
                validation("save_value_range", "the dungeon key count is out of range")
            })?;
        }
        (field, SaveValue::Bool(value)) => {
            if let Some((_, _, offset)) = ITEM_FIELDS
                .iter()
                .find(|(name, _, _)| field == format!("inventory.{name}"))
            {
                data[*offset] = u8::from(*value);
            } else if let Some((dungeon, item)) = dungeon_item_field(field) {
                let (offset, bit) = dungeon_item_offset(dungeon, item);
                set_bit(&mut data[offset], bit, *value);
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
            } else if let Some(bit) = field
                .strip_prefix("progress.early_story.")
                .and_then(|name| {
                    [
                        ("uncle_secret_passage", 0),
                        ("sanctuary_priest", 1),
                        ("zelda_sanctuary", 2),
                        ("uncle_left_house", 4),
                        ("book_progress", 5),
                        ("fortune_teller_variant", 6),
                    ]
                    .iter()
                    .find(|(candidate, _)| *candidate == name)
                    .map(|(_, bit)| *bit)
                })
            {
                set_bit(&mut data[0x3C6], bit, *value);
            } else if let Some(bit) = [
                "smith_tempering",
                "swordsmith_rescued",
                "purple_chest_opened",
                "stumpy_stumped",
                "bottle_purchased",
                "hobo_bottle",
            ]
            .iter()
            .position(|candidate| {
                *candidate == field.strip_prefix("progress.side_quests.").unwrap_or("")
            }) {
                let bit = [7, 5, 4, 3, 1, 0][bit];
                set_bit(&mut data[0x3C9], bit, *value);
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

fn dungeon_item_field(field: &str) -> Option<(usize, &str)> {
    let value = field.strip_prefix("progress.dungeons.")?;
    let (dungeon, item) = value.split_once('.')?;
    if !matches!(item, "compass" | "big_key" | "map") {
        return None;
    }
    let index = DUNGEONS.iter().position(|(id, _)| *id == dungeon)?;
    Some((index, item))
}

fn dungeon_item_offset(dungeon: usize, item: &str) -> (usize, u8) {
    let (byte_index, bit) = if dungeon < 8 {
        (0, 7 - dungeon)
    } else {
        (1, 15 - dungeon)
    };
    let base = match item {
        "compass" => 0x364,
        "big_key" => 0x366,
        "map" => 0x368,
        _ => unreachable!("dungeon item names are checked by dungeon_item_field"),
    };
    (base + byte_index, bit as u8)
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
    if ITEM_ENUM_FIELDS
        .iter()
        .any(|(_, _, offset, choices, _)| usize::from(data[*offset]) >= choices.len())
    {
        return Err(validation(
            "save_inventory",
            "an inventory item value is outside the original game range",
        ));
    }
    if (0x35C..=0x35F).any(|offset| usize::from(data[offset]) >= BOTTLE_CHOICES.len()) {
        return Err(validation(
            "save_inventory",
            "a bottle value is outside the original game range",
        ));
    }
    if data[0x36B] > 3 {
        return Err(validation(
            "save_heart_pieces",
            "heart pieces must be from zero through three",
        ));
    }
    if data[0x36E] > 128 {
        return Err(validation(
            "save_magic",
            "magic power is above the original game limit",
        ));
    }
    if data[0x370] > 3 || data[0x371] > 3 {
        return Err(validation(
            "save_capacity_upgrades",
            "capacity upgrades are above the original game limit",
        ));
    }
    if data[0x37B] > 2 {
        return Err(validation(
            "save_magic_consumption",
            "magic consumption is outside the original game range",
        ));
    }
    if data[0x3C5] > 3 || data[0x3C7] > 8 || data[0x3C8] > 6 || data[0x3CA] > 1 {
        return Err(validation(
            "save_progression",
            "a progression value is outside the original game range",
        ));
    }
    if data[0x3CB] != 0 {
        return Err(validation(
            "save_progression",
            "the high byte of the save world must be zero",
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
    use crate::save::SaveGameRegistry;

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
    fn generates_the_original_fresh_file_initializer() {
        let bytes = ZeldaAlttpHandler::generate().unwrap();
        let identity = definition().identity;
        let document = ZeldaAlttpHandler
            .parse(&input(bytes.clone()), &identity)
            .unwrap();
        assert_eq!(bytes.len(), ALTT_P_SRAM_SIZE);
        assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
        assert_eq!(document.sections.len(), 1);
        assert_eq!(document.active_slot, 0);
        assert_eq!(
            field_value(&document, "slot_1.player.name"),
            Some(&SaveValue::Text("LINK".into()))
        );
        assert_eq!(
            field_value(&document, "slot_1.hearts.capacity_eighths"),
            Some(&SaveValue::U32(24))
        );
        assert_eq!(
            field_value(&document, "slot_1.hearts.current_eighths"),
            Some(&SaveValue::U32(24))
        );
        assert_eq!(word_at(&bytes[..FILE_SIZE], 0x20C), 0xF000);
        assert_eq!(word_at(&bytes[..FILE_SIZE], 0x20E), 0xF000);
        assert_eq!(word_at(&bytes[..FILE_SIZE], DIED_COUNTER_OFFSET), 0xFFFF);
        assert_eq!(
            &bytes[..FILE_SIZE],
            &bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE]
        );
        assert!(is_valid_copy(&bytes[..FILE_SIZE]));
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
    fn registry_generation_uses_the_checked_initializer() {
        let input = SaveGameRegistry::default()
            .generate("zelda-a-link-to-the-past")
            .unwrap();
        assert_eq!(
            input.selected_game.as_deref(),
            Some(definition().identity.id.as_str())
        );
        assert_eq!(input.bytes, ZeldaAlttpHandler::generate().unwrap());
    }

    #[test]
    fn edits_verified_inventory_magic_dungeon_and_progression_fields() {
        let original = fixture();
        let result = ZeldaAlttpHandler
            .apply(
                &input(original.clone()),
                &definition().identity,
                &[
                    SaveEdit {
                        field: "slot_1.player.name".into(),
                        value: SaveValue::Text("Zelda".into()),
                    },
                    SaveEdit {
                        field: "slot_1.inventory.bow".into(),
                        value: SaveValue::Enum("silver_bow_and_arrows".into()),
                    },
                    SaveEdit {
                        field: "slot_1.inventory.bottle_1".into(),
                        value: SaveValue::Enum("blue_potion".into()),
                    },
                    SaveEdit {
                        field: "slot_1.magic.current".into(),
                        value: SaveValue::U32(128),
                    },
                    SaveEdit {
                        field: "slot_1.magic.consumption".into(),
                        value: SaveValue::Enum("half".into()),
                    },
                    SaveEdit {
                        field: "slot_1.progress.dungeons.sewers.compass".into(),
                        value: SaveValue::Bool(true),
                    },
                    SaveEdit {
                        field: "slot_1.progress.dungeons.ganons_tower.map".into(),
                        value: SaveValue::Bool(true),
                    },
                    SaveEdit {
                        field: "slot_1.progress.dungeons.eastern_palace.keys_earned".into(),
                        value: SaveValue::U32(6),
                    },
                    SaveEdit {
                        field: "slot_1.progress.game_state".into(),
                        value: SaveValue::Enum("zelda_rescued".into()),
                    },
                    SaveEdit {
                        field: "slot_1.progress.side_quests.purple_chest_opened".into(),
                        value: SaveValue::Bool(true),
                    },
                ],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        let data = &bytes[..FILE_SIZE];
        assert_eq!(decode_name(data), "Zelda");
        assert_eq!(data[0x340], 4);
        assert_eq!(data[0x35C], 5);
        assert_eq!(data[0x36E], 128);
        assert_eq!(data[0x37B], 1);
        assert_eq!(data[0x364] & 0x80, 0x80);
        assert_eq!(data[0x369] & 0x04, 0x04);
        assert_eq!(data[0x37E], 6);
        assert_eq!(data[0x3C5], 2);
        assert_eq!(data[0x3C9] & 0x10, 0x10);
        assert!(is_valid_copy(data));
        assert_eq!(&bytes[BACKUP_OFFSET..BACKUP_OFFSET + FILE_SIZE], data);
        assert_eq!(&bytes[0x500..0x520], &original[0x500..0x520]);
        assert_eq!(&bytes[0xA00..0xA20], &original[0xA00..0xA20]);
    }

    #[test]
    fn rejects_out_of_range_expanded_fields() {
        for (field, value, code) in [
            (
                "slot_1.magic.current",
                SaveValue::U32(129),
                "save_value_range",
            ),
            (
                "slot_1.progress.heart_pieces",
                SaveValue::U32(4),
                "save_value_range",
            ),
            (
                "slot_1.inventory.bottle_1",
                SaveValue::Enum("invalid".into()),
                "save_value_choice",
            ),
        ] {
            let error = ZeldaAlttpHandler
                .apply(
                    &input(fixture()),
                    &definition().identity,
                    &[SaveEdit {
                        field: field.into(),
                        value,
                    }],
                    false,
                )
                .unwrap_err();
            match error {
                RomWeaverError::ValidationCode(error) => assert_eq!(error.code(), code),
                other => panic!("expected a validation error, got {other:?}"),
            }
        }
    }

    #[test]
    fn writes_progress_bitfields_in_source_bit_order() {
        let edits = [
            "uncle_secret_passage",
            "sanctuary_priest",
            "zelda_sanctuary",
            "uncle_left_house",
            "book_progress",
            "fortune_teller_variant",
        ]
        .into_iter()
        .map(|name| SaveEdit {
            field: format!("slot_1.progress.early_story.{name}"),
            value: SaveValue::Bool(true),
        })
        .chain(
            [
                "swordsmith_rescued",
                "purple_chest_opened",
                "stumpy_stumped",
                "bottle_purchased",
                "hobo_bottle",
            ]
            .into_iter()
            .map(|name| SaveEdit {
                field: format!("slot_1.progress.side_quests.{name}"),
                value: SaveValue::Bool(true),
            }),
        )
        .collect::<Vec<_>>();
        let result = ZeldaAlttpHandler
            .apply(&input(fixture()), &definition().identity, &edits, false)
            .unwrap();
        let data = &result.bytes.unwrap()[..FILE_SIZE];
        assert_eq!(data[0x3C6], 0x77);
        assert_eq!(data[0x3C9], 0x3B);
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
