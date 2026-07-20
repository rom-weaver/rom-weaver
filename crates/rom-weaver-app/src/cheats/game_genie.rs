//! Game Genie code decoders for NES, SNES, Genesis/Mega Drive and Game Boy.
//!
//! Each scheme is a per-character alphabet substitution followed by a fixed
//! bit transposition. The permutation tables here were derived from public
//! references and verified against canonical worked examples (see the unit
//! tests): NES `AKE-LVS`→`$BD86:48`, SNES `ABCD-EFFF`→`C4A704:C9`,
//! Genesis `ABD5-78F7`→`BE47BD:1F00`, Game Boy `004-BCE-E66`→addr `$14BC`,
//! compare `$03`, value `$00`.

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

/// Move bit `perm[b]` of a `width`-bit MSB-first input to output position `b`.
fn transpose_bits(input: u64, perm: &[usize], width: usize) -> u64 {
    let mut out: u64 = 0;
    for (b, &src) in perm.iter().enumerate() {
        let bit = (input >> (width - 1 - src)) & 1;
        out |= bit << (width - 1 - b);
    }
    out
}

// --- NES -------------------------------------------------------------------

const NES_ALPHABET: [char; 16] = [
    'A', 'P', 'Z', 'L', 'G', 'I', 'T', 'Y', 'E', 'O', 'X', 'U', 'K', 'S', 'V', 'N',
];

fn nes_nibble(c: char) -> Option<u32> {
    NES_ALPHABET.iter().position(|&x| x == c).map(|i| i as u32)
}

fn decode_nes(code: &str, raw: &str) -> Result<DecodedCode> {
    if code.len() != 6 && code.len() != 8 {
        return Err(coded(
            "cheat_bad_code",
            "NES Game Genie codes must be 6 or 8 letters",
            raw,
        ));
    }
    let mut n = [0u32; 8];
    for (i, c) in code.chars().enumerate() {
        n[i] = nes_nibble(c).ok_or_else(|| {
            coded(
                "cheat_bad_code",
                "invalid character in NES Game Genie code",
                raw,
            )
        })?;
    }

    let address = 0x8000
        | ((n[3] & 7) << 12)
        | ((n[5] & 7) << 8)
        | ((n[4] & 8) << 8)
        | ((n[2] & 7) << 4)
        | ((n[1] & 8) << 4)
        | (n[4] & 7)
        | (n[3] & 8);

    let (value, compare) = if code.len() == 6 {
        let value = ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[5] & 8);
        (value, None)
    } else {
        let value = ((n[1] & 7) << 4) | ((n[0] & 8) << 4) | (n[0] & 7) | (n[7] & 8);
        let compare = ((n[7] & 7) << 4) | ((n[6] & 8) << 4) | (n[6] & 7) | (n[5] & 8);
        (value, Some(compare as u8))
    };

    Ok(DecodedCode {
        system: CheatSystem::Nes,
        kind: CheatKind::GameGenie,
        address,
        value: value as u16,
        compare,
        width: 1,
    })
}

// --- SNES ------------------------------------------------------------------

/// `SNES_ALPHABET[hex] = encoded char`; decoding inverts it.
const SNES_ALPHABET: [char; 16] = [
    'D', 'F', '4', '7', '0', '9', '1', '5', '6', 'B', 'C', '8', 'A', '2', '3', 'E',
];

const SNES_ADDR_PERM: [usize; 24] = [
    10, 11, 12, 13, 18, 19, 20, 21, 0, 1, 2, 3, 22, 23, 8, 9, 4, 5, 6, 7, 14, 15, 16, 17,
];

fn snes_nibble(c: char) -> Option<u32> {
    SNES_ALPHABET.iter().position(|&x| x == c).map(|i| i as u32)
}

