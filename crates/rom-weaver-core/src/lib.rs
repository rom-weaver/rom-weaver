mod cancel;
mod common_files;
mod concurrency;
mod context;
mod disc_sheet;
mod env;
mod error;
mod formatting;
mod io;
mod patch_support;
mod progress;
mod prompt;
mod registry;
mod report_details;
mod selection;
mod threads;

pub use cancel::CancellationToken;
pub use common_files::{
    ArchiveEntryKindFilter, COMMON_CONTAINER_FILE_EXTENSIONS, CONTAINER_FILTER_FILE_EXTENSIONS,
    PATCH_FILTER_FILE_EXTENSIONS, ROM_FILTER_FILE_EXTENSIONS,
    is_container_filter_passthrough_candidate_name, is_patch_filter_candidate_name,
    is_rom_filter_candidate_name, should_ignore_common_container_file,
};
pub use concurrency::{
    BatchPlan, BatchWave, ConcurrencyLimits, JobDemand, plan_batch, plan_waves,
    resolve_memory_ceiling, working_set_estimate,
};
pub use context::{OperationContext, PatchChecksumValidation, PatchPolicy, XdeltaSecondaryMode};
pub use disc_sheet::{
    DiscSheetKind, DiscSheetRefs, detect_disc_sheet, enumerate_disc_sheet_refs, sibling_gdi_path,
};
pub use env::{env_bool, env_u64, env_u64_opt};
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
pub use patch_support::{checksum_validation_suffix, require_single_patch_file};
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
    ContainerExtractRequest, ContainerHandler, ContainerHandlerOperations,
    ContainerHandlerRegistration, ContainerListEntry, ContainerProbeRequest, CreateInputOverride,
    CreateInputSource, CreateSupport, FormatDescriptor, OperationReport, PatchApplyRequest,
    PatchCapabilities, PatchCreateRequest, PatchHandler, PatchValidateRequest, ProbeConfidence,
    traced_codec_backend, traced_container_handler, traced_patch_handler,
};
pub use report_details::{
    attach_extraction_details, insert_thread_execution_details, operation_report_details,
};
pub use selection::{SelectionMatcher, normalize_archive_name};
pub use threads::{
    SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode,
    physical_memory_bytes,
};
#[cfg(target_arch = "wasm32")]
pub use threads::{WASM_MEMORY_BUDGET_BYTES, wasm_linear_memory_used_bytes};
