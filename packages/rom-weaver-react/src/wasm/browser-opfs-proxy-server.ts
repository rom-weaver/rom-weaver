// Producer (proxy worker) side of the OPFS async proxy channel.
//
// This is the single owner of every OPFS FileSystemSyncAccessHandle and the directory tree. It runs
// an async "doorbell" servicing loop: it waits on the shared doorbell counter, scans every slot, and
// services each REQUESTED op. Reads/writes/truncate/flush on an already-open handle are synchronous
// (fast); only open/mkdir/unlink/rename touch the async OPFS namespace APIs, which is why the loop is
// async (Atomics.waitAsync) rather than a blocking Atomics.wait. Consumers (browser-opfs-proxy-client)
// always block synchronously; only this side may yield.
//
// The loop never throws: every op is wrapped so a single failed request becomes an errno on its slot
// instead of killing the loop (which would hang every waiting consumer). A fatal/poison condition
// sets the global poison flag so consumers fail fast with EIO instead of waiting out their timeouts.

import {
  isGuestPathWithinMount,
  isGuestPathWithinRoots,
  normalizeRelativePathParts,
} from "./browser-opfs-guest-paths.ts";
import {
  OPFS_PROXY_GLOBAL_DOORBELL_INDEX,
  OPFS_PROXY_GLOBAL_HANDLE_ALLOC_INDEX,
  OPFS_PROXY_GLOBAL_POISONED_INDEX,
  OPFS_PROXY_MAX_HANDLES,
  type OpfsProxyChannel,
  type OpfsProxyChannelSlot,
  opfsProxyVersionIndex,
} from "./browser-opfs-proxy-channel.ts";
import { CREATE_FLAG, WRITABLE_FLAG } from "./browser-opfs-proxy-client.ts";
import {
  OPFS_PROXY_CONTROL_AUX_HIGH_INDEX,
  OPFS_PROXY_CONTROL_AUX_LOW_INDEX,
  OPFS_PROXY_CONTROL_HANDLE_INDEX,
  OPFS_PROXY_CONTROL_LENGTH_INDEX,
  OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX,
  OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX,
  OPFS_PROXY_CONTROL_OPCODE_INDEX,
  OPFS_PROXY_CONTROL_RESULT_INDEX,
  OPFS_PROXY_CONTROL_STATE_INDEX,
  OPFS_PROXY_CONTROL_STATUS_INDEX,
  OPFS_PROXY_OP_CLOSE,
  OPFS_PROXY_OP_FLUSH,
  OPFS_PROXY_OP_MKDIR,
  OPFS_PROXY_OP_OPEN,
  OPFS_PROXY_OP_PREAD,
  OPFS_PROXY_OP_READ,
  OPFS_PROXY_OP_RENAME,
  OPFS_PROXY_OP_SIZE,
  OPFS_PROXY_OP_TRUNCATE,
  OPFS_PROXY_OP_UNLINK,
  OPFS_PROXY_OP_WRITE,
  OPFS_PROXY_STATE_DONE,
  OPFS_PROXY_STATE_PROXY_SERVICING,
  OPFS_PROXY_STATE_REQUESTED,
  OPFS_PROXY_STATUS_OK,
} from "./browser-opfs-proxy-protocol.ts";
import type { FileSystemDirectoryHandleLike, RomWeaverBrowserSyncAccessMode } from "./browser-opfs-runtime-types.ts";
import { openSyncAccessHandle, type SyncAccessHandleLike, writableSyncAccessMode } from "./browser-opfs-sync-access.ts";

// WASI errno values the proxy reports through STATUS. Mirror wasiShim.wasi.ERRNO_* (kept local so the
// server stays free of the WASI shim and remains node-testable).
const ERRNO_ACCES = 2;
const ERRNO_EXIST = 20;
const ERRNO_IO = 29;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_NOTDIR = 54;
const ERRNO_ROFS = 69;

