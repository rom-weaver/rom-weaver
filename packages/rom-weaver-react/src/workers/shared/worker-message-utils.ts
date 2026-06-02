import { getFileNameExtension } from "../../lib/path-utils.ts";
import { normalizeSafeFileName } from "../../storage/shared/path-utils.ts";
import type { LogDetails, LogLevel } from "../../types/logging.ts";
import type { WorkerKind } from "../../types/worker-messages.ts";
import type { WorkerRequestId } from "../protocol/worker-protocol.ts";
import { now } from "./worker-timing.ts";

type WorkerMessageValue = object | string | number | boolean | null | undefined;
type WorkerMessageRecord = Record<string, WorkerMessageValue>;

type WorkerPostScope = {
  postMessage(message: WorkerMessageValue, transfer?: StructuredSerializeOptions | Transferable[]): void;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  __romWeaverWorkerKind?: WorkerKind;
};

const getScopeWorkerKind = (scope: WorkerPostScope): WorkerKind | undefined => scope.__romWeaverWorkerKind;
const getWorkerMessageNow = () => now();

const stampWorkerTransportMessage = <T>(message: T): T => {
  if (!message || typeof message !== "object") return message;
  if ("timestamp" in (message as Record<string, unknown>)) return message;
  return {
    ...(message as WorkerMessageRecord),
    timestamp: getWorkerMessageNow(),
  } as T;
};

const createWorkerErrorPayload = <T>(scope: WorkerPostScope, error: T, requestId?: WorkerRequestId) => ({
  code: "WORKER_FAILED" as const,
  details: {
    requestId: requestId === undefined ? undefined : String(requestId),
    workerKind: getScopeWorkerKind(scope),
  },
  message: getWorkerErrorMessage(error),
});

const normalizeWorkerRequestId = (
  requestId: WorkerRequestId | number | null | undefined,
): WorkerRequestId | undefined => (requestId === null || requestId === undefined ? undefined : String(requestId));

const getWorkerErrorMessage = <T>(error: T): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.stack || error.message;
  if (error && typeof error === "object") {
    const message = "message" in error ? (error as { message?: WorkerMessageValue }).message : null;
    if (typeof message === "string" && message) return message;
    const stack = "stack" in error ? (error as { stack?: WorkerMessageValue }).stack : null;
    if (typeof stack === "string" && stack) return stack;
    const name = "name" in error ? (error as { name?: WorkerMessageValue }).name : null;
    const errno = "errno" in error ? (error as { errno?: WorkerMessageValue }).errno : null;
    if (name === "ErrnoError" && (typeof errno === "number" || typeof errno === "string")) {
      if (String(errno) === "2") return "Worker filesystem file not found while preparing disc output.";
      return `Worker filesystem error ${errno} while preparing disc output.`;
    }
    try {
      return JSON.stringify(error);
    } catch (_err) {
      return String(error);
    }
  }
  return error ? String(error) : "Worker crashed";
};

const postFatalWorkerError = <T>(scope: WorkerPostScope, error: T, requestId?: WorkerRequestId) => {
  const normalizedRequestId = normalizeWorkerRequestId(requestId);
  const errorPayload = createWorkerErrorPayload(scope, error, normalizedRequestId);
  postCloneSafeWorkerMessage(scope, {
    action: "fatal",
    code: errorPayload.code,
    details: errorPayload.details,
    error: errorPayload,
    message: errorPayload.message,
    requestId: normalizedRequestId,
    success: false,
    type: "error",
    workerKind: getScopeWorkerKind(scope),
  });
};

const postWorkerReady = (scope: WorkerPostScope) => {
  const workerKind = getScopeWorkerKind(scope);
  postCloneSafeWorkerMessage(scope, {
    action: "ready",
    type: "ready",
    workerKind,
  });
};

