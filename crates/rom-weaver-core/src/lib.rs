mod cancel;
mod context;
mod error;
mod io;
mod progress;
mod registry;
mod threads;

pub use cancel::CancellationToken;
pub use context::{OperationContext, PatchChecksumValidation};
pub use error::{
    Result, RomWeaverError, ValidationCodeError, ValidationField, ValidationFieldValue,
};
pub use io::{ChunkPlanner, FileChunk, TempPathAllocator};
pub use progress::{
    NoopProgressSink, OperationFamily, OperationStatus, ProgressEvent, ProgressSink,
    RecordingProgressSink,
};
pub use registry::{
    traced_codec_backend, traced_container_handler, traced_patch_handler, ChecksumCapabilities,
    ChecksumEngine, ChecksumRequest, CodecBackend, CodecCapabilities, CodecDescriptor,
    CodecOperationRequest, ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandler, ContainerInspectRequest, FormatDescriptor, OperationReport,
    PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler, ProbeConfidence,
};
pub use threads::{SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode};
