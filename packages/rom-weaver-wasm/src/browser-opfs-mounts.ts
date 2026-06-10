import * as wasiShim from '@bjorn3/browser_wasi_shim';
import { collectRomWeaverRunInputPaths } from './rom-weaver-command.ts';
import { normalizeGuestPath } from './rom-weaver-runtime-utils.ts';
import {
  BrowserMemoryRandomAccessFile,
  BrowserOpfsRandomAccessFile,
  BrowserVirtualRandomAccessFile,
  isBlobLike,
  isVirtualFileProxy,
} from './browser-opfs-io-adapters.ts';
import {
  DEFAULT_SCRATCH_FILE_POOL_SIZE,
  OPFS_COPY_CHUNK_SIZE,
  OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES,
  OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES,
  PATH_SEPARATOR_REGEX,
  SCRATCH_DIRECTORY_NAME,
  SCRATCH_FILE_CREATE_CONCURRENCY,
} from './browser-opfs-constants.ts';
import {
  basenameForTrace,
  createOutputCollector,
  formatErrorForTrace,
  summarizeNormalizedVirtualFiles,
} from './browser-opfs-stdio-events.ts';
import { closeSyncFiles, openSyncAccessHandle, writableSyncAccessMode } from './browser-opfs-sync-access.ts';
import { assertDirectoryHandle } from './browser-opfs-runtime-env.ts';
import type {
  FileReaderSyncLike,
  FileSystemDirectoryHandleLike,
  LineHandler,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverRunInput,
  TraceLine,
} from './browser-opfs-runtime-types.ts';

declare const FileReaderSync: {
  new(): FileReaderSyncLike;
};

/**
 * Structural surface this module needs from the random-access file adapters
 * (BrowserOpfsRandomAccessFile, BrowserMemoryRandomAccessFile, BrowserVirtualRandomAccessFile).
 * Optional members exist only on some adapters and are feature-detected before use.
 */
export interface RandomAccessFileLike {
  allocateAtLeast?: (size: number) => void;
  close?: () => void;
  flush: () => void;
  readAt: (offset: number | bigint, dst: Uint8Array) => number;
  reopen?: () => void;
  scratchName?: string | null;
  size: () => number;
  supportsBufferedSequentialWrite?: boolean;
  supportsDirectWasmRead?: boolean;
  truncate: (size: number) => void;
  writeAt: (offset: number | bigint, data: Uint8Array) => number;
}

/** Directory contents map used by the in-memory WASI inode tree. */
type WasiDirectoryContents = Map<string, wasiShim.Inode>;

/** FileSystemDirectoryHandleLike does not declare isSameEntry; real OPFS handles may have it. */
type DirectoryHandleWithSameEntry = FileSystemDirectoryHandleLike & {
  isSameEntry?: (other: FileSystemDirectoryHandleLike) => boolean | Promise<boolean>;
};

/** Shape produced by normalizeVirtualFiles and consumed by mount startRun. */
export interface NormalizedVirtualFile {
  path: string;
  source: unknown;
}

/** Bookkeeping needed to undo a virtual-file mount after a run finishes. */
type VirtualFileRestore =
  | { entries: WasiDirectoryContents; hadExisting: true; name: string; value: wasiShim.Inode }
  | { entries: WasiDirectoryContents; hadExisting: false; name: string; value: null };

export interface BrowserOpfsMountAcquireOptions {
  directoryHandle: FileSystemDirectoryHandleLike;
  mountPath: string;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  virtualOnly?: boolean;
  writableRoots: string[];
}

export type BrowserOpfsMountCache = ReturnType<typeof createBrowserOpfsMountCache>;

export interface SeedBrowserOpfsScratchPoolsOptions {
  mountCache: BrowserOpfsMountCache;
  mountHandles?: Record<string, FileSystemDirectoryHandleLike> | null;
  runtimeMounts?: string[] | null;
  scratchFilePoolSize?: unknown;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  virtualOnlyMounts?: boolean;
  writableRoots: string[];
}

export interface BuildBrowserOpfsWasiFdsOptions {
  cwdMountPath?: string;
  knownInputPaths?: unknown;
  mountCache: BrowserOpfsMountCache;
  mountHandles: Record<string, FileSystemDirectoryHandleLike>;
  preopenOutputPaths?: unknown;
  request: RomWeaverRunInput | undefined;
  runCloseables: unknown[];
  runtimeMounts: string[];
  scratchFilePoolSize?: unknown;
  stderrLineHandler?: LineHandler;
  stdin?: unknown;
  stdoutLineHandler?: LineHandler;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  trace?: TraceLine;
  virtualFiles?: NormalizedVirtualFile[];
  virtualOnlyMounts?: boolean;
  writableRoots: string[];
}

export function createBrowserOpfsMountCache() {
  let disposed = false;
  const mountsByPath = new Map<string, BrowserOpfsMount>();

  return {
    async acquire({
      directoryHandle,
      mountPath,
      syncAccessMode,
      virtualOnly,
      writableRoots,
    }: BrowserOpfsMountAcquireOptions) {
      if (disposed) throw new Error('browser OPFS mount cache is disposed');
      const writableRootsKey = writableRoots.join('\0');
      const current = mountsByPath.get(mountPath) ?? null;
      if (
        current
        && current.syncAccessMode === syncAccessMode
        && current.virtualOnly === Boolean(virtualOnly)
        && current.writableRootsKey === writableRootsKey
        && await directoryHandlesMatch(current.directoryHandle, directoryHandle)
      ) {
        return current;
      }
      if (current) {
        mountsByPath.delete(mountPath);
        await current.dispose();
      }
      const mount = await BrowserOpfsMount.create({
        directoryHandle,
        mountPath,
        syncAccessMode,
        virtualOnly,
        writableRoots,
      });
      mountsByPath.set(mountPath, mount);
      return mount;
    },

    async invalidateMounts(mounts: Iterable<BrowserOpfsMount> | null | undefined) {
      const seen = new Set(mounts ?? []);
      for (const mount of seen) {
        if (!mount || typeof mount !== 'object') continue;
        const current = mountsByPath.get(mount.mountPath);
        if (current !== mount) continue;
        mountsByPath.delete(mount.mountPath);
        await mount.dispose();
      }
    },

    async invalidateMountPaths(mountPaths: Iterable<string> | null | undefined) {
      const lookup = new Set(mountPaths ?? []);
      for (const [mountPath, mount] of mountsByPath) {
        if (!lookup.has(mountPath)) continue;
        mountsByPath.delete(mountPath);
        await mount.dispose();
      }
    },

    async dispose() {
      disposed = true;
      const mounts = [...mountsByPath.values()];
      mountsByPath.clear();
      for (const mount of mounts) {
        await mount.dispose();
      }
    },
  };
}

export async function seedBrowserOpfsScratchPools({
  mountCache,
  mountHandles,
  runtimeMounts,
  scratchFilePoolSize,
  syncAccessMode,
  virtualOnlyMounts,
  writableRoots,
}: SeedBrowserOpfsScratchPoolsOptions) {
  for (const mountPath of runtimeMounts ?? []) {
    const handle = mountHandles?.[mountPath];
    if (!handle) continue;
    const mount = await mountCache.acquire({
      directoryHandle: handle,
      mountPath,
      syncAccessMode,
      virtualOnly: virtualOnlyMounts,
      writableRoots,
    });
    await mount.ensureScratchPool({ scratchFilePoolSize });
  }
}

