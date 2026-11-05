//! Stable error codes shared with the webapp.
//!
//! A [`crate::ValidationCodeError`] code names one failure the UI tells apart.
//! Failed progress events carry it as `error_code` (with `error_fields`), and
//! typegen emits [`ERROR_CODE_WORKFLOW_CODES`] so the webapp maps a code to its
//! [`WorkflowErrorCode`] without reading message text. Add a code here when the
//! webapp needs to distinguish a failure; codes no UI branch reads may stay
//! local string literals.

use serde::{Deserialize, Serialize};
#[cfg(feature = "typescript-types")]
use ts_rs::TS;

/// Workflow-level error classification the webapp localizes and branches on.
/// It also lists the browser-only codes (worker, storage, and workflow state)
/// so the generated union is the single list of webapp error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript-types", derive(TS))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum WorkflowErrorCode {
    AmbiguousSelection,
    ArchiveDepthExceeded,
    ArchiveReadFailed,
    Cancelled,
    ChecksumMismatch,
    CompressionFailed,
    InvalidInput,
    InvalidSettings,
    NoCompatiblePatch,
    NoSelectableCandidate,
    OutputWriteFailed,
    PatchApplyFailed,
    PatchCreateFailed,
    PatchParseFailed,
    PatchTargetMismatch,
    SelectionNotFound,
    SourceNotFound,
    SourceUnsupported,
    StorageUnavailable,
    UnsupportedFormat,
    WorkflowBusy,
    WorkflowDisposed,
    WorkflowEventBufferOverflow,
    WorkflowInvalidState,
    WorkflowNotReady,
    WorkerFailed,
    WorkerUnavailable,
}

impl WorkflowErrorCode {
    /// Every variant, in declaration order, for the generated runtime list.
    pub const ALL: &'static [Self] = &[
        Self::AmbiguousSelection,
        Self::ArchiveDepthExceeded,
        Self::ArchiveReadFailed,
        Self::Cancelled,
        Self::ChecksumMismatch,
        Self::CompressionFailed,
        Self::InvalidInput,
        Self::InvalidSettings,
        Self::NoCompatiblePatch,
        Self::NoSelectableCandidate,
        Self::OutputWriteFailed,
        Self::PatchApplyFailed,
        Self::PatchCreateFailed,
        Self::PatchParseFailed,
        Self::PatchTargetMismatch,
        Self::SelectionNotFound,
        Self::SourceNotFound,
        Self::SourceUnsupported,
        Self::StorageUnavailable,
        Self::UnsupportedFormat,
        Self::WorkflowBusy,
        Self::WorkflowDisposed,
        Self::WorkflowEventBufferOverflow,
        Self::WorkflowInvalidState,
        Self::WorkflowNotReady,
        Self::WorkerFailed,
        Self::WorkerUnavailable,
    ];
}

/// An extract source no registered container recognizes.
pub const VALIDATION_CODE_EXTRACT_NO_CONTAINER: &str = "extract.no_container";

/// A WBFS file or split set whose total size differs from its header's.
/// Carries `actual` and `expected` byte fields.
pub const VALIDATION_CODE_WBFS_SIZE_MISMATCH: &str = "wbfs.size_mismatch";

/// No extract entry matched the entry filter. Carries `path` and `filter`.
pub const ERROR_CODE_EXTRACT_NO_MATCHING_ENTRIES: &str = "extract.no_matching_entries";

/// Every extract candidate was dropped by the default ignore filters. Carries `path`.
pub const ERROR_CODE_EXTRACT_ALL_ENTRIES_IGNORED: &str = "extract.all_entries_ignored";

/// Nested archive extraction went deeper than the limit. Carries `max_depth` and `path`.
pub const ERROR_CODE_EXTRACT_MAX_DEPTH_EXCEEDED: &str = "extract.max_depth_exceeded";

/// libarchive could not read or decode an archive's headers or data.
pub const ERROR_CODE_ARCHIVE_READ_FAILED: &str = "archive.read_failed";

