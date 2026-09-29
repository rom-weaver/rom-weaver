//! SNES Gold Finger code decoder.
//!
//! Gold Finger codes use `AAAAADDDDDDCCF`: a 20-bit headerless ROM offset,
//! up to three sequential data bytes, a checksum, and a ROM/SRAM flag. Unused
//! trailing data bytes are written as `XX`.
//!
//! Format references:
//! - <https://patpend.net/technical/snes/sneskart.html>
//! - <https://github.com/libretro/bsnes-mercury/blob/master/target-libretro/libretro.cpp>

use rom_weaver_core::Result;

use super::{CheatKind, CheatSystem, DecodedCode, coded};

pub(crate) fn decode(normalized: &str, system: CheatSystem, raw: &str) -> Result<DecodedCode> {
    if system != CheatSystem::Snes {
        return Err(coded(
            "cheat_bad_system",
            "Gold Finger codes only support SNES",
            raw,
        ));
    }
    if normalized.len() != 14 || !normalized.is_ascii() {
        return Err(coded(
            "cheat_bad_code",
            "SNES Gold Finger codes must be 14 characters",
            raw,
        ));
    }

    let address = parse_hex(
        &normalized[0..5],
        raw,
        "Gold Finger address must be hexadecimal",
    )?;
    let checksum = parse_hex(
        &normalized[11..13],
        raw,
        "Gold Finger checksum must be hexadecimal",
    )? as u8;
    match normalized.as_bytes()[13] {
        b'0' => {}
        b'1' => {
            return Err(coded(
                "cheat_ram_address",
                "Gold Finger SRAM codes cannot be baked into a ROM file",
                raw,
            ));
        }
        _ => {
            return Err(coded(
                "cheat_bad_code",
                "Gold Finger function flag must be 0 for ROM or 1 for SRAM",
                raw,
            ));
        }
    }

    let mut value = 0u32;
    let mut width = 0u8;
    let mut found_unused = false;
    let mut checksum_sum = ((address >> 16) & 0xff) + ((address >> 8) & 0xff) + (address & 0xff);
    for index in 0..3 {
        let start = 5 + index * 2;
        let pair = &normalized[start..start + 2];
        if pair == "XX" {
            found_unused = true;
            continue;
        }
        if pair.as_bytes().contains(&b'X') {
            return Err(coded(
                "cheat_bad_code",
                "Gold Finger unused data bytes must be written as XX",
                raw,
            ));
        }
        if found_unused {
            return Err(coded(
                "cheat_bad_code",
                "Gold Finger unused data bytes must trail all written bytes",
                raw,
            ));
        }
        let byte = parse_hex(
            pair,
            raw,
            "Gold Finger data bytes must be hexadecimal or XX",
        )?;
        value |= byte << (index * 8);
        width += 1;
        checksum_sum += byte;
    }
    if width == 0 {
        return Err(coded(
            "cheat_bad_code",
            "Gold Finger codes must write at least one data byte",
            raw,
        ));
    }

    let expected_checksum = checksum_sum.wrapping_sub(0x160) as u8;
    if checksum != expected_checksum {
        return Err(coded(
            "cheat_bad_code",
            "Gold Finger checksum does not match the address and data",
            raw,
        ));
    }

    Ok(DecodedCode {
        system,
        kind: CheatKind::GoldFinger,
        address,
        value,
        compare: None,
        width,
    })
}

fn parse_hex(slice: &str, raw: &str, message: &'static str) -> Result<u32> {
    u32::from_str_radix(slice, 16).map_err(|_| coded("cheat_bad_code", message, raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_three_bytes_at_a_headerless_rom_offset() {
        let decoded = decode("12345ABCDEF700", CheatSystem::Snes, "12345ABCDEF700").unwrap();

        assert_eq!(decoded.address, 0x12345);
        assert_eq!(decoded.value, 0xEFCDAB);
        assert_eq!(decoded.width, 3);
        assert_eq!(decoded.kind, CheatKind::GoldFinger);
    }

    #[test]
    fn decodes_trailing_unused_data_bytes_as_a_short_write() {
        let decoded = decode("0000009XXXXA90", CheatSystem::Snes, "0000009XXXXA90").unwrap();

        assert_eq!(decoded.address, 0);
        assert_eq!(decoded.value, 0x09);
        assert_eq!(decoded.width, 1);
    }

    #[test]
    fn decodes_two_little_endian_bytes() {
        let decoded = decode("FFFFE3412XXF20", CheatSystem::Snes, "FFFFE3412XXF20").unwrap();

        assert_eq!(decoded.address, 0xFFFFE);
        assert_eq!(decoded.value, 0x1234);
        assert_eq!(decoded.width, 2);
    }

    #[test]
    fn rejects_sram_codes() {
        let error = decode("12345ABCDEF701", CheatSystem::Snes, "12345ABCDEF701").unwrap_err();

        assert!(error.to_string().contains("SRAM"));
    }

    #[test]
    fn rejects_bad_checksum() {
        let error = decode("12345ABCDEF710", CheatSystem::Snes, "12345ABCDEF710").unwrap_err();

        assert!(error.to_string().contains("checksum"));
    }

    #[test]
    fn rejects_a_data_byte_after_an_unused_sentinel() {
        let error = decode("0000009XX01AA0", CheatSystem::Snes, "0000009XX01AA0").unwrap_err();

        assert!(error.to_string().contains("trail"));
    }

    #[test]
    fn rejects_partial_unused_sentinel() {
        let error = decode("0000009X1XXA90", CheatSystem::Snes, "0000009X1XXA90").unwrap_err();

        assert!(error.to_string().contains("XX"));
    }

    #[test]
    fn rejects_a_code_with_no_data_bytes() {
        let error = decode("00000XXXXXXA00", CheatSystem::Snes, "00000XXXXXXA00").unwrap_err();

        assert!(error.to_string().contains("at least one"));
    }

    #[test]
    fn rejects_non_snes_systems() {
        let error = decode("12345ABCDEF700", CheatSystem::Genesis, "12345ABCDEF700").unwrap_err();

        assert!(error.to_string().contains("only support SNES"));
    }
}
