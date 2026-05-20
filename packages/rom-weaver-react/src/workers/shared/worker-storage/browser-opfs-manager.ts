import {
  getManagedOpfsFileHandle,
  getManagedOpfsStorageName,
  removeManagedOpfsPath,
} from "../../protocol/opfs-path.ts";
import type { EmscriptenFileSystem, EmscriptenWorkerModule } from "../wasm/emscripten-types.ts";
import { getParentPath } from "./path-utils.ts";
import { getWorkerStorageBucketRoot, WORKER_OPFS_MOUNTPOINT, WORKER_STORAGE_BUCKETS } from "./storage-layout.ts";
import type { OpfsBackend, WorkerOpfsManager } from "./types.ts";

type BrowserOpfsManagerOptions = {
  moduleObject?: EmscriptenWorkerModule | null;
  mountPoint: string;
  navigatorObject?: Navigator | null;
};

const COPY_CHUNK_SIZE = 1024 * 1024;
const NOT_FOUND_ERROR_REGEX = /not\s+found|object\s+can\s+not\s+be\s+found/i;
const TRAILING_POSIX_SLASHES_REGEX = /\/+$/;
const LEADING_POSIX_SLASHES_REGEX = /^\/+/;

const mountedRootsByFs = new WeakMap<EmscriptenFileSystem, Set<string>>();

const isNotFoundError = (error: unknown) =>
  typeof DOMException !== "undefined" && error instanceof DOMException
    ? error.name === "NotFoundError"
    : error instanceof Error && NOT_FOUND_ERROR_REGEX.test(error.message);

const normalizeMountPoint = (mountPoint: string) =>
  `/${String(mountPoint || WORKER_OPFS_MOUNTPOINT).replace(LEADING_POSIX_SLASHES_REGEX, "")}`
    .replace(/\/+/g, "/")
    .replace(TRAILING_POSIX_SLASHES_REGEX, "") || WORKER_OPFS_MOUNTPOINT;

const getVirtualRoot = (filePath: string, fallbackRoot: string) => {
  const normalizedPath = String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (!normalizedPath.startsWith("/")) return fallbackRoot;
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments[0] ? `/${segments[0]}` : fallbackRoot;
};

const ensureDirectory = (FS: EmscriptenFileSystem, directory: string) => {
  if (directory && directory !== "/") FS.mkdirTree(directory);
};

const ensureBucketDirectories = (FS: EmscriptenFileSystem, mountPoint: string) => {
  for (const bucket of WORKER_STORAGE_BUCKETS) {
    try {
      FS.mkdirTree(getWorkerStorageBucketRoot(mountPoint, bucket));
    } catch (_error) {
      /* ignore existing bucket directories */
    }
  }
};

const getMountedRoots = (FS: EmscriptenFileSystem) => {
  let roots = mountedRootsByFs.get(FS);
  if (!roots) {
    roots = new Set();
    mountedRootsByFs.set(FS, roots);
  }
  return roots;
};

