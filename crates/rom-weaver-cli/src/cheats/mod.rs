//! Decode Game Genie and Pro Action Replay/GameShark codes into ROM byte writes.
//!
//! [`decode`] produces an address/value pair; [`resolve_writes`] maps it through
//! [`RomLayout`] to file offsets, accounting for headers, banking, compare bytes,
//! and RAM-only addresses. The pure module never touches the filesystem.

use rom_weaver_core::{Result, RomWeaverError, ValidationCodeError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

mod action_replay;
mod game_genie;
mod layout;
mod retroarch;

use layout::Mapping;
pub use layout::RomLayout;
pub use retroarch::{
    MAX_CHT_BYTES, MAX_CHT_RECORDS, RetroArchParseOptions, export_retroarch_cht,
    parse_retroarch_cht,
};

/// A console family whose cheat codes we can decode. The address layout and
/// code scheme differ per system, so the caller must identify it up front.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "lowercase")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "lowercase"))]
pub enum CheatSystem {
    Nes,
    Snes,
    Genesis,
    GameBoy,
    #[serde(rename = "gameboy-color")]
    #[cfg_attr(feature = "typescript-types", ts(rename = "gameboy-color"))]
    GameBoyColor,
}

impl CheatSystem {
    /// Lowercase identifier used on the CLI / wasm boundary.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Nes => "nes",
            Self::Snes => "snes",
            Self::Genesis => "genesis",
            Self::GameBoy => "gameboy",
            Self::GameBoyColor => "gameboy-color",
        }
    }

    /// Parse the CLI/UI identifier (accepts a few common aliases).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "nes" | "famicom" | "fc" => Some(Self::Nes),
            "snes" | "sfc" | "superfamicom" => Some(Self::Snes),
            "genesis" | "megadrive" | "mega-drive" | "md" | "smd" => Some(Self::Genesis),
            "gameboy" | "gb" => Some(Self::GameBoy),
            "gameboy-color" | "gameboycolor" | "gbc" => Some(Self::GameBoyColor),
            _ => None,
        }
    }
}

/// Which code scheme a textual code uses. GameShark codes share Pro Action
/// Replay's raw address:value form, so they are decoded as the same kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "kebab-case"))]
pub enum CheatKind {
    GameGenie,
    ProActionReplay,
}

impl CheatKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gg" | "game-genie" | "gamegenie" | "genie" => Some(Self::GameGenie),
            "par" | "ar" | "action-replay" | "gameshark" | "gs" => Some(Self::ProActionReplay),
            _ => None,
        }
    }
}

/// A decoded cheat: a CPU/bus address, the replacement value (`width` bytes,
/// big-endian for the 2-byte Genesis case), and an optional compare byte used
/// to disambiguate the correct ROM bank when baking the code into a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodedCode {
    pub system: CheatSystem,
    pub kind: CheatKind,
    pub address: u32,
    pub value: u16,
    pub compare: Option<u8>,
    pub width: u8,
}

/// A concrete byte write into the ROM file: overwrite `width` bytes at `offset`
/// with `value` (big-endian when `width == 2`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CheatWrite {
    pub offset: usize,
    pub value: u16,
    pub width: u8,
}

/// A decoded address class. This does not weaken [`resolve_writes`], which
/// still rejects runtime addresses when a caller asks to bake them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "typescript-types", ts(rename_all = "kebab-case"))]
pub enum CheatTarget {
    CartridgeRom,
    RuntimeMemory,
    Unknown,
}

