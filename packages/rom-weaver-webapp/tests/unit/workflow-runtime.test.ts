import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const browserVfs = {
    getFile: vi.fn(async (path: string) => new File([`contents:${path}`], path.split("/").pop() || "entry.bin")),
    remove: vi.fn(async () => undefined),
  };
  const workerIo = {
    createWorkerOutput: vi.fn(async (input: Record<string, unknown>, fallbackFileName: string) => ({
      dispose: vi.fn(async () => undefined),
      fileName: input.fileName || fallbackFileName,
      path: input.filePath || "/work/output.bin",
      size: input.size || 0,
    })),
    stageSource: vi.fn(async (input: { fallbackFileName: string; pathPrefix: string }) => ({
      cleanup: vi.fn(async () => undefined),
      fileName: input.fallbackFileName,
      filePath: `/work/${input.pathPrefix}/${input.fallbackFileName}`,
      size: 12,
    })),
    stageSources: vi.fn(async (inputs: Array<{ fallbackFileName: string; pathPrefix?: string }>) =>
      inputs.map((input) => ({
        cleanup: vi.fn(async () => undefined),
        fileName: input.fallbackFileName,
        filePath: `/work/${input.pathPrefix || "staged"}/${input.fallbackFileName}`,
        size: 12,
      })),
    ),
    runPathWorkerToOutput: vi.fn(),
  };
  return {
    browserVfs,
    bundleCreate: vi.fn(async () => ({ archivePath: "/work/result.zip", bundlePath: "/work/result.json" })),
    bundleParse: vi.fn(async () => ({
      patchSources: [{ source: { extractedPath: "/work/extracted/patch.ips", kind: "extracted" } }],
      romSource: { extractedPath: "/work/extracted/game.bin", kind: "extracted" },
    })),
    configureSourcePrimitives: vi.fn(),
    createOutputFromBytes: vi.fn(async (_vfs: unknown, bytes: Uint8Array, fileName: string) => ({
      fileName,
      path: "/work/bytes.bin",
      size: bytes.byteLength,
    })),
    createOutputFromSource: vi.fn(async (_vfs: unknown, source: unknown, fileName: string) => ({
      fileName,
      path: "/work/source.bin",
      size: 4,
      source,
    })),
    createOutputFromVfs: vi.fn(
      async (_vfs: unknown, path: string, fileName: string, options: Record<string, unknown>) => ({
        dispose: vi.fn(async () => undefined),
        fileName,
        path,
        saveAs: vi.fn(async () => undefined),
        size: options.size || 8,
      }),
    ),
    createOutputScope: vi.fn(() => ({
      cleanup: vi.fn(async () => undefined),
      createOutputCleanups: vi.fn(async (paths: string[]) => paths.map(() => vi.fn(async () => undefined))),
      rootPath: "/work/output-scope",
      selectOutputPath: vi.fn((_directory: string, fileName: string) => `/work/output-scope/${fileName}`),
    })),
    createRuntimeIo: vi.fn(() => workerIo),
    createSharedCompression: vi.fn(() => ({ create: vi.fn(), extract: vi.fn(), probe: vi.fn() })),
    createSharedPatch: vi.fn(() => ({
      applyPatch: vi.fn(),
      createPatch: vi.fn(),
      createPatchCandidates: vi.fn(),
      validatePatch: vi.fn(),
    })),
    createSharedTrim: vi.fn(() => ({ run: vi.fn() })),
    download: vi.fn(async () => undefined),
    emitTrace: vi.fn(),
    identifyGroups: vi.fn(async () => ["nes"]),
    identifySelection: vi.fn(async (_hints: unknown, report: (platforms: string[]) => void) => {
      report(["NES"]);
      return { packs: [{ blob: new Blob(["identify"]), fileName: "nes.json" }] };
    }),
    identifySlugs: vi.fn((hints: { fileName?: string }) => (hints.fileName?.endsWith(".zip") ? ["nes"] : [])),
    ingest: vi.fn(async () => ({
      assets: [
        {
          checksums: { CRC32: "abcd" },
          fileName: "folder/game (Track 1).bin",
          path: "/work/output-scope/folder/game (Track 1).bin",
          sizeBytes: 15,
          trackNumber: 1,
        },
      ],
      patches: [{ fileName: "delta.ips", leafPath: "/work/output-scope/delta.ips", sizeBytes: 4 }],
    })),
    noteIoBatch: vi.fn(),
    outputBlob: vi.fn(async () => new Blob(["output"])),
    outputStorage: vi.fn(() => "opfs"),
    probe: vi.fn(async () => ({ entries: [{ filename: "game.bin" }], platform: "NES" })),
    registerCleanup: vi.fn((_file: object, cleanup: () => Promise<void>) => {
      let released = false;
      return vi.fn(async () => {
        if (!released) {
          released = true;
          await cleanup();
        }
      });
    }),
    removeSourceCleanup: vi.fn(),
    runtimePreload: vi.fn(() => ({ warmup: vi.fn() })),
    sourceAssert: vi.fn((source: unknown) => source),
    triggerWarmupPriority: vi.fn(),
    pauseWarmup: vi.fn(),
    resumeWarmup: vi.fn(),
    updateVirtual: vi.fn(),
    workerIo,
  };
});

