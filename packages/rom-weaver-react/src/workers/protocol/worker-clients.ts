import { createLogger } from "../../lib/logging.ts";
import type { LogRecord } from "../../types/logging.ts";
import type { CleanupCallback, JsonValue, ProgressCallback, ProgressEvent } from "../../types/runtime.ts";
import type {
  WorkerCleanupRef,
  WorkerKind,
  WorkerOutputRef,
  WorkerTransport,
  WorkerTransportMessageData,
} from "../../types/worker-messages.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import type {
  BrowserApplyPatchWorkerInput,
  BrowserApplyPatchWorkerResult,
  BrowserCreatePatchWorkerInput,
  BrowserCreatePatchWorkerResponse,
  BrowserCreatePatchWorkerResult,
  BrowserParsePatchWorkerInput,
  BrowserParsePatchWorkerResponse,
  BrowserParsePatchWorkerResult,
  CompressionWorkerKind,
  CompressionWorkerOperation,
  CompressionWorkerRequest,
  CompressionWorkerResult,
} from "./worker-protocol.ts";
import { createWorkerRpcClient } from "./worker-rpc.ts";

type WorkerMessageValue = object | string | number | boolean | null | undefined;
type WorkerMessageData = WorkerTransportMessageData & {
  action?: string;
  cleanupRef?: WorkerCleanupRef;
  cleanupPaths?: string[] | null;
  error?: {
    code?: string;
    details?: Record<string, unknown>;
    message?: string;
  };
  file?: Blob;
  fileHandle?: FileSystemFileHandle;
  fileName?: string;
  filePath?: string;
  kind?: string;
  log?: LogRecord;
  logLevel?: string;
  operation?: string;
  opfsPath?: string;
  outputRef?: WorkerOutputRef;
  progress?: ProgressEvent;
  requestId?: string;
  success?: boolean;
  timestamp?: number;
  [key: string]: WorkerMessageValue;
};
type WorkerLogCallback = (record: LogRecord) => void;

type ResolveWorkerResultContext = {
  retainCleanup: (cleanupPaths: string[] | null | undefined) => CleanupCallback | undefined;
};

type SharedWorkerClient<TAction extends string | null, TResult> = {
  prime: () => Promise<void>;
  requestWithWorker: (
    action: TAction,
    request: WorkerMessageData,
    onProgress?: ProgressCallback,
    onLog?: WorkerLogCallback,
  ) => Promise<{
    data: WorkerMessageData;
    worker: WorkerTransport<WorkerMessageData>;
  }>;
  retainWorker: (worker: WorkerTransport<WorkerMessageData>) => () => void;
  reset: (err?: Error) => void;
  run: (
    action: TAction,
    request: WorkerMessageData,
    onProgress?: ProgressCallback,
    onLog?: WorkerLogCallback,
  ) => Promise<TResult>;
};

type SharedCompressionWorkerClient = {
  prime: (kind: CompressionWorkerKind) => Promise<void>;
  reset: (err?: Error) => void;
  run: (
    kind: CompressionWorkerKind,
    operation: CompressionWorkerOperation,
    request?: Partial<CompressionWorkerRequest>,
    onProgress?: ProgressCallback,
    onLog?: WorkerLogCallback,
  ) => Promise<CompressionWorkerResult>;
  warmup: (kind: CompressionWorkerKind, request?: Partial<CompressionWorkerRequest>) => void;
};

type SharedCompressionKindWorkerClient = {
  prime: () => Promise<void>;
  reset: (err?: Error) => void;
  run: (
    operation: CompressionWorkerOperation,
    request?: Partial<CompressionWorkerRequest>,
    onProgress?: ProgressCallback,
    onLog?: WorkerLogCallback,
  ) => Promise<CompressionWorkerResult>;
  warmup: (request?: Partial<CompressionWorkerRequest>) => void;
};

const normalizeCleanupPaths = (cleanupPaths: WorkerMessageValue, cleanupRef?: WorkerCleanupRef): string[] | null => {
  if (Array.isArray(cleanupRef?.paths))
    return cleanupRef.paths.filter((path): path is string => typeof path === "string");
  return Array.isArray(cleanupPaths) ? cleanupPaths.filter((path): path is string => typeof path === "string") : null;
};

