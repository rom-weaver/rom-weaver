import type {
  WorkerKind,
  WorkerTransport,
  WorkerTransportMessageData,
  WorkerTransportPostMessageOptions,
} from "../../types/worker-messages.ts";
import { createWorkerRequestId } from "../shared/worker-request-id.ts";
import type { WorkerRequestId } from "./worker-protocol.ts";

type WorkerMessageData = WorkerTransportMessageData & {
  requestId?: WorkerRequestId;
};
type PendingRequest<TMessage extends WorkerMessageData> = {
  expectedWorkerKind?: WorkerKind;
  onLog?: (data: TMessage) => void;
  onProgress?: (data: TMessage) => void;
  onTrace?: (message: string, details: Record<string, unknown>) => void;
  requestMessage: WorkerMessageData;
  reject: (err: Error) => void;
  resolve: (response: WorkerRpcResponse<TMessage>) => void;
};
type WorkerRpcRequestOptions<TMessage extends WorkerMessageData> = {
  onLog?: (data: TMessage) => void;
  onProgress?: (data: TMessage) => void;
  onTrace?: (message: string, details: Record<string, unknown>) => void;
  expectedWorkerKind?: WorkerKind;
  signal?: AbortSignal;
  transferList?: WorkerTransportPostMessageOptions;
  workerKey?: string;
};
type WorkerRpcPrimeOptions = {
  workerKey?: string;
};
type QueuedMessage = {
  expectedWorkerKind?: WorkerKind;
  message: WorkerMessageData;
  requestId: WorkerRequestId;
  transferList?: WorkerTransportPostMessageOptions;
};
type WorkerRpcResponse<TMessage extends WorkerMessageData> = {
  data: TMessage;
  worker: WorkerTransport<TMessage>;
};
type WorkerRpcClientOptions<TMessage extends WorkerMessageData> = {
  createWorker: () => WorkerTransport<TMessage>;
  fallbackErrorMessage: string;
  expectedWorkerKind?: WorkerKind;
  getFatalError?: (data: TMessage) => { message: string; requestId?: WorkerRequestId | number | null } | null;
  getRequestId?: (data: TMessage) => WorkerRequestId | null;
  isErrorMessage?: (data: TMessage) => string | null;
  isLogMessage?: (data: TMessage) => boolean;
  isProgressMessage?: (data: TMessage) => boolean;
  isReadyMessage?: (data: TMessage) => boolean;
  isResponseMessage: (data: TMessage) => boolean;
  messageErrorFallback?: string;
  postMessage?: (
    worker: WorkerTransport<TMessage>,
    message: WorkerMessageData,
    transferList?: WorkerTransportPostMessageOptions,
  ) => void;
  workerErrorFallback?: string;
};
type WorkerRpcClient<TMessage extends WorkerMessageData> = {
  prime: (options?: WorkerRpcPrimeOptions) => Promise<WorkerTransport<TMessage>>;
  request: (message: WorkerMessageData, options?: WorkerRpcRequestOptions<TMessage>) => Promise<TMessage>;
  requestWithWorker: (
    message: WorkerMessageData,
    options?: WorkerRpcRequestOptions<TMessage>,
  ) => Promise<WorkerRpcResponse<TMessage>>;
  retainWorker: (retainedWorker: WorkerTransport<TMessage>) => () => void;
  reset: (err?: Error) => void;
};
type WorkerTransportWithDebug = Pick<WorkerTransport<WorkerMessageData>, "terminate"> & {
  __romWeaverWorkerDebug?: {
    workerName?: string;
    workerScriptUrl?: string;
  };
};

const getWorkerEventErrorMessage = (fallback: string, event?: ErrorEvent | MessageEvent<WorkerMessageData> | null) => {
  if (!event) return fallback;
  const baseMessage =
    ("message" in event && typeof event.message === "string" && event.message) ||
    ("error" in event && event.error instanceof Error && event.error.message) ||
    fallback;
  if (!("filename" in event) || typeof event.filename !== "string" || !event.filename) return baseMessage;
  const line = "lineno" in event && Number.isFinite(event.lineno) && event.lineno > 0 ? `:${event.lineno}` : "";
  const column = "colno" in event && Number.isFinite(event.colno) && event.colno > 0 ? `:${event.colno}` : "";
  return `${baseMessage} (${event.filename}${line}${column})`;
};

