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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveContainerKind {
    /// GameShark SP / SharkPort export (`.sps`, `.xps`): length-prefixed
    /// strings, a 0x1c game-info block, the raw save, and a trailing checksum.
    SharkPortSave,
    /// GameShark SP snapshot (`.gsv`): a fixed 0x430 header and 128 KiB of
    /// raw flash data. It carries no checksum.
    GameSharkSpSnapshot,
}

impl SaveContainerKind {
    pub fn display_name(self) -> &'static str {
        match self {
            Self::SharkPortSave => "GameShark SP save (SharkPortSave)",
            Self::GameSharkSpSnapshot => "GameShark SP snapshot",
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
    let container = parse_shark_port(bytes).or_else(|| parse_gsv(bytes))?;
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
