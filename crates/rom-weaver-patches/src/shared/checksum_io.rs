//! Checksum and varint I/O helpers shared by the patch format handlers.
//!
//! These were previously duplicated byte-for-byte (or near so) inside the BPS
//! and UPS modules. Per-format constants (buffer sizes, footer sizes, error
//! strings) stay in the format modules and are passed in by each call site so
//! behavior remains identical per format.

use std::{
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
};

use crc32fast::Hasher;
use rom_weaver_checksum::checksum_file_values;
use rom_weaver_core::{OperationContext, Result, RomWeaverError};

pub(crate) fn read_u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("u32 slice"))
}

pub(crate) fn crc32_slice(bytes: &[u8]) -> u32 {
    let mut hasher = Hasher::new();
    hasher.update(bytes);
    hasher.finalize()
}

pub(crate) fn crc32_path_cached(path: &Path, context: &OperationContext) -> Result<u32> {
    let parse_hex = |value: &str| {
        u32::from_str_radix(value, 16).map_err(|error| {
            RomWeaverError::Validation(format!(
                "native checksum engine returned invalid crc32: {error}"
            ))
        })
    };
    // Reuse a CRC32 the host already computed for this exact input (seeded from `--checksum-cache`)
    // instead of re-reading the whole file just to re-derive the source checksum.
    if let Some(cached) = context.seeded_checksum(path, "crc32") {
        return parse_hex(&cached);
    }
    let results = checksum_file_values(path, &["crc32"], context)?;
    let Some(value) = results.get("crc32") else {
        return Err(RomWeaverError::Validation(
            "native checksum engine did not return crc32 result".into(),
        ));
    };
    parse_hex(value)
}

/// CRC32 of the first `len` bytes of `path`, read through a `buffer_len`-sized
/// chunk buffer. `overflow_error` is the format-specific message reported if a
/// chunk length cannot fit in `usize`.
pub(crate) fn crc32_prefix(
    path: &Path,
    len: u64,
    buffer_len: usize,
    overflow_error: &'static str,
) -> Result<u32> {
    let mut file = BufReader::new(File::open(path)?);
    let mut hasher = Hasher::new();
    let mut remaining = len;
    let mut buffer = vec![0u8; buffer_len];
    while remaining > 0 {
        let chunk_len = usize::try_from(remaining.min(buffer.len() as u64))
            .map_err(|_| RomWeaverError::Validation(overflow_error.into()))?;
        file.read_exact(&mut buffer[..chunk_len])?;
        hasher.update(&buffer[..chunk_len]);
        remaining -= chunk_len as u64;
    }
    Ok(hasher.finalize())
}

/// Reads the fixed-size `N`-byte footer that starts at `footer_offset`.
pub(crate) fn read_footer<const N: usize>(path: &Path, footer_offset: u64) -> Result<[u8; N]> {
    let mut footer = [0u8; N];
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(footer_offset))?;
    file.read_exact(&mut footer)?;
    Ok(footer)
}
