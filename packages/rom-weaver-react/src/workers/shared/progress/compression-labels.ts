import type { WorkerRequestData } from "../../protocol/worker-runtime-payloads.ts";
import { normalizeWorkerThreadCount } from "../wasm/worker-thread-options.ts";

type ThreadInput = WorkerRequestData["threads"] | "auto" | false | "0" | "off" | 0;

const getThreadLabel = (threads: ThreadInput) => {
  const normalizedThreads = normalizeWorkerThreadCount(threads);
  if (!normalizedThreads) return "";
  return ` - ${normalizedThreads} ${normalizedThreads === 1 ? "thread" : "threads"}`;
};

const formatCompressionOperationLabel = (label: string, threads: ThreadInput) =>
  `${label}${getThreadLabel(threads)}...`;

export { formatCompressionOperationLabel };
