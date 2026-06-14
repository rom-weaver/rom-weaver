import type { WorkerKind } from "../../types/worker-messages.ts";
import { now } from "./worker-timing.ts";

type WorkerMessageValue = object | string | number | boolean | null | undefined;
type WorkerMessageRecord = Record<string, WorkerMessageValue>;

type WorkerPostScope = {
  postMessage(message: WorkerMessageValue, transfer?: StructuredSerializeOptions | Transferable[]): void;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  __romWeaverWorkerKind?: WorkerKind;
};

const getWorkerMessageNow = () => now();

const stampWorkerTransportMessage = <T>(message: T): T => {
  if (!message || typeof message !== "object") return message;
  if ("timestamp" in (message as Record<string, unknown>)) return message;
  return {
    ...(message as WorkerMessageRecord),
    timestamp: getWorkerMessageNow(),
  } as T;
};

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

export { getWorkerErrorMessage, postCloneSafeWorkerMessage };
