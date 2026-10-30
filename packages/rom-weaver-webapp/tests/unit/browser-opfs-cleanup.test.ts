import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestBrowserOpfsStorage } = vi.hoisted(() => ({
  requestBrowserOpfsStorage: vi.fn(
    async (_request?: {
      action?: string;
      filePath?: string;
    }): Promise<{ error?: { message: string }; success: boolean }> => ({
      success: true,
    }),
  ),
}));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../src/lib/logging.ts", () => ({ createLogger: () => ({ debug: vi.fn(), warn }) }));
vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({ requestBrowserOpfsStorage }));

import {
  registerBrowserTransientOpfsPath,
  resetBrowserTransientOpfs,
  startBrowserOpfsBootCleanup,
} from "../../src/storage/browser/browser-opfs-cleanup.ts";

const ownedPathReleases: Array<() => void> = [];
const ownPath = (filePath: string) => ownedPathReleases.push(registerBrowserTransientOpfsPath(filePath));

describe("browser OPFS cleanup", () => {
  beforeEach(() => {
    for (const release of ownedPathReleases.splice(0)) release();
    requestBrowserOpfsStorage.mockReset();
    warn.mockClear();
    requestBrowserOpfsStorage.mockResolvedValue({ success: true });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("still takes the shared lifetime lease when the boot sweep fails", async () => {
    const locks = {
      request: vi.fn(
        async (_name: string, options: LockOptions, callback: (lock: { name: string } | null) => unknown) =>
          callback(options.ifAvailable || options.mode === "shared" ? { name: _name } : null),
      ),
    };
    vi.stubGlobal("navigator", { locks });
    requestBrowserOpfsStorage.mockResolvedValue({ error: { message: "quota exceeded" }, success: false });
    vi.resetModules();
    const tab = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await expect(tab.startBrowserOpfsBootCleanup()).rejects.toThrow("quota exceeded");
    expect(locks.request).toHaveBeenCalledWith("rom-weaver-opfs-pages", { mode: "shared" }, expect.any(Function));
  });

  it("makes the boot-cleanup wait cover an in-flight reset sweep without rejecting on its failure", async () => {
    // The wait now starts the boot sweep, so use a fresh module with a finished boot sweep and no real Web
    // Lock, whose page lifetime lease would otherwise stay held for the rest of the file.
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const fresh = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await fresh.startBrowserOpfsBootCleanup();
    fresh.registerBrowserTransientOpfsPath("/work/operations/reset-pending");
    fresh.registerBrowserTransientOpfsPath("/work/weave-parse/reset-pending");
    // The sweep removes several paths at once and reports only after all have settled.
    const releases: Array<() => void> = [];
    requestBrowserOpfsStorage.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ error: { message: "quota exceeded" }, success: false }));
        }),
    );
    const reset = fresh.resetBrowserTransientOpfs();
    const rejection = expect(reset).rejects.toThrow("quota exceeded");
    let waited = false;
    const waiting = fresh.waitForBrowserOpfsBootCleanup().then(() => {
      waited = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(waited).toBe(false);
    for (const release of releases) release();
    await rejection;
    await waiting;
    expect(waited).toBe(true);
  });

  it("retries failed run scratch cleanup without sweeping another tab or newly registered runs", async () => {
    vi.resetModules();
    const tab = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    tab.registerBrowserOpfsRunScratch("own-run");
    const releaseFinished = tab.registerBrowserOpfsRunScratch("finished-run");
    releaseFinished();
    let releaseNew: () => void = () => undefined;
    requestBrowserOpfsStorage.mockImplementation(async (request) => {
      if (request?.action === "list-metadata") {
        releaseNew = tab.registerBrowserOpfsRunScratch("new-run");
        return {
          success: true,
          entries: ["own-run", "other-run", "finished-run", "new-run"].map((runId) => ({
            kind: "directory",
            path: `/rom-weaver-out/rw-${runId}-1-entropy`,
          })),
        };
      }
      return { success: false, error: { message: "entry is locked" } };
    });
    await expect(tab.resetBrowserTransientOpfs()).rejects.toThrow("entry is locked");
    expect(requestBrowserOpfsStorage.mock.calls.filter(([request]) => request?.action === "remove")).toEqual([
      [{ action: "remove", filePath: "/work/rom-weaver-out/rw-own-run-1-entropy" }],
    ]);
    releaseNew();
    requestBrowserOpfsStorage.mockClear();
    requestBrowserOpfsStorage.mockImplementation(async (request) =>
      request?.action === "list-metadata"
        ? { success: true, entries: [{ kind: "directory", path: "/rom-weaver-out/rw-own-run-1-entropy" }] }
        : { success: true },
    );
    await tab.resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).toHaveBeenCalledWith({
      action: "remove",
      filePath: "/work/rom-weaver-out/rw-own-run-1-entropy",
    });
    requestBrowserOpfsStorage.mockClear();
    await tab.resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).not.toHaveBeenCalled();
  });

  it("reports a failed sweep only after every sibling removal has settled", async () => {
    ownPath("/work/operations/failed");
    ownPath("/work/weave-parse/slow");
    let finishSlow: () => void = () => undefined;
    requestBrowserOpfsStorage.mockImplementation((request) =>
      request?.filePath === "/work/operations/failed"
        ? Promise.resolve({ error: { message: "quota exceeded" }, success: false })
        : request?.filePath === "/work/weave-parse/slow"
          ? new Promise((resolve) => {
              finishSlow = () => resolve({ success: true });
            })
          : Promise.resolve({ success: true }),
    );
    let settled = false;
    const reset = resetBrowserTransientOpfs().then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    finishSlow();
    await reset;
    expect(settled).toBe(true);
  });

  describe("boot readiness wait with Web Locks present", () => {
    const grantingLocks = (failLease = false) => ({
      request: vi.fn(
        async (_name: string, options: LockOptions, callback: (lock: { name: string } | null) => unknown) => {
          if (options.mode === "shared" && failLease) throw new Error("lease failed");
          return callback({ name: _name });
        },
      ),
    });

    it("resolves and logs the failure once when the sweep fails but the lease is taken", async () => {
      vi.stubGlobal("navigator", { locks: grantingLocks() });
      requestBrowserOpfsStorage.mockResolvedValue({ error: { message: "quota exceeded" }, success: false });
      vi.resetModules();
      const fresh = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
      await expect(fresh.waitForBrowserOpfsBootCleanup()).resolves.toBeUndefined();
      await expect(fresh.waitForBrowserOpfsBootCleanup()).resolves.toBeUndefined();
      await expect(fresh.waitForBrowserOpfsBootCleanup()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("still rejects with the lease error when the lease cannot be taken", async () => {
      vi.stubGlobal("navigator", { locks: grantingLocks(true) });
      requestBrowserOpfsStorage.mockResolvedValue({ error: { message: "quota exceeded" }, success: false });
      vi.resetModules();
      const fresh = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
      await expect(fresh.waitForBrowserOpfsBootCleanup()).rejects.toThrow("lease failed");
      expect(warn).not.toHaveBeenCalled();
    });
  });

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
      request?.filePath?.startsWith("/work/temp") ? busy : { success: true },
    );
    vi.stubGlobal("navigator", {});
    vi.resetModules();
    const fresh = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    await expect(fresh.startBrowserOpfsBootCleanup()).resolves.toBeUndefined();
    ownPath("/work/temp/owned");
    await expect(resetBrowserTransientOpfs()).rejects.toThrow(/Modifications are not allowed/);
  });

  it("recognizes a locked entry by error name when the message has no Chromium prefix", async () => {
    ownPath("/work/temp/owned");
    requestBrowserOpfsStorage.mockImplementation(async (request) =>
      request?.filePath === "/work/temp/owned"
        ? {
            error: { message: "The object can not be modified in this way.", name: "NoModificationAllowedError" },
            success: false,
          }
        : { success: true },
    );
    await expect(resetBrowserTransientOpfs({ skipBusy: true })).resolves.toBeUndefined();
    await expect(resetBrowserTransientOpfs()).rejects.toThrow("can not be modified");
  });

  it("still rejects reset cleanup for non-lock failures", async () => {
    ownPath("/work/operations/owned");
    requestBrowserOpfsStorage.mockImplementation(async () => ({
      error: { message: "quota exceeded" },
      success: false,
    }));
    await expect(resetBrowserTransientOpfs({ skipBusy: true })).rejects.toThrow("quota exceeded");
  });

  it("does not sweep shared roots when this page has no scratch", async () => {
    await resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).not.toHaveBeenCalled();
  });

  it("resets only directories registered in this page's module instance", async () => {
    vi.resetModules();
    const firstTab = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    firstTab.registerBrowserTransientOpfsPath("/work/operations/first-tab");
    vi.resetModules();
    const secondTab = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    secondTab.registerBrowserTransientOpfsPath("/work/weave-parse/second-tab");
    await firstTab.resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).toHaveBeenCalledExactlyOnceWith({
      action: "remove",
      filePath: "/work/operations/first-tab",
    });
    requestBrowserOpfsStorage.mockClear();
    await secondTab.resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).toHaveBeenCalledExactlyOnceWith({
      action: "remove",
      filePath: "/work/weave-parse/second-tab",
    });
  });

  it("forgets disposed paths and successful resets, but retries failed removals", async () => {
    const release = registerBrowserTransientOpfsPath("/work/operations/disposed");
    release();
    ownPath("/work/operations/retry");
    requestBrowserOpfsStorage.mockResolvedValueOnce({ error: { message: "quota exceeded" }, success: false });
    await expect(resetBrowserTransientOpfs()).rejects.toThrow("quota exceeded");
    await resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage.mock.calls).toEqual([
      [{ action: "remove", filePath: "/work/operations/retry" }],
      [{ action: "remove", filePath: "/work/operations/retry" }],
    ]);
    requestBrowserOpfsStorage.mockClear();
    await resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).not.toHaveBeenCalled();
  });

  it("captures only paths owned when reset starts, preserving new work", async () => {
    ownPath("/work/operations/old");
    let finish!: () => void;
    requestBrowserOpfsStorage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ success: true });
        }),
    );
    const reset = resetBrowserTransientOpfs();
    ownPath("/work/operations/new");
    finish();
    await reset;
    expect(requestBrowserOpfsStorage).toHaveBeenCalledExactlyOnceWith({
      action: "remove",
      filePath: "/work/operations/old",
    });
    requestBrowserOpfsStorage.mockClear();
    await resetBrowserTransientOpfs();
    expect(requestBrowserOpfsStorage).toHaveBeenCalledExactlyOnceWith({
      action: "remove",
      filePath: "/work/operations/new",
    });
  });
});
