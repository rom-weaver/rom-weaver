import type { OfflineReadyState } from "../offline-warmup.ts";

const createOfflineProgressReporter = <T extends OfflineReadyState>(
  read: () => Promise<T>,
  report: (progress: T) => void | Promise<void>,
  onError: (error: unknown) => void,
) => {
  let pending = false;
  let forceNext = false;
  let running: Promise<void> | null = null;
  let previousPercent: number | null | undefined;
  // Chunk notifications MUST share one pending read so cache work cannot build a backlog.
  const update = (force = false): Promise<void> => {
    pending = true;
    forceNext ||= force;
    if (running) return running;
    running = (async () => {
      while (pending) {
        pending = false;
        const forced = forceNext;
        forceNext = false;
        const progress = await read();
        const total = progress.totalBytes || progress.totalFiles;
        const loaded = progress.totalBytes ? progress.cachedBytes : progress.cachedFiles;
        const percent = total > 0 ? Math.min(99, Math.floor((loaded / total) * 100)) : null;
        if (!forced && percent === previousPercent) continue;
        previousPercent = percent;
        await report(progress);
      }
    })()
      .catch(onError)
      .finally(() => {
        running = null;
        if (pending) return update();
        return undefined;
      });
    return running;
  };
  return { update, flush: () => running ?? Promise.resolve() };
};

export { createOfflineProgressReporter };
