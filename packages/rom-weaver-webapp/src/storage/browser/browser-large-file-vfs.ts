import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { requestBrowserOpfsStorage } from "../../workers/protocol/browser-opfs-worker-client.ts";
import { createLogger } from "../../lib/logging.ts";
import { getVfsRelativePath, normalizeAbsoluteVfsPath, normalizeVfsRoot } from "../vfs/path.ts";
import type { LargeFileVfs, VfsOutputRef, VfsStat } from "../vfs/types.ts";
import { writeBlobToFileHandle } from "./file-handle-write.ts";

type BrowserLargeFileVfsOptions = {
  navigatorObject?: Pick<Navigator, "storage"> | null;
  rootPath?: string;
};

const logger = createLogger("browser-large-file-vfs");

const toUint8Array = (source: ArrayBuffer | ArrayBufferView | Uint8Array) => {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return new Uint8Array(source);
};

const getDestinationInteractive = (destination: unknown) =>
  !!destination && typeof destination === "object" && "interactive" in destination && destination.interactive === true;

const getDestinationFileName = (destination: unknown) => {
  if (!destination || typeof destination !== "object" || !("fileName" in destination)) return "";
  const fileName = (destination as { fileName?: unknown }).fileName;
  return typeof fileName === "string" ? fileName.trim() : "";
};

const getDestinationFileHandle = (destination: unknown) => {
  if (!destination || typeof destination !== "object") return null;
  if ("createWritable" in destination) return destination as FileSystemFileHandle;
  if ("fileHandle" in destination) {
    const fileHandle = (destination as { fileHandle?: unknown }).fileHandle;
    return fileHandle && typeof fileHandle === "object" && "createWritable" in fileHandle
      ? (fileHandle as FileSystemFileHandle)
      : null;
  }
  return null;
};

/**
 * Write the snapshot where the destination asks: into a picked file handle when
 * there is one, otherwise down the browser's download path.
 */
const saveFileToDestination = async (file: File, destination: unknown, fallbackFileName: string) => {
  const destinationFileHandle = getDestinationFileHandle(destination);
  if (destinationFileHandle) {
    await writeBlobToFileHandle(destinationFileHandle, file);
    return;
  }
  const destinationFileName = getDestinationFileName(destination);
  const downloadBlob = destinationFileName ? new Blob([file], { type: "application/octet-stream" }) : file;
  await triggerBrowserDownload(downloadBlob, destinationFileName || fallbackFileName, {
    interactive: getDestinationInteractive(destination),
  });
};

/** Byte range a read touches, clamped to what the caller's buffer can hold. */
const resolveReadRange = (
  target: Uint8Array,
  options: { bufferOffset?: number; fileOffset?: number; length?: number } | undefined,
) => {
  const bufferOffset =
    typeof options?.bufferOffset === "number" && options.bufferOffset > 0 ? Math.floor(options.bufferOffset) : 0;
  const fileOffset =
    typeof options?.fileOffset === "number" && options.fileOffset > 0 ? Math.floor(options.fileOffset) : 0;
  const available = Math.max(0, target.byteLength - bufferOffset);
  const length =
    typeof options?.length === "number" ? Math.max(0, Math.min(Math.floor(options.length), available)) : available;
  return { bufferOffset, fileOffset, length };
};

// OPFS refuses `removeEntry` with NoModificationAllowedError while any SyncAccessHandle is still
// open on the entry. The proxy closes a run's handles asynchronously once the run reports done, so
// cleanup that fires immediately after a run can land inside that window - observed closing within
// ~500ms. Retry across it rather than leaking the entry; the first attempt succeeds in the common
// case, so this costs nothing when nothing holds the file.
const REMOVE_BUSY_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