const getWorkerOutputRef = (data: WorkerMessageData): WorkerOutputRef | null =>
  data.outputRef && typeof data.outputRef === "object" ? data.outputRef : null;

const getCompressionOutputFilePath = (data: WorkerMessageData, outputRef: WorkerOutputRef | null) => {
  if (typeof outputRef?.filePath === "string") return outputRef.filePath;
  if (typeof data.filePath === "string") return data.filePath;
  return undefined;
};

const isBrowserWorkerOutputPath = (filePath: string | undefined) =>
  typeof filePath === "string" && filePath.startsWith(WORKER_OPFS_MOUNTPOINT);

const getPatchApplyOutputFilePath = (data: WorkerMessageData, outputRef: WorkerOutputRef | null) => {
  if (typeof outputRef?.filePath === "string") return outputRef.filePath;
  if (typeof data.patchedRomOpfsPath === "string") return data.patchedRomOpfsPath;
  return undefined;
};

const logger = createLogger("worker:client");

const compressionWorkerKindMap: Record<CompressionWorkerKind, WorkerKind> = {
  "7zip-zstd": "7zip-zstd",
  "azahar-z3ds": "azahar-z3ds",
  chdman: "chdman",
  "dolphin-rvz": "dolphin-rvz",
};

const getWorkerMessageError = (data: WorkerMessageData, fallback: string) => {
  if (data.error && typeof data.error === "object" && typeof data.error.message === "string" && data.error.message)
    return data.error.message;
  if (typeof data.message === "string" && data.message) return data.message;
  if (typeof data.failureMessage === "string" && data.failureMessage) return data.failureMessage;
  return fallback;
};

const summarizeWorkerRequest = <TAction extends string | null>(context: WorkerRequestContext<TAction>) => ({
  action: context.action || context.request.action,
  compression: context.request.compression,
  entryName: context.request.entryName,
  fileName: context.request.fileName,
  format: context.request.format,
  kind: context.request.kind,
  operation: context.request.operation,
  outputName: context.request.outputName,
  requestId: context.request.requestId,
  threads: context.request.threads,
});

const getWorkerRequestLogOptions = <TAction extends string | null>(context: WorkerRequestContext<TAction>) =>
  typeof context.request.logLevel === "string" ? { level: context.request.logLevel } : undefined;

const toWorkerMessageData = (data: WorkerMessageValue): WorkerMessageData =>
  data && typeof data === "object" ? (data as WorkerMessageData) : {};

const isWorkerProgressDetails = (
  value: ProgressEvent["details"] | WorkerMessageValue,
): value is NonNullable<ProgressEvent["details"]> => !!value && typeof value === "object" && !Array.isArray(value);

const normalizeWorkerProgress = <TAction extends string | null>(
  progress: ProgressEvent | undefined,
  data: WorkerMessageData,
  context: WorkerRequestContext<TAction>,
  sequence: number,
): ProgressEvent => {
  const source = progress && typeof progress === "object" ? progress : {};
  const action = String(context.action || context.request.operation || context.request.action || "");
  const workflow = action === "create" || action === "create-patch" ? "create" : "apply";
  const timestamp = typeof data.timestamp === "number" && Number.isFinite(data.timestamp) ? data.timestamp : undefined;
  const workerKind = typeof data.workerKind === "string" ? data.workerKind : context.request.workerKind;
  let workerRequestId: string | undefined;
  if (typeof data.requestId === "string" && data.requestId) workerRequestId = data.requestId;
  else if (typeof context.request.requestId === "string" && context.request.requestId) {
    workerRequestId = context.request.requestId;
  }
  const details: Record<string, JsonValue | undefined> = isWorkerProgressDetails(source.details)
    ? { ...(source.details as Record<string, JsonValue | undefined>) }
    : {};
  if (timestamp !== undefined) details.timestamp = timestamp;
  if (workerKind) details.workerKind = workerKind;
  if (workerRequestId) details.workerRequestId = workerRequestId;
  let stage = "apply";
  if (action === "checksum") stage = "checksum";
  else if (action === "create" || action === "create-patch") stage = "create";
  else if (action === "extract" || action === "list") stage = "decompress";
  else if (action === "cleanup") stage = "write";
  const normalizedPercent =
    typeof source.percent === "number" && Number.isFinite(source.percent) ? source.percent : null;
  return {
    ...source,
    ...(Object.keys(details).length ? { details } : {}),
    id: typeof source.id === "string" && source.id ? source.id : `worker-${context.request.requestId || sequence}`,
    label: typeof source.label === "string" && source.label ? source.label : "Worker operation",
    percent: normalizedPercent,
    role: "worker",
    sequence,
    stage,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(workerKind ? { workerKind } : {}),
    ...(workerRequestId ? { workerRequestId } : {}),
    workflow,
  };
};

