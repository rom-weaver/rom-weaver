import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  done: vi.fn(),
  end: vi.fn(),
  ingest: vi.fn(async () => ({
    outputs: [{ cleanup: vi.fn(async () => undefined) }],
    patchOutputs: [{ cleanup: vi.fn(async () => undefined) }],
  })),
  logger: vi.fn(),
  recycle: vi.fn(async () => undefined),
  start: vi.fn(),
}));

vi.mock("../../src/lib/logging.ts", () => ({
  createLogger: () => ({ trace: state.logger }),
}));
vi.mock("../../src/lib/perf/op-perf-marks.ts", () => ({
  markWarmupDone: state.done,
  markWarmupEnd: state.end,
  markWarmupStart: state.start,
}));
vi.mock("../../src/workers/rom-weaver/runner-control.ts", () => ({ recycleWarmRomWeaverRunner: state.recycle }));
vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({
  browserRuntime: { ingest: { run: state.ingest } },
}));

const { scheduleBrowserRuntimeWarmupExtraction } = await import("../../src/platform/browser/browser-runtime-warmup.ts");

beforeEach(() => {
  vi.clearAllMocks();
  state.ingest.mockResolvedValue({
    outputs: [{ cleanup: vi.fn(async () => undefined) }],
    patchOutputs: [{ cleanup: vi.fn(async () => undefined) }],
  });
  state.recycle.mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(globalThis, "requestIdleCallback", { configurable: true, value: undefined });
  vi.useRealTimers();
});

describe("browser runtime warmup", () => {
  it("schedules one idle extraction, cleans its outputs, and recycles the warm runner", async () => {
    let idle: (() => void) | undefined;
    Object.defineProperty(globalThis, "requestIdleCallback", {
      configurable: true,
      value: (callback: () => void) => {
        idle = callback;
        return 1;
      },
    });
    scheduleBrowserRuntimeWarmupExtraction();
    expect(idle).toBeTypeOf("function");
    idle?.();
    await vi.waitFor(() => expect(state.ingest).toHaveBeenCalledTimes(1));
    expect(state.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        checksumAlgorithms: ["crc32", "md5", "sha1"],
        fileName: "rom-weaver-warmup.zip",
        identify: false,
      }),
    );
    expect(state.start).toHaveBeenCalled();
    expect(state.done).toHaveBeenCalled();
    expect(state.end).toHaveBeenCalled();
    expect(state.logger).toHaveBeenCalledWith("warmup extraction start");
    expect(state.logger).toHaveBeenCalledWith("warmup extraction done", { outputCount: 1 });
    scheduleBrowserRuntimeWarmupExtraction();
    expect(state.ingest).toHaveBeenCalledTimes(1);
  });

  it("swallows warmup extraction and recycle failures", async () => {
    vi.resetModules();
    const { warmupBrowserRuntimeExtraction: warmup } =
      await import("../../src/platform/browser/browser-runtime-warmup.ts");
    state.ingest.mockRejectedValueOnce(new Error("offline"));
    state.recycle.mockRejectedValueOnce(new Error("busy"));
    await warmup();
    expect(state.logger).toHaveBeenCalledWith("warmup extraction skipped", { message: "offline" });
    expect(state.logger).toHaveBeenCalledWith("warmup runner recycle skipped", { message: "busy" });
    expect(state.end).toHaveBeenCalled();
  });
});
