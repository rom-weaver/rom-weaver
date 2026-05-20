import {
  createProgressEvent,
  getProgressEventPercent,
  getRawProgressLabel,
  normalizeProgressPercent,
} from "../../presentation/workflow-presentation.ts";
import type { JsonObject, JsonValue, ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type {
  ApplyWorkflowOptions,
  CompressionWorkflowOptions,
  CreateWorkflowOptions,
  ProgressEvent,
} from "../../types/workflow-runtime.ts";
import { createLogger } from "../logging.ts";

const isRecord = (value: JsonValue | object | null | undefined): value is JsonObject =>
  !!value && typeof value === "object" && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer);

const logger = createLogger("workflow:progress");
const progressLogState = new Map<string, number | string>();
const getProgressLogLevel = (options: ProgressOptions) => {
  if (!options) return undefined;
  if ("logLevel" in options) return options.logLevel;
  if ("logging" in options) return options.logging?.level;
  return undefined;
};

const logProgressEvent = (options: ProgressOptions, event: ProgressEvent) => {
  const percent =
    typeof event.percent === "number" && Number.isFinite(event.percent) ? Math.floor(event.percent) : null;
  const key = `${event.stage}:${event.label}`;
  const dedupeValue = percent === null ? "indeterminate" : percent;
  if (progressLogState.get(key) === dedupeValue) return;
  progressLogState.set(key, dedupeValue);
  logger.debug(
    "Progress",
    {
      label: event.label,
      percent,
      stage: event.stage,
    },
    { level: getProgressLogLevel(options) },
  );
};

const normalizeApplyProgressInput = (
  progress: SharedProgressEvent | JsonValue | object | null | undefined,
  total?: string | number | null | undefined,
) => {
  if (isRecord(progress)) {
    return {
      details: progress as JsonValue,
      label: getRawProgressLabel(progress, "Applying patch..."),
      percent: getProgressEventPercent(progress),
    };
  }

  const loadedValue =
    typeof progress === "string" || typeof progress === "number" || progress === null || progress === undefined
      ? normalizeProgressPercent(progress)
      : null;
  const totalValue = normalizeProgressPercent(total);
  return {
    details: undefined,
    label: "Applying patch...",
    percent:
      loadedValue !== null && totalValue !== null && totalValue > 0
        ? Math.max(0, Math.min(100, (loadedValue / totalValue) * 100))
        : null,
  };
};

type ProgressOptions = ApplyWorkflowOptions | CreateWorkflowOptions | CompressionWorkflowOptions | undefined;

const reportPublicProgress = (options: ProgressOptions, event: ProgressEvent) => {
  logProgressEvent(options, event);
  if (typeof options?.onProgress !== "function") return;
  const progress = createProgressEvent(event);
  options.onProgress({
    details: event.details,
    indeterminate: progress.indeterminate,
    label: progress.label,
    message: progress.message,
    percent: progress.percent,
    stage: (progress.stage || event.stage) as ProgressEvent["stage"],
    timingText: progress.timingText,
  });
};

const reportProgress = (options: ApplyWorkflowOptions | CreateWorkflowOptions | undefined, event: ProgressEvent) =>
  reportPublicProgress(options, event);

const reportCompressionProgress = (options: CompressionWorkflowOptions | undefined, event: ProgressEvent) =>
  reportPublicProgress(options, event);

export { normalizeApplyProgressInput, reportCompressionProgress, reportProgress };
