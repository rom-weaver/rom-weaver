import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getManagedOpfsFileHandle: vi.fn(),
  removeManagedOpfsPath: vi.fn(),
}));

vi.mock("../../src/workers/protocol/opfs-path.ts", () => ({
  getManagedOpfsFileHandle: mocks.getManagedOpfsFileHandle,
  removeManagedOpfsPath: mocks.removeManagedOpfsPath,
}));

type StorageRequest = {
  action: string;
  bytes?: Uint8Array;
  filePath?: string;
  position?: number;
  requestId?: string;
  size?: number;
};

type PostedMessage = {
  action: string;
  entries?: Array<{ kind: string; path: string; size?: number }>;
  error?: { message: string };
  filePath?: string;
  requestId?: string;
  size?: number;
  success: boolean;
};

type WorkerScope = {
  onmessage: ((event: { data: StorageRequest }) => void) | null;
  postMessage: (message: PostedMessage) => void;
};

const flush = async () => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
};

let scope: WorkerScope;
let posted: PostedMessage[];

const noModificationAllowedError = () => new DOMException("modification denied", "NoModificationAllowedError");

const createSyncAccessHandle = (options?: {
  truncate?: (size: number) => void;
  write?: (chunk: Uint8Array, at: { at: number }) => number;
}) => {
  let size = 0;
  return {
    close: vi.fn(),
    flush: vi.fn(),
    getSize: vi.fn(() => size),
    truncate: vi.fn(
      options?.truncate ??
        ((next: number) => {
          size = next;
        }),
    ),
    write: vi.fn(options?.write ?? ((chunk: Uint8Array) => chunk.byteLength)),
  };
};

const createWritable = (options?: { withAbort?: boolean; writeError?: unknown }) => ({
  abort: options?.withAbort === false ? undefined : vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  truncate: vi.fn(() => (options?.writeError ? Promise.reject(options.writeError) : Promise.resolve())),
  write: vi.fn(() => (options?.writeError ? Promise.reject(options.writeError) : Promise.resolve())),
});