vi.mock("../../src/lib/path-utils.ts", () => ({
  getPathBaseName: (path: string, fallback = "") =>
    String(path || fallback)
      .split(/[\\/]/u)
      .pop() || fallback,
}));
vi.mock("../../src/lib/logging.ts", () => ({ emitTraceLog: state.emitTrace }));
vi.mock("../../src/lib/runtime/run-output-paths.ts", () => ({ createRomWeaverOutputScope: state.createOutputScope }));
vi.mock("../../src/lib/runtime/run-result-parsing.ts", () => ({
  romTypeFromEmittedFile: (asset: { platform?: string }) => asset.platform || "unknown",
}));
vi.mock("../../src/lib/runtime/source-normalization.ts", () => ({
  assertBrowserBinarySource: state.sourceAssert,
}));
vi.mock("../../src/lib/runtime/wasm-command-runtime.ts", () => ({
  invokeRomWeaverBundleCreateWorker: state.bundleCreate,
  invokeRomWeaverBundleParseWorker: state.bundleParse,
  invokeRomWeaverIngestWorker: state.ingest,
  runRomWeaverProbeWorker: state.probe,
  invokeRomWeaverCreatePatchCandidatesWorker: vi.fn(),
  invokeRomWeaverCreatePatchWorker: vi.fn(),
  invokeRomWeaverPatchApplyWorker: vi.fn(),
  invokeRomWeaverPatchValidateWorker: vi.fn(),
  invokeRomWeaverTrimWorker: vi.fn(),
}));
vi.mock("../../src/lib/runtime/workflow-runtime-core.ts", () => ({
  createRuntimePreload: state.runtimePreload,
  createSharedCompressionRuntime: state.createSharedCompression,
  createSharedPatchRuntime: state.createSharedPatch,
  createSharedTrimRuntime: state.createSharedTrim,
}));
vi.mock("../../src/storage/browser/browser-source-primitives.ts", () => ({
  configureBrowserSourcePrimitives: state.configureSourcePrimitives,
  registerBrowserSourceCleanup: state.registerCleanup,
}));
vi.mock("../../src/storage/vfs/path.ts", () => ({
  joinVfsPath: (...parts: string[]) => parts.join("/").replace(/\/+/gu, "/"),
}));
vi.mock("../../src/storage/vfs/path-id.ts", () => ({ createVfsPathId: () => "id-1" }));
vi.mock("../../src/storage/vfs/runtime-output.ts", () => ({
  createRuntimeOutputFromBytes: state.createOutputFromBytes,
  createRuntimeOutputFromSource: state.createOutputFromSource,
  createRuntimeOutputFromVfs: state.createOutputFromVfs,
  getRuntimeOutputStorage: state.outputStorage,
  readRuntimeOutputBlob: state.outputBlob,
}));
vi.mock("../../src/workers/rom-weaver/runner-control.ts", () => ({ noteRomWeaverIoBatch: state.noteIoBatch }));
vi.mock("../../src/workers/shared/worker-storage/storage-layout.ts", () => ({ WORKER_OPFS_MOUNTPOINT: "/work" }));
vi.mock("../../src/platform/browser/browser-download.ts", () => ({ triggerBrowserDownload: state.download }));
vi.mock("../../src/platform/browser/browser-runtime-vfs.ts", () => ({
  createBrowserRuntimeVfsIo: state.createRuntimeIo,
}));
vi.mock("../../src/platform/browser/workflow-runtime-archive.ts", () => ({
  createBrowserArchiveRuntime: vi.fn(() => ({ create: vi.fn(), extract: vi.fn(), probe: vi.fn() })),
}));
vi.mock("../../src/platform/browser/workflow-runtime-chd.ts", () => ({
  createBrowserChdRuntime: vi.fn(() => ({})),
  stripPrimaryChdTrackSuffix: (name: string) => name.replace(/ \(Track 1\)/u, ""),
}));
vi.mock("../../src/platform/browser/workflow-runtime-disc-formats.ts", () => ({
  createBrowserDiscFormatsRuntime: vi.fn(() => ({})),
}));
vi.mock("../../src/platform/browser/workflow-runtime-vfs-cleanup.ts", () => ({ browserVfs: state.browserVfs }));
vi.mock("../../src/platform/browser/identify-packs.ts", () => ({
  identifyGroupIdsForHints: state.identifyGroups,
  loadIdentifyPackSelection: state.identifySelection,
  selectIdentifySlugs: state.identifySlugs,
}));
vi.mock("../../src/webapp/pwa/offline-warmup-client.ts", () => ({
  bumpOfflineWarmupPriority: state.triggerWarmupPriority,
  pauseOfflineWarmup: state.pauseWarmup,
  resumeOfflineWarmup: state.resumeWarmup,
}));

