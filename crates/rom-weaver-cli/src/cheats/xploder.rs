//! Raw Xploder code decoders for GBA and PlayStation.
//!
//! Xploder codes normally write live console memory. The layout stage rejects
//! those addresses unless the target maps to a ROM image that can be patched.

use rom_weaver_core::Result;

use super::{CheatKind, CheatSystem, DecodedCode, coded};

pub(crate) fn decode(normalized: &str, system: CheatSystem, raw: &str) -> Result<DecodedCode> {
    match system {
        CheatSystem::GameBoyAdvance => decode_gba(normalized, raw),
        CheatSystem::PlayStation => decode_playstation(normalized, raw),
        _ => Err(coded(
            "cheat_bad_system",
            "Xploder codes need GBA or PlayStation as the code system",
            raw,
        )),
    }
}

fn parse_hex(slice: &str, raw: &str) -> Result<u32> {
    u32::from_str_radix(slice, 16).map_err(|_| {
        coded(
            "cheat_bad_code",
            "Xploder code is not valid hexadecimal",
            raw,
        )
    })
}

fn require_hex(code: &str, raw: &str) -> Result<()> {
    if code.is_empty() || !code.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(coded(
            "cheat_bad_code",
            "Xploder code must be hexadecimal",
            raw,
        ));
    }
    Ok(())
}

fn unsupported(raw: &str, message: &'static str) -> rom_weaver_core::RomWeaverError {
    coded("cheat_unsupported_code", message, raw)
}

/// Decode Codebreaker/Xploder Advance's two-word raw codes.
fn decode_gba(code: &str, raw: &str) -> Result<DecodedCode> {
    require_hex(code, raw)?;
    if code.len() == 32 {
        return decode_gba_rom_patch(code, raw);
    }
    if code.len() != 12 {
        return Err(unsupported(
            raw,
            "GBA Xploder codes must be one raw line or a four-line ROM patch",
        ));
    }

    let address = parse_hex(&code[1..8], raw)?;
    let (value, width) = match &code[..1] {
        "3" => {
            if &code[8..10] != "00" {
                return Err(unsupported(
                    raw,
                    "GBA Xploder type 3 codes must use a zero-extended byte value",
                ));
            }
            (parse_hex(&code[10..12], raw)?, 1)
        }
        "8" => (parse_hex(&code[8..12], raw)?, 2),
        _ => {
            return Err(unsupported(
                raw,
                "this GBA Xploder code is a runtime, conditional, or enable code",
            ));
        }
    };

    Ok(DecodedCode {
        system: CheatSystem::GameBoyAdvance,
        kind: CheatKind::Xploder,
        address,
        value,
        compare: None,
        width,
    })
}

/// Decode the four-word GBA ROM-patch form. The address field counts halfwords.
fn decode_gba_rom_patch(code: &str, raw: &str) -> Result<DecodedCode> {
    if &code[..8] != "00000000"
        || !matches!(&code[8..10], "18" | "1A" | "1C" | "1E")
        || &code[16..20] != "0000"
        || &code[24..32] != "00000000"
    {
        return Err(unsupported(
            raw,
            "this GBA Xploder multi-line code is not a ROM patch",
        ));
    }
    let halfword_offset = parse_hex(&code[10..16], raw)?;
    let value = parse_hex(&code[20..24], raw)?;
    let address = 0x0800_0000u32.saturating_add(halfword_offset.saturating_mul(2));
    Ok(DecodedCode {
        system: CheatSystem::GameBoyAdvance,
        kind: CheatKind::Xploder,
        address,
        value,
        compare: None,
        width: 2,
    })
}

/// Decode the plain PSX Xplorer/Xploder constant-write forms.
fn decode_playstation(code: &str, raw: &str) -> Result<DecodedCode> {
    require_hex(code, raw)?;
    if code.len() != 12 {
        return Err(unsupported(
            raw,
            "PlayStation Xploder codes must be one raw line",
        ));
    }
    let mode = u8::from_str_radix(&code[1..2], 16).map_err(|_| {
        coded(
            "cheat_bad_code",
            "PlayStation Xploder code has an invalid mode",
            raw,
        )
    })?;
    if mode & 0x07 != 0 {
        return Err(coded(
            "cheat_encrypted_code",
            "encrypted PlayStation Xploder codes are not supported",
            raw,
        ));
    }

    let (address, value, width) = if &code[..1] == "3" {
        if &code[8..10] != "00" {
            return Err(unsupported(
                raw,
                "PlayStation Xploder type 3 codes must use a zero-extended byte value",
            ));
        }
        (
            0x8000_0000 | parse_hex(&code[2..8], raw)?,
            parse_hex(&code[10..12], raw)?,
            1,
        )
    } else if &code[..1] == "8" {
        (
            0x8000_0000 | parse_hex(&code[2..8], raw)?,
            parse_hex(&code[8..12], raw)?,
            2,
        )
    } else if &code[..2] == "00" {
        (
            0x8000_0000 | parse_hex(&code[2..8], raw)?,
            parse_hex(&code[8..12], raw)?,
            4,
        )
    } else {
        return Err(unsupported(
            raw,
            "this PlayStation Xploder code is conditional or not a constant write",
        ));
    };

    Ok(DecodedCode {
        system: CheatSystem::PlayStation,
        kind: CheatKind::Xploder,
        address,
        value,
        compare: None,
        width,
    })
}
