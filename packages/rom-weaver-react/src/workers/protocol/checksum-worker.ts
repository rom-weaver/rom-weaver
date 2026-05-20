import { createLogger } from "../../lib/logging.ts";
import type { WorkflowErrorCode } from "../../types/errors.ts";
import type { LogRecord } from "../../types/logging.ts";
import type { WorkerTransport } from "../../types/worker-messages.ts";
import { createChecksumWorkerInstance } from "./worker-factories.ts";
import type {
  BrowserChecksumResult,
  ChecksumCompleteResponse,
  ChecksumErrorResponse,
  ChecksumWorkerRequest,
  WorkerFatalMessage,
  WorkerProgressMessage,
  WorkerReadyMessage,
  WorkerSuccessMessage,
} from "./worker-protocol.ts";
import { createWorkerRpcClient } from "./worker-rpc.ts";

type ChecksumStreamAction = "checksum-stream-chunk" | "checksum-stream-start";
type ChecksumStreamAckMessage = WorkerSuccessMessage<ChecksumStreamAction, { workerKind: "patch-checksum" }>;
type ChecksumWarmupCompleteMessage = WorkerSuccessMessage<"warmup-complete", { workerKind: "patch-checksum" }>;
type ChecksumWarmupErrorMessage = {
  action: "warmup-complete";
  error: { code?: WorkflowErrorCode; details?: Record<string, unknown>; message: string };
  requestId?: string;
  success: false;
  type: "error";
  workerKind: "patch-checksum";
};
type ChecksumWorkerLogMessage = {
  action: "log";
  log: LogRecord;
  requestId?: string;
  type: "log";
  workerKind: "patch-checksum";
};
type ChecksumLogCallback = (record: LogRecord) => void;

type ChecksumWorkerMessage =
  | ChecksumCompleteResponse
  | ChecksumErrorResponse
  | ChecksumWorkerLogMessage
  | ChecksumStreamAckMessage
  | ChecksumWarmupCompleteMessage
  | ChecksumWarmupErrorMessage
  | WorkerFatalMessage
  | WorkerProgressMessage<{ label: string; percent: number }>
  | WorkerReadyMessage;

type BrowserChecksumInput = {
  checksumAlgorithms?: string[];
  checksumStartOffset?: number;
  file?: Blob;
  fileHandle?: FileSystemFileHandle;
  fileName?: string;
  filePath?: string;
  fileSize?: number;
  logLevel?: string;
  u8array?: Uint8Array;
};

type NodeChecksumInput = {
  checksumAlgorithms?: string[];
  checksumStartOffset?: number;
  fileName?: string;
  filePath?: string;
  fileSize?: number;
  logLevel?: string;
  u8array?: Uint8Array;
};

type BrowserChecksumStreamInput = {
  checksumAlgorithms?: string[];
  checksumStartOffset?: number;
  fileName?: string;
  logLevel?: string;
  readChunk: (offset: number, chunkLength: number) => Promise<Uint8Array> | Uint8Array;
  streamTotalBytes: number;
};

const DEFAULT_BROWSER_CHECKSUM_ALGORITHMS = ["crc32", "md5", "sha1"];
const BROWSER_CHECKSUM_STREAM_CHUNK_SIZE = 16 * 1024 * 1024;
const PARALLEL_BROWSER_CHECKSUM_MIN_BYTES = 64 * 1024 * 1024;
const checksumClientLogger = createLogger("runtime:checksum");

const isFatalMessage = (data: ChecksumWorkerMessage): data is WorkerFatalMessage => data.action === "fatal";
const isCompleteMessage = (data: ChecksumWorkerMessage): data is ChecksumCompleteResponse =>
  data.action === "checksum-complete";
const isChecksumStreamAckMessage = (data: ChecksumWorkerMessage): data is ChecksumStreamAckMessage =>
  data.action === "checksum-stream-start" || data.action === "checksum-stream-chunk";
const isChecksumStreamCompleteMessage = (data: ChecksumWorkerMessage): data is ChecksumCompleteResponse =>
  data.action === "checksum-stream-complete";
