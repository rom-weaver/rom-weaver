type Timing = {
  elapsedMs: number;
  elapsedSeconds: number;
};

const createTiming = (elapsedMs: number): Timing => {
  const normalizedMs = Math.max(0, elapsedMs);
  return {
    elapsedMs: Math.round(normalizedMs),
    elapsedSeconds: Number((normalizedMs / 1000).toFixed(3)),
  };
};

const formatTiming = (timing: Partial<Timing> | null | undefined): string => {
  if (!timing || typeof timing.elapsedMs !== "number" || !Number.isFinite(timing.elapsedMs)) return "";
  const elapsedMs = Math.max(0, Math.round(timing.elapsedMs));
  const elapsedSeconds =
    typeof timing.elapsedSeconds === "number" && Number.isFinite(timing.elapsedSeconds)
      ? Math.max(0, timing.elapsedSeconds)
      : elapsedMs / 1000;
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  if (elapsedSeconds < 10) return `${elapsedSeconds.toFixed(2)}s`;
  if (elapsedSeconds < 60) return `${elapsedSeconds.toFixed(1)}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds - minutes * 60;
  return `${minutes}m ${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
};

export { createTiming, formatTiming, type Timing };
