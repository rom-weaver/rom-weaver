//! Console/platform detection for ROM identification.
//!
//! The identify feature stores one hash→name database per platform, so the
//! probe must name the platform of an input to pick the right database. Two
//! detection paths:
//!
//! * **Cartridge** inputs reuse the header signatures in [`crate::rom_headers`]
//!   (see [`platform_for_rom_header`]).
//! * **Disc** images share extensions (`.iso`, `.chd`, `.cue`/`.bin`, …) across
//!   wildly different consoles, so extension is useless. Instead every disc
//!   carries a console signature either in its system area (sector 0) or its
//!   ISO 9660 filesystem; [`detect_disc_platform`] reads those. The container
//!   layer is responsible for decoding (CHD/RVZ) and de-framing CD 2352-byte
//!   sectors down to 2048-byte user data before calling in via
//!   [`DiscSectorSource`].
//!
//! Detection never guesses: when no signature matches it returns `None` so the
//! probe emits no platform rather than a wrong one.

use std::io;

use crate::rom_headers::KnownRomHeader;

/// Canonical platform identifiers.
pub mod platform {
    pub const PS1: &str = "Sony PlayStation";
    pub const PS2: &str = "Sony PlayStation 2";
    pub const PSP: &str = "Sony Playstation Portable";
    pub const SATURN: &str = "Sega Saturn";
    pub const DREAMCAST: &str = "Sega Dreamcast";
    pub const SEGA_CD: &str = "Sega Mega CD _ Sega CD";
    pub const PCE_CD: &str = "NEC PC-Engine CD & TurboGrafx-16 CD";
    pub const GAMECUBE: &str = "Nintendo GameCube";
    pub const WII: &str = "Nintendo Wii";
    pub const N3DS: &str = "Nintendo 3DS";
    pub const NDS: &str = "Nintendo DS";

    pub const ATARI_7800: &str = "Atari 7800";
    pub const LYNX: &str = "Atari Lynx";
    pub const NES: &str = "Nintendo Entertainment System";
    pub const FDS: &str = "Nintendo Famicom Disk System";
    pub const SNES: &str = "Nintendo Super Nintendo Entertainment System";
    pub const PCE: &str = "TurboGrafx-16_PC Engine";
    pub const GAME_BOY: &str = "Nintendo Game Boy";
    pub const GBA: &str = "Nintendo Game Boy Advance";
    pub const GENESIS: &str = "Sega Mega Drive _ Genesis";
    pub const MASTER_SYSTEM: &str = "Sega Master System";
    pub const N64: &str = "Nintendo 64";
    pub const NEO_GEO_POCKET: &str = "Neo Geo Pocket";
}

/// Map a detected cartridge header to its identify platform, where one exists.
///
/// Some headers are inherently ambiguous (Game Boy vs Color, SMS vs Game Gear,
/// NGP vs Color); we emit the most common member and let CRC32 lookup decide —
/// a wrong guess simply yields no match, never a false identification. Headers
/// with no corresponding identify database (e.g. MSX) return `None`.
pub const fn platform_for_rom_header(header: KnownRomHeader) -> Option<&'static str> {
    match header {
        KnownRomHeader::A78 => Some(platform::ATARI_7800),
        KnownRomHeader::Lnx => Some(platform::LYNX),
        KnownRomHeader::Nes => Some(platform::NES),
        KnownRomHeader::Fds => Some(platform::FDS),
        KnownRomHeader::SnesCopier
        | KnownRomHeader::SmcZero
        | KnownRomHeader::SmcGameDoctor1
        | KnownRomHeader::SmcGameDoctor2 => Some(platform::SNES),
        KnownRomHeader::PceCopier => Some(platform::PCE),
        KnownRomHeader::GameBoy => Some(platform::GAME_BOY),
        KnownRomHeader::Gba => Some(platform::GBA),
        KnownRomHeader::MegaDrive => Some(platform::GENESIS),
        KnownRomHeader::SmsTmr => Some(platform::MASTER_SYSTEM),
        KnownRomHeader::N64 => Some(platform::N64),
        KnownRomHeader::Nds => Some(platform::NDS),
        KnownRomHeader::NeoGeoPocket => Some(platform::NEO_GEO_POCKET),
        KnownRomHeader::Msx => None,
    }
}

