//! Platform + medium detection for ROM/disc inputs, derived purely from a
//! bounded in-memory prefix.
//!
//! This is intentionally *not* the identify feature: it never consults a
//! hash→name database and never names the exact title. It answers only "what
//! console is this, and what optical medium" from on-disc signatures
//! ([`crate::platform_detection`]) and cartridge header magics
//! ([`crate::rom_headers`]). Wrong guesses are impossible by construction —
//! every signature is specific, and an unknown input yields `None`.
//!
//! The caller reads at most [`DETECT_PREFIX_BYTES`] from the start of the file
//! (on the wasm main thread — see "Read-on-main" in `docs/ARCHITECTURE.md`) and
//! hands the slice to [`detect_rom_identity`]. Detection runs over that buffer
//! with no further I/O, so it adds no extra OPFS handles and cannot alter any
//! output bytes.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use tracing::{debug, trace};

use crate::platform_detection::{self, DiscSectorSource, detect_disc_platform, platform};
use crate::rom_headers::KnownRomHeader;

/// Largest prefix [`detect_rom_identity`] needs. The strongest disc signatures
/// (CD sync, Sega system area, GameCube/Wii magic) live in sector 0; the ISO
/// 9660 path reads the PVD at LBA 16 plus the root directory and `SYSTEM.CNF`,
/// which on real Sony discs sit within the first sectors of the data area. 2
/// MiB covers all of them at both 2048- and 2352-byte framing with wide margin.
pub const DETECT_PREFIX_BYTES: usize = 2 * 1024 * 1024;

/// 12-byte CD raw-sector sync pattern (`00 FF×10 00`) that marks 2352-byte
/// framing; its absence means the image is plain 2048-byte logical sectors.
const CD_SYNC: [u8; 12] = [
    0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00,
];
/// Raw CD sector size (sync + header + user data + EDC/ECC).
const RAW_SECTOR_BYTES: usize = 2352;
/// Logical (user-data) sector size.
const USER_SECTOR_BYTES: usize = 2048;
/// PS2 discs at or above this size are DVDs; smaller ones are CDs. PS2 CD-ROM
/// titles top out around 700 MiB (a single CD), DVD titles start well above it.
const PS2_DVD_THRESHOLD_BYTES: u64 = 800 * 1024 * 1024;

/// Optical medium of a disc image. Cartridge/card dumps have no medium.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscFormat {
    Cd,
    GdRom,
    Dvd,
}

impl DiscFormat {
    /// Short uppercase label for display (`CD`, `GD-ROM`, `DVD`).
    pub const fn label(self) -> &'static str {
        match self {
            DiscFormat::Cd => "CD",
            DiscFormat::GdRom => "GD-ROM",
            DiscFormat::Dvd => "DVD",
        }
    }
}

/// Detected console and (for disc images) optical medium. Either field may be
/// `None` when no signature matches.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RomIdentity {
    /// Canonical platform name (see [`platform_detection::platform`]), or `None`.
    pub platform: Option<&'static str>,
    /// Optical medium, or `None` for cartridges/cards and undetermined discs.
    pub disc_format: Option<DiscFormat>,
}

impl RomIdentity {
    /// True when nothing was detected.
    pub fn is_empty(&self) -> bool {
        self.platform.is_none() && self.disc_format.is_none()
    }

    /// Write the detected `platform` and `disc_format` (uppercase label) into a
    /// JSON object. The single source of truth for how identity is serialized so
    /// the probe, checksum, and extract surfaces all emit byte-identical keys.
    /// Absent fields are left out entirely (never written as `null`).
    pub fn write_into(&self, map: &mut serde_json::Map<String, serde_json::Value>) {
        if let Some(platform) = self.platform {
            map.insert("platform".to_string(), serde_json::Value::from(platform));
        }
        if let Some(disc_format) = self.disc_format {
            map.insert(
                "disc_format".to_string(),
                serde_json::Value::from(disc_format.label()),
            );
        }
    }
}

