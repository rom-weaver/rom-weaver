import { getManagedOpfsFileHandle, removeManagedOpfsPath } from "../protocol/opfs-path.ts";
import { getWorkerErrorMessage, postCloneSafeWorkerMessage } from "../shared/worker-message-utils.ts";
import {
  getWorkerStorageBucketPath,
  WORKER_OPFS_MOUNTPOINT,
  type WorkerStorageBucket,
} from "../shared/worker-storage/storage-layout.ts";

type StageRequest = {
  action: "cleanup" | "stage" | "truncate" | "write";
  bucket?: WorkerStorageBucket;
  bytes?: Uint8Array;
  file?: File;
  fileHandle?: FileSystemFileHandle;
  fileName?: string;
  filePath?: string;
  filePaths?: string[];
  mountPoint?: string;
  pathPrefix?: string;
  position?: number;
  requestId?: string;
  size?: number;
};

type StageResponse = {
  action: "cleanup-complete" | "stage-complete" | "stage-error" | "truncate-complete" | "write-complete";
  error?: { message: string };
  fileName?: string;
  filePath?: string;
  requestId?: string;
  size?: number;
  success: boolean;
};

const workerScope = self as DedicatedWorkerGlobalScope;
const CHUNK_SIZE = 8 * 1024 * 1024;
const LEADING_DOTS_REGEX = /^\.+/;
const PATH_SEPARATOR_REGEX = /[\\/]+/g;
const UNSAFE_FILE_CHARS_REGEX = /[^A-Za-z0-9._-]+/g;
const EDGE_UNDERSCORES_REGEX = /^_+|_+$/g;
const TRAILING_SLASHES_REGEX = /\/+$/;

const normalizeFileName = (fileName: string | null | undefined, fallback = "input.bin") =>
  String(fileName || fallback)
    .replace(PATH_SEPARATOR_REGEX, "_")
    .replace(UNSAFE_FILE_CHARS_REGEX, "_")
    .replace(EDGE_UNDERSCORES_REGEX, "")
    .replace(LEADING_DOTS_REGEX, "") || fallback;

const createInputPath = (request: StageRequest, fileName: string) => {
  const mountPoint = String(request.mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, "");
  const bucket = request.bucket || "input";
  const normalizedFileName = normalizeFileName(fileName);
  return getWorkerStorageBucketPath(mountPoint, bucket, normalizedFileName, normalizedFileName);
};

type SyncAccessMode = "readwrite" | "readwrite-unsafe";
type SyncCapableFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: (options?: { mode?: SyncAccessMode }) => Promise<FileSystemSyncAccessHandle>;
};

const isNoModificationAllowedError = (error: unknown) =>
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NoModificationAllowedError") ||
  String(error instanceof Error ? error.message : error || "")
    .toLowerCase()
    .includes("modifications are not allowed");

const openSyncAccessHandle = async (fileHandle: FileSystemFileHandle): Promise<FileSystemSyncAccessHandle | null> => {
  const syncCapableFileHandle = fileHandle as SyncCapableFileHandle;
  if (typeof syncCapableFileHandle.createSyncAccessHandle !== "function") return null;
  try {
    return await syncCapableFileHandle.createSyncAccessHandle({ mode: "readwrite-unsafe" });
  } catch (error) {
    if (!isNoModificationAllowedError(error)) throw error;
    return syncCapableFileHandle.createSyncAccessHandle({ mode: "readwrite" });
  }
};

const readBlobChunk = async (file: Blob, position: number) => {
  const nextPosition = Math.min(position + CHUNK_SIZE, file.size);
  return new Uint8Array(await file.slice(position, nextPosition).arrayBuffer());
};

const writeBlobToSyncAccessHandle = async (file: Blob, accessHandle: FileSystemSyncAccessHandle) => {
  // Prefetch the next chunk's (async) blob read while the current chunk's (synchronous) OPFS write
  // runs, so disk reads and OPFS writes overlap instead of strictly alternating.
  let position = 0;
  let pendingChunk = position < file.size ? readBlobChunk(file, position) : null;
  while (pendingChunk) {
    const chunkBytes = await pendingChunk;
    const nextPosition = position + chunkBytes.byteLength;
    pendingChunk = nextPosition < file.size ? readBlobChunk(file, nextPosition) : null;
    accessHandle.write(chunkBytes, { at: position });
    position = nextPosition;
  }
  accessHandle.truncate(file.size);
  accessHandle.flush();
};

const closeWritable = async (writable: FileSystemWritableFileStream, writeError: unknown) => {
  if (writeError && typeof writable.abort === "function") await writable.abort(writeError).catch(() => undefined);
  else await writable.close();
};

const toArrayBufferBackedBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