const loadWorker = async () => {
  vi.resetModules();
  posted = [];
  scope = {
    onmessage: null,
    postMessage: (message: PostedMessage) => {
      posted.push(message);
    },
  };
  vi.stubGlobal("self", scope);
  await import("../../src/workers/storage/browser-opfs-staging.worker.ts");
  const handler = scope.onmessage;
  if (!handler) throw new Error("the worker did not install a message handler");
  return async (request: StorageRequest) => {
    handler({ data: request });
    await flush();
    const response = posted.at(-1);
    if (!response) throw new Error("the worker posted no response");
    return response;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.removeManagedOpfsPath.mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { storage: { getDirectory: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("write", () => {
  it("writes every byte through an unsafe sync access handle", async () => {
    const accessHandle = createSyncAccessHandle();
    const createSync = vi.fn(() => Promise.resolve(accessHandle));
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createSyncAccessHandle: createSync });
    const send = await loadWorker();

    const response = await send({
      action: "write",
      bytes: Uint8Array.from([1, 2, 3]),
      filePath: "/staging/rom.sfc",
      position: 8,
      requestId: "req-1",
    });

    expect(mocks.getManagedOpfsFileHandle).toHaveBeenCalledWith("/staging/rom.sfc", {
      create: true,
      navigatorObject: navigator,
    });
    expect(createSync).toHaveBeenCalledWith({ mode: "readwrite-unsafe" });
    expect(accessHandle.write).toHaveBeenCalledTimes(1);
    expect(accessHandle.write.mock.calls[0]?.[1]).toEqual({ at: 8 });
    expect(accessHandle.flush).toHaveBeenCalledTimes(1);
    expect(accessHandle.close).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      action: "write-complete",
      filePath: "/staging/rom.sfc",
      requestId: "req-1",
      size: 3,
      success: true,
    });
  });

  it("loops until a short sync write lands the whole buffer", async () => {
    const chunks: Array<{ at: number; length: number }> = [];
    const accessHandle = createSyncAccessHandle({
      write: (chunk, at) => {
        chunks.push({ at: at.at, length: chunk.byteLength });
        return Math.min(2, chunk.byteLength);
      },
    });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: () => Promise.resolve(accessHandle),
    });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1, 2, 3, 4, 5]), filePath: "/a.bin" });

    expect(chunks).toEqual([
      { at: 0, length: 5 },
      { at: 2, length: 3 },
      { at: 4, length: 1 },
    ]);
    expect(response).toMatchObject({ action: "write-complete", size: 5, success: true });
  });

  it("fails fast when a sync write makes no progress", async () => {
    const accessHandle = createSyncAccessHandle({ write: () => 0 });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: () => Promise.resolve(accessHandle),
    });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1, 2]), filePath: "/a.bin", position: 4 });

    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("OPFS sync write made no progress at offset 4 (0/2 bytes)");
    expect(accessHandle.close).toHaveBeenCalledTimes(1);
  });

  it("fails a sync write whose count exceeds the bytes requested", async () => {
    const accessHandle = createSyncAccessHandle({ write: () => 3 });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: () => Promise.resolve(accessHandle),
    });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1, 2]), filePath: "/a.bin", position: 4 });

    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("OPFS sync write returned invalid byte count 3 at offset 4 (0/2 bytes)");
    expect(accessHandle.close).toHaveBeenCalledTimes(1);
  });

  it("reports Chromium's out-of-storage write count as no space left", async () => {
    // Chromium returns 2^32 - 8 instead of throwing when a write would exceed the storage quota.
    const accessHandle = createSyncAccessHandle({ write: () => 4294967288 });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: () => Promise.resolve(accessHandle),
    });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1, 2]), filePath: "/a.bin", position: 4 });

    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("OPFS sync write: no space left at offset 4 (0/2 bytes)");
    expect(accessHandle.close).toHaveBeenCalledTimes(1);
  });

  it("retries the sync handle in readwrite mode when the unsafe mode is denied", async () => {
    const accessHandle = createSyncAccessHandle();
    const createSync = vi.fn().mockRejectedValueOnce(noModificationAllowedError()).mockResolvedValueOnce(accessHandle);
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createSyncAccessHandle: createSync });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "/a.bin" });

    expect(createSync.mock.calls).toEqual([[{ mode: "readwrite-unsafe" }], [{ mode: "readwrite" }]]);
    expect(response).toMatchObject({ action: "write-complete", success: true });
  });

  it("falls back to a writable stream when both sync modes are denied", async () => {
    const writable = createWritable();
    const createSync = vi.fn(() => Promise.reject(noModificationAllowedError()));
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: createSync,
      createWritable: vi.fn(() => Promise.resolve(writable)),
    });
    const send = await loadWorker();

    const response = await send({
      action: "write",
      bytes: Uint8Array.from([7, 8]),
      filePath: "/a.bin",
      position: 3,
    });

    expect(writable.write).toHaveBeenCalledWith({
      data: expect.any(Uint8Array),
      position: 3,
      type: "write",
    });
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(writable.abort).not.toHaveBeenCalled();
    expect(response).toMatchObject({ action: "write-complete", size: 2, success: true });
  });

  it("recognises a denial that only says so in its message", async () => {
    const writable = createWritable();
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: vi.fn(() => Promise.reject(new Error("Modifications are not allowed here"))),
      createWritable: vi.fn(() => Promise.resolve(writable)),
    });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "/a.bin" });

    expect(response).toMatchObject({ action: "write-complete", success: true });
  });

  it("uses a writable stream when the handle has no sync access at all", async () => {
    const writable = createWritable();
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createWritable: vi.fn(() => Promise.resolve(writable)) });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "/a.bin" });

    expect(response).toMatchObject({ action: "write-complete", success: true });
  });

  it("copies a SharedArrayBuffer-backed payload into an ArrayBuffer for the writable stream", async () => {
    const writable = createWritable();
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createWritable: vi.fn(() => Promise.resolve(writable)) });
    const shared = new Uint8Array(new SharedArrayBuffer(3));
    shared.set([4, 5, 6]);
    const send = await loadWorker();

    await send({ action: "write", bytes: shared, filePath: "/a.bin" });

    const writeCall = writable.write.mock.calls[0] as [{ data: Uint8Array }];
    const written = writeCall[0].data;
    expect(written.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(written)).toEqual([4, 5, 6]);
  });

  it("aborts the writable stream with the write failure", async () => {
    const failure = new Error("quota exceeded");
    const writable = createWritable({ writeError: failure });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createWritable: vi.fn(() => Promise.resolve(writable)) });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "/a.bin" });

    expect(writable.abort).toHaveBeenCalledWith(failure);
    expect(writable.close).not.toHaveBeenCalled();
    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("quota exceeded");
  });

  it("closes a writable stream that cannot abort", async () => {
    const writable = createWritable({ withAbort: false, writeError: new Error("disk full") });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createWritable: vi.fn(() => Promise.resolve(writable)) });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "/a.bin" });

    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(response.action).toBe("stage-error");
  });

  it("rethrows a sync-handle failure that is not a modification denial", async () => {
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: vi.fn(() => Promise.reject(new Error("handle exploded"))),
    });
    const send = await loadWorker();

    const response = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "/a.bin" });

    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("handle exploded");
  });

  it("rejects a request with no path, no bytes, or no reachable handle", async () => {
    mocks.getManagedOpfsFileHandle.mockResolvedValue(null);
    const send = await loadWorker();

    const missingPath = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "   " });
    expect(missingPath.error?.message).toContain("Browser OPFS write requires a file path");
    const missingBytes = await send({ action: "write", filePath: "/a.bin" });
    expect(missingBytes.error?.message).toContain("Browser OPFS write requires Uint8Array bytes");
    const missingHandle = await send({ action: "write", bytes: Uint8Array.from([1]), filePath: "/a.bin" });
    expect(missingHandle.error?.message).toContain("OPFS file handles are not available in this browser worker");
  });
});