const getWorkerEventErrorDetails = (
  event?: ErrorEvent | MessageEvent<WorkerMessageData> | null,
  worker?: WorkerTransportWithDebug | null,
) => {
  if (!event) return undefined;
  const details: Record<string, unknown> = {};
  if ("type" in event && typeof event.type === "string" && event.type) details.eventType = event.type;
  if ("filename" in event && typeof event.filename === "string" && event.filename) details.fileName = event.filename;
  if ("lineno" in event && Number.isFinite(event.lineno) && event.lineno > 0) details.lineNumber = event.lineno;
  if ("colno" in event && Number.isFinite(event.colno) && event.colno > 0) details.columnNumber = event.colno;
  if ("error" in event && event.error instanceof Error && event.error.name) details.errorName = event.error.name;
  const workerDebug = worker?.__romWeaverWorkerDebug;
  if (workerDebug?.workerName) details.workerName = workerDebug.workerName;
  if (workerDebug?.workerScriptUrl) {
    details.workerScriptUrl = workerDebug.workerScriptUrl;
    if (!details.fileName) details.fileName = workerDebug.workerScriptUrl;
  }
  return Object.keys(details).length ? details : undefined;
};

const createWorkerProtocolError = (
  message: string,
  code: "CANCELLED" | "WORKER_FAILED" | "WORKER_UNAVAILABLE" = "WORKER_UNAVAILABLE",
  details?: Record<string, unknown>,
) => {
  const error = new Error(message) as Error & {
    code?: string;
    details?: Record<string, unknown>;
    severity?: string;
  };
  error.code = code;
  error.details = details;
  error.severity = code === "CANCELLED" ? "warning" : "error";
  return error;
};

const toWorkerProtocolError = (
  error: unknown,
  fallbackMessage: string,
  details?: Record<string, unknown>,
  code: "WORKER_FAILED" | "WORKER_UNAVAILABLE" = "WORKER_FAILED",
) => {
  if (error instanceof Error) {
    const existingCode =
      typeof (error as Error & { code?: unknown }).code === "string"
        ? ((error as Error & { code?: string }).code as string)
        : undefined;
    if (existingCode === "WORKER_FAILED" || existingCode === "WORKER_UNAVAILABLE" || existingCode === "CANCELLED")
      return error;
    return createWorkerProtocolError(error.message || fallbackMessage, code, {
      ...(details || {}),
      causeName: error.name || undefined,
    });
  }
  return createWorkerProtocolError(fallbackMessage, code, details);
};

const createWorkerCancelledError = (requestId: WorkerRequestId) =>
  createWorkerProtocolError("Worker request was cancelled", "CANCELLED", {
    requestId: String(requestId),
  });

const getMessageOperation = (message: WorkerMessageData) => {
  if (typeof message.operation === "string") return message.operation;
  if (typeof message.action === "string") return message.action;
  return undefined;
};

const isWorkerSidebandMessage = (message: WorkerMessageData) =>
  message.action === "log" || message.action === "progress" || message.type === "log" || message.type === "progress";

const getTraceOperation = (message: WorkerMessageData, fallbackMessage?: WorkerMessageData) => {
  if (isWorkerSidebandMessage(message)) {
    return fallbackMessage ? getMessageOperation(fallbackMessage) : getMessageOperation(message);
  }
  return getMessageOperation(message) || (fallbackMessage ? getMessageOperation(fallbackMessage) : undefined);
};

const normalizeTraceNumeric = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const getTraceProgressPercent = (message: WorkerMessageData) => {
  const progress =
    message &&
    typeof message === "object" &&
    "progress" in message &&
    message.progress &&
    typeof message.progress === "object"
      ? (message.progress as Record<string, unknown>)
      : null;
  if (!progress) return undefined;
  const directPercent = normalizeTraceNumeric(progress.percent);
  if (directPercent !== null) return Math.max(0, Math.min(100, directPercent));
  return undefined;
};

