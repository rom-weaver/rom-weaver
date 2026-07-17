import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpfsProxyChannel,
  OPFS_PROXY_GLOBAL_DOORBELL_INDEX,
  type OpfsProxyChannel,
  opfsProxyVersionIndex,
} from "../../src/wasm/browser-opfs-proxy-channel.ts";
import { CREATE_FLAG, WRITABLE_FLAG } from "../../src/wasm/browser-opfs-proxy-client.ts";
import {
  OPFS_PROXY_CONTROL_AUX_LOW_INDEX,
  OPFS_PROXY_CONTROL_HANDLE_INDEX,
  OPFS_PROXY_CONTROL_LENGTH_INDEX,
  OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX,
  OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX,
  OPFS_PROXY_CONTROL_OPCODE_INDEX,
  OPFS_PROXY_CONTROL_RESULT_INDEX,
  OPFS_PROXY_CONTROL_STATE_INDEX,
  OPFS_PROXY_CONTROL_STATUS_INDEX,
  OPFS_PROXY_HANDLE_BY_PATH,
  OPFS_PROXY_OP_CLOSE,
  OPFS_PROXY_OP_OPEN,
  OPFS_PROXY_OP_READ,
  OPFS_PROXY_OP_SIZE,
  OPFS_PROXY_OP_TRUNCATE,
  OPFS_PROXY_OP_UNLINK,
  OPFS_PROXY_OP_WRITE,
  OPFS_PROXY_STATE_DONE,
  OPFS_PROXY_STATE_IDLE,
  OPFS_PROXY_STATE_REQUESTED,
  OPFS_PROXY_STATUS_EIO,
  OPFS_PROXY_STATUS_OK,
} from "../../src/wasm/browser-opfs-proxy-protocol.ts";
import { type OpfsProxyServerHandle, startOpfsProxyServer } from "../../src/wasm/browser-opfs-proxy-server.ts";

// In-memory mock of the OPFS surface the proxy server needs. Files are growable byte buffers; the
// mock SyncAccessHandle mirrors FileSystemSyncAccessHandle's synchronous read/write/truncate API.
class MockFile {
  bytes = new Uint8Array(0);
  // Live SyncAccessHandle count for this file. WebKit/Safari allow at most one at a time, so the proxy
  // must never let this exceed 1 (the unlink-then-reopen-before-close case is the one that used to).
  liveHandles = 0;
  // Cumulative SyncAccessHandles ever created for this file, to prove a reopen reattached instead of
  // minting a fresh handle.
  createdHandles = 0;
}

class MockSyncAccessHandle {
  private open = true;
  constructor(private readonly file: MockFile) {
    this.file.liveHandles += 1;
    this.file.createdHandles += 1;
  }
  getSize(): number {
    return this.file.bytes.byteLength;
  }
  read(buffer: Uint8Array, options?: { at?: number }): number {
    const at = options?.at ?? 0;
    const available = Math.max(0, this.file.bytes.byteLength - at);
    const n = Math.min(buffer.byteLength, available);
    buffer.set(this.file.bytes.subarray(at, at + n));
    return n;
  }
  write(buffer: Uint8Array, options?: { at?: number }): number {
    const at = options?.at ?? 0;
    const end = at + buffer.byteLength;
    if (end > this.file.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.file.bytes);
      this.file.bytes = grown;
    }
    this.file.bytes.set(buffer, at);
    return buffer.byteLength;
  }
  truncate(size: number): void {
    const next = new Uint8Array(size);
    next.set(this.file.bytes.subarray(0, Math.min(size, this.file.bytes.byteLength)));
    this.file.bytes = next;
  }
  flush(): void {
    // no-op: the mock writes straight into the in-memory buffer
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.file.liveHandles -= 1;
  }
}

