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
const PC_BLOCK_OFFSET: usize = 0xF700;
const PC_BLOCK_SIZE: usize = 0x12310;
const SYS_INFO_SIZE: usize = 0x5c;
const ARRAY_CRC_SIZE: usize = 4;
const PLAYER_DATA_OFFSET: usize = SYS_INFO_SIZE + ARRAY_CRC_SIZE;
const PROFILE_OFFSET: usize = PLAYER_DATA_OFFSET + 4;
const MAX_MONEY: u32 = 999_999;
const MAX_COINS: u32 = 50_000;
const MAX_BATTLE_POINTS: u32 = 9_999;

#[derive(Clone, Copy, Debug)]
struct Layout {
    main_size: usize,
    pc_offset: usize,
    pc_size: usize,
    trainer_offset: usize,
    bp_offset: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Title {
    Diamond,
    Pearl,
    Platinum,
    HeartGold,
    SoulSilver,
}

impl Title {
    const ALL: [Self; 5] = [
        Self::Diamond,
        Self::Pearl,
        Self::Platinum,
        Self::HeartGold,
        Self::SoulSilver,
    ];

    fn id(self) -> &'static str {
        match self {
            Self::Diamond => "pokemon-diamond",
            Self::Pearl => "pokemon-pearl",
            Self::Platinum => "pokemon-platinum",
            Self::HeartGold => "pokemon-heartgold",
            Self::SoulSilver => "pokemon-soulsilver",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Diamond => "Pokémon Diamond",
            Self::Pearl => "Pokémon Pearl",
            Self::Platinum => "Pokémon Platinum",
            Self::HeartGold => "Pokémon HeartGold",
            Self::SoulSilver => "Pokémon SoulSilver",
        }
    }

    fn version(self) -> u8 {
        // https://github.com/pret/pokeheartgold/blob/master/include/config.h
        match self {
            Self::Diamond | Self::Pearl | Self::Platinum => 0,
            Self::HeartGold => 7,
            Self::SoulSilver => 8,
        }
    }

    fn identity(self) -> SaveGameIdentity {
        SaveGameIdentity {
            id: self.id().into(),
            name: self.name().into(),
            family: match self {
                Self::Diamond | Self::Pearl | Self::Platinum => "pokemon-gen4-dppt",
                Self::HeartGold | Self::SoulSilver => "pokemon-gen4-hgss",
            }
            .into(),
        }
    }