const createTraceDetails = (
  message: WorkerMessageData,
  requestId: WorkerRequestId,
  expectedWorkerKind?: WorkerKind,
  fallbackMessage?: WorkerMessageData,
) => {
  const progressPercent = getTraceProgressPercent(message);
  return {
    operation: getTraceOperation(message, fallbackMessage),
    requestId: String(requestId),
    workerKind: message.workerKind || fallbackMessage?.workerKind || expectedWorkerKind,
    ...(progressPercent === undefined ? {} : { percent: progressPercent }),
  };
};

const createMalformedWorkerMessageError = (
  message: string,
  data: WorkerTransportMessageData,
  expectedWorkerKind?: WorkerKind,
) =>
  createWorkerProtocolError(message, "WORKER_FAILED", {
    expectedWorkerKind,
    operation: getMessageOperation(data as WorkerMessageData),
    receivedWorkerKind: data.workerKind,
    requestId:
      typeof data.requestId === "string" || typeof data.requestId === "number" ? String(data.requestId) : undefined,
  });

const validateIncomingWorkerMessage = (
  data: WorkerTransportMessageData,
  expectedWorkerKind?: WorkerKind,
): Error | null => {
  if (!data || typeof data !== "object") return createWorkerProtocolError("Malformed worker message", "WORKER_FAILED");
  if (expectedWorkerKind && !data.workerKind)
    return createMalformedWorkerMessageError(
      "Worker message is missing a concrete workerKind",
      data,
      expectedWorkerKind,
    );
  if (expectedWorkerKind && data.workerKind && data.workerKind !== expectedWorkerKind) {
    return createMalformedWorkerMessageError(
      "Worker response came from the wrong concrete worker",
      data,
      expectedWorkerKind,
    );
  }
  if (
    data.type === "error" &&
    !(data.error && typeof data.error === "object" && typeof data.error.message === "string")
  )
    return createMalformedWorkerMessageError(
      "Worker error message is missing a typed error payload",
      data,
      expectedWorkerKind,
    );
  if ((data.type === "progress" || data.action === "progress") && !("progress" in data))
    return createMalformedWorkerMessageError(
      "Worker progress message is missing progress data",
      data,
      expectedWorkerKind,
    );
  return null;
};

