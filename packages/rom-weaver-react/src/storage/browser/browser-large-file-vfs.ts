import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { requestBrowserOpfsStorage } from "../../workers/protocol/browser-opfs-worker-client.ts";
import { getVfsRelativePath, normalizeAbsoluteVfsPath, normalizeVfsRoot } from "../vfs/path.ts";
import type { LargeFileVfs, VfsOutputRef, VfsStat } from "../vfs/types.ts";
import { writeBlobToFileHandle } from "./file-handle-write.ts";

type BrowserLargeFileVfsOptions = {
  navigatorObject?: Pick<Navigator, "storage"> | null;
  rootPath?: string;
};

const toUint8Array = (source: ArrayBuffer | ArrayBufferView | Uint8Array) => {
  if (source instanceof Uint8Array) return source;
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  return new Uint8Array(source);
};

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
    let fileHandle = await resolveFileHandle(normalizedPath, false);
    if (!fileHandle) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await wait(25 * (attempt + 1));
        fileHandle = await resolveFileHandle(normalizedPath, false);
        if (fileHandle) break;
      }
    }
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
      saveAs: async (destination) => {
        const file = await getOutputFile();
        const destinationFileHandle = getDestinationFileHandle(destination);
        if (!destinationFileHandle) {
          const destinationFileName = getDestinationFileName(destination);
          const downloadBlob = destinationFileName ? new Blob([file], { type: "application/octet-stream" }) : file;
          triggerBrowserDownload(downloadBlob, destinationFileName || fileName);
          return;
        }
        await writeBlobToFileHandle(destinationFileHandle, file);
      },
      size: knownSize ?? initialFile?.size ?? 0,
      timing: input.timing,
      vfs,
    };
  };

  const vfs: LargeFileVfs = {
    createOutputRef,
    hostKind: "browser-opfs",
    normalizePath: (filePath) => normalizeAbsoluteVfsPath(filePath, rootPath),
    read: async (filePath, buffer, options) => {
      const normalizedPath = normalizeAbsoluteVfsPath(filePath, rootPath);
      const target = toUint8Array(buffer);
      const bufferOffset =
        typeof options?.bufferOffset === "number" && options.bufferOffset > 0 ? Math.floor(options.bufferOffset) : 0;
      const fileOffset =
        typeof options?.fileOffset === "number" && options.fileOffset > 0 ? Math.floor(options.fileOffset) : 0;
      const length =
        typeof options?.length === "number"
          ? Math.max(0, Math.min(Math.floor(options.length), target.byteLength - bufferOffset))
          : Math.max(0, target.byteLength - bufferOffset);
      if (!length) return 0;
      let cached = readCache.get(normalizedPath);
      if (!cached) {
        const fileHandle = await resolveFileHandle(normalizedPath, false);
        if (!fileHandle) return 0;
        cached = { file: await fileHandle.getFile(), fileHandle };
        readCache.set(normalizedPath, cached);
      }
      const bytes = new Uint8Array(await cached.file.slice(fileOffset, fileOffset + length).arrayBuffer());
      target.set(bytes, bufferOffset);
      return bytes.byteLength;
    },
    remove: async (filePath) => {
      invalidateReadCache(normalizeAbsoluteVfsPath(filePath, rootPath));
      const directory = await getRootDirectory();
      const relativePath = getVfsRelativePath(filePath, rootPath);
      const segments = relativePath ? relativePath.split("/") : [];
      const fileName = segments.pop();
      if (!fileName) return;
      let currentDirectory = directory;
      try {
        for (const segment of segments)
          currentDirectory = await currentDirectory.getDirectoryHandle(segment, { create: false });
        await currentDirectory.removeEntry(fileName, { recursive: true });
      } catch (_error) {
        /* ignore cleanup errors */
      }
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
      const payload = new Uint8Array(data.byteLength);
      payload.set(data);
      const fileOffset =
        typeof options?.fileOffset === "number" && options.fileOffset > 0 ? Math.floor(options.fileOffset) : 0;
      const response = await requestBrowserOpfsStorage({
        action: "write",
        bytes: payload,
        filePath: normalizedPath,
        position: fileOffset,
      });
      if (!response.success) throw new Error(response.error?.message || `Browser VFS write failed: ${normalizedPath}`);
      return data.byteLength;
    },
  };

  return vfs;
};

export type { BrowserLargeFileVfsOptions };
export { createBrowserLargeFileVfs };