const isChecksumWarmupCompleteMessage = (
  data: ChecksumWorkerMessage,
): data is ChecksumWarmupCompleteMessage | ChecksumWarmupErrorMessage => data.action === "warmup-complete";
const isChecksumProgressMessage = (
  data: ChecksumWorkerMessage,
): data is WorkerProgressMessage<{ label: string; percent: number }> => data.action === "checksum-progress";
const isChecksumErrorMessage = (data: ChecksumWorkerMessage): data is ChecksumErrorResponse =>
  data.action === "checksum-error";
const isChecksumLogMessage = (data: ChecksumWorkerMessage): data is ChecksumWorkerLogMessage =>
  data.action === "log" || ("type" in data && data.type === "log");

const getBrowserChecksumInputSourceKind = (input: BrowserChecksumInput | NodeChecksumInput): string => {
  if ("fileHandle" in input && input.fileHandle) return "file-handle";
  if ("file" in input && input.file) return "blob";
  if (input.filePath) return "path";
  if (input.u8array instanceof Uint8Array) return "u8array";
  return "unknown";
};

const emitChecksumClientTrace = (
  input: BrowserChecksumInput | NodeChecksumInput,
  onLog: ChecksumLogCallback | undefined,
  message: string,
  details: Record<string, unknown> = {},
) => {
  if (input.logLevel !== "trace") return;
  const logDetails = {
    ...details,
    fileName: input.fileName,
    fileSize: input.fileSize,
    sourceKind: getBrowserChecksumInputSourceKind(input),
  };
  const record: LogRecord = {
    details: logDetails,
    level: "trace",
    message,
    namespace: "runtime:checksum",
    timestamp: new Date().toISOString(),
  };
  onLog?.(record);
  checksumClientLogger.trace(message, logDetails, { level: input.logLevel });
};

const emitForwardedChecksumLog = (record: LogRecord) => {
  const forwardedLogger = createLogger(record.namespace);
  switch (record.level) {
    case "debug":
      forwardedLogger.debug(record.message, record.details, { level: record.level });
      break;
    case "error":
      forwardedLogger.error(record.message, record.details, { level: record.level });
      break;
    case "info":
      forwardedLogger.info(record.message, record.details, { level: record.level });
      break;
    case "trace":
      forwardedLogger.trace(record.message, record.details, { level: record.level });
      break;
    case "warn":
      forwardedLogger.warn(record.message, record.details, { level: record.level });
      break;
  }
};

const forwardChecksumLog =
  (onLog?: ChecksumLogCallback) =>
  (data: ChecksumWorkerMessage): void => {
    if (!isChecksumLogMessage(data)) return;
    const record: LogRecord = {
      details: {
        ...(data.log.details || {}),
        requestId: data.requestId,
        workerKind: data.workerKind,
      },
      level: data.log.level,
      message: data.log.message,
      namespace: data.log.namespace,
      timestamp: data.log.timestamp,
    };
    onLog?.(record);
    emitForwardedChecksumLog(record);
  };

const toBrowserChecksumResult = (completeData: ChecksumCompleteResponse): BrowserChecksumResult => ({
  checksums: {
    adler32: completeData.adler32,
    crc16: completeData.crc16,
    crc32: completeData.crc32 || 0,
    md5: completeData.md5 || "",
    sha1: completeData.sha1 || "",
  } as BrowserChecksumResult["checksums"],
  rom: completeData.rom,
});

const mergeBrowserChecksumResults = (results: BrowserChecksumResult[]): BrowserChecksumResult => {
  const merged = {
    checksums: {
      crc32: 0,
      md5: "",
      sha1: "",
    } as BrowserChecksumResult["checksums"],
    rom: null as BrowserChecksumResult["rom"],
  } satisfies BrowserChecksumResult;
  for (const result of results) {
    if (result.checksums.adler32 !== undefined) merged.checksums.adler32 = result.checksums.adler32;
    if (result.checksums.crc16 !== undefined) merged.checksums.crc16 = result.checksums.crc16;
    if (typeof result.checksums.crc32 === "number" && result.checksums.crc32)
      merged.checksums.crc32 = result.checksums.crc32;
    if (typeof result.checksums.md5 === "string" && result.checksums.md5) merged.checksums.md5 = result.checksums.md5;
    if (typeof result.checksums.sha1 === "string" && result.checksums.sha1)
      merged.checksums.sha1 = result.checksums.sha1;
    if (result.rom !== null && result.rom !== undefined) merged.rom = result.rom;
  }
  return merged;
};

