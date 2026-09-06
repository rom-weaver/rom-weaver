use std::ops::Range;

use tracing::{debug, trace};

use crate::{Result, RomWeaverError, ValidationCodeError};

// SharkPortSave (.sps) and GameShark SP snapshot (.gsv) layouts follow VBA-M's
// CPUReadGSASnapshot / CPUWriteGSASnapshot / CPUReadGSASPSnapshot:
// https://github.com/visualboyadvance-m/visualboyadvance-m/blob/master/src/core/gba/gba.cpp
const SHARK_PORT_MAGIC: &[u8] = b"SharkPortSave";
const SHARK_PORT_INFO_SIZE: usize = 0x1c;
const GSV_HEADER_SIZE: usize = 0x430;
const GSV_FOOTER_OFFSET: usize = 0x42c;
const GSV_FOOTER: &[u8] = b"xV4\x12";
const GSV_SAVE_SIZE: usize = 128 * 1024;

// DeSmuME appends a footer after the padded raw save: an 0x52-byte notice, six
// little-endian u32 fields (actual size, padded size, type, address size,
// memory size, version), and a 16-byte cookie. See BackupDevice::flush in
// https://github.com/TASEmulators/desmume/blob/master/desmume/src/mc.cpp
const DESMUME_NOTICE: &[u8] =
    b"|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:";
const DESMUME_COOKIE: &[u8] = b"|-DESMUME SAVE-|";
const DESMUME_FOOTER_SIZE: usize = DESMUME_NOTICE.len() + 6 * 4 + DESMUME_COOKIE.len();

// DexDrive (.gme) and Connectix VGS (.mem/.vgs) PlayStation memory card images
// put a fixed header before the raw 128 KiB card. Sizes follow the memory card
// tooling in https://github.com/ShendoXT/memcardrex (MemoryCard.cs).
const DEXDRIVE_MAGIC: &[u8] = b"123-456-STD";
const DEXDRIVE_HEADER_SIZE: usize = 0xF40;
const VGS_MAGIC: &[u8] = b"VgsM";
const VGS_HEADER_SIZE: usize = 0x40;
const MEMORY_CARD_SIZE: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveContainerKind {
    /// GameShark SP / SharkPort export (`.sps`, `.xps`): length-prefixed
    /// strings, a 0x1c game-info block, the raw save, and a trailing checksum.
    SharkPortSave,
    /// GameShark SP snapshot (`.gsv`): a fixed 0x430 header and 128 KiB of
    /// raw flash data. It carries no checksum.
    GameSharkSpSnapshot,
    /// DeSmuME `.dsv`: the raw save followed by a 122-byte footer.
    DesmumeFooter,
    /// DexDrive `.gme`: a 0xF40 header before a raw PlayStation memory card.
    DexDrive,
    /// Connectix Virtual Game Station `.mem`/`.vgs`: a 64-byte header before
    /// a raw PlayStation memory card.
    VirtualGameStation,
}

impl SaveContainerKind {
    pub fn id(self) -> &'static str {
        match self {
            Self::SharkPortSave => "shark_port_save",
            Self::GameSharkSpSnapshot => "gameshark_sp_snapshot",
            Self::DesmumeFooter => "desmume_dsv",
            Self::DexDrive => "dexdrive_gme",
            Self::VirtualGameStation => "vgs_mem",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::SharkPortSave => "GameShark SP save (SharkPortSave)",
            Self::GameSharkSpSnapshot => "GameShark SP snapshot",
            Self::DesmumeFooter => "DeSmuME save (.dsv)",
            Self::DexDrive => "DexDrive memory card (.gme)",
            Self::VirtualGameStation => "Virtual Game Station memory card (.mem)",
        }
    }
}

/// A recognized wrapper around a raw save. `wrap` splices edited raw bytes
/// back into a copy of the original file, so every header byte the editor
/// does not understand survives a round trip unchanged.
#[derive(Clone, Debug)]
pub struct SaveContainer {
    kind: SaveContainerKind,
    outer: Vec<u8>,
    inner: Range<usize>,
    /// SharkPortSave only: the checksum covers this payload range (game info
    /// plus save data) and is stored as a little-endian u32 at this offset.
    checksum: Option<(Range<usize>, usize)>,
    warnings: Vec<String>,
}

impl SaveContainer {
    pub fn kind(&self) -> SaveContainerKind {
        self.kind
    }

    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    pub fn inner_bytes(&self) -> Vec<u8> {
        self.outer[self.inner.clone()].to_vec()
    }

    pub fn wrap(&self, inner: &[u8]) -> Result<Vec<u8>> {
        if inner.len() != self.inner.len() {
            return Err(RomWeaverError::ValidationCode(
                ValidationCodeError::new("save_container_size_changed")
                    .with_message("the edited save no longer fits its container")
                    .with_field("expected_size", self.inner.len())
                    .with_field("actual_size", inner.len()),
            ));
        }
        let mut outer = self.outer.clone();
        outer[self.inner.clone()].copy_from_slice(inner);
        if let Some((payload, offset)) = &self.checksum {
            let crc = shark_port_checksum(&outer[payload.clone()]);
            outer[*offset..*offset + 4].copy_from_slice(&crc.to_le_bytes());
            trace!(crc, "recomputed SharkPortSave checksum");
        }
        Ok(outer)
    }
}

