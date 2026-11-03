import OPFS_PROXY_WORKER_URL from "../../wasm/workers/browser-opfs-proxy-worker.ts?worker&url";
import { createWorkerRequestId } from "../../workers/shared/worker-request-id.ts";

type KeptRomFileRequest = {
  type: "kept-rom-file";
  action: "write" | "read" | "list" | "remove" | "release";
  requestId: string;
  name?: string;
  blob?: Blob;
  snapshotId?: string;
};

type KeptRomFileResponse = {
  type: "kept-rom-file-result";
  requestId: string;
  names?: string[];
  blob?: Blob;
  error?: { name: string; message: string };
};

const requestKeptRomFile = (
  request: Omit<KeptRomFileRequest, "type" | "requestId">,
  signal?: AbortSignal,
): Promise<KeptRomFileResponse> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = new Worker(OPFS_PROXY_WORKER_URL, { type: "module", name: "rw-kept-rom-file" });
    const requestId = createWorkerRequestId("kept-rom");
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Keeping or reading the ROM took too long. Try again."));
    }, 300_000);
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Kept ROM storage is unavailable."));
    };
    worker.onmessageerror = () => {
      cleanup();
      reject(new Error("The kept ROM could not be read."));
    };
    worker.onmessage = (event: MessageEvent<KeptRomFileResponse>) => {
      if (settled || event.data?.type !== "kept-rom-file-result" || event.data.requestId !== requestId) return;
      cleanup();
      if (event.data.error) reject(new DOMException(event.data.error.message, event.data.error.name));
      else resolve(event.data);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage({ ...request, requestId, type: "kept-rom-file" } satisfies KeptRomFileRequest);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });

export { requestKeptRomFile };
export type { KeptRomFileRequest, KeptRomFileResponse };
