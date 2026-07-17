import type { BrowserStorageManagerLike } from "./browser-storage-estimate.ts";

type BrowserOutputStorageGuardOptions = {
  operationLabel: string;
  requiredBytes?: number | null;
  storage?: BrowserStorageManagerLike | null;
};

type CodedOutputStorageError = Error & {
  cause?: unknown;
  code: "OUTPUT_WRITE_FAILED";
  details?: Record<string, unknown>;
};

const BROWSER_OUTPUT_STORAGE_FAILURE_REGEX = /\b(no space left|quota|nospc|enospc)\b/i;
const BROWSER_OUTPUT_STORAGE_CONTEXT_REGEX = /\[storage:/i;

const toNonNegativeByteCount = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
};

const createOutputStorageError = (
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): CodedOutputStorageError => {
  const error = new Error(message) as CodedOutputStorageError;
  error.name = "OutputStorageError";
  error.code = "OUTPUT_WRITE_FAILED";
  error.details = details;
  if (cause !== undefined) error.cause = cause;
  return error;
};

const ensureBrowserStorageAvailableForOutput = async (_options: BrowserOutputStorageGuardOptions): Promise<void> => {
  // navigator.storage quota/persistence values can be fingerprinting-noisy.
  // Skip preflight gating and rely on real write/extract failures instead.
};

const withBrowserOutputStorageFailureContext = async (
  error: unknown,
  { operationLabel, requiredBytes }: BrowserOutputStorageGuardOptions,
): Promise<unknown> => {
  const message = error instanceof Error ? error.message : String(error || "");
  if (BROWSER_OUTPUT_STORAGE_CONTEXT_REGEX.test(message)) return error;
  if (!BROWSER_OUTPUT_STORAGE_FAILURE_REGEX.test(message)) return error;

  const requiredByteCount = toNonNegativeByteCount(requiredBytes);
  return createOutputStorageError(
    message,
    {
      operationLabel,
      ...(requiredByteCount === null ? {} : { requiredBytes: requiredByteCount }),
    },
    error,
  );
};

export { ensureBrowserStorageAvailableForOutput, withBrowserOutputStorageFailureContext };