const normalizeBrowserChecksumAlgorithms = (algorithms: BrowserChecksumInput["checksumAlgorithms"]): string[] => {
  if (!(Array.isArray(algorithms) && algorithms.length)) return [...DEFAULT_BROWSER_CHECKSUM_ALGORITHMS];
  const normalized = algorithms
    .map((algorithm) =>
      String(algorithm || "")
        .trim()
        .toLowerCase(),
    )
    .filter((algorithm) => !!algorithm);
  return normalized.length ? Array.from(new Set(normalized)) : [...DEFAULT_BROWSER_CHECKSUM_ALGORITHMS];
};

const postChecksumMessageWithFileHandleFallback = (
  worker: WorkerTransport<ChecksumWorkerMessage>,
  message: ChecksumWorkerRequest,
) => {
  try {
    worker.postMessage(message);
  } catch (err) {
    if (!(message.fileHandle && message.file)) throw err;
    const { fileHandle: _fileHandle, ...blobRequest } = message;
    worker.postMessage(blobRequest);
  }
};

const getBrowserChecksumTransferList = (input: BrowserChecksumInput) => {
  if (!(input.u8array instanceof Uint8Array)) return undefined;
  return input.u8array.buffer instanceof ArrayBuffer ? [input.u8array.buffer] : undefined;
};

const getChecksumStreamChunkTransferList = (chunk: Uint8Array) =>
  chunk.buffer instanceof ArrayBuffer ? [chunk.buffer] : undefined;

const toOwnedChecksumStreamChunk = (chunk: Uint8Array) => {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) return chunk;
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy;
};

