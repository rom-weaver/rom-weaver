import { describe, expect, it } from "vitest";
import {
  createOpfsProxyChannel,
  OPFS_PROXY_GLOBAL_DOORBELL_INDEX,
  type OpfsProxyChannel,
} from "../../src/wasm/browser-opfs-proxy-channel.ts";
import { CREATE_FLAG, WRITABLE_FLAG } from "../../src/wasm/browser-opfs-proxy-client.ts";
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
  OPFS_PROXY_HANDLE_BY_PATH,
  OPFS_PROXY_OP_CLOSE,
  OPFS_PROXY_OP_OPEN,
  OPFS_PROXY_OP_SIZE,
  OPFS_PROXY_OP_UNLINK,
  OPFS_PROXY_OP_WRITE,
  OPFS_PROXY_STATE_DONE,
  OPFS_PROXY_STATE_IDLE,
  OPFS_PROXY_STATE_REQUESTED,
  OPFS_PROXY_STATUS_OK,
} from "../../src/wasm/browser-opfs-proxy-protocol.ts";
import { type OpfsProxyServerHandle, startOpfsProxyServer } from "../../src/wasm/browser-opfs-proxy-server.ts";
import {
  THREAD_SLOT_LENGTH,
  THREAD_SLOT_STATE_INDEX,
  waitForAtomicsStateChange,
} from "../../src/wasm/browser-wasi-thread-protocol.ts";

const ERRNO_ACCES = 2;

// Minimal in-memory OPFS mock (a focused copy of the one in opfs-proxy-channel.test.ts). A MockFile can
// report a synthetic, arbitrarily large size so the 64-bit SIZE encoding can be exercised without
// allocating multi-gigabyte buffers.
class MockFile {
  bytes = new Uint8Array(0);
  fakeSize: number | null = null;
  liveHandles = 0;
  createdHandles = 0;
}

class MockSyncAccessHandle {
  private open = true;
  constructor(private readonly file: MockFile) {
    this.file.liveHandles += 1;
    this.file.createdHandles += 1;
  }
  getSize(): number {
    return this.file.fakeSize ?? this.file.bytes.byteLength;
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
    // no-op: in-memory mock has nothing to flush
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
  length?: number;
  auxLow?: number;
  path?: string;
}

// Drives a single slot without Atomics.wait so it can cooperate with the async server loop on one
// thread. Reconstructs the 64-bit result from RESULT (low) + AUX_HIGH (high), exactly as the real
// client does, so a >= 2 GiB SIZE survives the wire.
async function request(channel: OpfsProxyChannel, fields: RequestFields): Promise<{ result: number; status: number }> {
  const slot = channel.slots[0];
  if (!slot) throw new Error("no slot");
  let length = fields.length ?? 0;
  if (fields.path !== undefined) {
    const encoded = encoder.encode(fields.path);
    slot.data.set(encoded, 0);
    length = encoded.byteLength;
  }
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, fields.opcode);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_HANDLE_INDEX, fields.handle ?? OPFS_PROXY_HANDLE_BY_PATH);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OFFSET_LOW_INDEX, 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OFFSET_HIGH_INDEX, 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, length);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX, fields.auxLow ?? 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX, 0);
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
  const resultLow = Atomics.load(slot.control, OPFS_PROXY_CONTROL_RESULT_INDEX) >>> 0;
  const resultHigh = Atomics.load(slot.control, OPFS_PROXY_CONTROL_AUX_HIGH_INDEX) >>> 0;
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_IDLE);
  return { result: resultHigh * 2 ** 32 + resultLow, status };
}

function startServer(
  root: MockDirectoryHandle,
  writableRoots: string[],
): { channel: OpfsProxyChannel; server: OpfsProxyServerHandle } {
  const channel = createOpfsProxyChannel(4);
  const server = startOpfsProxyServer({
    channel,
    mounts: [{ directoryHandle: root as never, mountPath: "/work", writableRoots }],
  });
  return { channel, server };
}

describe("opfs proxy SIZE 64-bit encoding", () => {
  it("reports a >= 2 GiB size without truncating to a signed 32-bit value", async () => {
    const root = new MockDirectoryHandle();
    const { channel, server } = startServer(root, ["/work"]);
    try {
      const opened = await request(channel, {
        auxLow: CREATE_FLAG | WRITABLE_FLAG,
        opcode: OPFS_PROXY_OP_OPEN,
        path: "/work/big.bin",
      });
      expect(opened.status).toBe(OPFS_PROXY_STATUS_OK);

      // 3 GiB: under the old `result | 0` this wrapped to a negative 32-bit value.
      const bigSize = 3 * 1024 * 1024 * 1024;
      const file = root.files.get("big.bin")?.file;
      expect(file).toBeDefined();
      if (file) file.fakeSize = bigSize;

      const size = await request(channel, { handle: opened.result, opcode: OPFS_PROXY_OP_SIZE });
      expect(size.status).toBe(OPFS_PROXY_STATUS_OK);
      expect(size.result).toBe(bigSize);
    } finally {
      server.stop();
      await server.done;
    }
  });
});

