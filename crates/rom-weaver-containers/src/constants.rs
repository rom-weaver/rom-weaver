pub(crate) const LIBARCHIVE_CREATE_IO_BUFFER_BYTES: usize = 128 * 1024;
pub(crate) const LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES: usize = 1024 * 1024;
pub(crate) const LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PARALLEL_COORDINATOR_STACK_SIZE_BYTES: usize = 8 * 1024 * 1024;

const COPY_PROGRESS_DEFAULT_BUFFER_BYTES: usize = 64 * 1024;
const COPY_PROGRESS_MIN_BUFFER_BYTES: u64 = 16 * 1024;
const COPY_PROGRESS_MAX_BUFFER_BYTES: u64 = 4 * 1024 * 1024;

/// Independent z3ds frame size. 1 MiB gives high zstd levels a larger match
/// window while retaining parallelism and bounded browser memory. Frame size is
/// stored in metadata, so older archives remain decodable.
pub(crate) const Z3DS_DEFAULT_FRAME_SIZE_BYTES: usize = 1024 * 1024;
pub(crate) const Z3DS_DEFAULT_COMPRESSION_LEVEL: i32 = 3;
pub(crate) const Z3DS_MIN_COMPRESSION_LEVEL: i32 = -7;
pub(crate) const Z3DS_MAX_COMPRESSION_LEVEL: i32 = 22;
/// Maximum frame-aligned span per extract task. Smaller inputs shrink tasks to
/// keep requested threads busy without re-decoding frame prefixes.
pub(crate) const Z3DS_EXTRACT_MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// How many extract tasks to aim for per requested thread. >1 gives the scheduler slack to balance
/// uneven frame compressibility across workers instead of stalling on one slow tail task.
pub(crate) const Z3DS_EXTRACT_TASKS_PER_THREAD: usize = 4;
/// Scratch buffer size for streaming a frame group out of the decoder into the output chunk. Keeps
/// the transient decode buffer small and constant regardless of how large an extract task spans.
pub(crate) const Z3DS_DECODE_BUFFER_BYTES: usize = 256 * 1024;

/// Memory an operation may plan its own concurrency against, in bytes.
///
/// `env_key` (read as MiB) wins so constrained or shared hosts can pin it. Otherwise native hosts
/// take half of physical RAM and leave the rest to the OS and the remainder of the process, while
/// wasm takes the reported figure whole - there it is already the conservative shared linear-memory
/// instance budget, not machine RAM. The fixed fallback covers hosts where RAM cannot be queried.
pub(crate) fn planning_memory_budget_bytes(env_key: &str) -> u64 {
    #[cfg(target_family = "wasm")]
    const FALLBACK_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
    #[cfg(not(target_family = "wasm"))]
    const FALLBACK_BUDGET_BYTES: u64 = 2 * 1024 * 1024 * 1024;

    rom_weaver_core::env_u64_opt(env_key)
        .map(|mb| mb.saturating_mul(1024 * 1024))
        .or_else(|| {
            rom_weaver_core::physical_memory_bytes().map(|ram| {
                if cfg!(target_family = "wasm") {
                    ram
                } else {
                    ram / 2
                }
            })
        })
        .unwrap_or(FALLBACK_BUDGET_BYTES)
}

pub(crate) fn copy_progress_buffer_size(total_bytes: u64) -> usize {
    if total_bytes == 0 {
        return COPY_PROGRESS_DEFAULT_BUFFER_BYTES;
    }
    (total_bytes / 100).clamp(
        COPY_PROGRESS_MIN_BUFFER_BYTES,
        COPY_PROGRESS_MAX_BUFFER_BYTES,
    ) as usize
}
