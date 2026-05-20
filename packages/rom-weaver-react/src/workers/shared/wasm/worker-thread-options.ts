import type { WorkerRequestData } from "../../protocol/worker-runtime-payloads.ts";

type ThreadInput = WorkerRequestData["threads"] | "auto" | false | "0" | "off" | 0;

const normalizeWorkerThreadCount = (threads: ThreadInput) => {
  if (threads === undefined || threads === null || threads === "" || threads === "auto") return null;
  if (threads === false || threads === 0 || threads === "0" || threads === "off") return 0;
  const parsed = parseInt(String(threads), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.min(64, parsed)) : null;
};

const createLoaderThreadOptions = (threads: ThreadInput) => {
  const normalizedThreads = normalizeWorkerThreadCount(threads);
  return normalizedThreads === null ? {} : { workerThreads: normalizedThreads };
};

export type { ThreadInput };
export { createLoaderThreadOptions, normalizeWorkerThreadCount };
