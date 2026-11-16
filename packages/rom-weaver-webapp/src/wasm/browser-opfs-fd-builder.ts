import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { OPFS_COPY_CHUNK_SIZE } from "./browser-opfs-constants.ts";
import { joinGuestPath, normalizeStdin } from "./browser-opfs-guest-paths.ts";
import type { BrowserOpfsMount } from "./browser-opfs-mount.ts";
import { cleanupBrowserOpfsMounts } from "./browser-opfs-mount.ts";
import type { BrowserOpfsMountCache } from "./browser-opfs-mounts.ts";
import type { OpfsProxyClient } from "./browser-opfs-proxy-client.ts";
import { OpfsProxyError } from "./browser-opfs-proxy-client.ts";
import { BrowserProxyRandomAccessFile } from "./browser-opfs-proxy-file.ts";
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
  proxyClient: OpfsProxyClient;
  request: RomWeaverRunInput | undefined;
  runCloseables: unknown[];
  runtimeMounts: string[];
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
  stderrLineHandler,
  stdoutLineHandler,
  virtualFiles,
  writableRoots,
  syncAccessMode,
  mountCache,
  proxyClient,
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
        proxyClient,
        syncAccessMode,
        virtualOnly: virtualOnlyMounts,
        writableRoots,
      });
      mounts.push(mount);
      trace?.(`[browser-opfs] mount acquire done path=${mountPath}`);
      mount.startRun({
        runCloseables,
        trace,
        virtualFiles,
      });
      trace?.(`[browser-opfs] mount startRun done path=${mountPath}`);
      fds.push(new PreparedWasiPreopenDirectory(mount));
      if (mountPath === cwdMountPath) cwdMount = mount;
    }
  } catch (error) {
    trace?.(`[browser-opfs] build fds failed ${formatErrorForTrace(error)}`);
    try {
      closeSyncFiles(runCloseables);
    } catch (cleanupError) {
      trace?.(`[browser-opfs] build fds close cleanup failed ${formatErrorForTrace(cleanupError)}`);
    }
    try {
      await Promise.resolve(cleanupBrowserOpfsMounts(mounts));
    } catch (cleanupError) {
      trace?.(`[browser-opfs] build fds mount cleanup failed ${formatErrorForTrace(cleanupError)}`);
    }
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

/** Per-preopen cap on traced misses; matches the WASI-level cap in installDirectWasiFileIoImports. */
const MAX_TRACED_MISSING_OPENS = 20;

interface RenameParent {
  entries: WasiDirectoryContents;
  name: string;
}

interface RenamePlan {
  destinationParent: RenameParent;
  newGuestPath: string;
  oldGuestPath: string;
  source: WasiRandomAccessFileInode;
  sourceParent: RenameParent;
}

interface OpenedFd {
  ret: number;
  fd_obj: wasiShim.Fd | null;
}

class PreparedWasiPreopenDirectory extends wasiShim.PreopenDirectory {
  mount: BrowserOpfsMount;
  private tracedMissingOpens = 0;

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
        if (this.tracedMissingOpens < MAX_TRACED_MISSING_OPENS) {
          this.tracedMissingOpens += 1;
          // An empty mount can indicate that a worker resolved the wrong OPFS directory.
          this.mount.trace?.(
            `[browser-opfs] path open missing mount=${this.mount.mountPath} path=${basenameForTrace(pathStr)} entries=${this.mount.contents.size}`,
          );
        }
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

    const opened = entry.path_open(oflags, fsRightsBase, fdFlags);
    if (opened.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      // A guest open that fails surfaces to the user as an opaque format error ("archive is
      // invalid"); the errno only exists here.
      this.mount.trace?.(
        `[browser-opfs] path open failed path=${basenameForTrace(pathStr)} oflags=${oflags} errno=${opened.ret}`,
      );
    }
    return this.withMountDirectory(opened, pathStr);
  }

  /** Makes a directory fd opened under this mount remove files through the mount, not only the in-memory tree. */
  withMountDirectory(opened: OpenedFd, relativePath: string): OpenedFd {
    const { fd_obj: fdObj } = opened;
    if (opened.ret !== wasiShim.wasi.ERRNO_SUCCESS || !(fdObj instanceof wasiShim.OpenDirectory)) return opened;
    return { ...opened, fd_obj: new MountOpenDirectory(fdObj.dir, this, relativePath) };
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
    const live = findEntryInDirectory(this.mount.contents, pathStr);
    if (live instanceof WasiRandomAccessFileInode) prepareFileForUnlink(live);
    const unlinked = unlinkEntryFromDirectory(this.mount.contents, pathStr);
    if (unlinked.ret === wasiShim.wasi.ERRNO_SUCCESS) {
      // Also remove the backing OPFS file so the namespace matches the inode tree.
      try {
        this.mount.proxyClient.unlink(guestPath);
      } catch (error) {
        // best-effort: the inode is already gone, so a failed OPFS removal is traced, not returned. A
        // directory that never held a file has no OPFS entry (ENOENT), which is expected.
        const errno = error instanceof OpfsProxyError ? error.errno : wasiShim.wasi.ERRNO_IO;
        if (errno !== wasiShim.wasi.ERRNO_NOENT) {
          this.mount.trace?.(`[browser-opfs] path unlink failed path=${basenameForTrace(pathStr)} errno=${errno}`);
        }
      }
    }
    return unlinked;
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

  /**
   * Moves a closed output file to a new name in this mount through the proxy, so a staged extract
   * output is installed without copying its bytes. A directory or a file with an open fd is refused
   * and the guest installs by copying instead; an existing destination fails with EEXIST.
   */
  renameFile(oldPath: string, newPath: string) {
    const plan = this.planRename(oldPath, newPath);
    if (typeof plan === "number") return plan;
    const { destinationParent, newGuestPath, oldGuestPath, source, sourceParent } = plan;

    // OPFS cannot move a file that has an open handle, so release this inode's handle first; it
    // reopens by itself if the move fails and the file stays where it was.
    source.idlePool?.remove(source);
    try {
      source.closeIdleFile();
      this.mount.proxyClient.move(oldGuestPath, newGuestPath);
    } catch (error) {
      const errno = error instanceof OpfsProxyError ? error.errno : wasiShim.wasi.ERRNO_IO;
      this.mount.trace?.(
        `[browser-opfs] path move failed from=${basenameForTrace(oldPath)} to=${basenameForTrace(newPath)} errno=${errno}`,
      );
      return errno;
    }
    sourceParent.entries.delete(sourceParent.name);
    destinationParent.entries.set(
      destinationParent.name,
      createProxyFileInode(this.mount, newGuestPath, { create: false }),
    );
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  /** Checks that `oldPath` can move to `newPath` and resolves what the move touches; an errno means refuse. */
  private planRename(oldPath: string, newPath: string): RenamePlan | number {
    for (const path of [oldPath, newPath]) {
      const pathRet = validateWasiRelativePath(path);
      if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;
    }
    const oldGuestPath = joinGuestPath(this.mount.mountPath, oldPath);
    const newGuestPath = joinGuestPath(this.mount.mountPath, newPath);
    if (!(this.mount.isWritablePath(oldGuestPath) && this.mount.isWritablePath(newGuestPath))) {
      return wasiShim.wasi.ERRNO_ROFS;
    }
    const source = findEntryInDirectory(this.mount.contents, oldPath);
    if (!source) return wasiShim.wasi.ERRNO_NOENT;
    const isIdleOutput =
      source instanceof WasiRandomAccessFileInode && source.closeOnLastFdClose && source.openRefCount === 0;
    if (!isIdleOutput) return wasiShim.wasi.ERRNO_BUSY;
    if (findEntryInDirectory(this.mount.contents, newPath)) return wasiShim.wasi.ERRNO_EXIST;
    const oldParts = normalizeWasiRelativePathParts(oldPath);
    const newParts = normalizeWasiRelativePathParts(newPath);
    if (oldParts === null || newParts === null || newParts.length === 0) return wasiShim.wasi.ERRNO_INVAL;
    const sourceParent = resolveParentDirectory(this.mount.contents, oldParts);
    const destinationParent = resolveParentDirectory(this.mount.contents, newParts);
    if (sourceParent.entries === null) return sourceParent.ret;
    if (destinationParent.entries === null) return destinationParent.ret;
    return { destinationParent, newGuestPath, oldGuestPath, source, sourceParent };
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

/**
 * A directory fd opened under the mount. The shim's own OpenDirectory edits only the in-memory tree, so a
 * file removed through it (as `remove_dir_all` does) would keep its OPFS entry and block removing the
 * directory. Its removals go through the mount, and a directory fd from a nested open is wrapped the
 * same way. The nested open itself still resolves in the in-memory tree.
 */
class MountOpenDirectory extends wasiShim.OpenDirectory {
  private readonly mount: PreparedWasiPreopenDirectory;
  private readonly basePath: string;

  constructor(dir: wasiShim.Directory, mount: PreparedWasiPreopenDirectory, basePath: string) {
    super(dir);
    this.mount = mount;
    this.basePath = basePath;
  }

  override path_open(...args: Parameters<wasiShim.OpenDirectory["path_open"]>): OpenedFd {
    return this.mount.withMountDirectory(super.path_open(...args), this.mountPath(args[1]));
  }

  override path_unlink_file(pathStr: string) {
    return this.mount.path_unlink_file(this.mountPath(pathStr));
  }

  override path_remove_directory(pathStr: string) {
    return this.mount.path_remove_directory(this.mountPath(pathStr));
  }

  private mountPath(pathStr: string) {
    return `${this.basePath}/${pathStr}`;
  }
}

/**
 * An fd still open on the file (mkstemp-then-unlink temp files) may not have opened its proxy handle
 * yet, so open it: the proxy then defers the OPFS removal to the handle's close instead of the first
 * later write re-creating the unlinked path as an orphan. With no fd, close the parked handle so the
 * proxy removes the file now. A deferred removal would keep the file's directory from being removed
 * and would let a create at the same path revive the old bytes.
 */
function prepareFileForUnlink(file: WasiRandomAccessFileInode) {
  if (file.openRefCount > 0) {
    try {
      file.file.openNow?.();
    } catch {
      // best-effort: fall through to a plain unlink
    }
    return;
  }
  file.idlePool?.remove(file);
  try {
    file.closeIdleFile();
  } catch {
    // best-effort: the proxy defers the removal to the handle's later close
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

  // Create the real OPFS output file on demand through the proxy; the bytes persist as they are written.
  parent.entries.set(
    parent.name,
    createProxyFileInode(mount, joinGuestPath(mount.mountPath, pathStr), { create: true }),
  );
  return wasiShim.wasi.ERRNO_SUCCESS;
}

function createProxyFileInode(mount: BrowserOpfsMount, guestPath: string, { create }: { create: boolean }) {
  const proxyFile = new BrowserProxyRandomAccessFile(mount.proxyClient, guestPath, { create, writable: true });
  mount.trackOwnedFile(proxyFile);
  // Closing the last fd parks its adapter in the bounded idle pool; eviction releases its handle and buffers.
  // A later checksum pass can reopen it without keeping every archive entry open for the whole run.
  return new WasiRandomAccessFileInode(proxyFile, { closeOnLastFdClose: true, idlePool: mount.idleFilePool });
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