const createWorkerRpcClient = <TMessage extends WorkerMessageData>({
  createWorker,
  expectedWorkerKind,
  fallbackErrorMessage,
  getFatalError,
  getRequestId = (data) => (typeof data.requestId === "string" ? data.requestId : null),
  isErrorMessage,
  isLogMessage = (data) => data.action === "log" || data.type === "log",
  isProgressMessage = (data) => data.action === "progress",
  isReadyMessage = (data) => data.action === "ready",
  isResponseMessage,
  messageErrorFallback,
  postMessage,
  workerErrorFallback,
}: WorkerRpcClientOptions<TMessage>): WorkerRpcClient<TMessage> => {
  let worker: WorkerTransport<TMessage> | null = null;
  let workerKey = "";
  let workerReady = false;
  const pending = new Map<WorkerRequestId, PendingRequest<TMessage>>();
  const queuedMessages: QueuedMessage[] = [];
  const readyWaiters: Array<{ reject: (err: Error) => void; resolve: (worker: WorkerTransport<TMessage>) => void }> =
    [];
  const workerRetainCounts = new Map<WorkerTransport<TMessage>, number>();

  const tracePendingRequests = (message: string, details: Record<string, unknown> = {}) => {
    for (const [requestId, request] of pending) {
      request.onTrace?.(message, {
        ...createTraceDetails(request.requestMessage, requestId, request.expectedWorkerKind),
        ...details,
      });
    }
  };

  const rejectPendingRequests = (err: Error, nextWorkerKey = "") => {
    for (const request of pending.values()) request.reject(err);
    pending.clear();
    queuedMessages.splice(0);
    for (const waiter of readyWaiters.splice(0)) waiter.reject(err);
    workerKey = nextWorkerKey;
  };

  const reset = (err?: Error) => {
    const failure = err || new Error(fallbackErrorMessage);
    tracePendingRequests("worker.reset", {
      error: failure,
      pendingCount: pending.size,
      queuedCount: queuedMessages.length,
      workerKey,
    });
    rejectPendingRequests(failure);
    if (worker && !workerRetainCounts.has(worker)) worker.terminate();
    worker = null;
    workerReady = false;
  };

  const resetForWorkerKey = (nextWorkerKey: string) => {
    if (!worker || workerKey === nextWorkerKey) return;
    tracePendingRequests("worker.resetForKey", {
      nextWorkerKey,
      pendingCount: pending.size,
      queuedCount: queuedMessages.length,
      workerKey,
    });
    rejectPendingRequests(
      createWorkerProtocolError(fallbackErrorMessage, "WORKER_UNAVAILABLE", {
        nextWorkerKey,
        phase: "worker.resetForKey",
        workerKey,
      }),
      nextWorkerKey,
    );
    if (!workerRetainCounts.has(worker)) worker.terminate();
    worker = null;
    workerReady = false;
  };

  const flushQueuedMessages = () => {
    if (!(worker && workerReady)) return;
    while (queuedMessages.length) {
      const nextMessage = queuedMessages.shift();
      if (!nextMessage) continue;
      try {
        const outboundError = validateIncomingWorkerMessage(nextMessage.message, nextMessage.expectedWorkerKind);
        if (outboundError) {
          const request = pending.get(nextMessage.requestId);
          pending.delete(nextMessage.requestId);
          request?.onTrace?.("worker.malformed", {
            ...createTraceDetails(nextMessage.message, nextMessage.requestId, nextMessage.expectedWorkerKind),
            error: outboundError,
          });
          request?.reject(outboundError);
          continue;
        }
        (postMessage || ((currentWorker, message, transferList) => currentWorker.postMessage(message, transferList)))(
          worker,
          nextMessage.message,
          nextMessage.transferList,
        );
        const request = pending.get(nextMessage.requestId);
        request?.onTrace?.(
          "worker.request.sent",
          createTraceDetails(nextMessage.message, nextMessage.requestId, nextMessage.expectedWorkerKind),
        );
      } catch (err) {
        const request = pending.get(nextMessage.requestId);
        pending.delete(nextMessage.requestId);
        request?.onTrace?.("worker.request.sendError", {
          ...createTraceDetails(nextMessage.message, nextMessage.requestId, nextMessage.expectedWorkerKind),
          error: err,
        });
        request?.reject(
          toWorkerProtocolError(err, fallbackErrorMessage, {
            operation: getMessageOperation(nextMessage.message),
            phase: "worker.request.sendError",
            requestId: String(nextMessage.requestId),
            workerKey,
          }),
        );
      }
    }
  };

  const ensureWorker = (nextWorkerKey: string) => {
    resetForWorkerKey(nextWorkerKey);
    if (worker) return worker;
    const nextWorker = createWorker();
    workerKey = nextWorkerKey;
    nextWorker.onmessage = (event) => {
      if (nextWorker !== worker) return;
      const data = (event.data || {}) as TMessage;
      const requestId = getRequestId(data);
      const request = requestId === null ? null : pending.get(requestId);
      const protocolError = validateIncomingWorkerMessage(data, request?.expectedWorkerKind || expectedWorkerKind);
      if (protocolError) {
        if (requestId !== null) pending.delete(requestId);
        if (request) {
          request.onTrace?.("worker.malformed", {
            ...createTraceDetails(data, requestId || "unknown", request.expectedWorkerKind, request.requestMessage),
            error: protocolError,
          });
          request.reject(protocolError);
        } else {
          tracePendingRequests("worker.malformed", { error: protocolError });
          reset(protocolError);
        }
        return;
      }
      if (isReadyMessage(data)) {
        workerReady = true;
        for (const waiter of readyWaiters.splice(0)) waiter.resolve(nextWorker);
        tracePendingRequests("worker.ready", {
          queuedCount: queuedMessages.length,
          workerKey,
        });
        flushQueuedMessages();
        return;
      }

      const fatal = getFatalError?.(data);
      if (fatal) {
        const err = createWorkerProtocolError(fatal.message || fallbackErrorMessage, "WORKER_FAILED", {
          phase: "worker.fatal",
          requestId: fatal.requestId === undefined || fatal.requestId === null ? undefined : String(fatal.requestId),
          workerKey,
        });
        if (fatal.requestId !== undefined && fatal.requestId !== null) {
          const fatalRequestId = String(fatal.requestId);
          const fatalRequest = pending.get(fatalRequestId);
          if (fatalRequest) {
            pending.delete(fatalRequestId);
            fatalRequest.onTrace?.("worker.crash", {
              ...createTraceDetails(fatalRequest.requestMessage, fatalRequestId, fatalRequest.expectedWorkerKind),
              error: err,
            });
            fatalRequest.reject(err);
            return;
          }
        }
        tracePendingRequests("worker.crash", { error: err });
        reset(err);
        return;
      }

      if (requestId === null) return;
      if (!request) return;

      if (isLogMessage(data)) {
        request.onTrace?.(
          "worker.log.forwarded",
          createTraceDetails(data, requestId, request.expectedWorkerKind, request.requestMessage),
        );
        request.onLog?.(data);
        return;
      }

      if (isProgressMessage(data)) {
        request.onTrace?.(
          "worker.progress",
          createTraceDetails(data, requestId, request.expectedWorkerKind, request.requestMessage),
        );
        request.onProgress?.(data);
        return;
      }

      const messageError = isErrorMessage?.(data);
      if (messageError) {
        pending.delete(requestId);
        request.onTrace?.("worker.error", {
          ...createTraceDetails(data, requestId, request.expectedWorkerKind, request.requestMessage),
          message: messageError,
        });
        request.reject(
          createWorkerProtocolError(messageError, "WORKER_FAILED", {
            operation: getMessageOperation(request.requestMessage),
            requestId: String(requestId),
            workerKind: data.workerKind,
          }),
        );
        return;
      }

      if (!isResponseMessage(data)) return;
      pending.delete(requestId);
      request.onTrace?.(
        "worker.result",
        createTraceDetails(data, requestId, request.expectedWorkerKind, request.requestMessage),
      );
      request.resolve({ data, worker: nextWorker });
    };
    nextWorker.onerror = (event) => {
      if (nextWorker !== worker) {
        nextWorker.terminate();
        return;
      }
      const err = createWorkerProtocolError(
        getWorkerEventErrorMessage(workerErrorFallback || fallbackErrorMessage, event),
        "WORKER_FAILED",
        {
          phase: "worker.onerror",
          ...getWorkerEventErrorDetails(event, nextWorker),
          workerKey,
        },
      );
      tracePendingRequests("worker.crash", { error: err });
      reset(err);
    };
    nextWorker.onmessageerror = (event) => {
      if (nextWorker !== worker) {
        nextWorker.terminate();
        return;
      }
      const err = createWorkerProtocolError(
        getWorkerEventErrorMessage(messageErrorFallback || fallbackErrorMessage, event),
        "WORKER_FAILED",
        {
          phase: "worker.onmessageerror",
          ...getWorkerEventErrorDetails(event, nextWorker),
          workerKey,
        },
      );
      tracePendingRequests("worker.malformed", { error: err });
      reset(err);
    };
    worker = nextWorker;
    workerReady = false;
    return nextWorker;
  };

  return {
    prime(options) {
      const nextWorkerKey = options?.workerKey || "";
      try {
        const nextWorker = ensureWorker(nextWorkerKey);
        if (workerReady) return Promise.resolve(nextWorker);
        return new Promise<WorkerTransport<TMessage>>((resolve, reject) => {
          readyWaiters.push({ reject, resolve });
        });
      } catch (err) {
        return Promise.reject(
          toWorkerProtocolError(err, fallbackErrorMessage, {
            phase: "worker.prime",
            workerKey: nextWorkerKey,
          }),
        );
      }
    },
    request(message, options) {
      return this.requestWithWorker(message, options).then((response) => response.data);
    },
    requestWithWorker(message, options) {
      const requestId = typeof message.requestId === "string" ? message.requestId : createWorkerRequestId("request");
      const requestStartedAt = typeof message.startedAt === "number" ? message.startedAt : Date.now();
      const requestMessage = { ...message, requestId, startedAt: requestStartedAt };
      const nextExpectedWorkerKind = options?.expectedWorkerKind || expectedWorkerKind;
      const nextWorkerKey = options?.workerKey || "";
      return new Promise<WorkerRpcResponse<TMessage>>((resolve, reject) => {
        if (options?.signal?.aborted) {
          options.onTrace?.(
            "worker.request.cancel",
            createTraceDetails(requestMessage, requestId, nextExpectedWorkerKind),
          );
          reject(createWorkerCancelledError(requestId));
          return;
        }
        let abortHandler: (() => void) | null = null;
        const finish = (callback: () => void) => {
          if (abortHandler) options?.signal?.removeEventListener("abort", abortHandler);
          abortHandler = null;
          callback();
        };
        try {
          const willCreateWorker = !worker || workerKey !== nextWorkerKey;
          options?.onTrace?.("worker.ensure", {
            ...createTraceDetails(requestMessage, requestId, nextExpectedWorkerKind),
            pendingCount: pending.size,
            queuedCount: queuedMessages.length,
            willCreateWorker,
            workerKey: nextWorkerKey,
          });
          ensureWorker(nextWorkerKey);
          if (willCreateWorker) {
            options?.onTrace?.("worker.created", {
              ...createTraceDetails(requestMessage, requestId, nextExpectedWorkerKind),
              workerKey: nextWorkerKey,
            });
          }
          abortHandler = () => {
            pending.delete(requestId);
            const queuedIndex = queuedMessages.findIndex((queued) => queued.requestId === requestId);
            if (queuedIndex !== -1) queuedMessages.splice(queuedIndex, 1);
            const err = createWorkerCancelledError(requestId);
            options?.onTrace?.(
              "worker.request.cancel",
              createTraceDetails(requestMessage, requestId, nextExpectedWorkerKind),
            );
            if (worker && !workerRetainCounts.has(worker)) worker.terminate();
            worker = null;
            workerReady = false;
            finish(() => reject(err));
          };
          options?.signal?.addEventListener("abort", abortHandler, { once: true });
          pending.set(requestId, {
            expectedWorkerKind: nextExpectedWorkerKind,
            onLog: options?.onLog,
            onProgress: options?.onProgress,
            onTrace: options?.onTrace,
            reject: (err) => finish(() => reject(err)),
            requestMessage,
            resolve: (response) => finish(() => resolve(response)),
          });
          options?.onTrace?.(
            "worker.request.queued",
            createTraceDetails(requestMessage, requestId, nextExpectedWorkerKind),
          );
          queuedMessages.push({
            expectedWorkerKind: nextExpectedWorkerKind,
            message: requestMessage,
            requestId,
            transferList: options?.transferList,
          });
          flushQueuedMessages();
        } catch (err) {
          pending.delete(requestId);
          finish(() =>
            reject(
              toWorkerProtocolError(err, fallbackErrorMessage, {
                operation: getMessageOperation(requestMessage),
                phase: "worker.ensure",
                requestId: String(requestId),
                workerKey: nextWorkerKey,
              }),
            ),
          );
        }
      });
    },
    reset,
    retainWorker(retainedWorker) {
      workerRetainCounts.set(retainedWorker, (workerRetainCounts.get(retainedWorker) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const nextCount = (workerRetainCounts.get(retainedWorker) || 1) - 1;
        if (nextCount > 0) {
          workerRetainCounts.set(retainedWorker, nextCount);
          return;
        }
        workerRetainCounts.delete(retainedWorker);
        if (retainedWorker !== worker) {
          retainedWorker.terminate();
          return;
        }
        if (pending.size === 0 && queuedMessages.length === 0) {
          tracePendingRequests("worker.terminate", {
            reason: "retained worker released",
            workerKey,
          });
          retainedWorker.terminate();
          worker = null;
          workerReady = false;
        }
      };
    },
  };
};

export type { WorkerMessageData, WorkerRpcClient, WorkerRpcPrimeOptions, WorkerRpcRequestOptions, WorkerRpcResponse };
export { createWorkerProtocolError, createWorkerRpcClient, getWorkerEventErrorMessage };