describe("truncate", () => {
  it("truncates through a sync access handle", async () => {
    const accessHandle = createSyncAccessHandle();
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: () => Promise.resolve(accessHandle),
    });
    const send = await loadWorker();

    const response = await send({ action: "truncate", filePath: "/a.bin", requestId: "req-2", size: 12.7 });

    expect(accessHandle.truncate).toHaveBeenCalledWith(12);
    expect(accessHandle.flush).toHaveBeenCalledTimes(1);
    expect(accessHandle.close).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({
      action: "truncate-complete",
      filePath: "/a.bin",
      requestId: "req-2",
      size: 12,
      success: true,
    });
  });

  it("fails a sync truncate that leaves the file at another size", async () => {
    // Chromium silently skips a truncate that would exceed the storage quota.
    const accessHandle = createSyncAccessHandle({ truncate: () => undefined });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: () => Promise.resolve(accessHandle),
    });
    const send = await loadWorker();

    const response = await send({ action: "truncate", filePath: "/a.bin", size: 2 ** 30 });

    expect(response).toMatchObject({ success: false });
    expect(response.error?.message).toContain(
      "OPFS truncate of /a.bin to 1073741824 bytes left 0 bytes: no space left",
    );
    expect(accessHandle.close).toHaveBeenCalledTimes(1);
  });

  it("truncates through a writable stream when no sync handle is available", async () => {
    const writable = createWritable();
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createWritable: vi.fn(() => Promise.resolve(writable)) });
    const send = await loadWorker();

    const response = await send({ action: "truncate", filePath: "/a.bin" });

    expect(writable.truncate).toHaveBeenCalledWith(0);
    expect(writable.close).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ action: "truncate-complete", size: 0, success: true });
  });

  it("aborts the writable stream when the truncate fails", async () => {
    const failure = new Error("truncate refused");
    const writable = createWritable({ writeError: failure });
    mocks.getManagedOpfsFileHandle.mockResolvedValue({ createWritable: vi.fn(() => Promise.resolve(writable)) });
    const send = await loadWorker();

    const response = await send({ action: "truncate", filePath: "/a.bin", size: 4 });

    expect(writable.abort).toHaveBeenCalledWith(failure);
    expect(response).toMatchObject({ action: "stage-error", success: false });
  });

  it("falls back to a writable stream when both sync modes deny the truncate", async () => {
    const writable = createWritable();
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: vi.fn(() => Promise.reject(noModificationAllowedError())),
      createWritable: vi.fn(() => Promise.resolve(writable)),
    });
    const send = await loadWorker();

    const response = await send({ action: "truncate", filePath: "/a.bin", size: 6 });

    expect(writable.truncate).toHaveBeenCalledWith(6);
    expect(response).toMatchObject({ action: "truncate-complete", size: 6, success: true });
  });

  it("reports a sync-handle failure that is not a modification denial", async () => {
    mocks.getManagedOpfsFileHandle.mockResolvedValue({
      createSyncAccessHandle: vi.fn(() => Promise.reject(new Error("sync handle exploded"))),
    });
    const send = await loadWorker();

    const response = await send({ action: "truncate", filePath: "/a.bin" });

    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("sync handle exploded");
  });

  it("rejects a truncate with no path or no reachable handle", async () => {
    mocks.getManagedOpfsFileHandle.mockResolvedValue(null);
    const send = await loadWorker();

    const missingPath = await send({ action: "truncate" });
    expect(missingPath.error?.message).toContain("Browser OPFS truncate requires a file path");
    const missingHandle = await send({ action: "truncate", filePath: "/a.bin" });
    expect(missingHandle.error?.message).toContain("OPFS file handles are not available in this browser worker");
  });
});

