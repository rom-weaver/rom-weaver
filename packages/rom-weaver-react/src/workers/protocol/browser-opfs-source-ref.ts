import { getBrowserSourceBlob, getBrowserSourceHandle } from "../../storage/browser/browser-source-primitives.ts";
import {
  getNamedSource,
  getNamedSourceFileName,
  getNamedSourceSize,
} from "../../storage/shared/binary/source-file-utils.ts";
import { createWorkerRequestId } from "../shared/worker-request-id.ts";
import type { WorkerStorageBucket } from "../shared/worker-storage/storage-layout.ts";
import { getManagedOpfsFileHandle, removeManagedOpfsPath } from "./opfs-path.ts";

type BrowserOpfsSourceRef = {
  cleanup: () => Promise<void>;
  fileName: string;
  filePath: string;
  kind: "path";
  size?: number;
  storageKind: "opfs";
};

type WorkerAssetRoot = typeof globalThis & {
  __romWeaverWorkerBaseUrl?: string;
};

type BrowserOpfsStageResponse = {
  action: "stage-complete" | "stage-error";
  error?: { message?: string };
  fileName?: string;
  filePath?: string;
  requestId?: string;
  size?: number;
  success: boolean;
};

type BrowserOpfsStageRequest = {
  action: "stage";
  bucket?: WorkerStorageBucket;
  file?: File;
  fileHandle?: FileSystemFileHandle;
  fileName?: string;
  mountPoint: string;
  pathPrefix: string;
  requestId: string;
};

const isFileLike = (source: unknown): source is File =>
  typeof File !== "undefined" && source instanceof File && typeof source.slice === "function";

const getRecordValue = (source: unknown, key: string) =>
  source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;

const getStringRecordValue = (source: unknown, key: string) => {
  const value = getRecordValue(source, key);
  return typeof value === "string" && value.trim() ? value : "";
};

const toFileLike = (source: Blob, fileName: string): File => {
  if (isFileLike(source)) return source;
  if (typeof File !== "function") throw new Error("Browser worker Blob inputs require File support");
  return new File([source], fileName || "input.bin", {
    lastModified:
      typeof (source as Blob & { lastModified?: unknown }).lastModified === "number"
        ? (source as Blob & { lastModified: number }).lastModified
        : undefined,
    type: source.type || "application/octet-stream",
  });
};

const getByteSource = (source: unknown): Uint8Array | null => {
  if (source instanceof Uint8Array) return source;
  const bytes = getRecordValue(source, "_u8array") || getRecordValue(source, "u8array");
  return bytes instanceof Uint8Array ? bytes : null;
};

const getOpfsPathSize = async (filePath: string): Promise<number | undefined> => {
  try {
    const handle = await getManagedOpfsFileHandle(filePath, { navigatorObject: navigator });
    const file = await handle?.getFile();
    return typeof file?.size === "number" ? file.size : undefined;
  } catch (_error) {
    return undefined;
  }
};

let stagingWorker: Worker | null = null;

const resolveStagingWorkerUrl = () => {
  const fallbackUrl = new URL("../storage/browser-opfs-staging.worker.ts", import.meta.url);
  const root = globalThis as WorkerAssetRoot;
  const baseUrl = typeof root.__romWeaverWorkerBaseUrl === "string" ? root.__romWeaverWorkerBaseUrl.trim() : "";
  if (!baseUrl) return fallbackUrl;
  try {
    return new URL("browser-opfs-staging.worker.js", baseUrl);
  } catch (_error) {
    return fallbackUrl;
  }
};

const getStagingWorker = () => {
  if (typeof Worker !== "function") throw new Error("Browser OPFS source staging requires Worker support");
  if (!stagingWorker) {
    stagingWorker = new Worker(resolveStagingWorkerUrl(), {
      name: "rpjs-opfs-staging-worker",
      type: "module",
    });
  }
  return stagingWorker;
};

const requestStage = (request: BrowserOpfsStageRequest): Promise<BrowserOpfsStageResponse> => {
  const worker = getStagingWorker();
  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<BrowserOpfsStageResponse>) => {
      if (event.data?.requestId !== request.requestId) return;
      cleanup();
      resolve(event.data);
    };
    const handleError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Browser OPFS staging worker failed"));
    };
    const cleanup = () => {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };
    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage(request);
  });
};

const createBrowserOpfsSourceRef = async (
  source: unknown,
  fallbackFileName: string,
  options: { bucket?: WorkerStorageBucket; mountPoint: string; pathPrefix: string },
): Promise<BrowserOpfsSourceRef> => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
  const fileName = getNamedSourceFileName(source as Parameters<typeof getNamedSource>[0], {
    fallback: fallbackFileName,
  });
  const sizeHint = getNamedSourceSize(source as Parameters<typeof getNamedSourceSize>[0]);
  const filePath =
    (typeof directSource === "string" && directSource.trim() ? directSource : "") ||
    getStringRecordValue(directSource, "filePath") ||
    getStringRecordValue(source, "filePath");
  if (filePath)
    return {
      cleanup: async () => undefined,
      fileName,
      filePath,
      kind: "path",
      size: sizeHint ?? (await getOpfsPathSize(filePath)),
      storageKind: "opfs",
    };
  const requestId = createWorkerRequestId("opfs-stage");
  const request: BrowserOpfsStageRequest = {
    action: "stage",
    bucket: options.bucket || "input",
    fileName,
    mountPoint: options.mountPoint,
    pathPrefix: options.pathPrefix,
    requestId,
  };
  const fileHandle = getBrowserSourceHandle(directSource) || getBrowserSourceHandle(source);
  const blob = getBrowserSourceBlob(directSource) || getBrowserSourceBlob(source);
  const bytes = getByteSource(directSource) || getByteSource(source);
  if (fileHandle) request.fileHandle = fileHandle;
  else if (blob) request.file = toFileLike(blob, fileName || fallbackFileName);
  else if (bytes) request.file = new File([bytes as BlobPart], fileName || fallbackFileName);
  else throw new Error("Browser worker inputs must be File or FileSystemFileHandle values");

  const response = await requestStage(request);
  if (!(response.success && response.filePath))
    throw new Error(response.error?.message || "Browser OPFS staging failed");
  return {
    cleanup: () => removeManagedOpfsPath(response.filePath as string),
    fileName: response.fileName || fileName || fallbackFileName,
    filePath: response.filePath,
    kind: "path",
    size: response.size,
    storageKind: "opfs",
  };
};

export type { BrowserOpfsSourceRef };
export { createBrowserOpfsSourceRef };