const writeBlobToOpfsPath = async (filePath: string, file: Blob) => {
  const fileHandle = await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject: navigator });
  if (!fileHandle) throw new Error("OPFS file handles are not available in this browser worker");

  const syncAccessHandle = await openSyncAccessHandle(fileHandle).catch((error) => {
    if (isNoModificationAllowedError(error)) return null;
    throw error;
  });
  if (syncAccessHandle) {
    try {
      await writeBlobToSyncAccessHandle(file, syncAccessHandle);
      return;
    } finally {
      syncAccessHandle.close();
    }
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false });
  let writeError: unknown = null;
  try {
    let position = 0;
    while (position < file.size) {
      const nextPosition = Math.min(position + CHUNK_SIZE, file.size);
      const chunkBytes = new Uint8Array(await file.slice(position, nextPosition).arrayBuffer());
      await writable.write({ data: chunkBytes, position, type: "write" });
      position = nextPosition;
    }
    await writable.truncate(file.size);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    await closeWritable(writable, writeError);
  }
};

const truncateOpfsPath = async (request: StageRequest): Promise<StageResponse> => {
  const filePath = String(request.filePath || "").trim();
  if (!filePath) throw new Error("Browser OPFS truncate requires a file path");
  const fileHandle = await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject: navigator });
  if (!fileHandle) throw new Error("OPFS file handles are not available in this browser worker");
  const size = Math.max(0, Math.floor(request.size || 0));
  const syncAccessHandle = await openSyncAccessHandle(fileHandle).catch((error) => {
    if (isNoModificationAllowedError(error)) return null;
    throw error;
  });
  if (syncAccessHandle) {
    try {
      syncAccessHandle.truncate(size);
      syncAccessHandle.flush();
    } finally {
      syncAccessHandle.close();
    }
  } else {
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    let writeError: unknown = null;
    try {
      await writable.truncate(size);
    } catch (error) {
      writeError = error;
      throw error;
    } finally {
      await closeWritable(writable, writeError);
    }
  }
  return {
    action: "truncate-complete",
    filePath,
    requestId: request.requestId,
    size,
    success: true,
  };
};

const writeBytesToOpfsPath = async (request: StageRequest): Promise<StageResponse> => {
  const filePath = String(request.filePath || "").trim();
  if (!filePath) throw new Error("Browser OPFS write requires a file path");
  const bytes = request.bytes;
  if (!(bytes instanceof Uint8Array)) throw new Error("Browser OPFS write requires Uint8Array bytes");
  const fileHandle = await getManagedOpfsFileHandle(filePath, { create: true, navigatorObject: navigator });
  if (!fileHandle) throw new Error("OPFS file handles are not available in this browser worker");
  const position = Math.max(0, Math.floor(request.position || 0));
  const syncAccessHandle = await openSyncAccessHandle(fileHandle).catch((error) => {
    if (isNoModificationAllowedError(error)) return null;
    throw error;
  });
  if (syncAccessHandle) {
    try {
      syncAccessHandle.write(bytes, { at: position });
      syncAccessHandle.flush();
    } finally {
      syncAccessHandle.close();
    }
  } else {
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    let writeError: unknown = null;
    try {
      await writable.write({ data: toArrayBufferBackedBytes(bytes), position, type: "write" });
    } catch (error) {
      writeError = error;
      throw error;
    } finally {
      await closeWritable(writable, writeError);
    }
  }
  return {
    action: "write-complete",
    filePath,
    requestId: request.requestId,
    size: bytes.byteLength,
    success: true,
  };
};

const stageSource = async (request: StageRequest): Promise<StageResponse> => {
  const sourceFile = request.file || (request.fileHandle ? await request.fileHandle.getFile() : null);
  if (!sourceFile) throw new Error("Browser OPFS staging requires a File or FileSystemFileHandle");
  const fileName = normalizeFileName(request.fileName || sourceFile.name, "input.bin");
  const filePath = request.filePath || createInputPath(request, fileName);
  await writeBlobToOpfsPath(filePath, sourceFile);
  return {
    action: "stage-complete",
    fileName,
    filePath,
    requestId: request.requestId,
    size: sourceFile.size,
    success: true,
  };
};

const cleanupPaths = async (request: StageRequest): Promise<StageResponse> => {
  await Promise.all((request.filePaths || []).map((filePath) => removeManagedOpfsPath(filePath, navigator)));
  return {
    action: "cleanup-complete",
    requestId: request.requestId,
    success: true,
  };
};

workerScope.onmessage = (event: MessageEvent<StageRequest>) => {
  const request = event.data || ({} as StageRequest);
  let run: Promise<StageResponse>;
  if (request.action === "cleanup") run = cleanupPaths(request);
  else if (request.action === "truncate") run = truncateOpfsPath(request);
  else if (request.action === "write") run = writeBytesToOpfsPath(request);
  else run = stageSource(request);
  run
    .then((response) => postCloneSafeWorkerMessage(workerScope, response))
    .catch((error) => {
      postCloneSafeWorkerMessage(workerScope, {
        action: "stage-error",
        error: { message: getWorkerErrorMessage(error) },
        requestId: request.requestId,
        success: false,
      } satisfies StageResponse);
    });
};
