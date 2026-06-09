import { createTiming, formatTiming, type Timing } from "../lib/progress/timing.ts";
import type { JsonObject, JsonValue } from "../types/runtime.ts";

const TRAILING_ELLIPSIS_REGEX = /\.\.\.$/;
const THREAD_COUNT_LABEL_REGEX = /\b\d+\s+threads?\b/i;

type WorkflowScalar = string | number | boolean | null | undefined;
type WorkflowValue = JsonValue | undefined;
type WorkflowRecord = JsonObject;

type TimingLike = Partial<Timing>;

type ProgressViewModelOptions = {
  stage?: WorkflowScalar;
  label?: WorkflowScalar;
  fallbackLabel?: WorkflowScalar;
  percent?: string | number | null | undefined;
  visualPercent?: string | number | null | undefined;
  hasProgress?: boolean | null | undefined;
  loaded?: string | number | null | undefined;
  total?: string | number | null | undefined;
  timing?: TimingLike | number | null;
  timingText?: WorkflowScalar;
  separator?: WorkflowScalar;
};

type WorkflowPresentationEventOptions = ProgressViewModelOptions & {
  kind?: WorkflowScalar;
  flow?: WorkflowScalar;
  message?: WorkflowScalar;
  details?: WorkflowRecord | null;
};

type ProgressEventOptions = ProgressViewModelOptions & {
  details?: WorkflowValue;
};

type ContextualProgressLabelOptions = {
  label?: WorkflowScalar;
  fallbackLabel?: WorkflowScalar;
  formatLabel?: WorkflowScalar;
  threads?: string | number | null | undefined;
};

type CompressionProgressLabelOptions = ContextualProgressLabelOptions & {
  progress?: WorkflowValue | object | null;
};

type ValidationViewModelOptions = {
  severity?: WorkflowScalar;
  message?: WorkflowScalar;
  details?: WorkflowValue;
};

type StageTimingOptions = {
  stageOrder?: WorkflowValue;
  stageLabels?: WorkflowRecord | null;
};

type ResultViewModelOptions = {
  savedFiles?: WorkflowValue;
  outputFormat?: WorkflowScalar;
  compressionSummary?: WorkflowScalar;
  stageMs?: WorkflowRecord | null;
  successMessage?: WorkflowScalar;
};

type OutputSizeSummaryOptions = {
  inputCompressedBytes?: string | number | null | undefined;
  inputDecompressionTimeMs?: string | number | null | undefined;
  inputBytes?: string | number | null | undefined;
  patchCompressedBytes?: string | number | null | undefined;
  patchBytes?: string | number | null | undefined;
  rawBytes?: string | number | null | undefined;
  outputBytes?: string | number | null | undefined;
  showRatio?: boolean | WorkflowScalar;
};

type OutputSizeSummaryViewModel = {
  visible: boolean;
  inputCompressedBytes: number | null;
  inputDecompressionTimeMs: number | null;
  inputBytes: number | null;
  inputLabel: string;
  patchCompressedBytes: number | null;
  patchBytes: number | null;
  rawBytes: number | null;
  rawLabel: string;
  outputBytes: number | null;
  outputLabel: string;
  ratioText: string;
  changeText: string;
};

const isRecord = (value: WorkflowValue | object | null | undefined): value is WorkflowRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getScalarValue = (value: WorkflowValue): WorkflowScalar =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  value === null ||
  value === undefined
    ? value
    : undefined;

const getNumericValue = (value: WorkflowValue): string | number | null | undefined =>
  typeof value === "string" || typeof value === "number" || value === null || value === undefined ? value : undefined;

const normalizeByteCount = (value: string | number | null | undefined): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
};

const normalizeProgressPercent = (value: string | number | null | undefined): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeProgressDisplayPercent = (value: string | number | null | undefined): number | null => {
  const normalized = normalizeProgressPercent(value);
  if (normalized === null) return null;
  return Math.max(0, Math.min(100, Math.round(normalized)));
};

const clampProgressPercent = (value: string | number | null | undefined): number | null => {
  const normalized = normalizeProgressPercent(value);
  if (normalized === null) return null;
  return Math.max(0, Math.min(100, normalized));
};

const getProgressEventPercent = (event?: WorkflowValue | object | null): number | null => {
  const source = isRecord(event) ? event : {};
  const directPercent = normalizeProgressPercent(getNumericValue(source.percent));
  if (directPercent !== null) return directPercent;
  return null;
};

