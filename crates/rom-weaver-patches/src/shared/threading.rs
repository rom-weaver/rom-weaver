//! Thread-capability planning helpers shared by the patch format handlers.
//!
//! These were previously duplicated byte-for-byte (or near so) across the
//! per-format modules. Per-format chunk-size constants and overflow error
//! strings stay in the format modules and are passed in by each call site so
//! behavior remains identical per format.

use std::{
    fs::File,
    io::{Seek, SeekFrom, Write},
};

use rayon::prelude::*;
use rom_weaver_core::{
    OperationContext, Result, RomWeaverError, SharedThreadPool, ThreadCapability, ThreadExecution,
};

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

/// Plans `capability` against the context's thread budget and runs `parallel`
/// with a freshly built pool when the plan negotiated parallelism (and the
/// caller's `allow_parallel` gate permits it), otherwise runs `serial` under
/// the planned single-thread execution.
///
/// Reproduces the orchestration previously duplicated across the format
/// handlers byte-for-byte: plan first, branch on `used_parallelism`, build the
/// pool (which re-plans and may fall back) only on the parallel path, and
/// surface the planned execution unchanged on the serial path. `allow_parallel`
/// carries per-site gates that disable parallelism for specific patch shapes.
pub(crate) fn run_with_optional_pool<T>(
    context: &OperationContext,
    capability: ThreadCapability,
    allow_parallel: bool,
    parallel: impl FnOnce(&SharedThreadPool) -> Result<T>,
    serial: impl FnOnce() -> Result<T>,
) -> Result<(ThreadExecution, T)> {
    // NOTE: deliberately no extra logging here - `plan_threads`/`build_pool`
    // already trace the negotiation, and the migrated call sites must emit a
    // byte-identical trace stream to the pre-refactor per-format code.
    let planned = context.plan_threads(capability.clone());
    if planned.used_parallelism && allow_parallel {
        let (execution, pool) = context.build_pool(capability)?;
        let value = parallel(&pool)?;
        return Ok((execution, value));
    }
    let value = serial()?;
    Ok((planned, value))
}

/// One positioned output write produced by a parallel prepare pass: the bytes
/// to write and the absolute output offset they land at.
pub(crate) struct PreparedWrite {
    pub(crate) offset: u64,
    pub(crate) data: Vec<u8>,
}

/// Seeks and writes each prepared write into `output`, skipping empty
/// payloads. Identical to the per-format loops it replaces.
pub(crate) fn apply_prepared_writes(output: &mut File, writes: &[PreparedWrite]) -> Result<()> {
    for write in writes {
        if write.data.is_empty() {
            continue;
        }
        output.seek(SeekFrom::Start(write.offset))?;
        output.write_all(&write.data)?;
    }
    Ok(())
}

/// Maps `items` to results on `pool` with rayon, failing fast on the first
/// error. Cancellation checks are deliberately NOT built in; callers keep
/// `context.cancel().check()?` inside `map` exactly where each format had it.
pub(crate) fn pool_map<I: Sync, T: Send>(
    pool: &SharedThreadPool,
    items: &[I],
    map: impl Fn(&I) -> Result<T> + Sync + Send,
) -> Result<Vec<T>> {
    pool.install(|| items.par_iter().map(&map).collect::<Result<Vec<_>>>())
}

/// Scans the create input in `chunk_count` chunks on `pool`, producing one `T`
/// per chunk. `scan_chunk_by_index` opens the files itself per chunk in
/// parallel and fails fast on the first error. Cancellation checks and
/// per-format fallback `info!` messages stay at the call sites.
pub(crate) fn scan_create_chunks<T: Send>(
    chunk_count: usize,
    pool: &SharedThreadPool,
    scan_chunk_by_index: impl Fn(usize) -> Result<T> + Sync + Send,
) -> Result<Vec<T>> {
    pool.install(|| {
        (0..chunk_count)
            .into_par_iter()
            .map(&scan_chunk_by_index)
            .collect::<Result<Vec<_>>>()
    })
}