async function directoryHandlesMatch(
  left: DirectoryHandleWithSameEntry,
  right: DirectoryHandleWithSameEntry,
) {
  if (left === right) return true;
  if (typeof left?.isSameEntry === 'function') {
    try {
      return await left.isSameEntry(right);
    } catch {
      // ignored
    }
  }
  if (typeof right?.isSameEntry === 'function') {
    try {
      return await right.isSameEntry(left);
    } catch {
      // ignored
    }
  }
  return false;
}

export async function buildBrowserOpfsWasiFds({
  cwdMountPath,
  request,
  stdin,
  runtimeMounts,
  mountHandles,
  knownInputPaths,
  preopenOutputPaths,
  stderrLineHandler,
  stdoutLineHandler,
  virtualFiles,
  scratchFilePoolSize,
  writableRoots,
  syncAccessMode,
  mountCache,
  runCloseables,
  trace,
  virtualOnlyMounts = false,
}: BuildBrowserOpfsWasiFdsOptions) {
  trace?.(
    `[browser-opfs] build fds enter mounts=${Array.isArray(runtimeMounts) ? runtimeMounts.length : 0} virtualOnly=${Boolean(virtualOnlyMounts)} virtualFiles=${summarizeNormalizedVirtualFiles(virtualFiles)}`,
  );
  const stdinBytes = normalizeStdin(stdin);
  const stdoutCollector = createOutputCollector(wasiShim.ConsoleStdout, {
    onLine: stdoutLineHandler,
  });
  const stderrCollector = createOutputCollector(wasiShim.ConsoleStdout, {
    onLine: stderrLineHandler,
  });

  const fds: wasiShim.Fd[] = [
    new wasiShim.OpenFile(new wasiShim.File(stdinBytes)),
    stdoutCollector.fd,
    stderrCollector.fd,
  ];
  const mounts: BrowserOpfsMount[] = [];
  let cwdMount: BrowserOpfsMount | null = null;
  try {
    for (const mountPath of runtimeMounts) {
      trace?.(`[browser-opfs] mount acquire start path=${mountPath}`);
      const handle = mountHandles[mountPath];
      if (!handle) {
        throw new Error(
          `No directory handle provided for runtime mount ${mountPath}. `
            + 'Provide options.mountHandles or runOptions.mountHandles.',
        );
      }

      const mount = await mountCache.acquire({
        directoryHandle: handle,
        mountPath,
        syncAccessMode,
        virtualOnly: virtualOnlyMounts,
        writableRoots,
      });
      mounts.push(mount);
      trace?.(`[browser-opfs] mount acquire done path=${mountPath}`);
      await mount.startRun({
        runCloseables,
        scratchFilePoolSize,
        virtualFiles,
        trace,
      });
      trace?.(`[browser-opfs] mount startRun done path=${mountPath}`);
      await mount.preopenOutputPaths({ paths: preopenOutputPaths, trace });
      fds.push(new PreparedWasiPreopenDirectory(mount));
      if (mountPath === cwdMountPath) cwdMount = mount;
    }
  } catch (error) {
    trace?.(`[browser-opfs] build fds failed ${formatErrorForTrace(error)}`);
    closeSyncFiles(runCloseables);
    await cleanupBrowserOpfsMounts(mounts);
    throw error;
  }

  if (cwdMount) {
    fds.push(new PreparedWasiPreopenDirectory(cwdMount, { preopenName: '.' }));
  }
  if (virtualOnlyMounts) {
    trace?.('[browser-opfs] sync mounted input paths start for virtual-only mount');
  }
  const syncSummary = await syncMountedInputPathsFromOpfs({
    cwdMountPath,
    knownInputPaths,
    mounts,
    mountHandles,
    request,
    runtimeMounts,
    trace,
  });
  if (virtualOnlyMounts) {
    trace?.(
      `[browser-opfs] sync mounted input paths done for virtual-only mount paths=${syncSummary.paths} hydrated=${syncSummary.hydrated} missing=${syncSummary.missing}`,
    );
  }
  trace?.(`[browser-opfs] build fds leave fds=${fds.length} mounts=${mounts.length}`);

  return {
    fds,
    mounts,
    stdoutCollector,
    stderrCollector,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

interface BrowserOpfsMountConstructorOptions {
  contents: WasiDirectoryContents;
  directoryHandle: FileSystemDirectoryHandleLike;
  mountPath: string;
  ownedFiles: RandomAccessFileLike[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  virtualOnly?: boolean;
  writableRoots: string[];
}

class BrowserOpfsMount {
  contents: WasiDirectoryContents;
  directoryHandle: FileSystemDirectoryHandleLike;
  mountPath: string;
  ownedFiles: RandomAccessFileLike[];
  scratchDirectoryHandle: FileSystemDirectoryHandleLike | null;
  scratchFiles: RandomAccessFileLike[];
  scratchPool: RandomAccessFileLike[];
  syncAccessMode: RomWeaverBrowserSyncAccessMode | undefined;
  trace: TraceLine | null;
  virtualOnly: boolean;
  virtualRestores: VirtualFileRestore[] | null;
  writableRoots: string[];
  writableRootsKey: string;

  static async create({
    directoryHandle,
    mountPath,
    syncAccessMode,
    virtualOnly,
    writableRoots,
  }: BrowserOpfsMountAcquireOptions) {
    const ownedFiles: RandomAccessFileLike[] = [];
    const contents = virtualOnly
      ? new Map<string, wasiShim.Inode>()
      : await buildOpfsInodeMap({
          closeables: ownedFiles,
          directoryHandle,
          guestPath: mountPath,
          syncAccessMode,
          writableRoots,
        });
    return new BrowserOpfsMount({
      contents,
      directoryHandle,
      mountPath,
      ownedFiles,
      syncAccessMode,
      virtualOnly: Boolean(virtualOnly),
      writableRoots,
    });
  }

  constructor({
    contents,
    directoryHandle,
    mountPath,
    ownedFiles,
    syncAccessMode,
    virtualOnly,
    writableRoots,
  }: BrowserOpfsMountConstructorOptions) {
    this.contents = contents;
    this.directoryHandle = directoryHandle;
    this.mountPath = mountPath;
    this.ownedFiles = ownedFiles;
    this.syncAccessMode = syncAccessMode;
    this.virtualOnly = Boolean(virtualOnly);
    this.writableRoots = writableRoots;
    this.writableRootsKey = writableRoots.join('\0');
    this.virtualRestores = null;
    this.scratchDirectoryHandle = null;
    this.scratchFiles = [];
    this.scratchPool = [];
    this.trace = null;
  }

  isWritablePath(guestPath: string) {
    return isGuestPathWithinRoots(guestPath, this.writableRoots);
  }

  takeScratchFile() {
    const file = this.scratchPool.pop() ?? null;
    if (file) file.truncate(0);
    return file;
  }

  resetScratchPool({ trace }: { trace?: TraceLine } = {}) {
    let truncatedFiles = 0;
    let reclaimedBytes = 0;
    for (const file of this.scratchFiles) {
      let size = 0;
      try {
        size = Math.max(0, Number(file.size()) || 0);
      } catch {
        size = 0;
      }
      if (size > 0) {
        file.truncate(0);
        truncatedFiles += 1;
        reclaimedBytes += size;
      }
    }
    this.scratchPool = [...this.scratchFiles];
    if (truncatedFiles > 0) {
      trace?.(
        `[browser-opfs] mount scratch reset path=${this.mountPath} files=${truncatedFiles} bytes=${reclaimedBytes}`,
      );
    }
  }

  async ensureScratchPool({
    scratchFilePoolSize,
    trace,
  }: {
    scratchFilePoolSize?: unknown;
    trace?: TraceLine;
  } = {}) {
    const desiredSize = normalizeScratchFilePoolSize(scratchFilePoolSize);
    if (this.scratchFiles.length >= desiredSize) return;
    const additionalFileCount = desiredSize - this.scratchFiles.length;
    trace?.(
      `[browser-opfs] mount scratch seed start path=${this.mountPath} size=${desiredSize} add=${additionalFileCount}`,
    );
    const scratch = this.virtualOnly
      ? createMemoryScratchFilePool({
          closeables: this.ownedFiles,
          scratchFilePoolSize: additionalFileCount,
        })
      : await createScratchFilePool({
          closeables: this.ownedFiles,
          directoryHandle: this.directoryHandle,
          scratchFilePoolSize: additionalFileCount,
          syncAccessMode: this.syncAccessMode,
        });
    this.scratchDirectoryHandle = scratch.directoryHandle;
    this.scratchFiles.push(...scratch.files);
    this.scratchPool = [...this.scratchFiles];
    trace?.(
      `[browser-opfs] mount scratch seed done path=${this.mountPath} files=${this.scratchFiles.length}`,
    );
  }

  async startRun({
    runCloseables,
    scratchFilePoolSize,
    virtualFiles,
    trace,
  }: {
    runCloseables: unknown[];
    scratchFilePoolSize?: unknown;
    virtualFiles?: NormalizedVirtualFile[];
    trace?: TraceLine;
  }) {
    void runCloseables;
    this.finishRun();
    this.trace = typeof trace === 'function' ? trace : null;
    trace?.(
      `[browser-opfs] mount virtual files start path=${this.mountPath} ${summarizeNormalizedVirtualFiles(virtualFiles)}`,
    );
    if (Array.isArray(virtualFiles) && virtualFiles.length > 0) {
      this.virtualRestores = addVirtualFilesToMount({
        contents: this.contents,
        mountPath: this.mountPath,
        trace,
        virtualFiles,
      });
    } else {
      this.virtualRestores = [];
    }
    trace?.(
      `[browser-opfs] mount virtual files done path=${this.mountPath} mounted=${this.virtualRestores.length}`,
    );
    await this.ensureScratchPool({ scratchFilePoolSize, trace });
    this.scratchPool = [...this.scratchFiles];
  }

  finishRun() {
    if (Array.isArray(this.virtualRestores) && this.virtualRestores.length > 0) {
      restoreVirtualFiles(this.virtualRestores);
    }
    this.virtualRestores = null;
    this.trace = null;
  }

  async preopenOutputPaths({
    paths,
    trace,
  }: {
    paths?: unknown;
    trace?: TraceLine;
  } = {}) {
    if (this.virtualOnly) return;
    const normalizedPaths = normalizePreopenOutputPaths(paths);
    if (normalizedPaths.length === 0) return;
    let preopened = 0;
    for (const guestPath of normalizedPaths) {
      if (!isGuestPathWithinMount(guestPath, this.mountPath)) continue;
      await this.preopenOutputPath(guestPath);
      preopened += 1;
    }
    if (preopened > 0) {
      trace?.(`[browser-opfs] mount preopen outputs path=${this.mountPath} files=${preopened}`);
    }
  }

  async preopenOutputPath(guestPath: string) {
    if (!this.isWritablePath(guestPath)) {
      throw new Error(`Browser OPFS output path is not writable: ${guestPath}`);
    }
    const relativePath = guestPath === this.mountPath ? '' : guestPath.slice(this.mountPath.length + 1);
    const parts = normalizeWasiRelativePathParts(relativePath);
    if (parts === null || parts.length === 0) {
      throw new Error(`Browser OPFS output path must be a file inside ${this.mountPath}: ${guestPath}`);
    }

    let entries = this.contents;
    let directoryHandle = this.directoryHandle;
    for (const part of parts.slice(0, -1)) {
      let entry: wasiShim.Inode | null = entries.get(part) ?? null;
      if (!entry) {
        entry = new wasiShim.Directory(new Map());
        entries.set(part, entry);
      }
      if (!(entry instanceof wasiShim.Directory)) {
        throw new Error(`Browser OPFS output parent is not a directory: ${guestPath}`);
      }
      directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: true }) as FileSystemDirectoryHandleLike;
      entries = entry.contents;
    }

    const name = lastPathPart(parts);
    const existing = entries.get(name) ?? null;
    if (existing instanceof wasiShim.Directory) {
      throw new Error(`Browser OPFS output path is a directory: ${guestPath}`);
    }
    if (existing instanceof WasiRandomAccessFileInode && typeof existing.file?.close === 'function') {
      try {
        existing.file.close();
      } catch {
        // ignore stale output handle cleanup failures; the new handle below owns the path.
      }
    }

    const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
    const syncHandle = await openSyncAccessHandle({
      fileHandle,
      mode: writableSyncAccessMode(this.syncAccessMode),
    });
    const file = new BrowserOpfsRandomAccessFile(syncHandle);
    file.truncate(0);
    this.trackOwnedFile(file);
    entries.set(name, new WasiRandomAccessFileInode(file));
  }

  trackOwnedFile(file: RandomAccessFileLike) {
    this.ownedFiles.push(file);
  }

  async dispose() {
    this.finishRun();
    await this.cleanupScratchPool();
    closeSyncFiles(this.ownedFiles);
    this.ownedFiles = [];
    this.scratchPool = [];
    this.scratchFiles = [];
    this.scratchDirectoryHandle = null;
  }

  async cleanupScratchPool() {
    if (!this.scratchDirectoryHandle) return;
    for (const file of this.scratchFiles) {
      if (!file.scratchName) continue;
      try {
        // removeEntry is optional on the handle type; previously a missing method threw a
        // TypeError that this try/catch ignored, so skipping the call is observably identical.
        await this.scratchDirectoryHandle.removeEntry?.(file.scratchName);
      } catch {
        // ignore best-effort scratch cleanup failures
      }
    }
    try {
      for await (const [name] of this.scratchDirectoryHandle.entries()) {
        try {
          await this.scratchDirectoryHandle.removeEntry?.(name);
        } catch {
          // ignore best-effort scratch cleanup failures
        }
      }
    } catch {
      // ignore best-effort scratch cleanup failures
    }
  }
}

class PreparedWasiPreopenDirectory extends wasiShim.PreopenDirectory {
  mount: BrowserOpfsMount;

  constructor(mount: BrowserOpfsMount, options: { preopenName?: string } = {}) {
    super(options.preopenName ?? mount.mountPath, mount.contents);
    this.mount = mount;
  }

  override path_open(
    _dirflags: number,
    pathStr: string,
    oflags: number,
    fsRightsBase: bigint,
    _fsRightsInheriting: bigint,
    fdFlags: number,
  ) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: pathRet, fd_obj: null };

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    let entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!entry) {
      if ((oflags & wasiShim.wasi.OFLAGS_CREAT) !== wasiShim.wasi.OFLAGS_CREAT) {
        return { ret: wasiShim.wasi.ERRNO_NOENT, fd_obj: null };
      }
      if (!this.mount.isWritablePath(guestPath)) {
        return { ret: wasiShim.wasi.ERRNO_ROFS, fd_obj: null };
      }
      const created = createInMemoryEntry(this.mount.contents, pathStr, {
        directory: (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY,
        mount: this.mount,
      });
      if (created !== wasiShim.wasi.ERRNO_SUCCESS) {
        this.mount.trace?.(
          `[browser-opfs] path create failed path=${basenameForTrace(pathStr)} errno=${created}`,
        );
        return { ret: created, fd_obj: null };
      }
      entry = findEntryInDirectory(this.mount.contents, pathStr);
      if (!entry) return { ret: wasiShim.wasi.ERRNO_IO, fd_obj: null };
    } else if ((oflags & wasiShim.wasi.OFLAGS_EXCL) === wasiShim.wasi.OFLAGS_EXCL) {
      return { ret: wasiShim.wasi.ERRNO_EXIST, fd_obj: null };
    } else if (!this.mount.isWritablePath(guestPath) && requestsWriteRights(fsRightsBase, oflags)) {
      return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
    }

    if (pathRequiresDirectory(pathStr, oflags) && !(entry instanceof wasiShim.Directory)) {
      return { ret: wasiShim.wasi.ERRNO_NOTDIR, fd_obj: null };
    }

    return entry.path_open(oflags, fsRightsBase, fdFlags);
  }

  override path_create_directory(pathStr: string) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    if (pathIsDirectoryInDirectory(this.mount.contents, pathStr)) {
      return wasiShim.wasi.ERRNO_SUCCESS;
    }
    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return wasiShim.wasi.ERRNO_ROFS;
    }
    return createInMemoryEntry(this.mount.contents, pathStr, {
      directory: true,
      mount: this.mount,
    });
  }

  override path_link(pathStr: string, inode: wasiShim.Inode, _allowDir: boolean) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return wasiShim.wasi.ERRNO_ROFS;
    }
    return setEntryInDirectory(this.mount.contents, pathStr, inode);
  }

  override path_unlink(pathStr: string) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: pathRet, inode_obj: null };
    }

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return { ret: wasiShim.wasi.ERRNO_ROFS, inode_obj: null };
    }
    return unlinkEntryFromDirectory(this.mount.contents, pathStr);
  }

  override path_unlink_file(pathStr: string) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!entry) return wasiShim.wasi.ERRNO_NOENT;
    if (entry instanceof wasiShim.Directory) return wasiShim.wasi.ERRNO_ISDIR;
    const { ret } = this.path_unlink(pathStr);
    return ret;
  }

  override path_remove_directory(pathStr: string) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!(entry instanceof wasiShim.Directory)) return wasiShim.wasi.ERRNO_NOTDIR;
    if (entry.contents.size > 0) return wasiShim.wasi.ERRNO_NOTEMPTY;
    const { ret } = this.path_unlink(pathStr);
    return ret;
  }
}

