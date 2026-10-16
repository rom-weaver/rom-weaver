//! Heap reservation for threaded sections on browser wasi-threads.
//!
//! V8 does not synchronize a shared `memory.grow` with the memory size that other threads'
//! instances have cached. A bulk-memory instruction (`memory.fill`, `memory.copy`) bounds-checks
//! against that cached size, so a thread that writes to pages another thread just grew can trap
//! "memory access out of bounds". The trapped wasi thread never reaches its join and the run hangs
//! with no error. Reserving the section's heap up front on the coordinating thread means its
//! workers reuse committed memory and nothing grows while siblings run.

/// Per-worker share of a reservation: the 2 MiB default thread stack plus per-task scratch.
const RESERVE_PER_WORKER_BYTES: usize = 4 * 1024 * 1024;
/// Headroom for allocator overhead and coordinator-side buffers.
const RESERVE_MARGIN_BYTES: usize = 32 * 1024 * 1024;

/// Heap that `workers` threads need for their stacks and per-task scratch. Callers with a larger
/// in-flight working set add it before calling [`reserve_parallel_heap`].
pub fn parallel_heap_reserve(workers: usize) -> usize {
    workers
        .saturating_mul(RESERVE_PER_WORKER_BYTES)
        .saturating_add(RESERVE_MARGIN_BYTES)
}

/// Grows the wasm heap by up to `bytes` before a threaded section starts.
///
/// dlmalloc grows only above the current `memory.size`, so a larger initial memory does not help;
/// allocating and freeing one block leaves the pages in its free list for the section to reuse.
/// Callers MUST call this on the coordinating thread before spawning workers. No-op off wasm
/// threads.
#[cfg(all(target_family = "wasm", rom_weaver_wasi_threads))]
pub fn reserve_parallel_heap(bytes: usize) {
    // Caps one reservation so a large plan cannot exhaust a constrained host's memory.
    const RESERVE_MAX_BYTES: usize = 768 * 1024 * 1024;
    let bytes = bytes.min(RESERVE_MAX_BYTES);
    tracing::trace!(
        bytes,
        heap_pages = ?wasm_heap_pages(),
        "reserve parallel heap before spawning workers"
    );
    reserve_block(bytes);
}

/// Allocates and frees one block of `bytes`, leaving its pages in the allocator's free list. A
/// refused `memory.grow` is logged and skipped: the section then grows on demand as before rather
/// than aborting the wasm.
#[cfg(any(all(target_family = "wasm", rom_weaver_wasi_threads), test))]
fn reserve_block(bytes: usize) -> bool {
    let mut reserve: Vec<u8> = Vec::new();
    if let Err(error) = reserve.try_reserve_exact(bytes) {
        tracing::debug!(bytes, %error, "parallel heap reservation refused; growing on demand");
        return false;
    }
    reserve.push(0);
    std::hint::black_box(reserve.as_ptr());
    drop(reserve);
    true
}

#[cfg(not(all(target_family = "wasm", rom_weaver_wasi_threads)))]
pub fn reserve_parallel_heap(_bytes: usize) {}

/// Current wasm linear-memory size in 64 KiB pages; `None` off wasm.
pub(crate) fn wasm_heap_pages() -> Option<usize> {
    #[cfg(target_arch = "wasm32")]
    {
        Some(core::arch::wasm32::memory_size::<0>())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        None
    }
}

#[cfg(test)]
#[path = "../tests/unit/parallel_heap.rs"]
mod tests;