const postWorkerError = <T>(
  scope: WorkerPostScope,
  action: string,
  error: T,
  requestId?: WorkerRequestId,
  fields?: WorkerMessageRecord,
) => {
  const errorPayload = createWorkerErrorPayload(scope, error, requestId);
  postCloneSafeWorkerMessage(scope, {
    action,
    code: errorPayload.code,
    details: { ...errorPayload.details, ...(fields || {}) },
    error: {
      ...errorPayload,
      details: { ...errorPayload.details, ...(fields || {}) },
    },
    message: errorPayload.message,
    requestId: normalizeWorkerRequestId(requestId),
    success: false,
    type: "error",
    workerKind: getScopeWorkerKind(scope),
    ...(fields || {}),
  });
};

const postWorkerProgress = (
  scope: WorkerPostScope,
  requestId: WorkerRequestId | undefined,
  progress: WorkerMessageValue,
) => {
  postCloneSafeWorkerMessage(scope, {
    action: "progress",
    progress,
    requestId: normalizeWorkerRequestId(requestId),
    type: "progress",
    workerKind: getScopeWorkerKind(scope),
  });
};

const postWorkerLog = (
  scope: WorkerPostScope,
  requestId: WorkerRequestId | undefined,
  level: Exclude<LogLevel, "off">,
  namespace: string,
  message: string,
  details?: LogDetails,
) => {
  postCloneSafeWorkerMessage(scope, {
    action: "log",
    log: {
      details,
      level,
      message,
      namespace,
      timestamp: new Date().toISOString(),
    },
    requestId: normalizeWorkerRequestId(requestId),
    type: "log",
    workerKind: getScopeWorkerKind(scope),
  });
};

const attachWorkerFatalHandlers = (scope: WorkerPostScope, getErrorMessage?: (value: unknown) => string) => {
  const normalizeError = getErrorMessage || getWorkerErrorMessage;
  scope.addEventListener?.("error", (event) => {
    const workerEvent = event as ErrorEvent;
    postFatalWorkerError(scope, workerEvent.error || workerEvent.message || workerEvent);
  });
  scope.addEventListener?.("unhandledrejection", (event) => {
    const rejectionEvent = event as PromiseRejectionEvent;
    postFatalWorkerError(scope, normalizeError(rejectionEvent.reason));
  });
};

const removeUncloneableWorkerResponseFields = <T>(message: T) => {
  if (!message || typeof message !== "object") return null;
  const sanitized = { ...(message as WorkerMessageRecord) };
  let changed = false;
  for (const key of ["fileHandle", "patchedRomFileHandle"]) {
    if (key in sanitized) {
      delete sanitized[key];
      changed = true;
    }
  }
  const outputRef = sanitized.outputRef;
  if (outputRef && typeof outputRef === "object" && "fileHandle" in outputRef) {
    sanitized.outputRef = { ...(outputRef as Record<string, WorkerMessageValue>) };
    delete (sanitized.outputRef as Record<string, WorkerMessageValue>).fileHandle;
    changed = true;
  }
  return changed ? sanitized : null;
};

const postCloneSafeWorkerMessage = <T>(
  scope: WorkerPostScope,
  message: T,
  transfer?: StructuredSerializeOptions | Transferable[],
) => {
  const stampedMessage = stampWorkerTransportMessage(message);
  try {
    scope.postMessage(stampedMessage as WorkerMessageValue, transfer);
  } catch (err) {
    const sanitized = removeUncloneableWorkerResponseFields(stampedMessage);
    if (!sanitized) throw err;
    scope.postMessage(sanitized, transfer);
  }
};

const normalizeWorkerFileName = (fileName: WorkerMessageValue, fallback: WorkerMessageValue) =>
  normalizeSafeFileName(fileName, fallback);

const getWorkerFileExtension = (fileName: WorkerMessageValue, fallback: string) => {
  return (
    getFileNameExtension(normalizeWorkerFileName(fileName, fallback || "input.bin"), { includeDot: true }) || fallback
  );
};

export {
  attachWorkerFatalHandlers,
  getWorkerErrorMessage,
  getWorkerFileExtension,
  normalizeWorkerFileName,
  normalizeWorkerRequestId,
  postCloneSafeWorkerMessage,
  postFatalWorkerError,
  postWorkerError,
  postWorkerLog,
  postWorkerProgress,
  postWorkerReady,
  stampWorkerTransportMessage,
};
