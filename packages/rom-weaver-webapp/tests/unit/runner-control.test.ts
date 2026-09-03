import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  noteRomWeaverIoBatch: vi.fn(),
  recycleWarmRomWeaverRunner: vi.fn(),
  warmupRomWeaverRunner: vi.fn(),
}));

vi.mock("../../src/workers/rom-weaver/rom-weaver-runner.ts", () => mocks);

const control = await import("../../src/workers/rom-weaver/runner-control.ts");

beforeEach(() => {
  vi.clearAllMocks();
  control.setInputSelectionHandler(undefined);
  mocks.warmupRomWeaverRunner.mockResolvedValue({ warmed: true });
  mocks.recycleWarmRomWeaverRunner.mockResolvedValue(undefined);
});

describe("rom-weaver runner control", () => {
  it("serializes input selections and cancels when no handler is registered", async () => {
    const handler = vi.fn().mockResolvedValue([1, 3]);
    control.setInputSelectionHandler(handler);
    await expect(
      control.resolveInputSelection(JSON.stringify({ candidates: ["a", "b", "c"], heading: "Pick", mode: "multi" })),
    ).resolves.toEqual([1, 3]);
    expect(handler).toHaveBeenCalledWith(
      JSON.stringify({ candidates: ["a", "b", "c"], heading: "Pick", mode: "multi" }),
    );

    control.setInputSelectionHandler(undefined);
    await expect(control.resolveInputSelection("not json")).resolves.toEqual([]);
  });

  it("continues the selection chain after a rejected UI request", async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error("selection closed")).mockResolvedValueOnce([0]);
    control.setInputSelectionHandler(handler);
    await expect(control.resolveInputSelection("first")).rejects.toThrow("selection closed");
    await expect(control.resolveInputSelection("second")).resolves.toEqual([0]);
    expect(handler).toHaveBeenNthCalledWith(2, "second");
  });

  it("delegates lifecycle, IO accounting, recycling, and warmup operations", async () => {
    const disposeAll = vi.fn().mockResolvedValue(undefined);
    const markAllStale = vi.fn();
    control.registerRunnerLifecycle({ disposeAll, markAllStale });
    await control.resetRomWeaverRunner({ terminate: true });
    control.markRomWeaverRunnerStale();
    expect(disposeAll).toHaveBeenCalledWith({ terminate: true });
    expect(markAllStale).toHaveBeenCalledTimes(1);

    await control.noteRomWeaverIoBatch([10, 20]);
    await control.recycleWarmRomWeaverRunner(4);
    await expect(control.warmupRomWeaverRunner(2)).resolves.toEqual({ warmed: true });
    expect(mocks.noteRomWeaverIoBatch).toHaveBeenCalledWith([10, 20]);
    expect(mocks.recycleWarmRomWeaverRunner).toHaveBeenCalledWith(4);
    expect(mocks.warmupRomWeaverRunner).toHaveBeenCalledWith(2);
  });
});
