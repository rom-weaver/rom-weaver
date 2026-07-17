import type { WorkflowErrorCode } from "../types/errors.ts";

type RomWeaverErrorCode = WorkflowErrorCode;
type CodedErrorLike = Error & {
  code?: unknown;
  details?: Record<string, unknown>;
};

class RomWeaverError extends Error {
  code: RomWeaverErrorCode;
  override cause?: unknown;
  details?: Record<string, unknown>;

  constructor(
    code: RomWeaverErrorCode,
    message: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "RomWeaverError";
    this.code = code;
    this.cause = options?.cause;
    this.details = options?.details;
  }
}

const createAbortError = () => new RomWeaverError("CANCELLED", "Workflow was cancelled");

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const COMPRESSION_FAILURE_MESSAGE_REGEX =
  /\b(archive|chd|compression failed|conversion|decompress|decompression|dolphin|extract|extracting|rvz|z3ds)\b|input file could not be opened/i;
const MODULE_IMPORT_FAILURE_MESSAGE_REGEX =
  /\b(importing a module script failed|failed to load module script|failed to fetch dynamically imported module|module script failed to load)\b/i;
const OUT_OF_MEMORY_MESSAGE_REGEX =
  /\b(out of memory|cannot enlarge memory|memory allocation|not enough memory|bad alloc|ENOMEM|OOM)\b/i;
const OUTPUT_WRITE_FAILURE_MESSAGE_REGEX =
  /\b(createwritable|writable|read\/write access|read\/write permission|destination file|output could not be written|modifications are not allowed|no space left|quota|nospc|enospc)\b/i;
const WORKFLOW_ERROR_CODES = new Set<RomWeaverErrorCode>([
  "AMBIGUOUS_SELECTION",
  "ARCHIVE_DEPTH_EXCEEDED",
  "CANCELLED",
  "CHECKSUM_MISMATCH",
  "COMPRESSION_FAILED",
  "INVALID_INPUT",
  "INVALID_SETTINGS",
  "NO_COMPATIBLE_PATCH",
  "NO_SELECTABLE_CANDIDATE",
  "OUTPUT_WRITE_FAILED",
  "PATCH_APPLY_FAILED",
  "PATCH_CREATE_FAILED",
  "PATCH_PARSE_FAILED",
  "PATCH_TARGET_MISMATCH",
  "SELECTION_NOT_FOUND",
  "SOURCE_NOT_FOUND",
  "SOURCE_UNSUPPORTED",
  "STORAGE_UNAVAILABLE",
  "UNSUPPORTED_FORMAT",
  "WORKFLOW_BUSY",
  "WORKFLOW_DISPOSED",
  "WORKFLOW_EVENT_BUFFER_OVERFLOW",
  "WORKFLOW_INVALID_STATE",
  "WORKFLOW_NOT_READY",
  "WORKER_FAILED",
  "WORKER_UNAVAILABLE",
]);

const getWorkflowErrorCode = (error: unknown): RomWeaverErrorCode | null => {
  const code = error instanceof Error ? (error as CodedErrorLike).code : undefined;
  return typeof code === "string" && WORKFLOW_ERROR_CODES.has(code as RomWeaverErrorCode)
    ? (code as RomWeaverErrorCode)
    : null;
};

const toRomWeaverError = (error: unknown): RomWeaverError => {
  if (error instanceof RomWeaverError) return error;
  const message = getErrorMessage(error);
  const existingCode = getWorkflowErrorCode(error);
  if (existingCode)
    return new RomWeaverError(existingCode, message, {
      cause: error instanceof Error && "cause" in error ? (error as Error & { cause?: unknown }).cause || error : error,
      details:
        error instanceof Error &&
        (error as CodedErrorLike).details &&
        typeof (error as CodedErrorLike).details === "object"
          ? (error as CodedErrorLike).details
          : undefined,
    });
  const lower = message.toLowerCase();
  if (lower.includes("abort") || lower.includes("cancel"))
    return new RomWeaverError("CANCELLED", message, { cause: error });
  if (lower.includes("archive nesting") || lower.includes("archive depth"))
    return new RomWeaverError("ARCHIVE_DEPTH_EXCEEDED", message, { cause: error });
  if (lower.includes("multiple") && lower.includes("candidate"))
    return new RomWeaverError("AMBIGUOUS_SELECTION", message, { cause: error });
  if (lower.includes("target was not found"))
    return new RomWeaverError("PATCH_TARGET_MISMATCH", message, {
      cause: error,
    });
  if (MODULE_IMPORT_FAILURE_MESSAGE_REGEX.test(message))
    return new RomWeaverError("WORKER_FAILED", message, { cause: error });
  if (lower.includes("checksum")) return new RomWeaverError("CHECKSUM_MISMATCH", message, { cause: error });
  if (lower.includes("multi-file output")) return new RomWeaverError("INVALID_INPUT", message, { cause: error });
  if (OUT_OF_MEMORY_MESSAGE_REGEX.test(message))
    return new RomWeaverError(
      COMPRESSION_FAILURE_MESSAGE_REGEX.test(message) ? "COMPRESSION_FAILED" : "WORKER_FAILED",
      message,
      { cause: error },
    );
  if (OUTPUT_WRITE_FAILURE_MESSAGE_REGEX.test(message))
    return new RomWeaverError("OUTPUT_WRITE_FAILED", message, { cause: error });
  if (COMPRESSION_FAILURE_MESSAGE_REGEX.test(message))
    return new RomWeaverError("COMPRESSION_FAILED", message, { cause: error });
  if (lower.includes("no input") || lower.includes("no patch"))
    return new RomWeaverError("INVALID_INPUT", message, { cause: error });
  return new RomWeaverError("INVALID_INPUT", message, { cause: error });
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw createAbortError();
};

const withAbortSignal = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(createAbortError());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

export { OUT_OF_MEMORY_MESSAGE_REGEX, RomWeaverError, throwIfAborted, toRomWeaverError, withAbortSignal };