const DOORBELL_SLICE_MS = 250;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

interface OpfsProxyMountDescriptor {
  mountPath: string;
  directoryHandle: FileSystemDirectoryHandleLike;
  writableRoots: string[];
}

/**
 * Mount metadata posted to the proxy worker — the directory handle is intentionally NOT included.
 * Safari/iOS cannot structured-clone a FileSystemDirectoryHandle to a (nested) worker (DataCloneError),
 * so the worker re-resolves its own handle from the per-origin OPFS root. `rootRelativeParts` is the
 * path from the OPFS root to the mount's directory (computed by the runner via `root.resolve(handle)`):
 * empty when the mount IS the root (the app's case), or the subdirectory segments when it is a nested
 * handle (e.g. a test fixture dir). The worker navigates these from `navigator.storage.getDirectory()`.
 */
export interface OpfsProxyMountBootstrap {
  mountPath: string;
  rootRelativeParts: string[];
  writableRoots: string[];
}

export interface OpfsProxyServerOptions {
  channel: OpfsProxyChannel;
  mounts: OpfsProxyMountDescriptor[];
  syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  trace?: (line: string) => void;
}

export interface OpfsProxyServerHandle {
  /** Resolves once the servicing loop has fully stopped. */
  readonly done: Promise<void>;
  stop(): void;
}

interface HandleEntry {
  id: number;
  path: string;
  handle: SyncAccessHandleLike;
  writable: boolean;
  refcount: number;
  /** Set when the path was unlinked while this handle was still open; the OPFS entry is removed on the
   * last release (POSIX unlink-while-open: existing fds stay valid until they close). */
  pendingRemoval: { dir: FileSystemDirectoryHandleLike; name: string } | null;
}

interface FileLocation {
  mount: OpfsProxyMountDescriptor;
  parts: string[];
}

/** Start the proxy servicing loop. The returned handle stops the loop and exposes its completion. */
export function startOpfsProxyServer(options: OpfsProxyServerOptions): OpfsProxyServerHandle {
  const server = new OpfsProxyServer(options);
  const done = server.run();
  return {
    done,
    stop: () => server.stop(),
  };
}

class OpfsProxyServer {
  private readonly channel: OpfsProxyChannel;
  private readonly mounts: OpfsProxyMountDescriptor[];
  private readonly syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  private readonly trace?: (line: string) => void;
  private readonly byId = new Map<number, HandleEntry>();
  private readonly byPath = new Map<string, number>();
  private readonly freeIds: number[] = [];
  private running = true;

  constructor(options: OpfsProxyServerOptions) {
    this.channel = options.channel;
    // Longest mountPath first so nested mounts resolve to the most specific root.
    this.mounts = [...options.mounts].sort((a, b) => b.mountPath.length - a.mountPath.length);
    this.syncAccessMode = options.syncAccessMode;
    this.trace = options.trace;
  }

