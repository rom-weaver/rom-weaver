//! Known ROM copier/intro header signatures and pure detection logic.
//!
//! Many console ROM dumps carry a removable header (copier or intro header)
//! prepended to the real data. This module identifies those headers from a byte
//! prefix or file size so callers can strip or re-attach them. It is pure data +
//! signature matching; the file/IO-driven detection workflow that uses these
//! types lives in `rom-weaver-app`'s `header_detection_and_finalize`.

pub const ROM_HEADER_BYTES: usize = 512;
pub const ROM_HEADER_SCAN_BYTES: usize = 0x8000;
pub const A78_HEADER_MAGIC: [u8; 9] = *b"ATARI7800";
pub const LNX_HEADER_MAGIC: [u8; 4] = *b"LYNX";
pub const INES_HEADER_MAGIC: [u8; 4] = *b"NES\x1A";
pub const FDS_HEADER_MAGIC: [u8; 3] = *b"FDS";
pub const SMS_TMR_SEGA_MAGIC: [u8; 8] = *b"TMR SEGA";
pub const NGP_COPYRIGHT_MAGIC: [u8; 16] = *b"COPYRIGHT BY SNK";
pub const GBA_HEADER_MAGIC: [u8; 4] = [0x24, 0xFF, 0xAE, 0x51];
pub const N64_BIG_ENDIAN_MAGIC: [u8; 4] = [0x80, 0x37, 0x12, 0x40];
pub const N64_LITTLE_ENDIAN_MAGIC: [u8; 4] = [0x40, 0x12, 0x37, 0x80];
pub const N64_BYTE_SWAPPED_MAGIC: [u8; 4] = [0x37, 0x80, 0x40, 0x12];
pub const SNES_COPIER_HEADER_MODULUS: u64 = 1024;
pub const PCE_COPIER_HEADER_MODULUS: u64 = 8192;
pub const NSRT_METADATA_OFFSET: usize = 0x1e8;
pub const NSRT_METADATA_MAGIC: [u8; 4] = *b"NSRT";
const SMC_GAME_DOCTOR_1_MAGIC: [u8; 16] = [
    0x00, 0x01, 0x4D, 0x45, 0x20, 0x44, 0x4F, 0x43, 0x54, 0x4F, 0x52, 0x20, 0x53, 0x46, 0x20, 0x33,
];
const SMC_GAME_DOCTOR_2_MAGIC: [u8; 16] = *b"GAME DOCTOR SF 3";
pub const GAME_BOY_NINTENDO_LOGO: [u8; 48] = [
    0xCE, 0xED, 0x66, 0x66, 0xCC, 0x0D, 0x00, 0x0B, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0C, 0x00, 0x0D,
    0x00, 0x08, 0x11, 0x1F, 0x88, 0x89, 0x00, 0x0E, 0xDC, 0xCC, 0x6E, 0xE6, 0xDD, 0xDD, 0xD9, 0x99,
    0xBB, 0xBB, 0x67, 0x63, 0x6E, 0x0E, 0xEC, 0xCC, 0xDD, 0xDC, 0x99, 0x9F, 0xBB, 0xB9, 0x33, 0x3E,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KnownRomHeader {
    A78,
    Lnx,
    Nes,
    Fds,
    SnesCopier,
    PceCopier,
    SmcZero,
    SmcGameDoctor1,
    SmcGameDoctor2,
    GameBoy,
    Gba,
    MegaDrive,
    SmsTmr,
    N64,
    Nds,
    NeoGeoPocket,
    Msx,
}

impl KnownRomHeader {
    pub const ALL: [Self; 17] = [
        Self::A78,
        Self::Lnx,
        Self::Nes,
        Self::Fds,
        Self::SnesCopier,
        Self::PceCopier,
        Self::SmcZero,
        Self::SmcGameDoctor1,
        Self::SmcGameDoctor2,
        Self::GameBoy,
        Self::Gba,
        Self::MegaDrive,
        Self::SmsTmr,
        Self::N64,
        Self::Nds,
        Self::NeoGeoPocket,
        Self::Msx,
    ];

    const fn profile_name(self) -> &'static str {
        match self {
            Self::A78 => "No-Intro_A7800.xml",
            Self::Lnx => "No-Intro_LNX.xml",
            Self::Nes => "No-Intro_NES.xml",
            Self::Fds => "No-Intro_FDS.xml",
            Self::SnesCopier => "SNES_COPIER_HEADER",
            Self::PceCopier => "PCE_COPIER_HEADER",
            Self::SmcZero => "SMC",
            Self::SmcGameDoctor1 => "SMC_GAME_DOCTOR_1",
            Self::SmcGameDoctor2 => "SMC_GAME_DOCTOR_2",
            Self::GameBoy => "Game Boy",
            Self::Gba => "Game Boy Advance",
            Self::MegaDrive => "Sega Mega Drive / Genesis",
            Self::SmsTmr => "SMS/GG_TMR_SEGA",
            Self::N64 => "Nintendo 64",
            Self::Nds => "Nintendo DS",
            Self::NeoGeoPocket => "Neo Geo Pocket",
            Self::Msx => "MSX AB",
        }
    }

    pub const fn headered_extension(self) -> &'static str {
        match self {
            Self::A78 => ".a78",
            Self::Lnx => ".lnx",
            Self::Nes => ".nes",
            Self::Fds => ".fds",
            Self::SnesCopier => ".smc",
            Self::PceCopier => ".pce",
            Self::SmcZero | Self::SmcGameDoctor1 | Self::SmcGameDoctor2 => ".smc",
            Self::GameBoy => ".gb",
            Self::Gba => ".gba",
            Self::MegaDrive => ".md",
            Self::SmsTmr => ".sms",
            Self::N64 => ".z64",
            Self::Nds => ".nds",
            Self::NeoGeoPocket => ".ngp",
            Self::Msx => ".mx1",
        }
    }

    pub const fn headerless_extension(self) -> &'static str {
        match self {
            Self::Lnx => ".lyx",
            Self::SmcZero | Self::SmcGameDoctor1 | Self::SmcGameDoctor2 => ".sfc",
            Self::A78 | Self::Nes | Self::Fds => self.headered_extension(),
            Self::SnesCopier => ".sfc",
            Self::PceCopier => ".tg16",
            Self::GameBoy => ".gbc",
            Self::Gba => self.headered_extension(),
            Self::MegaDrive => ".gen",
            Self::SmsTmr => ".gg",
            Self::N64 => ".n64",
            Self::Nds => ".dsi",
            Self::NeoGeoPocket => ".ngc",
            Self::Msx => ".mx2",
        }
    }

    /// Whether the stripped header should return on a patched output by default: format
    /// headers (iNES/fwNES/LNX/A78) carry emulator-required metadata, while SNES/PCE
    /// copier headers are junk left by copier devices - the modern convention (headerless
    /// `.sfc`) drops them. Only meaningful for strippable kinds; internal-header consoles
    /// return true as the safe identity. This is the kind-level default: an NSRT-signed
    /// SNES copier header carries real dump metadata and IS retained - callers with the
    /// stripped bytes in hand check [`header_has_nsrt_metadata`] on top of this.
    pub const fn retained_on_output(self) -> bool {
        !matches!(
            self,
            Self::SnesCopier
                | Self::PceCopier
                | Self::SmcZero
                | Self::SmcGameDoctor1
                | Self::SmcGameDoctor2
        )
    }

    pub const fn data_offset_bytes(self) -> Option<usize> {
        match self {
            Self::A78 => Some(128),
            Self::Lnx => Some(64),
            Self::Nes => Some(16),
            Self::Fds => Some(16),
            Self::SnesCopier
            | Self::PceCopier
            | Self::SmcZero
            | Self::SmcGameDoctor1
            | Self::SmcGameDoctor2 => Some(ROM_HEADER_BYTES),
            Self::GameBoy
            | Self::Gba
            | Self::MegaDrive
            | Self::SmsTmr
            | Self::N64
            | Self::Nds
            | Self::NeoGeoPocket
            | Self::Msx => None,
        }
    }

    const fn scan_bytes_required(self) -> usize {
        match self {
            Self::A78 => 1 + A78_HEADER_MAGIC.len(),
            Self::Lnx => LNX_HEADER_MAGIC.len(),
            Self::Nes => INES_HEADER_MAGIC.len(),
            Self::Fds => FDS_HEADER_MAGIC.len(),
            Self::SnesCopier | Self::PceCopier => 0,
            Self::SmcZero => ROM_HEADER_BYTES,
            Self::SmcGameDoctor1 => SMC_GAME_DOCTOR_1_MAGIC.len(),
            Self::SmcGameDoctor2 => SMC_GAME_DOCTOR_2_MAGIC.len(),
            Self::GameBoy => 0x134,
            Self::Gba => 0x08,
            Self::MegaDrive => 0x105,
            Self::SmsTmr => 0x7FF8,
            Self::N64 => N64_BIG_ENDIAN_MAGIC.len(),
            Self::Nds => 0xC4,
            Self::NeoGeoPocket => NGP_COPYRIGHT_MAGIC.len(),
            Self::Msx => 2,
        }
    }

    pub fn matches_extension(self, extension_with_dot: &str) -> bool {
        if self
            .headered_extension()
            .eq_ignore_ascii_case(extension_with_dot)
            || self
                .headerless_extension()
                .eq_ignore_ascii_case(extension_with_dot)
        {
            return true;
        }
        match self {
            Self::N64 => ".v64".eq_ignore_ascii_case(extension_with_dot),
            Self::Nds => ".srl".eq_ignore_ascii_case(extension_with_dot),
            _ => false,
        }
    }

    pub fn signature_matches(self, bytes: &[u8]) -> bool {
        if bytes.len() < self.scan_bytes_required() {
            return false;
        }
        match self {
            Self::A78 => bytes[1..1 + A78_HEADER_MAGIC.len()] == A78_HEADER_MAGIC,
            Self::Lnx => bytes[..LNX_HEADER_MAGIC.len()] == LNX_HEADER_MAGIC,
            Self::Nes => bytes[..INES_HEADER_MAGIC.len()] == INES_HEADER_MAGIC,
            Self::Fds => bytes[..FDS_HEADER_MAGIC.len()] == FDS_HEADER_MAGIC,
            Self::SnesCopier | Self::PceCopier => false,
            Self::SmcZero => bytes[3..ROM_HEADER_BYTES].iter().all(|value| *value == 0),
            Self::SmcGameDoctor1 => {
                bytes[..SMC_GAME_DOCTOR_1_MAGIC.len()] == SMC_GAME_DOCTOR_1_MAGIC
            }
            Self::SmcGameDoctor2 => {
                bytes[..SMC_GAME_DOCTOR_2_MAGIC.len()] == SMC_GAME_DOCTOR_2_MAGIC
            }
            Self::GameBoy => bytes[0x104..0x134] == GAME_BOY_NINTENDO_LOGO,
            Self::Gba => bytes[0x04..0x08] == GBA_HEADER_MAGIC,
            Self::MegaDrive => bytes[0x100..0x104] == *b"SEGA" || bytes[0x101..0x105] == *b"SEGA",
            Self::SmsTmr => [0x7FF0usize, 0x3FF0, 0x1FF0].iter().any(|offset| {
                bytes.get(*offset..offset.saturating_add(SMS_TMR_SEGA_MAGIC.len()))
                    == Some(SMS_TMR_SEGA_MAGIC.as_slice())
            }),
            Self::N64 => {
                bytes[..N64_BIG_ENDIAN_MAGIC.len()] == N64_BIG_ENDIAN_MAGIC
                    || bytes[..N64_LITTLE_ENDIAN_MAGIC.len()] == N64_LITTLE_ENDIAN_MAGIC
                    || bytes[..N64_BYTE_SWAPPED_MAGIC.len()] == N64_BYTE_SWAPPED_MAGIC
            }
            Self::Nds => bytes[0xC0..0xC4] == GBA_HEADER_MAGIC,
            Self::NeoGeoPocket => bytes[..NGP_COPYRIGHT_MAGIC.len()] == NGP_COPYRIGHT_MAGIC,
            Self::Msx => bytes[..2] == *b"AB",
        }
    }
}