    fn layout(self) -> Layout {
        match self {
            Self::Diamond | Self::Pearl => Layout {
                main_size: 0xC100,
                pc_offset: 0xC100,
                pc_size: 0x121E0,
                trainer_offset: 0x64,
                bp_offset: 0x65F8,
            },
            Self::Platinum => Layout {
                main_size: 0xCF2C,
                pc_offset: 0xCF2C,
                pc_size: 0x121E4,
                trainer_offset: 0x68,
                bp_offset: 0x7234,
            },
            Self::HeartGold | Self::SoulSilver => Layout {
                main_size: MAIN_BLOCK_SIZE,
                pc_offset: PC_BLOCK_OFFSET,
                pc_size: PC_BLOCK_SIZE,
                trainer_offset: PROFILE_OFFSET,
                bp_offset: 0x5BB8,
            },
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

    fn generate(&self, game: &SaveGameIdentity) -> Result<Vec<u8>> {
        let title = title_for_game(game)?;
        let mut bytes = vec![0xff; GEN4_SAVE_SIZE];
        initialize_copy(&mut bytes, 0, 0, title);
        initialize_copy(&mut bytes, 1, 1, title);

        let (active, redundancy) = active_slot(&bytes, title)?;
        build_document(&bytes, title, game, &active, redundancy)?;
        Ok(bytes)
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
        apply_to_active(&mut bytes, title, &active, edits)?;
        repair_main_crc(&mut bytes, title, &active);

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

fn initialize_copy(bytes: &mut [u8], slot: u8, count: u32, title: Title) {
    let layout = title.layout();
    let base = usize::from(slot) * COPY_SIZE;
    let copy = &mut bytes[base..base + COPY_SIZE];
    copy[..layout.pc_offset + layout.pc_size].fill(0);

    let trainer = layout.trainer_offset;
    copy[trainer + 0x18] = 0;
    if matches!(title, Title::HeartGold | Title::SoulSilver) {
        copy[trainer + 0x1C] = title.version();
    }

    initialize_footer(copy, layout.main_size, count, 0, 0);
    initialize_footer(
        copy,
        layout.pc_offset + layout.pc_size,
        count,
        1,
        layout.pc_offset,
    );
}

fn initialize_footer(copy: &mut [u8], end: usize, count: u32, slot: u16, start: usize) {
    let footer = end - FOOTER_SIZE;
    copy[footer..footer + 4].copy_from_slice(&count.to_le_bytes());
    copy[footer + 4..footer + 8].copy_from_slice(
        &u32::try_from(end - start)
            .expect("save block size fits u32")
            .to_le_bytes(),
    );
    copy[footer + 8..footer + 12].copy_from_slice(&FOOTER_MAGIC.to_le_bytes());
    copy[footer + 12..footer + 14].copy_from_slice(&slot.to_le_bytes());
    let crc = crc16_ccitt(&copy[start..footer]);
    copy[footer + 14..footer + 16].copy_from_slice(&crc.to_le_bytes());
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
    let layout = title.layout();
    let main_footer_offset = layout.main_size - FOOTER_SIZE;
    let pc_footer_offset = layout.pc_offset + layout.pc_size - FOOTER_SIZE;
    let main = parse_footer(copy, main_footer_offset, 0, layout.main_size, 0, "main")?;
    let pc = parse_footer(
        copy,
        pc_footer_offset,
        1,
        layout.pc_size,
        layout.pc_offset,
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
    let trainer = title.layout().trainer_offset;
    if !matches!(title, Title::Diamond | Title::Pearl | Title::Platinum)
        && copy[trainer + 0x1C] != title.version()
    {
        return Err(validation(
            "save_game_version",
            "the trainer profile does not match the selected game",
        ));
    }
    if copy[trainer + 0x18] > 1 {
        return Err(validation(
            "save_gender",
            "the save has an invalid player gender value",
        ));
    }
    if read_u32(copy, trainer + 0x14) > MAX_MONEY {
        return Err(validation(
            "save_money",
            "the save has a money value above the game limit",
        ));
    }
    if copy[trainer + 0x24] > 59 || copy[trainer + 0x25] > 59 {
        return Err(validation(
            "save_play_time",
            "the save has an invalid play-time minute or second value",
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
    let layout = title.layout();
    let trainer = layout.trainer_offset;
    let profile_id_offset = trainer + 0x10;
    let profile_money_offset = trainer + 0x14;
    let profile_gender_offset = trainer + 0x18;
    let profile_johto_badges_offset = trainer + 0x1A;
    let profile_kanto_badges_offset = trainer + 0x1F;
    let play_time_offset = trainer + 0x22;
    let coins_offset = trainer + 0x20;
    let trainer_id = read_u32(copy, profile_id_offset);
    let coins = u32::from(read_u16(copy, coins_offset));
    let battle_points = u32::from(read_u16(copy, layout.bp_offset));
    if coins > MAX_COINS {
        return Err(validation(
            "save_coins",
            "the save has coins above the game limit",
        ));
    }
    if battle_points > MAX_BATTLE_POINTS {
        return Err(validation(
            "save_battle_points",
            "the save has battle points above the game limit",
        ));
    }
    let mut fields = vec![
        SaveField {
            id: "trainer.id".into(),
            label: "Trainer ID".into(),
            section_id: 0,
            offset: profile_id_offset as u16,
            kind: SaveFieldKind::UnsignedInteger,
            value: SaveValue::U32(trainer_id & 0xffff),
            editable,
            constraints: SaveConstraint {
                min: Some(0),
                max: Some(65_535),
                ..Default::default()
            },
            description: "Public trainer identifier".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
        SaveField {
            id: "trainer.secret_id".into(),
            label: "Secret ID".into(),
            section_id: 0,
            offset: (profile_id_offset + 2) as u16,
            kind: SaveFieldKind::UnsignedInteger,
            value: SaveValue::U32(trainer_id >> 16),
            editable,
            constraints: SaveConstraint {
                min: Some(0),
                max: Some(65_535),
                ..Default::default()
            },
            description: "Hidden trainer identifier".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
        SaveField {
            id: "trainer.gender".into(),
            label: "Gender".into(),
            section_id: 0,
            offset: profile_gender_offset as u16,
            kind: SaveFieldKind::Enum,
            value: SaveValue::Enum(
                if copy[profile_gender_offset] == 0 {
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
            offset: profile_money_offset as u16,
            kind: SaveFieldKind::UnsignedInteger,
            value: SaveValue::U32(read_u32(copy, profile_money_offset)),
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
            offset: play_time_offset as u16,
            kind: SaveFieldKind::ReadOnlyText,
            value: SaveValue::Text(format!(
                "{}:{:02}:{:02}",
                read_u16(copy, play_time_offset),
                copy[play_time_offset + 2],
                copy[play_time_offset + 3]
            )),
            editable: false,
            constraints: SaveConstraint::default(),
            description: "Time played".into(),
            warnings: Vec::new(),
            step: None,
            encoding: None,
        },
    ];
    fields.push(scalar_field(
        "trainer.coins",
        "Coins",
        coins_offset,
        SaveValue::U32(coins),
        editable,
        (0, MAX_COINS),
        "Game Corner coins",
    ));
    fields.push(scalar_field(
        "trainer.play_time_hours",
        "Play time hours",
        play_time_offset,
        SaveValue::U32(u32::from(read_u16(copy, play_time_offset))),
        editable,
        (0, u32::from(u16::MAX)),
        "Hours played",
    ));
    fields.push(scalar_field(
        "trainer.play_time_minutes",
        "Play time minutes",
        play_time_offset + 2,
        SaveValue::U32(u32::from(copy[play_time_offset + 2])),
        editable,
        (0, 59),
        "Minutes in the current hour",
    ));
    fields.push(scalar_field(
        "trainer.play_time_seconds",
        "Play time seconds",
        play_time_offset + 3,
        SaveValue::U32(u32::from(copy[play_time_offset + 3])),
        editable,
        (0, 59),
        "Seconds in the current minute",
    ));
    fields.push(scalar_field(
        "progress.battle_points",
        "Battle Points",
        layout.bp_offset,
        SaveValue::U32(battle_points),
        editable,
        (0, MAX_BATTLE_POINTS),
        "Battle Frontier points",
    ));
    let badge_count = if matches!(title, Title::Diamond | Title::Pearl | Title::Platinum) {
        8
    } else {
        16
    };
    for badge in 0..badge_count {
        let (offset, bit) = badge_location(
            badge,
            profile_johto_badges_offset,
            profile_kanto_badges_offset,
        );
        fields.push(SaveField {
            id: format!("progress.badge_{}", badge + 1),
            label: badge_label(title, badge),
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
                physical_offset: (active.base + layout.pc_offset) as u32,
                checksum_expected: active.pc.crc,
                checksum_actual: crc16_ccitt(
                    &bytes[active.base + layout.pc_offset..active.base + active.pc.offset],
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

fn apply_to_active(
    bytes: &mut [u8],
    title: Title,
    active: &ParsedSlot,
    edits: &[SaveEdit],
) -> Result<()> {
    let copy = &mut bytes[active.base..active.base + COPY_SIZE];
    let layout = title.layout();
    let trainer = layout.trainer_offset;
    for edit in edits {
        match (edit.field.as_str(), &edit.value) {
            ("trainer.id", SaveValue::U32(value)) => {
                copy[trainer + 0x10..trainer + 0x12]
                    .copy_from_slice(&(*value as u16).to_le_bytes());
            }
            ("trainer.secret_id", SaveValue::U32(value)) => {
                copy[trainer + 0x12..trainer + 0x14]
                    .copy_from_slice(&(*value as u16).to_le_bytes());
            }
            ("trainer.gender", SaveValue::Enum(value)) => {
                copy[trainer + 0x18] = match value.as_str() {
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
                copy[trainer + 0x14..trainer + 0x14 + 4].copy_from_slice(&value.to_le_bytes());
            }
            ("trainer.coins", SaveValue::U32(value)) => {
                copy[trainer + 0x20..trainer + 0x22]
                    .copy_from_slice(&(*value as u16).to_le_bytes());
            }
            ("trainer.play_time_hours", SaveValue::U32(value)) => {
                copy[trainer + 0x22..trainer + 0x24]
                    .copy_from_slice(&(*value as u16).to_le_bytes());
            }
            ("trainer.play_time_minutes", SaveValue::U32(value)) => {
                copy[trainer + 0x24] = *value as u8;
            }
            ("trainer.play_time_seconds", SaveValue::U32(value)) => {
                copy[trainer + 0x25] = *value as u8;
            }
            ("progress.battle_points", SaveValue::U32(value)) => {
                copy[layout.bp_offset..layout.bp_offset + 2]
                    .copy_from_slice(&(*value as u16).to_le_bytes());
            }
            (field, SaveValue::Bool(value)) if field.starts_with("progress.badge_") => {
                let badge = field[15..]
                    .parse::<u8>()
                    .ok()
                    .and_then(|number| number.checked_sub(1))
                    .ok_or_else(|| {
                        validation("save_field_unknown", "the requested badge field is unknown")
                    })?;
                let (offset, bit) = badge_location_checked(badge, trainer + 0x1A, trainer + 0x1F)?;
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

fn repair_main_crc(bytes: &mut [u8], title: Title, active: &ParsedSlot) {
    let main_size = title.layout().main_size;
    let crc = crc16_ccitt(&bytes[active.base..active.base + main_size - FOOTER_SIZE]);
    let footer = active.base + active.main.offset;
    bytes[footer + 14..footer + 16].copy_from_slice(&crc.to_le_bytes());
}

/// Badge flag order follows the Johto and Kanto badge bytes of the trainer profile.
/// https://github.com/pret/pokeheartgold/blob/master/include/constants/badges.h
const BADGE_NAMES: [&str; 16] = [
    "Zephyr", "Hive", "Plain", "Fog", "Storm", "Mineral", "Glacier", "Rising", "Boulder",
    "Cascade", "Thunder", "Rainbow", "Soul", "Marsh", "Volcano", "Earth",
];

const SINNOH_BADGE_NAMES: [&str; 8] = [
    "Coal", "Forest", "Cobble", "Fen", "Relic", "Mine", "Icicle", "Beacon",
];

fn badge_label(title: Title, badge: u8) -> String {
    let names = if matches!(title, Title::Diamond | Title::Pearl | Title::Platinum) {
        &SINNOH_BADGE_NAMES[..]
    } else {
        &BADGE_NAMES[..]
    };
    format!("{} Badge", names[usize::from(badge)])
}

fn badge_location(badge: u8, johto_offset: usize, kanto_offset: usize) -> (usize, u8) {
    if badge < 8 {
        (johto_offset, badge)
    } else {
        (kanto_offset, badge - 8)
    }
}

fn badge_location_checked(
    badge: u8,
    johto_offset: usize,
    kanto_offset: usize,
) -> Result<(usize, u8)> {
    (badge < 16)
        .then(|| badge_location(badge, johto_offset, kanto_offset))
        .ok_or_else(|| validation("save_field_unknown", "the requested badge field is unknown"))
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
    offset: usize,
    value: SaveValue,
    editable: bool,
    range: (u32, u32),
    description: &str,
) -> SaveField {
    SaveField {
        id: id.into(),
        label: label.into(),
        section_id: 0,
        offset: offset as u16,
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

    const MAIN_FOOTER_OFFSET: usize = MAIN_BLOCK_SIZE - FOOTER_SIZE;
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

    fn synthetic_variant(title: Title) -> Vec<u8> {
        let mut bytes = vec![0xff; GEN4_SAVE_SIZE];
        for slot in 0..2u8 {
            let count = if slot == 0 { 10 } else { 11 };
            write_variant_copy(&mut bytes, slot, count, title, 100, 0b0000_0011);
        }
        bytes
    }

    fn write_variant_copy(
        bytes: &mut [u8],
        slot: u8,
        count: u32,
        title: Title,
        money: u32,
        johto_badges: u8,
    ) {
        let layout = title.layout();
        let base = usize::from(slot) * COPY_SIZE;
        let copy = &mut bytes[base..base + COPY_SIZE];
        copy[..layout.pc_offset + layout.pc_size].fill(0);
        let trainer = layout.trainer_offset;
        copy[trainer + 0x10..trainer + 0x14].copy_from_slice(&0x1234_5678u32.to_le_bytes());
        copy[trainer + 0x14..trainer + 0x18].copy_from_slice(&money.to_le_bytes());
        copy[trainer + 0x18] = 0;
        copy[trainer + 0x1A] = johto_badges;
        copy[trainer + 0x22..trainer + 0x24].copy_from_slice(&12u16.to_le_bytes());
        copy[trainer + 0x24] = 34;
        copy[trainer + 0x25] = 56;
        copy[trainer + 0x20..trainer + 0x22].copy_from_slice(&77u16.to_le_bytes());
        copy[layout.bp_offset..layout.bp_offset + 2].copy_from_slice(&88u16.to_le_bytes());
        write_footer(copy, layout.main_size, count, 0, 0);
        write_footer(
            copy,
            layout.pc_offset + layout.pc_size,
            count,
            1,
            layout.pc_offset,
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
    fn generates_parseable_editable_saves_for_every_supported_title() {
        let handler = PokemonGen4Handler;

        for title in Title::ALL {
            let identity = title.identity();
            assert!(!handler.supports_generation(&identity));
            let bytes = handler.generate(&identity).unwrap();
            assert_eq!(bytes.len(), GEN4_SAVE_SIZE, "{}", title.id());

            let input = SaveDetectionInput {
                bytes,
                selected_game: Some(title.id().into()),
                rom_sha1: None,
            };
            let document = handler.parse(&input, &identity).unwrap();
            assert_eq!(document.active_slot, 1, "{}", title.id());
            assert_eq!(document.counter, 1, "{}", title.id());
            assert_eq!(document.integrity.state, SaveIntegrityState::Valid);
            assert_eq!(
                field_value(&document, "trainer.money"),
                Some(&SaveValue::U32(0)),
                "{}",
                title.id()
            );
            assert!(
                document
                    .fields
                    .iter()
                    .filter(|field| field.kind != SaveFieldKind::ReadOnlyInteger
                        && field.kind != SaveFieldKind::ReadOnlyText)
                    .all(|field| field.editable),
                "{}",
                title.id()
            );

            let recognition = handler.recognize(&input);
            assert!(
                matches!(
                    recognition.outcome,
                    SaveRecognitionOutcome::Recognized { ref candidate }
                        if candidate.identity.id == identity.id
                ),
                "{}",
                title.id()
            );

            let edited = handler
                .apply(
                    &input,
                    &identity,
                    &[SaveEdit {
                        field: "trainer.money".into(),
                        value: SaveValue::U32(3_000),
                    }],
                    false,
                )
                .unwrap();
            assert_eq!(
                field_value(&edited.document, "trainer.money"),
                Some(&SaveValue::U32(3_000)),
                "{}",
                title.id()
            );
        }
    }

    #[test]
    fn generation_writes_both_layout_footers_and_checksums() {
        let handler = PokemonGen4Handler;
        for title in Title::ALL {
            let bytes = handler.generate(&title.identity()).unwrap();
            let layout = title.layout();
            for slot in 0..2u8 {
                let base = usize::from(slot) * COPY_SIZE;
                let copy = &bytes[base..base + COPY_SIZE];
                let expected_count = u32::from(slot);
                let main = parse_footer(
                    copy,
                    layout.main_size - FOOTER_SIZE,
                    0,
                    layout.main_size,
                    0,
                    "main",
                )
                .unwrap();
                let pc = parse_footer(
                    copy,
                    layout.pc_offset + layout.pc_size - FOOTER_SIZE,
                    1,
                    layout.pc_size,
                    layout.pc_offset,
                    "PC",
                )
                .unwrap();
                assert_eq!(main.count, expected_count, "{}", title.id());
                assert_eq!(pc.count, expected_count, "{}", title.id());
            }
        }
    }

    #[test]
    fn generated_hgss_profile_identifies_the_selected_version() {
        let handler = PokemonGen4Handler;
        for title in [Title::HeartGold, Title::SoulSilver] {
            let bytes = handler.generate(&title.identity()).unwrap();
            let trainer = title.layout().trainer_offset;
            assert_eq!(bytes[trainer + 0x1C], title.version());
            assert_eq!(
                bytes[COPY_SIZE + trainer + 0x1C],
                title.version(),
                "{}",
                title.id()
            );
        }
    }

    #[test]
    fn generation_rejects_an_identity_owned_by_another_handler() {
        let error = PokemonGen4Handler
            .generate(&SaveGameIdentity {
                id: "not-pokemon-gen4".into(),
                name: "Unsupported".into(),
                family: "unsupported".into(),
            })
            .unwrap_err();
        assert!(matches!(error, RomWeaverError::ValidationCode(_)));
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
    fn supports_diamond_pearl_and_platinum_layouts() {
        for title in [Title::Diamond, Title::Pearl, Title::Platinum] {
            let bytes = synthetic_variant(title);
            let input = SaveDetectionInput {
                bytes: bytes.clone(),
                selected_game: Some(title.id().into()),
                rom_sha1: None,
            };
            let result = PokemonGen4Handler
                .apply(
                    &input,
                    &title.identity(),
                    &[
                        SaveEdit {
                            field: "trainer.coins".into(),
                            value: SaveValue::U32(50_000),
                        },
                        SaveEdit {
                            field: "progress.battle_points".into(),
                            value: SaveValue::U32(9_999),
                        },
                        SaveEdit {
                            field: "trainer.play_time_minutes".into(),
                            value: SaveValue::U32(59),
                        },
                    ],
                    false,
                )
                .unwrap();
            let output = result.bytes.unwrap();
            assert_eq!(result.document.active_slot, 1);
            assert_eq!(
                field_value(&result.document, "trainer.coins"),
                Some(&SaveValue::U32(50_000))
            );
            assert_eq!(
                field_value(&result.document, "progress.battle_points"),
                Some(&SaveValue::U32(9_999))
            );
            assert_eq!(&output[..COPY_SIZE], &bytes[..COPY_SIZE]);
        }
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
            read_u32(&input.bytes[COPY_SIZE..], FIXTURE_MONEY_OFFSET),
            200
        );
    }

    #[test]
    fn matches_the_nitro_crc16_ccitt_test_vector() {
        assert_eq!(crc16_ccitt(b"123456789"), 0x29b1);
    }
}
