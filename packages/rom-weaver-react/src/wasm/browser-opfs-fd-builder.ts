import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { OPFS_COPY_CHUNK_SIZE } from "./browser-opfs-constants.ts";
import { joinGuestPath, normalizeStdin } from "./browser-opfs-guest-paths.ts";
import type { BrowserOpfsMount } from "./browser-opfs-mount.ts";
import { cleanupBrowserOpfsMounts } from "./browser-opfs-mount.ts";
import type { BrowserOpfsMountCache } from "./browser-opfs-mounts.ts";
import type {
  FileSystemDirectoryHandleLike,
  LineHandler,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverRunInput,
  TraceLine,
} from "./browser-opfs-runtime-types.ts";
import {
  basenameForTrace,
  createOutputCollector,
  formatErrorForTrace,
  summarizeNormalizedVirtualFiles,
} from "./browser-opfs-stdio-events.ts";
import { closeSyncFiles } from "./browser-opfs-sync-access.ts";
import type { NormalizedVirtualFile } from "./browser-opfs-virtual-files.ts";
import { syncMountedInputPathsFromOpfs } from "./browser-opfs-virtual-files.ts";
import type { RandomAccessFileLike } from "./browser-opfs-wasi-file-inode.ts";
import { WasiRandomAccessFileInode } from "./browser-opfs-wasi-file-inode.ts";
import type { WasiDirectoryContents } from "./browser-opfs-wasi-paths.ts";
import {
  findEntryInDirectory,
  normalizeWasiRelativePathParts,
  pathIsDirectoryInDirectory,
  pathRequiresDirectory,
  requestsWriteRights,
  resolveParentDirectory,
  unlinkEntryFromDirectory,
  validateWasiRelativePath,
} from "./browser-opfs-wasi-paths.ts";

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
          `No directory handle provided for runtime mount ${mountPath}. ` +
            "Provide options.mountHandles or runOptions.mountHandles.",
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
        trace,
        virtualFiles,
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
    fds.push(new PreparedWasiPreopenDirectory(cwdMount, { preopenName: "." }));
  }
  if (virtualOnlyMounts) {
    trace?.("[browser-opfs] sync mounted input paths start for virtual-only mount");
  }
  const syncSummary = await syncMountedInputPathsFromOpfs({
    cwdMountPath,
    knownInputPaths,
    mountHandles,
    mounts,
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
    stderrChunks: stderrCollector.chunks,
    stderrCollector,
    stdoutChunks: stdoutCollector.chunks,
    stdoutCollector,
  };
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
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return { fd_obj: null, ret: pathRet };

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    let entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!entry) {
      if ((oflags & wasiShim.wasi.OFLAGS_CREAT) !== wasiShim.wasi.OFLAGS_CREAT) {
        return { fd_obj: null, ret: wasiShim.wasi.ERRNO_NOENT };
      }
      if (!this.mount.isWritablePath(guestPath)) {
        return { fd_obj: null, ret: wasiShim.wasi.ERRNO_ROFS };
      }
      const created = createInMemoryEntry(this.mount.contents, pathStr, {
        directory: (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY,
        mount: this.mount,
      });
      if (created !== wasiShim.wasi.ERRNO_SUCCESS) {
        this.mount.trace?.(`[browser-opfs] path create failed path=${basenameForTrace(pathStr)} errno=${created}`);
        return { fd_obj: null, ret: created };
      }
      entry = findEntryInDirectory(this.mount.contents, pathStr);
      if (!entry) return { fd_obj: null, ret: wasiShim.wasi.ERRNO_IO };
    } else if ((oflags & wasiShim.wasi.OFLAGS_EXCL) === wasiShim.wasi.OFLAGS_EXCL) {
      return { fd_obj: null, ret: wasiShim.wasi.ERRNO_EXIST };
    } else if (!this.mount.isWritablePath(guestPath) && requestsWriteRights(fsRightsBase, oflags)) {
      return { fd_obj: null, ret: wasiShim.wasi.ERRNO_PERM };
    }

    if (pathRequiresDirectory(pathStr, oflags) && !(entry instanceof wasiShim.Directory)) {
      return { fd_obj: null, ret: wasiShim.wasi.ERRNO_NOTDIR };
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
      return { inode_obj: null, ret: pathRet };
    }

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return { inode_obj: null, ret: wasiShim.wasi.ERRNO_ROFS };
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
  parent.entries.set(parent.name, new WasiRandomAccessFileInode(file, { scratchBacked: true }));
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