class MockFileHandle {
  kind = "file";
  constructor(readonly file: MockFile) {}
  async createSyncAccessHandle(): Promise<MockSyncAccessHandle> {
    // Mirror WebKit/Safari: only one SyncAccessHandle may be live per file at a time.
    if (this.file.liveHandles > 0) throw namedError("NoModificationAllowedError");
    return new MockSyncAccessHandle(this.file);
  }
}

class MockDirectoryHandle {
  kind = "directory";
  dirs = new Map<string, MockDirectoryHandle>();
  files = new Map<string, MockFileHandle>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDirectoryHandle> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw namedError("NotFoundError");
      dir = new MockDirectoryHandle();
      this.dirs.set(name, dir);
    }
    return dir;
  }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFileHandle> {
    let handle = this.files.get(name);
    if (!handle) {
      if (!options?.create) throw namedError("NotFoundError");
      handle = new MockFileHandle(new MockFile());
      this.files.set(name, handle);
    }
    return handle;
  }
  async removeEntry(name: string): Promise<void> {
    if (!(this.files.delete(name) || this.dirs.delete(name))) throw namedError("NotFoundError");
  }
  async *entries(): AsyncIterableIterator<[string, unknown]> {
    for (const [name, handle] of this.files) yield [name, handle];
    for (const [name, handle] of this.dirs) yield [name, handle];
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

const encoder = new TextEncoder();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface RequestFields {
  opcode: number;
  handle?: number;
  offset?: number;
  length?: number;
  auxLow?: number;
  path?: string;
  destPath?: string;
}

// Async stand-in for OpfsProxyClient: drives a slot WITHOUT Atomics.wait so it can cooperate with the
// async server loop on the same thread (the real client blocks, which only works cross-thread).
async function request(channel: OpfsProxyChannel, fields: RequestFields): Promise<{ result: number; status: number }> {
  const slot = channel.slots[0];
  if (!slot) throw new Error("no slot");
  let length = fields.length ?? 0;
  if (fields.path !== undefined) {
    const encoded = encoder.encode(fields.path);
    slot.data.set(encoded, 0);
    length = encoded.byteLength;
    if (fields.destPath !== undefined) {
      const dest = encoder.encode(fields.destPath);
      slot.data.set(dest, encoded.byteLength);
    }
  }
  const offset = fields.offset ?? 0;
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, fields.opcode);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_HANDLE_INDEX, fields.handle ?? OPFS_PROXY_HANDLE_BY_PATH);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX, offset >>> 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX, Math.floor(offset / 2 ** 32) >>> 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, length);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX, fields.auxLow ?? 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_RESULT_INDEX, 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATUS_INDEX, OPFS_PROXY_STATUS_OK);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
  Atomics.add(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
  Atomics.notify(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);

  for (let i = 0; i < 1000; i += 1) {
    if (Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX) === OPFS_PROXY_STATE_DONE) break;
    await tick();
  }
  const status = Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATUS_INDEX);
  const result = Atomics.load(slot.control, OPFS_PROXY_CONTROL_RESULT_INDEX);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_IDLE);
  return { result, status };
}