const createManagedBackend = async ({
  create,
  filePath,
  navigatorObject,
  truncate,
}: {
  create: boolean;
  filePath: string;
  navigatorObject?: Navigator | null;
  truncate?: boolean;
}): Promise<OpfsBackend | null> => {
  let fileHandle: FileSystemFileHandle | null = null;
  try {
    fileHandle = await getManagedOpfsFileHandle(filePath, { create, navigatorObject });
  } catch (error) {
    if (!create && isNotFoundError(error)) return null;
    throw error;
  }
  if (!(fileHandle && typeof fileHandle.createSyncAccessHandle === "function")) return null;
  let accessHandle: FileSystemSyncAccessHandle;
  try {
    accessHandle = await fileHandle.createSyncAccessHandle();
  } catch (error) {
    throw new Error(
      `Browser OPFS manager createSyncAccessHandle failed for ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (truncate) {
    accessHandle.truncate(0);
    accessHandle.flush();
  }
  const size = truncate
    ? 0
    : typeof accessHandle.getSize === "function"
      ? accessHandle.getSize()
      : (await fileHandle.getFile()).size;
  return {
    accessHandle,
    closed: false,
    deleteQueued: false,
    fileHandle,
    size,
    storageName: getManagedOpfsStorageName(filePath),
    timestamp: Date.now(),
  };
};

const createBrowserOpfsStorageManager = async ({
  moduleObject,
  mountPoint,
  navigatorObject,
}: BrowserOpfsManagerOptions): Promise<WorkerOpfsManager | null> => {
  if (!(navigatorObject?.storage && typeof navigatorObject.storage.getDirectory === "function")) return null;
  await navigatorObject.storage.getDirectory();

  const normalizedMountPoint = normalizeMountPoint(mountPoint);
  const prepared: Record<string, OpfsBackend> = {};
  const writeObservers = new Set<(filePath: string, rangeStart: number, rangeEnd: number) => void>();
  let activeFs: EmscriptenFileSystem | null = moduleObject?.FS || null;
  let activeModuleObject: EmscriptenWorkerModule | null = moduleObject || null;

  const requireFs = () => {
    if (!activeFs) throw new Error("Worker filesystem is not mounted");
    return activeFs;
  };

  const closeBackend = (backend?: OpfsBackend | null) => {
    if (!backend || backend.closed) return;
    try {
      backend.accessHandle.flush();
    } catch (_error) {
      /* ignore cleanup errors */
    }
    try {
      backend.accessHandle.close();
    } catch (_error) {
      /* ignore cleanup errors */
    }
    backend.closed = true;
  };

  const reopenBackend = async (backend?: OpfsBackend | null) => {
    if (
      !(
        backend &&
        backend.closed &&
        backend.fileHandle &&
        typeof backend.fileHandle.createSyncAccessHandle === "function"
      )
    )
      return backend || null;
    let accessHandle: FileSystemSyncAccessHandle;
    try {
      accessHandle = await backend.fileHandle.createSyncAccessHandle();
    } catch (error) {
      throw new Error(
        `Browser OPFS manager reopen createSyncAccessHandle failed for ${backend.storageName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const size =
      typeof accessHandle.getSize === "function" ? accessHandle.getSize() : (await backend.fileHandle.getFile()).size;
    backend.accessHandle = accessHandle;
    backend.size = size;
    backend.timestamp = Date.now();
    backend.closed = false;
    return backend;
  };

  const cleanupBackend = async (filePath: string) => {
    const backend = prepared[filePath];
    if (backend) {
      closeBackend(backend);
      delete prepared[filePath];
    }
    try {
      await removeManagedOpfsPath(filePath, navigatorObject);
    } catch (_error) {
      /* ignore cleanup errors */
    }
  };

  const notifyWriteObservers = (filePath: string, rangeStart: number, rangeEnd: number) => {
    if (!(writeObservers.size && rangeEnd > rangeStart)) return;
    for (const observer of writeObservers) {
      try {
        observer(filePath, rangeStart, rangeEnd);
      } catch (_error) {
        /* ignore observer errors */
      }
    }
  };

  const ensureMountRoot = (
    rootPath: string,
    nextModuleObject?: EmscriptenWorkerModule | { FS?: EmscriptenFileSystem } | null,
  ) => {
    const nextFs = (nextModuleObject?.FS || activeModuleObject?.FS || activeFs) as EmscriptenFileSystem | undefined;
    const nextBackend =
      (nextModuleObject as EmscriptenWorkerModule | null | undefined)?.OPFS ||
      activeModuleObject?.OPFS ||
      moduleObject?.OPFS;
    if (!(nextFs && typeof nextFs.mount === "function" && nextBackend)) return false;
    activeFs = nextFs;
    if (nextModuleObject?.FS) activeModuleObject = nextModuleObject as EmscriptenWorkerModule;
    const mountedRoots = getMountedRoots(nextFs);
    if (mountedRoots.has(rootPath)) return true;
    try {
      nextFs.mkdirTree(rootPath);
    } catch (_error) {
      /* ignore existing mount directories */
    }
    try {
      nextFs.mount(nextBackend, {}, rootPath);
      mountedRoots.add(rootPath);
      if (rootPath === normalizedMountPoint) ensureBucketDirectories(nextFs, normalizedMountPoint);
      return true;
    } catch (_error) {
      return false;
    }
  };

  const ensurePathMounted = (
    filePath: string,
    nextModuleObject?: EmscriptenWorkerModule | { FS?: EmscriptenFileSystem } | null,
  ) => ensureMountRoot(getVirtualRoot(filePath, normalizedMountPoint), nextModuleObject);

  const ensureMounted = (nextModuleObject?: EmscriptenWorkerModule | { FS?: EmscriptenFileSystem } | null) =>
    ensureMountRoot(normalizedMountPoint, nextModuleObject);

  const finalizePreparedPath = (filePath: string) => {
    if (!(activeFs || activeModuleObject?.FS || moduleObject?.FS)) return true;
    return manager.ensureNode(filePath);
  };

  const prepareFile = async (filePath: string) => {
    // Input/output files may need to exist in OPFS before a wasm filesystem is mounted.
    // Mounting still happens lazily once a module is available via ensureMounted/ensureNode.
    closeBackend(prepared[filePath]);
    const backend = await createManagedBackend({
      create: true,
      filePath,
      navigatorObject,
      truncate: true,
    });
    if (!backend) return null;
    prepared[filePath] = backend;
    return backend;
  };

  const openFile = async (filePath: string) => {
    if (prepared[filePath]) return reopenBackend(prepared[filePath]);
    const backend = await createManagedBackend({
      create: false,
      filePath,
      navigatorObject,
    });
    if (!backend) return null;
    prepared[filePath] = backend;
    return backend;
  };

  const copyPreparedBackend = (sourcePath: string, targetPath: string) => {
    const sourceBackend = prepared[sourcePath];
    const targetBackend = prepared[targetPath];
    if (!(sourceBackend && targetBackend)) return false;
    sourceBackend.accessHandle.flush();
    targetBackend.accessHandle.truncate(0);
    const buffer = new Uint8Array(COPY_CHUNK_SIZE);
    let offset = 0;
    while (offset < sourceBackend.size) {
      const readLength = Math.min(buffer.byteLength, sourceBackend.size - offset);
      const bytesRead = sourceBackend.accessHandle.read(buffer.subarray(0, readLength), { at: offset });
      if (!bytesRead) break;
      const bytesWritten = targetBackend.accessHandle.write(buffer.subarray(0, bytesRead), { at: offset });
      notifyWriteObservers(targetPath, offset, offset + bytesWritten);
      offset += bytesRead;
    }
    targetBackend.accessHandle.truncate(sourceBackend.size);
    targetBackend.size = sourceBackend.size;
    targetBackend.timestamp = Date.now();
    targetBackend.accessHandle.flush();
    return true;
  };

  const manager: WorkerOpfsManager = {
    cleanup: async (filePaths?: string[]) => {
      const paths = filePaths?.length ? filePaths.slice() : Object.keys(prepared);
      await Promise.all(paths.map((filePath) => cleanupBackend(filePath)));
    },
    ensureMounted,
    ensureNode: (filePath: string) => {
      if (!ensurePathMounted(filePath, activeModuleObject || moduleObject)) return false;
      const fs = requireFs();
      ensureDirectory(fs, getParentPath(filePath));
      try {
        fs.stat?.(filePath);
        return true;
      } catch (_error) {
        /* fall through */
      }
      if (prepared[filePath]?.size) {
        try {
          fs.stat?.(filePath);
          return true;
        } catch (_error) {
          return false;
        }
      }
      try {
        fs.writeFile(filePath, new Uint8Array(0));
        return true;
      } catch (_error) {
        return false;
      }
    },
    getFile: async (filePath: string) => {
      const backend = prepared[filePath] || (await openFile(filePath));
      if (!backend) return null;
      closeBackend(backend);
      return backend.fileHandle.getFile();
    },
    getFileHandle: (filePath: string) => prepared[filePath]?.fileHandle || null,
    getPreparedPaths: () => Object.keys(prepared),
    linkFile: (sourcePath: string, targetPath: string) => {
      if (sourcePath === targetPath) return finalizePreparedPath(targetPath);
      if (!ensurePathMounted(sourcePath, activeModuleObject || moduleObject)) return false;
      if (!ensurePathMounted(targetPath, activeModuleObject || moduleObject)) return false;
      if (copyPreparedBackend(sourcePath, targetPath)) return finalizePreparedPath(targetPath);
      const fs = requireFs();
      const fsReader = fs as EmscriptenFileSystem & {
        read?: (
          stream: { path?: string; position?: number },
          buffer: Uint8Array,
          offset: number,
          length: number,
          position?: number,
        ) => number;
      };
      const targetBackend = prepared[targetPath];
      if (!(targetBackend && typeof fs.stat === "function" && typeof fsReader.read === "function")) return false;
      try {
        const stat = fs.stat(sourcePath);
        const total = Math.max(0, Number(stat?.size || 0));
        const stream = { path: sourcePath, position: 0 };
        const buffer = new Uint8Array(COPY_CHUNK_SIZE);
        let offset = 0;
        targetBackend.accessHandle.truncate(0);
        while (offset < total) {
          const bytesRead = fsReader.read(stream, buffer, 0, Math.min(buffer.byteLength, total - offset), offset);
          if (!bytesRead) break;
          const bytesWritten = targetBackend.accessHandle.write(buffer.subarray(0, bytesRead), { at: offset });
          notifyWriteObservers(targetPath, offset, offset + bytesWritten);
          offset += bytesRead;
        }
        targetBackend.accessHandle.truncate(offset);
        targetBackend.size = offset;
        targetBackend.timestamp = Date.now();
        targetBackend.accessHandle.flush();
      } catch (_error) {
        return false;
      }
      return finalizePreparedPath(targetPath);
    },
    observeWrites: (observer) => {
      writeObservers.add(observer);
      return () => {
        writeObservers.delete(observer);
      };
    },
    openFile,
    outputDirectory: normalizedMountPoint,
    prepareFile,
    releaseFile: (filePath: string) => {
      closeBackend(prepared[filePath]);
      delete prepared[filePath];
    },
    writeBlob: async function (this: WorkerOpfsManager, filePath: string, blob: Blob) {
      const backend = await this.prepareFile(filePath);
      if (!backend) return false;
      const chunkSize = 8 * 1024 * 1024;
      let position = 0;
      while (position < blob.size) {
        const nextPosition = Math.min(position + chunkSize, blob.size);
        const chunkBytes = new Uint8Array(await blob.slice(position, nextPosition).arrayBuffer());
        const bytesWritten = backend.accessHandle.write(chunkBytes, { at: position });
        backend.size = Math.max(backend.size, position + bytesWritten);
        backend.timestamp = Date.now();
        notifyWriteObservers(filePath, position, position + bytesWritten);
        position = nextPosition;
      }
      backend.accessHandle.truncate(blob.size);
      backend.accessHandle.flush();
      return finalizePreparedPath(filePath);
    },
    writeFile: async function (this: WorkerOpfsManager, filePath: string, bytes: Uint8Array) {
      const backend = await this.prepareFile(filePath);
      if (!backend) return false;
      const bytesWritten = backend.accessHandle.write(bytes, { at: 0 });
      backend.accessHandle.truncate(bytes.byteLength);
      backend.size = Math.max(bytes.byteLength, bytesWritten);
      backend.timestamp = Date.now();
      backend.accessHandle.flush();
      notifyWriteObservers(filePath, 0, bytesWritten);
      return finalizePreparedPath(filePath);
    },
  };

  if (activeModuleObject && !ensureMounted(activeModuleObject)) return null;
  return manager;
};

export { createBrowserOpfsStorageManager };
