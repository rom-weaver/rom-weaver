import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  releaseSweep: undefined as undefined | (() => void),
  requestBrowserOpfsStorage: vi.fn(),
  runRomWeaverJson: vi.fn(),
}));

vi.mock("../../src/workers/rom-weaver/rom-weaver-runner.ts", () => ({ runRomWeaverJson: mocks.runRomWeaverJson }));
vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({
  requestBrowserOpfsStorage: mocks.requestBrowserOpfsStorage,
}));

import { startBrowserOpfsBootCleanup } from "../../src/storage/browser/browser-opfs-cleanup.ts";
import { invokeRomWeaverWeaveParseWorker } from "../../src/lib/runtime/wasm-command-runtime.ts";

describe("wasm commands vs the page-boot OPFS sweep", () => {
  it("does not start a command until the boot sweep has finished deleting /work scratch", async () => {
    const sweepGate = new Promise<void>((resolve) => {
      mocks.releaseSweep = resolve;
    });
    mocks.requestBrowserOpfsStorage.mockImplementation(async () => {
      await sweepGate;
      return { entries: [], success: true };
    });
    mocks.runRomWeaverJson.mockResolvedValue({
      events: [{ details: { patch_sources: [] }, status: "succeeded" }],
      exitCode: 0,
      ok: true,
      stderr: "",
    });
    const sweep = startBrowserOpfsBootCleanup();
    const parse = invokeRomWeaverWeaveParseWorker({
      extractDirPath: "/work/weave-parse/id",
      sourcePath: "/work/weave-input/first-weave.zip",
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runRomWeaverJson).not.toHaveBeenCalled();
    mocks.releaseSweep?.();
    await sweep;
    await parse;
    expect(mocks.runRomWeaverJson).toHaveBeenCalledTimes(1);
  });

  it("still runs a command when the boot sweep fails", async () => {
    // A fresh module graph and no Web Locks, so the sweep runs once more and its failure is not masked by the
    // first test's lifetime lease.
    vi.resetModules();
    vi.stubGlobal("navigator", { locks: undefined });
    mocks.runRomWeaverJson.mockClear();
    mocks.requestBrowserOpfsStorage.mockResolvedValue({ error: { message: "quota exceeded" }, success: false });
    mocks.runRomWeaverJson.mockResolvedValue({
      events: [{ details: { patch_sources: [] }, status: "succeeded" }],
      exitCode: 0,
      ok: true,
      stderr: "",
    });
    const cleanup = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    const runtime = await import("../../src/lib/runtime/wasm-command-runtime.ts");
    await expect(cleanup.startBrowserOpfsBootCleanup()).rejects.toThrow("quota exceeded");
    await runtime
      .invokeRomWeaverWeaveParseWorker({
        extractDirPath: "/work/weave-parse/id",
        sourcePath: "/work/weave-input/first-weave.zip",
      })
      .catch(() => undefined);
    expect(mocks.runRomWeaverJson).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does not start a command until an in-flight reset sweep has finished", async () => {
    vi.resetModules();
    let release: () => void = () => undefined;
    const resetGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.requestBrowserOpfsStorage.mockImplementation(async () => {
      await resetGate;
      return { entries: [], success: true };
    });
    mocks.runRomWeaverJson.mockReset();
    mocks.runRomWeaverJson.mockResolvedValue({
      events: [{ details: { patch_sources: [] }, status: "succeeded" }],
      exitCode: 0,
      ok: true,
      stderr: "",
    });
    const cleanup = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    const runtime = await import("../../src/lib/runtime/wasm-command-runtime.ts");
    const reset = cleanup.resetBrowserTransientOpfs();
    const parse = runtime
      .invokeRomWeaverWeaveParseWorker({
        extractDirPath: "/work/weave-parse/id",
        sourcePath: "/work/weave-input/first-weave.zip",
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runRomWeaverJson).not.toHaveBeenCalled();
    release();
    await reset;
    await parse;
    expect(mocks.runRomWeaverJson).toHaveBeenCalledTimes(1);
  });
});
