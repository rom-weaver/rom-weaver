//! Minimal ISO9660 (ECMA-119) primary-descriptor parsing.
//!
//! Enough of the standard to enumerate the files of a GD-ROM data track and
//! locate each file's extent: the Primary Volume Descriptor and the directory
//! record tree it roots. This is deliberately read-only and parses only the
//! Primary descriptor (8.3 uppercase names) - that is the name set a `.dcp`
//! addresses its per-file deltas by. Joliet supplementary descriptors and the
//! path tables are intentionally not consulted here.
//!
//! All multi-byte numeric fields in ISO9660 are stored "both-endian" (a
//! little-endian copy immediately followed by a big-endian copy); we read the
//! little-endian copy. Recorded extent locations (LBAs) are *absolute* on a
//! GD-ROM - biased by the data track's start LBA - and are returned here
//! verbatim; converting them to track-relative sectors is the caller's job.

use rom_weaver_core::{Result, RomWeaverError};

use super::sector::LOGICAL_SECTOR_SIZE;

/// The location (sector 16) of the first volume descriptor, counted in logical
/// sectors from the start of the volume.
pub const FIRST_VOLUME_DESCRIPTOR_SECTOR: u64 = 16;

const VOLUME_DESCRIPTOR_PRIMARY: u8 = 1;
const STANDARD_IDENTIFIER: &[u8; 5] = b"CD001";
const FILE_FLAG_DIRECTORY: u8 = 0x02;

/// One parsed directory record (a single file or subdirectory entry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryRecord {
    /// Absolute extent location (LBA) as recorded on the disc.
    pub extent_lba: u32,
    /// Length of the file/directory data in bytes.
    pub data_len: u32,
    /// Whether this record describes a subdirectory.
    pub is_dir: bool,
    /// The decoded identifier with any `;version` suffix stripped. Empty for
    /// the `.` (current) and `..` (parent) self-records.
    pub name: String,
}

impl DirectoryRecord {
    /// True for the `.` / `..` self/parent records, which carry a single-byte
    /// identifier of `0x00` / `0x01` and an empty decoded `name`.
    pub fn is_self_or_parent(&self) -> bool {
        self.name.is_empty()
    }
}

/// Read a little-endian `u32` from `buf` at `offset`, erroring if out of range.
fn read_u32_le(buf: &[u8], offset: usize) -> Result<u32> {
    buf.get(offset..offset + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "ISO9660: truncated 32-bit field at offset {offset}"
            ))
        })
}

/// Parse the single directory record beginning at `buf[0]`, returning the
/// record and the number of bytes it occupied. Returns `Ok(None)` when the
/// length byte is zero, which signals padding to the end of the current logical
/// sector.
pub fn parse_directory_record(buf: &[u8]) -> Result<Option<(DirectoryRecord, usize)>> {
    let Some(&record_len) = buf.first() else {
        return Ok(None);
    };
    if record_len == 0 {
        return Ok(None);
    }
    let record_len = usize::from(record_len);
    let record = buf.get(..record_len).ok_or_else(|| {
        RomWeaverError::Validation(format!(
            "ISO9660: directory record claims {record_len} bytes but only {} remain",
            buf.len()
        ))
    })?;
    let extent_lba = read_u32_le(record, 2)?;
    let data_len = read_u32_le(record, 10)?;
    let flags = *record.get(25).ok_or_else(|| {
        RomWeaverError::Validation("ISO9660: directory record missing flags byte".to_string())
    })?;
    let name_len = usize::from(*record.get(32).ok_or_else(|| {
        RomWeaverError::Validation("ISO9660: directory record missing name length".to_string())
    })?);
    let raw_name = record.get(33..33 + name_len).ok_or_else(|| {
        RomWeaverError::Validation("ISO9660: directory record name runs past record".to_string())
    })?;
    let name = decode_identifier(raw_name);
    Ok(Some((
        DirectoryRecord {
            extent_lba,
            data_len,
            is_dir: flags & FILE_FLAG_DIRECTORY != 0,
            name,
        },
        record_len,
    )))
}

/// Decode a directory-record identifier: the `.`/`..` self-records (`0x00` /
/// `0x01`) become an empty string; file identifiers have any `;version` suffix
/// removed and are decoded as ASCII.
fn decode_identifier(raw: &[u8]) -> String {
    if raw == [0x00] || raw == [0x01] {
        return String::new();
    }
    let end = raw.iter().position(|&b| b == b';').unwrap_or(raw.len());
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

/// Parse every directory record in a directory extent's bytes, skipping the
/// `.`/`..` self-records. `buf` should be the directory's full data
/// (`data_len` bytes), which spans whole logical sectors; a zero length byte
/// advances to the next sector boundary.
pub fn parse_directory(buf: &[u8]) -> Result<Vec<DirectoryRecord>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < buf.len() {
        match parse_directory_record(&buf[pos..])? {
            Some((record, len)) => {
                pos += len;
                if !record.is_self_or_parent() {
                    out.push(record);
                }
            }
            None => {
                // Zero length byte: records never straddle a logical sector, so
                // skip the remaining padding of the current sector.
                let next = pos.div_ceil(LOGICAL_SECTOR_SIZE) * LOGICAL_SECTOR_SIZE;
                pos = if next > pos {
                    next
                } else {
                    pos + LOGICAL_SECTOR_SIZE
                };
            }
        }
    }
    Ok(out)
}

/// The fields of the Primary Volume Descriptor this reader needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrimaryVolumeDescriptor {
    /// Logical block size in bytes (expected to be 2048).
    pub logical_block_size: u16,
    /// Total number of logical blocks in the volume.
    pub volume_space_size: u32,
    /// The root directory record.
    pub root: DirectoryRecord,
}

/// Parse the Primary Volume Descriptor from the 2048-byte logical sector at
/// volume sector 16.
pub fn parse_primary_volume_descriptor(sector: &[u8]) -> Result<PrimaryVolumeDescriptor> {
    if sector.len() < LOGICAL_SECTOR_SIZE {
        return Err(RomWeaverError::Validation(format!(
            "ISO9660: volume descriptor sector is {} bytes, expected {LOGICAL_SECTOR_SIZE}",
            sector.len()
        )));
    }
    if sector[0] != VOLUME_DESCRIPTOR_PRIMARY || &sector[1..6] != STANDARD_IDENTIFIER {
        return Err(RomWeaverError::Validation(format!(
            "ISO9660: no Primary Volume Descriptor at sector 16 (type={:#04x}, id={:?})",
            sector[0],
            &sector[1..6]
        )));
    }
    let logical_block_size = u16::from_le_bytes([sector[128], sector[129]]);
    let volume_space_size = read_u32_le(sector, 80)?;
    let (root, _) = parse_directory_record(&sector[156..156 + 34])?.ok_or_else(|| {
        RomWeaverError::Validation("ISO9660: PVD root directory record is empty".to_string())
    })?;
    Ok(PrimaryVolumeDescriptor {
        logical_block_size,
        volume_space_size,
        root,
    })
}