/// Whether a stripped 512-byte SNES copier header carries NSRT dump metadata
/// (the `NSRT` signature at offset 0x1e8). NSRT headers hold real information
/// (title, region, dump checksums) unlike zero-padded copier junk, so output
/// policies retain them - matching the RUP (NINJA2) handler's own
/// normalization, which restores NSRT headers and drops the rest.
pub fn header_has_nsrt_metadata(header: &[u8]) -> bool {
    header.get(NSRT_METADATA_OFFSET..NSRT_METADATA_OFFSET + NSRT_METADATA_MAGIC.len())
        == Some(NSRT_METADATA_MAGIC.as_slice())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct KnownRomHeaderMatch {
    pub header: KnownRomHeader,
    pub stripped_bytes: Option<usize>,
}

impl KnownRomHeaderMatch {
    pub const fn profile_name(self) -> &'static str {
        self.header.profile_name()
    }

    pub const fn stripped_bytes(self) -> Option<usize> {
        self.stripped_bytes
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StripHeaderResult {
    pub header_bytes: Vec<u8>,
    pub matched_header: Option<KnownRomHeaderMatch>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nsrt_metadata_detected_in_snes_copier_header() {
        let mut header = vec![0_u8; ROM_HEADER_BYTES];
        header[NSRT_METADATA_OFFSET..NSRT_METADATA_OFFSET + NSRT_METADATA_MAGIC.len()]
            .copy_from_slice(&NSRT_METADATA_MAGIC);
        assert!(header_has_nsrt_metadata(&header));
    }

    #[test]
    fn zero_copier_header_has_no_nsrt_metadata() {
        assert!(!header_has_nsrt_metadata(&vec![0_u8; ROM_HEADER_BYTES]));
    }

    #[test]
    fn short_format_header_has_no_nsrt_metadata() {
        // A 16-byte iNES header can never cover the NSRT offset; the check must
        // not read past the header slice into ROM payload bytes.
        assert!(!header_has_nsrt_metadata(&[0_u8; 16]));
    }
}
