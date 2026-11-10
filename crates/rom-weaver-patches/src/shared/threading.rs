//! Thread-capability planning helpers shared by the patch format handlers.
//!
//! Callers supply per-format chunk sizes and overflow errors so diagnostics
//! keep their format-specific wording.

use std::{
    collections::VecDeque,
    io::{Seek, SeekFrom, Write},
    ops::Range,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
};

use rayon::prelude::*;
use rom_weaver_core::{
    CancellationToken, OperationContext, Result, RomWeaverError, SharedThreadPool,
    ThreadCapability, ThreadExecution, bounded_items_for_threads, decode_memory_budget_bytes,
    parallel_heap_reserve, reserve_parallel_heap,
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

fn write_prepared_batch<T: Sync>(
    output: &mut (impl Write + Seek),
    pool: Option<&SharedThreadPool>,
    batch: &[T],
    prepare: impl Fn(&T) -> Result<PreparedWrite> + Sync + Send,
) -> Result<()> {
    let writes = if let Some(pool) = pool {
        pool_map(pool, batch, prepare)?
    } else {
        batch.iter().map(prepare).collect::<Result<Vec<_>>>()?
    };
    apply_prepared_writes(output, &writes)
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
        write_prepared_batch(output, pool, batch, |(item, range)| {
            prepare(item, range.clone())
        })
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

/// Removes incomplete output after closing its handle, including during unwinding.
/// The caller MUST keep this guard outside any worker scope so workers join first.
pub(crate) struct PartialOutput<'a, W> {
    output: Option<W>,
    path: &'a Path,
    complete: bool,
}

impl<'a, W> PartialOutput<'a, W> {
    pub(crate) fn new(output: W, path: &'a Path) -> Self {
        Self {
            output: Some(output),
            path,
            complete: false,
        }
    }

    pub(crate) fn output(&mut self) -> &mut W {
        self.output
            .as_mut()
            .expect("output remains open until completion")
    }

    pub(crate) fn complete(mut self) {
        drop(self.output.take());
        self.complete = true;
    }
}

impl<W> Drop for PartialOutput<'_, W> {
    fn drop(&mut self) {
        drop(self.output.take());
        if !self.complete {
            tracing::debug!(output = %self.path.display(), "removing partial patch output after failed apply");
            let _ = std::fs::remove_file(self.path);
        }
    }
}

pub(crate) struct WholeWriteBatchOptions<'a, I> {
    pub(crate) pool: Option<&'a SharedThreadPool>,
    pub(crate) effective_threads: usize,
    pub(crate) write_len: fn(&I) -> usize,
    pub(crate) memory_len: &'a (dyn Fn(&I) -> u64 + Sync),
    pub(crate) fixed_memory_bytes: u64,
    pub(crate) cancel: &'a CancellationToken,
}

#[derive(Clone, Copy)]
struct WriteCharge {
    bytes: usize,
    memory: u64,
}

struct WriteAdmission {
    slots: usize,
    byte_limit: usize,
    memory_limit: u64,
    bytes: usize,
    memory: u64,
}

impl WriteAdmission {
    fn accepts(&self, count: usize, charge: WriteCharge) -> bool {
        count == 0
            || (count < self.slots
                && self
                    .bytes
                    .checked_add(charge.bytes)
                    .is_some_and(|n| n <= self.byte_limit)
                && self
                    .memory
                    .checked_add(charge.memory)
                    .is_some_and(|n| n <= self.memory_limit))
    }

    fn acquire(&mut self, charge: WriteCharge) {
        self.bytes = self.bytes.saturating_add(charge.bytes);
        self.memory = self.memory.saturating_add(charge.memory);
    }

    fn release(&mut self, charge: WriteCharge) {
        self.bytes -= charge.bytes;
        self.memory -= charge.memory;
    }
}

struct StopOnDrop<'a>(&'a AtomicBool);

impl Drop for StopOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Holds written buffers so later items reuse them instead of allocating.
#[derive(Default)]
struct SpareBuffers(Mutex<Vec<Vec<u8>>>);

impl SpareBuffers {
    /// Returns an empty buffer whose capacity is exactly `len` when a spare is large enough.
    fn take(&self, len: usize) -> Vec<u8> {
        let spare = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .pop();
        match spare {
            Some(mut buffer) if buffer.capacity() >= len => {
                buffer.clear();
                buffer.shrink_to(len);
                buffer
            }
            _ => Vec::with_capacity(len),
        }
    }

    fn put(&self, buffer: Vec<u8>) {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(buffer);
    }
}

/// Prepares whole items on workers and writes them in order on the caller; oversized items
/// run alone. A slot stays charged until its buffer is written; `prepare` SHOULD fill that buffer.
pub(crate) fn apply_batched_whole_writes<I: Sync>(
    output: &mut (impl Write + Seek),
    items: &[I],
    options: WholeWriteBatchOptions<'_, I>,
    prepare: impl Fn(&I, Vec<u8>) -> Result<PreparedWrite> + Sync + Send,
) -> Result<()> {
    WholeWritePipeline::new(items, options, prepare).run(output, decode_memory_budget_bytes())
}

struct WholeWritePipeline<'a, I, P> {
    items: &'a [I],
    options: WholeWriteBatchOptions<'a, I>,
    prepare: P,
    spares: SpareBuffers,
    stop: AtomicBool,
}

