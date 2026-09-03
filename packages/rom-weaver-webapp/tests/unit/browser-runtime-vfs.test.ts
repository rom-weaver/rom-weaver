import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createdRefs: [] as Array<{ filePath: string; fileName: string; cleanup: ReturnType<typeof vi.fn> }>,
  released: [] as unknown[],
  retained: [] as unknown[],
  sourceRefs: [] as Array<{
    fileName: string;
    filePath: string;
    size?: number;
    virtual?: boolean;
    cleanup: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../src/lib/logging.ts", () => ({ emitTraceLog: vi.fn() }));
vi.mock("../../src/storage/browser/browser-source-primitives.ts", () => ({
  releaseBrowserSource: vi.fn(async (source: unknown) => {
    state.released.push(source);
  }),
  retainBrowserSource: vi.fn((source: unknown) => {
    state.retained.push(source);
  }),
}));
vi.mock("../../src/storage/vfs/runtime-output.ts", () => ({
  createRuntimeOutputFromVfs: vi.fn(
    async (vfs: unknown, filePath: string, fileName: string, options: Record<string, unknown>) => {
      const output = {
        checksums: options.checksums,
        dispose: vi.fn(async () => options.cleanup && (await options.cleanup())),
        fileName,
        mediaType: options.mediaType,
        path: filePath,
        size: options.size ?? 0,
        vfs,
      };
      state.createdRefs.push({ filePath, fileName, cleanup: output.dispose });
      return output;
    },
  ),
}));
vi.mock("../../src/workers/protocol/browser-opfs-source-ref.ts", () => ({
  createBrowserOpfsSourceRef: vi.fn(async (source: unknown, fallback: string, options: Record<string, unknown>) => {
    const next = state.sourceRefs.shift();
    if (!next) throw new Error(`no staged ref for ${String(source)}`);
    return { ...next, fileName: next.fileName || fallback, pathPrefix: options.pathPrefix };
  }),
}));

const { createBrowserRuntimeVfsIo } = await import("../../src/platform/browser/browser-runtime-vfs.ts");

type FakeVfs = {
  createOutputRef: ReturnType<typeof vi.fn>;
  normalizePath: (path: string) => string;
  remove: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
};

const makeVfs = (): FakeVfs => ({
  createOutputRef: vi.fn(),
  normalizePath: (path) => path,
  remove: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 7 })),
});

const stageRequest = (source: unknown, extras: Record<string, unknown> = {}) => ({
  fallbackFileName: "input.bin",
  pathPrefix: "input",
  scope: "archive" as const,
  source,
  ...extras,
});

let vfs: FakeVfs;
let io: ReturnType<typeof createBrowserRuntimeVfsIo>;

