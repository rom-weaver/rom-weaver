//! ROM layout detection and address→file-offset resolution.
//!
//! A decoded code carries a CPU/bus address; turning that into a file offset
//! needs the ROM's header presence and banking scheme. [`RomLayout::detect`]
//! derives those purely from the ROM bytes, and [`resolve_writes`] maps a
//! [`DecodedCode`] onto one or more [`CheatWrite`]s - scanning banks for a
//! compare match where one is supplied, and rejecting RAM-only codes that
//! cannot be baked into a ROM file.

use rom_weaver_core::Result;

use super::{CheatSystem, CheatWrite, DecodedCode, coded};

const NES_INES_MAGIC: [u8; 4] = *b"NES\x1A";
const NES_HEADER_BYTES: usize = 16;
/// iNES flags6 bit 2 marks a 512-byte trainer between the header and PRG-ROM.
const NES_TRAINER_FLAG: u8 = 0x04;
const NES_TRAINER_BYTES: usize = 512;
const NES_BANK_BYTES: usize = 0x4000;
const SNES_COPIER_HEADER_BYTES: usize = 512;
const GB_BANK_BYTES: usize = 0x4000;

/// How CPU/bus addresses map onto file offsets for a ROM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mapping {
    /// Bus address is the file offset directly (Genesis, Game Boy bank 0).
    Flat,
    /// NES PRG-ROM with 16 KiB banking.
    NesPrg {
        prg_bytes: usize,
    },
    SnesLoRom,
    SnesHiRom,
}

/// Header presence + banking scheme for a ROM image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RomLayout {
    pub system: CheatSystem,
    pub header_bytes: usize,
    pub mapping: Mapping,
}

impl RomLayout {
    /// Derive a layout from the ROM bytes for a known system.
    pub fn detect(rom: &[u8], system: CheatSystem) -> Self {
        match system {
            CheatSystem::Nes => detect_nes(rom),
            CheatSystem::Snes => detect_snes(rom),
            CheatSystem::Genesis | CheatSystem::GameBoy => Self {
                system,
                header_bytes: 0,
                mapping: Mapping::Flat,
            },
        }
    }
}

fn detect_nes(rom: &[u8]) -> RomLayout {
    let headered = rom.len() >= NES_HEADER_BYTES && rom[..4] == NES_INES_MAGIC;
    // A trainer (flags6 bit 2) inserts 512 bytes between the header and PRG-ROM;
    // skipping it as well keeps PRG offsets correct.
    let trainer_bytes = if headered && rom[6] & NES_TRAINER_FLAG != 0 {
        NES_TRAINER_BYTES
    } else {
        0
    };
    let header_bytes = if headered {
        NES_HEADER_BYTES + trainer_bytes
    } else {
        0
    };
    let prg_bytes = if headered {
        let declared = rom[4] as usize * NES_BANK_BYTES;
        let available = rom.len().saturating_sub(header_bytes);
        if declared == 0 || declared > available {
            available
        } else {
            declared
        }
    } else {
        rom.len()
    };
    RomLayout {
        system: CheatSystem::Nes,
        header_bytes,
        mapping: Mapping::NesPrg { prg_bytes },
    }
}

/// A valid SNES internal header has checksum and complement that XOR to 0xFFFF.
fn snes_header_valid(rom: &[u8], base: usize) -> bool {
    let complement = read_u16_le(rom, base + 0x1C);
    let checksum = read_u16_le(rom, base + 0x1E);
    match (complement, checksum) {
        (Some(c), Some(s)) => (c ^ s) == 0xFFFF && s != 0,
        _ => false,
    }
}

