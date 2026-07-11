//! Minimal ZIP central-directory reader.
//!
//! A `.dcp` (Universal Dreamcast Patcher patch) is a plain ZIP archive. To
//! describe its contents we only need each entry's name and sizes, which live
//! in the central directory - no decompression and therefore no DEFLATE
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
    /// CRC32 of the uncompressed contents (central-directory field).
    pub crc32: u32,
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
        let crc32 = read_u32(&cd, pos + 16);
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
            crc32,
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
/// DEFLATE (8) methods - the only ones a `.dcp` uses - are supported.
pub fn extract_entry<R: Read + Seek>(reader: &mut R, entry: &ZipEntry) -> Result<Vec<u8>> {
    let file_len = reader.seek(SeekFrom::End(0))?;
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
    let data_start = reader.seek(SeekFrom::Current(name_len + extra_len))?;

    // `compressed_size` is an attacker-controlled 32-bit field; reject any value
    // that overruns the remaining file before sizing the read buffer so a tiny
    // malicious archive cannot trigger a multi-gigabyte allocation.
    let remaining = file_len.saturating_sub(data_start);
    if u64::from(entry.compressed_size) > remaining {
        return Err(RomWeaverError::Validation(format!(
            "ZIP: entry `{}` compressed size {} exceeds remaining file length {remaining}",
            entry.name, entry.compressed_size
        )));
    }
    let mut compressed = vec![0u8; entry.compressed_size as usize];
    reader.read_exact(&mut compressed)?;

    // Bound inflation by the declared uncompressed size so a deflate bomb cannot
    // grow the output vec without limit, and reject any stream whose real length
    // disagrees with the central-directory field.
    let extracted = match entry.method {
        METHOD_STORED => compressed,
        METHOD_DEFLATE => {
            let out = miniz_oxide::inflate::decompress_to_vec_with_limit(
                &compressed,
                entry.uncompressed_size as usize,
            )
            .map_err(|err| {
                RomWeaverError::Validation(format!(
                    "ZIP: failed to inflate entry `{}`: {err:?}",
                    entry.name
                ))
            })?;
            if out.len() != entry.uncompressed_size as usize {
                return Err(RomWeaverError::Validation(format!(
                    "ZIP: entry `{}` inflated to {} bytes, expected {}",
                    entry.name,
                    out.len(),
                    entry.uncompressed_size
                )));
            }
            out
        }
        other => {
            return Err(RomWeaverError::Validation(format!(
                "ZIP: entry `{}` uses unsupported compression method {other}",
                entry.name
            )));
        }
    };

    // Integrity: verbatim/boot-sector .dcp payloads have no other checksum, so a
    // bit-flipped stored or deflate entry must be rejected here rather than
    // written into the rebuilt disc.
    let actual_crc = crc32fast::hash(&extracted);
    if actual_crc != entry.crc32 {
        return Err(RomWeaverError::Validation(format!(
            "ZIP: entry `{}` CRC32 mismatch: computed {actual_crc:#010x}, expected {:#010x}",
            entry.name, entry.crc32
        )));
    }
    tracing::trace!(
        entry = %entry.name,
        len = extracted.len(),
        crc32 = actual_crc,
        "extracted and verified ZIP entry"
    );
    Ok(extracted)
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
    // The 32-bit size fields are attacker-controlled: a value just below the
    // ZIP64 sentinel (e.g. 0xFFFF_FFFE, ~4 GiB) clears the guard above yet would
    // size a multi-gigabyte allocation. Reject any central directory that cannot
    // fit in the file before it is read into memory.
    let cd_offset = u64::from(cd_offset);
    let fits = cd_offset
        .checked_add(u64::from(cd_size))
        .is_some_and(|end| end <= file_len);
    if !fits {
        return Err(RomWeaverError::Validation(format!(
            "ZIP: central directory (offset {cd_offset}, size {cd_size}) exceeds file length {file_len}"
        )));
    }
    Ok((cd_offset, cd_size as usize, entry_count))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn le16(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }
    fn le32(v: u32) -> [u8; 4] {
        v.to_le_bytes()
    }

    /// Build a valid one-entry archive with the given local payload and
    /// central-directory metadata, so extraction can be exercised end to end.
    fn single_entry_archive(
        name: &[u8],
        method: u16,
        payload: &[u8],
        compressed_size: u32,
        uncompressed_size: u32,
        crc32: u32,
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&le32(LOCAL_FILE_HEADER_SIGNATURE));
        buf.extend_from_slice(&le16(20)); // version needed
        buf.extend_from_slice(&le16(0)); // flags
        buf.extend_from_slice(&le16(method));
        buf.extend_from_slice(&le16(0)); // mod time
        buf.extend_from_slice(&le16(0)); // mod date
        buf.extend_from_slice(&le32(crc32));
        buf.extend_from_slice(&le32(compressed_size));
        buf.extend_from_slice(&le32(uncompressed_size));
        buf.extend_from_slice(&le16(name.len() as u16));
        buf.extend_from_slice(&le16(0)); // extra len
        buf.extend_from_slice(name);
        buf.extend_from_slice(payload);

        let cd_offset = buf.len() as u32;
        let mut central = Vec::new();
        central.extend_from_slice(&le32(CENTRAL_FILE_HEADER_SIGNATURE));
        central.extend_from_slice(&le16(20)); // version made by
        central.extend_from_slice(&le16(20)); // version needed
        central.extend_from_slice(&le16(0)); // flags
        central.extend_from_slice(&le16(method));
        central.extend_from_slice(&le16(0)); // mod time
        central.extend_from_slice(&le16(0)); // mod date
        central.extend_from_slice(&le32(crc32));
        central.extend_from_slice(&le32(compressed_size));
        central.extend_from_slice(&le32(uncompressed_size));
        central.extend_from_slice(&le16(name.len() as u16));
        central.extend_from_slice(&le16(0)); // extra len
        central.extend_from_slice(&le16(0)); // comment len
        central.extend_from_slice(&le16(0)); // disk start
        central.extend_from_slice(&le16(0)); // internal attr
        central.extend_from_slice(&le32(0)); // external attr
        central.extend_from_slice(&le32(0)); // local header offset
        central.extend_from_slice(name);

        let cd_size = central.len() as u32;
        buf.extend_from_slice(&central);

        buf.extend_from_slice(&le32(EOCD_SIGNATURE));
        buf.extend_from_slice(&le16(0)); // disk
        buf.extend_from_slice(&le16(0)); // cd disk
        buf.extend_from_slice(&le16(1)); // entries this disk
        buf.extend_from_slice(&le16(1)); // total entries
        buf.extend_from_slice(&le32(cd_size));
        buf.extend_from_slice(&le32(cd_offset));
        buf.extend_from_slice(&le16(0)); // comment len
        buf
    }

    /// An EOCD-only buffer whose central-directory size field is just below the
    /// ZIP64 sentinel (~4 GiB) while the file is 22 bytes must be rejected
    /// before the central directory is allocated.
    #[test]
    fn rejects_central_directory_larger_than_file() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&le32(EOCD_SIGNATURE));
        buf.extend_from_slice(&le16(0)); // disk
        buf.extend_from_slice(&le16(0)); // cd disk
        buf.extend_from_slice(&le16(0)); // entries this disk
        buf.extend_from_slice(&le16(0)); // total entries
        buf.extend_from_slice(&le32(0xFFFF_FFFE)); // cd_size, just under the sentinel
        buf.extend_from_slice(&le32(0)); // cd_offset
        buf.extend_from_slice(&le16(0)); // comment len

        let err = read_central_directory(&mut Cursor::new(buf)).unwrap_err();
        assert!(matches!(err, RomWeaverError::Validation(_)));
    }

    /// A valid one-entry archive whose central `compressed_size` lies (~4 GiB,
    /// not the ZIP64 sentinel): extraction must reject it instead of allocating
    /// a multi-gigabyte buffer.
    #[test]
    fn rejects_entry_compressed_size_larger_than_file() {
        let data: &[u8] = b"hi";
        let name: &[u8] = b"x.bin";

        let mut buf = Vec::new();
        // Local file header + stored payload.
        buf.extend_from_slice(&le32(LOCAL_FILE_HEADER_SIGNATURE));
        buf.extend_from_slice(&le16(20)); // version needed
        buf.extend_from_slice(&le16(0)); // flags
        buf.extend_from_slice(&le16(METHOD_STORED));
        buf.extend_from_slice(&le16(0)); // mod time
        buf.extend_from_slice(&le16(0)); // mod date
        buf.extend_from_slice(&le32(0)); // crc32
        buf.extend_from_slice(&le32(data.len() as u32)); // compressed
        buf.extend_from_slice(&le32(data.len() as u32)); // uncompressed
        buf.extend_from_slice(&le16(name.len() as u16));
        buf.extend_from_slice(&le16(0)); // extra len
        buf.extend_from_slice(name);
        buf.extend_from_slice(data);

        // Central-directory header with a malicious compressed size.
        let cd_offset = buf.len() as u32;
        let mut central = Vec::new();
        central.extend_from_slice(&le32(CENTRAL_FILE_HEADER_SIGNATURE));
        central.extend_from_slice(&le16(20)); // version made by
        central.extend_from_slice(&le16(20)); // version needed
        central.extend_from_slice(&le16(0)); // flags
        central.extend_from_slice(&le16(METHOD_STORED));
        central.extend_from_slice(&le16(0)); // mod time
        central.extend_from_slice(&le16(0)); // mod date
        central.extend_from_slice(&le32(0)); // crc32
        central.extend_from_slice(&le32(0xFFFF_FFFE)); // compressed, just under the sentinel
        central.extend_from_slice(&le32(data.len() as u32)); // uncompressed
        central.extend_from_slice(&le16(name.len() as u16));
        central.extend_from_slice(&le16(0)); // extra len
        central.extend_from_slice(&le16(0)); // comment len
        central.extend_from_slice(&le16(0)); // disk start
        central.extend_from_slice(&le16(0)); // internal attr
        central.extend_from_slice(&le32(0)); // external attr
        central.extend_from_slice(&le32(0)); // local header offset
        central.extend_from_slice(name);

        let cd_size = central.len() as u32;
        buf.extend_from_slice(&central);

        // End Of Central Directory.
        buf.extend_from_slice(&le32(EOCD_SIGNATURE));
        buf.extend_from_slice(&le16(0)); // disk
        buf.extend_from_slice(&le16(0)); // cd disk
        buf.extend_from_slice(&le16(1)); // entries this disk
        buf.extend_from_slice(&le16(1)); // total entries
        buf.extend_from_slice(&le32(cd_size));
        buf.extend_from_slice(&le32(cd_offset));
        buf.extend_from_slice(&le16(0)); // comment len

        let mut reader = Cursor::new(buf);
        let entries = read_central_directory(&mut reader).unwrap();
        assert_eq!(entries.len(), 1);
        let err = extract_entry(&mut reader, &entries[0]).unwrap_err();
        assert!(matches!(err, RomWeaverError::Validation(_)));
    }

    /// Stored and deflate entries with a correct CRC32 extract to their exact
    /// bytes.
    #[test]
    fn extracts_stored_and_deflate_with_valid_crc() {
        let data = vec![0x42u8; 4096];
        let crc = crc32fast::hash(&data);

        let stored = single_entry_archive(
            b"x.bin",
            METHOD_STORED,
            &data,
            data.len() as u32,
            data.len() as u32,
            crc,
        );
        let mut reader = Cursor::new(stored);
        let entries = read_central_directory(&mut reader).unwrap();
        assert_eq!(extract_entry(&mut reader, &entries[0]).unwrap(), data);

        let deflated = miniz_oxide::deflate::compress_to_vec(&data, 6);
        let archive = single_entry_archive(
            b"y.bin",
            METHOD_DEFLATE,
            &deflated,
            deflated.len() as u32,
            data.len() as u32,
            crc,
        );
        let mut reader = Cursor::new(archive);
        let entries = read_central_directory(&mut reader).unwrap();
        assert_eq!(extract_entry(&mut reader, &entries[0]).unwrap(), data);
    }

    /// A deflate stream that expands past its declared `uncompressed_size` is
    /// rejected rather than growing the output buffer without bound.
    #[test]
    fn rejects_deflate_bomb_exceeding_declared_size() {
        let bomb = vec![0u8; 256 * 1024];
        let deflated = miniz_oxide::deflate::compress_to_vec(&bomb, 6);
        assert!(deflated.len() < bomb.len(), "payload must compress");

        // Declare a tiny uncompressed size: inflation must stop at the limit and
        // report a validation error instead of producing the full 256 KiB.
        let archive = single_entry_archive(
            b"bomb.bin",
            METHOD_DEFLATE,
            &deflated,
            deflated.len() as u32,
            16,
            0,
        );
        let mut reader = Cursor::new(archive);
        let entries = read_central_directory(&mut reader).unwrap();
        let err = extract_entry(&mut reader, &entries[0]).unwrap_err();
        assert!(matches!(err, RomWeaverError::Validation(_)));
    }

    /// A stored entry whose bytes do not match the central-directory CRC32 is
    /// rejected (corrupt verbatim/boot-sector payload).
    #[test]
    fn rejects_entry_with_wrong_crc32() {
        let data: &[u8] = b"hello dreamcast";
        let archive = single_entry_archive(
            b"track.bin",
            METHOD_STORED,
            data,
            data.len() as u32,
            data.len() as u32,
            0xDEAD_BEEF, // deliberately wrong
        );
        let mut reader = Cursor::new(archive);
        let entries = read_central_directory(&mut reader).unwrap();
        let err = extract_entry(&mut reader, &entries[0]).unwrap_err();
        assert!(matches!(err, RomWeaverError::Validation(_)));
    }
}
