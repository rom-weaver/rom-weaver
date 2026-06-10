//! Thread-capability planning helpers shared by the patch format handlers.
//!
//! These were previously duplicated byte-for-byte (or near so) across the
//! per-format modules. Per-format chunk-size constants and overflow error
//! strings stay in the format modules and are passed in by each call site so
//! behavior remains identical per format.

use rom_weaver_core::{Result, RomWeaverError, ThreadCapability};

/// Parallel capability sized to one unit of work per parsed record (change,
/// command, primitive, group, ...), with a floor of one so empty patches
/// still plan a usable pool.
pub(crate) fn parallel_per_record_capability(record_count: usize) -> ThreadCapability {
    ThreadCapability::parallel(Some(record_count.max(1)))
}

/// Number of `chunk_bytes`-sized chunks needed to cover `len` bytes. Zero
/// lengths count as one chunk and counts that overflow `usize` saturate to
/// `usize::MAX`.
pub(crate) fn chunk_count_for_len(len: u64, chunk_bytes: u64) -> usize {
    if len == 0 {
        return 1;
    }
    let chunk_count = len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).unwrap_or(usize::MAX)
}

/// Like [`chunk_count_for_len`] but reports the format-specific
/// `overflow_error` when the chunk count cannot be indexed by this platform's
/// `usize` instead of saturating.
pub(crate) fn chunk_count_for_len_checked(
    len: u64,
    chunk_bytes: u64,
    overflow_error: &'static str,
) -> Result<usize> {
    if len == 0 {
        return Ok(1);
    }
    let chunk_count = len.saturating_add(chunk_bytes - 1) / chunk_bytes;
    usize::try_from(chunk_count).map_err(|_| RomWeaverError::Validation(overflow_error.into()))
}

/// Parallel capability with one unit of work per `chunk_bytes`-sized chunk of
/// `len` bytes.
pub(crate) fn parallel_chunked_capability(len: u64, chunk_bytes: u64) -> ThreadCapability {
    ThreadCapability::parallel(Some(chunk_count_for_len(len, chunk_bytes).max(1)))
}