/// Detect a save wrapper. Returns the container and the raw save bytes, or
/// `None` when the file has no recognized wrapper (including a wrapper whose
/// structure is malformed - the caller then treats the file as a raw save).
pub fn unwrap_save_container(bytes: &[u8]) -> Option<(SaveContainer, Vec<u8>)> {
    let container = parse_shark_port(bytes)
        .or_else(|| parse_gsv(bytes))
        .or_else(|| parse_desmume(bytes))
        .or_else(|| parse_dexdrive(bytes))
        .or_else(|| parse_vgs(bytes))?;
    let inner = container.inner_bytes();
    debug!(
        kind = container.kind.display_name(),
        outer_size = bytes.len(),
        save_size = inner.len(),
        "unwrapped a save container"
    );
    Some((container, inner))
}

fn parse_shark_port(bytes: &[u8]) -> Option<SaveContainer> {
    let mut cursor = 0usize;
    let magic_len = read_u32(bytes, &mut cursor)? as usize;
    if magic_len != SHARK_PORT_MAGIC.len() {
        return None;
    }
    if bytes.get(cursor..cursor + magic_len)? != SHARK_PORT_MAGIC {
        return None;
    }
    cursor += magic_len;
    // The version field, then the title, date, and notes strings. VBA-M
    // ignores all four on import; the splice-on-write keeps them verbatim.
    let _version = read_u32(bytes, &mut cursor)?;
    for _ in 0..3 {
        let len = read_u32(bytes, &mut cursor)? as usize;
        bytes.get(cursor..cursor.checked_add(len)?)?;
        cursor += len;
    }
    let payload_len = read_u32(bytes, &mut cursor)? as usize;
    if payload_len <= SHARK_PORT_INFO_SIZE {
        trace!(payload_len, "SharkPortSave payload has no save data");
        return None;
    }
    let payload = cursor..cursor.checked_add(payload_len)?;
    bytes.get(payload.clone())?;
    let inner = cursor + SHARK_PORT_INFO_SIZE..payload.end;
    let mut crc_cursor = payload.end;
    let stored_crc = read_u32(bytes, &mut crc_cursor)?;
    let mut warnings = Vec::new();
    let computed_crc = shark_port_checksum(&bytes[payload.clone()]);
    if stored_crc != computed_crc {
        warnings.push(format!(
            "the GameShark SP save checksum does not match its data \
             (stored 0x{stored_crc:08x}, computed 0x{computed_crc:08x}); \
             emulators ignore it"
        ));
    }
    Some(SaveContainer {
        kind: SaveContainerKind::SharkPortSave,
        outer: bytes.to_vec(),
        inner,
        checksum: Some((payload, crc_cursor - 4)),
        warnings,
    })
}

fn parse_gsv(bytes: &[u8]) -> Option<SaveContainer> {
    if bytes.len() != GSV_HEADER_SIZE + GSV_SAVE_SIZE {
        return None;
    }
    if bytes.get(GSV_FOOTER_OFFSET..GSV_FOOTER_OFFSET + GSV_FOOTER.len())? != GSV_FOOTER {
        return None;
    }
    Some(SaveContainer {
        kind: SaveContainerKind::GameSharkSpSnapshot,
        outer: bytes.to_vec(),
        inner: GSV_HEADER_SIZE..bytes.len(),
        checksum: None,
        warnings: Vec::new(),
    })
}

/// The raw save is everything before the footer, at DeSmuME's padded size.
/// The footer's own size fields stay untouched because `wrap` never changes
/// the inner length.
fn parse_desmume(bytes: &[u8]) -> Option<SaveContainer> {
    let footer_start = bytes.len().checked_sub(DESMUME_FOOTER_SIZE)?;
    if footer_start == 0 {
        return None;
    }
    if !bytes.ends_with(DESMUME_COOKIE) || !bytes[footer_start..].starts_with(DESMUME_NOTICE) {
        return None;
    }
    let mut cursor = footer_start + DESMUME_NOTICE.len();
    let actual_size = read_u32(bytes, &mut cursor)? as usize;
    let padded_size = read_u32(bytes, &mut cursor)? as usize;
    let mut warnings = Vec::new();
    if padded_size != footer_start {
        warnings.push(format!(
            "the DeSmuME footer records a {padded_size}-byte save but the file holds \
             {footer_start} bytes before the footer"
        ));
    }
    trace!(actual_size, padded_size, "parsed DeSmuME .dsv footer");
    Some(SaveContainer {
        kind: SaveContainerKind::DesmumeFooter,
        outer: bytes.to_vec(),
        inner: 0..footer_start,
        checksum: None,
        warnings,
    })
}

