import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestBrowserOpfsStorage } = vi.hoisted(() => ({
  requestBrowserOpfsStorage: vi.fn(async () => ({ success: true })),
}));

vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({ requestBrowserOpfsStorage }));

import {
  resetBrowserTransientOpfs,
  startBrowserOpfsBootCleanup,
} from "../../src/storage/browser/browser-opfs-cleanup.ts";

describe("browser OPFS cleanup", () => {
  beforeEach(() => requestBrowserOpfsStorage.mockClear());

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
});
