pub(crate) const LIBARCHIVE_CREATE_IO_BUFFER_BYTES: usize = 128 * 1024;
pub(crate) const LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES: usize = 1024 * 1024;
pub(crate) const LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const PARALLEL_COORDINATOR_STACK_SIZE_BYTES: usize = 8 * 1024 * 1024;

/// Native-only escape hatch (set to `"1"`) that forces container pipelines onto the
/// main-thread reader path so it can be exercised outside the browser/wasm runtime.
pub(crate) const MAIN_THREAD_READER_ENV: &str = "ROM_WEAVER_CONTAINER_MAIN_THREAD_READER";

const COPY_PROGRESS_DEFAULT_BUFFER_BYTES: usize = 64 * 1024;
const COPY_PROGRESS_MIN_BUFFER_BYTES: u64 = 16 * 1024;
const COPY_PROGRESS_MAX_BUFFER_BYTES: u64 = 4 * 1024 * 1024;

/// Independent zstd frame size used by z3ds create. Each frame is compressed in isolation so the
/// pipeline can fan frames across worker threads and zeekstd can seek to any frame, but a frame is
/// also the largest window zstd can match within. 256 KiB frames capped high levels (19+ plateaued
/// because the window — not the search — was the limit); 1 MiB lifts that ceiling while keeping
/// thousands of frames for parallelism and bounding per-context memory in the browser runtime. The
/// value is self-describing (stored as `maxframesize` metadata) and decode derives frame layout
/// from the seek table, so changing it stays backward compatible with already-created archives.
pub(crate) const Z3DS_DEFAULT_FRAME_SIZE_BYTES: usize = 1024 * 1024;
pub(crate) const Z3DS_DEFAULT_COMPRESSION_LEVEL: i32 = 3;
pub(crate) const Z3DS_MIN_COMPRESSION_LEVEL: i32 = 0;
pub(crate) const Z3DS_MAX_COMPRESSION_LEVEL: i32 = 22;
/// Upper bound on the decompressed span handed to each extract worker. Tasks are built from whole
/// frames (always frame-aligned, so no worker re-decodes a prefix it discards) and grow up to this
/// cap to amortize decoder setup over several frames on large archives — but shrink toward a single
/// frame on smaller ones so every requested thread still gets work (see
/// [`Z3DS_EXTRACT_TASKS_PER_THREAD`]), bounding the cap's effect on per-task memory either way.
pub(crate) const Z3DS_EXTRACT_MAX_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// How many extract tasks to aim for per requested thread. >1 gives the scheduler slack to balance
/// uneven frame compressibility across workers instead of stalling on one slow tail task.
pub(crate) const Z3DS_EXTRACT_TASKS_PER_THREAD: usize = 4;
/// Scratch buffer size for streaming a frame group out of the decoder into the output chunk. Keeps
/// the transient decode buffer small and constant regardless of how large an extract task spans.
pub(crate) const Z3DS_DECODE_BUFFER_BYTES: usize = 256 * 1024;

pub(crate) fn copy_progress_buffer_size(total_bytes: u64) -> usize {
    if total_bytes == 0 {
        return COPY_PROGRESS_DEFAULT_BUFFER_BYTES;
    }
    (total_bytes / 100).clamp(
        COPY_PROGRESS_MIN_BUFFER_BYTES,
        COPY_PROGRESS_MAX_BUFFER_BYTES,
    ) as usize
}
