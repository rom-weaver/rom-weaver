import { getBinarySourceFileName, getBinarySourceSize } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";

const getTraceSourceKind = (source: unknown) => {
  if (typeof File !== "undefined" && source instanceof File) return "file";
  if (typeof Blob !== "undefined" && source instanceof Blob) return "blob";
  if (source instanceof Uint8Array) return "uint8array";
  if (source instanceof ArrayBuffer) return "arraybuffer";
  if (
    source &&
    typeof source === "object" &&
    "getFile" in source &&
    typeof (source as { getFile?: unknown }).getFile === "function"
  )
    return "file-handle";
  if (source && typeof source === "object") return "object";
  return typeof source;
};

const getTraceSourceSummary = (source: unknown, fallback: string) => ({
  fileName: getBinarySourceFileName(source as BinarySource, fallback),
  kind: getTraceSourceKind(source),
  size: getBinarySourceSize(source as BinarySource) ?? undefined,
});

const getTraceSourceSummaries = (sources: BinarySource[], fallbackPrefix: string) =>
  sources.map((source, index) => getTraceSourceSummary(source, `${fallbackPrefix} ${index + 1}`));

const getErrorLogDetails = (error: Error): Record<string, unknown> => {
  const coded = error as Error & { cause?: unknown; code?: unknown; details?: unknown };
  const cause = coded.cause;
  return {
    cause:
      cause instanceof Error
        ? {
            message: cause.message,
            name: cause.name,
            stack: cause.stack,
          }
        : cause,
    code: typeof coded.code === "string" ? coded.code : undefined,
    details: coded.details,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
};

const logUiError = (context: string, error: Error) => {
  try {
    console.error(`[RomWeaver UI] ${context}: ${error.message}`, getErrorLogDetails(error), error);
  } catch (_logError) {
    // Ignore console failures; the UI still surfaces the normalized message.
  }
};

export { getErrorLogDetails, getTraceSourceKind, getTraceSourceSummaries, getTraceSourceSummary, logUiError };
