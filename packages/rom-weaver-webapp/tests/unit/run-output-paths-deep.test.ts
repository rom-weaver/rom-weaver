import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removeManagedOpfsPath: vi.fn(async () => undefined),
}));

vi.mock("../../src/workers/protocol/opfs-path.ts", () => ({
  removeManagedOpfsPath: mocks.removeManagedOpfsPath,
}));

import {
  createRomWeaverOutputScope,
  getTrimOutputFileName,
  runWithRomWeaverOutputScope,
} from "../../src/lib/runtime/run-output-paths.ts";

describe("run output path ownership", () => {
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
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledWith(scope.rootPath);
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
    expect(mocks.removeManagedOpfsPath).toHaveBeenCalledWith(emptyScope.rootPath);

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
