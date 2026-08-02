pub(crate) const LIBARCHIVE_CREATE_IO_BUFFER_BYTES: usize = 128 * 1024;
pub(crate) const LIBARCHIVE_CREATE_ZSTD_IO_BUFFER_BYTES: usize = 1024 * 1024;
pub(crate) const LIBARCHIVE_EXTRACT_IO_BUFFER_BYTES: usize = 8 * 1024 * 1024;
/// Read window for the parallel extract path, where every in-flight chunk is a live buffer: up to
/// one per worker plus the bounded channel's backlog. 8 MiB there is past the point of diminishing
/// returns for a decode loop - measured user CPU is flat from 8 MiB down to 256 KiB on a solid 7z -
/// while costing 8x the resident bytes, which is what a wasm linear memory never gives back.
pub(crate) const LIBARCHIVE_PARALLEL_EXTRACT_CHUNK_BYTES: usize = 1024 * 1024;
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

pub(crate) fn copy_progress_buffer_size(total_bytes: u64) -> usize {
    if total_bytes == 0 {
        return COPY_PROGRESS_DEFAULT_BUFFER_BYTES;
    }
    (total_bytes / 100).clamp(
        COPY_PROGRESS_MIN_BUFFER_BYTES,
        COPY_PROGRESS_MAX_BUFFER_BYTES,
    ) as usize
}