fn detect_snes(rom: &[u8]) -> RomLayout {
    // The 512-byte copier header is only present when the file size leaves a
    // 512-byte remainder, but that size heuristic alone false-positives on some
    // images. Disambiguate by checking which (header, mapping) combination has a
    // valid internal header (checksum XOR complement == 0xFFFF), preferring the
    // copier-headered interpretation when the size suggests it.
    let size_suggests_copier = rom.len() % 1024 == SNES_COPIER_HEADER_BYTES;
    let header_candidates: &[usize] = if size_suggests_copier {
        &[SNES_COPIER_HEADER_BYTES, 0]
    } else {
        &[0]
    };
    for &header_bytes in header_candidates {
        let lo_valid = snes_header_valid(rom, header_bytes + 0x7FC0);
        let hi_valid = snes_header_valid(rom, header_bytes + 0xFFC0);
        if lo_valid || hi_valid {
            let mapping = if hi_valid && !lo_valid {
                Mapping::SnesHiRom
            } else {
                Mapping::SnesLoRom
            };
            return RomLayout {
                system: CheatSystem::Snes,
                header_bytes,
                mapping,
            };
        }
    }
    // No internal header validated; fall back to the size heuristic + LoROM.
    RomLayout {
        system: CheatSystem::Snes,
        header_bytes: if size_suggests_copier {
            SNES_COPIER_HEADER_BYTES
        } else {
            0
        },
        mapping: Mapping::SnesLoRom,
    }
}

fn read_u16_le(rom: &[u8], at: usize) -> Option<u16> {
    let lo = *rom.get(at)? as u16;
    let hi = *rom.get(at + 1)? as u16;
    Some(lo | (hi << 8))
}

fn ram_error(offending: &str) -> rom_weaver_core::RomWeaverError {
    coded(
        "cheat_ram_address",
        "code targets RAM and cannot be baked into a ROM file",
        offending,
    )
}

fn range_error(offset: usize, len: usize) -> rom_weaver_core::RomWeaverError {
    coded(
        "cheat_offset_out_of_range",
        "resolved cheat offset is past the end of the ROM",
        &format!("offset={offset:#X} len={len:#X}"),
    )
}

fn no_match_error(offending: &str) -> rom_weaver_core::RomWeaverError {
    coded(
        "cheat_no_compare_match",
        "no ROM location matched the code's compare value",
        offending,
    )
}

pub(crate) fn resolve_writes(
    rom: &[u8],
    layout: &RomLayout,
    decoded: &DecodedCode,
) -> Result<Vec<CheatWrite>> {
    match layout.system {
        CheatSystem::Nes => resolve_nes(rom, layout, decoded),
        CheatSystem::Snes => resolve_snes(rom, layout, decoded),
        CheatSystem::Genesis => resolve_genesis(rom, layout, decoded),
        CheatSystem::GameBoy => resolve_gameboy(rom, decoded),
    }
}

fn resolve_nes(rom: &[u8], layout: &RomLayout, decoded: &DecodedCode) -> Result<Vec<CheatWrite>> {
    let cpu = decoded.address;
    let offending = format!("{cpu:#06X}");
    if cpu < 0x8000 {
        return Err(ram_error(&offending));
    }
    let prg_bytes = match layout.mapping {
        Mapping::NesPrg { prg_bytes } => prg_bytes,
        _ => rom.len().saturating_sub(layout.header_bytes),
    };
    // Fold both 16 KiB CPU windows ($8000-$BFFF, $C000-$FFFF) into a bank offset.
    let window_off = ((cpu - 0x8000) as usize) % NES_BANK_BYTES;
    let num_banks = (prg_bytes / NES_BANK_BYTES).max(1);

    if let Some(compare) = decoded.compare {
        let mut writes = Vec::new();
        for bank in 0..num_banks {
            let offset = layout.header_bytes + bank * NES_BANK_BYTES + window_off;
            if rom.get(offset) == Some(&compare) {
                writes.push(CheatWrite {
                    offset,
                    value: decoded.value,
                    width: decoded.width,
                });
            }
        }
        if writes.is_empty() {
            return Err(no_match_error(&offending));
        }
        return Ok(writes);
    }

    // No compare: pick the naive bank - the fixed last bank for $C000-$FFFF,
    // otherwise bank 0. Ambiguous on banked carts; documented best effort.
    let bank = if cpu >= 0xC000 { num_banks - 1 } else { 0 };
    let offset = layout.header_bytes + bank * NES_BANK_BYTES + window_off;
    if offset >= rom.len() {
        return Err(range_error(offset, rom.len()));
    }
    Ok(vec![CheatWrite {
        offset,
        value: decoded.value,
        width: decoded.width,
    }])
}

