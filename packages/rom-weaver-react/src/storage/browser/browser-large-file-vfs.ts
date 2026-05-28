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

const createBrowserLargeFileVfs = (options: BrowserLargeFileVfsOptions = {}): LargeFileVfs => {
  const rootPath = normalizeVfsRoot(options.rootPath);
  const navigatorObject = options.navigatorObject || globalThis.navigator;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const file = await fileHandle.getFile();
    return {
      checksums: input.checksums,
      dispose: async () => undefined,
      fileName,
      mediaType: input.mediaType || file.type || undefined,
      path: normalizedPath,
      saveAs: async (destination) => {
        if (!destination) {
          triggerBrowserDownload(file, fileName);
          return;
        }
        if (typeof destination !== "object" || !("createWritable" in destination))
          throw new Error("Browser VFS outputs require a FileSystemFileHandle destination");
        await writeBlobToFileHandle(destination as FileSystemFileHandle, file);
      },
      size: typeof input.size === "number" ? input.size : file.size,
      vfs,
    };
  };

  const vfs: LargeFileVfs = {
    createOutputRef,
    hostKind: "browser-opfs",
    normalizePath: (filePath) => normalizeAbsoluteVfsPath(filePath, rootPath),
    read: async (filePath, buffer, options) => {
      const normalizedPath = normalizeAbsoluteVfsPath(filePath, rootPath);
      const fileHandle = await resolveFileHandle(normalizedPath, false);
      if (!fileHandle) return 0;
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
      const blob = await fileHandle.getFile();
      const bytes = new Uint8Array(await blob.slice(fileOffset, fileOffset + length).arrayBuffer());
      target.set(bytes, bufferOffset);
      return bytes.byteLength;
    },
    remove: async (filePath) => {
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
