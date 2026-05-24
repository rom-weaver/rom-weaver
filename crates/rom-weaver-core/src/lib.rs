mod cancel;
mod context;
mod error;
mod io;
mod progress;
mod registry;
mod threads;

pub use cancel::CancellationToken;
pub use context::{OperationContext, PatchChecksumValidation, XdeltaSecondaryMode};
pub use error::{
    Result, RomWeaverError, ValidationCodeError, ValidationField, ValidationFieldValue,
};
pub use io::{
    BlockCacheReader, BoundedIoPolicy, ChunkPlanner, DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    DEFAULT_BLOCK_CACHE_SIZE_BYTES, DEFAULT_CHUNK_SIZE_BYTES, FileChunk, IoWatermark,
    OrderedChunkWriter, SharedBlockCacheReader, TempPathAllocator, bounded_items_for_threads,
};
pub use progress::{
    NoopProgressSink, OperationFamily, OperationStatus, ProgressEvent, ProgressSink,
    RecordingProgressSink,
};
pub use registry::{
    ChecksumCapabilities, ChecksumEngine, ChecksumRequest, CodecBackend, CodecCapabilities,
    CodecDescriptor, CodecOperationRequest, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerInspectRequest, FormatDescriptor,
    OperationReport, PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler,
    ProbeConfidence, traced_codec_backend, traced_container_handler, traced_patch_handler,
};
pub use threads::{SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode};