describe("remove", () => {
  it("removes a path", async () => {
    const send = await loadWorker();

    const response = await send({ action: "remove", filePath: "/staging/rom.sfc", requestId: "req-3" });

    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledWith("/staging/rom.sfc", navigator, { ignoreErrors: false });
    expect(response).toEqual({
      action: "remove-complete",
      filePath: "/staging/rom.sfc",
      requestId: "req-3",
      success: true,
      timestamp: expect.any(Number),
    });
  });

  it("retries a busy path on the backoff schedule", async () => {
    vi.useFakeTimers();
    mocks.removeManagedOpfsPath
      .mockRejectedValueOnce(noModificationAllowedError())
      .mockRejectedValueOnce(noModificationAllowedError())
      .mockResolvedValueOnce(undefined);
    await loadWorker();

    scope.onmessage?.({ data: { action: "remove", filePath: "/a.bin" } });
    await vi.advanceTimersByTimeAsync(25);
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    await flush();

    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(3);
    expect(posted.at(-1)).toMatchObject({ action: "remove-complete", success: true });
  });

  it("gives up once the backoff schedule runs out", async () => {
    vi.useFakeTimers();
    mocks.removeManagedOpfsPath.mockRejectedValue(noModificationAllowedError());
    const send = await loadWorker();

    scope.onmessage?.({ data: { action: "remove", filePath: "/a.bin" } });
    await vi.advanceTimersByTimeAsync(25 + 50 + 100 + 200 + 400 + 800);
    await flush();

    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(7);
    expect(posted.at(-1)).toMatchObject({ action: "stage-error", success: false });
    expect(send).toBeTypeOf("function");
  });

  it("does not retry a failure that is not a busy handle", async () => {
    mocks.removeManagedOpfsPath.mockRejectedValue(new Error("path is gone"));
    const send = await loadWorker();

    const response = await send({ action: "remove", filePath: "/a.bin" });

    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(1);
    expect(response.error?.message).toContain("path is gone");
  });

  it("rejects a remove with no path", async () => {
    const send = await loadWorker();

    const response = await send({ action: "remove", filePath: "" });
    expect(response.error?.message).toContain("Browser OPFS remove requires a path");
  });
});

