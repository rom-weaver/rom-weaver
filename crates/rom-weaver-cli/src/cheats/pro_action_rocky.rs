//! Famicom Pro Action Rocky decoder.
//!
//! Rocky codes are eight encrypted hexadecimal digits. They always carry a
//! replacement byte, a compare byte, and a 15-bit cartridge address whose
//! high bit is fixed. This independent implementation follows the published
//! bit layout and is checked against Mesen's compatible decoder:
//! <https://github.com/SourMesen/Mesen2/blob/master/Core/Shared/CheatManager.cpp>

use rom_weaver_core::Result;

use super::{CheatKind, CheatSystem, DecodedCode, coded};

const SHIFT_VALUES: [u32; 31] = [
    3, 13, 14, 1, 6, 9, 5, 0, 12, 7, 2, 8, 10, 11, 4, 19, 21, 23, 22, 20, 17, 16, 18, 29, 31, 24,
    26, 25, 30, 27, 28,
];

pub(crate) fn decode(normalized: &str, system: CheatSystem, raw: &str) -> Result<DecodedCode> {
    if system != CheatSystem::Nes {
        return Err(coded(
            "cheat_bad_system",
            "Pro Action Rocky codes only support NES/Famicom",
            raw,
        ));
    }
    if normalized.len() != 8 {
        return Err(coded(
            "cheat_bad_code",
            "Pro Action Rocky codes must be 8 hex digits",
            raw,
        ));
    }
    let mut encoded = u32::from_str_radix(normalized, 16).map_err(|_| {
        coded(
            "cheat_bad_code",
            "Pro Action Rocky code is not valid hexadecimal",
            raw,
        )
    })? >> 1;

    let mut key = 0x7E5E_E93A_u32;
    let mut decoded = 0_u32;
    for shift in SHIFT_VALUES.iter().rev() {
        if ((key ^ encoded) >> 30) & 1 != 0 {
            decoded |= 1 << shift;
            key ^= 0x5C18_4B91;
        }
        encoded <<= 1;
        key <<= 1;
    }

    Ok(DecodedCode {
        system: CheatSystem::Nes,
        kind: CheatKind::ProActionRocky,
        address: (decoded & 0x7FFF) | 0x8000,
        value: decoded >> 24,
        compare: Some(((decoded >> 16) & 0xFF) as u8),
        width: 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_published_fixed_vectors() {
        let cases = [
            ("FCBDD274", 0x8000, 0x00, 0x00),
            ("00000000", 0xE5DA, 0x3F, 0xD4),
            ("15C93C0A", 0x9123, 0xBD, 0xDE),
        ];

        for (code, address, value, compare) in cases {
            assert_eq!(
                decode(code, CheatSystem::Nes, code).unwrap(),
                DecodedCode {
                    system: CheatSystem::Nes,
                    kind: CheatKind::ProActionRocky,
                    address,
                    value,
                    compare: Some(compare),
                    width: 1,
                }
            );
        }
    }

    #[test]
    fn rejects_non_nes_systems() {
        let error = decode("00000000", CheatSystem::Snes, "00000000").unwrap_err();
        assert!(error.to_string().contains("cheat_bad_system"));
    }

    #[test]
    fn rejects_invalid_shapes() {
        for code in ["0000000", "000000000", "0000000G"] {
            let error = decode(code, CheatSystem::Nes, code).unwrap_err();
            assert!(error.to_string().contains("cheat_bad_code"));
        }
    }
}
