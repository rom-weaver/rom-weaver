import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removeManagedOpfsPath: vi.fn(async () => undefined),
  waitForRomWeaverShutdown: vi.fn(async () => undefined),
}));

vi.mock("../../src/workers/protocol/opfs-path.ts", () => ({
  removeManagedOpfsPath: mocks.removeManagedOpfsPath,
}));
vi.mock("../../src/workers/rom-weaver/runner-control.ts", () => ({
  waitForRomWeaverShutdown: mocks.waitForRomWeaverShutdown,
}));

import {
  createRomWeaverOutputScope,
  getTrimOutputFileName,
  runWithRomWeaverOutputScope,
} from "../../src/lib/runtime/run-output-paths.ts";

const scopeRemoveOptions = { ignoreErrors: false };

describe("run output path ownership", () => {
  it("keeps cleanup pending until cancelled writers acknowledge closure", async () => {
    mocks.removeManagedOpfsPath.mockClear();
    let close!: () => void;
    mocks.waitForRomWeaverShutdown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    const scope = createRomWeaverOutputScope();
    const cleanup = scope.cleanup();
    await Promise.resolve();
    expect(mocks.removeManagedOpfsPath).not.toHaveBeenCalled();
    close();
    await cleanup;
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledWith(scope.rootPath, undefined, scopeRemoveOptions);
  });

  it("retains cleanup ownership after strict deletion fails", async () => {
    mocks.removeManagedOpfsPath.mockClear();
    mocks.removeManagedOpfsPath.mockRejectedValueOnce(new DOMException("still locked", "NoModificationAllowedError"));
    const scope = createRomWeaverOutputScope();
    await expect(scope.cleanup()).rejects.toThrow("still locked");
    await scope.cleanup();
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(2);
  });

  it("retries a failed final output cleanup without losing its scope ownership", async () => {
    mocks.removeManagedOpfsPath.mockClear();
    const scope = createRomWeaverOutputScope();
    const removeOutputPath = vi.fn(async () => undefined);
    const [release] = await scope.createOutputCleanups([`${scope.rootPath}/rom.bin`], removeOutputPath);
    if (!release) throw new Error("output scope did not create a cleanup");
    removeOutputPath.mockRejectedValueOnce(new Error("output locked"));
    await expect(release()).rejects.toThrow("output locked");
    expect(mocks.removeManagedOpfsPath).not.toHaveBeenCalled();
    mocks.removeManagedOpfsPath.mockRejectedValueOnce(new Error("scope locked"));
    await expect(release()).rejects.toThrow("scope locked");
    await release();
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(2);
    expect(removeOutputPath).toHaveBeenCalledTimes(2);
  });

  it("selects an operation-scoped path and rejects active input conflicts", () => {
    const scope = createRomWeaverOutputScope();
    const selected = scope.selectOutputPath("/work/source.bin", "nested/result.bin", [undefined, "/work/patch.ips"]);
    expect(selected).toBe(`${scope.rootPath}/result.bin`);

    expect(() => scope.selectOutputPath(`${scope.rootPath}\\result.bin`, "result.bin")).toThrow(
      `Browser output path conflicts with an active input or patch: ${scope.rootPath}/result.bin`,
    );
  });

  it("releases repeated output references only after their last cleanup", async () => {
    mocks.removeManagedOpfsPath.mockClear();
    const scope = createRomWeaverOutputScope();
    const removeOutputPath = vi.fn(async () => undefined);
    const cleanups = await scope.createOutputCleanups(["/work/a", "/work/a", "/work/b"], removeOutputPath);

    await cleanups[0]?.();
    await cleanups[0]?.();
    expect(removeOutputPath).not.toHaveBeenCalled();
    await cleanups[1]?.();
    expect(removeOutputPath).toHaveBeenCalledTimes(1);
    expect(removeOutputPath).toHaveBeenCalledWith("/work/a");
    await cleanups[2]?.();
    expect(removeOutputPath).toHaveBeenCalledWith("/work/b");
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(1);
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledWith(scope.rootPath, undefined, scopeRemoveOptions);
  });

  it("cleans an empty scope immediately and composes nested result cleanup", async () => {
    mocks.removeManagedOpfsPath.mockClear();
    const emptyScope = createRomWeaverOutputScope();
    expect(
      await emptyScope.createOutputCleanups(
        [],
        vi.fn(async () => undefined),
      ),
    ).toEqual([]);
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledWith(emptyScope.rootPath, undefined, scopeRemoveOptions);

    mocks.removeManagedOpfsPath.mockClear();
    const resultCleanup = vi.fn(async () => undefined);
    const result = await runWithRomWeaverOutputScope("/work/input.bin", "patched.bin", [], async (path) => ({
      outputPath: path,
      cleanup: resultCleanup,
    }));
    expect(result.outputPath).toMatch(`${result.outputPath.split("/").slice(0, -1).join("/")}/patched.bin`);
    await result.cleanup();
    await result.cleanup();
    expect(resultCleanup).toHaveBeenCalledTimes(1);
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(1);
  });

  it("cleans the scope when the operation fails", async () => {
    mocks.removeManagedOpfsPath.mockClear();
    await expect(
      runWithRomWeaverOutputScope("/work/input.bin", "patched.bin", [], async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledTimes(1);
  });

  it("marks source names only when the requested name matches the source", () => {
    expect(getTrimOutputFileName("/work/game.bin", undefined)).toBe("game (trimmed).bin");
    expect(getTrimOutputFileName("/work/game.bin", "game.bin")).toBe("game (trimmed).bin");
    expect(getTrimOutputFileName("/work/game.bin", "game (trimmed).bin")).toBe("game (trimmed).bin");
    expect(getTrimOutputFileName("/work/game.bin?download=1", "new-name.bin")).toBe("new-name.bin");
    expect(getTrimOutputFileName("", "")).toBe("trimmed (trimmed).bin");
  });
});