interface WasiRandomAccessFileInodeOptions {
  closeOnLastFdClose?: boolean;
  readonly?: boolean;
  scratchBacked?: boolean;
}

class WasiRandomAccessFileInode extends wasiShim.Inode {
  closeOnLastFdClose: boolean;
  file: RandomAccessFileLike;
  openRefCount: number;
  readonly: boolean;
  scratchBacked: boolean;

  constructor(file: RandomAccessFileLike, options: WasiRandomAccessFileInodeOptions = {}) {
    super();
    this.file = file;
    this.readonly = Boolean(options.readonly);
    this.scratchBacked = Boolean(options.scratchBacked);
    this.closeOnLastFdClose = Boolean(options.closeOnLastFdClose);
    this.openRefCount = 0;
  }

  path_open(oflags: number, fsRightsBase: bigint, fdFlags: number) {
    if (this.readonly && requestsWriteRights(fsRightsBase, oflags)) {
      return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
    }
    const openRet = this.prepareOpenFile();
    if (openRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: openRet, fd_obj: null };
    }
    if ((oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC) {
      if (this.readonly) return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
      this.file.truncate(0);
    }
    const fd = new OpenWasiRandomAccessFile(this);
    this.registerOpenFile();
    if (fdFlags & wasiShim.wasi.FDFLAGS_APPEND) fd.fd_seek(0n, wasiShim.wasi.WHENCE_END);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, fd_obj: fd };
  }

  prepareOpenFile() {
    if (this.closeOnLastFdClose && this.openRefCount === 0 && typeof this.file?.reopen === 'function') {
      this.file.reopen();
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  registerOpenFile() {
    this.openRefCount += 1;
  }

  releaseOpenFile() {
    if (this.openRefCount > 0) this.openRefCount -= 1;
    if (this.openRefCount !== 0 || !this.closeOnLastFdClose) return wasiShim.wasi.ERRNO_SUCCESS;
    if (typeof this.file?.close !== 'function') return wasiShim.wasi.ERRNO_SUCCESS;
    try {
      this.file.close();
      return wasiShim.wasi.ERRNO_SUCCESS;
    } catch {
      return wasiShim.wasi.ERRNO_IO;
    }
  }

  get size() {
    return BigInt(this.file.size());
  }

  stat() {
    return new wasiShim.wasi.Filestat(this.ino, wasiShim.wasi.FILETYPE_REGULAR_FILE, this.size);
  }
}

export function __createWasiRandomAccessFileInodeForTest(
  file: RandomAccessFileLike,
  options: WasiRandomAccessFileInodeOptions = {},
) {
  return new WasiRandomAccessFileInode(file, options);
}

function normalizeWasiReadResult(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { bytesRead: 0, ret: wasiShim.wasi.ERRNO_IO };
  const integral = Math.trunc(numeric);
  if (integral >= 0) return { bytesRead: integral, ret: wasiShim.wasi.ERRNO_SUCCESS };
  const errno = Math.abs(integral);
  if (errno > 0 && errno <= 0xffff) return { bytesRead: 0, ret: errno };
  return { bytesRead: 0, ret: wasiShim.wasi.ERRNO_IO };
}

function emitWasiReadErrorTrace(scope: string, rawValue: unknown, retCode: number) {
  if (typeof console === 'undefined') return;
  const log = typeof console.debug === 'function' ? console.debug : console.log;
  log.call(console, `[rom-weaver trace] browser-opfs: ${scope} readAt returned error-like value`, {
    rawValue,
    retCode,
  });
}

class OpenWasiRandomAccessFile extends wasiShim.Fd {
  closed: boolean;
  inode: WasiRandomAccessFileInode;
  position: bigint;
  writeBuffer: Uint8Array | null;
  writeBufferLength: number;
  writeBufferStart: bigint;

  constructor(inode: WasiRandomAccessFileInode) {
    super();
    this.inode = inode;
    this.position = 0n;
    this.writeBuffer = null;
    this.writeBufferStart = 0n;
    this.writeBufferLength = 0;
    this.closed = false;
  }

  override fd_allocate(offset: bigint, len: bigint) {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    const requested = BigInt(offset) + BigInt(len);
    if (BigInt(this.inode.file.size()) >= requested) return wasiShim.wasi.ERRNO_SUCCESS;
    if (typeof this.inode.file.allocateAtLeast === 'function') {
      this.inode.file.allocateAtLeast(Number(requested));
    } else {
      this.inode.file.truncate(Number(requested));
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  override fd_fdstat_get() {
    if (this.closed) {
      return {
        ret: wasiShim.wasi.ERRNO_BADF,
        fdstat: null,
      };
    }
    return {
      ret: wasiShim.wasi.ERRNO_SUCCESS,
      fdstat: new wasiShim.wasi.Fdstat(wasiShim.wasi.FILETYPE_REGULAR_FILE, 0),
    };
  }

  override fd_filestat_get() {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, filestat: null };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, filestat: null };
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, filestat: this.inode.stat() };
  }

  override fd_filestat_set_size(size: bigint) {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    if (this.inode.readonly) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    const nextSize = Number(size);
    this.inode.file.truncate(nextSize);
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  override fd_read(size: number) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, data: new Uint8Array(0) };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: flushRet, data: new Uint8Array(0) };
    }
    const buffer = new Uint8Array(size);
    const rawRead = this.inode.file.readAt(this.position, buffer);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_read', rawRead, readResult.ret);
      return { ret: readResult.ret, data: new Uint8Array(0) };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, buffer.byteLength));
    this.position += BigInt(bytesRead);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.subarray(0, bytesRead) };
  }

  override fd_pread(size: number, offset: bigint) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, data: new Uint8Array(0) };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: flushRet, data: new Uint8Array(0) };
    }
    const buffer = new Uint8Array(size);
    const rawRead = this.inode.file.readAt(offset, buffer);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_pread', rawRead, readResult.ret);
      return { ret: readResult.ret, data: new Uint8Array(0) };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, buffer.byteLength));
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.subarray(0, bytesRead) };
  }

  fd_read_into(target: Uint8Array) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nread: 0 };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nread: 0 };
    if (!this.inode.file.supportsDirectWasmRead) {
      return { ret: wasiShim.wasi.ERRNO_NOTSUP, nread: 0 };
    }
    const rawRead = this.inode.file.readAt(this.position, target);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_read_into', rawRead, readResult.ret);
      return { ret: readResult.ret, nread: 0 };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, target.byteLength));
    this.position += BigInt(bytesRead);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nread: bytesRead };
  }

  fd_pread_into(target: Uint8Array, offset: bigint) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nread: 0 };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nread: 0 };
    if (!this.inode.file.supportsDirectWasmRead) {
      return { ret: wasiShim.wasi.ERRNO_NOTSUP, nread: 0 };
    }
    const rawRead = this.inode.file.readAt(offset, target);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_pread_into', rawRead, readResult.ret);
      return { ret: readResult.ret, nread: 0 };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, target.byteLength));
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nread: bytesRead };
  }

  override fd_seek(offset: bigint, whence: number) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, offset: this.position };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, offset: this.position };
    let nextPosition: bigint;
    switch (whence) {
      case wasiShim.wasi.WHENCE_SET:
        nextPosition = BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_CUR:
        nextPosition = this.position + BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_END:
        nextPosition = BigInt(this.inode.file.size()) + BigInt(offset);
        break;
      default:
        return { ret: wasiShim.wasi.ERRNO_INVAL, offset: 0n };
    }
    if (nextPosition < 0n) return { ret: wasiShim.wasi.ERRNO_INVAL, offset: 0n };
    this.position = nextPosition;
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, offset: this.position };
  }

  override fd_tell() {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, offset: this.position };
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, offset: this.position };
  }

  override fd_write(data: Uint8Array) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    if (data.byteLength === 0) return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: 0 };
    if (!this.inode.file.supportsBufferedSequentialWrite) {
      const bytesWritten = this.inode.file.writeAt(this.position, data);
      this.position += BigInt(bytesWritten);
      return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
    }
    return this.bufferSequentialWrite(data);
  }

  override fd_pwrite(data: Uint8Array, offset: bigint) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten: 0 };
    const bytesWritten = this.inode.file.writeAt(offset, data);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
  }

  override fd_sync() {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    this.inode.file.flush();
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  override fd_close() {
    if (this.closed) return wasiShim.wasi.ERRNO_SUCCESS;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    this.closed = true;
    this.writeBuffer = null;
    this.writeBufferLength = 0;
    this.writeBufferStart = 0n;
    return this.inode.releaseOpenFile();
  }

  pendingWriteBufferLength() {
    if (this.closed) return 0;
    return this.writeBufferLength;
  }

  ensureWriteBuffer() {
    if (!this.writeBuffer) {
      this.writeBuffer = new Uint8Array(OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES);
    }
    return this.writeBuffer;
  }

  flushPendingWrite() {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    // writeBuffer is always allocated before writeBufferLength becomes positive; the null
    // check only narrows the type and matches the empty-buffer early return.
    const buffer = this.writeBuffer;
    if (this.writeBufferLength <= 0 || buffer === null) return wasiShim.wasi.ERRNO_SUCCESS;
    const source = buffer.subarray(0, this.writeBufferLength);
    const bytesWritten = this.inode.file.writeAt(this.writeBufferStart, source);
    if (bytesWritten !== this.writeBufferLength) {
      if (bytesWritten > 0 && bytesWritten < this.writeBufferLength) {
        buffer.copyWithin(0, bytesWritten, this.writeBufferLength);
        this.writeBufferStart += BigInt(bytesWritten);
        this.writeBufferLength -= bytesWritten;
      }
      return wasiShim.wasi.ERRNO_IO;
    }
    this.writeBufferLength = 0;
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  bufferSequentialWrite(data: Uint8Array) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    let nwritten = 0;
    while (nwritten < data.byteLength) {
      if (this.writeBufferLength > 0) {
        const expectedPosition = this.writeBufferStart + BigInt(this.writeBufferLength);
        if (this.position !== expectedPosition) {
          const flushRet = this.flushPendingWrite();
          if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten };
        }
      }

      if (this.writeBufferLength === 0) {
        this.writeBufferStart = this.position;
        const remaining = data.byteLength - nwritten;
        if (remaining >= OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES) {
          const source = data.subarray(nwritten);
          const bytesWritten = this.inode.file.writeAt(this.position, source);
          this.position += BigInt(bytesWritten);
          nwritten += bytesWritten;
          if (bytesWritten !== source.byteLength) break;
          continue;
        }
      }

      const buffer = this.ensureWriteBuffer();
      const available = buffer.byteLength - this.writeBufferLength;
      if (available <= 0) {
        const flushRet = this.flushPendingWrite();
        if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten };
        continue;
      }
      const chunkLength = Math.min(data.byteLength - nwritten, available);
      buffer.set(data.subarray(nwritten, nwritten + chunkLength), this.writeBufferLength);
      this.writeBufferLength += chunkLength;
      this.position += BigInt(chunkLength);
      nwritten += chunkLength;
      if (this.writeBufferLength >= buffer.byteLength) {
        const flushRet = this.flushPendingWrite();
        if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten };
      }
    }
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten };
  }
}

