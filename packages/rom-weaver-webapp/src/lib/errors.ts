import type { WorkflowErrorCode } from "../types/errors.ts";
import { ROM_WEAVER_WORKFLOW_ERROR_CODES } from "../wasm/generated/rom-weaver-format-metadata.ts";
import type { RomWeaverEngineErrorCode, RomWeaverEngineErrorFields } from "../workers/rom-weaver/runner-errors.ts";

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
const STORAGE_FULL_MESSAGE_REGEX = /\b(no space left|quota|nospc|enospc|storage is full)\b|QuotaExceededError/i;
const OUTPUT_WRITE_FAILURE_MESSAGE_REGEX =
  /\b(createwritable|writable|read\/write access|read\/write permission|destination file|output could not be written|modifications are not allowed)\b/i;
const WORKFLOW_ERROR_CODES: ReadonlySet<string> = new Set(ROM_WEAVER_WORKFLOW_ERROR_CODES);

const isWorkflowErrorCode = (code: unknown): code is RomWeaverErrorCode =>
  typeof code === "string" && WORKFLOW_ERROR_CODES.has(code);

type EngineErrorFields = RomWeaverEngineErrorFields;

/**
 * The stable engine code and fields of the first error in the cause chain that a failed Rust run classified
 * (see `withRomWeaverFailure`).
 */
const getEngineError = (error: unknown): { code: string; fields: EngineErrorFields } | undefined => {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth += 1) {
    const details = (current as CodedErrorLike).details;
    if (details && typeof details.engineCode === "string")
      return { code: details.engineCode, fields: (details.engineFields as EngineErrorFields | undefined) ?? {} };
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

const hasEngineErrorCode = (error: unknown, code: RomWeaverEngineErrorCode): boolean =>
  getEngineError(error)?.code === code;

const getSimpleErrorCode = (lower: string): RomWeaverErrorCode | undefined => {
  if (lower.includes("abort") || lower.includes("cancel")) return "CANCELLED";
  if (lower.includes("multiple") && lower.includes("candidate")) return "AMBIGUOUS_SELECTION";
  if (lower.includes("target was not found")) return "PATCH_TARGET_MISMATCH";
  return undefined;
};

const getPatternErrorCode = (lower: string, message: string): RomWeaverErrorCode => {
  if (MODULE_IMPORT_FAILURE_MESSAGE_REGEX.test(message)) return "WORKER_FAILED";
  if (lower.includes("checksum")) return "CHECKSUM_MISMATCH";
  if (lower.includes("multi-file output")) return "INVALID_INPUT";
  if (OUT_OF_MEMORY_MESSAGE_REGEX.test(message)) return "OUT_OF_MEMORY";
  if (STORAGE_FULL_MESSAGE_REGEX.test(message)) return "STORAGE_FULL";
  if (OUTPUT_WRITE_FAILURE_MESSAGE_REGEX.test(message)) return "OUTPUT_WRITE_FAILED";
  if (COMPRESSION_FAILURE_MESSAGE_REGEX.test(message)) return "COMPRESSION_FAILED";
  if (lower.includes("no input") || lower.includes("no patch")) return "INVALID_INPUT";
  return "INVALID_INPUT";
};

const getWorkflowErrorCode = (error: unknown): RomWeaverErrorCode | null => {
  const code = error instanceof Error ? (error as CodedErrorLike).code : undefined;
  return isWorkflowErrorCode(code) ? code : null;
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
  // Engine failures arrive with a code from `withRomWeaverFailure`; this text fallback is for errors raised
  // in the browser (workers, storage, module loading).
  const lower = message.toLowerCase();
  const code = getSimpleErrorCode(lower) || getPatternErrorCode(lower, message);
  return new RomWeaverError(code, message, { cause: error });
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

export {
  getEngineError,
  getErrorMessage,
  hasEngineErrorCode,
  isWorkflowErrorCode,
  OUT_OF_MEMORY_MESSAGE_REGEX,
  RomWeaverError,
  STORAGE_FULL_MESSAGE_REGEX,
  throwIfAborted,
  toRomWeaverError,
  withAbortSignal,
};
