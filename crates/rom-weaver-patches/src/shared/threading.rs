//! Thread-capability planning helpers shared by the patch format handlers.
//!
//! Callers supply per-format chunk sizes and overflow errors so diagnostics
//! keep their format-specific wording.

use std::{
    io::{Seek, SeekFrom, Write},
    ops::Range,
};

use rayon::prelude::*;
use rom_weaver_core::{
    OperationContext, Result, RomWeaverError, SharedThreadPool, ThreadCapability, ThreadExecution,
    bounded_items_for_threads,
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

/// Use the operation's shared pool when capability and caller permit
/// parallelism; otherwise use the planned serial path.
///
/// Pool construction may re-plan and fall back. `allow_parallel` carries
/// format-specific shape gates.
pub(crate) fn run_with_optional_pool<T>(
    context: &OperationContext,
    capability: ThreadCapability,
    allow_parallel: bool,
    parallel: impl FnOnce(&SharedThreadPool) -> Result<T>,
    serial: impl FnOnce() -> Result<T>,
) -> Result<(ThreadExecution, T)> {
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
/// payloads.
pub(crate) fn apply_prepared_writes(
    output: &mut (impl Write + Seek),
    writes: &[PreparedWrite],
) -> Result<()> {
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
/// error. Callers MUST check cancellation inside `map` when required.
pub(crate) fn pool_map<I: Sync, T: Send>(
    pool: &SharedThreadPool,
    items: &[I],
    map: impl Fn(&I) -> Result<T> + Sync + Send,
) -> Result<Vec<T>> {
    pool.install(|| items.par_iter().map(&map).collect::<Result<Vec<_>>>())
}

pub(crate) const PARALLEL_WRITE_CHUNK_BYTES: usize = 4 * 1024 * 1024;

pub(crate) fn parallel_write_batch_bytes(threads: usize) -> usize {
    bounded_items_for_threads(threads).saturating_mul(PARALLEL_WRITE_CHUNK_BYTES)
}

/// Splits oversized records so even a single dense change fits the prepared-byte budget.
/// Callers MUST validate the complete record before preparing any subrange.
pub(crate) fn apply_batched_writes<I: Sync>(
    output: &mut (impl Write + Seek),
    items: &[I],
    pool: Option<&SharedThreadPool>,
    write_len: impl Fn(&I) -> usize,
    prepare: impl Fn(&I, Range<usize>) -> Result<PreparedWrite> + Sync + Send,
) -> Result<()> {
    let byte_limit = parallel_write_batch_bytes(pool.map_or(1, SharedThreadPool::size));
    let mut batch = Vec::new();
    let mut batch_bytes = 0;
    let mut flush = |batch: &[(&I, Range<usize>)]| -> Result<()> {
        tracing::trace!(
            items = batch.len(),
            byte_limit,
            "patch prepared write batch"
        );
        let map = |(item, range): &(&I, Range<usize>)| prepare(item, range.clone());
        let writes = if let Some(pool) = pool {
            pool_map(pool, batch, map)?
        } else {
            batch.iter().map(map).collect::<Result<Vec<_>>>()?
        };
        apply_prepared_writes(output, &writes)
    };
    for item in items {
        let len = write_len(item);
        for start in (0..len.max(1)).step_by(PARALLEL_WRITE_CHUNK_BYTES) {
            let end = start.saturating_add(PARALLEL_WRITE_CHUNK_BYTES).min(len);
            let bytes = end - start;
            if !batch.is_empty() && batch_bytes + bytes > byte_limit {
                flush(&batch)?;
                batch.clear();
                batch_bytes = 0;
            }
            batch.push((item, start..end));
            batch_bytes += bytes;
        }
    }
    if !batch.is_empty() {
        flush(&batch)?;
    }
    Ok(())
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

#[cfg(test)]
#[path = "../../tests/unit/threading.rs"]
mod tests;
