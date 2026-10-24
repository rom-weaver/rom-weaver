import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PrefixReply = { type: string; requestId: string; bytes?: Uint8Array; message?: string };
let dispatch: (request: Record<string, unknown>) => Promise<PrefixReply>;
let posted: ReturnType<typeof vi.fn>;
let getDirectory: ReturnType<typeof vi.fn>;
let getDirectoryHandle: ReturnType<typeof vi.fn>;
let getFileHandle: ReturnType<typeof vi.fn>;
let slice: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  const bytes = new Uint8Array(100 * 2352);
  bytes.set([67, 68, 48, 48, 49], 16 * 2352 + 17);
  const file = new Blob([bytes]);
  slice = vi.spyOn(file, "slice");
  getFileHandle = vi.fn().mockResolvedValue({ getFile: vi.fn().mockResolvedValue(file) });
  const directory = { getDirectoryHandle: vi.fn(), getFileHandle };
  getDirectoryHandle = directory.getDirectoryHandle.mockResolvedValue(directory);
  getDirectory = vi.fn().mockResolvedValue(directory);
  vi.stubGlobal("navigator", { storage: { getDirectory } });
  let complete: (reply: PrefixReply) => void;
  posted = vi.fn((reply: PrefixReply) => complete(reply));
  const scope = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: posted };
  vi.stubGlobal("self", scope);
  await import("../../src/wasm/workers/browser-opfs-proxy-worker.ts");
  dispatch = (request) =>
    new Promise((resolve) => {
      complete = resolve;
      scope.onmessage?.({ data: { type: "read-prefix", requestId: "prefix-1", ...request } });
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OPFS proxy worker prefix control", () => {
  it("reads the exact bounded prefix before bootstrap without creating paths", async () => {
    const reply = await dispatch({ filePath: "/work/output/patched.bin", length: 37654 });
    expect(reply.type).toBe("read-prefix-complete");
    if (!reply.bytes) throw new Error("prefix reply did not include bytes");
    expect(reply.bytes.length).toBe(37654);
    expect(Array.from(reply.bytes.subarray(16 * 2352 + 17))).toEqual([67, 68, 48, 48, 49]);
    expect(getDirectoryHandle).toHaveBeenCalledExactlyOnceWith("output", { create: false });
    expect(getFileHandle).toHaveBeenCalledExactlyOnceWith("patched.bin", { create: false });
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 37654);
    expect(posted).toHaveBeenCalledWith(reply, [reply.bytes.buffer]);
  });

  it.each([-1, 65537, NaN, 1.5])("rejects invalid prefix length %s before opening OPFS", async (length) => {
    const reply = await dispatch({ filePath: "/work/output/patched.bin", length });
    expect(reply).toMatchObject({ type: "read-prefix-error", requestId: "prefix-1" });
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it("returns a correlated read failure without creating the missing file", async () => {
    getFileHandle.mockRejectedValue(new Error("disk unavailable"));
    const reply = await dispatch({ filePath: "/work/output/missing.bin", length: 12 });
    expect(reply).toMatchObject({ type: "read-prefix-error", requestId: "prefix-1", message: "disk unavailable" });
    expect(getFileHandle).toHaveBeenCalledExactlyOnceWith("missing.bin", { create: false });
    expect(slice).not.toHaveBeenCalled();
  });
});
