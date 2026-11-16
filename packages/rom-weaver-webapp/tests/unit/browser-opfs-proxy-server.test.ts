import { requestOpfsShutdown, waitForOpfsShutdownState } from "../../src/wasm/browser-opfs-shutdown.ts";
import { afterEach, expect, test, vi } from "vitest";
import {
  createOpfsProxyChannel,
  OPFS_PROXY_GLOBAL_DOORBELL_INDEX,
  OPFS_PROXY_GLOBAL_POISONED_INDEX,
} from "../../src/wasm/browser-opfs-proxy-channel.ts";
import {
  OPFS_PROXY_CONTROL_AUX_LOW_INDEX,
  OPFS_PROXY_CONTROL_LENGTH_INDEX,
  OPFS_PROXY_CONTROL_OPCODE_INDEX,
  OPFS_PROXY_CONTROL_RESULT_INDEX,
  OPFS_PROXY_CONTROL_STATE_INDEX,
  OPFS_PROXY_CONTROL_STATUS_INDEX,
  OPFS_PROXY_OP_MOVE,
  OPFS_PROXY_OP_OPEN,
  OPFS_PROXY_OP_UNLINK,
  OPFS_PROXY_STATE_DONE,
  OPFS_PROXY_STATE_IDLE,
  OPFS_PROXY_STATE_REQUESTED,
  OPFS_PROXY_STATUS_OK,
} from "../../src/wasm/browser-opfs-proxy-protocol.ts";
import { startOpfsProxyServer } from "../../src/wasm/browser-opfs-proxy-server.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("poisons the channel and clears its watchdog when the native wait rejects", async () => {
  vi.useFakeTimers();
  let rejectWait: (error: Error) => void = () => undefined;
  const nativeWait = new Promise<"ok">((_, reject) => {
    rejectWait = reject;
  });
  vi.spyOn(Atomics, "waitAsync").mockReturnValue({ async: true, value: nativeWait });
  const channel = createOpfsProxyChannel(1);
  const trace = vi.fn();
  const server = startOpfsProxyServer({ channel, mounts: [], trace });
  rejectWait(new Error("native wait failed"));
  await server.done;
  expect(Atomics.load(channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX)).toBe(1);
  expect(trace).toHaveBeenCalledWith(expect.stringContaining("native wait failed"));
  expect(vi.getTimerCount()).toBe(0);
});

test("services a request and stops when the native doorbell wait never resolves", async () => {
  vi.useFakeTimers();
  const nativeWait = new Promise<"ok">(() => undefined);
  const nativeThen = vi.spyOn(nativeWait, "then");
  const waitAsync = vi.spyOn(Atomics, "waitAsync").mockReturnValue({ async: true, value: nativeWait });
  const channel = createOpfsProxyChannel(1);
  const server = startOpfsProxyServer({ channel, mounts: [] });
  let stopped = false;
  void server.done.then(() => {
    stopped = true;
  });
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(1);
    server.registerBlobSource("/input.bin", new Blob(["abc"]));
    const slot = channel.slots[0];
    if (!slot) throw new Error("Proxy channel has no request slot");
    const path = new TextEncoder().encode("/input.bin");
    slot.data.set(path);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, OPFS_PROXY_OP_OPEN);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, path.byteLength);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    Atomics.add(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
    Atomics.notify(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
    await vi.advanceTimersByTimeAsync(1000);
    expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX)).toBe(OPFS_PROXY_STATE_DONE);
    expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATUS_INDEX)).toBe(OPFS_PROXY_STATUS_OK);
    expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_RESULT_INDEX)).toBeGreaterThan(0);
    expect(waitAsync).toHaveBeenCalledTimes(1);
    expect(nativeThen).toHaveBeenCalledTimes(1);
  } finally {
    server.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect.soft(stopped).toBe(true);
    expect.soft(vi.getTimerCount()).toBe(0);
  }
});

