import { createLogger } from "../../lib/logging.ts";
import { getBinarySourceTraceKind } from "../../storage/shared/binary/source-shared.ts";
import { getBinarySourceFileName, getBinarySourceSize } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";

const logger = createLogger("ui");

const getTraceSourceSummary = (source: unknown, fallback: string) => ({
  fileName: getBinarySourceFileName(source as BinarySource, fallback),
  kind: getBinarySourceTraceKind(source),
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
  logger.error(context, getErrorLogDetails(error));
};

export { getTraceSourceSummaries, getTraceSourceSummary, logUiError };