fn decode_snes(code: &str, raw: &str) -> Result<DecodedCode> {
    if code.len() != 8 {
        return Err(coded(
            "cheat_bad_code",
            "SNES Game Genie codes must be 8 characters",
            raw,
        ));
    }
    let mut s = [0u32; 8];
    for (i, c) in code.chars().enumerate() {
        s[i] = snes_nibble(c).ok_or_else(|| {
            coded(
                "cheat_bad_code",
                "invalid character in SNES Game Genie code",
                raw,
            )
        })?;
    }

    let value = (s[0] << 4) | s[1];
    let addr_input = (s[2] << 20) | (s[3] << 16) | (s[4] << 12) | (s[5] << 8) | (s[6] << 4) | s[7];
    let address = transpose_bits(addr_input as u64, &SNES_ADDR_PERM, 24) as u32;

    Ok(DecodedCode {
        system: CheatSystem::Snes,
        kind: CheatKind::GameGenie,
        address,
        value: value as u16,
        compare: None,
        width: 1,
    })
}

// --- Genesis / Mega Drive --------------------------------------------------

const GENESIS_ALPHABET: [char; 32] = [
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P', 'R', 'S', 'T', 'V', 'W',
    'X', 'Y', 'Z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
];

const GENESIS_PERM: [usize; 40] = [
    16, 17, 18, 19, 20, 21, 22, 23, 8, 9, 10, 11, 12, 13, 14, 15, 32, 33, 34, 35, 36, 37, 38, 39,
    29, 30, 31, 24, 25, 26, 27, 28, 0, 1, 2, 3, 4, 5, 6, 7,
];

fn genesis_symbol(c: char) -> Option<u64> {
    GENESIS_ALPHABET
        .iter()
        .position(|&x| x == c)
        .map(|i| i as u64)
}

fn decode_genesis(code: &str, raw: &str) -> Result<DecodedCode> {
    if code.len() != 8 {
        return Err(coded(
            "cheat_bad_code",
            "Genesis Game Genie codes must be 8 characters",
            raw,
        ));
    }
    let mut input: u64 = 0;
    for c in code.chars() {
        let sym = genesis_symbol(c).ok_or_else(|| {
            coded(
                "cheat_bad_code",
                "invalid character in Genesis Game Genie code",
                raw,
            )
        })?;
        input = (input << 5) | sym;
    }

    let out = transpose_bits(input, &GENESIS_PERM, 40);
    let address = (out >> 16) as u32 & 0xFF_FFFF;
    let value = (out & 0xFFFF) as u16;

    Ok(DecodedCode {
        system: CheatSystem::Genesis,
        kind: CheatKind::GameGenie,
        address,
        value,
        compare: None,
        width: 2,
    })
}

// --- Game Boy / GBC --------------------------------------------------------

fn hex_digit(c: char, raw: &str) -> Result<u32> {
    c.to_digit(16).ok_or_else(|| {
        coded(
            "cheat_bad_code",
            "invalid character in Game Boy Game Genie code",
            raw,
        )
    })
}

fn decode_gameboy(code: &str, raw: &str) -> Result<DecodedCode> {
    if code.len() != 6 && code.len() != 9 {
        return Err(coded(
            "cheat_bad_code",
            "Game Boy Game Genie codes must be 6 or 9 hex digits",
            raw,
        ));
    }
    let mut d = [0u32; 9];
    for (i, c) in code.chars().enumerate() {
        d[i] = hex_digit(c, raw)?;
    }

    let value = (d[0] << 4) | d[1];
    // High nibble of the address is the 6th digit complemented; low 12 bits are
    // digits C,D,E.
    let address = ((0xF - d[5]) << 12) | (d[2] << 8) | (d[3] << 4) | d[4];

    let compare = if code.len() == 9 {
        // The 8th digit (d[7]) is a redundant check digit and is ignored; the
        // compare byte is carried by digits G and I, de-obfuscated by
        // XOR 0xFF, rotate-right 2, XOR 0x45.
        let rawcmp = ((d[6] << 4) | d[8]) as u8;
        let rotated = (rawcmp ^ 0xFF).rotate_right(2);
        Some(rotated ^ 0x45)
    } else {
        None
    };

    Ok(DecodedCode {
        system: CheatSystem::GameBoy,
        kind: CheatKind::GameGenie,
        address,
        value: value as u16,
        compare,
        width: 1,
    })
}