/// 2048-byte logical (Mode-1 / Mode-2 Form-1 user-data) sector size.
const SECTOR_BYTES: usize = 2048;
/// ISO 9660 Primary Volume Descriptor location.
const PVD_LBA: u64 = 16;
/// GameCube disc magic (`0xC2339F3D`, big-endian) at byte offset 0x1C.
const GAMECUBE_MAGIC: u32 = 0xC233_9F3D;
/// Wii disc magic (`0x5D1C9EA3`, big-endian) at byte offset 0x18.
const WII_MAGIC: u32 = 0x5D1C_9EA3;

/// Source of 2048-byte user-data sectors for a disc image.
///
/// Implementors decode the container (CHD/RVZ/CSO/raw) and present logical
/// sectors; `read_sectors` returns `count` consecutive sectors from `lba`
/// concatenated, or fewer bytes at end-of-disc.
pub trait DiscSectorSource {
    fn read_sectors(&self, lba: u64, count: u32) -> io::Result<Vec<u8>>;
}

/// Detect the console of a disc image from its on-disc signatures, or `None`.
pub fn detect_disc_platform(source: &dyn DiscSectorSource) -> Option<&'static str> {
    if let Ok(sector0) = source.read_sectors(0, 1)
        && let Some(platform) = detect_from_sector0(&sector0)
    {
        return Some(platform);
    }
    detect_iso9660_platform(source)
}

/// System-area (sector 0) magic checks: Sega CD/Saturn/Dreamcast ASCII headers
/// and GameCube/Wii/3DS magic words.
fn detect_from_sector0(sector0: &[u8]) -> Option<&'static str> {
    if sector0.len() >= 16 {
        let head = &sector0[..16];
        if head.starts_with(b"SEGA SEGASATURN") {
            return Some(platform::SATURN);
        }
        if head.starts_with(b"SEGA SEGAKATANA") {
            return Some(platform::DREAMCAST);
        }
        if head.starts_with(b"SEGADISCSYSTEM") || head.starts_with(b"SEGABOOTDISC") {
            return Some(platform::SEGA_CD);
        }
    }
    if read_be32(sector0, 0x18) == Some(WII_MAGIC) {
        return Some(platform::WII);
    }
    if read_be32(sector0, 0x1C) == Some(GAMECUBE_MAGIC) {
        return Some(platform::GAMECUBE);
    }
    if sector0.len() >= 0x104 && &sector0[0x100..0x104] == b"NCSD" {
        return Some(platform::N3DS);
    }
    None
}

/// ISO 9660 path: read the PVD, walk the root directory, and disambiguate the
/// Sony consoles (PSP via `UMD_DATA.BIN`/`PSP_GAME`; PS2 vs PS1 via the
/// `BOOT2`/`BOOT` line in `SYSTEM.CNF`).
fn detect_iso9660_platform(source: &dyn DiscSectorSource) -> Option<&'static str> {
    let pvd = source.read_sectors(PVD_LBA, 1).ok()?;
    // Primary Volume Descriptor: type byte 1, standard identifier "CD001".
    if pvd.len() < 190 || pvd[0] != 1 || &pvd[1..6] != b"CD001" {
        return None;
    }
    // Root directory record lives at offset 156 of the PVD.
    let root_lba = read_le32(&pvd, 156 + 2)? as u64;
    let root_len = read_le32(&pvd, 156 + 10)?;
    let entries = read_directory(source, root_lba, root_len)?;

    let mut system_cnf: Option<(u64, u32)> = None;
    for entry in &entries {
        let name = entry.upper_name();
        if name.starts_with("UMD_DATA.BIN") || name == "PSP_GAME" {
            return Some(platform::PSP);
        }
        if name.starts_with("SYSTEM.CNF") {
            system_cnf = Some((entry.lba, entry.len));
        }
    }

    let (lba, len) = system_cnf?;
    let sectors = len.div_ceil(SECTOR_BYTES as u32).max(1);
    let data = source.read_sectors(lba, sectors).ok()?;
    let text = &data[..(len as usize).min(data.len())];
    // Check BOOT2 before BOOT: the PS2 token contains the PS1 token.
    if contains(text, b"BOOT2") {
        return Some(platform::PS2);
    }
    if contains(text, b"BOOT") {
        return Some(platform::PS1);
    }
    None
}