  stop(): void {
    this.running = false;
    // Wake the loop so it observes the stop flag promptly.
    Atomics.add(this.channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
    Atomics.notify(this.channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
  }

  async run(): Promise<void> {
    const { global, slots } = this.channel;
    this.trace?.(`[browser-opfs] proxy server start slots=${slots.length} mounts=${this.mounts.length}`);
    try {
      while (this.running) {
        const seen = Atomics.load(global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
        let servicedAny = false;
        for (const slot of slots) {
          if (Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX) !== OPFS_PROXY_STATE_REQUESTED) continue;
          if (
            Atomics.compareExchange(
              slot.control,
              OPFS_PROXY_CONTROL_STATE_INDEX,
              OPFS_PROXY_STATE_REQUESTED,
              OPFS_PROXY_STATE_PROXY_SERVICING,
            ) !== OPFS_PROXY_STATE_REQUESTED
          ) {
            continue;
          }
          await this.serviceSlot(slot);
          servicedAny = true;
        }
        if (servicedAny) continue;
        if (Atomics.load(global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX) !== seen) continue;
        const wait = Atomics.waitAsync(global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, seen, DOORBELL_SLICE_MS);
        if (wait.async) await wait.value;
      }
    } catch (error) {
      // The loop itself failing is fatal: poison so every waiting consumer fails fast with EIO.
      Atomics.store(global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);
      this.trace?.(`[browser-opfs] proxy server loop died ${String(error)}`);
    } finally {
      this.closeAllHandles();
      this.trace?.("[browser-opfs] proxy server stopped");
    }
  }

  private async serviceSlot(slot: OpfsProxyChannelSlot): Promise<void> {
    const { control, data } = slot;
    let status = OPFS_PROXY_STATUS_OK;
    let result = 0;
    try {
      result = await this.dispatch(slot);
    } catch (error) {
      status = errnoForError(error);
      const detail = `${String((error as { name?: string } | null)?.name ?? "Error")}: ${String((error as { message?: string } | null)?.message ?? error)}`;
      // Stash the human-readable error in the data buffer so the consumer can surface it (the wire
      // status only carries a coarse errno). RESULT holds the detail byte length on failure.
      const encoded = textEncoder.encode(detail).subarray(0, data.byteLength);
      data.set(encoded, 0);
      result = encoded.byteLength;
      this.trace?.(
        `[browser-opfs] proxy op failed opcode=${Atomics.load(control, OPFS_PROXY_CONTROL_OPCODE_INDEX)} errno=${status} ${detail}`,
      );
    }
    Atomics.store(control, OPFS_PROXY_CONTROL_RESULT_INDEX, result | 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_STATUS_INDEX, status);
    Atomics.store(control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_DONE);
    Atomics.notify(control, OPFS_PROXY_CONTROL_STATE_INDEX, 1);
  }

  private async dispatch(slot: OpfsProxyChannelSlot): Promise<number> {
    const { control, data } = slot;
    const opcode = Atomics.load(control, OPFS_PROXY_CONTROL_OPCODE_INDEX);
    switch (opcode) {
      case OPFS_PROXY_OP_OPEN:
        return this.opOpen(slot);
      case OPFS_PROXY_OP_READ:
      case OPFS_PROXY_OP_PREAD:
        return this.opRead(slot);
      case OPFS_PROXY_OP_WRITE:
        return this.opWrite(slot);
      case OPFS_PROXY_OP_TRUNCATE:
        return this.opTruncate(slot);
      case OPFS_PROXY_OP_FLUSH:
        this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX)).handle.flush();
        return 0;
      case OPFS_PROXY_OP_CLOSE:
        this.releaseHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
        return 0;
      case OPFS_PROXY_OP_SIZE:
        return this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX)).handle.getSize();
      case OPFS_PROXY_OP_UNLINK:
        await this.opUnlink(this.readPath(data, control, 0));
        return 0;
      case OPFS_PROXY_OP_MKDIR:
        await this.opMkdir(this.readPath(data, control, 0));
        return 0;
      case OPFS_PROXY_OP_RENAME:
        await this.opRename(slot);
        return 0;
      default:
        throw new ProxyErrno(ERRNO_IO);
    }
  }

  private async opOpen(slot: OpfsProxyChannelSlot): Promise<number> {
    const { control, data } = slot;
    const guestPath = this.readPath(data, control, 0);
    const auxLow = Atomics.load(control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX);
    const create = (auxLow & CREATE_FLAG) !== 0;
    const writableRequested = (auxLow & WRITABLE_FLAG) !== 0;
    const existing = this.byPath.get(guestPath);
    if (existing !== undefined) {
      const entry = this.byId.get(existing);
      if (entry) {
        entry.refcount += 1;
        return entry.id;
      }
    }
    const location = this.locate(guestPath);
    const writable = writableRequested || isGuestPathWithinRoots(guestPath, location.mount.writableRoots);
    const fileHandle = await this.resolveFileHandle(location, { create });
    const mode = writable ? writableSyncAccessMode(this.syncAccessMode) : "read-only";
    const handle = await openSyncAccessHandle({ fileHandle, mode });
    const id = this.allocId();
    const entry: HandleEntry = { handle, id, path: guestPath, pendingRemoval: null, refcount: 1, writable };
    this.byId.set(id, entry);
    this.byPath.set(guestPath, id);
    return id;
  }

  private opRead(slot: OpfsProxyChannelSlot): number {
    const { control, data } = slot;
    const entry = this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
    const offset = readOffset(control);
    const length = Atomics.load(control, OPFS_PROXY_CONTROL_LENGTH_INDEX);
    const target = data.subarray(0, Math.min(length, data.byteLength));
    return entry.handle.read(target, { at: offset });
  }

  private opWrite(slot: OpfsProxyChannelSlot): number {
    const { control, data } = slot;
    const entry = this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
    if (!entry.writable) throw new ProxyErrno(ERRNO_ROFS);
    const offset = readOffset(control);
    const length = Atomics.load(control, OPFS_PROXY_CONTROL_LENGTH_INDEX);
    const source = data.subarray(0, Math.min(length, data.byteLength));
    const written = entry.handle.write(source, { at: offset });
    this.bumpVersion(entry.id);
    return written;
  }

  private opTruncate(slot: OpfsProxyChannelSlot): number {
    const { control } = slot;
    const entry = this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
    if (!entry.writable) throw new ProxyErrno(ERRNO_ROFS);
    const size = readAux(control);
    entry.handle.truncate(size);
    this.bumpVersion(entry.id);
    return 0;
  }

  private async opUnlink(guestPath: string): Promise<void> {
    const location = this.locate(guestPath);
    const { dir, name } = await this.resolveParent(location, { create: false });
    if (!dir.removeEntry) throw new ProxyErrno(ERRNO_ACCES);
    // OPFS rejects removeEntry while a SyncAccessHandle is open on the file
    // (NoModificationAllowedError). If we still hold an open handle for this path, honor POSIX
    // unlink-while-open: detach it from the namespace now but defer the OPFS removeEntry until the
    // handle's last reference closes, so any fd that still points at it stays valid. Force-closing the
    // handle here would break those fds (a later read/size on it would fail with EIO).
    const openId = this.byPath.get(guestPath);
    const openEntry = openId === undefined ? undefined : this.byId.get(openId);
    if (openEntry) {
      openEntry.pendingRemoval = { dir, name };
      this.byPath.delete(guestPath);
      return;
    }
    try {
      await dir.removeEntry(name);
    } catch (error) {
      // A NoModificationAllowedError here means a handle is still open on the file even though it is no
      // longer in byPath — i.e. a prior unlink already deferred its removal to that handle's close. The
      // entry gets removed then, so treat this duplicate unlink as success rather than a spurious error.
      if ((error as { name?: string } | null)?.name !== "NoModificationAllowedError") throw error;
    }
  }

  private async opMkdir(guestPath: string): Promise<void> {
    const location = this.locate(guestPath);
    let dir = location.mount.directoryHandle;
    for (const part of location.parts) {
      dir = (await dir.getDirectoryHandle(part, { create: true })) as FileSystemDirectoryHandleLike;
    }
  }

  private async opRename(slot: OpfsProxyChannelSlot): Promise<void> {
    const { control, data } = slot;
    const srcLength = Atomics.load(control, OPFS_PROXY_CONTROL_LENGTH_INDEX);
    const destLength = Atomics.load(control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX);
    const srcPath = textDecoder.decode(new Uint8Array(data.subarray(0, srcLength)));
    const destPath = textDecoder.decode(new Uint8Array(data.subarray(srcLength, srcLength + destLength)));
    await this.renamePath(srcPath, destPath);
  }

  private async renamePath(srcPath: string, destPath: string): Promise<void> {
    const srcLocation = this.locate(srcPath);
    const srcParent = await this.resolveParent(srcLocation, { create: false });
    const srcFile = (await srcParent.dir.getFileHandle(srcParent.name)) as FileSystemFileHandleLike;
    // Native move() is atomic but fails if either endpoint has an open SyncAccessHandle. Use it only
    // when neither does; otherwise fall back to copy + (deferred) unlink so open fds stay valid.
    const endpointHasOpenHandle = this.byPath.has(srcPath) || this.byPath.has(destPath);
    if (typeof srcFile.move === "function" && !endpointHasOpenHandle) {
      const destLocation = this.locate(destPath);
      const destParent = await this.resolveParent(destLocation, { create: true });
      await srcFile.move(destParent.dir as unknown as FileSystemDirectoryHandle, destParent.name);
      this.byPath.delete(srcPath);
      return;
    }
    await this.copyPath(srcPath, destPath);
    await this.opUnlink(srcPath);
  }

  private async copyPath(srcPath: string, destPath: string): Promise<void> {
    const srcId = await this.opOpenInternal(srcPath, { create: false, writable: false });
    const destId = await this.opOpenInternal(destPath, { create: true, writable: true });
    try {
      const src = this.requireHandle(srcId);
      const dest = this.requireHandle(destId);
      const size = src.handle.getSize();
      dest.handle.truncate(size);
      const buffer = new Uint8Array(Math.min(size, 8 * 1024 * 1024) || 1);
      let offset = 0;
      while (offset < size) {
        const view = buffer.subarray(0, Math.min(buffer.byteLength, size - offset));
        const read = src.handle.read(view, { at: offset });
        if (read <= 0) break;
        dest.handle.write(view.subarray(0, read), { at: offset });
        offset += read;
      }
      dest.handle.flush();
    } finally {
      this.releaseHandle(srcId);
      this.releaseHandle(destId);
    }
  }

  private async opOpenInternal(guestPath: string, options: { create: boolean; writable: boolean }): Promise<number> {
    const existing = this.byPath.get(guestPath);
    if (existing !== undefined) {
      const entry = this.byId.get(existing);
      if (entry) {
        entry.refcount += 1;
        return entry.id;
      }
    }
    const location = this.locate(guestPath);
    const writable = options.writable || isGuestPathWithinRoots(guestPath, location.mount.writableRoots);
    const fileHandle = await this.resolveFileHandle(location, { create: options.create });
    const mode = writable ? writableSyncAccessMode(this.syncAccessMode) : "read-only";
    const handle = await openSyncAccessHandle({ fileHandle, mode });
    const id = this.allocId();
    this.byId.set(id, { handle, id, path: guestPath, pendingRemoval: null, refcount: 1, writable });
    this.byPath.set(guestPath, id);
    return id;
  }

  private readPath(data: Uint8Array, control: Int32Array, offset: number): string {
    const length = Atomics.load(control, OPFS_PROXY_CONTROL_LENGTH_INDEX);
    // TextDecoder rejects SharedArrayBuffer-backed views; copy into a plain buffer before decoding.
    return textDecoder.decode(new Uint8Array(data.subarray(offset, offset + length)));
  }

  private locate(guestPath: string): FileLocation {
    for (const mount of this.mounts) {
      if (!isGuestPathWithinMount(guestPath, mount.mountPath)) continue;
      const relative = guestPath.slice(mount.mountPath.length);
      const parts = normalizeRelativePathParts(relative, { label: "proxy guest path" });
      if (parts.length === 0) throw new ProxyErrno(ERRNO_ISDIR);
      return { mount, parts };
    }
    throw new ProxyErrno(ERRNO_NOENT);
  }

  private async resolveFileHandle(location: FileLocation, { create }: { create: boolean }): Promise<unknown> {
    const { dir, name } = await this.resolveParent(location, { create });
    return dir.getFileHandle(name, { create });
  }

  private async resolveParent(
    location: FileLocation,
    { create }: { create: boolean },
  ): Promise<{ dir: FileSystemDirectoryHandleLike; name: string }> {
    let dir = location.mount.directoryHandle;
    for (let i = 0; i < location.parts.length - 1; i += 1) {
      const part = location.parts[i];
      if (part === undefined) throw new ProxyErrno(ERRNO_NOENT);
      dir = (await dir.getDirectoryHandle(part, { create })) as FileSystemDirectoryHandleLike;
    }
    const name = location.parts[location.parts.length - 1];
    if (name === undefined) throw new ProxyErrno(ERRNO_NOENT);
    return { dir, name };
  }

  private requireHandle(handleId: number): HandleEntry {
    const entry = this.byId.get(handleId);
    if (!entry) throw new ProxyErrno(ERRNO_IO);
    return entry;
  }

  private releaseHandle(handleId: number): void {
    const entry = this.byId.get(handleId);
    if (!entry) return;
    entry.refcount -= 1;
    if (entry.refcount > 0) return;
    try {
      entry.handle.close();
    } catch {
      // best-effort close
    }
    this.byId.delete(handleId);
    if (this.byPath.get(entry.path) === handleId) this.byPath.delete(entry.path);
    this.freeIds.push(handleId);
    // A path unlinked while this handle was open deferred its OPFS removal to now (the handle is
    // closed, so removeEntry no longer hits NoModificationAllowedError). Best-effort, fire-and-forget.
    if (entry.pendingRemoval) {
      const { dir, name } = entry.pendingRemoval;
      entry.pendingRemoval = null;
      void Promise.resolve(dir.removeEntry?.(name)).catch(() => {
        // ignore best-effort deferred-unlink failures
      });
    }
  }

  private bumpVersion(handleId: number): void {
    Atomics.add(this.channel.global, opfsProxyVersionIndex(handleId), 1);
  }

  private allocId(): number {
    const reused = this.freeIds.pop();
    if (reused !== undefined) return reused;
    const next = Atomics.add(this.channel.global, OPFS_PROXY_GLOBAL_HANDLE_ALLOC_INDEX, 1) + 1;
    if (next >= OPFS_PROXY_MAX_HANDLES) throw new ProxyErrno(ERRNO_IO);
    return next;
  }

  private closeAllHandles(): void {
    for (const entry of this.byId.values()) {
      try {
        entry.handle.close();
      } catch {
        // best-effort close
      }
    }
    this.byId.clear();
    this.byPath.clear();
  }
}

// FileSystemFileHandle surface used for rename via move() when the browser supports it.
type FileSystemFileHandleLike = {
  move?: (destination: FileSystemDirectoryHandle, name?: string) => Promise<void>;
};

/** Carries a specific WASI errno out of an op handler so STATUS reflects the real failure kind. */
class ProxyErrno extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super(`proxy errno ${errno}`);
    this.name = "ProxyErrno";
    this.errno = errno;
  }
}

function readOffset(control: Int32Array): number {
  const low = Atomics.load(control, OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX) >>> 0;
  const high = Atomics.load(control, OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX) >>> 0;
  return high * 2 ** 32 + low;
}

function readAux(control: Int32Array): number {
  const low = Atomics.load(control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX) >>> 0;
  const high = Atomics.load(control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX) >>> 0;
  return high * 2 ** 32 + low;
}

function errnoForError(error: unknown): number {
  if (error instanceof ProxyErrno) return error.errno;
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotFoundError") return ERRNO_NOENT;
  if (name === "TypeMismatchError") return ERRNO_NOTDIR;
  if (name === "InvalidModificationError") return ERRNO_EXIST;
  if (name === "NoModificationAllowedError") return ERRNO_ACCES;
  return ERRNO_IO;
}