const { browserRuntime, createBrowserRuntime } = await import("../../src/platform/browser/workflow-runtime.ts");

beforeEach(() => {
  vi.clearAllMocks();
  state.probe.mockResolvedValue({ entries: [{ filename: "game.bin" }], platform: "NES" });
  state.identifySlugs.mockImplementation((hints: { fileName?: string }) =>
    hints.fileName?.endsWith(".zip") ? ["nes"] : [],
  );
  state.identifySelection.mockResolvedValue({ packs: [{ blob: new Blob(["identify"]), fileName: "nes.json" }] });
  state.ingest.mockResolvedValue({
    assets: [
      {
        checksums: { CRC32: "abcd" },
        fileName: "folder/game (Track 1).bin",
        path: "/work/output-scope/folder/game (Track 1).bin",
        sizeBytes: 15,
        trackNumber: 1,
      },
    ],
    patches: [{ fileName: "delta.ips", leafPath: "/work/output-scope/delta.ips", sizeBytes: 4 }],
  });
});

describe("browser workflow runtime construction and outputs", () => {
  it("constructs the browser adapter and delegates output creation and IO batches", async () => {
    const runtime = createBrowserRuntime();
    expect(runtime).toMatchObject({ name: "browser", sidecars: {}, useBlobOutput: true });
    expect(state.configureSourcePrimitives).toHaveBeenCalled();
    expect(state.createRuntimeIo).toHaveBeenCalledWith({ mountPoint: "/work", vfs: state.browserVfs });
    expect(runtime.binary.assertSource("source")).toBe("source");
    await runtime.output.createBytes(new Uint8Array([1, 2]), "bytes.bin");
    await runtime.output.createSource("source", "source.bin");
    expect(state.createOutputFromBytes).toHaveBeenCalledWith(state.browserVfs, new Uint8Array([1, 2]), "bytes.bin", {
      pathPrefix: "runtime-bytes",
    });
    expect(state.createOutputFromSource).toHaveBeenCalledWith(state.browserVfs, "source", "source.bin", {
      pathPrefix: "runtime-source",
    });
    void runtime.noteIoBatch({ bytes: 4 } as never);
    expect(state.noteIoBatch).toHaveBeenCalledWith({ bytes: 4 });
    expect(runtime.workerIo).toBe(state.workerIo);
  });

  it("routes public output saves to handles, named downloads, or the fallback download", async () => {
    const output = {
      fileName: "result.bin",
      path: "/work/result.bin",
      saveAs: vi.fn(async () => undefined),
      size: 7,
    };
    const handle = { createWritable: vi.fn() };
    await browserRuntime.publicOutput.saveAs(output as never, handle);
    await browserRuntime.publicOutput.saveAs(output as never, { fileName: " renamed.bin " });
    await browserRuntime.publicOutput.saveAs(output as never, { interactive: true });
    await browserRuntime.publicOutput.saveAs(output as never, null);
    await browserRuntime.publicOutput.saveAs(output as never, {});
    expect(output.saveAs).toHaveBeenCalledTimes(4);
    expect(output.saveAs).toHaveBeenNthCalledWith(1, handle);
    expect(output.saveAs).toHaveBeenNthCalledWith(2, { fileName: "renamed.bin", interactive: false });
    expect(output.saveAs).toHaveBeenNthCalledWith(3, { fileName: undefined, interactive: true });
    expect(output.saveAs).toHaveBeenNthCalledWith(4, undefined);
    expect(state.outputBlob).toHaveBeenCalledWith(output);
    expect(state.download).toHaveBeenCalledWith(expect.any(Blob), "result.bin");
    expect(browserRuntime.publicOutput.getSize(output as never)).toBe(7);
    expect(browserRuntime.publicOutput.getStorage(output as never)).toBe("opfs");
  });
});

