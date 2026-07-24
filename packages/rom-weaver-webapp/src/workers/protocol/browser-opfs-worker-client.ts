import { createWorkerRequestId } from "../shared/worker-request-id.ts";
// `?worker&url`, never `new URL(..., import.meta.url)` - see "Worker URLs" in docs/ARCHITECTURE.md.
import BUNDLED_STAGING_WORKER_URL from "../storage/browser-opfs-staging.worker.ts?worker&url";

type WorkerAssetRoot = typeof globalThis & {
  __romWeaverWorkerBaseUrl?: string;
};

// Input staging is retired (browser inputs read directly - see browser-opfs-source-ref), so this client
// only drives output-side OPFS writes and truncates. "stage-error" remains the generic failure reply for
// every action.
type BrowserOpfsStorageAction = "truncate" | "write";

type BrowserOpfsStorageRequest = {
  action: BrowserOpfsStorageAction;
  bytes?: Uint8Array;
  filePath?: string;
  position?: number;
  requestId?: string;
  size?: number;
};

type BrowserOpfsStorageResponse = {
  action: "stage-error" | "truncate-complete" | "write-complete";
  error?: { message?: string };
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
  return new Worker(BUNDLED_STAGING_WORKER_URL, {
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

export { requestBrowserOpfsStorage };
