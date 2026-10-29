import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ request: vi.fn(), stage: vi.fn() }));
vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({
  requestBrowserOpfsStorage: state.request,
}));
vi.mock("../../src/workers/protocol/browser-opfs-source-ref.ts", () => ({
  createBrowserOpfsSourceRef: state.stage,
}));

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.resetModules();
  state.request.mockReset().mockResolvedValue({ entries: [], success: true });
  state.stage.mockReset().mockResolvedValue({
    cleanup: async () => undefined,
    fileName: "rom.bin",
    filePath: "/work/input/rom.bin",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("browser VFS boot readiness", () => {
  it("lazily blocks concurrent staging, write and truncate until cleanup and the shared lease are ready", async () => {
    const sweep = deferred();
    const lease = deferred();
    state.request.mockImplementation(async (request: { action: string }) => {
      if (request.action === "remove") await sweep.promise;
      return { entries: [], success: true };
    });
    const requestLock = vi.fn(async (_name: string, options: LockOptions, callback: (lock: object) => unknown) => {
      if (options.mode === "shared") await lease.promise;
      return callback({});
    });
    vi.stubGlobal("navigator", { locks: { request: requestLock } });
    const { createBrowserRuntimeVfsIo } = await import("../../src/platform/browser/browser-runtime-vfs.ts");
    const { createBrowserLargeFileVfs } = await import("../../src/storage/browser/browser-large-file-vfs.ts");
    const vfs = createBrowserLargeFileVfs();
    const stat = vi.spyOn(vfs, "stat").mockResolvedValue({ path: "/work/input/rom.bin", size: 4 });
    const io = createBrowserRuntimeVfsIo({ vfs });
    const staged = io.stageSource({
      fallbackFileName: "rom.bin",
      scope: "archive",
      source: { path: "/work/input/rom.bin", vfs },
    });
    const virtualStage = io.stageSource({ fallbackFileName: "rom.bin", scope: "archive", source: new Blob(["ROM"]) });
    const write = vfs.write("/work/patches/patch.ips", new Uint8Array([1, 2]));
    const truncate = vfs.truncate("/work/operations/rom.bin", 4);
    await vi.waitFor(() =>
      expect(state.request).toHaveBeenCalledWith({ action: "remove", filePath: "/work/operations" }),
    );
    expect(stat).not.toHaveBeenCalled();
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.request.mock.calls.some(([request]) => ["write", "truncate"].includes(request.action))).toBe(false);
    sweep.resolve();
    await vi.waitFor(() => expect(requestLock).toHaveBeenCalledTimes(2));
    expect(stat).not.toHaveBeenCalled();
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.request.mock.calls.some(([request]) => ["write", "truncate"].includes(request.action))).toBe(false);
    lease.resolve();
    await expect(staged).resolves.toMatchObject({ filePath: "/work/input/rom.bin", size: 4 });
    await expect(virtualStage).resolves.toMatchObject({ filePath: "/work/input/rom.bin" });
    await expect(write).resolves.toBe(2);
    await expect(truncate).resolves.toBeUndefined();
    expect(requestLock).toHaveBeenCalledTimes(2);
  });

  it.each(["cleanup", "lease"])("rejects staging and writes when %s fails", async (failure) => {
    vi.stubGlobal(
      "navigator",
      failure === "lease"
        ? {
            locks: {
              request: async (_name: string, options: LockOptions, callback: (lock: object) => unknown) => {
                if (options.mode === "shared") throw new Error("lease failed");
                return callback({});
              },
            },
          }
        : {},
    );
    if (failure === "cleanup")
      state.request.mockResolvedValue({ error: { message: "cleanup failed" }, success: false });
    const { createBrowserRuntimeVfsIo } = await import("../../src/platform/browser/browser-runtime-vfs.ts");
    const { createBrowserLargeFileVfs } = await import("../../src/storage/browser/browser-large-file-vfs.ts");
    const vfs = createBrowserLargeFileVfs();
    const io = createBrowserRuntimeVfsIo({ vfs });
    await expect(
      io.stageSource({ fallbackFileName: "rom.bin", scope: "archive", source: new Blob(["ROM"]) }),
    ).rejects.toThrow(`${failure} failed`);
    await expect(vfs.write("/work/patches/patch.ips", new Uint8Array([1]))).rejects.toThrow(`${failure} failed`);
    await expect(vfs.truncate("/work/operations/rom.bin", 4)).rejects.toThrow(`${failure} failed`);
    expect(state.stage).not.toHaveBeenCalled();
    expect(state.request.mock.calls.some(([request]) => ["write", "truncate"].includes(request.action))).toBe(false);
  });
});
