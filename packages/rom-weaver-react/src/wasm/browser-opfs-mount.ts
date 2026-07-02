import * as wasiShim from "@bjorn3/browser_wasi_shim";
import {
  isGuestPathWithinMount,
  isGuestPathWithinRoots,
  joinGuestPath,
  normalizePreopenOutputPaths,
} from "./browser-opfs-guest-paths.ts";
import type { OpfsProxyClient } from "./browser-opfs-proxy-client.ts";
import { BrowserProxyRandomAccessFile } from "./browser-opfs-proxy-file.ts";
import type {
  FileSystemDirectoryHandleLike,
  RomWeaverBrowserSyncAccessMode,
  TraceLine,
} from "./browser-opfs-runtime-types.ts";
import { summarizeNormalizedVirtualFiles } from "./browser-opfs-stdio-events.ts";
import { closeSyncFiles } from "./browser-opfs-sync-access.ts";
import type { NormalizedVirtualFile, VirtualFileRestore } from "./browser-opfs-virtual-files.ts";
import { addVirtualFilesToMount, restoreVirtualFiles } from "./browser-opfs-virtual-files.ts";
import type { RandomAccessFileLike } from "./browser-opfs-wasi-file-inode.ts";
import { WasiRandomAccessFileInode } from "./browser-opfs-wasi-file-inode.ts";
import type { WasiDirectoryContents } from "./browser-opfs-wasi-paths.ts";
import { lastPathPart, normalizeWasiRelativePathParts } from "./browser-opfs-wasi-paths.ts";

export interface BrowserOpfsMountAcquireOptions {
  directoryHandle: FileSystemDirectoryHandleLike;
  mountPath: string;
  /** The mount routes all OPFS I/O through this proxy client instead of owning sync handles. */
  proxyClient: OpfsProxyClient;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  virtualOnly?: boolean;
  writableRoots: string[];
}

interface BrowserOpfsMountConstructorOptions {
  contents: WasiDirectoryContents;
  directoryHandle: FileSystemDirectoryHandleLike;
  mountPath: string;
  ownedFiles: RandomAccessFileLike[];
  proxyClient: OpfsProxyClient;
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  virtualOnly?: boolean;
  writableRoots: string[];
}

export class BrowserOpfsMount {
  contents: WasiDirectoryContents;
  directoryHandle: FileSystemDirectoryHandleLike;
  mountPath: string;
  ownedFiles: RandomAccessFileLike[];
  /** Count of ownedFiles built at mount creation (the persistent input set). Everything appended past
   * this index is per-run (preopened/created outputs, lazily hydrated inputs) and pruned in finishRun. */
  persistentOwnedFileCount: number;
  proxyClient: OpfsProxyClient;
  syncAccessMode: RomWeaverBrowserSyncAccessMode | undefined;
  trace: TraceLine | null;
  virtualOnly: boolean;
  virtualRestores: VirtualFileRestore[] | null;
  writableRoots: string[];
  writableRootsKey: string;

  static async create({
    directoryHandle,
    mountPath,
    proxyClient,
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
          proxyClient,
          writableRoots,
        });
    return new BrowserOpfsMount({
      contents,
      directoryHandle,
      mountPath,
      ownedFiles,
      proxyClient,
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
    proxyClient,
    syncAccessMode,
    virtualOnly,
    writableRoots,
  }: BrowserOpfsMountConstructorOptions) {
    this.contents = contents;
    this.directoryHandle = directoryHandle;
    this.mountPath = mountPath;
    this.ownedFiles = ownedFiles;
    this.persistentOwnedFileCount = ownedFiles.length;
    this.proxyClient = proxyClient;
    this.syncAccessMode = syncAccessMode;
    this.virtualOnly = Boolean(virtualOnly);
    this.writableRoots = writableRoots;
    this.writableRootsKey = writableRoots.join("\0");
    this.virtualRestores = null;
    this.trace = null;
  }

  isWritablePath(guestPath: string) {
    return isGuestPathWithinRoots(guestPath, this.writableRoots);
  }

  startRun({
    runCloseables,
    virtualFiles,
    trace,
  }: {
    runCloseables: unknown[];
    virtualFiles?: NormalizedVirtualFile[];
    trace?: TraceLine;
  }) {
    void runCloseables;
    this.finishRun();
    this.trace = typeof trace === "function" ? trace : null;
    trace?.(
      `[browser-opfs] mount virtual files start path=${this.mountPath} ${summarizeNormalizedVirtualFiles(virtualFiles)}`,
    );
    if (Array.isArray(virtualFiles) && virtualFiles.length > 0) {
      this.virtualRestores = addVirtualFilesToMount({
        contents: this.contents,
        mountPath: this.mountPath,
        proxyClient: this.proxyClient,
        trace,
        virtualFiles,
      });
    } else {
      this.virtualRestores = [];
    }
    trace?.(`[browser-opfs] mount virtual files done path=${this.mountPath} mounted=${this.virtualRestores.length}`);
  }

  finishRun() {
    if (Array.isArray(this.virtualRestores) && this.virtualRestores.length > 0) {
      restoreVirtualFiles(this.virtualRestores);
    }
    this.virtualRestores = null;
    this.pruneRunOwnedFiles();
    this.trace = null;
  }

