import { createWorkerRequestId } from "../shared/worker-request-id.ts";
import type { WorkerStorageBucket } from "../shared/worker-storage/storage-layout.ts";

type WorkerAssetRoot = typeof globalThis & {
  __romWeaverWorkerBaseUrl?: string;
};

type BrowserOpfsStorageAction = "cleanup" | "stage" | "truncate" | "write";

type BrowserOpfsStorageRequest = {
  action: BrowserOpfsStorageAction;
  bucket?: WorkerStorageBucket;
  bytes?: Uint8Array;
  file?: Blob;
  fileName?: string;
  filePath?: string;
  filePaths?: string[];
  mountPoint?: string;
  pathPrefix?: string;
  position?: number;
  requestId?: string;
  size?: number;
};

type BrowserOpfsStorageResponse = {
  action: "cleanup-complete" | "stage-complete" | "stage-error" | "truncate-complete" | "write-complete";
  error?: { message?: string };
  fileName?: string;
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
    } catch (_error) {
      // Fall through to the bundled worker.
    }
  }
  return new Worker(new URL("../storage/browser-opfs-staging.worker.ts", import.meta.url), {
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
  const worker = getOpfsWorker();
  const requestId = request.requestId || createWorkerRequestId(`opfs-${request.action}`);
  const message = { ...request, requestId };
  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<BrowserOpfsStorageResponse>) => {
      if (event.data?.requestId !== requestId) return;
      cleanup();
      resolve(event.data);
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Browser OPFS storage worker failed"));
    };
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage(message);
  });
};

export type { BrowserOpfsStorageRequest, BrowserOpfsStorageResponse };
export { requestBrowserOpfsStorage };