/// A [`DiscSectorSource`] backed by an in-memory prefix, de-framing 2352-byte
/// raw sectors down to their 2048-byte user data when needed.
struct PrefixDisc<'a> {
    bytes: &'a [u8],
    frame: usize,
    data_offset: usize,
}

impl DiscSectorSource for PrefixDisc<'_> {
    fn read_sectors(&self, lba: u64, count: u32) -> io::Result<Vec<u8>> {
        // `count` derives from an untrusted ISO9660 directory/extent length, so cap the
        // reservation at the prefix we can actually return (the loop below stops at its end)
        // instead of trusting `count` — a bogus length must not force a multi-GiB allocation.
        let capacity = (count as usize)
            .saturating_mul(USER_SECTOR_BYTES)
            .min(self.bytes.len());
        let mut out = Vec::with_capacity(capacity);
        for index in 0..count as u64 {
            let frame_start = (lba + index) as usize * self.frame + self.data_offset;
            if frame_start >= self.bytes.len() {
                break;
            }
            let end = (frame_start + USER_SECTOR_BYTES).min(self.bytes.len());
            out.extend_from_slice(&self.bytes[frame_start..end]);
        }
        Ok(out)
    }
}

/// Detect the platform and optical medium of `prefix` (the first bytes of the
/// input), where `total_len` is the full file length and `extension` is the
/// source file extension (with leading dot) when known.
///
/// Disc detection runs first because its signatures are specific and would
/// otherwise be masked by weak cartridge heuristics (e.g. a zeroed prefix or a
/// leading `"AB"`). Only when the input is clearly not a disc does cartridge
/// header detection run.
pub fn detect_rom_identity(prefix: &[u8], total_len: u64, extension: Option<&str>) -> RomIdentity {
    if let Some(identity) = detect_disc_identity(prefix, total_len) {
        trace!(
            platform = ?identity.platform,
            disc_format = ?identity.disc_format,
            "detected disc identity"
        );
        return identity;
    }
    if let Some(console) = detect_cartridge_platform(prefix, extension) {
        trace!(platform = console, "detected cartridge platform");
        return RomIdentity {
            platform: Some(console),
            disc_format: None,
        };
    }
    debug!(
        prefix_len = prefix.len(),
        total_len, "no rom identity detected"
    );
    RomIdentity::default()
}

/// A streaming sink that captures the first ≤[`DETECT_PREFIX_BYTES`] of a byte
/// stream for identity detection, independent of any checksum being computed over
/// the same bytes. Feed it alongside a [`crate::StreamingChecksum`] /
/// [`crate::StreamingVariantChecksums`] — each consumer is fed separately, none
/// embeds another — then call [`detect`](Self::detect) once the stream ends.
#[derive(Clone, Debug, Default)]
pub struct IdentityPrefix {
    buf: Vec<u8>,
    consumed: u64,
}

impl IdentityPrefix {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold the next ordered slice of the stream into the bounded prefix and running
    /// length. Cheap once the cap is reached (length-only).
    pub fn push(&mut self, bytes: &[u8]) {
        self.consumed = self.consumed.saturating_add(bytes.len() as u64);
        if self.buf.len() < DETECT_PREFIX_BYTES {
            let take = (DETECT_PREFIX_BYTES - self.buf.len()).min(bytes.len());
            self.buf.extend_from_slice(&bytes[..take]);
        }
    }

    /// Detect the platform + medium from the captured prefix. `extension` is the
    /// source/output file extension (with leading dot) when known.
    pub fn detect(&self, extension: Option<&str>) -> RomIdentity {
        detect_rom_identity(&self.buf, self.consumed, extension)
    }

    /// Like [`detect`](Self::detect) but uses a caller-supplied `total_len` instead of the bytes
    /// consumed so far. A streaming producer that already knows the final output size (e.g. a disc
    /// extract with a fixed decoded length) can fill the prefix early and still resolve
    /// size-dependent media correctly (e.g. PS2 CD vs DVD) without waiting for EOF.
    pub fn detect_with_total_len(&self, total_len: u64, extension: Option<&str>) -> RomIdentity {
        detect_rom_identity(&self.buf, total_len, extension)
    }