fn resolve_snes(rom: &[u8], layout: &RomLayout, decoded: &DecodedCode) -> Result<Vec<CheatWrite>> {
    let cpu = decoded.address;
    let offending = format!("{cpu:#08X}");
    let bank = (cpu >> 16) & 0xFF;
    let low = cpu & 0xFFFF;
    // WRAM banks and the low system-RAM mirror cannot be baked into ROM.
    let system_bank = bank <= 0x3F || (0x80..=0xBF).contains(&bank);
    if bank == 0x7E || bank == 0x7F || (system_bank && low < 0x2000) {
        return Err(ram_error(&offending));
    }
    let offset = match layout.mapping {
        Mapping::SnesHiRom => layout.header_bytes + (cpu as usize & 0x3F_FFFF),
        // LoROM maps ROM only into each bank's upper half ($8000-$FFFF); a
        // lower-half address is RAM/IO, not a ROM byte, so reject it rather than
        // silently folding it onto a valid-looking offset.
        _ => {
            if low & 0x8000 == 0 {
                return Err(ram_error(&offending));
            }
            layout.header_bytes + (((bank as usize & 0x7F) << 15) | (low as usize & 0x7FFF))
        }
    };
    if offset >= rom.len() {
        return Err(range_error(offset, rom.len()));
    }
    Ok(vec![CheatWrite {
        offset,
        value: decoded.value,
        width: decoded.width,
    }])
}

fn resolve_genesis(
    rom: &[u8],
    layout: &RomLayout,
    decoded: &DecodedCode,
) -> Result<Vec<CheatWrite>> {
    let cpu = decoded.address;
    let offending = format!("{cpu:#08X}");
    // $E00000-$FFFFFF is the 68k work-RAM mirror.
    if cpu >= 0xE0_0000 {
        return Err(ram_error(&offending));
    }
    let offset = layout.header_bytes + cpu as usize;
    if offset + decoded.width as usize > rom.len() {
        return Err(range_error(offset, rom.len()));
    }
    Ok(vec![CheatWrite {
        offset,
        value: decoded.value,
        width: decoded.width,
    }])
}

fn resolve_gameboy(rom: &[u8], decoded: &DecodedCode) -> Result<Vec<CheatWrite>> {
    let cpu = decoded.address;
    let offending = format!("{cpu:#06X}");
    // Cartridge ROM is $0000-$7FFF; anything above is RAM/IO.
    if cpu >= 0x8000 {
        return Err(ram_error(&offending));
    }

    // Fixed bank 0.
    if cpu < 0x4000 {
        let offset = cpu as usize;
        if let Some(compare) = decoded.compare
            && rom.get(offset) != Some(&compare)
        {
            return Err(no_match_error(&offending));
        }
        if offset >= rom.len() {
            return Err(range_error(offset, rom.len()));
        }
        return Ok(vec![CheatWrite {
            offset,
            value: decoded.value,
            width: decoded.width,
        }]);
    }

    // Switchable $4000-$7FFF window.
    let window_off = (cpu as usize) - 0x4000;
    let num_banks = (rom.len() / GB_BANK_BYTES).max(1);
    if let Some(compare) = decoded.compare {
        let mut writes = Vec::new();
        // Bank 0 is fixed at $0000-$3FFF and never maps into the switchable
        // $4000-$7FFF window, so writing a bank-0 file offset here would corrupt
        // the fixed bank; the no-compare branch below already assumes bank 1+.
        for bank in 1..num_banks {
            let offset = bank * GB_BANK_BYTES + window_off;
            if rom.get(offset) == Some(&compare) {
                writes.push(CheatWrite {
                    offset,
                    value: decoded.value,
                    width: decoded.width,
                });
            }
        }
        if writes.is_empty() {
            return Err(no_match_error(&offending));
        }
        return Ok(writes);
    }

    // No compare: bank 1 maps to file $4000-$7FFF.
    let offset = cpu as usize;
    if offset >= rom.len() {
        return Err(range_error(offset, rom.len()));
    }
    Ok(vec![CheatWrite {
        offset,
        value: decoded.value,
        width: decoded.width,
    }])
}