struct DirEntry {
    name: Vec<u8>,
    lba: u64,
    len: u32,
}

impl DirEntry {
    fn upper_name(&self) -> String {
        String::from_utf8_lossy(&self.name).to_ascii_uppercase()
    }
}

/// Parse the directory records in a directory's extent.
fn read_directory(source: &dyn DiscSectorSource, lba: u64, len: u32) -> Option<Vec<DirEntry>> {
    let sectors = len.div_ceil(SECTOR_BYTES as u32).max(1);
    let buffer = source.read_sectors(lba, sectors).ok()?;
    let mut entries = Vec::new();
    let mut pos = 0usize;
    while pos + 33 <= buffer.len() {
        let record_len = buffer[pos] as usize;
        if record_len == 0 {
            // No more records in this sector; advance to the next boundary.
            let next = (pos / SECTOR_BYTES + 1) * SECTOR_BYTES;
            if next <= pos || next >= buffer.len() {
                break;
            }
            pos = next;
            continue;
        }
        if pos + record_len > buffer.len() {
            break;
        }
        let name_len = buffer[pos + 32] as usize;
        let name_start = pos + 33;
        if name_start + name_len <= buffer.len() {
            entries.push(DirEntry {
                lba: read_le32(&buffer, pos + 2)? as u64,
                len: read_le32(&buffer, pos + 10)?,
                name: buffer[name_start..name_start + name_len].to_vec(),
            });
        }
        pos += record_len;
    }
    Some(entries)
}

