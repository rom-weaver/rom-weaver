// Producer (proxy worker) side of the OPFS async proxy channel.
//
// Sole owner of OPFS sync handles and directories. Its async doorbell loop may
// yield for namespace operations; consumers block synchronously on their slots.
//
// Request failures become per-slot errno values. Fatal failures poison the
// channel so every consumer fails fast instead of timing out.

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
 * Mount metadata without a directory handle: Safari cannot clone handles to a
 * nested worker, so the proxy resolves `rootRelativeParts` from the OPFS root.
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
  /** Register a read-only Blob input servable by guest path (no OPFS staging copy). See opOpen. */
  registerBlobSource(path: string, blob: Blob): void;
  unregisterBlobSource(path: string): void;
}

interface HandleEntry {
  id: number;
  path: string;
  /** Null for Blob-backed (read-only input) entries, which read via `blob` instead of an OPFS handle. */
  handle: SyncAccessHandleLike | null;
  /** Set for read-only Blob-backed input entries; reads slice this instead of an OPFS sync handle. */
  blob: Blob | null;
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

export function startOpfsProxyServer(options: OpfsProxyServerOptions): OpfsProxyServerHandle {
  const server = new OpfsProxyServer(options);
  const done = server.run();
  return {
    done,
    registerBlobSource: (path, blob) => server.registerBlobSource(path, blob),
    stop: () => server.stop(),
    unregisterBlobSource: (path) => server.unregisterBlobSource(path),
  };
}

class OpfsProxyServer {
  private readonly channel: OpfsProxyChannel;
  private readonly mounts: OpfsProxyMountDescriptor[];
  private readonly syncAccessMode?: RomWeaverBrowserSyncAccessMode;
  private readonly trace?: (line: string) => void;
  private readonly byId = new Map<number, HandleEntry>();
  private readonly byPath = new Map<string, number>();
  // Paths unlinked while a handle was still open: the OPFS entry has NOT been removed yet (removeEntry
  // is deferred to the last close), so the underlying file is still live with exactly one open handle.
  // A reopen of such a path must reattach to that same handle - opening a second SyncAccessHandle on the
  // same OPFS file violates WebKit/Safari's one-handle-per-file rule and risks a double removeEntry.
  private readonly pendingByPath = new Map<string, number>();
  private readonly freeIds: number[] = [];
  // Read-only Blob inputs registered by guest path. opOpen resolves these to Blob-backed handles so a
  // worker-selected file is served like an OPFS handle without staging a copy into OPFS first.
  private readonly blobSources = new Map<string, Blob>();
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

  registerBlobSource(path: string, blob: Blob): void {
    this.blobSources.set(path, blob);
  }

  unregisterBlobSource(path: string): void {
    // Drop the source mapping; any handle still open on it keeps working (its entry holds the Blob ref)
    // until the last close, mirroring OPFS unlink-while-open.
    this.blobSources.delete(path);
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
      this.poisonAndWakeConsumers();
      this.trace?.(`[browser-opfs] proxy server loop died ${String(error)}`);
    } finally {
      this.closeAllHandles();
      // The loop has exited, so nothing will ever service another request: poison + wake every parked
      // consumer (a clean stop, not just a crash) so they fail fast instead of waiting out their full
      // op/acquire timeouts. Idempotent with the catch path above.
      this.poisonAndWakeConsumers();
      this.trace?.("[browser-opfs] proxy server stopped");
    }
  }