test("traces a missing unlink target as a miss rather than a failure", async () => {
  const channel = createOpfsProxyChannel(1);
  const trace = vi.fn();
  const notFound = Object.assign(new Error("missing"), { name: "NotFoundError" });
  const directoryHandle = {
    getDirectoryHandle: vi.fn(),
    removeEntry: vi.fn().mockRejectedValue(notFound),
  };
  const server = startOpfsProxyServer({
    channel,
    mounts: [{ directoryHandle, mountPath: "/out", writableRoots: ["/out"] }] as never,
    trace,
  });
  try {
    const slot = channel.slots[0];
    if (!slot) throw new Error("Proxy channel has no request slot");
    const path = new TextEncoder().encode("/out/gone.bin");
    slot.data.set(path);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, OPFS_PROXY_OP_UNLINK);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, path.byteLength);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    Atomics.add(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
    Atomics.notify(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
    await vi.waitFor(() => {
      expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX)).toBe(OPFS_PROXY_STATE_DONE);
    });
    const lines = trace.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes("proxy op missed opcode=8"))).toBe(true);
    expect(lines.filter((line) => line.includes("failed"))).toEqual([]);
  } finally {
    server.stop();
  }
});

test.each([false, true])("shared stop waits for blocked open and reports close failure=%s", async (closeFailure) => {
  const channel = createOpfsProxyChannel(1);
  const shutdownControl = new Int32Array(new SharedArrayBuffer(4));
  let finishOpen!: (handle: unknown) => void;
  const close = vi.fn(() => {
    if (closeFailure) throw new Error("handle close failed");
  });
  const createSyncAccessHandle = vi.fn(
    () =>
      new Promise((resolve) => {
        finishOpen = resolve;
      }),
  );
  const directoryHandle = {
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn().mockResolvedValue({ createSyncAccessHandle }),
  };
  const server = startOpfsProxyServer({
    channel,
    shutdownControl,
    mounts: [{ directoryHandle, mountPath: "/out", writableRoots: ["/out"] }] as never,
  });
  const slot = channel.slots[0];
  if (!slot) throw new Error("Proxy channel has no request slot");
  const path = new TextEncoder().encode("/out/late.bin");
  slot.data.set(path);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, OPFS_PROXY_OP_OPEN);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, path.byteLength);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
  Atomics.add(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
  Atomics.notify(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
  await vi.waitFor(() => expect(createSyncAccessHandle).toHaveBeenCalled());
  requestOpfsShutdown(shutdownControl);
  await vi.waitFor(() => expect(Atomics.load(channel.global, OPFS_PROXY_GLOBAL_POISONED_INDEX)).toBe(1));
  expect(Atomics.load(shutdownControl, 0)).toBe(1);
  expect(close).not.toHaveBeenCalled();
  finishOpen({ close, getSize: () => 0 });
  await server.done;
  if (closeFailure) await expect(waitForOpfsShutdownState(shutdownControl, 2)).rejects.toThrow("failed to close");
  else await waitForOpfsShutdownState(shutdownControl, 2);
  expect(close).toHaveBeenCalledOnce();
});

test("closed acknowledgement waits for deferred unlink completion", async () => {
  const channel = createOpfsProxyChannel(1);
  const shutdownControl = new Int32Array(new SharedArrayBuffer(4));
  let finishRemoval!: () => void;
  const close = vi.fn();
  const removeEntry = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishRemoval = resolve;
      }),
  );
  const directoryHandle = {
    getDirectoryHandle: vi.fn(),
    removeEntry,
    getFileHandle: vi
      .fn()
      .mockResolvedValue({ createSyncAccessHandle: vi.fn().mockResolvedValue({ close, getSize: () => 0 }) }),
  };
  const server = startOpfsProxyServer({
    channel,
    shutdownControl,
    mounts: [{ directoryHandle, mountPath: "/out", writableRoots: ["/out"] }] as never,
  });
  const slot = channel.slots[0];
  if (!slot) throw new Error("Proxy channel has no request slot");
  const path = new TextEncoder().encode("/out/removed.bin");
  const send = async (opcode: number) => {
    slot.data.set(path);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, opcode);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, path.byteLength);
    Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
    Atomics.add(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
    Atomics.notify(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
    await vi.waitFor(() =>
      expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX)).toBe(OPFS_PROXY_STATE_DONE),
    );
  };
  await send(OPFS_PROXY_OP_OPEN);
  await send(OPFS_PROXY_OP_UNLINK);
  requestOpfsShutdown(shutdownControl);
  await vi.waitFor(() => expect(removeEntry).toHaveBeenCalled());
  expect(close).toHaveBeenCalledOnce();
  expect(Atomics.load(shutdownControl, 0)).toBe(1);
  finishRemoval();
  await server.done;
  expect(Atomics.load(shutdownControl, 0)).toBe(2);
});