/// A normalized logical cheat. All subcodes and unknown source fields remain
/// attached to this one record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CheatRecord {
    pub id: String,
    pub system: CheatSystem,
    pub game_id: String,
    pub description: String,
    pub raw_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "typescript-types", ts(optional))]
    pub code_kind: Option<CheatKind>,
    pub raw_fields: BTreeMap<String, String>,
    pub source_file: String,
    pub source_index: usize,
    pub source_revision: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCheatPayload {
    pub record: CheatRecord,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase", tag = "type")]
#[cfg_attr(
    feature = "typescript-types",
    ts(rename_all = "camelCase", tag = "type")
)]
pub enum CheatResolution {
    RomBakeable {
        writes: Vec<CheatWrite>,
    },
    Runtime {
        payload: RuntimeCheatPayload,
    },
    Mixed {
        writes: Vec<CheatWrite>,
        payload: RuntimeCheatPayload,
    },
    RequiresParameter {
        payload: RuntimeCheatPayload,
    },
    Unsupported {
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedCheatRecord {
    pub record: CheatRecord,
    pub resolution: CheatResolution,
    pub detected_kind: Option<CheatKind>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "camelCase")]
pub struct CheatWriteConflict {
    pub first_id: String,
    pub second_id: String,
    pub offset: usize,
    pub first_value: u8,
    pub second_value: u8,
}

/// Split a raw input into individual codes. Cheat lists are commonly joined
/// with `+`, newlines, commas, or spaces; each piece is one code. (Intra-code
/// separators like the Game Genie `-` or the GameShark `:` are kept and handled
/// by [`normalize`].)
pub fn split_codes(input: &str) -> Vec<&str> {
    input
        .split(|c: char| c == '+' || c == ',' || c == ';' || c.is_whitespace())
        .map(str::trim)
        .filter(|piece| !piece.is_empty())
        .collect()
}

/// Strip intra-code separators and upper-case a single code for decoding. Note
/// `+` is NOT stripped here - it separates codes (see [`split_codes`]) - so a
/// stray `+` left in a single token surfaces as an invalid character rather
/// than silently merging two codes.
fn normalize(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-' && *c != ':')
        .flat_map(|c| c.to_uppercase())
        .collect()
}

/// Build a coded validation error carrying the offending code text.
fn coded(code: &'static str, message: &'static str, offending: &str) -> RomWeaverError {
    RomWeaverError::ValidationCode(
        ValidationCodeError::new(code)
            .with_message(message)
            .with_field("code", offending.to_owned()),
    )
}

/// Decode a single code with an explicit scheme.
pub fn decode(code: &str, system: CheatSystem, kind: CheatKind) -> Result<DecodedCode> {
    let normalized = normalize(code);
    tracing::trace!(target: "rom_weaver_cheats", raw = code, normalized = %normalized, ?system, ?kind, "decoding cheat code");
    let mut decoded = match kind {
        CheatKind::GameGenie => game_genie::decode(&normalized, system, code)?,
        CheatKind::ProActionReplay => action_replay::decode(&normalized, system, code)?,
    };
    // Game Boy Color uses the compatible Game Boy decoder, which emits its
    // base family. Retain the caller's selected database system in the result.
    decoded.system = system;
    tracing::debug!(
        target: "rom_weaver_cheats",
        raw = code,
        address = format_args!("{:06X}", decoded.address),
        value = format_args!("{:04X}", decoded.value),
        compare = ?decoded.compare,
        width = decoded.width,
        "decoded cheat code"
    );
    Ok(decoded)
}

/// Decode a single code, inferring the scheme from its shape.
///
/// Heuristics (documented per system): NES Game Genie codes use a restricted
/// letter alphabet, so any digit means Pro Action Replay; Genesis GameShark
/// codes are longer/colon-separated hex; Game Boy GameShark codes are 8 hex
/// digits where Game Genie codes are 6 or 9. SNES Game Genie and Pro Action
/// Replay are both 8 hex-ish chars and cannot be told apart reliably, so SNES
/// defaults to Game Genie - pass an explicit kind for SNES Pro Action Replay.
pub fn decode_auto(code: &str, system: CheatSystem) -> Result<DecodedCode> {
    let kind = infer_kind(&normalize(code), system);
    decode(code, system, kind)
}

fn infer_kind(normalized: &str, system: CheatSystem) -> CheatKind {
    let all_hex = !normalized.is_empty() && normalized.bytes().all(|b| b.is_ascii_hexdigit());
    match system {
        // GG uses A P Z L G I T Y E O X U K S V N - no decimal digits.
        CheatSystem::Nes => {
            if normalized.bytes().any(|b| b.is_ascii_digit()) {
                CheatKind::ProActionReplay
            } else {
                CheatKind::GameGenie
            }
        }
        // GB GG is 6 or 9 hex; GameShark is 8 hex.
        CheatSystem::GameBoy | CheatSystem::GameBoyColor => {
            if all_hex && normalized.len() == 8 {
                CheatKind::ProActionReplay
            } else {
                CheatKind::GameGenie
            }
        }
        // Genesis GG is 8 chars from a no-digit-ambiguity alphabet incl.
        // 0-9; GameShark is 10 hex (6 addr + 4 value) or colon-separated.
        CheatSystem::Genesis => {
            if all_hex && normalized.len() != 8 {
                CheatKind::ProActionReplay
            } else {
                CheatKind::GameGenie
            }
        }
        CheatSystem::Snes => CheatKind::GameGenie,
    }
}

/// Classify an understood decoded address without trying to map it to a file.
pub fn classify_decoded_code(layout: &RomLayout, decoded: &DecodedCode) -> CheatTarget {
    if layout.system != decoded.system {
        return CheatTarget::Unknown;
    }
    let address = decoded.address;
    match decoded.system {
        CheatSystem::Nes => {
            if address >= 0x8000 {
                CheatTarget::CartridgeRom
            } else {
                CheatTarget::RuntimeMemory
            }
        }
        CheatSystem::Snes => {
            let bank = (address >> 16) & 0xff;
            let low = address & 0xffff;
            let system_bank = bank <= 0x3f || (0x80..=0xbf).contains(&bank);
            if bank == 0x7e
                || bank == 0x7f
                || (system_bank && low < 0x2000)
                || (matches!(layout.mapping, Mapping::SnesLoRom) && low < 0x8000)
            {
                CheatTarget::RuntimeMemory
            } else {
                CheatTarget::CartridgeRom
            }
        }
        CheatSystem::Genesis => {
            if address >= 0xe0_0000 {
                CheatTarget::RuntimeMemory
            } else {
                CheatTarget::CartridgeRom
            }
        }
        CheatSystem::GameBoy | CheatSystem::GameBoyColor => {
            if address < 0x8000 {
                CheatTarget::CartridgeRom
            } else {
                CheatTarget::RuntimeMemory
            }
        }
    }
}

/// Common database placeholders need a value before the code can be decoded.
pub fn contains_parameter_placeholder(value: &str) -> bool {
    value.contains('?') || value.to_ascii_uppercase().contains("XX")
}

fn record_payload(record: &CheatRecord) -> RuntimeCheatPayload {
    RuntimeCheatPayload {
        record: record.clone(),
    }
}

fn record_kind_hint(record: &CheatRecord) -> Option<CheatKind> {
    let field_hint = record
        .raw_fields
        .iter()
        .find(|(name, _)| matches!(name.as_str(), "kind" | "type" | "device" | "code_type"))
        .map(|(_, value)| value.as_str())
        .unwrap_or_default();
    let hint = format!("{field_hint} {}", record.source_file).to_ascii_lowercase();
    if hint.contains("game genie") || hint.contains("game-genie") {
        Some(CheatKind::GameGenie)
    } else if hint.contains("action replay")
        || hint.contains("action-replay")
        || hint.contains("gameshark")
        || hint.contains("game shark")
    {
        Some(CheatKind::ProActionReplay)
    } else {
        None
    }
}

fn has_structured_runtime_semantics(record: &CheatRecord) -> bool {
    record.raw_fields.keys().any(|name| {
        matches!(
            name.as_str(),
            "address"
                | "value"
                | "handler"
                | "memory_search_size"
                | "address_bit_position"
                | "big_endian"
                | "repeat_count"
                | "repeat_add_to_address"
                | "repeat_add_to_value"
                | "condition"
                | "condition_type"
                | "condition_address"
                | "condition_value"
                | "activation"
        )
    })
}

fn has_parameterized_executable_field(record: &CheatRecord) -> bool {
    record.raw_fields.iter().any(|(name, value)| {
        matches!(
            name.as_str(),
            "code"
                | "address"
                | "value"
                | "handler"
                | "memory_search_size"
                | "address_bit_position"
                | "big_endian"
                | "repeat_count"
                | "repeat_add_to_address"
                | "repeat_add_to_value"
                | "condition"
                | "condition_type"
                | "condition_address"
                | "condition_value"
                | "activation"
        ) && contains_parameter_placeholder(value)
    })
}

/// Resolve one named cheat as one unit. Mixed groups stay intact for runtime
/// export because their subcodes can depend on each other.
pub fn classify_record(rom: &[u8], record: &CheatRecord) -> ClassifiedCheatRecord {
    let payload = record_payload(record);
    if has_parameterized_executable_field(record)
        || record
            .raw_code
            .as_deref()
            .is_some_and(contains_parameter_placeholder)
    {
        return ClassifiedCheatRecord {
            record: record.clone(),
            resolution: CheatResolution::RequiresParameter { payload },
            detected_kind: None,
        };
    }
    if has_structured_runtime_semantics(record) {
        return ClassifiedCheatRecord {
            record: record.clone(),
            resolution: CheatResolution::Runtime { payload },
            detected_kind: record.code_kind.or_else(|| record_kind_hint(record)),
        };
    }

    let Some(raw_code) = record.raw_code.as_deref() else {
        return ClassifiedCheatRecord {
            record: record.clone(),
            resolution: CheatResolution::Unsupported {
                reason: "the entry has no native code or structured memory fields".to_string(),
            },
            detected_kind: None,
        };
    };

    let codes = split_codes(raw_code);
    if codes.is_empty() {
        return ClassifiedCheatRecord {
            record: record.clone(),
            resolution: CheatResolution::Unsupported {
                reason: "the entry has an empty native code".to_string(),
            },
            detected_kind: None,
        };
    }

    let layout = RomLayout::detect(rom, record.system);
    let mut writes = Vec::new();
    let mut rom_count = 0usize;
    let mut runtime_count = 0usize;
    let mut detected_kind = None;
    for code in codes {
        let mut hinted_kind = record.code_kind.or_else(|| record_kind_hint(record));
        let normalized = normalize(code);
        if hinted_kind.is_none()
            && record.system == CheatSystem::Snes
            && code.contains('-')
            && normalized.len() == 8
            && normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            hinted_kind = Some(CheatKind::GameGenie);
        }
        if hinted_kind.is_none()
            && record.system == CheatSystem::Snes
            && normalized.len() == 8
            && normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            let game_genie = decode(code, record.system, CheatKind::GameGenie);
            let action_replay = decode(code, record.system, CheatKind::ProActionReplay);
            match (game_genie, action_replay) {
                (Ok(game_genie), Ok(action_replay)) => {
                    let game_genie_target = classify_decoded_code(&layout, &game_genie);
                    let action_replay_target = classify_decoded_code(&layout, &action_replay);
                    if game_genie_target == CheatTarget::RuntimeMemory
                        && action_replay_target == CheatTarget::RuntimeMemory
                    {
                        runtime_count += 1;
                        continue;
                    }
                    return ClassifiedCheatRecord {
                        record: record.clone(),
                        resolution: CheatResolution::Unsupported {
                            reason:
                                "the SNES code is ambiguous between Game Genie and Action Replay"
                                    .to_string(),
                        },
                        detected_kind: None,
                    };
                }
                (Ok(decoded), Err(_)) | (Err(_), Ok(decoded)) => {
                    detected_kind = Some(decoded.kind);
                    match classify_decoded_code(&layout, &decoded) {
                        CheatTarget::CartridgeRom => match resolve_writes(rom, &layout, &decoded) {
                            Ok(resolved) => {
                                rom_count += 1;
                                writes.extend(resolved);
                                continue;
                            }
                            Err(error) => {
                                return ClassifiedCheatRecord {
                                    record: record.clone(),
                                    resolution: CheatResolution::Unsupported {
                                        reason: error.to_string(),
                                    },
                                    detected_kind,
                                };
                            }
                        },
                        CheatTarget::RuntimeMemory => {
                            runtime_count += 1;
                            continue;
                        }
                        CheatTarget::Unknown => {}
                    }
                }
                (Err(error), Err(_)) => {
                    return ClassifiedCheatRecord {
                        record: record.clone(),
                        resolution: CheatResolution::Unsupported {
                            reason: error.to_string(),
                        },
                        detected_kind: None,
                    };
                }
            }
        }
        let decode_result = match hinted_kind {
            Some(kind) => decode(code, record.system, kind),
            None => decode_auto(code, record.system),
        };
        let decoded = match decode_result {
            Ok(decoded) => decoded,
            Err(error) => {
                return ClassifiedCheatRecord {
                    record: record.clone(),
                    resolution: CheatResolution::Unsupported {
                        reason: error.to_string(),
                    },
                    detected_kind,
                };
            }
        };
        detected_kind = match detected_kind {
            None => Some(decoded.kind),
            Some(kind) if kind == decoded.kind => Some(kind),
            Some(_) => None,
        };
        match classify_decoded_code(&layout, &decoded) {
            CheatTarget::CartridgeRom => match resolve_writes(rom, &layout, &decoded) {
                Ok(resolved) => {
                    rom_count += 1;
                    writes.extend(resolved);
                }
                Err(error) => {
                    return ClassifiedCheatRecord {
                        record: record.clone(),
                        resolution: CheatResolution::Unsupported {
                            reason: error.to_string(),
                        },
                        detected_kind,
                    };
                }
            },
            CheatTarget::RuntimeMemory => runtime_count += 1,
            CheatTarget::Unknown => {
                return ClassifiedCheatRecord {
                    record: record.clone(),
                    resolution: CheatResolution::Unsupported {
                        reason: "the decoded code does not match the selected system".to_string(),
                    },
                    detected_kind,
                };
            }
        }
    }

    let resolution = match (rom_count > 0, runtime_count > 0) {
        (true, false) => CheatResolution::RomBakeable { writes },
        (false, true) => CheatResolution::Runtime { payload },
        (true, true) => CheatResolution::Mixed { writes, payload },
        (false, false) => CheatResolution::Unsupported {
            reason: "the entry contains no codes".to_string(),
        },
    };
    ClassifiedCheatRecord {
        record: record.clone(),
        resolution,
        detected_kind,
    }
}

