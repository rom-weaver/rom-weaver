import { beforeEach, describe, expect, it, vi } from "vitest";

const warmup = vi.hoisted(() => ({ warmupRomWeaverRunner: vi.fn(async () => undefined) }));
vi.mock("../../src/workers/rom-weaver/runner-control.ts", () => warmup);

import {
  createRuntimePreload,
  createSharedCompressionRuntime,
  createSharedPatchRuntime,
  createSharedTrimRuntime,
} from "../../src/lib/runtime/workflow-runtime-core.ts";

type WorkerSource = {
  fileName: string;
  filePath: string;
  size: number;
  cleanup: ReturnType<typeof vi.fn>;
};

const makeSource = (fileName: string, index: number): WorkerSource => ({
  cleanup: vi.fn(async () => undefined),
  fileName,
  filePath: `/work/${index}-${fileName}`,
  size: index + 10,
});

const makeOutput = (fileName = "output.bin", size = 12) => ({
  dispose: vi.fn(async () => undefined),
  fileName,
  path: `/work/${fileName}`,
  size,
  timing: { elapsedMs: 8 },
});

const makePatchAdapter = () => {
  const sources = [makeSource("input.bin", 0), makeSource("patch.ips", 1)];
  const workerIo = {
    createWorkerOutput: vi.fn(async (result: { fileName?: string; size?: number }, fallback: string) =>
      makeOutput(result.fileName || fallback, result.size || 1),
    ),
    stageSource: vi.fn(async () => sources[0]),
    stageSources: vi.fn(async () => sources),
  };
  const adapter = {
    invokeApplyPatchWorker: vi.fn(async () => ({
      applySummary: { timing: { elapsedMs: 19 }, patchCount: 1 },
      fileName: "patched.bin",
      size: 99,
      timing: { elapsedMs: 19 },
    })),
    invokeCreatePatchCandidatesWorker: vi.fn(async () => ({
      candidates: [{ format: "ips", reason: "same-size" }],
    })),
    invokeCreatePatchWorker: vi.fn(async () => ({ fileName: "created.ips", size: 20, timing: { elapsedMs: 3 } })),
    invokeValidatePatchWorker: vi.fn(async () => ({ valid: true, warnings: [] })),
    workerIo,
  };
  return { adapter, sources, workerIo };
};

beforeEach(() => warmup.warmupRomWeaverRunner.mockClear());

