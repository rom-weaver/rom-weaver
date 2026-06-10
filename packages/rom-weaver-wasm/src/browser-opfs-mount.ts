import * as wasiShim from '@bjorn3/browser_wasi_shim';
import { BrowserOpfsRandomAccessFile } from './browser-opfs-io-adapters.ts';
import { summarizeNormalizedVirtualFiles } from './browser-opfs-stdio-events.ts';
import { closeSyncFiles, openSyncAccessHandle, writableSyncAccessMode } from './browser-opfs-sync-access.ts';
import {
  isGuestPathWithinMount,
  isGuestPathWithinRoots,
  joinGuestPath,
  normalizePreopenOutputPaths,
} from './browser-opfs-guest-paths.ts';
import { lastPathPart, normalizeWasiRelativePathParts } from './browser-opfs-wasi-paths.ts';
import type { WasiDirectoryContents } from './browser-opfs-wasi-paths.ts';
import { WasiRandomAccessFileInode } from './browser-opfs-wasi-file-inode.ts';
import type { RandomAccessFileLike } from './browser-opfs-wasi-file-inode.ts';
import {
  addVirtualFilesToMount,
  restoreVirtualFiles,
} from './browser-opfs-virtual-files.ts';
import type { NormalizedVirtualFile, VirtualFileRestore } from './browser-opfs-virtual-files.ts';
import {
  createMemoryScratchFilePool,
  createScratchFilePool,
  normalizeScratchFilePoolSize,
} from './browser-opfs-scratch-pool.ts';
import type {
  FileSystemDirectoryHandleLike,
  RomWeaverBrowserSyncAccessMode,
  TraceLine,
} from './browser-opfs-runtime-types.ts';

export interface BrowserOpfsMountAcquireOptions {
  directoryHandle: FileSystemDirectoryHandleLike;
  mountPath: string;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  virtualOnly?: boolean;
  writableRoots: string[];
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

export class BrowserOpfsMount {
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

export async function cleanupBrowserOpfsMounts(mounts: BrowserOpfsMount[]) {
  for (const mount of mounts) {
    mount.finishRun();
    if (Array.isArray(mount.scratchFiles) && mount.scratchFiles.length > 0) {
      mount.scratchPool = [...mount.scratchFiles];
    }
  }
}