fn read_le32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_be32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat in-memory disc image addressed in 2048-byte sectors.
    struct MemoryDisc {
        bytes: Vec<u8>,
    }

    impl MemoryDisc {
        fn with_sectors(count: usize) -> Self {
            Self {
                bytes: vec![0u8; count * SECTOR_BYTES],
            }
        }

        fn write(&mut self, lba: usize, offset: usize, data: &[u8]) {
            let start = lba * SECTOR_BYTES + offset;
            self.bytes[start..start + data.len()].copy_from_slice(data);
        }
    }

    impl DiscSectorSource for MemoryDisc {
        fn read_sectors(&self, lba: u64, count: u32) -> io::Result<Vec<u8>> {
            let start = lba as usize * SECTOR_BYTES;
            let end = (start + count as usize * SECTOR_BYTES).min(self.bytes.len());
            Ok(self.bytes.get(start..end).unwrap_or(&[]).to_vec())
        }
    }

    /// Build a minimal ISO 9660 directory record (only the fields the parser reads).
    fn dir_record(name: &[u8], lba: u32, len: u32) -> Vec<u8> {
        let mut record = vec![0u8; 33 + name.len()];
        if record.len() % 2 == 1 {
            record.push(0);
        }
        record[0] = record.len() as u8;
        record[2..6].copy_from_slice(&lba.to_le_bytes());
        record[10..14].copy_from_slice(&len.to_le_bytes());
        record[32] = name.len() as u8;
        record[33..33 + name.len()].copy_from_slice(name);
        record
    }

    /// Build a disc with an ISO 9660 PVD whose root directory holds `entries`.
    fn iso_with_root(entries: &[Vec<u8>]) -> MemoryDisc {
        let mut disc = MemoryDisc::with_sectors(32);
        let root_lba = 18u32;
        // PVD at sector 16.
        disc.write(PVD_LBA as usize, 0, &[1]);
        disc.write(PVD_LBA as usize, 1, b"CD001");
        // Root directory record at offset 156 points at `root_lba`.
        let root = dir_record(&[0x00], root_lba, SECTOR_BYTES as u32);
        disc.write(PVD_LBA as usize, 156, &root);
        // Concatenate the entries into the root directory extent.
        let mut offset = 0usize;
        for entry in entries {
            disc.write(root_lba as usize, offset, entry);
            offset += entry.len();
        }
        disc
    }

    #[test]
    fn detects_sega_consoles_from_sector0() {
        let mut saturn = MemoryDisc::with_sectors(1);
        saturn.write(0, 0, b"SEGA SEGASATURN ");
        assert_eq!(detect_disc_platform(&saturn), Some(platform::SATURN));

        let mut dreamcast = MemoryDisc::with_sectors(1);
        dreamcast.write(0, 0, b"SEGA SEGAKATANA ");
        assert_eq!(detect_disc_platform(&dreamcast), Some(platform::DREAMCAST));

        let mut segacd = MemoryDisc::with_sectors(1);
        segacd.write(0, 0, b"SEGADISCSYSTEM  ");
        assert_eq!(detect_disc_platform(&segacd), Some(platform::SEGA_CD));
    }

    #[test]
    fn detects_gamecube_and_wii_magic() {
        let mut gamecube = MemoryDisc::with_sectors(1);
        gamecube.write(0, 0x1C, &GAMECUBE_MAGIC.to_be_bytes());
        assert_eq!(detect_disc_platform(&gamecube), Some(platform::GAMECUBE));

        let mut wii = MemoryDisc::with_sectors(1);
        wii.write(0, 0x18, &WII_MAGIC.to_be_bytes());
        assert_eq!(detect_disc_platform(&wii), Some(platform::WII));
    }

    #[test]
    fn detects_psp_from_umd_data() {
        let disc = iso_with_root(&[
            dir_record(&[0x00], 18, SECTOR_BYTES as u32),
            dir_record(b"UMD_DATA.BIN;1", 20, 64),
        ]);
        assert_eq!(detect_disc_platform(&disc), Some(platform::PSP));
    }

    #[test]
    fn distinguishes_ps2_from_ps1_via_system_cnf() {
        let mut ps2 = iso_with_root(&[dir_record(b"SYSTEM.CNF;1", 20, 40)]);
        ps2.write(20, 0, b"BOOT2 = cdrom0:\\SLUS_200.01;1\r\n");
        assert_eq!(detect_disc_platform(&ps2), Some(platform::PS2));

        let mut ps1 = iso_with_root(&[dir_record(b"SYSTEM.CNF;1", 20, 40)]);
        ps1.write(20, 0, b"BOOT = cdrom:\\SCUS_941.63;1\r\n");
        assert_eq!(detect_disc_platform(&ps1), Some(platform::PS1));
    }

    #[test]
    fn returns_none_for_unknown_disc() {
        let blank = MemoryDisc::with_sectors(32);
        assert_eq!(detect_disc_platform(&blank), None);
    }

    #[test]
    fn maps_cartridge_headers_to_platforms() {
        assert_eq!(
            platform_for_rom_header(KnownRomHeader::Nes),
            Some(platform::NES)
        );
        assert_eq!(
            platform_for_rom_header(KnownRomHeader::Gba),
            Some(platform::GBA)
        );
        assert_eq!(
            platform_for_rom_header(KnownRomHeader::N64),
            Some(platform::N64)
        );
        assert_eq!(
            platform_for_rom_header(KnownRomHeader::SnesCopier),
            Some(platform::SNES)
        );
        assert_eq!(platform_for_rom_header(KnownRomHeader::Msx), None);
    }
}
