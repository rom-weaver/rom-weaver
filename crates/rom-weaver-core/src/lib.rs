pub mod codecs;

mod access;
mod cancel;
mod common_files;
mod concurrency;
mod context;
mod disc_sheet;
mod env;
mod error;
mod formatting;
mod io;
mod media_topology;
mod n64;
mod output_replace;
mod parallel_heap;
mod patch_support;
pub mod pbp;
mod progress;
mod prompt;
mod registry;
mod report_details;
pub mod save;
mod selection;
mod suggest;
mod threads;

pub use access::{access_advice, effective_ids, in_container};
pub use cancel::{
    CancellationToken, clear_in_progress_outputs, complete_in_progress_output,
    process_cancellation_token, register_in_progress_output, register_live_temp_dir,
    remove_in_progress_outputs, remove_live_temp_dirs, unregister_live_temp_dir,
    with_output_creation,
};
pub use common_files::{
    ArchiveEntryKindFilter, COMMON_CONTAINER_FILE_EXTENSIONS, CONTAINER_FILTER_FILE_EXTENSIONS,
    KindFilterNameMatch, PATCH_FILTER_FILE_EXTENSIONS, ROM_FILTER_FILE_EXTENSIONS,
    is_container_filter_passthrough_candidate_name, is_dcp_patch_name,
    is_patch_filter_candidate_name, is_rom_filter_candidate_name,
    payload_name_needs_content_classification, select_kind_filter_matches,
    should_ignore_common_container_file,
};
pub use concurrency::{
    BatchPlan, BatchWave, ConcurrencyLimits, JobDemand, plan_batch, plan_waves,
    resolve_memory_ceiling, working_set_estimate,
};
pub use context::{
    OperationContext, PatchApplyDirection, PatchCheckScopes, PatchChecksumValidation,
    PatchEndpointSelection, PatchPolicy, XdeltaSecondaryMode,
};
pub use disc_sheet::{
    DiscSheetKind, DiscSheetRefs, detect_disc_sheet, enumerate_disc_sheet_file_names,
    enumerate_disc_sheet_refs, parse_disc_sheet_refs_from_text, sibling_gdi_path,
};
pub use env::{env_u64, env_u64_opt};
pub use error::{
    ChdMediaScope, FormatOperationKind, IoOp, IoResultExt, Result, RomWeaverError,
    RomWeaverErrorKind, UnsupportedOp, VALIDATION_CODE_EXTRACT_NO_CONTAINER,
    VALIDATION_CODE_WBFS_SIZE_MISMATCH, ValidationCodeError, ValidationField, ValidationFieldValue,
};
pub use formatting::format_human_bytes;
pub use io::{
    BlockCacheReader, ChunkPlanner, DEFAULT_BLOCK_CACHE_MAX_BLOCKS, DEFAULT_BLOCK_CACHE_SIZE_BYTES,
    DEFAULT_CHUNK_SIZE_BYTES, FileChunk, IoWatermark, OrderedChunkWriter, OrderedStreamingMessages,
    SharedBlockCacheReader, StagedOutput, TempPathAllocator, bounded_items_for_threads,
    copy_cancelable, copy_file_retrying_interrupted, copy_retrying_interrupted,
    create_extract_output_file, ensure_output_available, file_starts_with,
    ordered_streaming_compress, read_full, read_up_to, retry_interrupted,
};
pub use media_topology::{
    ComponentId, ComponentRole, DetectionConfidence, DetectionEvidence, MediaComponent, MediaKind,
    MediaTopology, PlatformCandidate,
};
pub use n64::{
    N64_BIG_ENDIAN_MAGIC, N64_BYTE_SWAPPED_MAGIC, N64_LITTLE_ENDIAN_MAGIC, N64ByteOrder,
};
pub use parallel_heap::{parallel_heap_reserve, reserve_parallel_heap};
pub use patch_support::{checksum_validation_suffix, require_single_patch_file};
pub use progress::{
    ContainerByteProgress, NoopProgressSink, OperationFamily, OperationStatus, ProgressEvent,
    ProgressSink, RecordingProgressSink, emit_container_running_progress, emit_variant_plan,
    maybe_emit_container_byte_progress,
};
pub use prompt::{
    NoninteractivePrompter, ParsedSelectionInput, ParsedSelectionListInput, PromptCandidate,
    Selection, SelectionList, SelectionPrompter, parse_selection_input, parse_selection_list_input,
};
pub use registry::{
    ChecksumRequest, ContainerCapabilities, ContainerCreateRequest, ContainerExtractRequest,
    ContainerHandler, ContainerHandlerOperations, ContainerHandlerRegistration, ContainerListEntry,
    ContainerProbeRequest, CreateInputOverride, CreateInputSource, CreateSupport, FormatDescriptor,
    OperationReport, PatchApplyRequest, PatchCapabilities, PatchCreateFormatOptions,
    PatchCreateRequest, PatchHandler, PatchValidateRequest, ProbeConfidence, SolidPatchMetadata,
    traced_container_handler, traced_patch_handler,
};
pub use report_details::{
    attach_emitted_file_paths, attach_extraction_details, build_emitted_file_detail,
    build_known_emitted_file_detail, emitted_path_key, insert_thread_execution_details,
    operation_report_details,
};
pub use save::{
    RAW_SAVE_FILE_EXTENSIONS, SaveChangePreview, SaveConfidence, SaveConstraint, SaveContainerKind,
    SaveDetectionInput, SaveDocument, SaveEdit, SaveEditResult, SaveField, SaveFieldChange,
    SaveFieldKind, SaveFieldValue, SaveFormatCandidate, SaveGameCandidate, SaveGameDefinition,
    SaveGameIdentity, SaveGameRegistry, SaveIntegrity, SaveIntegrityIssue, SaveIntegrityState,
    SaveRecognition, SaveRecognitionConfidence, SaveRecognitionOutcome, SaveRecognitionReason,
    SaveSection, SaveValue, SchemaSaveHandler, apply_save_edits, candidate_save_formats,
    detect_save, parse_save, unwrap_save_container, validate_save_edits,
};
pub use selection::{SelectionMatcher, normalize_archive_name};
pub use suggest::{closest_name, did_you_mean_suffix};
pub use threads::{
    SharedThreadPool, ThreadBudget, ThreadCapability, ThreadExecution, ThreadMode,
    decode_memory_budget_bytes, physical_memory_bytes,
};
#[cfg(target_arch = "wasm32")]
pub use threads::{WASM_MEMORY_BUDGET_BYTES, wasm_linear_memory_used_bytes};
