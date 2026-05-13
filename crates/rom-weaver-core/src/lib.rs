mod cancel;
mod context;
mod error;
mod io;
mod progress;
mod registry;
mod threads;

pub use cancel::CancellationToken;
pub use context::OperationContext;
pub use error::{Result, RomWeaverError};
pub use io::{ChunkPlanner, FileChunk, TempPathAllocator};
pub use progress::{
    NoopProgressSink, OperationFamily, OperationStatus, ProgressEvent, ProgressSink,
    RecordingProgressSink,
};
pub use registry::{
    ChecksumCapabilities, ChecksumEngine, ChecksumRequest, CodecBackend, CodecCapabilities,
    CodecDescriptor, CodecOperationRequest, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerInspectRequest, FormatDescriptor,
    OperationReport, PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler,
    ProbeConfidence,
};
pub use threads::{SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode};