    /// Whether the bounded prefix has filled to [`DETECT_PREFIX_BYTES`] — i.e. enough bytes have
    /// streamed through to detect every disc/cartridge signature without waiting for EOF. Lets a
    /// streaming producer surface identity mid-extraction (once it is fully determinable) instead of
    /// only at the end.
    pub fn is_full(&self) -> bool {
        self.buf.len() >= DETECT_PREFIX_BYTES
    }
}

/// Read a bounded prefix from a decoded file on disk and detect its identity.
///
/// Intended for callers holding a path to *decoded* bytes (an extracted ISO/BIN
/// or a bare ROM) — not a compressed container, whose prefix is not disc data.
/// Reads on the calling thread (keep it the wasm main thread for OPFS inputs).
/// Any I/O error yields an empty identity rather than failing the operation.
pub fn detect_rom_identity_for_path(path: &Path) -> RomIdentity {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) => {
            trace!(path = %path.display(), %error, "rom identity: open failed");
            return RomIdentity::default();
        }
    };
    let total_len = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    let mut prefix = Vec::new();
    if let Err(error) = file
        .by_ref()
        .take(DETECT_PREFIX_BYTES as u64)
        .read_to_end(&mut prefix)
    {
        trace!(path = %path.display(), %error, "rom identity: read failed");
        return RomIdentity::default();
    }
    let extension = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()));
    detect_rom_identity(&prefix, total_len, extension.as_deref())
}

/// Returns a disc identity when the prefix looks like an optical disc image
/// (CD raw framing, an ISO 9660 PVD, or a recognised system-area signature).
fn detect_disc_identity(prefix: &[u8], total_len: u64) -> Option<RomIdentity> {
    let cd_raw = prefix.len() >= CD_SYNC.len() && prefix[..CD_SYNC.len()] == CD_SYNC;
    let (frame, data_offset) = if cd_raw {
        // Mode byte lives at raw offset 15; Mode 2 user data starts after an
        // 8-byte subheader (offset 24), Mode 1 directly after the header (16).
        let data_offset = if prefix.get(15) == Some(&0x02) {
            24
        } else {
            16
        };
        (RAW_SECTOR_BYTES, data_offset)
    } else {
        (USER_SECTOR_BYTES, 0)
    };
    let source = PrefixDisc {
        bytes: prefix,
        frame,
        data_offset,
    };
    let console = detect_disc_platform(&source);
    let is_disc = cd_raw || console.is_some() || has_iso9660_pvd(&source);
    if !is_disc {
        return None;
    }
    Some(RomIdentity {
        platform: console,
        disc_format: medium_for(console, cd_raw, total_len),
    })
}

/// True when the PVD at LBA 16 carries the ISO 9660 `CD001` standard identifier.
fn has_iso9660_pvd(source: &dyn DiscSectorSource) -> bool {
    matches!(
        source.read_sectors(16, 1),
        Ok(pvd) if pvd.len() >= 6 && &pvd[1..6] == b"CD001"
    )
}

/// Map a detected platform (and the framing/size fallbacks) to an optical medium.
fn medium_for(console: Option<&str>, cd_raw: bool, total_len: u64) -> Option<DiscFormat> {
    match console {
        Some(platform::DREAMCAST) => Some(DiscFormat::GdRom),
        Some(platform::GAMECUBE | platform::WII | platform::PSP) => Some(DiscFormat::Dvd),
        Some(platform::PS1 | platform::SATURN | platform::SEGA_CD | platform::PCE_CD) => {
            Some(DiscFormat::Cd)
        }
        Some(platform::PS2) => Some(if total_len >= PS2_DVD_THRESHOLD_BYTES {
            DiscFormat::Dvd
        } else {
            DiscFormat::Cd
        }),
        // 3DS/DS are card dumps detected via the disc path but have no medium.
        Some(platform::N3DS | platform::NDS) => None,
        // Unknown console: only the raw-sector framing tells us it is a CD.
        _ if cd_raw => Some(DiscFormat::Cd),
        _ => None,
    }
}