fn parse_dexdrive(bytes: &[u8]) -> Option<SaveContainer> {
    parse_fixed_header(
        bytes,
        DEXDRIVE_MAGIC,
        DEXDRIVE_HEADER_SIZE,
        SaveContainerKind::DexDrive,
    )
}

fn parse_vgs(bytes: &[u8]) -> Option<SaveContainer> {
    parse_fixed_header(
        bytes,
        VGS_MAGIC,
        VGS_HEADER_SIZE,
        SaveContainerKind::VirtualGameStation,
    )
}

fn parse_fixed_header(
    bytes: &[u8],
    magic: &[u8],
    header_size: usize,
    kind: SaveContainerKind,
) -> Option<SaveContainer> {
    if bytes.len() != header_size + MEMORY_CARD_SIZE || !bytes.starts_with(magic) {
        return None;
    }
    Some(SaveContainer {
        kind,
        outer: bytes.to_vec(),
        inner: header_size..bytes.len(),
        checksum: None,
        warnings: Vec::new(),
    })
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> Option<u32> {
    let slice = bytes.get(*cursor..*cursor + 4)?;
    *cursor += 4;
    Some(u32::from_le_bytes(slice.try_into().ok()?))
}

/// VBA-M sums `temp[i] << (crc % 24)` over a signed `char` buffer, so bytes
/// >= 0x80 MUST sign-extend before the shift to stay byte-identical.
pub fn shark_port_checksum(payload: &[u8]) -> u32 {
    let mut crc: u32 = 0;
    for &byte in payload {
        let value = byte as i8 as i32 as u32;
        crc = crc.wrapping_add(value.wrapping_shl(crc % 0x18));
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desmume_fixture(save: &[u8]) -> Vec<u8> {
        let mut bytes = save.to_vec();
        bytes.extend_from_slice(DESMUME_NOTICE);
        for value in [save.len() as u32, save.len() as u32, 3, 2, 18, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(DESMUME_COOKIE);
        bytes
    }

    #[test]
    fn desmume_footer_is_122_bytes_and_unwraps_to_the_padded_save() {
        assert_eq!(DESMUME_FOOTER_SIZE, 122);
        let save = vec![0x5Au8; 512 * 1024];
        let wrapped = desmume_fixture(&save);
        let (container, inner) = unwrap_save_container(&wrapped).expect("dsv");
        assert_eq!(container.kind(), SaveContainerKind::DesmumeFooter);
        assert_eq!(inner, save);
        assert!(container.warnings().is_empty());
        let mut edited = inner.clone();
        edited[0] = 0x01;
        let output = container.wrap(&edited).unwrap();
        assert_eq!(output[0], 0x01);
        assert_eq!(output[1..], wrapped[1..]);
    }

    #[test]
    fn desmume_footer_with_a_wrong_padded_size_warns() {
        let mut wrapped = desmume_fixture(&[0u8; 8192]);
        let offset = 8192 + DESMUME_NOTICE.len() + 4;
        wrapped[offset..offset + 4].copy_from_slice(&4096u32.to_le_bytes());
        let (container, _) = unwrap_save_container(&wrapped).expect("dsv");
        assert!(container.warnings()[0].contains("4096-byte save"));
    }

    #[test]
    fn a_bare_footer_or_a_bad_cookie_is_not_a_container() {
        let bare = desmume_fixture(&[]);
        assert!(unwrap_save_container(&bare).is_none());
        let mut wrapped = desmume_fixture(&[0u8; 512]);
        let end = wrapped.len();
        wrapped[end - 1] = b'?';
        assert!(unwrap_save_container(&wrapped).is_none());
    }

    #[test]
    fn dexdrive_and_vgs_headers_unwrap_to_a_raw_memory_card() {
        for (magic, header, kind) in [
            (
                DEXDRIVE_MAGIC,
                DEXDRIVE_HEADER_SIZE,
                SaveContainerKind::DexDrive,
            ),
            (
                VGS_MAGIC,
                VGS_HEADER_SIZE,
                SaveContainerKind::VirtualGameStation,
            ),
        ] {
            let mut wrapped = vec![0u8; header];
            wrapped[..magic.len()].copy_from_slice(magic);
            let mut card = vec![0u8; MEMORY_CARD_SIZE];
            card[..2].copy_from_slice(b"MC");
            wrapped.extend_from_slice(&card);
            let (container, inner) = unwrap_save_container(&wrapped).expect("card wrapper");
            assert_eq!(container.kind(), kind);
            assert_eq!(inner, card);
            assert_eq!(container.wrap(&inner).unwrap(), wrapped);

            wrapped.push(0);
            assert!(unwrap_save_container(&wrapped).is_none());
        }
    }

    #[test]
    fn wrap_rejects_a_resized_save() {
        let wrapped = desmume_fixture(&[0u8; 512]);
        let (container, _) = unwrap_save_container(&wrapped).expect("dsv");
        assert!(container.wrap(&[0u8; 256]).is_err());
    }
}