interface BuildOpfsInodeMapOptions {
  closeables: RandomAccessFileLike[];
  directoryHandle: FileSystemDirectoryHandleLike;
  guestPath: string;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  writableRoots: string[];
}

async function buildOpfsInodeMap({
  closeables,
  directoryHandle,
  guestPath,
  syncAccessMode,
  writableRoots,
}: BuildOpfsInodeMapOptions): Promise<WasiDirectoryContents> {
  const entries = new Map<string, wasiShim.Inode>();

  for await (const [entryName, rawEntryHandle] of directoryHandle.entries()) {
    // entries() yields handles typed as unknown; kind discriminates directory vs file handles.
    const entryHandle = rawEntryHandle as FileSystemDirectoryHandleLike;
    const entryGuestPath = joinGuestPath(guestPath, entryName);
    if (entryHandle.kind === 'directory') {
      const nested = await buildOpfsInodeMap({
        closeables,
        directoryHandle: entryHandle,
        guestPath: entryGuestPath,
        syncAccessMode,
        writableRoots,
      });
      entries.set(entryName, new wasiShim.Directory(nested));
      continue;
    }

    if (entryHandle.kind !== 'file') continue;

    const writable = isGuestPathWithinRoots(entryGuestPath, writableRoots);
    const syncHandle = await openSyncAccessHandle({
      fileHandle: entryHandle,
      mode: writable ? syncAccessMode : 'read-only',
    });
    const file = new BrowserOpfsRandomAccessFile(syncHandle);
    closeables.push(file);
    entries.set(entryName, new WasiRandomAccessFileInode(file, { readonly: !writable }));
  }

  return entries;
}