const isForwardableWorkerLog = (log: unknown): log is LogRecord =>
  !!(
    log &&
    typeof log === "object" &&
    "level" in log &&
    "message" in log &&
    "namespace" in log &&
    typeof (log as LogRecord).level === "string" &&
    typeof (log as LogRecord).message === "string" &&
    typeof (log as LogRecord).namespace === "string"
  );

const forwardWorkerLog = <TAction extends string | null>(
  data: WorkerMessageData,
  context: WorkerRequestContext<TAction>,
  onLog?: WorkerLogCallback,
) => {
  if (!isForwardableWorkerLog(data.log)) return;
  const workerLogger = createLogger(data.log.namespace);
  const details = {
    ...(data.log.details || {}),
    requestId: data.requestId ?? context.request.requestId,
    workerKind: context.request.kind || data.workerKind || context.request.workerKind,
    workerOperation: context.action || context.request.operation || context.request.action,
  };
  onLog?.({
    details,
    level: data.log.level,
    message: data.log.message,
    namespace: data.log.namespace,
    timestamp: data.log.timestamp,
  });
  const logOptions = getWorkerRequestLogOptions(context);
  switch (data.log.level) {
    case "debug":
      workerLogger.debug(data.log.message, details, logOptions);
      break;
    case "error":
      workerLogger.error(data.log.message, details, logOptions);
      break;
    case "info":
      workerLogger.info(data.log.message, details, logOptions);
      break;
    case "trace":
      workerLogger.trace(data.log.message, details, logOptions);
      break;
    case "warn":
      workerLogger.warn(data.log.message, details, logOptions);
      break;
  }
};

const traceWorkerProtocol = <TAction extends string | null>(
  context: WorkerRequestContext<TAction>,
  message: string,
  details: Record<string, unknown>,
) => {
  logger.trace(
    message,
    {
      ...details,
      kind: context.request.kind,
      operation: details.operation || context.action || context.request.operation || context.request.action,
      workerKind: details.workerKind || context.request.workerKind,
    },
    getWorkerRequestLogOptions(context),
  );
};

type WorkerRequestContext<TAction extends string | null> = {
  action: TAction;
  request: WorkerMessageData;
};

const runLoggedWorkerRequest = async <TAction extends string | null, TResult>(
  context: WorkerRequestContext<TAction>,
  runRequest: () => Promise<TResult>,
) => {
  const logOptions = getWorkerRequestLogOptions(context);
  const startedAt = Date.now();
  const summary = summarizeWorkerRequest(context);
  logger.debug("Worker request started", summary, logOptions);
  logger.trace("worker.request.start", summary, logOptions);
  try {
    const result = await runRequest();
    logger.debug("Worker request completed", summary, logOptions);
    logger.trace(
      "worker.request.finish",
      {
        ...summary,
        durationMs: Date.now() - startedAt,
      },
      logOptions,
    );
    return result;
  } catch (error) {
    logger.error("Worker request failed", { ...summary, error }, logOptions);
    logger.trace(
      "worker.request.fail",
      {
        ...summary,
        durationMs: Date.now() - startedAt,
        error,
      },
      logOptions,
    );
    throw error;
  }
};

