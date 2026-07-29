import { getManagedOpfsFileHandle, removeManagedOpfsPath } from "../protocol/opfs-path.ts";
import { getWorkerErrorMessage, postCloneSafeWorkerMessage } from "../shared/worker-message-utils.ts";

// OPFS list/write/truncate/cleanup worker. Input staging (copying a Blob into OPFS) was retired - browser
// inputs now read directly via the per-thread FileReaderSync fast path or the OPFS proxy handle (see
// browser-opfs-source-ref). The "stage-error" response action is kept as the generic failure reply.

type StorageRequest = {
  action: "list" | "remove" | "truncate" | "write";
  bytes?: Uint8Array;
  filePath?: string;
  position?: number;
  requestId?: string;
  size?: number;
};

type StorageResponse = {
  action: "list-complete" | "remove-complete" | "stage-error" | "truncate-complete" | "write-complete";
  entries?: Array<{ kind: "directory" | "file"; path: string; size?: number }>;
  error?: { message: string };
  filePath?: string;
  requestId?: string;
  size?: number;
  success: boolean;
};

const workerScope = self as DedicatedWorkerGlobalScope;

const REMOVE_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

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

const removeOpfsPath = async (request: StorageRequest): Promise<StorageResponse> => {
  const filePath = String(request.filePath || "").trim();
  if (!filePath) throw new Error("Browser OPFS remove requires a path");
  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeManagedOpfsPath(filePath, navigator, { ignoreErrors: false });
      return {
        action: "remove-complete",
        filePath,
        requestId: request.requestId,
        success: true,
      };
    } catch (error) {
      const delay = REMOVE_BUSY_RETRY_DELAYS_MS[attempt];
      if ((error as { name?: string } | null)?.name !== "NoModificationAllowedError" || delay === undefined)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

const listOpfsPaths = async (request: StorageRequest): Promise<StorageResponse> => {
  const root = await navigator.storage.getDirectory();
  const entries: Array<{ kind: "directory" | "file"; path: string; size?: number }> = [];
  const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, handle] of directory.entries()) {
      const path = `${prefix}/${name}`;
      if (handle.kind === "directory") {
        entries.push({ kind: "directory", path });
        await walk(handle, path);
      } else {
        entries.push({ kind: "file", path, size: (await handle.getFile()).size });
      }
    }
  };
  await walk(root, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    action: "list-complete",
    entries,
    requestId: request.requestId,
    success: true,
  };
};

workerScope.onmessage = (event: MessageEvent<StorageRequest>) => {
  const request = event.data || ({} as StorageRequest);
  let run: Promise<StorageResponse>;
  if (request.action === "list") run = listOpfsPaths(request);
  else if (request.action === "remove") run = removeOpfsPath(request);
  else if (request.action === "truncate") run = truncateOpfsPath(request);
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