test("the server loop stops and acknowledges on a shutdown request even when Atomics.waitAsync never resolves", async () => {
  // Some engines leave waitAsync unresolved after a notification, so the loop must not depend on it to stop.
  const waitAsync = vi
    .spyOn(Atomics, "waitAsync")
    .mockImplementation((() => ({ async: true, value: new Promise(() => undefined) })) as never);
  try {
    const channel = createOpfsProxyChannel(1);
    const shutdownControl = new Int32Array(new SharedArrayBuffer(4));
    const server = startOpfsProxyServer({
      channel,
      shutdownControl,
      mounts: [{ directoryHandle: {}, mountPath: "/out", writableRoots: ["/out"] }] as never,
    });
    requestOpfsShutdown(shutdownControl);
    await vi.waitFor(() => expect(Atomics.load(shutdownControl, 0)).toBe(2));
    await server.done;
  } finally {
    waitAsync.mockRestore();
  }
});

const ERRNO_BUSY = 10;
const ERRNO_EXIST = 20;
const ERRNO_NOTSUP = 58;
const ERRNO_XDEV = 75;

const notFound = () => Object.assign(new Error("missing"), { name: "NotFoundError" });

type ProxyChannel = ReturnType<typeof createOpfsProxyChannel>;

async function sendProxyRequest(channel: ProxyChannel, opcode: number, paths: string[]) {
  const slot = channel.slots[0];
  if (!slot) throw new Error("Proxy channel has no request slot");
  const encoded = paths.map((path) => new TextEncoder().encode(path));
  let offset = 0;
  for (const bytes of encoded) {
    slot.data.set(bytes, offset);
    offset += bytes.byteLength;
  }
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_OPCODE_INDEX, opcode);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_LENGTH_INDEX, encoded[0]?.byteLength ?? 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_AUX_LOW_INDEX, encoded[1]?.byteLength ?? 0);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_REQUESTED);
  Atomics.add(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX, 1);
  Atomics.notify(channel.global, OPFS_PROXY_GLOBAL_DOORBELL_INDEX);
  await vi.waitFor(() =>
    expect(Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX)).toBe(OPFS_PROXY_STATE_DONE),
  );
  const status = Atomics.load(slot.control, OPFS_PROXY_CONTROL_STATUS_INDEX);
  Atomics.store(slot.control, OPFS_PROXY_CONTROL_STATE_INDEX, OPFS_PROXY_STATE_IDLE);
  return status;
}

interface MoveScenario {
  name: string;
  destinationExists?: boolean;
  fileHandle: Record<string, unknown>;
  holdSourceOpen?: boolean;
  expectedMoves: number;
  expectedStatus: number;
}

