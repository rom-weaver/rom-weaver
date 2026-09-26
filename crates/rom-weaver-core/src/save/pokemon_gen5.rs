use tracing::{debug, trace};

use super::formats::NINTENDO_DS_512K;
use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityState, SaveRecognition, SaveRecognitionConfidence,
    SaveRecognitionOutcome, SaveRecognitionReason, SaveSection, SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

pub const GEN5_SAVE_SIZE: usize = NINTENDO_DS_512K.supported_sizes[0];
const TRAINER_OFFSET: usize = 0x19400;
const INVENTORY_OFFSET: usize = 0x18400;
const MAX_MONEY: u32 = 9_999_999;
const MAX_BATTLE_POINTS: u32 = u16::MAX as u32;
const MAX_TRAINER_NAME_UNITS: usize = 7;
const INVENTORY_GENERAL_COUNT: usize = 261;
const INVENTORY_MACHINE_COUNT: usize = 105;
const INVENTORY_MEDICINE_COUNT: usize = 47;
const INVENTORY_BERRY_COUNT: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LayoutKind {
    Bw,
    B2w2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Title {
    Black,
    White,
    Black2,
    White2,
}

impl Title {
    const ALL: [Self; 4] = [Self::Black, Self::White, Self::Black2, Self::White2];

    fn id(self) -> &'static str {
        match self {
            Self::Black => "pokemon-black",
            Self::White => "pokemon-white",
            Self::Black2 => "pokemon-black-2",
            Self::White2 => "pokemon-white-2",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Black => "Pokémon Black",
            Self::White => "Pokémon White",
            Self::Black2 => "Pokémon Black 2",
            Self::White2 => "Pokémon White 2",
        }
    }

    fn version(self) -> u8 {
        match self {
            Self::White => 20,
            Self::Black => 21,
            Self::White2 => 22,
            Self::Black2 => 23,
        }
    }

    fn layout(self) -> LayoutKind {
        match self {
            Self::Black | Self::White => LayoutKind::Bw,
            Self::Black2 | Self::White2 => LayoutKind::B2w2,
        }
    }

    fn identity(self) -> SaveGameIdentity {
        SaveGameIdentity {
            id: self.id().into(),
            name: self.name().into(),
            family: match self.layout() {
                LayoutKind::Bw => "pokemon-gen5-bw",
                LayoutKind::B2w2 => "pokemon-gen5-b2w2",
            }
            .into(),
        }
    }

    fn definition(self) -> SaveGameDefinition {
        SaveGameDefinition {
            identity: self.identity(),
            platform: "nds".into(),
            save_format: NINTENDO_DS_512K.id.into(),
            save_format_name: NINTENDO_DS_512K.display_name.into(),
            handler_id: "pokemon-gen5".into(),
            supported_save_sizes: vec![GEN5_SAVE_SIZE as u32],
            known_rom_sha1: Vec::new(),
            checksum_sizes: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Block {
    offset: usize,
    length: usize,
    checksum: usize,
    mirror: usize,
}

#[derive(Clone, Copy)]
struct InventoryPocket {
    name: &'static str,
    offset: usize,
    count: usize,
    max_quantity: u32,
}

impl LayoutKind {
    fn blocks(self) -> &'static [Block] {
        match self {
            Self::Bw => &BW_BLOCKS,
            Self::B2w2 => &B2W2_BLOCKS,
        }
    }

    fn misc_offset(self) -> usize {
        match self {
            Self::Bw => 0x21200,
            Self::B2w2 => 0x21100,
        }
    }

    fn battle_points_offset(self) -> usize {
        match self {
            Self::Bw => 0x21D00,
            Self::B2w2 => 0x21B00,
        }
    }

    fn misc_section(self) -> u8 {
        52
    }

    fn battle_points_section(self) -> u8 {
        match self {
            Self::Bw => 58,
            Self::B2w2 => 57,
        }
    }

    fn inventory_pockets(self) -> [InventoryPocket; 5] {
        [
            InventoryPocket {
                name: "items",
                offset: 0x000,
                count: INVENTORY_GENERAL_COUNT,
                max_quantity: 999,
            },
            InventoryPocket {
                name: "key_items",
                offset: 0x4d8,
                count: match self {
                    Self::Bw => 19,
                    Self::B2w2 => 27,
                },
                max_quantity: 1,
            },
            InventoryPocket {
                name: "tm_hm",
                offset: 0x624,
                count: INVENTORY_MACHINE_COUNT,
                max_quantity: 1,
            },
            InventoryPocket {
                name: "medicine",
                offset: 0x7d8,
                count: INVENTORY_MEDICINE_COUNT,
                max_quantity: 999,
            },
            InventoryPocket {
                name: "berries",
                offset: 0x898,
                count: INVENTORY_BERRY_COUNT,
                max_quantity: 999,
            },
        ]
    }

    fn max_item_id(self) -> u32 {
        match self {
            Self::Bw => 632,
            Self::B2w2 => 638,
        }
    }
}

pub struct PokemonGen5Handler;

impl SaveGameHandler for PokemonGen5Handler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        Title::ALL.into_iter().map(Title::definition).collect()
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        if input.bytes.len() != GEN5_SAVE_SIZE {
            return unsupported(SaveRecognitionReason::WrongSize);
        }
        let requested = match input.selected_game.as_deref() {
            Some(id) => match title_for_id(id) {
                Some(title) => Some(title),
                None => return unsupported(SaveRecognitionReason::UnsupportedLayout),
            },
            None => None,
        };
        let stored = title_for_version(input.bytes[TRAINER_OFFSET + 0x1f]);
        let candidates = requested
            .or(stored)
            .filter(|title| requested.is_none_or(|value| value == *title))
            .filter(|title| stored.is_some_and(|value| value == *title))
            .filter(|title| validate_save(&input.bytes, *title).is_ok())
            .map(|title| SaveGameCandidate {
                identity: title.identity(),
                confidence: SaveRecognitionConfidence::High,
                reasons: {
                    let mut reasons = vec![
                        SaveRecognitionReason::ChecksumValid,
                        SaveRecognitionReason::SignatureValid,
                    ];
                    if input.selected_game.is_some() {
                        reasons.push(SaveRecognitionReason::SelectedGame);
                    }
                    reasons
                },
            })
            .into_iter()
            .collect::<Vec<_>>();
        let outcome = match candidates.as_slice() {
            [candidate] => SaveRecognitionOutcome::Recognized {
                candidate: candidate.clone(),
            },
            [] => SaveRecognitionOutcome::Unsupported {
                reasons: vec![SaveRecognitionReason::UnsupportedLayout],
            },
            _ => unreachable!("a stored Gen V version identifies one title"),
        };
        SaveRecognition {
            outcome,
            candidates,
            reasons: Vec::new(),
        }
    }

    fn parse(&self, input: &SaveDetectionInput, game: &SaveGameIdentity) -> Result<SaveDocument> {
        let title = title_for_game(game)?;
        validate_save(&input.bytes, title)?;
        build_document(&input.bytes, title)
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        let title = title_for_game(game)?;
        validate_save(&input.bytes, title)?;
        let document = build_document(&input.bytes, title)?;
        let mut preview = validate_save_edits(&document, edits)?;
        if !preview.changed {
            return Ok(SaveEditResult {
                preview,
                bytes: None,
                document,
            });
        }
        let checksum_section = (title.layout().blocks().len() - 1) as u8;
        if !preview.touched_sections.contains(&checksum_section) {
            preview.touched_sections.push(checksum_section);
            preview.touched_sections.sort_unstable();
        }

        let mut bytes = input.bytes.clone();
        apply_edits(&mut bytes, title, edits)?;
        repair_touched_blocks(&mut bytes, title.layout(), &preview.touched_sections);
        validate_save(&bytes, title)?;
        let reparsed = build_document(&bytes, title)?;
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

fn unsupported(reason: SaveRecognitionReason) -> SaveRecognition {
    SaveRecognition {
        outcome: SaveRecognitionOutcome::Unsupported {
            reasons: vec![reason.clone()],
        },
        candidates: Vec::new(),
        reasons: vec![reason],
    }
}

fn title_for_id(id: &str) -> Option<Title> {
    Title::ALL.into_iter().find(|title| title.id() == id)
}

fn title_for_version(version: u8) -> Option<Title> {
    Title::ALL
        .into_iter()
        .find(|title| title.version() == version)
}

fn title_for_game(game: &SaveGameIdentity) -> Result<Title> {
    title_for_id(&game.id).ok_or_else(|| {
        validation(
            "save_game_unsupported",
            "the selected save game is unsupported",
        )
    })
}

fn validate_save(bytes: &[u8], title: Title) -> Result<()> {
    if bytes.len() != GEN5_SAVE_SIZE {
        return Err(validation(
            "save_wrong_size",
            "a Pokémon Generation V save must be exactly 512 KiB",
        ));
    }
    if bytes[TRAINER_OFFSET + 0x1f] != title.version() {
        return Err(validation(
            "save_game_version",
            "the trainer data does not match the selected game",
        ));
    }
    if bytes[TRAINER_OFFSET + 0x21] > 1 {
        return Err(validation(
            "save_gender",
            "the save has an invalid player gender value",
        ));
    }
    if bytes[TRAINER_OFFSET + 0x26] > 59 || bytes[TRAINER_OFFSET + 0x27] > 59 {
        return Err(validation(
            "save_play_time",
            "the save has an invalid play-time minute or second value",
        ));
    }
    if read_u32(bytes, title.layout().misc_offset()) > MAX_MONEY {
        return Err(validation(
            "save_money",
            "the save has a money value above the game limit",
        ));
    }
    for (index, block) in title.layout().blocks().iter().enumerate() {
        let actual = crc16_ccitt(&bytes[block.offset..block.offset + block.length]);
        if read_u16(bytes, block.checksum) != actual || read_u16(bytes, block.mirror) != actual {
            debug!(index, actual, "Pokémon Gen V save block checksum mismatch");
            return Err(validation(
                "save_checksum",
                "a Pokémon Generation V save block checksum is invalid",
            ));
        }
    }
    trace!(
        game = title.id(),
        blocks = title.layout().blocks().len(),
        "validated Pokémon Gen V save"
    );
    Ok(())
}

fn build_document(bytes: &[u8], title: Title) -> Result<SaveDocument> {
    let layout = title.layout();
    let trainer_id = read_u32(bytes, TRAINER_OFFSET + 0x14);
    let mut fields = vec![
        text_field(
            "trainer.name",
            "Trainer Name",
            27,
            4,
            decode_trainer_name(&bytes[TRAINER_OFFSET + 4..TRAINER_OFFSET + 0x14])?,
            "Player trainer name",
        ),
        scalar_field(
            "trainer.id",
            "Trainer ID",
            27,
            0x14,
            trainer_id & 0xffff,
            (0, u16::MAX as u32),
            "Public trainer identifier",
        ),
        scalar_field(
            "trainer.secret_id",
            "Secret ID",
            27,
            0x16,
            trainer_id >> 16,
            (0, u16::MAX as u32),
            "Secret trainer identifier",
        ),
        scalar_field(
            "trainer.money",
            "Money",
            layout.misc_section(),
            0,
            read_u32(bytes, layout.misc_offset()),
            (0, MAX_MONEY),
            "Current money",
        ),
        enum_field(
            "trainer.gender",
            "Gender",
            27,
            0x21,
            if bytes[TRAINER_OFFSET + 0x21] == 0 {
                "male"
            } else {
                "female"
            },
        ),
        scalar_field(
            "trainer.play_time_hours",
            "Play Time Hours",
            27,
            0x24,
            u32::from(read_u16(bytes, TRAINER_OFFSET + 0x24)),
            (0, u16::MAX as u32),
            "Recorded play-time hours",
        ),
        scalar_field(
            "trainer.play_time_minutes",
            "Play Time Minutes",
            27,
            0x26,
            u32::from(bytes[TRAINER_OFFSET + 0x26]),
            (0, 59),
            "Recorded play-time minutes",
        ),
        scalar_field(
            "trainer.play_time_seconds",
            "Play Time Seconds",
            27,
            0x27,
            u32::from(bytes[TRAINER_OFFSET + 0x27]),
            (0, 59),
            "Recorded play-time seconds",
        ),
        scalar_field(
            "progress.battle_points",
            "Battle Points",
            layout.battle_points_section(),
            0,
            u32::from(read_u16(bytes, layout.battle_points_offset())),
            (0, MAX_BATTLE_POINTS),
            "Battle Subway points",
        ),
    ];
    fields.extend(inventory_fields(bytes, layout));
    for badge in 0..8u8 {
        fields.push(SaveField {
            id: format!("progress.badge_{}", badge + 1),
            label: format!("{} Badge", BADGE_NAMES[usize::from(badge)]),
            section_id: layout.misc_section(),
            offset: 4,
            kind: SaveFieldKind::BitfieldBoolean,
            value: SaveValue::Bool(bytes[layout.misc_offset() + 4] & (1 << badge) != 0),
            editable: true,
            constraints: SaveConstraint::default(),
            description: "Gym badge flag".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        });
    }
    let sections = layout
        .blocks()
        .iter()
        .enumerate()
        .map(|(index, block)| {
            let actual = crc16_ccitt(&bytes[block.offset..block.offset + block.length]);
            SaveSection {
                id: index as u8,
                physical_offset: block.offset as u32,
                checksum_expected: read_u16(bytes, block.checksum),
                checksum_actual: actual,
                signature: u32::from(title.version()),
                counter: 0,
                valid: read_u16(bytes, block.checksum) == actual
                    && read_u16(bytes, block.mirror) == actual,
            }
        })
        .collect();
    Ok(SaveDocument {
        identity: title.identity(),
        active_slot: 0,
        counter: 0,
        integrity: SaveIntegrity {
            state: SaveIntegrityState::Valid,
            issues: Vec::new(),
        },
        sections,
        fields,
        platform: "nds".into(),
        save_format: NINTENDO_DS_512K.id.into(),
        save_format_name: NINTENDO_DS_512K.display_name.into(),
        handler_id: "pokemon-gen5".into(),
        save_size: GEN5_SAVE_SIZE as u32,
        warnings: Vec::new(),
    })
}

fn inventory_fields(bytes: &[u8], layout: LayoutKind) -> Vec<SaveField> {
    let pockets = layout.inventory_pockets();
    let slot_count = pockets.iter().map(|pocket| pocket.count).sum::<usize>();
    let mut fields = Vec::with_capacity(slot_count * 2);
    for pocket in pockets {
        for slot in 0..pocket.count {
            let relative = pocket.offset + slot * 4;
            let offset = INVENTORY_OFFSET + relative;
            let item = read_u16(bytes, offset);
            let quantity = read_u16(bytes, offset + 2);
            let field_prefix = format!("inventory.{}.slot_{slot}", pocket.name);
            let label = pocket.name.replace('_', " ");
            fields.push(scalar_field(
                &format!("{field_prefix}.item_id"),
                &format!("Inventory {label} slot {} item", slot + 1),
                25,
                relative as u16,
                u32::from(item),
                (0, layout.max_item_id()),
                "Inventory item identifier; zero marks an empty slot",
            ));
            fields.push(scalar_field(
                &format!("{field_prefix}.quantity"),
                &format!("Inventory {label} slot {} quantity", slot + 1),
                25,
                (relative + 2) as u16,
                u32::from(quantity),
                (0, pocket.max_quantity),
                "Inventory item quantity",
            ));
        }
    }
    fields
}

fn apply_edits(bytes: &mut [u8], title: Title, edits: &[SaveEdit]) -> Result<()> {
    let layout = title.layout();
    for edit in edits {
        match (edit.field.as_str(), &edit.value) {
            ("trainer.name", SaveValue::Text(value)) => {
                encode_trainer_name(value, &mut bytes[TRAINER_OFFSET + 4..TRAINER_OFFSET + 0x14])?
            }
            ("trainer.id", SaveValue::U32(value)) => {
                write_u16(bytes, TRAINER_OFFSET + 0x14, *value as u16)
            }
            ("trainer.secret_id", SaveValue::U32(value)) => {
                write_u16(bytes, TRAINER_OFFSET + 0x16, *value as u16)
            }
            ("trainer.money", SaveValue::U32(value)) => {
                write_u32(bytes, layout.misc_offset(), *value)
            }
            ("trainer.gender", SaveValue::Enum(value)) => {
                bytes[TRAINER_OFFSET + 0x21] = match value.as_str() {
                    "male" => 0,
                    "female" => 1,
                    _ => {
                        return Err(validation(
                            "save_value_choice",
                            "the requested gender is not allowed",
                        ));
                    }
                };
            }
            ("trainer.play_time_hours", SaveValue::U32(value)) => {
                write_u16(bytes, TRAINER_OFFSET + 0x24, *value as u16)
            }
            ("trainer.play_time_minutes", SaveValue::U32(value)) => {
                bytes[TRAINER_OFFSET + 0x26] = *value as u8
            }
            ("trainer.play_time_seconds", SaveValue::U32(value)) => {
                bytes[TRAINER_OFFSET + 0x27] = *value as u8
            }
            ("progress.battle_points", SaveValue::U32(value)) => {
                write_u16(bytes, layout.battle_points_offset(), *value as u16)
            }
            (field, SaveValue::Bool(value)) if field.starts_with("progress.badge_") => {
                let badge = field[15..]
                    .parse::<u8>()
                    .ok()
                    .and_then(|number| number.checked_sub(1))
                    .filter(|number| *number < 8)
                    .ok_or_else(|| {
                        validation("save_field_unknown", "the requested badge field is unknown")
                    })?;
                let mask = 1 << badge;
                if *value {
                    bytes[layout.misc_offset() + 4] |= mask;
                } else {
                    bytes[layout.misc_offset() + 4] &= !mask;
                }
            }
            (field, SaveValue::U32(value)) if field.starts_with("inventory.") => {
                let (slot, component) = parse_inventory_field(field, layout)?;
                let offset = INVENTORY_OFFSET + slot * 4;
                match component {
                    "item_id" => write_u16(bytes, offset, *value as u16),
                    "quantity" => write_u16(bytes, offset + 2, *value as u16),
                    _ => unreachable!("validated inventory field component"),
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

fn repair_touched_blocks(bytes: &mut [u8], layout: LayoutKind, sections: &[u8]) {
    for section in sections {
        let block = layout.blocks()[usize::from(*section)];
        let crc = crc16_ccitt(&bytes[block.offset..block.offset + block.length]);
        write_u16(bytes, block.checksum, crc);
        write_u16(bytes, block.mirror, crc);
    }
    let checksum_block = layout.blocks().last().expect("Gen V has a checksum block");
    let crc =
        crc16_ccitt(&bytes[checksum_block.offset..checksum_block.offset + checksum_block.length]);
    write_u16(bytes, checksum_block.checksum, crc);
    write_u16(bytes, checksum_block.mirror, crc);
}

fn text_field(
    id: &str,
    label: &str,
    section_id: u8,
    offset: u16,
    value: String,
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id,
        offset,
        kind: SaveFieldKind::Text,
        value: SaveValue::Text(value),
        editable: true,
        constraints: SaveConstraint {
            max_length: Some(MAX_TRAINER_NAME_UNITS as u8),
            ..Default::default()
        },
        description: description.into(),
        warnings: Vec::new(),
        step: None,
        encoding: Some("utf16le".into()),
    }
}

fn parse_inventory_field(field: &str, layout: LayoutKind) -> Result<(usize, &str)> {
    let suffix = field.strip_prefix("inventory.").ok_or_else(|| {
        validation(
            "save_field_unknown",
            "the requested inventory field is unknown",
        )
    })?;
    let (pocket_and_slot, component) = suffix.rsplit_once('.').ok_or_else(|| {
        validation(
            "save_field_unknown",
            "the requested inventory field is unknown",
        )
    })?;
    let (pocket_name, slot) = pocket_and_slot.rsplit_once(".slot_").ok_or_else(|| {
        validation(
            "save_field_unknown",
            "the requested inventory field is unknown",
        )
    })?;
    let slot = slot.parse::<usize>().ok();
    let offset = layout
        .inventory_pockets()
        .into_iter()
        .find(|pocket| pocket.name == pocket_name && slot.is_some_and(|slot| slot < pocket.count))
        .and_then(|pocket| slot.map(|slot| pocket.offset + slot * 4));
    if !matches!(component, "item_id" | "quantity") || offset.is_none() {
        return Err(validation(
            "save_field_unknown",
            "the requested inventory field is unknown",
        ));
    }
    Ok((offset.expect("checked inventory slot") / 4, component))
}

fn decode_trainer_name(bytes: &[u8]) -> Result<String> {
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|unit| !matches!(unit, 0 | 0xffff))
        .map(|unit| match unit {
            0x246d => 0x2642,
            0x246e => 0x2640,
            _ => unit,
        })
        .collect::<Vec<_>>();
    String::from_utf16(&units).map_err(|_| {
        validation(
            "save_text_codec",
            "the save has invalid UTF-16 trainer text",
        )
    })
}

fn encode_trainer_name(value: &str, output: &mut [u8]) -> Result<()> {
    let full_width = value.chars().any(|character| {
        let value = u32::from(character);
        value != 0x2640 && value != 0x2642 && value >> 12 != 0 && value >> 12 != 0xe
    });
    let units = value
        .encode_utf16()
        .map(|unit| match (full_width, unit) {
            (false, 0x2642) => 0x246d,
            (false, 0x2640) => 0x246e,
            _ => unit,
        })
        .collect::<Vec<_>>();
    if units.len() > MAX_TRAINER_NAME_UNITS {
        return Err(validation(
            "save_name_length",
            "the trainer name is longer than seven UTF-16 code units",
        ));
    }
    output.fill(0);
    let count = units.len();
    for (pair, unit) in output.chunks_exact_mut(2).zip(units) {
        pair.copy_from_slice(&unit.to_le_bytes());
    }
    if count < output.len() / 2 {
        let terminator = count * 2;
        output[terminator..terminator + 2].copy_from_slice(&0xffffu16.to_le_bytes());
    }
    Ok(())
}

fn scalar_field(
    id: &str,
    label: &str,
    section_id: u8,
    offset: u16,
    value: u32,
    range: (u32, u32),
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id,
        offset,
        kind: SaveFieldKind::UnsignedInteger,
        value: SaveValue::U32(value),
        editable: true,
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

fn enum_field(id: &str, label: &str, section_id: u8, offset: u16, value: &str) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id,
        offset,
        kind: SaveFieldKind::Enum,
        value: SaveValue::Enum(value.into()),
        editable: true,
        constraints: SaveConstraint {
            choices: vec!["male".into(), "female".into()],
            ..Default::default()
        },
        description: "Player gender".into(),
        warnings: Vec::new(),
        step: None,
        encoding: None,
    }
}

fn field_value<'a>(document: &'a SaveDocument, id: &str) -> Option<&'a SaveValue> {
    document
        .fields
        .iter()
        .find(|field| field.id == id)
        .map(|field| &field.value)
}

const BADGE_NAMES: [&str; 8] = [
    "Trio", "Basic", "Insect", "Bolt", "Quake", "Jet", "Freeze", "Legend",
];

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
fn write_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}
fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn crc16_ccitt(data: &[u8]) -> u16 {
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

const BW_BLOCKS: [Block; 70] = [
    Block {
        offset: 0x00000,
        length: 0x03E0,
        checksum: 0x003E2,
        mirror: 0x23F00,
    },
    Block {
        offset: 0x00400,
        length: 0x0FF0,
        checksum: 0x013F2,
        mirror: 0x23F02,
    },
    Block {
        offset: 0x01400,
        length: 0x0FF0,
        checksum: 0x023F2,
        mirror: 0x23F04,
    },
    Block {
        offset: 0x02400,
        length: 0x0FF0,
        checksum: 0x033F2,
        mirror: 0x23F06,
    },
    Block {
        offset: 0x03400,
        length: 0x0FF0,
        checksum: 0x043F2,
        mirror: 0x23F08,
    },
    Block {
        offset: 0x04400,
        length: 0x0FF0,
        checksum: 0x053F2,
        mirror: 0x23F0A,
    },
    Block {
        offset: 0x05400,
        length: 0x0FF0,
        checksum: 0x063F2,
        mirror: 0x23F0C,
    },
    Block {
        offset: 0x06400,
        length: 0x0FF0,
        checksum: 0x073F2,
        mirror: 0x23F0E,
    },
    Block {
        offset: 0x07400,
        length: 0x0FF0,
        checksum: 0x083F2,
        mirror: 0x23F10,
    },
    Block {
        offset: 0x08400,
        length: 0x0FF0,
        checksum: 0x093F2,
        mirror: 0x23F12,
    },
    Block {
        offset: 0x09400,
        length: 0x0FF0,
        checksum: 0x0A3F2,
        mirror: 0x23F14,
    },
    Block {
        offset: 0x0A400,
        length: 0x0FF0,
        checksum: 0x0B3F2,
        mirror: 0x23F16,
    },
    Block {
        offset: 0x0B400,
        length: 0x0FF0,
        checksum: 0x0C3F2,
        mirror: 0x23F18,
    },
    Block {
        offset: 0x0C400,
        length: 0x0FF0,
        checksum: 0x0D3F2,
        mirror: 0x23F1A,
    },
    Block {
        offset: 0x0D400,
        length: 0x0FF0,
        checksum: 0x0E3F2,
        mirror: 0x23F1C,
    },
    Block {
        offset: 0x0E400,
        length: 0x0FF0,
        checksum: 0x0F3F2,
        mirror: 0x23F1E,
    },
    Block {
        offset: 0x0F400,
        length: 0x0FF0,
        checksum: 0x103F2,
        mirror: 0x23F20,
    },
    Block {
        offset: 0x10400,
        length: 0x0FF0,
        checksum: 0x113F2,
        mirror: 0x23F22,
    },
    Block {
        offset: 0x11400,
        length: 0x0FF0,
        checksum: 0x123F2,
        mirror: 0x23F24,
    },
    Block {
        offset: 0x12400,
        length: 0x0FF0,
        checksum: 0x133F2,
        mirror: 0x23F26,
    },
    Block {
        offset: 0x13400,
        length: 0x0FF0,
        checksum: 0x143F2,
        mirror: 0x23F28,
    },
    Block {
        offset: 0x14400,
        length: 0x0FF0,
        checksum: 0x153F2,
        mirror: 0x23F2A,
    },
    Block {
        offset: 0x15400,
        length: 0x0FF0,
        checksum: 0x163F2,
        mirror: 0x23F2C,
    },
    Block {
        offset: 0x16400,
        length: 0x0FF0,
        checksum: 0x173F2,
        mirror: 0x23F2E,
    },
    Block {
        offset: 0x17400,
        length: 0x0FF0,
        checksum: 0x183F2,
        mirror: 0x23F30,
    },
    Block {
        offset: 0x18400,
        length: 0x09C0,
        checksum: 0x18DC2,
        mirror: 0x23F32,
    },
    Block {
        offset: 0x18E00,
        length: 0x0534,
        checksum: 0x19336,
        mirror: 0x23F34,
    },
    Block {
        offset: 0x19400,
        length: 0x0068,
        checksum: 0x1946A,
        mirror: 0x23F36,
    },
    Block {
        offset: 0x19500,
        length: 0x009C,
        checksum: 0x1959E,
        mirror: 0x23F38,
    },
    Block {
        offset: 0x19600,
        length: 0x1338,
        checksum: 0x1A93A,
        mirror: 0x23F3A,
    },
    Block {
        offset: 0x1AA00,
        length: 0x07C4,
        checksum: 0x1B1C6,
        mirror: 0x23F3C,
    },
    Block {
        offset: 0x1B200,
        length: 0x0D54,
        checksum: 0x1BF56,
        mirror: 0x23F3E,
    },
    Block {
        offset: 0x1C000,
        length: 0x002C,
        checksum: 0x1C02E,
        mirror: 0x23F40,
    },
    Block {
        offset: 0x1C100,
        length: 0x0658,
        checksum: 0x1C75A,
        mirror: 0x23F42,
    },
    Block {
        offset: 0x1C800,
        length: 0x0A94,
        checksum: 0x1D296,
        mirror: 0x23F44,
    },
    Block {
        offset: 0x1D300,
        length: 0x01AC,
        checksum: 0x1D4AE,
        mirror: 0x23F46,
    },
    Block {
        offset: 0x1D500,
        length: 0x03EC,
        checksum: 0x1D8EE,
        mirror: 0x23F48,
    },
    Block {
        offset: 0x1D900,
        length: 0x005C,
        checksum: 0x1D95E,
        mirror: 0x23F4A,
    },
    Block {
        offset: 0x1DA00,
        length: 0x01E0,
        checksum: 0x1DBE2,
        mirror: 0x23F4C,
    },
    Block {
        offset: 0x1DC00,
        length: 0x00A8,
        checksum: 0x1DCAA,
        mirror: 0x23F4E,
    },
    Block {
        offset: 0x1DD00,
        length: 0x0460,
        checksum: 0x1E162,
        mirror: 0x23F50,
    },
    Block {
        offset: 0x1E200,
        length: 0x1400,
        checksum: 0x1F602,
        mirror: 0x23F52,
    },
    Block {
        offset: 0x1F700,
        length: 0x02A4,
        checksum: 0x1F9A6,
        mirror: 0x23F54,
    },
    Block {
        offset: 0x1FA00,
        length: 0x02DC,
        checksum: 0x1FCDE,
        mirror: 0x23F56,
    },
    Block {
        offset: 0x1FD00,
        length: 0x034C,
        checksum: 0x2004E,
        mirror: 0x23F58,
    },
    Block {
        offset: 0x20100,
        length: 0x03EC,
        checksum: 0x204EE,
        mirror: 0x23F5A,
    },
    Block {
        offset: 0x20500,
        length: 0x00F8,
        checksum: 0x205FA,
        mirror: 0x23F5C,
    },
    Block {
        offset: 0x20600,
        length: 0x02FC,
        checksum: 0x208FE,
        mirror: 0x23F5E,
    },
    Block {
        offset: 0x20900,
        length: 0x0094,
        checksum: 0x20996,
        mirror: 0x23F60,
    },
    Block {
        offset: 0x20A00,
        length: 0x035C,
        checksum: 0x20D5E,
        mirror: 0x23F62,
    },
    Block {
        offset: 0x20E00,
        length: 0x01CC,
        checksum: 0x20FCE,
        mirror: 0x23F64,
    },
    Block {
        offset: 0x21000,
        length: 0x0168,
        checksum: 0x2116A,
        mirror: 0x23F66,
    },
    Block {
        offset: 0x21200,
        length: 0x00EC,
        checksum: 0x212EE,
        mirror: 0x23F68,
    },
    Block {
        offset: 0x21300,
        length: 0x01B0,
        checksum: 0x214B2,
        mirror: 0x23F6A,
    },
    Block {
        offset: 0x21500,
        length: 0x001C,
        checksum: 0x2151E,
        mirror: 0x23F6C,
    },
    Block {
        offset: 0x21600,
        length: 0x04D4,
        checksum: 0x21AD6,
        mirror: 0x23F6E,
    },
    Block {
        offset: 0x21B00,
        length: 0x0034,
        checksum: 0x21B36,
        mirror: 0x23F70,
    },
    Block {
        offset: 0x21C00,
        length: 0x003C,
        checksum: 0x21C3E,
        mirror: 0x23F72,
    },
    Block {
        offset: 0x21D00,
        length: 0x01AC,
        checksum: 0x21EAE,
        mirror: 0x23F74,
    },
    Block {
        offset: 0x21F00,
        length: 0x0B90,
        checksum: 0x22A92,
        mirror: 0x23F76,
    },
    Block {
        offset: 0x22B00,
        length: 0x009C,
        checksum: 0x22B9E,
        mirror: 0x23F78,
    },
    Block {
        offset: 0x22C00,
        length: 0x0850,
        checksum: 0x23452,
        mirror: 0x23F7A,
    },
    Block {
        offset: 0x23500,
        length: 0x0028,
        checksum: 0x2352A,
        mirror: 0x23F7C,
    },
    Block {
        offset: 0x23600,
        length: 0x0284,
        checksum: 0x23886,
        mirror: 0x23F7E,
    },
    Block {
        offset: 0x23900,
        length: 0x0010,
        checksum: 0x23912,
        mirror: 0x23F80,
    },
    Block {
        offset: 0x23A00,
        length: 0x005C,
        checksum: 0x23A5E,
        mirror: 0x23F82,
    },
    Block {
        offset: 0x23B00,
        length: 0x016C,
        checksum: 0x23C6E,
        mirror: 0x23F84,
    },
    Block {
        offset: 0x23D00,
        length: 0x0040,
        checksum: 0x23D42,
        mirror: 0x23F86,
    },
    Block {
        offset: 0x23E00,
        length: 0x00FC,
        checksum: 0x23EFE,
        mirror: 0x23F88,
    },
    Block {
        offset: 0x23F00,
        length: 0x008C,
        checksum: 0x23F9A,
        mirror: 0x23F9A,
    },
];

const B2W2_BLOCKS: [Block; 74] = [
    Block {
        offset: 0x00000,
        length: 0x03e0,
        checksum: 0x003E2,
        mirror: 0x25F00,
    },
    Block {
        offset: 0x00400,
        length: 0x0ff0,
        checksum: 0x013F2,
        mirror: 0x25F02,
    },
    Block {
        offset: 0x01400,
        length: 0x0ff0,
        checksum: 0x023F2,
        mirror: 0x25F04,
    },
    Block {
        offset: 0x02400,
        length: 0x0ff0,
        checksum: 0x033F2,
        mirror: 0x25F06,
    },
    Block {
        offset: 0x03400,
        length: 0x0ff0,
        checksum: 0x043F2,
        mirror: 0x25F08,
    },
    Block {
        offset: 0x04400,
        length: 0x0ff0,
        checksum: 0x053F2,
        mirror: 0x25F0A,
    },
    Block {
        offset: 0x05400,
        length: 0x0ff0,
        checksum: 0x063F2,
        mirror: 0x25F0C,
    },
    Block {
        offset: 0x06400,
        length: 0x0ff0,
        checksum: 0x073F2,
        mirror: 0x25F0E,
    },
    Block {
        offset: 0x07400,
        length: 0x0ff0,
        checksum: 0x083F2,
        mirror: 0x25F10,
    },
    Block {
        offset: 0x08400,
        length: 0x0ff0,
        checksum: 0x093F2,
        mirror: 0x25F12,
    },
    Block {
        offset: 0x09400,
        length: 0x0ff0,
        checksum: 0x0A3F2,
        mirror: 0x25F14,
    },
    Block {
        offset: 0x0A400,
        length: 0x0ff0,
        checksum: 0x0B3F2,
        mirror: 0x25F16,
    },
    Block {
        offset: 0x0B400,
        length: 0x0ff0,
        checksum: 0x0C3F2,
        mirror: 0x25F18,
    },
    Block {
        offset: 0x0C400,
        length: 0x0ff0,
        checksum: 0x0D3F2,
        mirror: 0x25F1A,
    },
    Block {
        offset: 0x0D400,
        length: 0x0ff0,
        checksum: 0x0E3F2,
        mirror: 0x25F1C,
    },
    Block {
        offset: 0x0E400,
        length: 0x0ff0,
        checksum: 0x0F3F2,
        mirror: 0x25F1E,
    },
    Block {
        offset: 0x0F400,
        length: 0x0ff0,
        checksum: 0x103F2,
        mirror: 0x25F20,
    },
    Block {
        offset: 0x10400,
        length: 0x0ff0,
        checksum: 0x113F2,
        mirror: 0x25F22,
    },
    Block {
        offset: 0x11400,
        length: 0x0ff0,
        checksum: 0x123F2,
        mirror: 0x25F24,
    },
    Block {
        offset: 0x12400,
        length: 0x0ff0,
        checksum: 0x133F2,
        mirror: 0x25F26,
    },
    Block {
        offset: 0x13400,
        length: 0x0ff0,
        checksum: 0x143F2,
        mirror: 0x25F28,
    },
    Block {
        offset: 0x14400,
        length: 0x0ff0,
        checksum: 0x153F2,
        mirror: 0x25F2A,
    },
    Block {
        offset: 0x15400,
        length: 0x0ff0,
        checksum: 0x163F2,
        mirror: 0x25F2C,
    },
    Block {
        offset: 0x16400,
        length: 0x0ff0,
        checksum: 0x173F2,
        mirror: 0x25F2E,
    },
    Block {
        offset: 0x17400,
        length: 0x0ff0,
        checksum: 0x183F2,
        mirror: 0x25F30,
    },
    Block {
        offset: 0x18400,
        length: 0x09ec,
        checksum: 0x18DEE,
        mirror: 0x25F32,
    },
    Block {
        offset: 0x18E00,
        length: 0x0534,
        checksum: 0x19336,
        mirror: 0x25F34,
    },
    Block {
        offset: 0x19400,
        length: 0x00b0,
        checksum: 0x194B2,
        mirror: 0x25F36,
    },
    Block {
        offset: 0x19500,
        length: 0x00a8,
        checksum: 0x195AA,
        mirror: 0x25F38,
    },
    Block {
        offset: 0x19600,
        length: 0x1338,
        checksum: 0x1A93A,
        mirror: 0x25F3A,
    },
    Block {
        offset: 0x1AA00,
        length: 0x07c4,
        checksum: 0x1B1C6,
        mirror: 0x25F3C,
    },
    Block {
        offset: 0x1B200,
        length: 0x0d54,
        checksum: 0x1BF56,
        mirror: 0x25F3E,
    },
    Block {
        offset: 0x1C000,
        length: 0x0094,
        checksum: 0x1C096,
        mirror: 0x25F40,
    },
    Block {
        offset: 0x1C100,
        length: 0x0658,
        checksum: 0x1C75A,
        mirror: 0x25F42,
    },
    Block {
        offset: 0x1C800,
        length: 0x0a94,
        checksum: 0x1D296,
        mirror: 0x25F44,
    },
    Block {
        offset: 0x1D300,
        length: 0x01ac,
        checksum: 0x1D4AE,
        mirror: 0x25F46,
    },
    Block {
        offset: 0x1D500,
        length: 0x03ec,
        checksum: 0x1D8EE,
        mirror: 0x25F48,
    },
    Block {
        offset: 0x1D900,
        length: 0x005c,
        checksum: 0x1D95E,
        mirror: 0x25F4A,
    },
    Block {
        offset: 0x1DA00,
        length: 0x01e0,
        checksum: 0x1DBE2,
        mirror: 0x25F4C,
    },
    Block {
        offset: 0x1DC00,
        length: 0x00a8,
        checksum: 0x1DCAA,
        mirror: 0x25F4E,
    },
    Block {
        offset: 0x1DD00,
        length: 0x0460,
        checksum: 0x1E162,
        mirror: 0x25F50,
    },
    Block {
        offset: 0x1E200,
        length: 0x1400,
        checksum: 0x1F602,
        mirror: 0x25F52,
    },
    Block {
        offset: 0x1F700,
        length: 0x02a4,
        checksum: 0x1F9A6,
        mirror: 0x25F54,
    },
    Block {
        offset: 0x1FA00,
        length: 0x00e0,
        checksum: 0x1FAE2,
        mirror: 0x25F56,
    },
    Block {
        offset: 0x1FB00,
        length: 0x034c,
        checksum: 0x1FE4E,
        mirror: 0x25F58,
    },
    Block {
        offset: 0x1FF00,
        length: 0x04e0,
        checksum: 0x203E2,
        mirror: 0x25F5A,
    },
    Block {
        offset: 0x20400,
        length: 0x00f8,
        checksum: 0x204FA,
        mirror: 0x25F5C,
    },
    Block {
        offset: 0x20500,
        length: 0x02fc,
        checksum: 0x207FE,
        mirror: 0x25F5E,
    },
    Block {
        offset: 0x20800,
        length: 0x0094,
        checksum: 0x20896,
        mirror: 0x25F60,
    },
    Block {
        offset: 0x20900,
        length: 0x035c,
        checksum: 0x20C5E,
        mirror: 0x25F62,
    },
    Block {
        offset: 0x20D00,
        length: 0x01d4,
        checksum: 0x20ED6,
        mirror: 0x25F64,
    },
    Block {
        offset: 0x20F00,
        length: 0x01e0,
        checksum: 0x210E2,
        mirror: 0x25F66,
    },
    Block {
        offset: 0x21100,
        length: 0x00f0,
        checksum: 0x211F2,
        mirror: 0x25F68,
    },
    Block {
        offset: 0x21200,
        length: 0x01b4,
        checksum: 0x213B6,
        mirror: 0x25F6A,
    },
    Block {
        offset: 0x21400,
        length: 0x04dc,
        checksum: 0x218DE,
        mirror: 0x25F6C,
    },
    Block {
        offset: 0x21900,
        length: 0x0034,
        checksum: 0x21936,
        mirror: 0x25F6E,
    },
    Block {
        offset: 0x21A00,
        length: 0x003c,
        checksum: 0x21A3E,
        mirror: 0x25F70,
    },
    Block {
        offset: 0x21B00,
        length: 0x01ac,
        checksum: 0x21CAE,
        mirror: 0x25F72,
    },
    Block {
        offset: 0x21D00,
        length: 0x0b90,
        checksum: 0x22892,
        mirror: 0x25F74,
    },
    Block {
        offset: 0x22900,
        length: 0x00ac,
        checksum: 0x229AE,
        mirror: 0x25F76,
    },
    Block {
        offset: 0x22A00,
        length: 0x0850,
        checksum: 0x23252,
        mirror: 0x25F78,
    },
    Block {
        offset: 0x23300,
        length: 0x0284,
        checksum: 0x23586,
        mirror: 0x25F7A,
    },
    Block {
        offset: 0x23600,
        length: 0x0010,
        checksum: 0x23612,
        mirror: 0x25F7C,
    },
    Block {
        offset: 0x23700,
        length: 0x00a8,
        checksum: 0x237AA,
        mirror: 0x25F7E,
    },
    Block {
        offset: 0x23800,
        length: 0x016c,
        checksum: 0x2396E,
        mirror: 0x25F80,
    },
    Block {
        offset: 0x23A00,
        length: 0x0080,
        checksum: 0x23A82,
        mirror: 0x25F82,
    },
    Block {
        offset: 0x23B00,
        length: 0x00fc,
        checksum: 0x23BFE,
        mirror: 0x25F84,
    },
    Block {
        offset: 0x23C00,
        length: 0x16a8,
        checksum: 0x252AA,
        mirror: 0x25F86,
    },
    Block {
        offset: 0x25300,
        length: 0x0498,
        checksum: 0x2579A,
        mirror: 0x25F88,
    },
    Block {
        offset: 0x25800,
        length: 0x0060,
        checksum: 0x25862,
        mirror: 0x25F8A,
    },
    Block {
        offset: 0x25900,
        length: 0x00fc,
        checksum: 0x259FE,
        mirror: 0x25F8C,
    },
    Block {
        offset: 0x25A00,
        length: 0x03e4,
        checksum: 0x25DE6,
        mirror: 0x25F8E,
    },
    Block {
        offset: 0x25E00,
        length: 0x00f0,
        checksum: 0x25EF2,
        mirror: 0x25F90,
    },
    Block {
        offset: 0x25F00,
        length: 0x0094,
        checksum: 0x25FA2,
        mirror: 0x25FA2,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(title: Title) -> Vec<u8> {
        let mut bytes = vec![0xff; GEN5_SAVE_SIZE];
        for block in title.layout().blocks() {
            bytes[block.offset..block.offset + block.length].fill(0);
        }
        encode_trainer_name(
            "Hilbert",
            &mut bytes[TRAINER_OFFSET + 4..TRAINER_OFFSET + 0x14],
        )
        .unwrap();
        write_u32(&mut bytes, TRAINER_OFFSET + 0x14, 0x5678_1234);
        bytes[TRAINER_OFFSET + 0x1f] = title.version();
        bytes[TRAINER_OFFSET + 0x21] = 0;
        write_u16(&mut bytes, TRAINER_OFFSET + 0x24, 12);
        bytes[TRAINER_OFFSET + 0x26] = 34;
        bytes[TRAINER_OFFSET + 0x27] = 56;
        write_u32(&mut bytes, title.layout().misc_offset(), 123_456);
        bytes[title.layout().misc_offset() + 4] = 0b0000_0101;
        write_u16(&mut bytes, title.layout().battle_points_offset(), 789);
        write_u16(&mut bytes, INVENTORY_OFFSET, 1);
        write_u16(&mut bytes, INVENTORY_OFFSET + 2, 20);
        for block in title.layout().blocks() {
            let crc = crc16_ccitt(&bytes[block.offset..block.offset + block.length]);
            write_u16(&mut bytes, block.checksum, crc);
            write_u16(&mut bytes, block.mirror, crc);
        }
        bytes
    }

    fn input(title: Title) -> SaveDetectionInput {
        SaveDetectionInput {
            bytes: fixture(title),
            selected_game: Some(title.id().into()),
            rom_sha1: None,
        }
    }

    #[test]
    fn crc_matches_independent_ccitt_false_vector() {
        assert_eq!(crc16_ccitt(b"123456789"), 0x29b1);
    }

    #[test]
    fn recognizes_each_version_from_the_stored_game_identifier() {
        for title in Title::ALL {
            let mut value = input(title);
            value.selected_game = None;
            let recognition = PokemonGen5Handler.recognize(&value);
            assert!(
                matches!(recognition.outcome, SaveRecognitionOutcome::Recognized { ref candidate } if candidate.identity.id == title.id())
            );
            assert_eq!(
                PokemonGen5Handler
                    .parse(&value, &title.identity())
                    .unwrap()
                    .sections
                    .len(),
                title.layout().blocks().len()
            );
        }
    }

    #[test]
    fn rejects_zero_filled_and_mismatched_or_corrupt_saves() {
        let zero = SaveDetectionInput {
            bytes: vec![0; GEN5_SAVE_SIZE],
            selected_game: None,
            rom_sha1: None,
        };
        assert!(matches!(
            PokemonGen5Handler.recognize(&zero).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));

        let value = input(Title::Black);
        assert!(
            PokemonGen5Handler
                .parse(&value, &Title::White.identity())
                .is_err()
        );

        let mut corrupt = value;
        corrupt.bytes[BW_BLOCKS[27].mirror] ^= 1;
        assert!(
            PokemonGen5Handler
                .parse(&corrupt, &Title::Black.identity())
                .is_err()
        );

        let mut corrupt_data = input(Title::Black);
        corrupt_data.bytes[TRAINER_OFFSET] ^= 1;
        assert!(
            PokemonGen5Handler
                .parse(&corrupt_data, &Title::Black.identity())
                .is_err()
        );

        let mut corrupt_table = input(Title::Black);
        corrupt_table.bytes[BW_BLOCKS.last().unwrap().offset] ^= 1;
        assert!(
            PokemonGen5Handler
                .parse(&corrupt_table, &Title::Black.identity())
                .is_err()
        );

        let mut unknown = input(Title::Black);
        unknown.selected_game = Some("pokemon-unknown".into());
        assert!(matches!(
            PokemonGen5Handler.recognize(&unknown).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));

        let mut mismatch = input(Title::Black);
        mismatch.selected_game = Some(Title::White.id().into());
        assert!(matches!(
            PokemonGen5Handler.recognize(&mismatch).outcome,
            SaveRecognitionOutcome::Unsupported { .. }
        ));
    }

    #[test]
    fn edits_boundary_values_repairs_both_checksums_and_preserves_other_bytes() {
        for title in Title::ALL {
            let value = input(title);
            let before = value.bytes.clone();
            let edits = vec![
                SaveEdit {
                    field: "trainer.name".into(),
                    value: SaveValue::Text("Touko".into()),
                },
                SaveEdit {
                    field: "trainer.id".into(),
                    value: SaveValue::U32(u16::MAX as u32),
                },
                SaveEdit {
                    field: "trainer.secret_id".into(),
                    value: SaveValue::U32(0),
                },
                SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(MAX_MONEY),
                },
                SaveEdit {
                    field: "trainer.gender".into(),
                    value: SaveValue::Enum("female".into()),
                },
                SaveEdit {
                    field: "trainer.play_time_hours".into(),
                    value: SaveValue::U32(u16::MAX as u32),
                },
                SaveEdit {
                    field: "trainer.play_time_minutes".into(),
                    value: SaveValue::U32(59),
                },
                SaveEdit {
                    field: "trainer.play_time_seconds".into(),
                    value: SaveValue::U32(59),
                },
                SaveEdit {
                    field: "progress.battle_points".into(),
                    value: SaveValue::U32(MAX_BATTLE_POINTS),
                },
                SaveEdit {
                    field: "progress.badge_8".into(),
                    value: SaveValue::Bool(true),
                },
                SaveEdit {
                    field: "inventory.items.slot_0.item_id".into(),
                    value: SaveValue::U32(title.layout().max_item_id()),
                },
                SaveEdit {
                    field: "inventory.items.slot_0.quantity".into(),
                    value: SaveValue::U32(999),
                },
            ];
            let result = PokemonGen5Handler
                .apply(&value, &title.identity(), &edits, false)
                .unwrap();
            let output = result.bytes.unwrap();
            assert!(
                result
                    .preview
                    .touched_sections
                    .contains(&((title.layout().blocks().len() - 1) as u8))
            );
            assert_eq!(
                field_value(&result.document, "trainer.money"),
                Some(&SaveValue::U32(MAX_MONEY))
            );
            assert_eq!(output[0x30000], before[0x30000]);
            for (index, (old, new)) in before.iter().zip(&output).enumerate() {
                let changed_data = (TRAINER_OFFSET + 4..TRAINER_OFFSET + 0x28).contains(&index)
                    || (INVENTORY_OFFSET..INVENTORY_OFFSET + 4).contains(&index)
                    || (title.layout().misc_offset()..title.layout().misc_offset() + 5)
                        .contains(&index)
                    || (title.layout().battle_points_offset()
                        ..title.layout().battle_points_offset() + 2)
                        .contains(&index);
                let changed_checksum = title.layout().blocks().iter().any(|block| {
                    (block.checksum..block.checksum + 2).contains(&index)
                        || (block.mirror..block.mirror + 2).contains(&index)
                });
                if !changed_data && !changed_checksum {
                    assert_eq!(new, old, "unexpected byte change at {index:#x}");
                }
            }
            for section in &result.preview.touched_sections {
                let block = title.layout().blocks()[usize::from(*section)];
                let crc = crc16_ccitt(&output[block.offset..block.offset + block.length]);
                assert_eq!(read_u16(&output, block.checksum), crc);
                assert_eq!(read_u16(&output, block.mirror), crc);
            }
            assert!(validate_save(&output, title).is_ok());
        }
    }

    #[test]
    fn dry_run_returns_no_bytes_and_does_not_mutate_the_input() {
        let value = input(Title::White2);
        let before = value.bytes.clone();
        let result = PokemonGen5Handler
            .apply(
                &value,
                &Title::White2.identity(),
                &[SaveEdit {
                    field: "trainer.money".into(),
                    value: SaveValue::U32(1),
                }],
                true,
            )
            .unwrap();
        assert!(result.bytes.is_none());
        assert_eq!(value.bytes, before);
        assert_eq!(
            field_value(&result.document, "trainer.money"),
            Some(&SaveValue::U32(1))
        );
    }

    #[test]
    fn exposes_native_and_browser_editable_scalar_inventory_schema() {
        for title in Title::ALL {
            let document = PokemonGen5Handler
                .parse(&input(title), &title.identity())
                .unwrap();
            assert_eq!(
                field_value(&document, "inventory.items.slot_0.item_id"),
                Some(&SaveValue::U32(1))
            );
            assert_eq!(
                field_value(&document, "inventory.items.slot_0.quantity"),
                Some(&SaveValue::U32(20))
            );
            assert_eq!(
                field_value(&document, "inventory.items.slot_1.item_id"),
                Some(&SaveValue::U32(0))
            );
            for pocket in title.layout().inventory_pockets() {
                assert!(
                    field_value(
                        &document,
                        &format!("inventory.{}.slot_0.item_id", pocket.name)
                    )
                    .is_some()
                );
                assert!(
                    field_value(
                        &document,
                        &format!(
                            "inventory.{}.slot_{}.quantity",
                            pocket.name,
                            pocket.count - 1
                        )
                    )
                    .is_some()
                );
                assert!(
                    field_value(
                        &document,
                        &format!("inventory.{}.slot_{}.item_id", pocket.name, pocket.count)
                    )
                    .is_none()
                );
            }
            for field in document
                .fields
                .iter()
                .filter(|field| field.id.starts_with("inventory."))
            {
                assert_eq!(field.kind, SaveFieldKind::UnsignedInteger);
                assert!(field.editable);
                assert!(matches!(field.value, SaveValue::U32(_)));
            }
            let browser_document = serde_json::to_value(&document).unwrap();
            let browser_fields = browser_document["fields"].as_array().unwrap();
            let first_item = browser_fields
                .iter()
                .find(|field| field["id"] == "inventory.items.slot_0.item_id")
                .unwrap();
            assert_eq!(first_item["kind"], "unsigned_integer");
            assert_eq!(first_item["value"]["u32"], 1);
        }
    }

    #[test]
    fn edits_each_pocket_boundary_without_exposing_or_changing_padding() {
        for title in Title::ALL {
            let mut value = input(title);
            let pockets = title.layout().inventory_pockets();
            let inventory_end = title.layout().blocks()[25].length;
            let mut padding = Vec::new();
            for (index, pocket) in pockets.iter().enumerate() {
                let data_end = pocket.offset + pocket.count * 4;
                let next_offset = pockets
                    .get(index + 1)
                    .map_or(inventory_end, |next| next.offset);
                for relative in data_end..next_offset {
                    value.bytes[INVENTORY_OFFSET + relative] = 0xa5;
                    padding.push(INVENTORY_OFFSET + relative);
                }
            }
            repair_touched_blocks(&mut value.bytes, title.layout(), &[25]);
            let before = value.bytes.clone();
            let mut edits = Vec::new();
            for pocket in pockets {
                for slot in [0, pocket.count - 1] {
                    edits.push(SaveEdit {
                        field: format!("inventory.{}.slot_{slot}.item_id", pocket.name),
                        value: SaveValue::U32(1),
                    });
                    edits.push(SaveEdit {
                        field: format!("inventory.{}.slot_{slot}.quantity", pocket.name),
                        value: SaveValue::U32(pocket.max_quantity),
                    });
                }
            }
            let result = PokemonGen5Handler
                .apply(&value, &title.identity(), &edits, false)
                .unwrap();
            let output = result.bytes.unwrap();
            for offset in padding {
                assert_eq!(
                    output[offset], before[offset],
                    "padding changed at {offset:#x}"
                );
            }
        }
    }

    #[test]
    fn trainer_name_round_trips_utf16_and_rejects_too_many_code_units() {
        let value = input(Title::Black2);
        let result = PokemonGen5Handler
            .apply(
                &value,
                &Title::Black2.identity(),
                &[SaveEdit {
                    field: "trainer.name".into(),
                    value: SaveValue::Text("A♀é".into()),
                }],
                false,
            )
            .unwrap();
        assert_eq!(
            field_value(&result.document, "trainer.name"),
            Some(&SaveValue::Text("A♀é".into()))
        );

        let error = PokemonGen5Handler.apply(
            &value,
            &Title::Black2.identity(),
            &[SaveEdit {
                field: "trainer.name".into(),
                value: SaveValue::Text("😀😀😀😀".into()),
            }],
            false,
        );
        assert!(error.is_err());
    }
}