describe("createSharedPatchRuntime", () => {
  it("stages, dispatches, annotates, and cleans an applied patch", async () => {
    const { adapter, sources, workerIo } = makePatchAdapter();
    const runtime = createSharedPatchRuntime(adapter as never);
    const progress = vi.fn();
    const output = await runtime.applyPatch?.({
      input: { fileName: "game.bin" } as never,
      logLevel: "trace",
      onLog: vi.fn(),
      onProgress: progress,
      options: { dryRun: true },
      patches: [{ patchFile: { fileName: "fix.ips" }, patchFileName: "fix.ips", patchFormat: "ips" }],
      signal: undefined,
    } as never);

    expect(adapter.invokeApplyPatchWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        inputSize: sources[0]?.size,
        patchFileName: "patch.ips",
        patchFilePath: sources[1]?.filePath,
        patchFormat: "ips",
        patchFiles: [{ patchFileName: "patch.ips", patchFilePath: sources[1]?.filePath, patchFormat: "ips" }],
        romFileName: "input.bin",
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(output).toMatchObject({ fileName: "patched.bin", _applySummary: { patchCount: 1 } });
    expect(sources[0]?.cleanup).toHaveBeenCalledTimes(1);
    expect(sources[1]?.cleanup).toHaveBeenCalledTimes(1);
    expect(workerIo.createWorkerOutput).toHaveBeenCalledWith(expect.anything(), "patched.bin", undefined);

    const workerProgress = adapter.invokeApplyPatchWorker.mock.calls[0]?.[1] as (event: unknown) => void;
    workerProgress({ current: 2, details: { bytes: 10 }, label: "Applying", percent: 50, total: 4 });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ current: 2, label: "Applying", percent: 50, total: 4 }),
    );
  });

  it("cleans staged sources when the apply worker fails", async () => {
    const { adapter, sources } = makePatchAdapter();
    adapter.invokeApplyPatchWorker.mockRejectedValueOnce(new Error("worker failed"));
    const runtime = createSharedPatchRuntime(adapter as never);
    await expect(runtime.applyPatch?.({ input: {}, patches: [], options: {} } as never)).rejects.toThrow(
      "worker failed",
    );
    expect(sources[0]?.cleanup).toHaveBeenCalledTimes(1);
    expect(sources[1]?.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reports stage failures without trying to clean unknown sources", async () => {
    const { adapter, sources } = makePatchAdapter();
    adapter.workerIo.stageSources.mockRejectedValueOnce(new Error("stage failed"));
    const runtime = createSharedPatchRuntime(adapter as never);
    await expect(runtime.applyPatch?.({ input: {}, patches: [], options: {} } as never)).rejects.toThrow(
      "stage failed",
    );
    expect(sources[0]?.cleanup).not.toHaveBeenCalled();
  });

  it("creates a patch and forwards metadata, timing, and cleanup", async () => {
    const { adapter, sources, workerIo } = makePatchAdapter();
    const runtime = createSharedPatchRuntime(adapter as never);
    const result = await runtime.createPatch?.({
      checksumName: "crc32",
      format: "bps",
      logLevel: "debug",
      metadata: { author: "tester", title: "Game" },
      modified: { fileName: "new.bin" } as never,
      onLog: vi.fn(),
      onProgress: vi.fn(),
      options: {},
      original: { fileName: "old.bin" } as never,
      outputName: "patch.bps",
      signal: undefined,
      sourceCrc32: "deadbeef",
      threads: 3,
    } as never);
    expect(adapter.invokeCreatePatchWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        checksumName: "crc32",
        format: "bps",
        metadata: { author: "tester", title: "Game" },
        modifiedFileName: sources[1]?.fileName,
        originalFileName: sources[0]?.fileName,
        outputName: "patch.bps",
        sourceCrc32: "deadbeef",
        threads: 3,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result).toMatchObject({
      format: "bps",
      sizeSummary: { createTimeMs: 3 },
      output: { fileName: "created.ips" },
    });
    expect(workerIo.createWorkerOutput).toHaveBeenCalledWith(expect.anything(), "patch.bps", undefined);
    expect(sources[0]?.cleanup).toHaveBeenCalled();
    expect(sources[1]?.cleanup).toHaveBeenCalled();
  });

  it("creates candidates and validates patches, including validation requirements", async () => {
    const { adapter, sources } = makePatchAdapter();
    const runtime = createSharedPatchRuntime(adapter as never);
    const candidates = await runtime.createPatchCandidates?.({
      modified: {},
      original: {},
      onProgress: undefined,
      signal: undefined,
      threads: undefined,
    } as never);
    expect(candidates).toEqual({ candidates: [{ format: "ips", reason: "same-size" }] });
    expect(adapter.invokeCreatePatchCandidatesWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        modifiedFileName: sources[1]?.fileName,
        originalFileName: sources[0]?.fileName,
        threads: undefined,
      }),
      undefined,
      undefined,
    );

    await expect(
      runtime.validatePatch?.({
        input: {},
        logLevel: "debug",
        onLog: undefined,
        onProgress: undefined,
        options: { dryRun: true },
        patches: [
          {
            patchFile: {},
            patchFileName: "a.ips",
            requirements: { inputChecks: [{ algorithm: "crc32", value: "a" }] },
          },
          { patchFile: {}, patchFileName: "b.ips" },
        ],
        signal: undefined,
      } as never),
    ).resolves.toMatchObject({ valid: true });
    expect(adapter.invokeValidatePatchWorker).toHaveBeenCalled();
    expect(adapter.invokeValidatePatchWorker.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({
          validationRequirements: [{ inputChecks: [{ algorithm: "crc32", value: "a" }] }],
        }),
        patchFiles: expect.arrayContaining([expect.objectContaining({ patchFileName: "patch.ips" })]),
      }),
    );
  });

  it("rejects when a worker input is not staged", async () => {
    const { adapter, sources } = makePatchAdapter();
    adapter.workerIo.stageSources.mockResolvedValueOnce([]);
    const runtime = createSharedPatchRuntime(adapter as never);
    await expect(runtime.applyPatch?.({ input: {}, patches: [], options: {} } as never)).rejects.toThrow(
      "Patch worker input was not staged for applying",
    );
    expect(sources[0]?.cleanup).not.toHaveBeenCalled();
  });
});