const getProgressEventVisualPercent = (event?: WorkflowValue | object | null): number | null => {
  const source = isRecord(event) ? event : {};
  const details = isRecord(source.details) ? source.details : {};
  const detailedPercent = clampProgressPercent(getNumericValue(details.visualPercent));
  if (detailedPercent !== null) return detailedPercent;
  const directVisualPercent = clampProgressPercent(getNumericValue(source.visualPercent));
  if (directVisualPercent !== null) return directVisualPercent;
  return clampProgressPercent(getNumericValue(source.percent));
};

const getRawProgressLabel = (progress: WorkflowValue | object | null, fallbackLabel: string): string => {
  if (isRecord(progress) && typeof progress.label === "string" && progress.label) return progress.label;
  if (isRecord(progress) && typeof progress.message === "string" && progress.message) return progress.message;
  return fallbackLabel;
};

const formatProgressMessage = ({
  label,
  percent,
  timingText,
  separator,
}: {
  label: WorkflowScalar;
  percent: number | null;
  timingText: string;
  separator: string;
}): string => {
  const normalizedLabel = String(label || "");
  if (percent === null) return normalizedLabel;
  const timingSegment = timingText ? `${separator}${timingText}` : "";
  return `${normalizedLabel}${timingSegment}${separator}${percent}%`;
};

const normalizeTimingInput = (timing: TimingLike | number): TimingLike => {
  if (typeof timing === "number") return createTiming(timing);
  return timing.elapsedMs === undefined ? createTiming(Number(timing)) : timing;
};

const createProgressViewModel = ({
  stage,
  label,
  fallbackLabel,
  percent,
  visualPercent,
  loaded,
  total,
  hasProgress: progressEnabled,
  timing,
  timingText,
  separator,
}: ProgressViewModelOptions = {}) => {
  const hasProgress =
    progressEnabled === false ? false : percent !== undefined || loaded !== undefined || total !== undefined;
  const percentSource = visualPercent ?? percent ?? getProgressEventPercent({ loaded, total });
  const normalizedPercent = hasProgress ? normalizeProgressDisplayPercent(percentSource) : null;
  const normalizedVisualPercent = hasProgress ? clampProgressPercent(percentSource) : null;
  const normalizedLabel = String(label || fallbackLabel || "");
  const normalizedSeparator = typeof separator === "string" ? separator : " ";
  const resolvedTimingText =
    typeof timingText === "string" && timingText
      ? timingText
      : (() => {
          if (timing) {
            return formatTiming(normalizeTimingInput(timing));
          }
          return "";
        })();
  let percentKey = "status";
  if (hasProgress) {
    percentKey = normalizedPercent === null ? "indeterminate" : String(Math.floor(normalizedPercent / 10) * 10);
  }
  return {
    dedupeKey: `${typeof stage === "string" ? stage : "progress"}:${normalizedLabel}:${percentKey}`,
    indeterminate: hasProgress && normalizedPercent === null,
    label: normalizedLabel,
    message: formatProgressMessage({
      label: normalizedLabel,
      percent: normalizedPercent,
      separator: normalizedSeparator,
      timingText: resolvedTimingText,
    }),
    percent: normalizedPercent,
    stage: typeof stage === "string" ? stage : "",
    timingText: resolvedTimingText,
    visualPercent: normalizedVisualPercent,
  };
};

const createProgressViewModelFromEvent = (
  event?: WorkflowValue | object | null,
  options: ProgressViewModelOptions = {},
) => {
  const source = isRecord(event) ? event : {};
  const hasEventProgress =
    source.hasProgress === false
      ? false
      : Object.hasOwn(source, "percent") || Object.hasOwn(source, "loaded") || Object.hasOwn(source, "total");
  const eventPercent = getProgressEventPercent(source);
  const eventVisualPercent = getProgressEventVisualPercent(source);
  return createProgressViewModel({
    fallbackLabel: options.fallbackLabel,
    hasProgress: source.hasProgress === false ? false : options.hasProgress,
    label: getScalarValue(source.label) || getScalarValue(source.message) || options.label,
    percent: hasEventProgress ? eventPercent : options.percent,
    separator: getScalarValue(source.separator) ?? options.separator,
    stage: getScalarValue(source.stage) ?? options.stage,
    timing: (source.timing as TimingLike | number | null | undefined) ?? options.timing,
    timingText: getScalarValue(source.timingText) ?? options.timingText,
    visualPercent: hasEventProgress ? eventVisualPercent : options.visualPercent,
  });
};

