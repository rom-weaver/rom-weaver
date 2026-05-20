import type { CompressionWorkerRequest } from "../protocol/worker-protocol.ts";
import type { WorkerRequestData } from "../protocol/worker-runtime-payloads.ts";
import {
  attachCompressionWorker,
  type CompressionWorkerKindHandlers,
  completeCompressionOperation,
} from "../shared/rpc/compression-worker-dispatcher.ts";
import { workerScope } from "../shared/worker-compression-types.ts";
import {
  CompressionArchiveCapabilities,
  postCreateResult,
  postExtractResult,
  runCleanup,
  runCreate,
  runExtract,
  runList,
} from "./archive-worker-actions.ts";

const configureArchiveThreads = (data: WorkerRequestData) => {
  if (data.threads !== undefined && typeof CompressionArchiveCapabilities.configure === "function")
    CompressionArchiveCapabilities.configure({ threads: data.threads });
};

const handlers: CompressionWorkerKindHandlers = {
  cleanup: async (data) => {
    await runCleanup(data as CompressionWorkerRequest);
    completeCompressionOperation("7zip-zstd", data, "cleanup");
  },
  create: async (data) => {
    configureArchiveThreads(data);
    const result = await runCreate(data as CompressionWorkerRequest, workerScope as never);
    await postCreateResult(workerScope as never, data.requestId, result);
  },
  extract: async (data) => {
    configureArchiveThreads(data);
    const result = await runExtract(data as CompressionWorkerRequest, workerScope as never);
    await postExtractResult(workerScope as never, data.requestId, result);
  },
  list: async (data) => {
    configureArchiveThreads(data);
    completeCompressionOperation("7zip-zstd", data, "list", {
      entries: await runList(data as CompressionWorkerRequest, workerScope as never),
    });
  },
  warmup: async (data) => {
    configureArchiveThreads(data);
    await CompressionArchiveCapabilities.warmup();
    completeCompressionOperation("7zip-zstd", data, "warmup");
  },
};

attachCompressionWorker({ handlers, kind: "7zip-zstd" });
