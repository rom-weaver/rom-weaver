use tracing::{debug, trace};

use super::formats::GAME_BOY_SRAM_32K;
use super::{
    SaveConstraint, SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField,
    SaveFieldKind, SaveGameCandidate, SaveGameDefinition, SaveGameHandler, SaveGameIdentity,
    SaveIntegrity, SaveIntegrityIssue, SaveIntegrityState, SaveRecognition,
    SaveRecognitionConfidence, SaveRecognitionOutcome, SaveRecognitionReason, SaveSection,
    SaveValue, validate_save_edits,
};
use crate::{Result, RomWeaverError, ValidationCodeError};

pub const GEN2_SAVE_SIZE: usize = GAME_BOY_SRAM_32K.supported_sizes[0];
const CHECK_VALUE_1: u8 = 99;
const CHECK_VALUE_2: u8 = 127;
const MAX_MONEY: u32 = 999_999;

// These offsets are assembled from pret's linked layouts. The main save starts in
// SRAM bank 1. Gold/Silver's backup spans banks 0, 1, and 3.
// https://github.com/pret/pokegold/blob/master/layout.link
// https://github.com/pret/pokecrystal/blob/master/layout.link
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Family {
    GoldSilver,
    Crystal,
}

#[derive(Clone, Copy, Debug)]
struct Span {
    offset: usize,
    len: usize,
}

#[derive(Clone, Copy, Debug)]
struct SlotLayout {
    player_one: Span,
    player_three: Span,
    checksum_data: &'static [Span],
    checksum_offset: usize,
    check_value_one: usize,
    check_value_two: usize,
}

const GS_MAIN_DATA: [Span; 1] = [Span {
    offset: 0x2009,
    len: 0xD60,
}];
const GS_BACKUP_DATA: [Span; 5] = [
    Span {
        offset: 0x10E8,
        len: 0x4DF,
    },
    Span {
        offset: 0x0C6B,
        len: 0x47D,
    },
    Span {
        offset: 0x15C7,
        len: 0x226,
    },
    Span {
        offset: 0x3D96,
        len: 0x1AA,
    },
    Span {
        offset: 0x7E39,
        len: 0x34,
    },
];
const CRYSTAL_MAIN_DATA: [Span; 1] = [Span {
    offset: 0x2009,
    len: 0xB7A,
}];
const CRYSTAL_BACKUP_DATA: [Span; 1] = [Span {
    offset: 0x1209,
    len: 0xB7A,
}];

const GS_MAIN: SlotLayout = SlotLayout {
    player_one: Span {
        offset: 0x2009,
        len: 0x226,
    },
    player_three: Span {
        offset: 0x23D9,
        len: 0x47D,
    },
    checksum_data: &GS_MAIN_DATA,
    checksum_offset: 0x2D69,
    check_value_one: 0x2008,
    check_value_two: 0x2D6B,
};
const GS_BACKUP: SlotLayout = SlotLayout {
    player_one: Span {
        offset: 0x15C7,
        len: 0x226,
    },
    player_three: Span {
        offset: 0x0C6B,
        len: 0x47D,
    },
    checksum_data: &GS_BACKUP_DATA,
    checksum_offset: 0x7E6D,
    check_value_one: 0x7E38,
    check_value_two: 0x7E6F,
};
const CRYSTAL_MAIN: SlotLayout = SlotLayout {
    player_one: Span {
        offset: 0x2009,
        len: 0x3CF,
    },
    player_three: Span {
        offset: 0x2009,
        len: 0xB7A,
    },
    checksum_data: &CRYSTAL_MAIN_DATA,
    checksum_offset: 0x2D0D,
    check_value_one: 0x2008,
    check_value_two: 0x2D0F,
};
const CRYSTAL_BACKUP: SlotLayout = SlotLayout {
    player_one: Span {
        offset: 0x1209,
        len: 0x3CF,
    },
    player_three: Span {
        offset: 0x1209,
        len: 0xB7A,
    },
    checksum_data: &CRYSTAL_BACKUP_DATA,
    checksum_offset: 0x1F0D,
    check_value_one: 0x1208,
    check_value_two: 0x1F0F,
};

pub struct PokemonGen2Handler;