interface AddVirtualFilesToMountOptions {
  contents: WasiDirectoryContents;
  mountPath: string;
  trace?: TraceLine;
  virtualFiles?: NormalizedVirtualFile[];
}

function addVirtualFilesToMount({ contents, mountPath, trace, virtualFiles }: AddVirtualFilesToMountOptions) {
  const restores: VirtualFileRestore[] = [];
  for (const entry of virtualFiles ?? []) {
    if (!isGuestPathWithinMount(entry.path, mountPath)) {
      trace?.(`[browser-opfs] virtual file skipped outside mount path=${basenameForTrace(entry.path)} mount=${mountPath}`);
      continue;
    }
    const relativePath = entry.path === mountPath ? '' : entry.path.slice(mountPath.length + 1);
    addVirtualFileEntry(contents, relativePath, entry.source, restores, trace);
  }
  return restores;
}

function addVirtualFileEntry(
  contents: WasiDirectoryContents,
  relativePath: string,
  source: unknown,
  restores: VirtualFileRestore[],
  trace: TraceLine | undefined,
) {
  const parts = normalizeWasiRelativePathParts(relativePath);
  if (parts === null || parts.length === 0) {
    throw new TypeError(`virtual file path must be inside a mounted directory: ${relativePath}`);
  }
  let entries: WasiDirectoryContents = contents;
  for (const part of parts.slice(0, -1)) {
    const existing = entries.get(part) ?? null;
    if (!existing) {
      const directory = new wasiShim.Directory(new Map());
      entries.set(part, directory);
      entries = directory.contents;
      continue;
    }
    const existingContents = inodeMapContents(existing);
    if (!existingContents) {
      throw new Error(`virtual file parent path is not a directory: ${relativePath}`);
    }
    entries = existingContents;
  }
  const file = new BrowserVirtualRandomAccessFile(source, { trace });
  const name = lastPathPart(parts);
  trace?.(
    `[browser-opfs] virtual file mounted name=${name} proxy=${Boolean(file.proxy)} size=${file.size()}`,
  );
  const existingValue = entries.get(name);
  restores.push(
    existingValue === undefined
      ? { entries, hadExisting: false, name, value: null }
      : { entries, hadExisting: true, name, value: existingValue },
  );
  entries.set(name, new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true, readonly: true }));
}

