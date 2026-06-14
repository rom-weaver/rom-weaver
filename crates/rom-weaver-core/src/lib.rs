mod cancel;
mod common_files;
mod context;
mod disc_sheet;
mod error;
mod formatting;
mod io;
mod progress;
mod prompt;
mod registry;
mod selection;
mod threads;

pub use cancel::CancellationToken;
pub use common_files::{
    ArchiveEntryKindFilter, COMMON_CONTAINER_FILE_EXTENSIONS, CONTAINER_FILTER_FILE_EXTENSIONS,
    PATCH_FILTER_FILE_EXTENSIONS, ROM_FILTER_FILE_EXTENSIONS,
    is_container_filter_passthrough_candidate_name, is_patch_filter_candidate_name,
    is_rom_filter_candidate_name, should_ignore_common_container_file,
};
pub use context::{OperationContext, PatchChecksumValidation, XdeltaSecondaryMode};
pub use disc_sheet::{
    DiscSheetKind, DiscSheetRefs, detect_disc_sheet, enumerate_disc_sheet_refs, sibling_gdi_path,
};
pub use error::{
    ChdMediaScope, FormatOperationKind, Result, RomWeaverError, UnsupportedOp, ValidationCodeError,
    ValidationField, ValidationFieldValue,
};
pub use formatting::format_human_bytes;
pub use io::{
    BlockCacheReader, BoundedIoPolicy, ChunkPlanner, DEFAULT_BLOCK_CACHE_MAX_BLOCKS,
    DEFAULT_BLOCK_CACHE_SIZE_BYTES, DEFAULT_CHUNK_SIZE_BYTES, FileChunk, IoWatermark,
    OrderedChunkWriter, OrderedStreamingMessages, SharedBlockCacheReader, TempPathAllocator,
    bounded_items_for_threads, create_extract_output_file, file_starts_with,
    ordered_streaming_compress, reads_source_on_main_thread,
};
pub use progress::{
    ContainerByteProgress, NoopProgressSink, OperationFamily, OperationStatus, ProgressEvent,
    ProgressSink, RecordingProgressSink, emit_container_running_progress,
    maybe_emit_container_byte_progress,
};
pub use prompt::{
    NoninteractivePrompter, ParsedSelectionInput, ParsedSelectionListInput, PromptCandidate,
    Selection, SelectionList, SelectionPrompter, parse_selection_input, parse_selection_list_input,
};
pub use registry::{
    ChecksumCapabilities, ChecksumEngine, ChecksumRequest, CodecBackend, CodecCapabilities,
    CodecDescriptor, CodecOperationRequest, ContainerCapabilities, ContainerCreateRequest,
    ContainerExtractRequest, ContainerHandler, ContainerHandlerOperations, ContainerListEntry,
    ContainerProbeRequest, CreateInputOverride, CreateInputSource, FormatDescriptor,
    OperationReport, PatchApplyRequest, PatchCapabilities, PatchCreateRequest, PatchHandler,
    PatchValidateRequest, ProbeConfidence, traced_codec_backend, traced_container_handler,
    traced_patch_handler,
};
pub use selection::{SelectionMatcher, normalize_archive_name};
pub use threads::{
    SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode,
    physical_memory_bytes,
};