describe("opfs proxy create-after-unlink", () => {
  it("preserves freshly written output when a path is recreated before its unlink-deferred close", async () => {
    const root = new MockDirectoryHandle();
    const { channel, server } = startServer(root, ["/work"]);
    try {
      const first = await request(channel, {
        auxLow: CREATE_FLAG | WRITABLE_FLAG,
        opcode: OPFS_PROXY_OP_OPEN,
        path: "/work/out.bin",
      });
      expect(first.status).toBe(OPFS_PROXY_STATUS_OK);
      const file = root.files.get("out.bin")?.file;
      expect(file?.liveHandles).toBe(1);

      // Unlink while open: removal deferred to last close.
      const unlink = await request(channel, { opcode: OPFS_PROXY_OP_UNLINK, path: "/work/out.bin" });
      expect(unlink.status).toBe(OPFS_PROXY_STATUS_OK);

      // Recreate the same path (O_CREAT) before that close: must reuse the still-live handle (no second
      // SyncAccessHandle) and cancel the pending removal so the new output is not deleted at dispose.
      const recreated = await request(channel, {
        auxLow: CREATE_FLAG | WRITABLE_FLAG,
        opcode: OPFS_PROXY_OP_OPEN,
        path: "/work/out.bin",
      });
      expect(recreated.status).toBe(OPFS_PROXY_STATUS_OK);
      expect(recreated.result).toBe(first.result);
      expect(file?.createdHandles).toBe(1);

      // Write fresh output through the revived handle.
      const payload = encoder.encode("fresh output");
      channel.slots[0]?.data.set(payload, 0);
      const written = await request(channel, {
        handle: recreated.result,
        length: payload.byteLength,
        opcode: OPFS_PROXY_OP_WRITE,
      });
      expect(written.result).toBe(payload.byteLength);

      // Release both refs. The deferred removal must NOT fire - the recreated file survives.
      await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_CLOSE });
      await request(channel, { handle: first.result, opcode: OPFS_PROXY_OP_CLOSE });
      await tick();
      expect(root.files.has("out.bin")).toBe(true);
      expect(root.files.get("out.bin")?.file.bytes.byteLength).toBe(payload.byteLength);
    } finally {
      server.stop();
      await server.done;
    }
  });
});

describe("opfs proxy reattach mode", () => {
  it("rejects a writable reopen of a read-only handle instead of returning a read-only one", async () => {
    const root = new MockDirectoryHandle();
    // No writable roots: writability comes only from the WRITABLE flag on each open.
    const { channel, server } = startServer(root, []);
    try {
      const readOnly = await request(channel, {
        auxLow: CREATE_FLAG,
        opcode: OPFS_PROXY_OP_OPEN,
        path: "/work/ro.bin",
      });
      expect(readOnly.status).toBe(OPFS_PROXY_STATUS_OK);

      // Reopening the same (still-open) path as writable cannot be satisfied by the read-only handle.
      const writable = await request(channel, {
        auxLow: WRITABLE_FLAG,
        opcode: OPFS_PROXY_OP_OPEN,
        path: "/work/ro.bin",
      });
      expect(writable.status).toBe(ERRNO_ACCES);
    } finally {
      server.stop();
      await server.done;
    }
  });
});

describe("waitForAtomicsStateChange shouldAbort", () => {
  it("returns 'aborted' before waiting when shouldAbort is already true", () => {
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH));
    const result = waitForAtomicsStateChange(control, THREAD_SLOT_STATE_INDEX, 0, {
      deadline: Date.now() + 60_000,
      shouldAbort: () => true,
    });
    expect(result).toBe("aborted");
  });

  it("bails out via shouldAbort after a slice instead of running out the full deadline", () => {
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH));
    let abort = false;
    const calls = { n: 0 };
    const started = Date.now();
    const result = waitForAtomicsStateChange(control, THREAD_SLOT_STATE_INDEX, 0, {
      deadline: Date.now() + 60_000,
      shouldAbort: () => {
        calls.n += 1;
        if (calls.n >= 2) abort = true;
        return abort;
      },
      sliceMs: 5,
    });
    expect(result).toBe("aborted");
    // Must have returned long before the 60s deadline.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still reports timed-out at the deadline when shouldAbort never fires", () => {
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH));
    const result = waitForAtomicsStateChange(control, THREAD_SLOT_STATE_INDEX, 0, {
      deadline: Date.now() - 1,
      shouldAbort: () => false,
    });
    expect(result).toBe("timed-out");
  });
});