function restoreVirtualFiles(restores: VirtualFileRestore[]) {
  for (let index = restores.length - 1; index >= 0; index -= 1) {
    const restore = restores[index];
    if (!restore) continue;
    const current = restore.entries.get(restore.name) ?? null;
    if (current instanceof WasiRandomAccessFileInode && typeof current.file?.close === 'function') {
      try {
        current.file.close();
      } catch {
        // ignore best-effort virtual-file cleanup failures
      }
    }
    if (restore.hadExisting) {
      restore.entries.set(restore.name, restore.value);
      continue;
    }
    restore.entries.delete(restore.name);
  }
}

interface SyncMountedInputPathsFromOpfsOptions {
  cwdMountPath?: string;
  knownInputPaths?: unknown;
  mountHandles: Record<string, FileSystemDirectoryHandleLike>;
  mounts: BrowserOpfsMount[];
  request: RomWeaverRunInput | undefined;
  runtimeMounts: string[];
  trace?: TraceLine;
}

async function syncMountedInputPathsFromOpfs({
  cwdMountPath,
  knownInputPaths,
  mounts,
  mountHandles,
  request,
  runtimeMounts,
  trace,
}: SyncMountedInputPathsFromOpfsOptions) {
  const inputPaths = collectMountedInputPaths(request, knownInputPaths);
  const summary = { paths: inputPaths.length, hydrated: 0, missing: 0 };
  if (inputPaths.length === 0) return summary;
  const mountsByPath = new Map<string, BrowserOpfsMount>(
    mounts.map((mount) => [mount.mountPath, mount]),
  );
  for (const path of inputPaths) {
    const resolved = resolveMountedGuestPath(path, mountHandles, runtimeMounts, { cwdMountPath });
    if (!resolved) continue;
    const mount = mountsByPath.get(resolved.mountPath);
    if (!mount) continue;
    const relativePath = resolved.relativeParts.join('/');
    if (relativePath.length === 0 || pathExistsInDirectory(mount.contents, relativePath)) continue;
    const hydrated = await hydrateMountedInputPathFromOpfs({
      mount,
      relativeParts: resolved.relativeParts,
      rootHandle: resolved.handle,
    });
    if (hydrated) {
      summary.hydrated += 1;
    } else {
      summary.missing += 1;
      trace?.(`[browser-opfs] sync mounted input path missing path=${basenameForTrace(path)}`);
    }
  }
  return summary;
}

function collectMountedInputPaths(request: RomWeaverRunInput | undefined, knownInputPaths: unknown) {
  // request is always provided on real runs; preserve the original behavior (a TypeError from
  // collectRomWeaverRunInputPaths) instead of silently skipping when it is missing.
  return collectRomWeaverRunInputPaths(request as RomWeaverRunInput, {
    knownInputPaths: normalizeKnownInputPaths(knownInputPaths),
  });
}

async function hydrateMountedInputPathFromOpfs({
  mount,
  relativeParts,
  rootHandle,
}: {
  mount: BrowserOpfsMount;
  relativeParts: string[];
  rootHandle: FileSystemDirectoryHandleLike;
}) {
  if (!Array.isArray(relativeParts) || relativeParts.length === 0) return false;
  let entries = mount.contents;
  let directoryHandle = rootHandle;
  for (const part of relativeParts.slice(0, -1)) {
    let entry: wasiShim.Inode | null = entries.get(part) ?? null;
    if (!entry) {
      try {
        directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: false }) as FileSystemDirectoryHandleLike;
      } catch {
        return false;
      }
      entry = new wasiShim.Directory(new Map());
      entries.set(part, entry);
    } else {
      try {
        directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: false }) as FileSystemDirectoryHandleLike;
      } catch {
        return false;
      }
    }
    if (!(entry instanceof wasiShim.Directory)) return false;
    entries = entry.contents;
  }

  const name = lastPathPart(relativeParts);
  if (entries.has(name)) return true;

  const guestPath = joinGuestPath(mount.mountPath, relativeParts.join('/'));
  const writable = mount.isWritablePath(guestPath);
  try {
    const fileHandle = await directoryHandle.getFileHandle(name, { create: false });
    const syncHandle = await openSyncAccessHandle({
      fileHandle,
      mode: writable ? mount.syncAccessMode : 'read-only',
    });
    const file = new BrowserOpfsRandomAccessFile(syncHandle);
    mount.trackOwnedFile(file);
    entries.set(name, new WasiRandomAccessFileInode(file, { readonly: !writable }));
    return true;
  } catch {
    // ignored
  }

  try {
    await directoryHandle.getDirectoryHandle(name, { create: false });
    entries.set(name, new wasiShim.Directory(new Map()));
    return true;
  } catch {
    // ignored
  }
  return false;
}