/// Detect a cartridge platform from a header magic. Extension-matching headers
/// are tried first so an ambiguous magic resolves to the format the file claims
/// to be; size-only copier headers (which match no magic) are never used here.
fn detect_cartridge_platform(prefix: &[u8], extension: Option<&str>) -> Option<&'static str> {
    let mut ordered: Vec<KnownRomHeader> = KnownRomHeader::ALL.to_vec();
    if let Some(extension) = extension {
        ordered.sort_by_key(|header| !header.matches_extension(extension));
    }
    for header in ordered {
        if header.signature_matches(prefix)
            && let Some(console) = platform_detection::platform_for_rom_header(header)
        {
            return Some(console);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PVD_LBA: usize = 16;

    /// Build a 2048-framed image of `sector_count` blank logical sectors.
    fn logical_image(sector_count: usize) -> Vec<u8> {
        vec![0u8; sector_count * USER_SECTOR_BYTES]
    }

    fn write(buffer: &mut [u8], offset: usize, data: &[u8]) {
        buffer[offset..offset + data.len()].copy_from_slice(data);
    }

    #[test]
    fn detects_dreamcast_gdrom_from_raw_sector() {
        // A 2352 raw sector with CD sync; Dreamcast header in the user data.
        let mut image = vec![0u8; RAW_SECTOR_BYTES * 8];
        write(&mut image, 0, &CD_SYNC);
        image[15] = 0x01; // Mode 1 → user data at offset 16.
        write(&mut image, 16, b"SEGA SEGAKATANA ");
        let identity = detect_rom_identity(&image, image.len() as u64, Some(".bin"));
        assert_eq!(identity.platform, Some(platform::DREAMCAST));
        assert_eq!(identity.disc_format, Some(DiscFormat::GdRom));
    }

    #[test]
    fn detects_gamecube_dvd_from_logical_image() {
        let mut image = logical_image(4);
        write(&mut image, 0x1C, &0xC233_9F3Du32.to_be_bytes());
        let identity = detect_rom_identity(&image, image.len() as u64, Some(".iso"));
        assert_eq!(identity.platform, Some(platform::GAMECUBE));
        assert_eq!(identity.disc_format, Some(DiscFormat::Dvd));
    }

    /// Minimal ISO 9660 logical image with a SYSTEM.CNF naming BOOT2 — detected as PS2, whose
    /// optical medium then depends on the total length (CD below the DVD threshold, DVD above).
    fn ps2_iso_image() -> Vec<u8> {
        let mut image = logical_image(32);
        write(&mut image, PVD_LBA * USER_SECTOR_BYTES, &[1]);
        write(&mut image, PVD_LBA * USER_SECTOR_BYTES + 1, b"CD001");
        // Root directory record at PVD offset 156 → LBA 18.
        let root_lba = 18u32;
        let mut root = vec![0u8; 34];
        root[0] = root.len() as u8;
        root[2..6].copy_from_slice(&root_lba.to_le_bytes());
        root[10..14].copy_from_slice(&(USER_SECTOR_BYTES as u32).to_le_bytes());
        root[32] = 1;
        write(&mut image, PVD_LBA * USER_SECTOR_BYTES + 156, &root);
        // SYSTEM.CNF entry in the root directory extent, pointing at LBA 20.
        let name = b"SYSTEM.CNF;1";
        let mut entry = vec![0u8; 33 + name.len()];
        entry[0] = entry.len() as u8;
        entry[2..6].copy_from_slice(&20u32.to_le_bytes());
        entry[10..14].copy_from_slice(&40u32.to_le_bytes());
        entry[32] = name.len() as u8;
        entry[33..].copy_from_slice(name);
        write(&mut image, root_lba as usize * USER_SECTOR_BYTES, &entry);
        write(
            &mut image,
            20 * USER_SECTOR_BYTES,
            b"BOOT2 = cdrom0:\\SLUS_200.01;1\r\n",
        );
        image
    }

    #[test]
    fn classifies_ps2_medium_by_size() {
        let image = ps2_iso_image();

        let small = detect_rom_identity(&image, 600 * 1024 * 1024, Some(".iso"));
        assert_eq!(small.platform, Some(platform::PS2));
        assert_eq!(small.disc_format, Some(DiscFormat::Cd));

        let large = detect_rom_identity(&image, 2 * 1024 * 1024 * 1024, Some(".iso"));
        assert_eq!(large.disc_format, Some(DiscFormat::Dvd));
    }

    #[test]
    fn prefix_detect_with_total_len_overrides_consumed_length() {
        // A streaming producer fills the prefix from only the head of the stream, so the prefix's
        // own consumed length is far below the DVD threshold; `detect` would call it a CD. Passing
        // the known final length resolves the PS2 medium correctly mid-extraction.
        let image = ps2_iso_image();
        let mut prefix = IdentityPrefix::new();
        prefix.push(&image);
        assert!((image.len() as u64) < PS2_DVD_THRESHOLD_BYTES);

        let consumed = prefix.detect(Some(".iso"));
        assert_eq!(consumed.platform, Some(platform::PS2));
        assert_eq!(consumed.disc_format, Some(DiscFormat::Cd));

        let with_total = prefix.detect_with_total_len(2 * 1024 * 1024 * 1024, Some(".iso"));
        assert_eq!(with_total.platform, Some(platform::PS2));
        assert_eq!(with_total.disc_format, Some(DiscFormat::Dvd));
    }

    #[test]
    fn detects_cartridge_platform_without_medium() {
        let mut rom = vec![0u8; 0x8000];
        write(&mut rom, 0, b"NES\x1A");
        let identity = detect_rom_identity(&rom, rom.len() as u64, Some(".nes"));
        assert_eq!(identity.platform, Some(platform::NES));
        assert_eq!(identity.disc_format, None);
    }

    #[test]
    fn unknown_input_yields_nothing() {
        let noise = vec![0x42u8; 0x8000];
        let identity = detect_rom_identity(&noise, noise.len() as u64, Some(".bin"));
        assert!(identity.is_empty());
    }

    #[test]
    fn unknown_raw_cd_is_at_least_cd() {
        let mut image = vec![0x11u8; RAW_SECTOR_BYTES * 4];
        write(&mut image, 0, &CD_SYNC);
        let identity = detect_rom_identity(&image, image.len() as u64, Some(".bin"));
        assert_eq!(identity.platform, None);
        assert_eq!(identity.disc_format, Some(DiscFormat::Cd));
    }

    #[test]
    fn read_sectors_bounds_output_to_prefix_for_untrusted_count() {
        // A crafted ISO 9660 extent length must never force a huge reservation: read_sectors
        // caps the allocation at the prefix it actually holds and its loop stops at the prefix
        // end (the d33c890d clamp). Without the clamp this call reserves ~8 TB and aborts.
        let prefix = vec![0x5Au8; 4 * USER_SECTOR_BYTES];
        let disc = PrefixDisc {
            bytes: &prefix,
            frame: USER_SECTOR_BYTES,
            data_offset: 0,
        };
        let out = disc.read_sectors(0, u32::MAX).expect("bounded read");
        assert_eq!(out.len(), prefix.len());
    }

    #[test]
    fn write_into_emits_present_fields_only() {
        let mut full = serde_json::Map::new();
        RomIdentity {
            platform: Some(platform::GAMECUBE),
            disc_format: Some(DiscFormat::Dvd),
        }
        .write_into(&mut full);
        assert_eq!(full["platform"], serde_json::json!("Nintendo GameCube"));
        assert_eq!(full["disc_format"], serde_json::json!("DVD"));

        let mut cartridge = serde_json::Map::new();
        RomIdentity {
            platform: Some(platform::NES),
            disc_format: None,
        }
        .write_into(&mut cartridge);
        assert_eq!(
            cartridge["platform"],
            serde_json::json!("Nintendo Entertainment System")
        );
        assert!(!cartridge.contains_key("disc_format"));

        let mut empty = serde_json::Map::new();
        RomIdentity::default().write_into(&mut empty);
        assert!(empty.is_empty());
    }
}