describe("opfs proxy channel", () => {
  let channel: OpfsProxyChannel;
  let root: MockDirectoryHandle;
  let server: OpfsProxyServerHandle;

  beforeEach(() => {
    channel = createOpfsProxyChannel(4);
    root = new MockDirectoryHandle();
    server = startOpfsProxyServer({
      channel,
      mounts: [{ directoryHandle: root as never, mountPath: "/work", writableRoots: ["/work"] }],
    });
  });

  afterEach(async () => {
    server.stop();
    await server.done;
  });

  it("creates, writes, reads back, and reports size", async () => {
    const opened = await request(channel, {
      auxLow: CREATE_FLAG | WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/out.bin",
    });
    expect(opened.status).toBe(OPFS_PROXY_STATUS_OK);
    const handle = opened.result;
    expect(handle).toBeGreaterThan(0);

    const payload = encoder.encode("hello proxy");
    channel.slots[0]?.data.set(payload, 0);
    const written = await request(channel, {
      handle,
      length: payload.byteLength,
      offset: 0,
      opcode: OPFS_PROXY_OP_WRITE,
    });
    expect(written.status).toBe(OPFS_PROXY_STATUS_OK);
    expect(written.result).toBe(payload.byteLength);

    const size = await request(channel, { handle, opcode: OPFS_PROXY_OP_SIZE });
    expect(size.result).toBe(payload.byteLength);

    const read = await request(channel, {
      handle,
      length: payload.byteLength,
      offset: 0,
      opcode: OPFS_PROXY_OP_READ,
    });
    expect(read.result).toBe(payload.byteLength);
    const readBack = new TextDecoder().decode(channel.slots[0]?.data.subarray(0, read.result));
    expect(readBack).toBe("hello proxy");

    // The file really landed in the mock OPFS tree.
    expect(root.files.get("out.bin")?.file.bytes.byteLength).toBe(payload.byteLength);
  });

  it("bumps the per-handle version on write and truncate", async () => {
    const { result: handle } = await request(channel, {
      auxLow: CREATE_FLAG | WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/v.bin",
    });
    const versionIndex = opfsProxyVersionIndex(handle);
    expect(Atomics.load(channel.global, versionIndex)).toBe(0);

    channel.slots[0]?.data.set(encoder.encode("abc"), 0);
    await request(channel, { handle, length: 3, offset: 0, opcode: OPFS_PROXY_OP_WRITE });
    expect(Atomics.load(channel.global, versionIndex)).toBe(1);

    await request(channel, { auxLow: 1, handle, opcode: OPFS_PROXY_OP_TRUNCATE });
    expect(Atomics.load(channel.global, versionIndex)).toBe(2);
  });

  it("shares one handle across opens via refcount and frees it on the last close", async () => {
    const first = await request(channel, {
      auxLow: CREATE_FLAG | WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/shared.bin",
    });
    const second = await request(channel, {
      auxLow: WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/shared.bin",
    });
    expect(second.result).toBe(first.result);

    // First close drops a ref but the handle stays usable.
    await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_CLOSE });
    const stillOpen = await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_SIZE });
    expect(stillOpen.status).toBe(OPFS_PROXY_STATUS_OK);

    // Second close frees it; re-opening mints a fresh id.
    await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_CLOSE });
    const reopened = await request(channel, {
      auxLow: WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/shared.bin",
    });
    expect(reopened.status).toBe(OPFS_PROXY_STATUS_OK);
  });

  it("reports NOENT (errno 44) when opening a missing file without create", async () => {
    const missing = await request(channel, { opcode: OPFS_PROXY_OP_OPEN, path: "/work/nope.bin" });
    expect(missing.status).toBe(44);
  });

  it("removes a created file once its last handle closes", async () => {
    const opened = await request(channel, {
      auxLow: CREATE_FLAG | WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/temp.bin",
    });
    expect(root.files.has("temp.bin")).toBe(true);

    // Unlink while the handle is still open: POSIX unlink-while-open detaches the name now but keeps
    // the OPFS file (and the open handle) valid until the last reference closes - OPFS cannot removeEntry
    // a file with a live SyncAccessHandle, and force-closing it would break the still-open fd.
    const unlink = await request(channel, { opcode: OPFS_PROXY_OP_UNLINK, path: "/work/temp.bin" });
    expect(unlink.status).toBe(OPFS_PROXY_STATUS_OK);
    expect(root.files.has("temp.bin")).toBe(true);
    const stillUsable = await request(channel, { handle: opened.result, opcode: OPFS_PROXY_OP_SIZE });
    expect(stillUsable.status).toBe(OPFS_PROXY_STATUS_OK);

    // Closing the last handle performs the deferred OPFS removal.
    await request(channel, { handle: opened.result, opcode: OPFS_PROXY_OP_CLOSE });
    await vi.waitFor(() => expect(root.files.has("temp.bin")).toBe(false));
  });

  it("removes a closed file immediately on unlink", async () => {
    const opened = await request(channel, {
      auxLow: CREATE_FLAG | WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/temp2.bin",
    });
    await request(channel, { handle: opened.result, opcode: OPFS_PROXY_OP_CLOSE });
    expect(root.files.has("temp2.bin")).toBe(true);
    const unlink = await request(channel, { opcode: OPFS_PROXY_OP_UNLINK, path: "/work/temp2.bin" });
    expect(unlink.status).toBe(OPFS_PROXY_STATUS_OK);
    expect(root.files.has("temp2.bin")).toBe(false);
  });

  it("reattaches to the live handle when a path is reopened before its unlink-deferred close", async () => {
    const first = await request(channel, {
      auxLow: CREATE_FLAG | WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/reopen.bin",
    });
    expect(first.status).toBe(OPFS_PROXY_STATUS_OK);
    const file = root.files.get("reopen.bin")?.file;
    expect(file?.liveHandles).toBe(1);

    // Unlink while open defers the OPFS removal to the last close; the file (and its single live handle)
    // stays valid. Reopening the same name BEFORE that close must reattach to the existing handle, not
    // open a second SyncAccessHandle on the same (not-yet-removed) OPFS file.
    const unlink = await request(channel, { opcode: OPFS_PROXY_OP_UNLINK, path: "/work/reopen.bin" });
    expect(unlink.status).toBe(OPFS_PROXY_STATUS_OK);

    const reopened = await request(channel, {
      auxLow: WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/reopen.bin",
    });
    expect(reopened.status).toBe(OPFS_PROXY_STATUS_OK);
    // Same id => reattached to the existing entry; never a second live handle on the file.
    expect(reopened.result).toBe(first.result);
    expect(file?.liveHandles).toBe(1);
    expect(file?.createdHandles).toBe(1);

    // The reopen bumped refcount to 2, so the first close keeps the handle usable...
    await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_CLOSE });
    const stillUsable = await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_SIZE });
    expect(stillUsable.status).toBe(OPFS_PROXY_STATUS_OK);
    expect(file?.liveHandles).toBe(1);

    // ...and the last close runs the deferred removal and frees the single handle.
    await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_CLOSE });
    await vi.waitFor(() => expect(root.files.has("reopen.bin")).toBe(false));
    expect(file?.liveHandles).toBe(0);
  });

  it("surfaces an error on a double-close (refcount underflow) instead of decrementing silently", async () => {
    const opened = await request(channel, {
      auxLow: CREATE_FLAG | WRITABLE_FLAG,
      opcode: OPFS_PROXY_OP_OPEN,
      path: "/work/dbl.bin",
    });
    expect(opened.status).toBe(OPFS_PROXY_STATUS_OK);

    // First close frees the single reference.
    const firstClose = await request(channel, { handle: opened.result, opcode: OPFS_PROXY_OP_CLOSE });
    expect(firstClose.status).toBe(OPFS_PROXY_STATUS_OK);

    // Second close targets an id that no longer exists: a protocol violation that must surface as EIO,
    // not silently drive a refcount negative (which would leak the entry forever).
    const secondClose = await request(channel, { handle: opened.result, opcode: OPFS_PROXY_OP_CLOSE });
    expect(secondClose.status).toBe(OPFS_PROXY_STATUS_EIO);
  });

  it("surfaces an error for an op targeting an unknown handle id", async () => {
    // 4242 was never allocated by an open; requireHandle must reject rather than swallow it.
    const size = await request(channel, { handle: 4242, opcode: OPFS_PROXY_OP_SIZE });
    expect(size.status).toBe(OPFS_PROXY_STATUS_EIO);

    const close = await request(channel, { handle: 4242, opcode: OPFS_PROXY_OP_CLOSE });
    expect(close.status).toBe(OPFS_PROXY_STATUS_EIO);
  });
});