const createChecksumStreamId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `checksum-stream-${crypto.randomUUID()}`
    : `checksum-stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const createChecksumWorkerRpcClientOptions = () => ({
  createWorker: () => createChecksumWorkerInstance() as WorkerTransport<ChecksumWorkerMessage>,
  expectedWorkerKind: "patch-checksum" as const,
  fallbackErrorMessage: "Checksum worker failed",
  getFatalError: (data: ChecksumWorkerMessage) =>
    isFatalMessage(data)
      ? { message: data.error?.message || "Checksum worker failed", requestId: data.requestId }
      : null,
  isErrorMessage: (data: ChecksumWorkerMessage) =>
    isChecksumErrorMessage(data) ? String(data.error.message || "Checksum worker failed") : null,
  isProgressMessage: (data: ChecksumWorkerMessage) => data.action === "checksum-progress",
  isResponseMessage: (data: ChecksumWorkerMessage) =>
    isCompleteMessage(data) ||
    isChecksumStreamAckMessage(data) ||
    isChecksumStreamCompleteMessage(data) ||
    isChecksumWarmupCompleteMessage(data),
  messageErrorFallback: "Checksum worker returned an unreadable response",
  workerErrorFallback: "Checksum worker error",
});

const createBrowserChecksumWorkerClient = () => {
  const client = createWorkerRpcClient<ChecksumWorkerMessage>({
    ...createChecksumWorkerRpcClientOptions(),
    postMessage: (worker, message) =>
      postChecksumMessageWithFileHandleFallback(worker, message as ChecksumWorkerRequest),
  });
  return {
    prime: client.prime,
    reset: client.reset,
    run: (
      input: BrowserChecksumInput,
      onProgress?: (progress: { label: string; percent: number }) => void,
      onLog?: ChecksumLogCallback,
    ): Promise<ChecksumCompleteResponse> =>
      client.request(
        {
          action: "checksum",
          benchmarkFileSize: input.fileSize,
          checksumAlgorithms: input.checksumAlgorithms,
          checksumStartOffset: input.checksumStartOffset,
          file: input.file,
          fileHandle: input.fileHandle,
          fileName: input.fileName,
          filePath: input.filePath,
          logLevel: input.logLevel,
          u8array: input.u8array,
          workerKind: "patch-checksum",
        },
        {
          onLog: forwardChecksumLog(onLog),
          onProgress: (data) => {
            if (isChecksumProgressMessage(data)) onProgress?.(data.progress);
          },
          transferList: getBrowserChecksumTransferList(input),
        },
      ) as Promise<ChecksumCompleteResponse>,
    stream: async (
      input: BrowserChecksumStreamInput,
      onProgress?: (progress: { label: string; percent: number }) => void,
      onLog?: ChecksumLogCallback,
    ): Promise<ChecksumCompleteResponse> => {
      const streamId = createChecksumStreamId();
      const totalBytes = Math.max(0, Math.floor(Number(input.streamTotalBytes) || 0));
      await (client.request(
        {
          action: "checksum-stream-start",
          checksumAlgorithms: input.checksumAlgorithms,
          checksumStartOffset: input.checksumStartOffset,
          fileName: input.fileName,
          logLevel: input.logLevel,
          streamId,
          streamTotalBytes: totalBytes,
          workerKind: "patch-checksum",
        },
        {
          onLog: forwardChecksumLog(onLog),
          onProgress: (data) => {
            if (isChecksumProgressMessage(data)) onProgress?.(data.progress);
          },
        },
      ) as Promise<ChecksumStreamAckMessage>);
      for (let offset = 0; offset < totalBytes; ) {
        const requestedLength = Math.min(BROWSER_CHECKSUM_STREAM_CHUNK_SIZE, totalBytes - offset);
        const nextChunk = toOwnedChecksumStreamChunk(await input.readChunk(offset, requestedLength));
        if (nextChunk.byteLength > requestedLength)
          throw new Error(
            `Checksum stream chunk exceeded requested length: ${nextChunk.byteLength} > ${requestedLength}`,
          );
        if (!nextChunk.byteLength) throw new Error(`Checksum stream chunk was empty at offset ${offset}`);
        await (client.request(
          {
            action: "checksum-stream-chunk",
            fileName: input.fileName,
            logLevel: input.logLevel,
            streamId,
            u8array: nextChunk,
            workerKind: "patch-checksum",
          },
          {
            onLog: forwardChecksumLog(onLog),
            onProgress: (data) => {
              if (isChecksumProgressMessage(data)) onProgress?.(data.progress);
            },
            transferList: getChecksumStreamChunkTransferList(nextChunk),
          },
        ) as Promise<ChecksumStreamAckMessage>);
        offset += nextChunk.byteLength;
      }
      return client.request(
        {
          action: "checksum-stream-complete",
          checksumStartOffset: input.checksumStartOffset,
          fileName: input.fileName,
          logLevel: input.logLevel,
          streamId,
          workerKind: "patch-checksum",
        },
        {
          onLog: forwardChecksumLog(onLog),
          onProgress: (data) => {
            if (isChecksumProgressMessage(data)) onProgress?.(data.progress);
          },
        },
      ) as Promise<ChecksumCompleteResponse>;
    },
    warmup: async (): Promise<void> => {
      const result = (await client.request({
        action: "warmup",
        workerKind: "patch-checksum",
      })) as ChecksumWarmupCompleteMessage | ChecksumWarmupErrorMessage;
      if (result.success) return;
      throw new Error(result.error.message || "Checksum worker warmup failed");
    },
  };
};

const sharedBrowserChecksumWorkerClient = createBrowserChecksumWorkerClient();

const primeChecksumWorker = async (): Promise<void> => {
  await sharedBrowserChecksumWorkerClient.prime();
};

const warmupChecksumWorker = async (): Promise<void> => {
  await sharedBrowserChecksumWorkerClient.warmup();
};

const calculateChecksumsInBrowserWorker = async (
  input: BrowserChecksumInput,
  onProgress?: (progress: { label: string; percent: number }) => void,
  onLog?: ChecksumLogCallback,
): Promise<BrowserChecksumResult> => {
  const normalizedAlgorithms = normalizeBrowserChecksumAlgorithms(input.checksumAlgorithms);
  const sourceSize =
    typeof input.fileSize === "number" && Number.isFinite(input.fileSize)
      ? input.fileSize
      : typeof input.file?.size === "number" && Number.isFinite(input.file.size)
        ? input.file.size
        : 0;
  const shouldUseParallelWorkers =
    input.file &&
    !input.fileHandle &&
    normalizedAlgorithms.length > 1 &&
    sourceSize >= PARALLEL_BROWSER_CHECKSUM_MIN_BYTES;
  emitChecksumClientTrace(input, onLog, "checksum.worker.dispatch", {
    algorithms: normalizedAlgorithms,
    parallel: shouldUseParallelWorkers,
    sourceSize,
  });
  if (shouldUseParallelWorkers)
    return calculateChecksumsInParallelBrowserWorkers(
      {
        ...input,
        checksumAlgorithms: normalizedAlgorithms,
      },
      onProgress,
      onLog,
    );
  const completeData = await sharedBrowserChecksumWorkerClient.run(
    {
      ...input,
      checksumAlgorithms: normalizedAlgorithms,
    },
    onProgress,
    onLog,
  );
  return toBrowserChecksumResult(completeData);
};

const calculateChecksumsInParallelBrowserWorkers = async (
  input: BrowserChecksumInput,
  onProgress?: (progress: { label: string; percent: number }) => void,
  onLog?: ChecksumLogCallback,
): Promise<BrowserChecksumResult> => {
  const algorithms = normalizeBrowserChecksumAlgorithms(input.checksumAlgorithms);
  if (algorithms.length <= 1)
    return calculateChecksumsInBrowserWorker({ ...input, checksumAlgorithms: algorithms }, onProgress, onLog);
  emitChecksumClientTrace(input, onLog, "checksum.parallel.start", {
    algorithms,
    workerCount: algorithms.length,
  });
  const progressByAlgorithm = new Map<string, number>();
  const clients = algorithms.map(() => createBrowserChecksumWorkerClient());
  const emitCombinedProgress = (label?: string) => {
    if (!onProgress) return;
    const percents = algorithms
      .map((algorithm) => progressByAlgorithm.get(algorithm))
      .filter((percent): percent is number => typeof percent === "number" && Number.isFinite(percent));
    if (!percents.length) return;
    const averagePercent = percents.reduce((sum, percent) => sum + percent, 0) / percents.length;
    onProgress({
      label: label || "Calculating checksums...",
      percent: averagePercent,
    });
  };
  try {
    const results = await Promise.all(
      algorithms.map((algorithm, index) =>
        clients[index]!.run(
          {
            ...input,
            checksumAlgorithms: [algorithm],
          },
          (progress) => {
            if (typeof progress.percent === "number" && Number.isFinite(progress.percent))
              progressByAlgorithm.set(algorithm, progress.percent);
            emitCombinedProgress(progress.label);
          },
          onLog,
        ),
      ),
    );
    emitChecksumClientTrace(input, onLog, "checksum.parallel.finish", {
      algorithms,
      workerCount: algorithms.length,
    });
    return mergeBrowserChecksumResults(results.map((result) => toBrowserChecksumResult(result)));
  } finally {
    for (const client of clients) client.reset();
  }
};

const calculateChecksumsInNodeWorker = async (
  input: NodeChecksumInput,
  onProgress?: (progress: { label: string; percent: number }) => void,
  onLog?: ChecksumLogCallback,
): Promise<BrowserChecksumResult> => {
  if (!((typeof input.filePath === "string" && input.filePath) || input.u8array instanceof Uint8Array))
    throw new Error("Node checksum worker requires either filePath or u8array input");
  emitChecksumClientTrace(input, onLog, "checksum.worker.dispatch", {
    algorithms: normalizeBrowserChecksumAlgorithms(input.checksumAlgorithms),
    parallel: false,
  });
  const nodeClient = createWorkerRpcClient<ChecksumWorkerMessage>(createChecksumWorkerRpcClientOptions());
  const completeData = (await nodeClient
    .request(
      {
        action: "checksum",
        benchmarkFileSize: input.fileSize,
        checksumAlgorithms: input.checksumAlgorithms,
        checksumStartOffset: input.checksumStartOffset,
        fileName: input.fileName,
        filePath: input.filePath,
        logLevel: input.logLevel,
        u8array: input.u8array,
        workerKind: "patch-checksum",
      },
      {
        onLog: forwardChecksumLog(onLog),
        onProgress: (data) => {
          if (isChecksumProgressMessage(data)) onProgress?.(data.progress);
        },
      },
    )
    .finally(() => {
      nodeClient.reset();
    })) as ChecksumCompleteResponse;
  return toBrowserChecksumResult(completeData);
};

export {
  calculateChecksumsInBrowserWorker,
  calculateChecksumsInNodeWorker,
  calculateChecksumsInParallelBrowserWorkers,
  createBrowserChecksumWorkerClient,
  primeChecksumWorker,
  warmupChecksumWorker,
};