test.each<MoveScenario>([
  {
    expectedMoves: 1,
    expectedStatus: OPFS_PROXY_STATUS_OK,
    fileHandle: { move: vi.fn() },
    name: "moves a closed file",
  },
  {
    destinationExists: true,
    expectedMoves: 0,
    expectedStatus: ERRNO_EXIST,
    fileHandle: { move: vi.fn() },
    name: "refuses an existing destination",
  },
  {
    expectedMoves: 0,
    expectedStatus: ERRNO_NOTSUP,
    fileHandle: {},
    name: "reports a browser without move() as unsupported",
  },
  {
    expectedMoves: 0,
    expectedStatus: ERRNO_BUSY,
    fileHandle: {
      createSyncAccessHandle: vi.fn().mockResolvedValue({ close: vi.fn(), getSize: () => 0 }),
      move: vi.fn(),
    },
    holdSourceOpen: true,
    name: "refuses a source that still has an open handle",
  },
])("proxy move $name", async ({ destinationExists, expectedMoves, expectedStatus, fileHandle, holdSourceOpen }) => {
  const channel = createOpfsProxyChannel(1);
  const directoryHandle = {
    getDirectoryHandle: vi.fn(),
    getFileHandle: vi.fn(async (name: string) => {
      if (name === "staged.bin") return fileHandle;
      if (destinationExists) return {};
      throw notFound();
    }),
  };
  const server = startOpfsProxyServer({
    channel,
    mounts: [{ directoryHandle, mountPath: "/out", writableRoots: ["/out"] }] as never,
  });
  try {
    if (holdSourceOpen) {
      expect(await sendProxyRequest(channel, OPFS_PROXY_OP_OPEN, ["/out/staged.bin"])).toBe(OPFS_PROXY_STATUS_OK);
    }
    expect(await sendProxyRequest(channel, OPFS_PROXY_OP_MOVE, ["/out/staged.bin", "/out/final.bin"])).toBe(
      expectedStatus,
    );
    const move = fileHandle.move as ReturnType<typeof vi.fn> | undefined;
    expect(move?.mock.calls.length ?? 0).toBe(expectedMoves);
    if (expectedMoves > 0) expect(move).toHaveBeenCalledWith(directoryHandle, "final.bin");
  } finally {
    server.stop();
  }
});

test("proxy move creates the destination directory before moving into it", async () => {
  const channel = createOpfsProxyChannel(1);
  const move = vi.fn();
  const subDirectory = { getDirectoryHandle: vi.fn(), getFileHandle: vi.fn().mockRejectedValue(notFound()) };
  const directoryHandle = {
    getDirectoryHandle: vi.fn().mockResolvedValue(subDirectory),
    getFileHandle: vi.fn().mockResolvedValue({ move }),
  };
  const server = startOpfsProxyServer({
    channel,
    mounts: [{ directoryHandle, mountPath: "/out", writableRoots: ["/out"] }] as never,
  });
  try {
    expect(await sendProxyRequest(channel, OPFS_PROXY_OP_MOVE, ["/out/staged.bin", "/out/sub/final.bin"])).toBe(
      OPFS_PROXY_STATUS_OK,
    );
    expect(directoryHandle.getDirectoryHandle).toHaveBeenCalledWith("sub", { create: true });
    expect(move).toHaveBeenCalledWith(subDirectory, "final.bin");
  } finally {
    server.stop();
  }
});

test("proxy move refuses a destination in another mount", async () => {
  const channel = createOpfsProxyChannel(1);
  const move = vi.fn();
  const source = { getDirectoryHandle: vi.fn(), getFileHandle: vi.fn().mockResolvedValue({ move }) };
  const other = { getDirectoryHandle: vi.fn(), getFileHandle: vi.fn().mockRejectedValue(notFound()) };
  const server = startOpfsProxyServer({
    channel,
    mounts: [
      { directoryHandle: source, mountPath: "/out", writableRoots: ["/out"] },
      { directoryHandle: other, mountPath: "/other", writableRoots: ["/other"] },
    ] as never,
  });
  try {
    expect(await sendProxyRequest(channel, OPFS_PROXY_OP_MOVE, ["/out/staged.bin", "/other/final.bin"])).toBe(
      ERRNO_XDEV,
    );
    expect(move).not.toHaveBeenCalled();
  } finally {
    server.stop();
  }
});