describe("browser ingest and bundle runtime", () => {
  it("stages identify packs, annotates extracted members, and adopts outputs", async () => {
    const result = await browserRuntime.ingest.run({
      checksumAlgorithms: ["crc32"],
      fileName: "game.zip",
      identify: true,
      identifyAllRomEntries: true,
      interactiveSelectionEnabled: false,
      select: [],
      source: new Blob(["archive"]),
      splitBin: true,
    } as never);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0]).toMatchObject({
      fileName: "folder/game.bin",
      path: expect.stringContaining("folder/game"),
    });
    expect(result.patchOutputs[0]).toMatchObject({ fileName: "delta.ips" });
    expect(state.probe).toHaveBeenCalledWith(
      expect.objectContaining({ romFilter: true, sourcePath: expect.stringContaining("ingest-input") }),
      undefined,
      undefined,
    );
    expect(state.workerIo.stageSources).toHaveBeenCalledWith([
      expect.objectContaining({ fallbackFileName: "nes.json", scope: "checksum" }),
    ]);
    expect(state.workerIo.stageSource).toHaveBeenCalledWith(expect.objectContaining({ scope: "archive" }));
    expect(state.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ select: ["game.bin"], checksumAlgorithms: ["crc32"], splitBin: true }),
      undefined,
      undefined,
    );
    expect(state.resumeWarmup).toHaveBeenCalled();
  });

  it("continues ingest when probing and identify data fail, and cleans staged inputs", async () => {
    state.probe.mockRejectedValueOnce(new Error("probe failed"));
    state.identifySelection.mockRejectedValueOnce(new Error("packs offline"));
    const result = await browserRuntime.ingest.run({
      fileName: "unknown.bin",
      identify: true,
      source: "bytes",
    } as never);
    expect(result.identifyUnavailable).toBe("packs offline");
    expect(result.outputs).toHaveLength(1);
    expect(state.emitTrace).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "runtime:browser-workflow" }),
      "ROM identify probe failed; widening the identify pack selection",
      expect.objectContaining({ error: "probe failed" }),
    );
  });

  it("creates and parses bundles, then releases extracted members and their scope", async () => {
    const created = await browserRuntime.bundle.create?.({
      bundleFileName: "exports/bundle.zip",
      bundleRom: { fileName: "bundle.rom", source: "bundle" },
      noBundleRom: true,
      outputName: "named",
      patches: [{ author: "A", fileName: "fix.ips", source: "patch", optional: true }],
      rom: { fileName: "game.rom", source: "rom" },
    } as never);
    expect(created).toMatchObject({
      bundleOutput: { path: "/work/result.json" },
      archiveOutput: { path: "/work/result.zip" },
    });
    expect(state.bundleCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        bundlePath: "/work/output-scope/bundle.zip",
        noBundleRom: true,
        patchPaths: expect.any(Array),
      }),
      undefined,
      undefined,
    );

    const parsed = await browserRuntime.bundle.parse?.({ fileName: "bundle.json", source: "bundle" } as never);
    expect(parsed?.extractedFiles.size).toBe(2);
    expect(parsed?.extractedFiles.get("/work/extracted/game.bin")).toMatchObject({ name: "game.bin" });
    await parsed?.cleanup();
    expect(state.browserVfs.remove).toHaveBeenCalledWith("/work/extracted/game.bin");
    expect(state.browserVfs.remove).toHaveBeenCalledWith("/work/extracted/patch.ips");
    expect(state.browserVfs.remove).toHaveBeenCalledWith(expect.stringContaining("bundle-parse"));
  });

  it("cleans a bundle create failure after output creation", async () => {
    state.bundleCreate.mockRejectedValueOnce(new Error("bundle failed"));
    await expect(browserRuntime.bundle.create?.({ patches: [], rom: { source: "rom" } } as never)).rejects.toThrow(
      "bundle failed",
    );
    expect(state.createOutputScope).toHaveBeenCalled();
  });
});
