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

export { postCloneSafeWorkerMessage };
