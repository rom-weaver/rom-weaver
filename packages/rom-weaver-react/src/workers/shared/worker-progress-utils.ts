import type { JsonValue } from "../../types/runtime.ts";
import { createCoveredByteRangeTracker, mapBytesToPercentRange } from "./wasm-tool-runtime-utils.ts";
import { postCloneSafeWorkerMessage } from "./worker-message-utils.ts";

type WorkerProgressValue = JsonValue | object | undefined;

const postProgress = (requestId: string | number, progress: WorkerProgressValue) => {
  const workerKind = (self as typeof globalThis & { __romWeaverWorkerKind?: string }).__romWeaverWorkerKind;
  postCloneSafeWorkerMessage(self, {
    action: "progress",
    progress,
    requestId,
    type: "progress",
    ...(workerKind ? { workerKind } : {}),
  });
};

const createProgressCallback = (requestId: string | number) => (progress: WorkerProgressValue) =>
  postProgress(requestId, progress);

const createRangeProgressCallback = (
  label: string,
  totalSize: number,
  startPercent: number,
  endPercent: number,
  progressCallback: (progress: { label: string; percent: number }) => void,
) => {
  let lastPercent = -1;
  let lastPostedAt = 0;
  const start = typeof startPercent === "number" ? startPercent : 0;
  const end = typeof endPercent === "number" ? endPercent : 100;
  const coveredRangeTracker = createCoveredByteRangeTracker(totalSize);
  const total = coveredRangeTracker.getTotal();

  return (rangeStart: number, rangeEnd: number) => {
    const coveredBytes = coveredRangeTracker.add(rangeStart, rangeEnd);
    if (coveredBytes === null) return;
    const percent = mapBytesToPercentRange(coveredBytes, total, start, end);
    const roundedPercent = Math.floor(percent);
    const now = Date.now();
    if (roundedPercent > lastPercent || now - lastPostedAt > 500) {
      lastPercent = roundedPercent;
      lastPostedAt = now;
      progressCallback({
        label,
        percent,
      });
    }
  };
};

const createPercentRangeProgressCallback = (
  label: string,
  startPercent: number | string | null | undefined,
  endPercent: number | string | null | undefined,
  progressCallback: (progress: { label: string; percent: number }) => void,
) => {
  let lastPercent = -1;
  const start = typeof startPercent === "number" ? startPercent : 0;
  const end = typeof endPercent === "number" ? endPercent : 100;
  return (percent: number | string | null | undefined) => {
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    const normalizedPercent = Math.max(0, Math.min(100, percent));
    const mappedPercent = Math.max(start, Math.min(end, start + (end - start) * (normalizedPercent / 100)));
    if (mappedPercent <= lastPercent) return;
    lastPercent = mappedPercent;
    progressCallback({ label, percent: mappedPercent });
  };
};

type MonotonicProgressEvent = {
  label?: RuntimeValue;
  aliases?: RuntimeValue;
  normalizedLabel?: RuntimeValue;
  percent?: RuntimeValue;
  [key: string]: RuntimeValue;
};

const normalizeProgressLabel = (label: RuntimeValue) =>
  String(label || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

const matchesProgressLabels = (progress: MonotonicProgressEvent, labels: string[]) => {
  const progressLabels = [
    normalizeProgressLabel(progress.normalizedLabel),
    normalizeProgressLabel(progress.label),
    ...(Array.isArray(progress.aliases) ? progress.aliases.map((label) => normalizeProgressLabel(label)) : []),
  ].filter(Boolean);
  return labels.map((label) => normalizeProgressLabel(label)).some((label) => progressLabels.indexOf(label) !== -1);
};

const createMonotonicProgressCallback = (
  operationLabel: string,
  aliasLabels: string[],
  progressCallback: (progress: MonotonicProgressEvent) => void,
) => {
  let lastPercent = -1;
  const progressLabels = [operationLabel].concat(aliasLabels || []);
  return (progress: MonotonicProgressEvent) => {
    if (progress && matchesProgressLabels(progress, progressLabels)) {
      const normalizedProgress = {
        label: operationLabel,
        percent: progress.percent,
        ...(Array.isArray(progress.aliases) ? { aliases: progress.aliases } : {}),
        ...(typeof progress.normalizedLabel === "string" ? { normalizedLabel: progress.normalizedLabel } : {}),
      };
      if (typeof normalizedProgress.percent === "number") {
        if (normalizedProgress.percent < lastPercent) return;
        lastPercent = normalizedProgress.percent;
      } else if (normalizedProgress.percent === null && lastPercent >= 0) {
        normalizedProgress.percent = lastPercent;
      }
      progressCallback(normalizedProgress);
      return;
    }
    progressCallback(progress);
  };
};

export {
  createMonotonicProgressCallback,
  createPercentRangeProgressCallback,
  createProgressCallback,
  createRangeProgressCallback,
  matchesProgressLabels,
};
