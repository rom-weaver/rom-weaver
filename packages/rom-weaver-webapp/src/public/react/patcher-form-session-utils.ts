import type { SetStateAction } from "react";
import { getLiteralFileNameExtension, withOutputExtension } from "../../lib/output/output-name-validation.ts";
import { sanitizeTypedOutputName } from "../../lib/path-utils.ts";
import { getErrorCode } from "../../presentation/errors.ts";
import { formatPercentFixed } from "../../presentation/workflow-presentation.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";

const getPublicOutputSize = (output: { size?: number }) => output.size || 0;

const isWorkflowDisposedError = (error: unknown) => getErrorCode(error) === "WORKFLOW_DISPOSED";

const waitForNextUiPaint = () =>
  new Promise<void>((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(() => resolve(), 0);
  });

const resolveLocalStateUpdate = <T>(current: T, update: SetStateAction<T>): T =>
  typeof update === "function" ? (update as (current: T) => T)(current) : update;

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const getRequestedOutputName = (outputName: string): string | undefined => {
  const normalizedOutputName = outputName.trim();
  return normalizedOutputName || undefined;
};

const resolvePendingDownloadFileName = ({
  automaticOutputName,
  fallbackOutputName,
  preferAutomaticName,
  requestedOutputName,
  resultOutputName,
}: {
  automaticOutputName?: string;
  fallbackOutputName?: string;
  /** The result was named by a manual name that is now gone, so its file name is stale. */
  preferAutomaticName?: boolean;
  requestedOutputName?: string;
  resultOutputName?: string;
}) => {
  const normalizedRequestedOutputName = sanitizeTypedOutputName(requestedOutputName);
  const normalizedResultOutputName = resultOutputName ? getRequestedOutputName(resultOutputName) : undefined;
  if (normalizedRequestedOutputName)
    return withOutputExtension(normalizedRequestedOutputName, getLiteralFileNameExtension(normalizedResultOutputName));
  // The result's file name is stale when it came from a manual name that has
  // since been cleared; then the automatic name wins and the result only
  // supplies the real extension (.bin, .zip, ...).
  const automaticBaseName = sanitizeTypedOutputName(automaticOutputName) || sanitizeTypedOutputName(fallbackOutputName);
  if (preferAutomaticName && automaticBaseName) {
    return withOutputExtension(automaticBaseName, getLiteralFileNameExtension(normalizedResultOutputName));
  }
  return normalizedResultOutputName || automaticBaseName || "output";
};

const formatElapsedTiming = (elapsedMs: number | null) => {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  return formatTiming(createTiming(elapsedMs));
};

// Percentages computed against tiny inputs explode into noise (a 13 B input
// reads as 1415.4%), so the ratio is suppressed until the input is large
// enough for the percentage to mean something.
const MIN_COMPRESSION_RATIO_INPUT_BYTES = 100 * 1024;

const formatDownloadCompressionRatio = (inputBytes: number | null, outputBytes: number | null) => {
  if (
    !(
      typeof inputBytes === "number" &&
      inputBytes >= MIN_COMPRESSION_RATIO_INPUT_BYTES &&
      typeof outputBytes === "number" &&
      outputBytes >= 0
    )
  )
    return "";
  return formatPercentFixed((outputBytes / inputBytes) * 100);
};

export {
  formatDownloadCompressionRatio,
  formatElapsedTiming,
  getPublicOutputSize,
  getRequestedOutputName,
  isWorkflowDisposedError,
  resolveLocalStateUpdate,
  resolvePendingDownloadFileName,
  toError,
  waitForNextUiPaint,
};
