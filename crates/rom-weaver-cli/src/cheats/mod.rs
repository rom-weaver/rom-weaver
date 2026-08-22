//! Decode cheat codes into ROM byte writes.
//!
//! [`decode`] produces an address/value pair; [`resolve_writes`] maps it through
//! [`RomLayout`] to file offsets, accounting for headers, banking, compare bytes,
//! and RAM-only addresses. The pure module never touches the filesystem.

use rom_weaver_core::{Result, RomWeaverError, ValidationCodeError};

mod action_replay;
mod game_genie;
mod layout;
mod xploder;

#[cfg(test)]
use layout::Mapping;
pub use layout::RomLayout;

/// A console family whose cheat codes we can decode. The address layout and
/// code scheme differ per system, so the caller must identify it up front.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheatSystem {
    Nes,
    Snes,
    Genesis,
    GameBoy,
    GameBoyAdvance,
    PlayStation,
}

impl CheatSystem {
    /// Lowercase identifier used on the CLI / wasm boundary.
    pub const fn id(self) -> &'static str {
        match self {
            Self::Nes => "nes",
            Self::Snes => "snes",
            Self::Genesis => "genesis",
            Self::GameBoy => "gameboy",
            Self::GameBoyAdvance => "gba",
            Self::PlayStation => "psx",
        }
    }

    /// Parse the CLI/UI identifier (accepts a few common aliases).
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "nes" | "famicom" | "fc" => Some(Self::Nes),
            "snes" | "sfc" | "superfamicom" => Some(Self::Snes),
            "genesis" | "megadrive" | "mega-drive" | "md" | "smd" => Some(Self::Genesis),
            "gameboy" | "gb" | "gbc" => Some(Self::GameBoy),
            "gba" | "game-boy-advance" | "gameboy-advance" => Some(Self::GameBoyAdvance),
            "psx" | "ps1" | "playstation" | "playstation-1" => Some(Self::PlayStation),
            _ => None,
        }
    }
}

/// Which code scheme a textual code uses. GameShark codes share Pro Action
/// Replay's raw address:value form, so they are decoded as the same kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheatKind {
    GameGenie,
    ProActionReplay,
    Xploder,
}

impl CheatKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "gg" | "game-genie" | "gamegenie" | "genie" => Some(Self::GameGenie),
            "par" | "ar" | "action-replay" | "gameshark" | "gs" => Some(Self::ProActionReplay),
            "xploder" | "xplorer" | "codebreaker" | "code-breaker" => Some(Self::Xploder),
            _ => None,
        }
    }
}

/// A decoded cheat: a CPU/bus address, the replacement value (`width` bytes),
/// and an optional compare byte used to disambiguate the correct ROM bank when
/// baking the code into a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodedCode {
    pub system: CheatSystem,
    pub kind: CheatKind,
    pub address: u32,
    pub value: u32,
    pub compare: Option<u8>,
    pub width: u8,
}

/// A concrete byte write into the ROM file: overwrite `width` bytes at `offset`
/// with `value`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CheatWrite {
    pub offset: usize,
    pub value: u32,
    pub width: u8,
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

/// Split Xploder lines while keeping the words that make one code together.
/// A four-word GBA ROM-patch code stays together as one item.
pub fn split_xploder_codes(input: &str) -> Vec<String> {
    let mut codes = Vec::new();
    for segment in input.split(|c: char| c == '+' || c == ',' || c == ';') {
        let tokens: Vec<&str> = segment.split_whitespace().collect();
        let mut index = 0;
        while index < tokens.len() {
            if index + 3 < tokens.len()
                && tokens[index].len() == 8
                && tokens[index + 1].len() == 8
                && tokens[index + 2].len() == 8
                && tokens[index + 3].len() == 8
                && tokens[index].eq_ignore_ascii_case("00000000")
                && is_gba_rom_patch_word(tokens[index + 1])
                && tokens[index + 3].eq_ignore_ascii_case("00000000")
            {
                codes.push(format!(
                    "{}{}{}{}",
                    tokens[index],
                    tokens[index + 1],
                    tokens[index + 2],
                    tokens[index + 3]
                ));
                index += 4;
                continue;
            }
            if index + 1 < tokens.len()
                && tokens[index].len() == 8
                && (tokens[index + 1].len() == 4 || tokens[index + 1].len() == 8)
            {
                codes.push(format!("{}{}", tokens[index], tokens[index + 1]));
                index += 2;
                continue;
            }
            codes.push(tokens[index].to_owned());
            index += 1;
        }
    }
    codes
}

fn is_gba_rom_patch_word(token: &str) -> bool {
    token.len() == 8
        && matches!(
            token.as_bytes(),
            [b'1', b'8', ..]
                | [b'1', b'a' | b'A', ..]
                | [b'1', b'c' | b'C', ..]
                | [b'1', b'e' | b'E', ..]
        )
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
    let decoded = match kind {
        CheatKind::GameGenie => game_genie::decode(&normalized, system, code)?,
        CheatKind::ProActionReplay => action_replay::decode(&normalized, system, code)?,
        CheatKind::Xploder => xploder::decode(&normalized, system, code)?,
    };
    tracing::debug!(
        target: "rom_weaver_cheats",
        raw = code,
        address = format_args!("{:06X}", decoded.address),
        value = format_args!("{:08X}", decoded.value),
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
        CheatSystem::GameBoy => {
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
        CheatSystem::GameBoyAdvance | CheatSystem::PlayStation => CheatKind::Xploder,
    }
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
pub fn apply_writes(rom: &mut [u8], system: CheatSystem, writes: &[CheatWrite]) -> Result<()> {
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
            2 | 4 => {
                let bytes = if matches!(system, CheatSystem::Genesis) {
                    write.value.to_be_bytes()
                } else {
                    write.value.to_le_bytes()
                };
                let start = if write.width == 2 && matches!(system, CheatSystem::Genesis) {
                    2
                } else {
                    0
                };
                rom[write.offset..end].copy_from_slice(&bytes[start..start + write.width as usize]);
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
            value = format_args!("{:08X}", write.value),
            width = write.width,
            "applied cheat write"
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod cheats_tests;
