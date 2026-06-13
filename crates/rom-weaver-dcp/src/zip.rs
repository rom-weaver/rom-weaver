//! Minimal ZIP central-directory reader.
//!
//! A `.dcp` (Universal Dreamcast Patcher patch) is a plain ZIP archive. To
//! describe its contents we only need each entry's name and sizes, which live
//! in the central directory — no decompression and therefore no DEFLATE
//! dependency. This reader scans the End Of Central Directory record and parses
//! the central-directory file headers; entry payload extraction is a separate
//! concern handled by the apply pipeline.
//!
//! Scope: standard (non-ZIP64) archives. ZIP64 is detected and reported rather
//! than mis-parsed.

use std::io::{Read, Seek, SeekFrom};

use rom_weaver_core::{Result, RomWeaverError};

const EOCD_SIGNATURE: u32 = 0x0605_4b50;
const CENTRAL_FILE_HEADER_SIGNATURE: u32 = 0x0201_4b50;
const EOCD_MIN_SIZE: usize = 22;
/// Maximum bytes to scan back from EOF for the EOCD signature: 22-byte record
/// plus up to a 64 KiB trailing comment.
const EOCD_SEARCH_LIMIT: usize = EOCD_MIN_SIZE + u16::MAX as usize;
/// Sentinel value a 32-bit ZIP field carries when the real value lives in a
/// ZIP64 record.
const ZIP64_SENTINEL: u32 = 0xFFFF_FFFF;

/// One central-directory entry: its name and stored/uncompressed sizes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    /// Entry name exactly as stored (forward-slash separated path).
    pub name: String,
    /// Compressed size in bytes.
    pub compressed_size: u32,
    /// Uncompressed size in bytes.
    pub uncompressed_size: u32,
    /// Compression method (0 = stored, 8 = deflate).
    pub method: u16,
    /// Offset of the entry's local file header from the start of the archive.
    pub local_header_offset: u32,
}

impl ZipEntry {
    /// Whether the entry is a directory marker (zero-length name suffix `/`).
    pub fn is_directory(&self) -> bool {
        self.name.ends_with('/')
    }
}

fn read_u16(buf: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([buf[at], buf[at + 1]])
}

fn read_u32(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]])
}

/// Read and parse every central-directory entry from a ZIP archive.
pub fn read_central_directory<R: Read + Seek>(reader: &mut R) -> Result<Vec<ZipEntry>> {
    let file_len = reader.seek(SeekFrom::End(0))?;
    let (cd_offset, cd_size, entry_count) = locate_central_directory(reader, file_len)?;

    reader.seek(SeekFrom::Start(cd_offset))?;
    let mut cd = vec![0u8; cd_size];
    reader.read_exact(&mut cd)?;

    let mut entries = Vec::with_capacity(entry_count);
    let mut pos = 0usize;
    for _ in 0..entry_count {
        if pos + 46 > cd.len() || read_u32(&cd, pos) != CENTRAL_FILE_HEADER_SIGNATURE {
            return Err(RomWeaverError::Validation(
                "ZIP: malformed central directory file header".to_string(),
            ));
        }
        let method = read_u16(&cd, pos + 10);
        let compressed_size = read_u32(&cd, pos + 20);
        let uncompressed_size = read_u32(&cd, pos + 24);
        let name_len = read_u16(&cd, pos + 28) as usize;
        let extra_len = read_u16(&cd, pos + 30) as usize;
        let comment_len = read_u16(&cd, pos + 32) as usize;
        let local_header_offset = read_u32(&cd, pos + 42);
        if compressed_size == ZIP64_SENTINEL
            || uncompressed_size == ZIP64_SENTINEL
            || local_header_offset == ZIP64_SENTINEL
        {
            return Err(RomWeaverError::Validation(
                "ZIP: ZIP64 archives are not yet supported".to_string(),
            ));
        }
        let name_start = pos + 46;
        let name_bytes = cd.get(name_start..name_start + name_len).ok_or_else(|| {
            RomWeaverError::Validation("ZIP: central directory entry name truncated".to_string())
        })?;
        let name = String::from_utf8_lossy(name_bytes).into_owned();
        entries.push(ZipEntry {
            name,
            compressed_size,
            uncompressed_size,
            method,
            local_header_offset,
        });
        pos = name_start + name_len + extra_len + comment_len;
    }
    tracing::debug!(entries = entries.len(), "parsed ZIP central directory");
    Ok(entries)
}

