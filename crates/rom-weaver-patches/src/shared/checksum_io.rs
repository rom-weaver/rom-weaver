//! Checksum and varint I/O helpers shared by the patch format handlers.
//!
//! Callers supply per-format constants and error strings so diagnostics keep
//! their format-specific wording.

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
    let value = checksum_path_cached(path, "crc32", context)?;
    u32::from_str_radix(&value, 16).map_err(|error| {
        RomWeaverError::Validation(format!(
            "native checksum engine returned invalid crc32: {error}"
        ))
    })
}

/// Hex digest of `algorithm` for `path`. Reuses a value the host already computed for this exact
/// input (seeded from `--assume-in`) instead of re-reading the whole file.
pub(crate) fn checksum_path_cached(
    path: &Path,
    algorithm: &str,
    context: &OperationContext,
) -> Result<String> {
    if let Some(cached) = context.seeded_checksum(path, algorithm) {
        return Ok(cached);
    }
    checksum_file_values(path, &[algorithm], context)?
        .remove(algorithm)
        .ok_or_else(|| {
            RomWeaverError::Validation(format!(
                "native checksum engine did not return {algorithm} result"
            ))
        })
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

#[cfg(test)]
#[path = "../../tests/unit/checksum_io.rs"]
mod tests;