const createProgressEvent = ({
  stage,
  label,
  fallbackLabel,
  percent,
  loaded,
  total,
  timing,
  timingText,
  separator,
  details,
}: ProgressEventOptions = {}) => {
  const progress = createProgressViewModel({
    fallbackLabel,
    label,
    loaded,
    percent,
    separator,
    stage,
    timing,
    timingText,
    total,
  });
  return {
    details: details ?? null,
    indeterminate: progress.indeterminate,
    label: progress.label,
    message: progress.message,
    percent: progress.percent,
    stage: progress.stage,
    timingText: progress.timingText,
  };
};

const createWorkflowPresentationEvent = ({
  kind,
  flow,
  stage,
  label,
  fallbackLabel,
  percent,
  loaded,
  total,
  timing,
  timingText,
  separator,
  message,
  details,
}: WorkflowPresentationEventOptions = {}) => {
  const progress = createProgressViewModel({
    fallbackLabel,
    label,
    loaded,
    percent,
    separator,
    stage,
    timing,
    timingText,
    total,
  });
  return {
    details: {
      dedupeKey: progress.dedupeKey,
      indeterminate: progress.indeterminate,
      label: progress.label,
      timingText: progress.timingText,
      ...(details || {}),
    },
    flow: typeof flow === "string" ? flow : "patch",
    kind: typeof kind === "string" ? kind : "progress",
    message: typeof message === "string" && message ? message : progress.message,
    percent: progress.percent,
    stage: progress.stage,
  };
};