const LOCAL_FILE_HEADER_SIGNATURE: u32 = 0x0403_4b50;
const METHOD_STORED: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

/// Extract and decompress one entry's full contents.
///
/// Seeks to the entry's local file header (re-reading the local name/extra
/// lengths, which may differ from the central directory), reads the stored
/// bytes, and inflates them when DEFLATE-compressed. Only the STORED (0) and
/// DEFLATE (8) methods — the only ones a `.dcp` uses — are supported.
pub fn extract_entry<R: Read + Seek>(reader: &mut R, entry: &ZipEntry) -> Result<Vec<u8>> {
    reader.seek(SeekFrom::Start(u64::from(entry.local_header_offset)))?;
    let mut header = [0u8; 30];
    reader.read_exact(&mut header)?;
    if read_u32(&header, 0) != LOCAL_FILE_HEADER_SIGNATURE {
        return Err(RomWeaverError::Validation(format!(
            "ZIP: entry `{}` has no local file header signature",
            entry.name
        )));
    }
    let name_len = read_u16(&header, 26) as i64;
    let extra_len = read_u16(&header, 28) as i64;
    reader.seek(SeekFrom::Current(name_len + extra_len))?;

    let mut compressed = vec![0u8; entry.compressed_size as usize];
    reader.read_exact(&mut compressed)?;

    match entry.method {
        METHOD_STORED => Ok(compressed),
        METHOD_DEFLATE => miniz_oxide::inflate::decompress_to_vec(&compressed).map_err(|err| {
            RomWeaverError::Validation(format!(
                "ZIP: failed to inflate entry `{}`: {err:?}",
                entry.name
            ))
        }),
        other => Err(RomWeaverError::Validation(format!(
            "ZIP: entry `{}` uses unsupported compression method {other}",
            entry.name
        ))),
    }
}

/// Find the End Of Central Directory record and return
/// `(cd_offset, cd_size, entry_count)`.
fn locate_central_directory<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
) -> Result<(u64, usize, usize)> {
    let search_len = std::cmp::min(file_len, EOCD_SEARCH_LIMIT as u64);
    let search_start = file_len - search_len;
    reader.seek(SeekFrom::Start(search_start))?;
    let mut tail = vec![0u8; search_len as usize];
    reader.read_exact(&mut tail)?;

    // Scan backward for the EOCD signature.
    let mut eocd = None;
    for i in (0..tail.len().saturating_sub(EOCD_MIN_SIZE - 1)).rev() {
        if read_u32(&tail, i) == EOCD_SIGNATURE {
            eocd = Some(i);
            break;
        }
    }
    let eocd = eocd.ok_or_else(|| {
        RomWeaverError::Validation("ZIP: no End Of Central Directory record found".to_string())
    })?;
    let rec = &tail[eocd..];
    if rec.len() < EOCD_MIN_SIZE {
        return Err(RomWeaverError::Validation(
            "ZIP: truncated End Of Central Directory record".to_string(),
        ));
    }
    let entry_count = read_u16(rec, 10) as usize;
    let cd_size = read_u32(rec, 12);
    let cd_offset = read_u32(rec, 16);
    if cd_size == ZIP64_SENTINEL || cd_offset == ZIP64_SENTINEL || read_u16(rec, 8) == u16::MAX {
        return Err(RomWeaverError::Validation(
            "ZIP: ZIP64 archives are not yet supported".to_string(),
        ));
    }
    Ok((u64::from(cd_offset), cd_size as usize, entry_count))
}
