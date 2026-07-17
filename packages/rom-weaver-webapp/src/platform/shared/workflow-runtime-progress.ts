import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { JsonValue, ProgressEvent } from "../../types/workflow-runtime-types.ts";

type JsonRecord = { [key: string]: JsonValue | undefined };

type RuntimeProgress = {
  details?: JsonValue;
  label?: string;
  message?: string;
  percent?: number | null;
  stage?: string;
};

const isRecord = (value: JsonValue | object | null | undefined): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);

/* Rust stage labels name the FORMAT, never the file ("extracting rvz (18%)",
   "creating `7z` (3/10)"). When the call site knows the file, swap the generic
   stem for the contextual label and keep the parenthetical progress detail. */
const GENERIC_STAGE_LABEL =
  /^(extracting|creating|compressing|converting|decompressing|reading)\s+`?[\w.-]+`?\s*(\((?:\d{1,3}\s*%|\d+\/\d+)\))?$/i;

const contextualizeRuntimeLabel = (label: string | undefined, contextualLabel: string | undefined) => {
  if (!label) return contextualLabel;
  if (!contextualLabel) return label;
  const generic = label.trim().match(GENERIC_STAGE_LABEL);
  if (!generic) return label;
  const detail = generic[2];
  if (!detail) return contextualLabel;
  return `${contextualLabel.replace(/\.{3}$/, "")} ${detail}`;
};

const forwardCreatePatchProgress =
  (onProgress?: Parameters<NonNullable<WorkflowRuntime["patch"]["createPatch"]>>[0]["onProgress"]) =>
  (progress: RuntimeProgress) => {
    onProgress?.({
      ...progress,
    });
  };

const forwardRomSpecificProgress = (
  stage: "input" | "output",
  onProgress?: (progress: ProgressEvent) => void,
  /** Contextual fallback (e.g. "Extracting game.rvz...") shown when the runtime event carries no label. */
  fallbackLabel?: string,
) => {
  if (!onProgress) return undefined;
  return (progress: RuntimeProgress) => {
    const label =
      contextualizeRuntimeLabel(progress.label, fallbackLabel) ||
      (stage === "input" ? "Extracting disc image..." : "Creating disc image...");
    if (typeof progress.percent !== "number" || !Number.isFinite(progress.percent)) {
      onProgress({
        ...progress,
        label,
        percent: null,
        stage,
      });
      return;
    }
    const percent = Math.max(0, Math.min(100, progress.percent));
    onProgress({
      ...progress,
      label,
      percent,
      stage,
    });
  };
};

const forwardArchiveProgress = (
  stage: "input" | "output",
  onProgress?: (progress: ProgressEvent) => void,
  /** Contextual fallback (e.g. "Extracting game.zip...") shown when the runtime event carries no label. */
  fallbackLabel?: string,
) => {
  let sawIntermediate = false;
  return (progress: RuntimeProgress) => {
    const label =
      contextualizeRuntimeLabel(progress.label, fallbackLabel) ||
      (stage === "input" ? "Extracting archive entry..." : "Creating archive...");
    const details = isRecord(progress.details)
      ? {
          ...progress.details,
          ...(progress.stage ? { runtimeStage: progress.stage } : {}),
        }
      : progress.details;
    const emit = (percent: number | null) => {
      onProgress?.({
        ...progress,
        details,
        label,
        percent,
        stage,
      });
    };
    if (typeof progress.percent !== "number" || !Number.isFinite(progress.percent)) {
      emit(null);
      return;
    }
    const percent = Math.max(0, Math.min(100, progress.percent));
    if (percent > 0 && percent < 100) sawIntermediate = true;
    if (percent >= 100 && !sawIntermediate) {
      emit(null);
      return;
    }
    if (percent <= 0 && !sawIntermediate) {
      emit(null);
      return;
    }
    emit(percent);
  };
};

export { contextualizeRuntimeLabel, forwardArchiveProgress, forwardCreatePatchProgress, forwardRomSpecificProgress };
