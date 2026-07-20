//! Pro Action Replay / GameShark code decoders.
//!
//! Unlike Game Genie, these schemes are (mostly) un-obfuscated address:value
//! pairs. Many of them target system RAM rather than the cartridge ROM and so
//! cannot be baked into a ROM file - that rejection happens later in the layout
//! stage where each system's ROM address range is known.

use rom_weaver_core::Result;

use super::{CheatKind, CheatSystem, DecodedCode, coded};

pub(crate) fn decode(normalized: &str, system: CheatSystem, raw: &str) -> Result<DecodedCode> {
    match system {
        CheatSystem::Nes => decode_nes(normalized, raw),
        CheatSystem::Snes => decode_snes(normalized, raw),
        CheatSystem::Genesis => decode_genesis(normalized, raw),
        CheatSystem::GameBoy => decode_gameboy(normalized, raw),
    }
}

fn parse_hex(slice: &str, raw: &str) -> Result<u32> {
    u32::from_str_radix(slice, 16).map_err(|_| {
        coded(
            "cheat_bad_code",
            "Pro Action Replay code is not valid hexadecimal",
            raw,
        )
    })
}

fn require_hex(code: &str, raw: &str) -> Result<()> {
    if code.is_empty() || !code.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(coded(
            "cheat_bad_code",
            "Pro Action Replay code must be hexadecimal",
            raw,
        ));
    }
    Ok(())
}

/// NES Pro Action Replay: `AAAAVV` (address+value) or `AAAAVVCC` (with compare).
fn decode_nes(code: &str, raw: &str) -> Result<DecodedCode> {
    require_hex(code, raw)?;
    let (address, value, compare) = match code.len() {
        6 => (
            parse_hex(&code[0..4], raw)?,
            parse_hex(&code[4..6], raw)?,
            None,
        ),
        8 => (
            parse_hex(&code[0..4], raw)?,
            parse_hex(&code[4..6], raw)?,
            Some(parse_hex(&code[6..8], raw)? as u8),
        ),
        _ => {
            return Err(coded(
                "cheat_bad_code",
                "NES Pro Action Replay codes must be 6 or 8 hex digits",
                raw,
            ));
        }
    };
    Ok(DecodedCode {
        system: CheatSystem::Nes,
        kind: CheatKind::ProActionReplay,
        address,
        value: value as u16,
        compare,
        width: 1,
    })
}

/// SNES Pro Action Replay: `XXXXXXVV` (24-bit bus address + value byte).
fn decode_snes(code: &str, raw: &str) -> Result<DecodedCode> {
    require_hex(code, raw)?;
    if code.len() != 8 {
        return Err(coded(
            "cheat_bad_code",
            "SNES Pro Action Replay codes must be 8 hex digits",
            raw,
        ));
    }
    let address = parse_hex(&code[0..6], raw)?;
    let value = parse_hex(&code[6..8], raw)?;
    Ok(DecodedCode {
        system: CheatSystem::Snes,
        kind: CheatKind::ProActionReplay,
        address,
        value: value as u16,
        compare: None,
        width: 1,
    })
}

/// Genesis GameShark / Pro Action Replay: `AAAAAA:VVVV` (24-bit address + 16-bit
/// value) or `AAAAAAVV` (8-bit value).
fn decode_genesis(code: &str, raw: &str) -> Result<DecodedCode> {
    require_hex(code, raw)?;
    let (address, value, width) = match code.len() {
        10 => (
            parse_hex(&code[0..6], raw)?,
            parse_hex(&code[6..10], raw)? as u16,
            2,
        ),
        8 => (
            parse_hex(&code[0..6], raw)?,
            parse_hex(&code[6..8], raw)? as u16,
            1,
        ),
        _ => {
            return Err(coded(
                "cheat_bad_code",
                "Genesis GameShark codes must be 8 or 10 hex digits",
                raw,
            ));
        }
    };
    Ok(DecodedCode {
        system: CheatSystem::Genesis,
        kind: CheatKind::ProActionReplay,
        address,
        value,
        compare: None,
        width,
    })
}

/// Game Boy GameShark: `TTVVAAAA` - type byte, value byte, little-endian
/// 16-bit address.
fn decode_gameboy(code: &str, raw: &str) -> Result<DecodedCode> {
    require_hex(code, raw)?;
    if code.len() != 8 {
        return Err(coded(
            "cheat_bad_code",
            "Game Boy GameShark codes must be 8 hex digits",
            raw,
        ));
    }
    let value = parse_hex(&code[2..4], raw)?;
    let low = parse_hex(&code[4..6], raw)?;
    let high = parse_hex(&code[6..8], raw)?;
    let address = (high << 8) | low;
    Ok(DecodedCode {
        system: CheatSystem::GameBoy,
        kind: CheatKind::ProActionReplay,
        address,
        value: value as u16,
        compare: None,
        width: 1,
    })
}