impl SaveGameHandler for PokemonGen2Handler {
    fn definitions(&self) -> Vec<SaveGameDefinition> {
        [
            definition("pokemon-gold", "Pokémon Gold", "pokemon-gen2-gs"),
            definition("pokemon-silver", "Pokémon Silver", "pokemon-gen2-gs"),
            definition("pokemon-crystal", "Pokémon Crystal", "pokemon-gen2-crystal"),
        ]
        .into()
    }

    fn recognize(&self, input: &SaveDetectionInput) -> SaveRecognition {
        if !GAME_BOY_SRAM_32K.accepts(&input.bytes) {
            return unsupported(SaveRecognitionReason::WrongSize);
        }
        let requested = input.selected_game.as_deref();
        let mut candidates = Vec::new();
        for (family, ids) in [
            (
                Family::GoldSilver,
                [Some("pokemon-gold"), Some("pokemon-silver")],
            ),
            (Family::Crystal, [Some("pokemon-crystal"), None]),
        ] {
            if !slot_layouts(family)
                .iter()
                .any(|layout| valid_slot(&input.bytes, layout))
            {
                continue;
            }
            for id in ids.into_iter().flatten() {
                if requested.is_none() || requested == Some(id) {
                    candidates.push(SaveGameCandidate {
                        identity: identity(id),
                        confidence: SaveRecognitionConfidence::High,
                        reasons: vec![SaveRecognitionReason::ChecksumValid],
                    });
                }
            }
        }
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
        let family = family_for_game(game)?;
        let slots = parse_slots(&input.bytes, family)?;
        build_document(&input.bytes, family, game, slots)
    }