describe("createSharedTrimRuntime", () => {
  it("runs a trim worker and releases its source", async () => {
    const source = makeSource("game.bin", 0);
    const workerIo = {
      createWorkerOutput: vi.fn(async () => makeOutput("trimmed.bin", 7)),
      stageSource: vi.fn(async () => source),
    };
    const invokeTrimWorker = vi.fn(async () => ({ fileName: "trimmed.bin", size: 7, timing: { elapsedMs: 4 } }));
    const runtime = createSharedTrimRuntime({ invokeTrimWorker, workerIo } as never);
    const result = await runtime.trim?.({
      extension: "sfc",
      logLevel: "trace",
      onLog: vi.fn(),
      onProgress: vi.fn(),
      outputName: "trimmed.sfc",
      signal: undefined,
      source: {} as never,
      threads: 2,
    } as never);
    expect(invokeTrimWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        extension: "sfc",
        outputName: "trimmed.sfc",
        sourceFileName: source.fileName,
        threads: 2,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(result).toMatchObject({ output: { fileName: "trimmed.bin" }, sizeSummary: { trimTimeMs: 4 } });
    expect(source.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans the source when trimming fails", async () => {
    const source = makeSource("game.bin", 0);
    const workerIo = { stageSource: vi.fn(async () => source), createWorkerOutput: vi.fn() };
    const runtime = createSharedTrimRuntime({
      invokeTrimWorker: vi.fn(async () => {
        throw new Error("trim failed");
      }),
      workerIo,
    } as never);
    await expect(runtime.trim?.({ source: {} } as never)).rejects.toThrow("trim failed");
    expect(source.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("createSharedCompressionRuntime", () => {
  const compressionOutput = () => makeOutput("compressed.bin", 30);

  it("dispatches archive creation, probing, and generic extraction", async () => {
    const archiveCreate = vi.fn(async (request) => ({ output: { fileName: request.outputName, size: 2 } }));
    const archiveExtract = vi.fn(async (request) => ({ outputs: [makeOutput(request.entries[0] || "entry.bin", 2)] }));
    const archiveProbe = vi.fn(async () => ({ entries: [{ filename: "game.bin", size_bytes: 2 }] }));
    const runtime = createSharedCompressionRuntime(
      { create: archiveCreate, extract: archiveExtract, probe: archiveProbe } as never,
      {},
    );
    await expect(runtime.create?.({ entries: [], format: "zip", outputName: "bundle.zip" } as never)).resolves.toEqual({
      output: { fileName: "bundle.zip", size: 2 },
    });
    await expect(runtime.probe?.({ format: "zip", source: {} } as never)).resolves.toEqual({
      entries: [{ filename: "game.bin", size_bytes: 2 }],
    });
    await expect(
      runtime.extract?.({ descendSinglePayload: true, entries: ["game.bin"], format: "zip", source: {} } as never),
    ).resolves.toEqual({
      outputs: [expect.objectContaining({ fileName: "game.bin" })],
    });
    expect(archiveCreate).toHaveBeenCalledTimes(1);
    expect(archiveExtract).toHaveBeenCalledTimes(1);
    expect(archiveProbe).toHaveBeenCalledTimes(1);
  });

  it("creates CHD, RVZ, and Z3DS outputs from namespaced settings", async () => {
    const createChd = vi.fn(async (_input) => compressionOutput());
    const createRvz = vi.fn(async (_input) => compressionOutput());
    const createZ3ds = vi.fn(async (_input) => compressionOutput());
    const runtime = createSharedCompressionRuntime({}, { createChd, createRvz, createZ3ds });
    const common = { fileName: "game.bin", options: { logLevel: "debug", threads: 4 }, outputName: "out" };
    await expect(
      runtime.create?.({
        ...common,
        format: "chd",
        source: {},
        romSpecific: { chd: { mode: "cd", sourceMode: "tracks", compressionCodecs: ["lzma"] } },
      } as never),
    ).resolves.toMatchObject({ output: expect.anything() });
    await expect(
      runtime.create?.({
        ...common,
        format: "rvz",
        source: {},
        romSpecific: { rvz: { codec: "zstd", blockSize: 1024, compressionLevel: 5, mode: "raw", scrub: true } },
      } as never),
    ).resolves.toMatchObject({ output: expect.anything() });
    await expect(
      runtime.create?.({
        ...common,
        format: "z3ds",
        source: {},
        romSpecific: { z3ds: { compressionLevel: 3, metadata: { title: "Game" }, underlyingMagic: "3DS" } },
      } as never),
    ).resolves.toMatchObject({ output: expect.anything() });
    expect(createChd).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cd", sourceMode: "tracks", compressionCodecs: ["lzma"], threads: 4 }),
    );
    expect(createRvz).toHaveBeenCalledWith(expect.objectContaining({ codec: "zstd", blockSize: 1024, scrub: true }));
    expect(createZ3ds).toHaveBeenCalledWith(expect.objectContaining({ compressionLevel: 3, underlyingMagic: "3DS" }));
  });

  it("rejects legacy or unsupported compression create requests", async () => {
    const runtime = createSharedCompressionRuntime({}, {});
    await expect(runtime.create?.({ format: "chd", source: {}, chdSourceMode: "legacy" } as never)).rejects.toThrow(
      "Legacy compression create option fields are unsupported",
    );
    await expect(runtime.create?.({ format: "made-up", source: {} } as never)).rejects.toThrow(
      "Unsupported compression create format: made-up",
    );
    await expect(runtime.create?.({ format: "chd", source: {} } as never)).rejects.toThrow(
      "CHD compression creation is unavailable",
    );
    await expect(runtime.create?.({ entries: [], format: "zip" } as never)).rejects.toThrow(
      "Archive compression creation is unavailable",
    );
  });

  it("extracts CHD outputs for cue/track selections and preserves retained ownership", async () => {
    const cue = makeOutput("source.cue", 3);
    const trackA = makeOutput("track01.bin", 4);
    const trackB = makeOutput("track02.bin", 5);
    const extractChd = vi.fn(async (input) => {
      input.onProgress?.({ label: "Extracting", percent: 25 });
      return {
        outputs: [cue, trackA, trackB],
        output: trackA,
        entries: [],
      };
    });
    const runtime = createSharedCompressionRuntime({}, { extractChd });
    const progress = vi.fn();
    const result = await runtime.extract?.({
      entries: ["disc.cue", "track01.bin"],
      format: "chd",
      options: { chdSplitBin: true, logLevel: "trace", onProgress: progress, threads: 2 },
      outputName: "out.bin",
      source: { fileName: "disc.chd" },
    } as never);
    expect(result?.outputs.map((output: { fileName?: string }) => output.fileName)).toEqual([
      "disc.cue",
      "track01.bin",
      "track02.bin",
    ]);
    expect(extractChd).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cd", outputName: "track01.bin", splitBin: true }),
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Extracting", stage: "input", percent: 25 }),
    );
  });

  it("handles single-output ROM-specific extraction and missing runtime capabilities", async () => {
    const extractRvz = vi.fn(async () => makeOutput("game.bin", 9));
    const runtime = createSharedCompressionRuntime({}, { extractRvz });
    await expect(
      runtime.extract?.({ entries: ["game.bin"], format: "rvz", source: { fileName: "game.rvz" } } as never),
    ).resolves.toMatchObject({ outputs: [{ fileName: "game.bin" }] });
    await expect(runtime.extract?.({ entries: ["one", "two"], format: "rvz", source: {} } as never)).rejects.toThrow(
      "RVZ compression extraction requires exactly one synthetic output entry",
    );
    const unavailable = createSharedCompressionRuntime({}, {});
    await expect(unavailable.extract?.({ entries: ["game.bin"], format: "rvz", source: {} } as never)).rejects.toThrow(
      "RVZ compression extraction is unavailable",
    );
    const optional = createSharedCompressionRuntime({}, {}, { archiveRuntimeOptional: true });
    expect(optional.extract).toBeUndefined();
    await expect(optional.create?.({ format: "made-up", source: {} } as never)).rejects.toThrow();
  });
});

describe("createRuntimePreload", () => {
  it("emits the worker lifecycle around a successful warmup", async () => {
    const emit = vi.fn();
    await createRuntimePreload().preloadCapability?.("compression", emit, { threads: 3 });
    expect(warmup.warmupRomWeaverRunner).toHaveBeenCalledWith(3);
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      {
        data: { capability: "compression", level: "debug", message: "Preloading compression capability" },
        kind: "log",
      },
      { data: { capability: "compression", status: "created", workerKind: "rom-weaver" }, kind: "worker" },
      { data: { capability: "compression", status: "loading", workerKind: "rom-weaver" }, kind: "worker" },
      { data: { capability: "compression", status: "loading", tool: "rom-weaver" }, kind: "wasm" },
      { data: { capability: "compression", status: "busy", workerKind: "rom-weaver" }, kind: "worker" },
      { data: { capability: "compression", status: "loaded", tool: "rom-weaver" }, kind: "wasm" },
      { data: { capability: "compression", status: "instantiated", tool: "rom-weaver" }, kind: "wasm" },
      { data: { capability: "compression", status: "ready", workerKind: "rom-weaver" }, kind: "worker" },
      { data: { capability: "compression", status: "idle", workerKind: "rom-weaver" }, kind: "worker" },
    ]);
  });

  it("emits failed lifecycle events and rethrows warmup failures", async () => {
    const failure = new Error("warmup failed");
    warmup.warmupRomWeaverRunner.mockRejectedValueOnce(failure);
    const emit = vi.fn();
    await expect(createRuntimePreload().preloadCapability?.("patch", emit, undefined)).rejects.toBe(failure);
    expect(emit).toHaveBeenLastCalledWith({
      data: { capability: "patch", status: "failed", workerKind: "rom-weaver" },
      kind: "worker",
    });
    expect(emit).toHaveBeenCalledWith({
      data: { capability: "patch", status: "failed", tool: "rom-weaver" },
      kind: "wasm",
    });
  });
});
