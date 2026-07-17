import { getManagedOpfsFileHandle } from "../protocol/opfs-path.ts";
import { getWorkerErrorMessage, postCloneSafeWorkerMessage } from "../shared/worker-message-utils.ts";

// OPFS write/truncate worker. Input staging (copying a Blob into OPFS) was retired - browser inputs now
// read directly via the per-thread FileReaderSync fast path or the OPFS proxy handle (see
// browser-opfs-source-ref). This worker only services output-side writes and truncates. The
// "stage-error" response action is kept as the generic failure reply for every action.

type StorageRequest = {
  action: "truncate" | "write";
  bytes?: Uint8Array;
  filePath?: string;
  position?: number;
  requestId?: string;
  size?: number;
};

type StorageResponse = {
  action: "stage-error" | "truncate-complete" | "write-complete";
  error?: { message: string };
  filePath?: string;
  requestId?: string;
  size?: number;
  success: boolean;
};

const workerScope = self as DedicatedWorkerGlobalScope;

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

// FileSystemSyncAccessHandle.write() may write fewer bytes than requested (the spec permits a
// short count, e.g. under quota pressure). Loop until the whole buffer lands, failing fast if a
// write makes no forward progress so a partial write can't silently corrupt the file.
const writeAllToSyncAccessHandle = (accessHandle: FileSystemSyncAccessHandle, bytes: Uint8Array, position: number) => {
  let written = 0;
  while (written < bytes.byteLength) {
    const chunk = written === 0 ? bytes : bytes.subarray(written);
    const count = accessHandle.write(chunk, { at: position + written });
    if (!(count > 0)) {
      throw new Error(
        `OPFS sync write made no progress at offset ${position + written} (${written}/${bytes.byteLength} bytes)`,
      );
    }
    written += count;
  }
};

const closeWritable = async (writable: FileSystemWritableFileStream, writeError: unknown) => {
  if (writeError && typeof writable.abort === "function") await writable.abort(writeError).catch(() => undefined);
  else await writable.close();
};

// FileSystemWritableFileStream.write requires an ArrayBuffer-backed view (BufferSource excludes
// SharedArrayBuffer-backed views). The client transfers the payload's ArrayBuffer, so `bytes` is already
// ArrayBuffer-backed in practice and toWritableBufferSource passes it through with no copy; this stays
// only as a defensive fallback for a hypothetical SharedArrayBuffer-backed payload.
const toArrayBufferBackedBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

const toWritableBufferSource = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : toArrayBufferBackedBytes(bytes);

const truncateOpfsPath = async (request: StorageRequest): Promise<StorageResponse> => {
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

const writeBytesToOpfsPath = async (request: StorageRequest): Promise<StorageResponse> => {
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
      writeAllToSyncAccessHandle(syncAccessHandle, bytes, position);
      syncAccessHandle.flush();
    } finally {
      syncAccessHandle.close();
    }
  } else {
    const writable = await fileHandle.createWritable({ keepExistingData: true });
    let writeError: unknown = null;
    try {
      await writable.write({ data: toWritableBufferSource(bytes), position, type: "write" });
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

workerScope.onmessage = (event: MessageEvent<StorageRequest>) => {
  const request = event.data || ({} as StorageRequest);
  let run: Promise<StorageResponse>;
  if (request.action === "truncate") run = truncateOpfsPath(request);
  else if (request.action === "write") run = writeBytesToOpfsPath(request);
  else run = Promise.reject(new Error(`unsupported OPFS storage action: ${String(request.action)}`));
  run
    .then((response) => postCloneSafeWorkerMessage(workerScope, response))
    .catch((error) => {
      postCloneSafeWorkerMessage(workerScope, {
        action: "stage-error",
        error: { message: getWorkerErrorMessage(error) },
        requestId: request.requestId,
        success: false,
      } satisfies StorageResponse);
    });
};