    fn apply(
        &self,
        input: &SaveDetectionInput,
        game: &SaveGameIdentity,
        edits: &[SaveEdit],
        dry_run: bool,
    ) -> Result<SaveEditResult> {
        let family = family_for_game(game)?;
        let slots = parse_slots(&input.bytes, family)?;
        let document = build_document(&input.bytes, family, game, slots)?;
        if !(slots.main && slots.backup) {
            return Err(validation(
                "save_integrity_partial",
                "normal edits need valid primary and backup save data",
            ));
        }
        let mut preview = validate_save_edits(&document, edits)?;
        if !preview.changed {
            return Ok(SaveEditResult {
                preview,
                bytes: None,
                document,
            });
        }
        preview.touched_sections = vec![0, 1];
        let mut bytes = input.bytes.clone();
        for layout in slot_layouts(family) {
            apply_to_slot(&mut bytes, family, layout, edits)?;
            repair_checksum(&mut bytes, layout);
        }
        let reparsed_slots = parse_slots(&bytes, family)?;
        let reparsed = build_document(&bytes, family, game, reparsed_slots)?;
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

#[derive(Clone, Copy, Debug)]
struct Slots {
    main: bool,
    backup: bool,
}

fn definition(id: &str, name: &str, family: &str) -> SaveGameDefinition {
    SaveGameDefinition {
        identity: SaveGameIdentity {
            id: id.into(),
            name: name.into(),
            family: family.into(),
        },
        platform: "game-boy-color".into(),
        save_format: GAME_BOY_SRAM_32K.id.into(),
        save_format_name: GAME_BOY_SRAM_32K.display_name.into(),
        handler_id: "pokemon-gen2".into(),
        supported_save_sizes: vec![GEN2_SAVE_SIZE as u32],
        known_rom_sha1: Vec::new(),
        checksum_sizes: Vec::new(),
    }
}

fn identity(id: &str) -> SaveGameIdentity {
    match id {
        "pokemon-gold" => definition(id, "Pokémon Gold", "pokemon-gen2-gs").identity,
        "pokemon-silver" => definition(id, "Pokémon Silver", "pokemon-gen2-gs").identity,
        "pokemon-crystal" => definition(id, "Pokémon Crystal", "pokemon-gen2-crystal").identity,
        _ => unreachable!("only defined Pokémon Gen II games reach this function"),
    }
}

fn family_for_game(game: &SaveGameIdentity) -> Result<Family> {
    match game.id.as_str() {
        "pokemon-gold" | "pokemon-silver" => Ok(Family::GoldSilver),
        "pokemon-crystal" => Ok(Family::Crystal),
        _ => Err(validation(
            "save_game_unsupported",
            "the selected save game is unsupported",
        )),
    }
}

fn slot_layouts(family: Family) -> [SlotLayout; 2] {
    match family {
        Family::GoldSilver => [GS_MAIN, GS_BACKUP],
        Family::Crystal => [CRYSTAL_MAIN, CRYSTAL_BACKUP],
    }
}

fn parse_slots(bytes: &[u8], family: Family) -> Result<Slots> {
    if !GAME_BOY_SRAM_32K.accepts(bytes) {
        return Err(validation(
            "save_wrong_size",
            "a Pokémon Gen II save must be exactly 32 KiB",
        ));
    }
    let [main_layout, backup_layout] = slot_layouts(family);
    let slots = Slots {
        main: valid_slot(bytes, &main_layout),
        backup: valid_slot(bytes, &backup_layout),
    };
    if !slots.main && !slots.backup {
        return Err(validation(
            "save_checksum",
            "the save has no valid primary or backup data",
        ));
    }
    Ok(slots)
}

fn valid_slot(bytes: &[u8], layout: &SlotLayout) -> bool {
    bytes.get(layout.check_value_one) == Some(&CHECK_VALUE_1)
        && bytes.get(layout.check_value_two) == Some(&CHECK_VALUE_2)
        && checksum(bytes, layout.checksum_data)
            == u16::from_le_bytes([
                bytes[layout.checksum_offset],
                bytes[layout.checksum_offset + 1],
            ])
}

fn checksum(bytes: &[u8], spans: &[Span]) -> u16 {
    spans
        .iter()
        .flat_map(|span| bytes[span.offset..span.offset + span.len].iter())
        .fold(0u16, |sum, byte| sum.wrapping_add(u16::from(*byte)))
}

fn repair_checksum(bytes: &mut [u8], layout: SlotLayout) {
    let value = checksum(bytes, layout.checksum_data);
    bytes[layout.checksum_offset..layout.checksum_offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn build_document(
    bytes: &[u8],
    family: Family,
    game: &SaveGameIdentity,
    slots: Slots,
) -> Result<SaveDocument> {
    let (layout, active_slot) = if slots.main {
        (slot_layouts(family)[0], 0)
    } else {
        (slot_layouts(family)[1], 1)
    };
    let name = decode_name(&read(bytes, layout.player_one, 2)[..11]);
    let money = read_u24(bytes, layout.player_three, money_offset(family));
    if money > MAX_MONEY {
        return Err(validation(
            "save_money",
            "the save has a money value above the game limit",
        ));
    }
    let mut fields = vec![read_only_text(
        "trainer.name",
        "Trainer name",
        2,
        name,
        "Trainer text. This layout does not edit names.",
    )];
    fields.push(read_only_integer(
        "trainer.id",
        "Trainer ID",
        0,
        read_u16_be(bytes, layout.player_one, 0) as u32,
        "Public trainer identifier",
    ));
    if family == Family::Crystal {
        fields.push(read_only_integer(
            "trainer.secret_id",
            "Secret ID",
            0x3CF,
            read_u16_be(bytes, layout.player_three, 0x3CF) as u32,
            "Hidden trainer identifier",
        ));
    }
    fields.push(SaveField {
        id: "trainer.money".into(),
        label: "Money".into(),
        section_id: 0,
        offset: money_offset(family) as u16,
        kind: SaveFieldKind::UnsignedInteger,
        value: SaveValue::U32(money),
        editable: slots.main && slots.backup,
        constraints: SaveConstraint {
            min: Some(0),
            max: Some(i64::from(MAX_MONEY)),
            ..Default::default()
        },
        description: "Money carried by the player".into(),
        warnings: edit_warning(slots),
        step: Some(1),
        encoding: Some("big_endian_u24".into()),
    });
    fields.push(read_only_text(
        "trainer.play_time",
        "Play time",
        play_time_cap_offset(family) as u16,
        format_play_time(bytes, layout.player_one, family),
        "Time played",
    ));
    for index in 0..16usize {
        let offset = badge_offset(family) + index / 8;
        let value = read(bytes, layout.player_three, offset)[0] & (1 << (index % 8)) != 0;
        fields.push(SaveField {
            id: format!("progress.badge_{}", index + 1),
            label: format!("Badge {}", index + 1),
            section_id: 0,
            offset: offset as u16,
            kind: SaveFieldKind::BitfieldBoolean,
            value: SaveValue::Bool(value),
            editable: slots.main && slots.backup,
            constraints: SaveConstraint::default(),
            description: if index < 8 {
                "Johto Gym Badge flag".into()
            } else {
                "Kanto Gym Badge flag".into()
            },
            warnings: edit_warning(slots),
            step: None,
            encoding: None,
        });
    }
    let sections = slot_layouts(family)
        .into_iter()
        .enumerate()
        .map(|(id, slot)| {
            let expected =
                u16::from_le_bytes([bytes[slot.checksum_offset], bytes[slot.checksum_offset + 1]]);
            SaveSection {
                id: id as u8,
                physical_offset: slot.checksum_data[0].offset as u32,
                checksum_expected: expected,
                checksum_actual: checksum(bytes, slot.checksum_data),
                signature: 0,
                counter: 0,
                valid: valid_slot(bytes, &slot),
            }
        })
        .collect();
    let integrity = if slots.main && slots.backup {
        SaveIntegrity {
            state: SaveIntegrityState::Valid,
            issues: Vec::new(),
        }
    } else {
        SaveIntegrity {
            state: SaveIntegrityState::PartiallyRecoverable,
            issues: vec![SaveIntegrityIssue {
                code: "redundant_slot_invalid".into(),
                message: "One primary or backup save copy failed integrity checks".into(),
                section_id: None,
            }],
        }
    };
    trace!(game = %game.id, active_slot, "validated Pokémon Gen II save");
    debug!(game = %game.id, active_slot, "parsed Pokémon Gen II save");
    Ok(SaveDocument {
        identity: game.clone(),
        active_slot,
        counter: 0,
        integrity,
        sections,
        fields,
        platform: "game-boy-color".into(),
        save_format: GAME_BOY_SRAM_32K.id.into(),
        save_format_name: GAME_BOY_SRAM_32K.display_name.into(),
        handler_id: "pokemon-gen2".into(),
        save_size: GEN2_SAVE_SIZE as u32,
        warnings: if slots.main && slots.backup {
            Vec::new()
        } else {
            vec!["One save copy is invalid; editing is disabled".into()]
        },
    })
}

fn apply_to_slot(
    bytes: &mut [u8],
    family: Family,
    layout: SlotLayout,
    edits: &[SaveEdit],
) -> Result<()> {
    for edit in edits {
        match (&*edit.field, &edit.value) {
            ("trainer.money", SaveValue::U32(value)) => {
                write_u24(bytes, layout.player_three, money_offset(family), *value)
            }
            (field, SaveValue::Bool(value)) if field.starts_with("progress.badge_") => {
                let index = field[15..]
                    .parse::<usize>()
                    .ok()
                    .and_then(|number| number.checked_sub(1))
                    .filter(|number| *number < 16)
                    .ok_or_else(|| {
                        validation("save_field_unknown", "the requested badge field is unknown")
                    })?;
                let byte =
                    &mut read_mut(bytes, layout.player_three, badge_offset(family) + index / 8)[0];
                if *value {
                    *byte |= 1 << (index % 8);
                } else {
                    *byte &= !(1 << (index % 8));
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

fn money_offset(family: Family) -> usize {
    match family {
        Family::GoldSilver => 2,
        Family::Crystal => 0x3D3,
    }
}

fn badge_offset(family: Family) -> usize {
    match family {
        Family::GoldSilver => 0x0B,
        Family::Crystal => 0x3DC,
    }
}

fn read(bytes: &[u8], span: Span, relative: usize) -> &[u8] {
    &bytes[span.offset + relative..span.offset + span.len]
}

fn read_mut(bytes: &mut [u8], span: Span, relative: usize) -> &mut [u8] {
    let start = span.offset + relative;
    let end = span.offset + span.len;
    &mut bytes[start..end]
}

fn read_u16_be(bytes: &[u8], span: Span, relative: usize) -> u16 {
    u16::from_be_bytes([
        read(bytes, span, relative)[0],
        read(bytes, span, relative)[1],
    ])
}

fn read_u24(bytes: &[u8], span: Span, relative: usize) -> u32 {
    let value = read(bytes, span, relative);
    u32::from_be_bytes([0, value[0], value[1], value[2]])
}

fn write_u24(bytes: &mut [u8], span: Span, relative: usize, value: u32) {
    read_mut(bytes, span, relative)[..3].copy_from_slice(&value.to_be_bytes()[1..]);
}

fn play_time_cap_offset(family: Family) -> usize {
    match family {
        Family::GoldSilver => 0x49,
        Family::Crystal => 0x48,
    }
}

fn format_play_time(bytes: &[u8], span: Span, family: Family) -> String {
    let hours = play_time_cap_offset(family) + 1;
    format!(
        "{}:{:02}:{:02}:{:02}",
        read_u16_be(bytes, span, hours),
        read(bytes, span, hours + 2)[0],
        read(bytes, span, hours + 3)[0],
        read(bytes, span, hours + 4)[0],
    )
}

fn decode_name(bytes: &[u8]) -> String {
    let mut output = String::new();
    for byte in bytes {
        if *byte == 0x50 {
            return output;
        }
        let character = match byte {
            0x80..=0x99 => (*byte - 0x80 + b'A') as char,
            0xA0..=0xB9 => (*byte - 0xA0 + b'a') as char,
            0xF6..=0xFF => (*byte - 0xF6 + b'0') as char,
            0x7F => ' ',
            0x9A => '(',
            0x9B => ')',
            0x9C => ':',
            0x9D => ';',
            0x9E => '[',
            0x9F => ']',
            0xC0 => 'Ä',
            0xC1 => 'Ö',
            0xC2 => 'Ü',
            0xC3 => 'ä',
            0xC4 => 'ö',
            0xC5 => 'ü',
            0xDF => '←',
            0xE0 => '\'',
            0xE3 => '-',
            0xE6 => '?',
            0xE7 => '!',
            0xE8 => '.',
            0xE9 => '&',
            0xEA => 'é',
            0xEB => '→',
            0xEF => '♂',
            0xF0 => '¥',
            0xF1 => '×',
            0xF3 => '/',
            0xF4 => ',',
            0xF5 => '♀',
            _ => return format!("Unsupported Gen II character byte {byte:#04x}"),
        };
        output.push(character);
    }
    "Trainer name has no terminator".into()
}

fn read_only_text(
    id: &str,
    label: &str,
    offset: u16,
    value: String,
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: 0,
        offset,
        kind: SaveFieldKind::ReadOnlyText,
        value: SaveValue::Text(value),
        editable: false,
        constraints: SaveConstraint::default(),
        description: description.into(),
        warnings: vec!["Read-only".into()],
        step: None,
        encoding: Some("pokemon_gen2_english".into()),
    }
}

fn read_only_integer(
    id: &str,
    label: &str,
    offset: u16,
    value: u32,
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: 0,
        offset,
        kind: SaveFieldKind::ReadOnlyInteger,
        value: SaveValue::U32(value),
        editable: false,
        constraints: SaveConstraint::default(),
        description: description.into(),
        warnings: vec!["Read-only".into()],
        step: None,
        encoding: None,
    }
}

fn edit_warning(slots: Slots) -> Vec<String> {
    (!slots.main || !slots.backup)
        .then(|| "Editing needs valid primary and backup save data".into())
        .into_iter()
        .collect()
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

    fn save(family: Family) -> Vec<u8> {
        let mut bytes = vec![0; GEN2_SAVE_SIZE];
        for layout in slot_layouts(family) {
            bytes[layout.check_value_one] = CHECK_VALUE_1;
            bytes[layout.check_value_two] = CHECK_VALUE_2;
            write_u24(
                &mut bytes,
                layout.player_three,
                money_offset(family),
                12_345,
            );
            read_mut(&mut bytes, layout.player_three, badge_offset(family))[0] = 0b0000_0101;
            read_mut(&mut bytes, layout.player_one, 2)[..4]
                .copy_from_slice(&[0x80, 0x81, 0x82, 0x50]);
            read_mut(&mut bytes, layout.player_one, 0)[..2]
                .copy_from_slice(&0x1234u16.to_be_bytes());
            read_mut(
                &mut bytes,
                layout.player_one,
                play_time_cap_offset(family) + 1,
            )[..5]
                .copy_from_slice(&[0, 42, 3, 4, 5]);
            if family == Family::Crystal {
                read_mut(&mut bytes, layout.player_three, 0x3CF)[..2]
                    .copy_from_slice(&0x5678u16.to_be_bytes());
            }
            repair_checksum(&mut bytes, layout);
        }
        bytes
    }

    #[test]
    fn gold_save_parses_and_repairs_both_copies() {
        let handler = PokemonGen2Handler;
        let mut bytes = save(Family::GoldSilver);
        bytes[0x5000] = 0xA5;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some("pokemon-gold".into()),
            rom_sha1: None,
        };
        let game = identity("pokemon-gold");
        let document = handler.parse(&input, &game).unwrap();
        assert_eq!(
            field_value(&document, "trainer.name"),
            Some(&SaveValue::Text("ABC".into()))
        );
        assert_eq!(
            field_value(&document, "trainer.money"),
            Some(&SaveValue::U32(12_345))
        );
        assert_eq!(
            field_value(&document, "trainer.play_time"),
            Some(&SaveValue::Text("42:03:04:05".into()))
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
                        field: "progress.badge_2".into(),
                        value: SaveValue::Bool(true),
                    },
                ],
                false,
            )
            .unwrap();
        let bytes = result.bytes.unwrap();
        assert!(valid_slot(&bytes, &GS_MAIN));
        assert!(valid_slot(&bytes, &GS_BACKUP));
        assert_eq!(bytes[0x5000], 0xA5);
        assert!(
            input
                .bytes
                .iter()
                .zip(&bytes)
                .enumerate()
                .all(|(index, (before, after))| {
                    before == after
                        || slot_layouts(Family::GoldSilver).iter().any(|layout| {
                            (layout.player_three.offset + money_offset(Family::GoldSilver)
                                ..layout.player_three.offset + money_offset(Family::GoldSilver) + 3)
                                .contains(&index)
                                || index
                                    == layout.player_three.offset + badge_offset(Family::GoldSilver)
                                || (layout.checksum_offset..layout.checksum_offset + 2)
                                    .contains(&index)
                        })
                })
        );
        assert_eq!(
            field_value(&result.document, "trainer.money"),
            Some(&SaveValue::U32(999_999))
        );
        assert_eq!(
            field_value(&result.document, "progress.badge_2"),
            Some(&SaveValue::Bool(true))
        );
    }

    #[test]
    fn recognition_keeps_shared_titles_ambiguous() {
        let gold_silver = SaveDetectionInput {
            bytes: save(Family::GoldSilver),
            selected_game: None,
            rom_sha1: None,
        };
        assert!(matches!(
            PokemonGen2Handler.recognize(&gold_silver).outcome,
            SaveRecognitionOutcome::Ambiguous { ref candidates } if candidates.len() == 2
        ));

        let crystal = SaveDetectionInput {
            bytes: save(Family::Crystal),
            selected_game: None,
            rom_sha1: None,
        };
        assert!(matches!(
            PokemonGen2Handler.recognize(&crystal).outcome,
            SaveRecognitionOutcome::Recognized { ref candidate }
                if candidate.identity.id == "pokemon-crystal"
        ));
    }

    #[test]
    fn dry_run_reparses_without_returning_bytes() {
        let input = SaveDetectionInput {
            bytes: save(Family::Crystal),
            selected_game: Some("pokemon-crystal".into()),
            rom_sha1: None,
        };
        let result = PokemonGen2Handler
            .apply(
                &input,
                &identity("pokemon-crystal"),
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
            read_u24(&input.bytes, CRYSTAL_MAIN.player_three, 0x3D3),
            12_345
        );
    }

    #[test]
    fn crystal_save_exposes_the_secret_id() {
        let handler = PokemonGen2Handler;
        let input = SaveDetectionInput {
            bytes: save(Family::Crystal),
            selected_game: Some("pokemon-crystal".into()),
            rom_sha1: None,
        };
        let document = handler.parse(&input, &identity("pokemon-crystal")).unwrap();
        assert_eq!(
            field_value(&document, "trainer.secret_id"),
            Some(&SaveValue::U32(0x5678))
        );
        assert!(valid_slot(&input.bytes, &CRYSTAL_MAIN));
        assert!(valid_slot(&input.bytes, &CRYSTAL_BACKUP));
    }

    #[test]
    fn single_valid_copy_is_read_only() {
        let handler = PokemonGen2Handler;
        let mut bytes = save(Family::GoldSilver);
        bytes[GS_BACKUP.checksum_offset] ^= 1;
        let input = SaveDetectionInput {
            bytes,
            selected_game: Some("pokemon-gold".into()),
            rom_sha1: None,
        };
        let game = identity("pokemon-gold");
        let document = handler.parse(&input, &game).unwrap();
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
            handler
                .apply(
                    &input,
                    &game,
                    &[SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(1),
                    }],
                    false,
                )
                .is_err()
        );
    }
}
