import { createProgressEvent } from "../../presentation/workflow-presentation.ts";
import type {
  ApplyWorkflowOptions,
  CompressionWorkflowOptions,
  CreateWorkflowOptions,
  ProgressEvent,
} from "../../types/workflow-runtime-types.ts";
import { createLogger } from "../logging.ts";

const logger = createLogger("workflow:progress");
// Bounded LRU of the last-logged value per `stage:label`. Labels embed per-file/per-op names, so a
// long-lived page produces an unbounded stream of distinct keys; without a cap this Map would grow
// for the page lifetime. Capping it keeps recent dedupe behavior while bounding memory - an evicted
// key simply re-logs once the next time it appears.
const PROGRESS_LOG_DEDUPE_CAP = 256;
const progressLogState = new Map<string, number | string>();

const rememberProgressDedupe = (key: string, value: number | string) => {
  // Delete-then-set marks the key most-recently-used (Map preserves insertion order).
  progressLogState.delete(key);
  progressLogState.set(key, value);
  while (progressLogState.size > PROGRESS_LOG_DEDUPE_CAP) {
    const oldest = progressLogState.keys().next().value;
    if (oldest === undefined) break;
    progressLogState.delete(oldest);
  }
};

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
  rememberProgressDedupe(key, dedupeValue);
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

export { reportProgress };
