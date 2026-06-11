import type { SetStateAction } from "react";
import { getFileNameExtension as getSharedFileNameExtension, hasFileNameExtension } from "../../lib/path-utils.ts";
import { createTiming, formatTiming } from "../../lib/progress/timing.ts";
import { getErrorCode } from "../../presentation/errors.ts";
import { formatPercentFixed } from "../../presentation/workflow-presentation.ts";
import type { RomInputRowState } from "./patcher-ui-state.ts";

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

const getFileNameExtension = (fileName: string | null | undefined) =>
  getSharedFileNameExtension(fileName, { includeDot: true });

const resolvePendingDownloadFileName = ({
  automaticOutputName,
  fallbackOutputName,
  requestedOutputName,
  resultOutputName,
}: {
  automaticOutputName?: string;
  fallbackOutputName?: string;
  requestedOutputName?: string;
  resultOutputName?: string;
}) => {
  const normalizedRequestedOutputName = requestedOutputName ? getRequestedOutputName(requestedOutputName) : undefined;
  const normalizedResultOutputName = resultOutputName ? getRequestedOutputName(resultOutputName) : undefined;
  if (normalizedRequestedOutputName) {
    if (hasFileNameExtension(normalizedRequestedOutputName)) return normalizedRequestedOutputName;
    const resultExtension = getFileNameExtension(normalizedResultOutputName);
    return resultExtension ? `${normalizedRequestedOutputName}${resultExtension}` : normalizedRequestedOutputName;
  }
  return (
    normalizedResultOutputName ||
    (automaticOutputName ? getRequestedOutputName(automaticOutputName) : undefined) ||
    (fallbackOutputName ? getRequestedOutputName(fallbackOutputName) : undefined) ||
    "output"
  );
};

const getLogicalRomInputCount = (rows: RomInputRowState[]) => {
  const groupIds = new Set<string>();
  let ungroupedCount = 0;
  for (const row of rows) {
    const groupId = String(row.groupId || "").trim();
    if (groupId) groupIds.add(groupId);
    else ungroupedCount += 1;
  }
  return groupIds.size + ungroupedCount;
};

const getMultiInputOutputError = (compression: string, logicalInputCount: number) => {
  if (logicalInputCount <= 1) return "";
  if (compression === "7z" || compression === "zip") return "";
  if (compression === "none") {
    return "output.compression: 'none' cannot be used for multi-file output; use output.compression: 'zip' with zipCodec: 'store'";
  }
  return `output.compression: '${compression}' cannot be used for multi-file output; use output.compression: 'zip' or '7z'`;
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
  getLogicalRomInputCount,
  getMultiInputOutputError,
  getPublicOutputSize,
  getRequestedOutputName,
  isWorkflowDisposedError,
  resolveLocalStateUpdate,
  resolvePendingDownloadFileName,
  toError,
  waitForNextUiPaint,
};