beforeEach(() => {
  vi.useFakeTimers();
  state.createdRefs.length = 0;
  state.released.length = 0;
  state.retained.length = 0;
  state.sourceRefs.length = 0;
  vfs = makeVfs();
  io = createBrowserRuntimeVfsIo({ mountPoint: "/work", vfs });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("browser runtime VFS source staging", () => {
  it("passes through a VFS reference already mounted on the active VFS", async () => {
    const source = { fileName: "direct.bin", path: "/work/direct.bin", vfs };
    const staged = await io.stageSource(stageRequest(source));

    expect(staged).toMatchObject({ fileName: "direct.bin", filePath: "/work/direct.bin", size: 7 });
    await staged.cleanup();
    expect(state.sourceRefs).toEqual([]);
  });

  it("stages virtual sources once and shares the cached ref across callers", async () => {
    const source = { name: "same.zip", size: 10 };
    const cleanup = vi.fn(async () => undefined);
    state.sourceRefs.push({ fileName: "same.zip", filePath: "/work/same.zip", size: 10, virtual: true, cleanup });

    const first = await io.stageSource(stageRequest(source));
    const second = await io.stageSource(stageRequest(source));
    expect(first.filePath).toBe(second.filePath);
    expect(cleanup).not.toHaveBeenCalled();

    await first.cleanup();
    expect(cleanup).not.toHaveBeenCalled();
    await second.cleanup();
    expect(cleanup).not.toHaveBeenCalled();
    await io.releaseSources([source]);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent stages and cleans a release that arrives before insertion", async () => {
    const source = { name: "queued.zip" };
    let resolveStage!: (value: {
      fileName: string;
      filePath: string;
      virtual: boolean;
      cleanup: () => Promise<void>;
    }) => void;
    const cleanup = vi.fn(async () => undefined);
    const stagePromise = new Promise<{
      fileName: string;
      filePath: string;
      virtual: boolean;
      cleanup: () => Promise<void>;
    }>((resolve) => {
      resolveStage = resolve;
    });
    const createRef = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
    vi.mocked(createRef.createBrowserOpfsSourceRef).mockImplementationOnce(async () => stagePromise);

    const firstPromise = io.stageSource(stageRequest(source));
    await Promise.resolve();
    await io.releaseSources([source]);
    resolveStage({ cleanup, fileName: "queued.zip", filePath: "/work/queued.zip", virtual: true });
    const first = await firstPromise;
    expect(first.filePath).toBe("/work/queued.zip");
    await first.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("retries a missing staged path and reports a second failure", async () => {
    const source = { name: "retry.bin" };
    const firstCleanup = vi.fn(async () => undefined);
    const secondCleanup = vi.fn(async () => undefined);
    state.sourceRefs.push(
      { fileName: "retry.bin", filePath: "/work/retry-1.bin", cleanup: firstCleanup },
      { fileName: "retry.bin", filePath: "/work/retry-2.bin", cleanup: secondCleanup },
    );
    vfs.stat.mockResolvedValue(null);

    const promise = io.stageSource(stageRequest(source));
    const failure = expect(promise).rejects.toThrow("Browser worker input path is not available: /work/retry-2.bin");
    await vi.runAllTimersAsync();
    await failure;
    expect(firstCleanup).toHaveBeenCalledTimes(1);
    expect(secondCleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans every fulfilled sibling when stageSources has one rejection", async () => {
    const one = { name: "one.bin" };
    const two = { name: "two.bin" };
    const firstCleanup = vi.fn(async () => undefined);
    state.sourceRefs.push({ fileName: "one.bin", filePath: "/work/one.bin", virtual: true, cleanup: firstCleanup });
    const createRef = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
    vi.mocked(createRef.createBrowserOpfsSourceRef)
      .mockImplementationOnce(async () => ({
        cleanup: firstCleanup,
        fileName: "one.bin",
        filePath: "/work/one.bin",
        virtual: true,
      }))
      .mockImplementationOnce(async () => {
        throw new Error("second source failed");
      });

    await expect(io.stageSources([stageRequest(one), stageRequest(two)])).rejects.toThrow("second source failed");
    await io.releaseSources([one]);
    expect(firstCleanup).toHaveBeenCalledTimes(1);
  });
});

describe("browser runtime VFS worker adapters", () => {
  it("retains and releases owned sources, and turns a path result into output metadata", async () => {
    const source = { name: "owned.bin" };
    io.retainOwnedSources([source]);
    await io.releaseOwnedSources([source]);
    expect(state.retained).toEqual([source]);
    expect(state.released).toEqual([source]);

    const cleanup = vi.fn(async () => undefined);
    const output = await io.createWorkerOutput(
      {
        checksums: { CRC32: "abcd" },
        cleanup,
        fileName: "result.bin",
        filePath: "/work/result.bin",
        size: 12,
        trackNumber: 2,
      },
      "fallback.bin",
      "worker failed",
    );
    expect(output).toMatchObject({
      checksums: { CRC32: "abcd" },
      fileName: "result.bin",
      path: "/work/result.bin",
      size: 12,
    });
    await output.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses outputRef metadata and removes a VFS path when no result cleanup exists", async () => {
    const output = await io.createWorkerOutput(
      { outputRef: { fileName: "ref.bin", filePath: "/work/ref.bin", size: 5 } },
      "fallback.bin",
      "worker failed",
    );
    expect(output.fileName).toBe("ref.bin");
    await output.dispose();
    expect(vfs.remove).toHaveBeenCalledWith("/work/ref.bin");
  });

  it("runs a path worker through staging and cleans the staged source", async () => {
    const source = { name: "worker.bin" };
    const stagedCleanup = vi.fn(async () => undefined);
    state.sourceRefs.push({
      fileName: "worker.bin",
      filePath: "/work/worker.bin",
      virtual: true,
      cleanup: stagedCleanup,
    });
    const worker = vi.fn(async (_staged: { filePath: string }) => ({ filePath: "/work/output.bin" }));
    const output = await io.runPathWorkerToOutput({
      fallbackFileName: "worker.bin",
      outputName: "output.bin",
      pathPrefix: "runtime",
      run: worker,
      scope: "archive",
      source,
    });
    expect(worker).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/work/worker.bin" }));
    expect(output.fileName).toBe("output.bin");
    expect(stagedCleanup).not.toHaveBeenCalled();
    await io.releaseSources([source]);
    expect(stagedCleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects worker results with neither a path nor an output reference", async () => {
    await expect(io.createWorkerOutput({}, "fallback.bin", "custom worker failure")).rejects.toThrow(
      "custom worker failure",
    );
  });
});