/// libarchive could not open or read the archive file itself (a storage
/// problem, not archive damage).
pub const ERROR_CODE_ARCHIVE_STORAGE_FAILED: &str = "archive.storage_failed";

/// The user dismissed an interactive selection prompt.
pub const ERROR_CODE_SELECTION_CANCELLED: &str = "selection.cancelled";

/// Trim was given a disc format it does not support (GameCube/Wii discs).
pub const ERROR_CODE_TRIM_UNSUPPORTED_DISC: &str = "trim.unsupported_disc";

/// A GameCube/Wii (nod) create input is not a GameCube or Wii disc image.
pub const ERROR_CODE_DISC_NOT_GAMECUBE_WII: &str = "disc.not_gamecube_wii";

/// A patch file failed its own checksum, so the patch itself is damaged.
pub const ERROR_CODE_PATCH_FILE_CHECKSUM_INVALID: &str = "patch.file_checksum_invalid";

/// A source, target, or output checksum differs from the one a patch expects.
pub const ERROR_CODE_PATCH_CHECKSUM_MISMATCH: &str = "patch.checksum_mismatch";

/// A write failed because the storage is full.
pub const ERROR_CODE_IO_STORAGE_FULL: &str = "io.storage_full";

/// Each code the webapp distinguishes, with the workflow code it reports as.
/// Typegen emits this table; a code missing here reaches the webapp uncoded.
pub const ERROR_CODE_WORKFLOW_CODES: &[(&str, WorkflowErrorCode)] = &[
    (
        VALIDATION_CODE_EXTRACT_NO_CONTAINER,
        WorkflowErrorCode::UnsupportedFormat,
    ),
    (
        VALIDATION_CODE_WBFS_SIZE_MISMATCH,
        WorkflowErrorCode::InvalidInput,
    ),
    (
        ERROR_CODE_EXTRACT_NO_MATCHING_ENTRIES,
        WorkflowErrorCode::CompressionFailed,
    ),
    (
        ERROR_CODE_EXTRACT_ALL_ENTRIES_IGNORED,
        WorkflowErrorCode::CompressionFailed,
    ),
    (
        ERROR_CODE_EXTRACT_MAX_DEPTH_EXCEEDED,
        WorkflowErrorCode::ArchiveDepthExceeded,
    ),
    (
        ERROR_CODE_ARCHIVE_READ_FAILED,
        WorkflowErrorCode::ArchiveReadFailed,
    ),
    (
        ERROR_CODE_ARCHIVE_STORAGE_FAILED,
        WorkflowErrorCode::CompressionFailed,
    ),
    (ERROR_CODE_SELECTION_CANCELLED, WorkflowErrorCode::Cancelled),
    (
        ERROR_CODE_TRIM_UNSUPPORTED_DISC,
        WorkflowErrorCode::UnsupportedFormat,
    ),
    (
        ERROR_CODE_DISC_NOT_GAMECUBE_WII,
        WorkflowErrorCode::UnsupportedFormat,
    ),
    (
        ERROR_CODE_PATCH_FILE_CHECKSUM_INVALID,
        WorkflowErrorCode::ChecksumMismatch,
    ),
    (
        ERROR_CODE_PATCH_CHECKSUM_MISMATCH,
        WorkflowErrorCode::ChecksumMismatch,
    ),
    (
        ERROR_CODE_IO_STORAGE_FULL,
        WorkflowErrorCode::OutputWriteFailed,
    ),
];

/// The workflow code a stable error code reports as, if the webapp distinguishes it.
pub fn workflow_error_code(code: &str) -> Option<WorkflowErrorCode> {
    ERROR_CODE_WORKFLOW_CODES
        .iter()
        .find(|(candidate, _)| *candidate == code)
        .map(|(_, workflow)| *workflow)
}

#[cfg(test)]
#[path = "../tests/unit/error_codes.rs"]
mod tests;