const createBrowserLargeFileVfs = (options: BrowserLargeFileVfsOptions = {}): LargeFileVfs => {
  const rootPath = normalizeVfsRoot(options.rootPath);
  const navigatorObject = options.navigatorObject || globalThis.navigator;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Per-path read cache. The WASM input read path issues many small reads against the same
  // staged file; without this every read re-walks the OPFS directory tree (one async handle
  // lookup per path segment) and re-snapshots the File via getFile(). On Safari those calls
  // dominate the read cost. A cached File is a point-in-time snapshot, so every local mutation
  // (write/truncate/remove) MUST invalidate the entry or a later read could serve stale bytes.
  const readCache = new Map<string, { file: File; fileHandle: FileSystemFileHandle }>();
  const invalidateReadCache = (normalizedPath: string) => {
    readCache.delete(normalizedPath);
  };

  const getRootDirectory = async () => {
    const directory = await navigatorObject?.storage?.getDirectory?.();
    if (!directory) throw new Error("Browser OPFS is not available");
    return directory;
  };

  const resolveFileHandle = async (filePath: string, create = false): Promise<FileSystemFileHandle | null> => {
    const directory = await getRootDirectory();
    const relativePath = getVfsRelativePath(filePath, rootPath);
    const segments = relativePath ? relativePath.split("/") : [];
    const fileName = segments.pop();
    if (!fileName) throw new Error(`VFS path must point to a file: ${filePath}`);
    let currentDirectory = directory;
    try {
      for (const segment of segments) {
        currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create });
      }
      return await currentDirectory.getFileHandle(fileName, { create });
    } catch (error) {
      if (
        !create &&
        typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "NotFoundError"
      ) {
        return null;
      }
      throw error;
    }
  };

  /** Walks to the directory holding an entry; null when any segment is already gone. */
  const resolveParentDirectory = async (segments: string[]) => {
    let currentDirectory = await getRootDirectory();
    try {
      for (const segment of segments)
        currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: false });
    } catch {
      return null;
    }
    return currentDirectory;
  };

  /**
   * Remove an entry, waiting out the window where a SyncAccessHandle still holds
   * it. Any other failure is left ignored, matching the historical cleanup behavior.
   */
  const removeEntryWhenFree = async (directory: FileSystemDirectoryHandle, fileName: string) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await directory.removeEntry(fileName, { recursive: true });
        return;
      } catch (error) {
        const busy = (error as { name?: string } | null)?.name === "NoModificationAllowedError";
        const delay = REMOVE_BUSY_RETRY_DELAYS_MS[attempt];
        if (!(busy && delay !== undefined)) return;
        await wait(delay);
      }
    }
  };

  // OPFS can lag a just-finished write, so poll briefly before declaring the output missing.
  const awaitOutputHandle = async (normalizedPath: string) => {
    let fileHandle = await resolveFileHandle(normalizedPath, false);
    for (let attempt = 0; !fileHandle && attempt < 6; attempt += 1) {
      await wait(25 * (attempt + 1));
      fileHandle = await resolveFileHandle(normalizedPath, false);
    }
    return fileHandle;
  };

  const createOutputRef = async (
    filePath: string,
    fileName: string,
    input: {
      checksums?: Record<string, string>;
      cleanup?: () => Promise<void> | void;
      mediaType?: string;
      size?: number;
      timing?: VfsOutputRef["timing"];
    } = {},
  ): Promise<VfsOutputRef> => {
    const normalizedPath = normalizeAbsoluteVfsPath(filePath, rootPath);
    const fileHandle = await awaitOutputHandle(normalizedPath);
    if (!fileHandle) throw new Error(`Browser VFS output is not available: ${fileName}`);
    let cachedOutputFile: File | null = null;
    const getOutputFile = async (): Promise<File> => {
      if (cachedOutputFile) return cachedOutputFile;
      cachedOutputFile = await fileHandle.getFile();
      return cachedOutputFile;
    };
    const knownSize = typeof input.size === "number" && Number.isFinite(input.size) ? input.size : null;
    const initialFile = knownSize === null ? await getOutputFile() : null;
    return {
      checksums: input.checksums,
      dispose: async () => undefined,
      fileName,
      mediaType: input.mediaType || initialFile?.type || undefined,
      path: normalizedPath,
      // Warm the disk-backed File snapshot ahead of a user-gesture download: iOS
      // `navigator.share` needs the tap's transient activation to still be live, so the
      // tap-time `saveAs` must not spend it walking OPFS handles.
      prepareDownload: async () => {
        await getOutputFile();
      },
      saveAs: async (destination) => {
        await saveFileToDestination(await getOutputFile(), destination, fileName);
      },
      size: knownSize ?? initialFile?.size ?? 0,
      timing: input.timing,
      vfs,
    };
  };

  const vfs: LargeFileVfs = {
    createOutputRef,
    getFile: async (filePath) => {
      const fileHandle = await resolveFileHandle(normalizeAbsoluteVfsPath(filePath, rootPath), false);
      return fileHandle ? fileHandle.getFile() : null;
    },
    hostKind: "browser-opfs",
    normalizePath: (filePath) => normalizeAbsoluteVfsPath(filePath, rootPath),
    read: async (filePath, buffer, options) => {
      const normalizedPath = normalizeAbsoluteVfsPath(filePath, rootPath);
      const target = toUint8Array(buffer);
      const { bufferOffset, fileOffset, length } = resolveReadRange(target, options);
      if (!length) return 0;
      const snapshotEntry = async () => {
        const fileHandle = await resolveFileHandle(normalizedPath, false);
        if (!fileHandle) return null;
        const entry = { file: await fileHandle.getFile(), fileHandle };
        readCache.set(normalizedPath, entry);
        return entry;
      };
      let cached = readCache.get(normalizedPath) ?? (await snapshotEntry());
      if (!cached) return 0;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await cached.file.slice(fileOffset, fileOffset + length).arrayBuffer());
      } catch (error) {
        // The cached File is a point-in-time snapshot. Writers outside this VFS instance (wasm
        // worker sync access handles, the OPFS staging worker, direct navigator.storage cleanup)
        // replace entries without hitting our invalidation hooks, and reading a dead snapshot
        // throws NotReadableError. Re-resolve the handle and retry once on a fresh snapshot.
        invalidateReadCache(normalizedPath);
        cached = await snapshotEntry();
        if (!cached) throw error;
        bytes = new Uint8Array(await cached.file.slice(fileOffset, fileOffset + length).arrayBuffer());
      }
      target.set(bytes, bufferOffset);
      return bytes.byteLength;
    },
    remove: async (filePath) => {
      invalidateReadCache(normalizeAbsoluteVfsPath(filePath, rootPath));
      const relativePath = getVfsRelativePath(filePath, rootPath);
      const segments = relativePath ? relativePath.split("/") : [];
      const fileName = segments.pop();
      if (!fileName) return;
      const parent = await resolveParentDirectory(segments);
      if (!parent) return; // A missing parent directory means there is nothing left to remove.
      await removeEntryWhenFree(parent, fileName);
    },
    rootPath,
    saveAs: async (filePath, destination, fileName) => {
      await (await createOutputRef(filePath, fileName || "output.bin")).saveAs(destination);
    },
    stat: async (filePath): Promise<VfsStat | null> => {
      const normalizedPath = normalizeAbsoluteVfsPath(filePath, rootPath);
      const fileHandle = await resolveFileHandle(normalizedPath, false);
      if (!fileHandle) return null;
      const file = await fileHandle.getFile();
      return {
        path: normalizedPath,
        size: file.size,
      };
    },
    truncate: async (filePath, size) => {
      const normalizedPath = normalizeAbsoluteVfsPath(filePath, rootPath);
      invalidateReadCache(normalizedPath);
      logger.debug("OPFS path create requested", {
        creator: "browser-large-file-vfs.truncate",
        path: normalizedPath,
        size: Math.max(0, Math.floor(size || 0)),
      });
      const response = await requestBrowserOpfsStorage({
        action: "truncate",
        filePath: normalizedPath,
        size: Math.max(0, Math.floor(size || 0)),
      });
      if (!response.success)
        throw new Error(response.error?.message || `Browser VFS truncate failed: ${normalizedPath}`);
    },
    write: async (filePath, bytes, options) => {
      const normalizedPath = normalizeAbsoluteVfsPath(filePath, rootPath);
      invalidateReadCache(normalizedPath);
      const data = toUint8Array(bytes);
      // `bytes` may alias memory we must not detach (a view into shared wasm linear memory), so copy into
      // a standalone, regular-ArrayBuffer payload we own. requestBrowserOpfsStorage transfers
      // `payload.buffer` to the OPFS worker (no structure-clone copy); payload must not be reused after.
      const byteLength = data.byteLength;
      const payload = new Uint8Array(byteLength);
      payload.set(data);
      const fileOffset =
        typeof options?.fileOffset === "number" && options.fileOffset > 0 ? Math.floor(options.fileOffset) : 0;
      logger.debug("OPFS path write requested", {
        creator: "browser-large-file-vfs.write",
        path: normalizedPath,
        size: byteLength,
      });
      const response = await requestBrowserOpfsStorage({
        action: "write",
        bytes: payload,
        filePath: normalizedPath,
        position: fileOffset,
      });
      if (!response.success) throw new Error(response.error?.message || `Browser VFS write failed: ${normalizedPath}`);
      return byteLength;
    },
  };

  return vfs;
};

export { createBrowserLargeFileVfs };