const normalizeProgressThreadCount = (threads: string | number | null | undefined): number | null => {
  const parsed = typeof threads === "number" ? threads : parseInt(String(threads || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
};

const formatProgressThreadCount = (threads: string | number | null | undefined): string => {
  const normalized = normalizeProgressThreadCount(threads);
  return normalized ? `${normalized} ${normalized === 1 ? "thread" : "threads"}` : "";
};

const getProgressEventThreadCount = (progress: WorkflowValue | object | null | undefined): string | number | null => {
  if (!isRecord(progress)) return null;
  const details = isRecord(progress.details) ? progress.details : {};
  const compression = isRecord(details.compression) ? details.compression : {};
  const extraction = isRecord(details.extraction) ? details.extraction : {};
  return (
    getNumericValue(progress.effective_threads) ??
    getNumericValue(progress.effectiveThreads) ??
    getNumericValue(details.effective_threads) ??
    getNumericValue(details.effectiveThreads) ??
    getNumericValue(compression.effective_threads) ??
    getNumericValue(compression.effectiveThreads) ??
    getNumericValue(extraction.effective_threads) ??
    getNumericValue(extraction.effectiveThreads) ??
    null
  );
};

const stripProgressEllipsis = (label: string): string =>
  String(label || "")
    .trim()
    .replace(TRAILING_ELLIPSIS_REGEX, "");

const hasProgressThreadLabel = (label: string): boolean => THREAD_COUNT_LABEL_REGEX.test(label);

const labelIncludesProgressFormat = (label: string, formatLabel: string): boolean => {
  const normalizedFormat = String(formatLabel || "")
    .trim()
    .toLowerCase();
  return !normalizedFormat || normalizedFormat === "archive" || label.toLowerCase().includes(normalizedFormat);
};

const createThreadedProgressLabel = (label: WorkflowScalar, threads?: string | number | null | undefined): string => {
  const rawLabel = String(label || "").trim();
  const normalizedLabel = stripProgressEllipsis(rawLabel);
  if (hasProgressThreadLabel(normalizedLabel))
    return TRAILING_ELLIPSIS_REGEX.test(rawLabel) ? `${normalizedLabel}...` : normalizedLabel;
  const threadLabel = formatProgressThreadCount(threads);
  return `${normalizedLabel}${threadLabel ? ` - ${threadLabel}` : ""}...`;
};

const createContextualProgressLabel = ({
  label,
  fallbackLabel,
  formatLabel,
  threads,
}: ContextualProgressLabelOptions = {}): string => {
  const rawLabel = String(label || "").trim();
  const normalizedLabel = stripProgressEllipsis(rawLabel || String(fallbackLabel || ""));
  const normalizedFormatLabel = String(formatLabel || "");
  const contextualLabel = labelIncludesProgressFormat(normalizedLabel, normalizedFormatLabel)
    ? normalizedLabel
    : `${normalizedLabel} ${normalizedFormatLabel}`.trim();
  if (hasProgressThreadLabel(contextualLabel) && TRAILING_ELLIPSIS_REGEX.test(rawLabel)) return `${contextualLabel}...`;
  return createThreadedProgressLabel(contextualLabel, threads);
};

const createCompressionProgressLabel = (options: ContextualProgressLabelOptions = {}): string => {
  const formatLabel = String(options.formatLabel || "");
  const rawLabel = String(options.label || "").trim();
  const fallbackLabel = String(options.fallbackLabel || `Compressing to${formatLabel ? ` ${formatLabel}` : ""}`);
  const normalizedLabel = stripProgressEllipsis(rawLabel || fallbackLabel);
  const contextualLabel = labelIncludesProgressFormat(normalizedLabel, formatLabel)
    ? normalizedLabel
    : `${normalizedLabel} ${formatLabel}`.trim();
  if (hasProgressThreadLabel(contextualLabel)) return contextualLabel;
  const threadLabel = formatProgressThreadCount(options.threads);
  return `${contextualLabel}${threadLabel ? ` - ${threadLabel}` : ""}`;
};

const getCompressedBytesWritten = (progress: WorkflowValue | object | null | undefined): number | null => {
  if (!isRecord(progress)) return null;
  const details = isRecord(progress.details) ? progress.details : {};
  const value = details.compressedBytesWritten;
  return typeof value === "number" || typeof value === "string" ? normalizeByteCount(value) : null;
};

const isCompressionWriteTelemetryProgress = (progress: WorkflowValue | object | null | undefined): boolean => {
  if (!isRecord(progress)) return false;
  return (
    progress.stage === "write" &&
    getCompressedBytesWritten(progress) !== null &&
    getProgressEventPercent(progress) === null
  );
};

const formatByteSize = (value: string | number | null | undefined): string => {
  const bytes = normalizeByteCount(value);
  if (bytes === null) return "";
  const unitBase = 1000;
  if (bytes < unitBase) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let normalizedValue = bytes / unitBase;
  let unitIndex = 0;
  while (normalizedValue >= unitBase && unitIndex < units.length - 1) {
    normalizedValue /= unitBase;
    unitIndex++;
  }
  return `${normalizedValue.toFixed(1)} ${units[unitIndex]}`;
};

const createCompressionProgressLabelFromEvent = (options: CompressionProgressLabelOptions = {}): string => {
  const formatLabel = String(options.formatLabel || "");
  const compressedBytesWritten = getCompressedBytesWritten(options.progress);
  const writtenLabel = formatByteSize(compressedBytesWritten);
  const fallbackLabel = String(options.fallbackLabel || `Compressing to${formatLabel ? ` ${formatLabel}` : ""}`);
  const label =
    writtenLabel && !isCompressionWriteTelemetryProgress(options.progress)
      ? `Compressing to${formatLabel ? ` ${formatLabel}` : ""} - wrote ${writtenLabel}`
      : getRawProgressLabel(options.progress || null, String(options.label || ""));
  return createCompressionProgressLabel({
    fallbackLabel,
    formatLabel,
    label,
    threads: getProgressEventThreadCount(options.progress) ?? options.threads,
  });
};

const formatPercentFixed = (value: string | number | null | undefined, digits = 1): string => {
  const normalized = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(normalized)) return "";
  return `${normalized.toFixed(digits)}%`;
};

const createOutputSizeSummary = ({
  inputCompressedBytes,
  inputDecompressionTimeMs,
  inputBytes,
  patchCompressedBytes,
  patchBytes,
  rawBytes,
  outputBytes,
  showRatio,
}: OutputSizeSummaryOptions = {}): OutputSizeSummaryViewModel => {
  const normalizedInputCompressedBytes = normalizeByteCount(inputCompressedBytes);
  const normalizedInputDecompressionTimeMs = normalizeByteCount(inputDecompressionTimeMs);
  const normalizedInputBytes = normalizeByteCount(inputBytes);
  const normalizedPatchCompressedBytes = normalizeByteCount(patchCompressedBytes);
  const normalizedPatchBytes = normalizeByteCount(patchBytes);
  const normalizedRawBytes = normalizeByteCount(rawBytes);
  const normalizedOutputBytes = normalizeByteCount(outputBytes);
  const showRatioByDefault =
    showRatio === undefined
      ? normalizedRawBytes !== null && normalizedOutputBytes !== null && normalizedRawBytes !== normalizedOutputBytes
      : !!showRatio;
  const ratio =
    showRatioByDefault && normalizedRawBytes && normalizedOutputBytes !== null
      ? (normalizedOutputBytes / normalizedRawBytes) * 100
      : null;
  const change =
    showRatioByDefault && ratio !== null
      ? {
          delta: Math.abs(100 - ratio),
          direction: ratio > 100 ? "larger" : "smaller",
        }
      : null;
  return {
    changeText: change ? `${formatPercentFixed(change.delta)} ${change.direction}` : "",
    inputBytes: normalizedInputBytes,
    inputCompressedBytes: normalizedInputCompressedBytes,
    inputDecompressionTimeMs: normalizedInputDecompressionTimeMs,
    inputLabel: formatByteSize(normalizedInputBytes),
    outputBytes: normalizedOutputBytes,
    outputLabel: formatByteSize(normalizedOutputBytes),
    patchBytes: normalizedPatchBytes,
    patchCompressedBytes: normalizedPatchCompressedBytes,
    ratioText: ratio === null ? "" : `${formatPercentFixed(ratio)} of raw`,
    rawBytes: normalizedRawBytes,
    rawLabel: formatByteSize(normalizedRawBytes),
    visible:
      normalizedInputCompressedBytes !== null ||
      normalizedInputBytes !== null ||
      normalizedPatchCompressedBytes !== null ||
      normalizedPatchBytes !== null ||
      normalizedRawBytes !== null ||
      normalizedOutputBytes !== null,
  };
};

const createValidationViewModel = ({ severity, message, details }: ValidationViewModelOptions = {}) => ({
  details: details || null,
  message: String(message || ""),
  severity: typeof severity === "string" && severity ? severity : "error",
});

const formatStageTimingSummary = (stageMs: WorkflowRecord | null | undefined, options: StageTimingOptions = {}) => {
  const normalized = stageMs || {};
  const stageOrder = Array.isArray(options.stageOrder)
    ? options.stageOrder.map(String)
    : ["decompress", "apply", "compress"];
  const stageLabels = options.stageLabels || {};
  return stageOrder.reduce<
    Array<{ stage: string; label: string; timing: ReturnType<typeof createTiming>; message: string }>
  >((entries, stageName) => {
    const elapsedMs = normalized[stageName];
    if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return entries;
    const stageLabel = typeof stageLabels[stageName] === "string" ? stageLabels[stageName] : stageName;
    entries.push({
      label: stageLabel,
      message: `${stageLabel} completed in ${formatTiming(createTiming(elapsedMs))}`,
      stage: stageName,
      timing: createTiming(elapsedMs),
    });
    return entries;
  }, []);
};

const createResultViewModel = ({
  savedFiles,
  outputFormat,
  compressionSummary,
  stageMs,
  successMessage,
}: ResultViewModelOptions = {}) => {
  const fileList = Array.isArray(savedFiles)
    ? savedFiles.filter(Boolean).map(String)
    : (() => {
        if (savedFiles) {
          return [String(savedFiles)];
        }
        return [];
      })();
  const timingEntries = formatStageTimingSummary(stageMs);
  return {
    compressionSummary: typeof compressionSummary === "string" ? compressionSummary : "",
    message:
      typeof successMessage === "string" && successMessage
        ? successMessage
        : `successfully saved to ${fileList.join(", ")}`,
    outputFormat: typeof outputFormat === "string" ? outputFormat : "",
    savedFiles: fileList,
    timingEntries: timingEntries,
    timingSummary: timingEntries.map((entry) => entry.message).join("\n"),
  };
};

export {
  clampProgressPercent,
  createCompressionProgressLabel,
  createCompressionProgressLabelFromEvent,
  createContextualProgressLabel,
  createOutputSizeSummary,
  createProgressEvent,
  createProgressViewModel,
  createProgressViewModelFromEvent,
  createResultViewModel,
  createThreadedProgressLabel,
  createValidationViewModel,
  createWorkflowPresentationEvent,
  formatByteSize,
  formatPercentFixed,
  formatProgressThreadCount,
  formatStageTimingSummary,
  getProgressEventPercent,
  getProgressEventVisualPercent,
  getRawProgressLabel,
  isCompressionWriteTelemetryProgress,
  normalizeByteCount,
  normalizeProgressDisplayPercent,
  normalizeProgressPercent,
};

type ProgressViewModel = ReturnType<typeof createProgressViewModel>;

export type { OutputSizeSummaryViewModel, ProgressViewModel };