function resolveMountedGuestPath(
  path: string,
  mountHandles: Record<string, FileSystemDirectoryHandleLike>,
  runtimeMounts: string[],
  { cwdMountPath }: { cwdMountPath?: string } = {},
) {
  const rawPath = String(path ?? '').trim();
  const candidatePaths = [normalizeGuestPath(rawPath, { label: 'prepared request path' })];
  if (rawPath && !rawPath.startsWith('/') && cwdMountPath) {
    candidatePaths.push(joinGuestPath(cwdMountPath, rawPath));
  }
  const sortedMounts = [...runtimeMounts].sort((a, b) => b.length - a.length);
  for (const normalizedPath of candidatePaths) {
    for (const mountPath of sortedMounts) {
      if (normalizedPath !== mountPath && !normalizedPath.startsWith(`${mountPath}/`)) continue;
      const handle = mountHandles[mountPath];
      if (!handle) return null;
      const relative = normalizedPath === mountPath ? '' : normalizedPath.slice(mountPath.length + 1);
      return {
        handle,
        mountPath,
        relativeParts: relative ? normalizeRelativePathParts(relative, { label: normalizedPath }) : [],
      };
    }
  }
  return null;
}

function requestsWriteRights(fsRightsBase: bigint, oflags: number) {
  return (BigInt(fsRightsBase) & BigInt(wasiShim.wasi.RIGHTS_FD_WRITE)) === BigInt(wasiShim.wasi.RIGHTS_FD_WRITE)
    || (oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC
    || (oflags & wasiShim.wasi.OFLAGS_CREAT) === wasiShim.wasi.OFLAGS_CREAT;
}

function pathExistsInDirectory(contents: WasiDirectoryContents, pathStr: string) {
  return Boolean(findEntryInDirectory(contents, pathStr));
}

function pathIsDirectoryInDirectory(contents: WasiDirectoryContents, pathStr: string) {
  const entry = findEntryInDirectory(contents, pathStr);
  return Boolean(entry && entry instanceof wasiShim.Directory);
}

function findEntryInDirectory(contents: WasiDirectoryContents, pathStr: string): wasiShim.Inode | null {
  if (!(contents instanceof Map)) return null;
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return null;
  if (parts.length === 0) return new wasiShim.Directory(contents);

  let currentEntries = contents;
  for (const [index, part] of parts.entries()) {
    const entry = currentEntries.get(part) ?? null;
    if (!entry) return null;
    if (index === parts.length - 1) return entry;
    const entryContents = inodeMapContents(entry);
    if (!entryContents) return null;
    currentEntries = entryContents;
  }
  return null;
}

// Inode subclasses store directory children on `contents`; duck-type the property instead of
// using `instanceof Directory` so the runtime check matches the original behavior exactly.
function inodeMapContents(entry: wasiShim.Inode): WasiDirectoryContents | null {
  const contents = (entry as { contents?: unknown }).contents;
  return contents instanceof Map ? contents as WasiDirectoryContents : null;
}

// Callers verify parts is non-empty before indexing; this re-asserts that for
// noUncheckedIndexedAccess without resorting to non-null assertions.
function lastPathPart(parts: string[]): string {
  const name = parts[parts.length - 1];
  if (name === undefined) throw new Error('path has no segments');
  return name;
}

function createInMemoryEntry(
  contents: WasiDirectoryContents,
  pathStr: string,
  { directory, mount }: { directory: boolean; mount: BrowserOpfsMount },
) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (parts.length === 0) return wasiShim.wasi.ERRNO_EXIST;
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS || parent.entries === null) return parent.ret;
  if (parent.entries.has(parent.name)) return wasiShim.wasi.ERRNO_EXIST;
  if (directory) {
    parent.entries.set(parent.name, new wasiShim.Directory(new Map()));
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  const file = mount?.takeScratchFile?.() ?? null;
  if (!file) return wasiShim.wasi.ERRNO_NOSPC;
  parent.entries.set(
    parent.name,
    new WasiRandomAccessFileInode(file, { scratchBacked: true }),
  );
  return wasiShim.wasi.ERRNO_SUCCESS;
}

function setEntryInDirectory(contents: WasiDirectoryContents, pathStr: string, inode: wasiShim.Inode) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (parts.length === 0) return wasiShim.wasi.ERRNO_INVAL;
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS || parent.entries === null) return parent.ret;
  const existing = parent.entries.get(parent.name) ?? null;
  if (existing && copyInodeContents(existing, inode)) {
    return wasiShim.wasi.ERRNO_SUCCESS;
  }
  parent.entries.set(parent.name, inode);
  return wasiShim.wasi.ERRNO_SUCCESS;
}

function copyInodeContents(target: wasiShim.Inode, source: wasiShim.Inode) {
  if (!(target instanceof WasiRandomAccessFileInode) || target.readonly) return false;
  if (source instanceof WasiRandomAccessFileInode) {
    copyRandomAccessFileSync(source.file, target.file);
    return true;
  }
  const bytes = readInodeBytes(source);
  if (!bytes) return false;
  target.file.truncate(0);
  if (bytes.byteLength > 0) target.file.writeAt(0, bytes);
  target.file.flush();
  return true;
}

function readInodeBytes(inode: wasiShim.Inode) {
  if (inode instanceof wasiShim.File) {
    return inode.data instanceof Uint8Array ? inode.data : new Uint8Array(inode.data ?? []);
  }
  return null;
}

async function createScratchFilePool({
  closeables,
  directoryHandle,
  scratchFilePoolSize,
  syncAccessMode,
}: {
  closeables: RandomAccessFileLike[];
  directoryHandle: FileSystemDirectoryHandleLike;
  scratchFilePoolSize?: unknown;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
}) {
  const count = normalizeScratchFilePoolSize(scratchFilePoolSize);
  if (count === 0) {
    return { directoryHandle: null, files: [], pool: [] };
  }

  const scratchDirectoryHandle = await directoryHandle.getDirectoryHandle(
    SCRATCH_DIRECTORY_NAME,
    { create: true },
  ) as FileSystemDirectoryHandleLike;
  const token = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const files = new Array<BrowserOpfsRandomAccessFile>(count);
  await forEachRangeConcurrently({
    count,
    limit: Math.min(count, SCRATCH_FILE_CREATE_CONCURRENCY),
    async run(index: number) {
      const scratchName = `${token}-${index}.tmp`;
      const fileHandle = await scratchDirectoryHandle.getFileHandle(scratchName, { create: true });
      const syncHandle = await openSyncAccessHandle({
        fileHandle,
        mode: writableSyncAccessMode(syncAccessMode),
      });
      const file = new BrowserOpfsRandomAccessFile(syncHandle, { scratchName });
      files[index] = file;
      closeables.push(file);
    },
  });
  return {
    directoryHandle: scratchDirectoryHandle,
    files,
    pool: [...files],
  };
}

async function forEachRangeConcurrently({
  count,
  limit,
  run,
}: {
  count: number;
  limit: number;
  run: (index: number) => Promise<void>;
}) {
  const total = Math.max(0, Number(count) || 0);
  if (total === 0) return;
  const parallel = Math.max(1, Math.floor(Number(limit) || 1));
  let nextIndex = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(parallel, total);
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push((async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;
        await run(index);
      }
    })());
  }
  await Promise.all(workers);
}

function createMemoryScratchFilePool({
  closeables,
  scratchFilePoolSize,
}: {
  closeables: RandomAccessFileLike[];
  scratchFilePoolSize?: unknown;
}) {
  const count = normalizeScratchFilePoolSize(scratchFilePoolSize);
  const files: BrowserMemoryRandomAccessFile[] = [];
  for (let index = 0; index < count; index += 1) {
    const file = new BrowserMemoryRandomAccessFile();
    files.push(file);
    closeables.push(file);
  }
  return {
    directoryHandle: null,
    files,
    pool: [...files],
  };
}