  /**
   * Close and forget every proxy adapter created during the run — preopened/created output files and
   * lazily hydrated inputs — reverting ownedFiles to the persistent set built at mount creation. A
   * cached mount reused across many ops would otherwise hold one open proxy handle per distinct
   * output/hydrated-input file until dispose, exhausting the proxy handle table (EIO) after ~1020 files.
   * The matching inodes are dropped from the in-memory tree so a later run recreates/rehydrates them
   * instead of dereferencing a now-closed handle.
   */
  pruneRunOwnedFiles() {
    if (this.ownedFiles.length <= this.persistentOwnedFileCount) return;
    const perRunFiles = this.ownedFiles.splice(this.persistentOwnedFileCount);
    evictInodesBackedByFiles(this.contents, new Set(perRunFiles));
    closeSyncFiles(perRunFiles);
    this.trace?.(
      `[browser-opfs] mount finishRun pruned run adapters path=${this.mountPath} closed=${perRunFiles.length}`,
    );
  }

  async preopenOutputPaths({ paths, trace }: { paths?: unknown; trace?: TraceLine } = {}) {
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
    const relativePath = guestPath === this.mountPath ? "" : guestPath.slice(this.mountPath.length + 1);
    const parts = normalizeWasiRelativePathParts(relativePath);
    if (parts === null || parts.length === 0) {
      throw new Error(`Browser OPFS output path must be a file inside ${this.mountPath}: ${guestPath}`);
    }

    let entries = this.contents;
    for (const part of parts.slice(0, -1)) {
      let entry: wasiShim.Inode | null = entries.get(part) ?? null;
      if (!entry) {
        entry = new wasiShim.Directory(new Map());
        entries.set(part, entry);
      }
      if (!(entry instanceof wasiShim.Directory)) {
        throw new Error(`Browser OPFS output parent is not a directory: ${guestPath}`);
      }
      // The proxy worker creates the OPFS directories on open; only build the wasm-side inode tree
      // here so path resolution works.
      entries = entry.contents;
    }

    const name = lastPathPart(parts);
    const existing = entries.get(name) ?? null;
    if (existing instanceof wasiShim.Directory) {
      throw new Error(`Browser OPFS output path is a directory: ${guestPath}`);
    }
    if (existing instanceof WasiRandomAccessFileInode && typeof existing.file?.close === "function") {
      try {
        existing.file.close();
      } catch {
        // ignore stale output handle cleanup failures; the new handle below owns the path.
      }
    }

    const proxyFile = new BrowserProxyRandomAccessFile(this.proxyClient, guestPath, {
      create: true,
      writable: true,
    });
    proxyFile.truncate(0);
    this.trackOwnedFile(proxyFile);
    entries.set(name, new WasiRandomAccessFileInode(proxyFile));
  }

  trackOwnedFile(file: RandomAccessFileLike) {
    this.ownedFiles.push(file);
  }

  dispose() {
    this.finishRun();
    closeSyncFiles(this.ownedFiles);
    this.ownedFiles = [];
  }
}

/** Recursively removes every directory entry whose inode is backed by one of the given files, so a
 * pruned per-run adapter leaves no dangling closed-handle inode in the mount tree. */
function evictInodesBackedByFiles(contents: WasiDirectoryContents, files: Set<RandomAccessFileLike>): void {
  if (files.size === 0) return;
  for (const [name, inode] of contents) {
    if (inode instanceof wasiShim.Directory) {
      evictInodesBackedByFiles(inode.contents, files);
      continue;
    }
    if (inode instanceof WasiRandomAccessFileInode && files.has(inode.file)) {
      contents.delete(name);
    }
  }
}

interface BuildOpfsInodeMapOptions {
  closeables: RandomAccessFileLike[];
  directoryHandle: FileSystemDirectoryHandleLike;
  guestPath: string;
  proxyClient: OpfsProxyClient;
  writableRoots: string[];
}

async function buildOpfsInodeMap({
  closeables,
  directoryHandle,
  guestPath,
  proxyClient,
  writableRoots,
}: BuildOpfsInodeMapOptions): Promise<WasiDirectoryContents> {
  const entries = new Map<string, wasiShim.Inode>();

  for await (const [entryName, rawEntryHandle] of directoryHandle.entries()) {
    // entries() yields handles typed as unknown; kind discriminates directory vs file handles.
    const entryHandle = rawEntryHandle as FileSystemDirectoryHandleLike;
    const entryGuestPath = joinGuestPath(guestPath, entryName);
    if (entryHandle.kind === "directory") {
      // A sibling op concurrently extracting into the shared /work root can be removing/rewriting a
      // subtree while this mount is built; that subtree is not this op's input, so skip it on failure
      // rather than aborting the whole mount build (which surfaces as InvalidStateError → no extract).
      let nested: WasiDirectoryContents;
      try {
        nested = await buildOpfsInodeMap({
          closeables,
          directoryHandle: entryHandle,
          guestPath: entryGuestPath,
          proxyClient,
          writableRoots,
        });
      } catch {
        continue;
      }
      entries.set(entryName, new wasiShim.Directory(nested));
      continue;
    }

    if (entryHandle.kind !== "file") continue;

    const writable = isGuestPathWithinRoots(entryGuestPath, writableRoots);
    // The proxy worker owns the handle. Reference the file by guest path (opened lazily on first
    // access), so the runner never holds a sync handle and spawned threads can reach it too.
    const proxyFile = new BrowserProxyRandomAccessFile(proxyClient, entryGuestPath, { writable });
    closeables.push(proxyFile);
    entries.set(entryName, new WasiRandomAccessFileInode(proxyFile, { readonly: !writable }));
  }

  return entries;
}

export function cleanupBrowserOpfsMounts(mounts: BrowserOpfsMount[]) {
  for (const mount of mounts) {
    mount.finishRun();
  }
}
