type WorkflowErrorCode =
  | "AMBIGUOUS_SELECTION"
  | "ARCHIVE_DEPTH_EXCEEDED"
  | "CANCELLED"
  | "CHECKSUM_MISMATCH"
  | "COMPRESSION_FAILED"
  | "INVALID_INPUT"
  | "INVALID_SETTINGS"
  | "NO_COMPATIBLE_PATCH"
  | "NO_SELECTABLE_CANDIDATE"
  | "OUTPUT_WRITE_FAILED"
  | "PATCH_APPLY_FAILED"
  | "PATCH_CREATE_FAILED"
  | "PATCH_PARSE_FAILED"
  | "PATCH_TARGET_MISMATCH"
  | "SELECTION_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_UNSUPPORTED"
  | "STORAGE_UNAVAILABLE"
  | "UNSUPPORTED_FORMAT"
  | "WORKFLOW_BUSY"
  | "WORKFLOW_DISPOSED"
  | "WORKFLOW_EVENT_BUFFER_OVERFLOW"
  | "WORKFLOW_INVALID_STATE"
  | "WORKFLOW_NOT_READY"
  | "WORKER_FAILED"
  | "WORKER_UNAVAILABLE";

type ErrorSeverity = "error" | "fatal" | "warning";

type RomWeaverErrorDetails = {
  cause?: unknown;
  candidateId?: string;
  expected?: unknown;
  fileName?: string;
  operation?: string;
  received?: unknown;
  requestId?: string;
  role?: string;
  sourceName?: string;
  workerKind?: string;
  [key: string]: unknown;
};

type RomWeaverError = Error & {
  code: WorkflowErrorCode;
  details?: RomWeaverErrorDetails;
  severity?: ErrorSeverity;
};

export type { ErrorSeverity, RomWeaverError, RomWeaverErrorDetails, WorkflowErrorCode };