const enqueueWorkerRequest = <TResult>(
  chain: Promise<unknown>,
  setChain: (chain: Promise<void>) => void,
  runRequest: () => Promise<TResult>,
) => {
  const result = chain.then(runRequest, runRequest);
  setChain(
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
};

const createCleanupRetainer = (
  client: Pick<ReturnType<typeof createWorkerRpcClient<WorkerMessageData>>, "retainWorker">,
  worker: WorkerTransport<WorkerMessageData>,
  createCleanupMessage: (cleanupPaths: string[]) => WorkerMessageData = (cleanupPaths) => ({
    action: "cleanup",
    filePaths: cleanupPaths,
    operation: "cleanup",
    workerKind: "patch-checksum" as const,
  }),
) => {
  return (cleanupPaths: string[] | null | undefined) => {
    const normalizedCleanupPaths = normalizeCleanupPaths(cleanupPaths);
    if (!normalizedCleanupPaths?.length) return undefined;
    const releaseWorker = client.retainWorker(worker);
    let cleanupComplete = false;
    return () => {
      if (cleanupComplete) return;
      cleanupComplete = true;
      const cleanupMessage = createCleanupMessage(normalizedCleanupPaths);
      logger.trace("worker.cleanup.requested", {
        cleanupPathCount: normalizedCleanupPaths.length,
        operation: cleanupMessage.operation || cleanupMessage.action || "cleanup",
        workerKind: cleanupMessage.workerKind,
      });
      try {
        worker.postMessage(cleanupMessage);
        logger.trace("worker.cleanup.sent", {
          cleanupPathCount: normalizedCleanupPaths.length,
          operation: cleanupMessage.operation || cleanupMessage.action || "cleanup",
          workerKind: cleanupMessage.workerKind,
        });
      } catch (error) {
        logger.trace("worker.cleanup.failed", {
          cleanupPathCount: normalizedCleanupPaths.length,
          error,
          operation: cleanupMessage.operation || cleanupMessage.action || "cleanup",
          workerKind: cleanupMessage.workerKind,
        });
      } finally {
        releaseWorker();
      }
    };
  };
};

const createRpcBackedWorkerClient = <TAction extends string | null, TResult>({
  buildMessage,
  createWorker,
  fallbackErrorMessage,
  isCompleteMessage,
  messageErrorFallback,
  resetErrorMessage,
  resolveResult,
  workerErrorFallback,
}: {
  buildMessage: (context: WorkerRequestContext<TAction>) => WorkerMessageData;
  createWorker: () => WorkerTransport<WorkerMessageData>;
  fallbackErrorMessage: string;
  isCompleteMessage: (data: WorkerMessageData, context: WorkerRequestContext<TAction>) => boolean;
  messageErrorFallback?: string;
  resetErrorMessage?: string;
  resolveResult: (
    data: WorkerMessageData,
    context: WorkerRequestContext<TAction>,
    resolveContext: ResolveWorkerResultContext,
  ) => TResult;
  workerErrorFallback?: string;
}): SharedWorkerClient<TAction, TResult> => {
  const client = createWorkerRpcClient<WorkerMessageData>({
    createWorker,
    fallbackErrorMessage,
    getFatalError: (data) =>
      data.action === "fatal"
        ? {
            message: getWorkerMessageError(data, fallbackErrorMessage),
            requestId: null,
          }
        : null,
    isErrorMessage: (data) => (data.type === "error" ? getWorkerMessageError(data, fallbackErrorMessage) : null),
    isResponseMessage: () => true,
    messageErrorFallback,
    workerErrorFallback,
  });
  let chain = Promise.resolve();
  let progressSequence = 0;
  const requestWorker = (
    message: WorkerMessageData,
    context: WorkerRequestContext<TAction>,
    workerKey: string,
    onProgress?: ProgressCallback,
    onLog?: WorkerLogCallback,
  ) =>
    client.requestWithWorker(message, {
      expectedWorkerKind: message.workerKind as WorkerKind | undefined,
      onLog: (data) => forwardWorkerLog(data, context, onLog),
      onProgress: (data) => {
        if (data.action === "progress" || data.type === "progress")
          onProgress?.(normalizeWorkerProgress(data.progress, data, context, ++progressSequence));
      },
      onTrace: (message, details) => traceWorkerProtocol(context, message, details),
      workerKey,
    });

  return {
    prime: () => client.prime().then(() => undefined),
    requestWithWorker(action, request, onProgress, onLog) {
      const context = { action, request };
      const message = buildMessage(context);
      const workerKey =
        typeof request.kind === "string" && request.kind
          ? `${request.kind}:${String(request.threads ?? "")}`
          : String(request.threads ?? "");
      return requestWorker(message, context, workerKey, onProgress, onLog);
    },
    reset: (err) => {
      chain = Promise.resolve();
      client.reset(err || new Error(resetErrorMessage || fallbackErrorMessage));
    },
    retainWorker: client.retainWorker,
    run(action, request, onProgress, onLog) {
      const context = { action, request };
      const workerKey = String(request.threads ?? "");
      const runRequest = async () => {
        const message = buildMessage(context);
        return runLoggedWorkerRequest(context, async () => {
          const response = await requestWorker(message, context, workerKey, onProgress, onLog);
          const data = toWorkerMessageData(response.data);
          if (!isCompleteMessage(data, context)) throw new Error(getWorkerMessageError(data, fallbackErrorMessage));
          return resolveResult(data, context, {
            retainCleanup: (cleanupPaths) => createCleanupRetainer(client, response.worker)(cleanupPaths),
          });
        });
      };
      return enqueueWorkerRequest(
        chain,
        (nextChain) => {
          chain = nextChain;
        },
        runRequest,
      );
    },
  };
};

const resolveCompressionWorkerResult = (
  data: WorkerMessageData,
  fallbackErrorMessage: string,
  retainCleanup: ResolveWorkerResultContext["retainCleanup"],
): CompressionWorkerResult => {
  if (!data.success) throw new Error(getWorkerMessageError(data, fallbackErrorMessage));
  const outputRef = getWorkerOutputRef(data);
  const cleanupPaths = normalizeCleanupPaths(data.cleanupPaths, data.cleanupRef);
  if (data.file instanceof Blob) throw new Error("Compression worker returned a binary payload");
  const filePath = getCompressionOutputFilePath(data, outputRef);
  const operation = String(data.operation || "") as CompressionWorkerOperation;
  if ((operation === "create" || operation === "extract") && !filePath)
    throw new Error(getWorkerMessageError(data, fallbackErrorMessage));
  const fallbackFileName = typeof data.fileName === "string" ? data.fileName : "output.bin";
  return {
    ...(data as CompressionWorkerResult),
    archiveEntryName: typeof data.archiveEntryName === "string" ? data.archiveEntryName : undefined,
    archiveEntryType: typeof data.archiveEntryType === "string" ? data.archiveEntryType : undefined,
    archiveFileName: typeof data.archiveFileName === "string" ? data.archiveFileName : undefined,
    chdCueFileName: typeof data.chdCueFileName === "string" ? data.chdCueFileName : undefined,
    chdCueText: typeof data.chdCueText === "string" ? data.chdCueText : undefined,
    chdMode: typeof data.chdMode === "string" ? data.chdMode : undefined,
    chdSourceFileName: typeof data.chdSourceFileName === "string" ? data.chdSourceFileName : undefined,
    cleanup: retainCleanup(cleanupPaths),
    cleanupPaths,
    entries: Array.isArray(data.entries) ? data.entries : undefined,
    entry: data.entry && typeof data.entry === "object" ? (data.entry as CompressionWorkerResult["entry"]) : undefined,
    file: undefined,
    fileName: outputRef?.fileName || fallbackFileName,
    filePath,
    kind: String(data.kind || "7zip-zstd") as CompressionWorkerKind,
    operation,
    outputRef:
      outputRef ||
      (filePath
        ? {
            fileName: fallbackFileName,
            filePath,
            kind: "opfs",
          }
        : undefined),
    rvzMode: typeof data.rvzMode === "string" ? data.rvzMode : undefined,
    rvzSourceFileName: typeof data.rvzSourceFileName === "string" ? data.rvzSourceFileName : undefined,
    timestamp: typeof data.timestamp === "number" && Number.isFinite(data.timestamp) ? data.timestamp : undefined,
    timing: data.timing && typeof data.timing === "object" ? data.timing : null,
    z3dsMetadata:
      data.z3dsMetadata && typeof data.z3dsMetadata === "object"
        ? (data.z3dsMetadata as CompressionWorkerResult["z3dsMetadata"])
        : undefined,
    z3dsSourceFileName: typeof data.z3dsSourceFileName === "string" ? data.z3dsSourceFileName : undefined,
    z3dsUnderlyingMagic: typeof data.z3dsUnderlyingMagic === "string" ? data.z3dsUnderlyingMagic : undefined,
  };
};

const createDeferredCompressionCleanup = ({
  cleanupPaths,
  kind,
  logLevel,
  runCleanup,
  threads,
}: {
  cleanupPaths: string[] | null | undefined;
  kind: CompressionWorkerKind;
  logLevel?: string;
  runCleanup: (request: Partial<CompressionWorkerRequest>) => Promise<unknown>;
  threads?: number | string | null;
}): CleanupCallback | undefined => {
  const normalizedCleanupPaths = normalizeCleanupPaths(cleanupPaths);
  if (!normalizedCleanupPaths?.length) return undefined;
  let cleanupComplete = false;
  const cleanupTimeoutMs = 5000;
  return async () => {
    if (cleanupComplete) return;
    cleanupComplete = true;
    logger.trace("worker.cleanup.requested", {
      cleanupPathCount: normalizedCleanupPaths.length,
      operation: "cleanup",
      workerKind: compressionWorkerKindMap[kind],
    });
    try {
      await Promise.race([
        runCleanup({
          filePaths: normalizedCleanupPaths,
          kind,
          logLevel,
          threads,
        }),
        new Promise((resolve) => {
          setTimeout(resolve, cleanupTimeoutMs);
        }),
      ]);
      logger.trace("worker.cleanup.completed", {
        cleanupPathCount: normalizedCleanupPaths.length,
        cleanupTimeoutMs,
        operation: "cleanup",
        workerKind: compressionWorkerKindMap[kind],
      });
    } catch (error) {
      logger.trace("worker.cleanup.failed", {
        cleanupPathCount: normalizedCleanupPaths.length,
        error,
        operation: "cleanup",
        workerKind: compressionWorkerKindMap[kind],
      });
    }
  };
};

const createCompressionWorkerClient = (
  createWorker: (kind: CompressionWorkerKind) => WorkerTransport<WorkerMessageData>,
  fallbackErrorMessage = "Compression operation failed",
): SharedCompressionWorkerClient => {
  let requestedWorkerKind: CompressionWorkerKind = "7zip-zstd";
  const client = createRpcBackedWorkerClient<CompressionWorkerOperation, CompressionWorkerResult>({
    buildMessage: (context) => ({
      ...context.request,
      action: context.action,
      kind: context.request.kind,
      operation: context.action,
      workerKind: compressionWorkerKindMap[context.request.kind as CompressionWorkerKind],
    }),
    createWorker: () => createWorker(requestedWorkerKind),
    fallbackErrorMessage,
    isCompleteMessage: (data, context) =>
      data.action === "complete" && data.kind === context.request.kind && data.operation === context.action,
    messageErrorFallback: "Error reading compression worker response",
    resetErrorMessage: "Compression worker request was interrupted",
    resolveResult: (data, _context, { retainCleanup }) =>
      resolveCompressionWorkerResult(data, fallbackErrorMessage, retainCleanup),
    workerErrorFallback: "Compression worker failed",
  });
  let chain = Promise.resolve();
  let activeRunCount = 0;
  let releaseWorkerWhenIdle = false;

  const releaseIdleWorker = () => {
    if (activeRunCount !== 0 || !releaseWorkerWhenIdle) return;
    releaseWorkerWhenIdle = false;
    client.reset();
  };

  const run = (
    kind: CompressionWorkerKind,
    operation: CompressionWorkerOperation,
    request: Partial<CompressionWorkerRequest> = {},
    onProgress?: ProgressCallback,
    onLog?: WorkerLogCallback,
  ) => {
    activeRunCount += 1;
    const context = {
      action: operation,
      request: {
        ...request,
        kind,
        operation,
        workerKind: compressionWorkerKindMap[kind],
      } as WorkerMessageData,
    };
    const runRequest = async () => {
      requestedWorkerKind = kind;
      const message = context.request;
      return runLoggedWorkerRequest(context, async () => {
        const response = await client.requestWithWorker(operation, message, onProgress, onLog);
        const result = resolveCompressionWorkerResult(
          toWorkerMessageData(response.data),
          fallbackErrorMessage,
          (cleanupPaths) =>
            createDeferredCompressionCleanup({
              cleanupPaths,
              kind,
              logLevel: typeof request.logLevel === "string" ? request.logLevel : undefined,
              runCleanup: (cleanupRequest) => run(kind, "cleanup", cleanupRequest),
              threads: request.threads,
            }),
        );
        if ((operation === "create" || operation === "extract") && isBrowserWorkerOutputPath(result.filePath))
          releaseWorkerWhenIdle = true;
        return result;
      });
    };
    const result = enqueueWorkerRequest(
      chain,
      (nextChain) => {
        chain = nextChain;
      },
      runRequest,
    );
    return result.finally(() => {
      activeRunCount -= 1;
      releaseIdleWorker();
    });
  };

  return {
    prime(kind) {
      requestedWorkerKind = kind;
      return client.prime();
    },
    reset: client.reset,
    run,
    warmup(kind, request = {}) {
      run(kind, "warmup", request).catch(() => undefined);
    },
  };
};

const createCompressionKindWorkerClient = (
  kind: CompressionWorkerKind,
  createWorker: () => WorkerTransport<WorkerMessageData>,
  fallbackErrorMessage = "Compression operation failed",
): SharedCompressionKindWorkerClient => {
  const client = createCompressionWorkerClient((requestedKind) => {
    if (requestedKind !== kind)
      throw new Error(`Compression worker kind mismatch: expected ${kind}, got ${requestedKind}`);
    return createWorker();
  }, fallbackErrorMessage);
  return {
    prime: () => client.prime(kind),
    reset: client.reset,
    run: (operation, request, onProgress, onLog) => client.run(kind, operation, request, onProgress, onLog),
    warmup: (request) => client.warmup(kind, request),
  };
};

const createParsePatchWorkerClient = (createWorker: () => WorkerTransport<WorkerMessageData>) => {
  const client = createRpcBackedWorkerClient<"parse-patch", BrowserParsePatchWorkerResult>({
    buildMessage: (context) => ({
      ...context.request,
      action: "parse-patch",
      workerKind: "patch-checksum",
    }),
    createWorker,
    fallbackErrorMessage: "Patch parse worker failed to load or crashed.",
    isCompleteMessage: (data) => data.action === "parse-patch-complete",
    messageErrorFallback: "Patch parse worker returned an unreadable response",
    resetErrorMessage: "Patch parse worker request was interrupted",
    resolveResult: (data) => {
      const response = data as BrowserParsePatchWorkerResponse;
      if (!response.success) throw new Error(getWorkerMessageError(response, "Patch parse worker request failed"));
      return response.patch || null;
    },
    workerErrorFallback: "Patch parse worker failed to load or crashed.",
  });

  return {
    reset: client.reset,
    run: (input: BrowserParsePatchWorkerInput) => client.run("parse-patch", input as unknown as WorkerMessageData),
  };
};

const createCreatePatchWorkerClient = (createWorker: () => WorkerTransport<WorkerMessageData>) => {
  const client = createRpcBackedWorkerClient<"create-patch", BrowserCreatePatchWorkerResult>({
    buildMessage: (context) => ({
      ...context.request,
      action: "create-patch",
      workerKind: "patch-checksum",
    }),
    createWorker,
    fallbackErrorMessage: "Create patch worker failed to load or crashed.",
    isCompleteMessage: (data) => data.action === "complete",
    messageErrorFallback: "Create patch worker returned an unreadable response",
    resetErrorMessage: "Create patch worker request was interrupted",
    resolveResult: (data, context, { retainCleanup }) => {
      const input = context.request as unknown as BrowserCreatePatchWorkerInput;
      const response = data as BrowserCreatePatchWorkerResponse;
      const responseData = response as WorkerMessageData;
      if (!response.success) throw new Error(getWorkerMessageError(response, "Create patch worker request failed"));
      const outputRef = getWorkerOutputRef(response as WorkerMessageData);
      if (responseData.file instanceof Blob) throw new Error("Create patch worker returned a binary payload");
      const filePath = getCompressionOutputFilePath(responseData, outputRef);
      if (!filePath) throw new Error("Create patch worker did not return a patch file");
      const cleanupPaths = normalizeCleanupPaths(responseData.cleanupPaths, response.cleanupRef);
      return {
        cleanup: retainCleanup(cleanupPaths),
        fileName: outputRef?.fileName || response.fileName || input.outputName,
        filePath,
        ...(outputRef ? { outputRef } : null),
        size: outputRef?.size || 0,
        ...(typeof response.timestamp === "number" && Number.isFinite(response.timestamp)
          ? { timestamp: response.timestamp }
          : null),
      };
    },
    workerErrorFallback: "Create patch worker failed to load or crashed.",
  });

  return {
    reset: client.reset,
    run: (input: BrowserCreatePatchWorkerInput, onProgress?: ProgressCallback, onLog?: WorkerLogCallback) =>
      client.run("create-patch", input as unknown as WorkerMessageData, onProgress, onLog),
  };
};

const createApplyPatchWorkerClient = (createWorker: () => WorkerTransport<WorkerMessageData>) => {
  const client = createRpcBackedWorkerClient<"apply", BrowserApplyPatchWorkerResult>({
    buildMessage: (context) => ({
      ...context.request,
      action: "apply",
      workerKind: "patch-checksum",
    }),
    createWorker,
    fallbackErrorMessage: "Apply patch worker failed to load or crashed.",
    isCompleteMessage: (data) => data.action === "complete",
    messageErrorFallback: "Apply patch worker returned an unreadable response",
    resetErrorMessage: "Apply patch worker request was interrupted",
    resolveResult: (data, context, { retainCleanup }) => {
      const input = context.request as unknown as BrowserApplyPatchWorkerInput;
      if (!data.success) throw new Error(getWorkerMessageError(data, "Apply patch worker request failed"));
      const outputRef = getWorkerOutputRef(data);
      if (data.patchedRomFile instanceof Blob) throw new Error("Apply patch worker returned a binary payload");
      const filePath = getPatchApplyOutputFilePath(data, outputRef);
      if (!filePath) throw new Error("Apply patch worker did not return output");
      const cleanupPaths = normalizeCleanupPaths(data.cleanupPaths, data.cleanupRef);
      return {
        ...(data.applySummary && typeof data.applySummary === "object"
          ? { applySummary: data.applySummary as BrowserApplyPatchWorkerResult["applySummary"] }
          : null),
        cleanup: retainCleanup(cleanupPaths),
        fileName: String(outputRef?.fileName || data.patchedRomFileName || input.romFileName || "patched.bin"),
        filePath,
        ...(outputRef ? { outputRef } : null),
        size:
          outputRef?.size ||
          (data.applySummary &&
          typeof data.applySummary === "object" &&
          typeof (data.applySummary as { outputSize?: unknown }).outputSize === "number"
            ? ((data.applySummary as { outputSize?: number }).outputSize ?? 0)
            : 0),
        timing:
          data.timing && typeof data.timing === "object"
            ? (data.timing as BrowserApplyPatchWorkerResult["timing"])
            : null,
        ...(typeof data.timestamp === "number" && Number.isFinite(data.timestamp)
          ? { timestamp: data.timestamp }
          : null),
      };
    },
    workerErrorFallback: "Apply patch worker failed to load or crashed.",
  });
  return {
    reset: client.reset,
    run: (input: BrowserApplyPatchWorkerInput, onProgress?: ProgressCallback, onLog?: WorkerLogCallback) =>
      client.run("apply", input as unknown as WorkerMessageData, onProgress, onLog),
  };
};

export type { SharedCompressionKindWorkerClient, SharedCompressionWorkerClient, WorkerMessageData };
export {
  createApplyPatchWorkerClient,
  createCompressionKindWorkerClient,
  createCompressionWorkerClient,
  createCreatePatchWorkerClient,
  createParsePatchWorkerClient,
};