/// Find differing byte writes. Equal overlaps are compatible and omitted.
pub fn detect_write_conflicts(entries: &[(String, Vec<CheatWrite>)]) -> Vec<CheatWriteConflict> {
    use std::collections::BTreeMap;

    let mut seen: BTreeMap<usize, (String, u8)> = BTreeMap::new();
    let mut conflicts = Vec::new();
    for (id, writes) in entries {
        for write in writes {
            let bytes = match write.width {
                1 => vec![write.value as u8],
                2 => vec![(write.value >> 8) as u8, write.value as u8],
                _ => continue,
            };
            for (relative, value) in bytes.into_iter().enumerate() {
                let offset = write.offset + relative;
                match seen.get(&offset) {
                    Some((first_id, first_value)) if *first_value != value => {
                        conflicts.push(CheatWriteConflict {
                            first_id: first_id.clone(),
                            second_id: id.clone(),
                            offset,
                            first_value: *first_value,
                            second_value: value,
                        });
                    }
                    None => {
                        seen.insert(offset, (id.clone(), value));
                    }
                    _ => {}
                }
            }
        }
    }
    conflicts
}

/// Map a decoded code onto concrete ROM file writes, given the ROM's layout.
/// May return multiple writes when a compare byte matches several banks.
pub fn resolve_writes(
    rom: &[u8],
    layout: &RomLayout,
    decoded: &DecodedCode,
) -> Result<Vec<CheatWrite>> {
    layout::resolve_writes(rom, layout, decoded)
}

/// Apply resolved writes into a mutable ROM buffer in place.
pub fn apply_writes(rom: &mut [u8], writes: &[CheatWrite]) -> Result<()> {
    for write in writes {
        let end = write.offset.saturating_add(write.width as usize);
        if end > rom.len() {
            return Err(coded(
                "cheat_offset_out_of_range",
                "resolved cheat offset is past the end of the ROM",
                &format!("offset={:#X} len={:#X}", write.offset, rom.len()),
            ));
        }
        match write.width {
            1 => rom[write.offset] = write.value as u8,
            2 => {
                // Genesis values are big-endian words.
                rom[write.offset] = (write.value >> 8) as u8;
                rom[write.offset + 1] = write.value as u8;
            }
            other => {
                return Err(coded(
                    "cheat_bad_code",
                    "unsupported cheat write width",
                    &other.to_string(),
                ));
            }
        }
        tracing::trace!(
            target: "rom_weaver_cheats",
            offset = format_args!("{:#X}", write.offset),
            value = format_args!("{:04X}", write.value),
            width = write.width,
            "applied cheat write"
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod cheats_tests;