impl<'a, I: Sync, P: Fn(&I, Vec<u8>) -> Result<PreparedWrite> + Sync + Send>
    WholeWritePipeline<'a, I, P>
{
    fn new(items: &'a [I], options: WholeWriteBatchOptions<'a, I>, prepare: P) -> Self {
        Self {
            items,
            options,
            prepare,
            spares: SpareBuffers::default(),
            stop: AtomicBool::new(false),
        }
    }

    fn run(&self, output: &mut (impl Write + Seek), memory_budget: u64) -> Result<()> {
        let WholeWriteBatchOptions {
            pool,
            effective_threads,
            write_len,
            memory_len,
            fixed_memory_bytes,
            cancel: _,
        } = &self.options;
        let slots = (*effective_threads)
            .max(1)
            .min(pool.map_or(1, SharedThreadPool::size));
        let overhead = pool.map_or(0, |pool| parallel_heap_reserve(pool.size())) as u64;
        let fixed_memory_bytes = fixed_memory_bytes.saturating_add(overhead);
        let mut admission = WriteAdmission {
            slots,
            byte_limit: parallel_write_batch_bytes(slots),
            memory_limit: memory_budget.saturating_sub(fixed_memory_bytes),
            bytes: 0,
            memory: 0,
        };
        let charge = |item: &I| WriteCharge {
            bytes: write_len(item),
            memory: memory_len(item),
        };
        // Simulate the same ordered admissions across the entire plan, including late large windows.
        let mut planned = VecDeque::new();
        let mut peak_memory = 0;
        let mut parallel_memory = 0;
        let mut peak_bytes = 0;
        let mut peak_slots = 0;
        for item in self.items {
            let item_charge = charge(item);
            while !admission.accepts(planned.len(), item_charge) {
                admission.release(planned.pop_front().expect("nonempty admission"));
            }
            admission.acquire(item_charge);
            planned.push_back(item_charge);
            peak_memory = peak_memory.max(admission.memory);
            if planned.len() > 1 {
                parallel_memory = parallel_memory.max(admission.memory);
            }
            peak_bytes = peak_bytes.max(admission.bytes);
            peak_slots = peak_slots.max(planned.len());
        }
        tracing::debug!(
            slots,
            peak_slots,
            peak_bytes,
            peak_memory,
            parallel_memory,
            fixed_memory_bytes,
            memory_budget,
            "patch whole write admission plan"
        );
        admission.bytes = 0;
        admission.memory = 0;
        drop(planned);

        if let Some(pool) = pool {
            pool.in_place_scope(|scope| {
                let scope = scope.filter(|_| peak_slots > 1);
                if scope.is_some() {
                    reserve_parallel_heap(
                        usize::try_from(
                            parallel_memory.saturating_add(parallel_heap_reserve(0) as u64),
                        )
                        .unwrap_or(usize::MAX),
                    );
                }
                self.write_items(output, scope, &mut admission)
            })
        } else {
            self.write_items(output, None, &mut admission)
        }
    }

    fn prepare_item(&self, item: &I) -> Result<PreparedWrite> {
        let buffer = self.spares.take((self.options.write_len)(item));
        (self.prepare)(item, buffer)
    }

    fn write_items<'scope>(
        &'scope self,
        output: &mut (impl Write + Seek),
        scope: Option<&rayon::Scope<'scope>>,
        admission: &mut WriteAdmission,
    ) -> Result<()> {
        let options = &self.options;
        let items = self.items;
        let stop = &self.stop;
        let cancel = options.cancel;
        let Some(scope) = scope else {
            for item in items {
                cancel.check()?;
                let write = self.prepare_item(item)?;
                cancel.check()?;
                write_whole_item(output, &write, cancel)?;
                self.spares.put(write.data);
            }
            return Ok(());
        };
        let mut pending = VecDeque::new();
        let _stop_on_exit = StopOnDrop(stop);
        let mut next = 0;
        loop {
            while next < items.len() {
                cancel.check()?;
                let item = &items[next];
                let charge = WriteCharge {
                    bytes: (options.write_len)(item),
                    memory: (options.memory_len)(item),
                };
                if !admission.accepts(pending.len(), charge) {
                    break;
                }
                admission.acquire(charge);
                let (sender, receiver) = mpsc::sync_channel(1);
                scope.spawn(move |_| {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    let result = cancel
                        .check()
                        .and_then(|()| self.prepare_item(item))
                        .and_then(|write| {
                            cancel.check()?;
                            Ok(write)
                        });
                    // Exactly one send fits even while the coordinator writes another slot.
                    let _ = sender.send(result);
                });
                pending.push_back((receiver, charge));
                next += 1;
                tracing::trace!(
                    outstanding = pending.len(),
                    bytes = admission.bytes,
                    memory = admission.memory,
                    "patch whole write admitted"
                );
            }
            let Some((receiver, charge)) = pending.pop_front() else {
                return Ok(());
            };
            let write = receiver.recv().map_err(|_| {
                RomWeaverError::Validation(
                    "patch decoder stopped before returning a prepared write".into(),
                )
            })??;
            cancel.check()?;
            write_whole_item(output, &write, cancel)?;
            self.spares.put(write.data);
            admission.release(charge);
        }
    }
}

fn write_whole_item(
    output: &mut (impl Write + Seek),
    write: &PreparedWrite,
    cancel: &CancellationToken,
) -> Result<()> {
    if !write.data.is_empty() {
        output.seek(SeekFrom::Start(write.offset))?;
        cancel.check()?;
        output.write_all(&write.data)?;
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
