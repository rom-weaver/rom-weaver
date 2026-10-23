import OPFS_PROXY_WORKER_URL from "../../wasm/workers/browser-opfs-proxy-worker.ts?worker&url";
import { createWorkerRequestId } from "../shared/worker-request-id.ts";
// `?worker&url`, never `new URL(..., import.meta.url)` - see "Worker URLs" in docs/development/ARCHITECTURE.md.
import WEAVED_STAGING_WORKER_URL from "../storage/browser-opfs-staging.worker.ts?worker&url";

type WorkerAssetRoot = typeof globalThis & {
  __romWeaverWorkerBaseUrl?: string;
};

// Input staging is retired (browser inputs read directly - see browser-opfs-source-ref), so this client
// drives OPFS listing, output-side writes, truncates, and transient-tree cleanup. "stage-error" remains the
// generic failure reply for every action.
type BrowserOpfsStorageAction = "list" | "list-metadata" | "remove" | "truncate" | "write";

type BrowserOpfsEntry = {
  kind: "directory" | "file";
  path: string;
  size?: number;
};

type BrowserOpfsStorageRequest = {
  action: BrowserOpfsStorageAction;
  bytes?: Uint8Array;
  filePath?: string;
  position?: number;
  requestId?: string;
  size?: number;
};

type BrowserOpfsStorageResponse = {
  action: "list-complete" | "remove-complete" | "stage-error" | "truncate-complete" | "write-complete";
  error?: { message?: string; name?: string };
  entries?: BrowserOpfsEntry[];
  filePath?: string;
  requestId?: string;
  size?: number;
  success: boolean;
};

let opfsWorker: Worker | null = null;

const createOpfsWorker = () => {
  const root = globalThis as WorkerAssetRoot;
  const baseUrl = typeof root.__romWeaverWorkerBaseUrl === "string" ? root.__romWeaverWorkerBaseUrl.trim() : "";
  if (baseUrl) {
    try {
      return new Worker(new URL("browser-opfs-staging.worker.js", baseUrl), {
        name: "rpjs-opfs-storage-worker",
        type: "module",
      });
    } catch {
      // Fall through to the bundled worker.
    }
  }
  return new Worker(WEAVED_STAGING_WORKER_URL, {
    name: "rpjs-opfs-storage-worker",
    type: "module",
  });
};

const getOpfsWorker = () => {
  if (typeof Worker !== "function") throw new Error("Browser OPFS storage requires Worker support");
  if (!opfsWorker) opfsWorker = createOpfsWorker();
  return opfsWorker;
};

const requestBrowserOpfsStorage = (request: BrowserOpfsStorageRequest): Promise<BrowserOpfsStorageResponse> => {
  const requestId = request.requestId || createWorkerRequestId(`opfs-${request.action}`);
  const message = { ...request, requestId };
  return new Promise((resolve, reject) => {
    // Acquire the worker inside the executor: a synchronous construction failure
    // (no Worker support, blocked worker URL) must reject so callers' staging
    // fallbacks engage instead of an unhandled throw.
    const worker = getOpfsWorker();
    const handleMessage = (event: MessageEvent<BrowserOpfsStorageResponse>) => {
      if (event.data?.requestId !== requestId) return;
      cleanup();
      resolve(event.data);
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      // A fatal worker error (blocked/failed script fetch, CSP, offline SW miss) kills the worker for
      // good: a cached dead worker silently no-ops every later postMessage, so a retry's promise would
      // never settle. Drop the cached worker so the next request respawns a fresh one. The identity guard
      // makes this idempotent across the concurrent in-flight requests that all receive this same error
      // event (only the first replaces it) - no respawn storm, and respawn is driven by the next request,
      // not a loop here.
      if (opfsWorker === worker) {
        worker.terminate();
        opfsWorker = null;
      }
      reject(new Error(event.message || "Browser OPFS storage worker failed"));
    };
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    // Transfer the write payload's buffer instead of structure-cloning it: each OPFS write ships an
    // ~8 MiB chunk and a clone would copy it on send (then the worker would copy again). The caller hands
    // us a standalone ArrayBuffer-backed copy it never touches after this call, so detaching it is safe.
    const transferableBuffer =
      message.bytes instanceof Uint8Array && message.bytes.buffer instanceof ArrayBuffer ? message.bytes.buffer : null;
    worker.postMessage(message, transferableBuffer ? [transferableBuffer] : []);
  });
};

const readBrowserOpfsPrefix = (filePath: string, length: number, signal?: AbortSignal): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("OPFS prefix read aborted", "AbortError"));
      return;
    }
    if (!Number.isInteger(length) || length < 0 || length > 16 * 2352 + 22) {
      reject(new Error("OPFS prefix length must be an integer between 0 and 37654"));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(OPFS_PROXY_WORKER_URL, {
        name: "rpjs-opfs-prefix-worker",
        type: "module",
      });
    } catch (error) {
      reject(error);
      return;
    }
    const requestId = createWorkerRequestId("opfs-prefix");
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      worker.removeEventListener("messageerror", handleMessageError);
      worker.terminate();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const handleAbort = () => fail(signal?.reason ?? new DOMException("OPFS prefix read aborted", "AbortError"));
    const handleError = (event: ErrorEvent) => fail(new Error(event.message || "OPFS prefix worker failed"));
    const handleMessageError = () => fail(new Error("OPFS prefix worker returned an unreadable message"));
    const handleMessage = (
      event: MessageEvent<{ requestId?: string; type?: string; bytes?: Uint8Array; message?: string }>,
    ) => {
      if (event.data?.requestId !== requestId) return;
      if (
        event.data.type !== "read-prefix-complete" ||
        !(event.data.bytes instanceof Uint8Array) ||
        event.data.bytes.length > length
      ) {
        fail(new Error(event.data.message || "OPFS prefix worker returned an invalid response"));
        return;
      }
      cleanup();
      resolve(event.data.bytes);
    };
    const timer = setTimeout(() => fail(new Error("OPFS prefix read timed out")), 30_000);
    signal?.addEventListener("abort", handleAbort, { once: true });
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.addEventListener("messageerror", handleMessageError);
    try {
      worker.postMessage({ type: "read-prefix", filePath, length, requestId });
    } catch (error) {
      fail(error);
    }
  });

export type { BrowserOpfsEntry };
export { readBrowserOpfsPrefix, requestBrowserOpfsStorage };