export function normalizeScratchFilePoolSize(value?: unknown) {
  if (value === undefined || value === null) return DEFAULT_SCRATCH_FILE_POOL_SIZE;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SCRATCH_FILE_POOL_SIZE;
  return Math.floor(parsed);
}

export async function cleanupBrowserOpfsMounts(mounts: BrowserOpfsMount[]) {
  for (const mount of mounts) {
    mount.finishRun();
    if (Array.isArray(mount.scratchFiles) && mount.scratchFiles.length > 0) {
      mount.scratchPool = [...mount.scratchFiles];
    }
  }
}

function copyRandomAccessFileSync(source: RandomAccessFileLike, target: RandomAccessFileLike) {
  if (source === target) return;
  const size = Number(source.size());
  const buffer = new Uint8Array(OPFS_COPY_CHUNK_SIZE);
  target.truncate(size);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const view = buffer.subarray(0, length);
    const read = source.readAt(offset, view);
    if (read <= 0) break;
    target.writeAt(offset, view.subarray(0, read));
    offset += read;
  }
  target.flush();
}

function unlinkEntryFromDirectory(contents: WasiDirectoryContents, pathStr: string) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return { ret: wasiShim.wasi.ERRNO_NOTCAPABLE, inode_obj: null };
  if (parts.length === 0) return { ret: wasiShim.wasi.ERRNO_INVAL, inode_obj: null };
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS || parent.entries === null) {
    return { ret: parent.ret, inode_obj: null };
  }
  const entry = parent.entries.get(parent.name) ?? null;
  if (!entry) return { ret: wasiShim.wasi.ERRNO_NOENT, inode_obj: null };
  parent.entries.delete(parent.name);
  return { ret: wasiShim.wasi.ERRNO_SUCCESS, inode_obj: entry };
}

type ParentDirectoryResolution =
  | { ret: number; entries: WasiDirectoryContents; name: string }
  | { ret: number; entries: null; name: null };

function resolveParentDirectory(contents: WasiDirectoryContents, parts: string[]): ParentDirectoryResolution {
  let entries = contents;
  for (const part of parts.slice(0, -1)) {
    const entry = entries.get(part) ?? null;
    if (!entry) return { ret: wasiShim.wasi.ERRNO_NOENT, entries: null, name: null };
    const entryContents = inodeMapContents(entry);
    if (!entryContents) {
      return { ret: wasiShim.wasi.ERRNO_NOTDIR, entries: null, name: null };
    }
    entries = entryContents;
  }
  return { ret: wasiShim.wasi.ERRNO_SUCCESS, entries, name: lastPathPart(parts) };
}

function normalizeWasiRelativePathParts(pathStr: string) {
  const value = String(pathStr);
  if (value.startsWith('/') || value.includes('\0')) return null;
  const parts: string[] = [];
  for (const token of value.split('/')) {
    if (token === '' || token === '.') continue;
    if (token === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(token);
  }
  return parts;
}

function validateWasiRelativePath(pathStr: string) {
  const value = String(pathStr);
  if (value.startsWith('/')) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (value.includes('\0')) return wasiShim.wasi.ERRNO_INVAL;

  const parts: string[] = [];
  for (const token of value.split('/')) {
    if (token === '' || token === '.') continue;
    if (token === '..') {
      if (parts.length === 0) return wasiShim.wasi.ERRNO_NOTCAPABLE;
      parts.pop();
      continue;
    }
    parts.push(token);
  }

  return wasiShim.wasi.ERRNO_SUCCESS;
}

function pathRequiresDirectory(pathStr: string, oflags: number) {
  return (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY
    || String(pathStr).endsWith('/');
}

export function normalizeMountHandleMap({
  mountHandles,
}: {
  mountHandles?: Record<string, unknown> | null;
}) {
  const normalized: Record<string, FileSystemDirectoryHandleLike> = {};
  if (!mountHandles) return normalized;

  for (const [guestPath, handle] of Object.entries(mountHandles)) {
    const normalizedGuestPath = normalizeGuestPath(guestPath, {
      label: `mountHandles[${guestPath}]`,
    });
    assertDirectoryHandle(handle, `mountHandles[${guestPath}]`);
    // assertDirectoryHandle throws above unless handle structurally matches a directory handle.
    normalized[normalizedGuestPath] = handle as FileSystemDirectoryHandleLike;
  }

  return normalized;
}

export function normalizeVirtualFiles(value: unknown): NormalizedVirtualFile[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('virtualFiles must be an array');
  return value.map((entry, index) => normalizeVirtualFile(entry, index));
}

function normalizeVirtualFile(entry: unknown, index: number): NormalizedVirtualFile {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError(`virtualFiles[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const path = normalizeGuestPath(record.path, { label: `virtualFiles[${index}].path` });
  const source = record.source ?? record.file ?? record.blob ?? record.bytes ?? record.data;
  const proxy = record.proxy;
  if (isVirtualFileProxy(proxy)) return { path, source: proxy };
  if (isVirtualFileProxy(source)) return { path, source };
  if (isBlobLike(source)) {
    if (typeof FileReaderSync !== 'function') {
      throw new Error('Blob virtual files require FileReaderSync in a dedicated worker');
    }
    return { path, source };
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return { path, source };
  throw new TypeError(`virtualFiles[${index}].source must be a Blob, File, Uint8Array, or ArrayBuffer`);
}

export function normalizeWritableRoots({
  workGuestPath,
  writableDirectories,
  inherited,
}: {
  workGuestPath: string;
  writableDirectories?: unknown;
  inherited?: string[];
}) {
  const roots = new Set(inherited ?? [workGuestPath]);
  for (const root of normalizeGuestPathList(writableDirectories, 'writableDirectories')) roots.add(root);
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function normalizeGuestPathList(value: unknown, label: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of guest paths`);
  return value.map((entry) => normalizeGuestPath(String(entry), { label }));
}

export function normalizeKnownInputPaths(value: unknown) {
  return normalizeGuestPathList(value, 'knownInputPaths');
}

export function normalizePreopenOutputPaths(value: unknown) {
  return normalizeGuestPathList(value, 'preopenOutputPaths');
}

export function isGuestPathWithinRoots(path: unknown, roots: readonly string[]) {
  const normalizedPath = normalizeGuestPath(path, { label: 'guest path' });
  for (const root of roots) {
    if (normalizedPath === root || normalizedPath.startsWith(`${root}/`)) return true;
  }
  return false;
}

export function isGuestPathWithinMount(path: string, mountPath: string) {
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

export function joinGuestPath(...parts: unknown[]) {
  const joined = parts
    .map((part, index) => {
      const value = String(part ?? '');
      if (index === 0) return value.replace(/\/+$/, '');
      return value.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .filter((part) => part.length > 0)
    .join('/');
  return normalizeGuestPath(joined.startsWith('/') ? joined : `/${joined}`, { label: 'guest path' });
}

export function normalizeRelativePathParts(value: unknown, { label = 'relative path' }: { label?: string } = {}) {
  const parts = String(value ?? '')
    .replace(/^\/+/, '')
    .split(PATH_SEPARATOR_REGEX)
    .filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes('\0')) {
      throw new TypeError(`${label} contains an unsafe path segment`);
    }
  }
  return parts;
}

export function normalizeStdin(stdin: unknown) {
  if (stdin === undefined || stdin === null) return new Uint8Array();
  if (typeof stdin === 'string') return new TextEncoder().encode(stdin);
  if (stdin instanceof Uint8Array) return stdin;
  if (stdin instanceof ArrayBuffer) return new Uint8Array(stdin);
  throw new TypeError('stdin must be a string, Uint8Array, ArrayBuffer, or undefined');
}