  // Mark the proxy dead and wake every consumer parked on a slot's STATE word — the poison flag alone
  // is invisible to a consumer already blocked in Atomics.wait; the notify unblocks it to re-check
  // isPoisoned() and fail fast.
  private poisonAndWakeConsumers(): void {
    Atomics.store(this.channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX, 1);
    for (const slot of this.channel.slots) {
      Atomics.notify(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX);
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
    // Encode the result across two words like read/write offsets so 64-bit values survive: RESULT
    // holds the low 32 bits, AUX_HIGH the high 32 bits. SIZE for a >= 2 GiB file would otherwise wrap
    // to a (often negative) 32-bit value; the consumer reconstructs high * 2**32 + (low >>> 0). Every
    // other op's result fits in 32 bits, so AUX_HIGH resolves to 0 for them.
    Atomics.store(control, OPFS_PROXY_CONTROL_RESULT_INDEX, result >>> 0);
    Atomics.store(control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX, Math.floor(result / 2 ** 32) >>> 0);
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
        // Blob inputs are read-only with nothing to flush; the handle is null for them.
        this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX)).handle?.flush();
        return 0;
      case OPFS_PROXY_OP_CLOSE:
        this.releaseHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
        return 0;
      case OPFS_PROXY_OP_SIZE: {
        const entry = this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
        return entry.blob ? entry.blob.size : (entry.handle?.getSize() ?? 0);
      }
      case OPFS_PROXY_OP_UNLINK:
        await this.opUnlink(this.readPath(data, control, 0));
        return 0;
      case OPFS_PROXY_OP_MKDIR:
        await this.opMkdir(this.readPath(data, control, 0));
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
    const reattached = this.reattachOpenHandle(guestPath, { create, writableRequested });
    if (reattached !== undefined) return reattached;
    // A registered Blob input is served as a read-only handle: no OPFS namespace lookup, no
    // SyncAccessHandle. Reads slice the Blob on this (dedicated, free) worker (see opRead).
    const blob = this.blobSources.get(guestPath);
    if (blob) {
      const id = this.allocId();
      const entry: HandleEntry = {
        blob,
        handle: null,
        id,
        path: guestPath,
        pendingRemoval: null,
        refcount: 1,
        writable: false,
      };
      this.byId.set(id, entry);
      this.byPath.set(guestPath, id);
      return id;
    }
    const location = this.locate(guestPath);
    const writable = writableRequested || isGuestPathWithinRoots(guestPath, location.mount.writableRoots);
    const fileHandle = await this.resolveFileHandle(location, { create });
    const mode = writable ? writableSyncAccessMode(this.syncAccessMode) : "read-only";
    const handle = await openSyncAccessHandle({ fileHandle, mode });
    const id = this.allocId();
    const entry: HandleEntry = { blob: null, handle, id, path: guestPath, pendingRemoval: null, refcount: 1, writable };
    this.byId.set(id, entry);
    this.byPath.set(guestPath, id);
    return id;
  }

  private opRead(slot: OpfsProxyChannelSlot): number | Promise<number> {
    const { control, data } = slot;
    const entry = this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
    const offset = readOffset(control);
    const length = Atomics.load(control, OPFS_PROXY_CONTROL_LENGTH_INDEX);
    const target = data.subarray(0, Math.min(length, data.byteLength));
    if (entry.blob) return this.readBlobAt(entry.blob, offset, target);
    if (!entry.handle) throw new ProxyErrno(ERRNO_IO);
    return entry.handle.read(target, { at: offset });
  }

  // Slice a read range out of a Blob input into the (SAB-backed) slot buffer. Async - only the dedicated
  // proxy worker runs it, so yielding here never blocks a consumer (they wait synchronously on the SAB).
  private async readBlobAt(blob: Blob, offset: number, target: Uint8Array): Promise<number> {
    const end = Math.min(offset + target.byteLength, blob.size);
    if (end <= offset) return 0;
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    const copyLength = Math.min(bytes.byteLength, target.byteLength);
    target.set(bytes.subarray(0, copyLength));
    return copyLength;
  }

  private opWrite(slot: OpfsProxyChannelSlot): number {
    const { control, data } = slot;
    const entry = this.requireHandle(Atomics.load(control, OPFS_PROXY_CONTROL_HANDLE_INDEX));
    if (!(entry.writable && entry.handle)) throw new ProxyErrno(ERRNO_ROFS);
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
    if (!(entry.writable && entry.handle)) throw new ProxyErrno(ERRNO_ROFS);
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
      // Keep the path discoverable so a reopen-before-last-close reattaches to this still-live handle
      // instead of opening a second one on the same (not-yet-removed) OPFS file.
      this.pendingByPath.set(guestPath, openEntry.id);
      return;
    }
    try {
      await dir.removeEntry(name);
    } catch (error) {
      // A NoModificationAllowedError here means a handle is still open on the file even though it is no
      // longer in byPath - i.e. a prior unlink already deferred its removal to that handle's close. The
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
    const name = location.parts.at(-1);
    if (name === undefined) throw new ProxyErrno(ERRNO_NOENT);
    return { dir, name };
  }

  // Reattach an open request to an existing live handle for `guestPath`, bumping its refcount. Covers two
  // cases: a normally-open path (byPath), and a path unlinked while still open (pendingByPath) whose OPFS
  // file is not yet removed - reattaching there guarantees we never open a second SyncAccessHandle on the
  // same file. Returns the handle id on reattach, or undefined when no live handle exists.
  private reattachOpenHandle(
    guestPath: string,
    options: { create?: boolean; writableRequested?: boolean } = {},
  ): number | undefined {
    const fromByPath = this.byPath.has(guestPath);
    const liveId = this.byPath.get(guestPath) ?? this.pendingByPath.get(guestPath);
    if (liveId === undefined) return undefined;
    const entry = this.byId.get(liveId);
    if (!entry) {
      // The path index points at a freed id: a stale mapping that should have been cleared on release.
      this.byPath.delete(guestPath);
      this.pendingByPath.delete(guestPath);
      this.trace?.(`[browser-opfs] proxy stale path index path=${guestPath} id=${liveId}`);
      return undefined;
    }
    // A writable open cannot be satisfied by a read-only handle: the existing SyncAccessHandle was
    // opened read-only and cannot be upgraded in place (a second handle on the same file violates the
    // WebKit one-handle rule), so reject rather than hand back a handle whose writes would hit EROFS.
    if (options.writableRequested && !entry.writable) {
      this.trace?.(
        `[browser-opfs] proxy reattach mode conflict path=${guestPath} requested=writable existing=read-only`,
      );
      throw new ProxyErrno(ERRNO_ACCES);
    }
    // POSIX create-after-unlink: a CREATE-intent open of a path whose handle is pending OPFS removal
    // (unlinked while still open) must not let the deferred removeEntry delete the freshly written
    // output at the old handle's last close. We cannot open a second SyncAccessHandle on the
    // not-yet-removed file, so revive this still-live handle as a normal entry and cancel its deferred
    // removal - the reopened path becomes the live file again instead of a doomed one.
    if (options.create && !fromByPath && entry.pendingRemoval) {
      entry.pendingRemoval = null;
      this.pendingByPath.delete(guestPath);
      this.byPath.set(guestPath, entry.id);
      this.trace?.(`[browser-opfs] proxy create-after-unlink revived path=${guestPath} id=${entry.id}`);
    }
    entry.refcount += 1;
    return entry.id;
  }

  private requireHandle(handleId: number): HandleEntry {
    const entry = this.byId.get(handleId);
    if (!entry) {
      this.trace?.(`[browser-opfs] proxy op on unknown handle id=${handleId}`);
      throw new ProxyErrno(ERRNO_IO);
    }
    return entry;
  }

  private releaseHandle(handleId: number): void {
    const entry = this.byId.get(handleId);
    if (!entry) {
      // A close/release targeting a handle that does not exist is a consumer protocol violation
      // (double-close, or a stale id). Surface it as an errno so it is visible rather than swallowed.
      this.trace?.(`[browser-opfs] proxy release of unknown handle id=${handleId}`);
      throw new ProxyErrno(ERRNO_IO);
    }
    if (entry.refcount <= 0) {
      // The entry is already fully released but still in byId (it should have been deleted at 0): a
      // double-close raced past the delete. Refuse to drive the count negative and leak the entry.
      this.trace?.(`[browser-opfs] proxy release underflow handle id=${handleId} refcount=${entry.refcount}`);
      throw new ProxyErrno(ERRNO_IO);
    }
    entry.refcount -= 1;
    if (entry.refcount > 0) return;
    try {
      entry.handle?.close();
    } catch (error) {
      this.trace?.(`[browser-opfs] proxy handle close failed id=${handleId} ${String(error)}`);
    }
    this.byId.delete(handleId);
    if (this.byPath.get(entry.path) === handleId) this.byPath.delete(entry.path);
    if (this.pendingByPath.get(entry.path) === handleId) this.pendingByPath.delete(entry.path);
    this.freeIds.push(handleId);
    // A path unlinked while this handle was open deferred its OPFS removal to now (the handle is
    // closed, so removeEntry no longer hits NoModificationAllowedError). Fire-and-forget but traced.
    if (entry.pendingRemoval) {
      const { dir, name } = entry.pendingRemoval;
      entry.pendingRemoval = null;
      void Promise.resolve(dir.removeEntry?.(name)).catch((error: unknown) => {
        this.trace?.(`[browser-opfs] proxy deferred unlink failed path=${entry.path} ${String(error)}`);
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
        entry.handle?.close();
      } catch {
        // best-effort close
      }
    }
    this.byId.clear();
    this.byPath.clear();
    this.pendingByPath.clear();
  }
}

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