describe("list", () => {
  const createDirectory = (entries: Array<[string, { getFile?: () => Promise<{ size: number }>; kind: string }]>) => ({
    entries: () => entries[Symbol.iterator](),
    kind: "directory",
  });

  it("walks the tree depth-first and sorts by path", async () => {
    const nested = createDirectory([["b.bin", { getFile: () => Promise.resolve({ size: 2 }), kind: "file" }]]);
    const root = createDirectory([
      ["z.bin", { getFile: () => Promise.resolve({ size: 9 }), kind: "file" }],
      ["nested", { ...nested, kind: "directory" }],
    ]);
    vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } });
    const send = await loadWorker();

    const response = await send({ action: "list", requestId: "req-4" });

    expect(response).toMatchObject({ action: "list-complete", requestId: "req-4", success: true });
    expect(response.entries).toEqual([
      { kind: "directory", path: "/nested" },
      { kind: "file", path: "/nested/b.bin", size: 2 },
      { kind: "file", path: "/z.bin", size: 9 },
    ]);
  });

  it("omits file sizes for a metadata-only listing", async () => {
    const getFile = vi.fn(() => Promise.resolve({ size: 5 }));
    const root = createDirectory([["a.bin", { getFile, kind: "file" }]]);
    vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } });
    const send = await loadWorker();

    const response = await send({ action: "list-metadata" });

    expect(getFile).not.toHaveBeenCalled();
    expect(response.entries).toEqual([{ kind: "file", path: "/a.bin" }]);
  });

  it("reports a listing failure", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.reject(new Error("no OPFS root")) } });
    const send = await loadWorker();

    const response = await send({ action: "list" });
    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("no OPFS root");
  });

  it("continues listing after a file vanishes during a size read", async () => {
    const root = createDirectory([
      ["gone.bin", { kind: "file", getFile: () => Promise.reject(new DOMException("file vanished", "NotFoundError")) }],
      ["keep.bin", { kind: "file", getFile: () => Promise.resolve({ size: 7 }) }],
    ]);
    vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } });
    const send = await loadWorker();

    const response = await send({ action: "list" });

    expect(response).toMatchObject({ action: "list-complete", success: true });
    expect(response.entries).toEqual([{ kind: "file", path: "/keep.bin", size: 7 }]);
  });

  it("still reports iterator errors other than NotFoundError", async () => {
    const root = {
      entries: () => {
        throw new DOMException("access denied", "NotAllowedError");
      },
    };
    vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } });
    const send = await loadWorker();

    expect(await send({ action: "list-metadata" })).toMatchObject({
      action: "stage-error",
      success: false,
      error: { message: expect.stringContaining("NotAllowedError: access denied") },
    });
  });

  it.each(["list", "list-metadata"])("continues %s when a directory vanishes mid-walk", async (action) => {
    const vanished = {
      kind: "directory",
      entries: vi.fn(() => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next: () => Promise.reject(new DOMException("entry vanished", "NotFoundError")),
      })),
    };
    const root = createDirectory([
      ["rw-other-1", vanished],
      ["keep.bin", { kind: "file", getFile: () => Promise.resolve({ size: 7 }) }],
    ]);
    vi.stubGlobal("navigator", { storage: { getDirectory: () => Promise.resolve(root) } });
    const send = await loadWorker();

    const response = await send({ action });

    expect(vanished.entries).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ action: "list-complete", success: true });
    expect(response.entries).toContainEqual({
      kind: "file",
      path: "/keep.bin",
      ...(action === "list" ? { size: 7 } : {}),
    });
  });
});

describe("dispatch", () => {
  it("rejects an action it does not know", async () => {
    const send = await loadWorker();

    const response = await send({ action: "explode" });
    expect(response).toMatchObject({ action: "stage-error", success: false });
    expect(response.error?.message).toContain("unsupported OPFS storage action: explode");
  });

  it("treats a message with no data as an unsupported action", async () => {
    await loadWorker();

    scope.onmessage?.({ data: null as unknown as StorageRequest });
    await flush();

    expect(posted.at(-1)).toMatchObject({ action: "stage-error", success: false });
    expect(posted.at(-1)?.error?.message).toContain("unsupported OPFS storage action: undefined");
  });
});
