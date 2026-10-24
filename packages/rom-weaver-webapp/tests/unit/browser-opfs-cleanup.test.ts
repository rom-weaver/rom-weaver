import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestBrowserOpfsStorage } = vi.hoisted(() => ({
  requestBrowserOpfsStorage: vi.fn(
    async (_request?: { filePath?: string }): Promise<{ error?: { message: string }; success: boolean }> => ({
      success: true,
    }),
  ),
}));

vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({ requestBrowserOpfsStorage }));

import {
  resetBrowserTransientOpfs,
  startBrowserOpfsBootCleanup,
} from "../../src/storage/browser/browser-opfs-cleanup.ts";

describe("browser OPFS cleanup", () => {
  beforeEach(() => {
    requestBrowserOpfsStorage.mockReset();
    requestBrowserOpfsStorage.mockResolvedValue({ success: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("preserves live-tab outputs and reclaims abandoned storage after the last tab closes", async () => {
    let liveTabs = 0;
    const locks = {
      request: vi.fn(
        async (_name: string, options: LockOptions, callback: (lock: { name: string } | null) => unknown) => {
          if (options.ifAvailable) return callback(liveTabs ? null : { name: _name });
          if (options.mode !== "shared") throw new Error("Expected shared tab lease");
          liveTabs += 1;
          return callback({ name: _name });
        },
      ),
    };
    vi.stubGlobal("navigator", { locks });
    vi.resetModules();
    const firstTab = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await firstTab.startBrowserOpfsBootCleanup();
    expect(requestBrowserOpfsStorage).toHaveBeenCalledWith({ action: "remove", filePath: "/work/operations" });
    requestBrowserOpfsStorage.mockClear();
    vi.resetModules();
    const secondTab = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await secondTab.startBrowserOpfsBootCleanup();
    expect(requestBrowserOpfsStorage).not.toHaveBeenCalled();
    expect(liveTabs).toBe(2);
    liveTabs = 0;
    vi.resetModules();
    const laterSession = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await laterSession.startBrowserOpfsBootCleanup();
    expect(requestBrowserOpfsStorage).toHaveBeenCalledWith({ action: "remove", filePath: "/work/operations" });
  });

  it("sweeps stale root libarchive temp files at boot and leaves nested or unrelated files", async () => {
    requestBrowserOpfsStorage.mockImplementation(async (request) =>
      (request as { action?: string })?.action === "list-metadata"
        ? ({
            entries: [
              { kind: "file", path: "/libarchive_AbC123" },
              { kind: "file", path: "/operations/x/libarchive_keep" },
              { kind: "file", path: "/rom.bin" },
              { kind: "directory", path: "/libarchive_dir" },
              { kind: "directory", path: "/rw-tmp-abc" },
              { kind: "file", path: "/rw-tmp-abc/.keep" },
            ],
            success: true,
          } as never)
        : { success: true },
    );
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const fresh = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await fresh.startBrowserOpfsBootCleanup();
    const removed = requestBrowserOpfsStorage.mock.calls
      .map(([request]) => (request as { filePath?: string })?.filePath)
      .filter((path) => path?.includes("libarchive_") || path?.includes("rw-tmp-"));
    expect(removed).toEqual(["/work/libarchive_AbC123", "/work/rw-tmp-abc"]);
  });

  it("sweeps emulator retention only for the boot cleanup", async () => {
    await startBrowserOpfsBootCleanup();
    expect(requestBrowserOpfsStorage).toHaveBeenCalledWith({
      action: "remove",
      filePath: "/work/runtime-output/emulator",
    });

    requestBrowserOpfsStorage.mockClear();
    await resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).not.toHaveBeenCalledWith({
      action: "remove",
      filePath: "/work/runtime-output/emulator",
    });
  });

  it("skips entries locked by a previous page during boot cleanup but still fails a manual reset", async () => {
    const busy = {
      error: { message: "NoModificationAllowedError: Modifications are not allowed" },
      success: false,
    };
    requestBrowserOpfsStorage.mockImplementation(async (request) =>
      request?.filePath === "/work/temp" ? busy : { success: true },
    );
    vi.resetModules();
    const fresh = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await expect(fresh.startBrowserOpfsBootCleanup()).resolves.toBeUndefined();
    await expect(resetBrowserTransientOpfs()).rejects.toThrow(/Modifications are not allowed/);
  });

  it("recognizes a locked entry by error name when the message has no Chromium prefix", async () => {
    requestBrowserOpfsStorage.mockImplementation(async (request) =>
      request?.filePath === "/work/temp"
        ? {
            error: { message: "The object can not be modified in this way.", name: "NoModificationAllowedError" },
            success: false,
          }
        : { success: true },
    );
    await expect(resetBrowserTransientOpfs({ skipBusy: true })).resolves.toBeUndefined();
    await expect(resetBrowserTransientOpfs()).rejects.toThrow("can not be modified");
  });

  it("still rejects boot cleanup for non-lock failures", async () => {
    requestBrowserOpfsStorage.mockImplementation(async () => ({
      error: { message: "quota exceeded" },
      success: false,
    }));
    await expect(resetBrowserTransientOpfs({ skipBusy: true })).rejects.toThrow("quota exceeded");
  });
});
