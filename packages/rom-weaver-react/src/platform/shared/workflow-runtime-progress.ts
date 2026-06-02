import type { ProgressEvent } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";

type RuntimeProgress = {
  label?: string;
  message?: string;
  percent?: number | null;
};

const forwardCreatePatchProgress =
  (onProgress?: Parameters<NonNullable<WorkflowRuntime["patch"]["createPatch"]>>[0]["onProgress"]) =>
  (progress: RuntimeProgress) => {
    onProgress?.({
      ...progress,
    });
  };

const forwardDiscProgress = (stage: "input" | "output", onProgress?: (progress: ProgressEvent) => void) => {
  if (!onProgress) return undefined;
  let lastPercent = -1;
  let sawIntermediate = false;
  return (progress: RuntimeProgress) => {
    const label = progress.label || (stage === "input" ? "Extracting disc image..." : "Creating disc image...");
    const emit = (percent: number | null) => {
      onProgress({
        ...progress,
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
      emit(lastPercent > 0 ? Math.min(99, Math.max(lastPercent + 1, 50)) : 50);
      sawIntermediate = true;
    }
    lastPercent = percent;
    emit(percent);
  };
};

const forwardArchiveProgress = (stage: "input" | "output", onProgress?: (progress: ProgressEvent) => void) => {
  let sawIntermediate = false;
  return (progress: { label?: string; percent?: number | null }) => {
    const label = progress.label || (stage === "input" ? "Extracting archive entry..." : "Creating archive...");
    const emit = (percent: number | null) => {
      onProgress?.({
        ...progress,
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
    if (percent <= 0 && !sawIntermediate) {
      emit(null);
      return;
    }
    emit(percent);
  };
};

export { forwardArchiveProgress, forwardCreatePatchProgress, forwardDiscProgress };
