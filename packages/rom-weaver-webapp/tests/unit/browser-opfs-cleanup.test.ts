import { beforeEach, describe, expect, it, vi } from "vitest";

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
