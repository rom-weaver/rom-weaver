import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configureBrowserAssetBaseUrl: vi.fn(),
  identifyHashWorker: vi.fn(),
  invokeRomWeaverPpfUndoWorker: vi.fn(),
  loadIdentifyPacks: vi.fn(),
  preloadCapability: vi.fn(),
  scheduleBrowserRuntimeWarmupExtraction: vi.fn(),
  runtime: {
    compression: { create: vi.fn() },
    output: { createSource: vi.fn() },
    ingest: { run: vi.fn() },
    patch: { createPatchCandidates: vi.fn() },
    preload: { preloadCapability: vi.fn() },
    publicOutput: { getBlob: vi.fn() },
    workerIo: { createWorkerOutput: vi.fn(), stageSources: vi.fn() },
  },
}));

class IdentifyDataUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentifyDataUnavailableError";
  }
}

vi.mock("../../src/platform/browser/workflow-runtime.ts", () => ({ browserRuntime: mocks.runtime }));
vi.mock("../../src/platform/browser/browser-asset-base.ts", () => ({
  configureBrowserAssetBaseUrl: mocks.configureBrowserAssetBaseUrl,
}));
vi.mock("../../src/platform/browser/browser-runtime-warmup.ts", () => ({
  scheduleBrowserRuntimeWarmupExtraction: mocks.scheduleBrowserRuntimeWarmupExtraction,
}));
vi.mock("../../src/platform/browser/identify-packs.ts", () => ({
  IdentifyDataUnavailableError,
  loadIdentifyPacks: mocks.loadIdentifyPacks,
}));
vi.mock("../../src/lib/runtime/wasm-command-runtime.ts", () => ({
  invokeRomWeaverIdentifyHashWorker: mocks.identifyHashWorker,
  invokeRomWeaverPpfUndoWorker: mocks.invokeRomWeaverPpfUndoWorker,
}));

const api = await import("../../src/platform/browser/browser-api.ts");

const blob = (name: string) => new File([`${name}-bytes`], name);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtime.ingest.run.mockResolvedValue({
    outputs: [],
    patchOutputs: [],
    result: { assets: [] },
  });
  mocks.runtime.workerIo.stageSources.mockResolvedValue([]);
  mocks.runtime.workerIo.createWorkerOutput.mockReturnValue({ output: true });
  mocks.runtime.preload.preloadCapability.mockResolvedValue(undefined);
  mocks.loadIdentifyPacks.mockResolvedValue([]);
});

describe("browser ingest and identify API", () => {
  it("forwards ingest options and rejects when the checksum runtime is unavailable", async () => {
    const onProgress = vi.fn();
    const signal = new AbortController().signal;
    await api.ingestRom(blob("game.gba"), "game.gba", {
      checksumAlgorithms: ["md5"],
      identify: true,
      identifyAllRomEntries: true,
      onProgress,
      signal,
    });
    expect(mocks.runtime.ingest.run).toHaveBeenCalledWith({
      checksumAlgorithms: ["md5"],
      fileName: "game.gba",
      identify: true,
      identifyAllRomEntries: true,
      onProgress,
      signal,
      source: expect.any(File),
    });

    const ingest = mocks.runtime.ingest;
    const run = ingest.run;
    ingest.run = undefined;
    await expect(api.ingestRom(blob("game.gba"), "game.gba")).rejects.toThrow(
      "The rom-weaver checksum runtime is unavailable",
    );
    ingest.run = run;
  });

  it("identifies all asset fields and disposes every temporary output", async () => {
    const disposeOne = vi.fn().mockResolvedValue(undefined);
    const disposeTwo = vi.fn().mockRejectedValue(new Error("already closed"));
    mocks.runtime.ingest.run.mockResolvedValue({
      outputs: [{ dispose: disposeOne }],
      patchOutputs: [{ dispose: disposeTwo }],
      result: {
        assets: [
          {
            checksumVariants: [{ algorithm: "sha1", value: "abc" }],
            checksums: { crc32: "ABCD" },
            condition: "prototype",
            copiedInPlace: false,
            database: "pack.bin",
            evidence: ["header"],
            fileName: "game.gba",
            identification: {
              condition: "prototype",
              database: "pack.bin",
              evidence: ["header"],
              hint: "check dump",
              matches: [{ name: "Game" }],
              platformCandidates: ["gba"],
              quality: "verified",
              status: "matched",
            },
            memberPath: "Games/game.gba",
            path: "/work/game.gba",
            platform: "Game Boy Advance",
          },
        ],
      },
    });

    const result = await api.identifyRom(blob("games.zip"), "games.zip");
    expect(result).toMatchObject({
      archiveName: "games.zip",
      candidates: [
        {
          checksumVariants: [{ algorithm: "sha1", value: "abc" }],
          checksums: { crc32: "ABCD" },
          condition: "prototype",
          database: "pack.bin",
          detectedPlatform: "Game Boy Advance",
          evidence: ["header"],
          hint: "check dump",
          matches: [{ name: "Game" }],
          path: "Games/game.gba",
          platformCandidates: ["gba"],
          quality: "verified",
          status: "matched",
        },
      ],
      input: "games.zip",
      status: "matched",
    });
    expect(disposeOne).toHaveBeenCalledTimes(1);
    expect(disposeTwo).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.ingest.run).toHaveBeenCalledWith(
      expect.objectContaining({
        checksumAlgorithms: ["crc32", "md5", "sha1"],
        identify: true,
        identifyAllRomEntries: true,
      }),
    );
  });

  it("reports identify database outages and runs hash checks through staged packs", async () => {
    const unavailable = new IdentifyDataUnavailableError("packs are offline");
    mocks.loadIdentifyPacks.mockRejectedValueOnce(unavailable);
    await expect(api.identifyHash("  ABCD  ")).resolves.toEqual({
      candidates: [{ checksumVariants: [], checksums: {}, matches: [], path: "abcd", status: "unavailable" }],
      input: "abcd",
      status: "unavailable",
      unavailableReason: "packs are offline",
    });

    const staged = [
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/work/identify-1.pack" },
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/work/identify-2.pack" },
    ];
    mocks.loadIdentifyPacks.mockImplementationOnce(async (_options, onProgress) => {
      onProgress(["gba", "nes"]);
      return [
        { blob: blob("gba.pack"), fileName: "gba.pack" },
        { blob: blob("nes.pack"), fileName: "nes.pack" },
      ];
    });
    mocks.runtime.workerIo.stageSources.mockResolvedValueOnce(staged);
    mocks.identifyHashWorker.mockResolvedValueOnce({
      checksumVariants: [{ algorithm: "md5", value: "abcd" }],
      checksums: { md5: "abcd" },
      input: "/work/game.gba",
      matches: [{ name: "Game" }],
      status: "matched",
    });
    const onProgress = vi.fn();
    await expect(api.identifyChecks({ checksums: { sha1: "ABCD" }, size: 123 }, { onProgress })).resolves.toEqual({
      candidates: [
        {
          checksumVariants: [{ algorithm: "md5", value: "abcd" }],
          checksums: { md5: "abcd" },
          matches: [{ name: "Game" }],
          path: "/work/game.gba",
          status: "matched",
        },
      ],
      input: "/work/game.gba",
      status: "matched",
    });
    expect(onProgress).toHaveBeenCalledWith({ message: "Loading identification data for 2 systems…" });
    expect(mocks.runtime.workerIo.stageSources).toHaveBeenCalledWith([
      expect.objectContaining({ fallbackFileName: "gba.pack", pathPrefix: "identify-pack-1" }),
      expect.objectContaining({ fallbackFileName: "nes.pack", pathPrefix: "identify-pack-2" }),
    ]);
    expect(mocks.identifyHashWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        databasePaths: ["/work/identify-1.pack", "/work/identify-2.pack"],
        size: 123,
      }),
      onProgress,
    );
    expect(staged[0]?.cleanup).toHaveBeenCalledTimes(1);
    expect(staged[1]?.cleanup).toHaveBeenCalledTimes(1);

    await expect(api.identifyChecks({ checksums: { hash: " " } })).rejects.toThrow(
      "Identify needs at least one checksum",
    );
  });

  it("rejects hash identification when its worker IO is missing", async () => {
    const workerIo = mocks.runtime.workerIo;
    mocks.runtime.workerIo = undefined;
    await expect(api.identifyChecks({ checksums: { hash: "abcd" } })).rejects.toThrow(
      "The rom-weaver identify runtime is unavailable",
    );
    mocks.runtime.workerIo = workerIo;
  });
});

describe("browser runtime helpers", () => {
  it("preserves content-detected DVD metadata for shared CHD auto mode", async () => {
    const vfs = { normalizePath: (path: string) => path, getFile: vi.fn() };
    const raw = { path: "/out/restored.bin", fileName: "restored.bin", size: 2048, vfs, dispose: vi.fn() };
    const compressed = { ...raw, path: "/out/restored.chd", fileName: "restored.chd", dispose: vi.fn() };
    mocks.runtime.workerIo.stageSources.mockResolvedValue([
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/input/game.bin" },
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/input/undo.ppf" },
    ]);
    mocks.invokeRomWeaverPpfUndoWorker.mockResolvedValue({
      filePath: raw.path,
      files: [{ path: raw.path, fileName: raw.fileName }],
    });
    mocks.runtime.workerIo.createWorkerOutput.mockResolvedValue(raw);
    mocks.runtime.compression.create.mockResolvedValue({ output: compressed });
    mocks.runtime.output.createSource.mockResolvedValue(compressed);
    await api.undoPpf({
      rom: blob("game.bin"),
      patch: blob("undo.ppf"),
      outputName: "restored.bin",
      compression: "chd",
      metadata: { format: "DVD", recommendedFormat: "chd" },
    });
    expect(mocks.runtime.compression.create).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "chd",
        source: expect.objectContaining({ path: raw.path, vfs }),
        romSpecific: { chd: expect.objectContaining({ mode: "dvd" }) },
      }),
    );
    expect(vfs.getFile).not.toHaveBeenCalled();
  });

  it("forwards RVZ controls through the shared output builder without reading the restored file into memory", async () => {
    const vfs = { normalizePath: (path: string) => path, getFile: vi.fn() };
    const raw = { path: "/out/restored.iso", fileName: "restored.iso", size: 1024, vfs, dispose: vi.fn() };
    const compressed = { ...raw, path: "/out/restored.rvz", fileName: "restored.rvz", dispose: vi.fn() };
    mocks.runtime.workerIo.stageSources.mockResolvedValue([
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/input/game.iso" },
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/input/undo.ppf" },
    ]);
    mocks.invokeRomWeaverPpfUndoWorker.mockResolvedValue({
      filePath: raw.path,
      files: [{ path: raw.path, fileName: raw.fileName }],
    });
    mocks.runtime.workerIo.createWorkerOutput.mockResolvedValue(raw);
    mocks.runtime.compression.create.mockResolvedValue({ output: compressed });
    mocks.runtime.output.createSource.mockResolvedValue(compressed);
    await api.undoPpf({
      rom: blob("game.iso"),
      patch: blob("undo.ppf"),
      outputName: "restored.iso",
      compression: "rvz",
      settings: {
        output: { container: { rvzBlockSize: "131072", rvzScrub: true, rvzCodec: "zstd", rvzCompressionLevel: "7" } },
      },
    });
    expect(mocks.runtime.compression.create).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "rvz",
        source: expect.objectContaining({ path: raw.path, vfs }),
        romSpecific: {
          rvz: expect.objectContaining({ blockSize: "131072", scrub: true, codec: "zstd", compressionLevel: 7 }),
        },
      }),
    );
    expect(vfs.getFile).not.toHaveBeenCalled();
    expect(raw.dispose).toHaveBeenCalledOnce();
  });

  it("compresses restored OPFS outputs with shared archive settings and packages raw disc companions", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const inputs = [
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/work/rom.bin" },
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/work/undo.ppf" },
    ];
    mocks.runtime.workerIo.stageSources.mockResolvedValue(inputs);
    const files = [{ fileName: "restored.bin", path: "/out/restored.bin" }];
    mocks.invokeRomWeaverPpfUndoWorker.mockResolvedValue({ filePath: files[0].path, files, cleanup });
    const archive = { fileName: "restored.zip", dispose: vi.fn() };
    mocks.runtime.compression.create.mockResolvedValue({ output: archive });
    await expect(
      api.undoPpf({
        rom: blob("rom.bin"),
        patch: blob("undo.ppf"),
        outputName: "restored.bin",
        compression: "zip",
        settings: { workers: { threads: 2 }, output: { container: { profile: "high", zipCodec: "store" } } },
      }),
    ).resolves.toBe(archive);
    expect(mocks.runtime.compression.create).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [expect.objectContaining({ filename: "restored.bin", filePath: "/out/restored.bin" })],
        format: "zip",
        options: expect.objectContaining({ zipCodec: "store", compressionProfile: "high", threads: 2 }),
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(mocks.runtime.workerIo.createWorkerOutput).not.toHaveBeenCalled();
    const discFiles = [
      { fileName: "disc.cue", path: "/out/disc.cue" },
      { fileName: "track.bin", path: "/out/track.bin" },
    ];
    mocks.invokeRomWeaverPpfUndoWorker.mockResolvedValue({ filePath: discFiles[0].path, files: discFiles, cleanup });
    await api.undoPpf({ rom: blob("disc.cue"), patch: blob("undo.ppf"), outputName: "disc-restored.cue" });
    expect(mocks.runtime.compression.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entries: discFiles.map((file) => expect.objectContaining({ filename: file.fileName, filePath: file.path })),
        format: "zip",
        options: expect.objectContaining({ zipCodec: "store", outputName: "disc-restored.zip" }),
      }),
    );
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("cleans restored and staged inputs when archive compression fails", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const sourceCleanup = vi.fn().mockResolvedValue(undefined);
    mocks.runtime.workerIo.stageSources.mockResolvedValue([
      { cleanup: sourceCleanup, filePath: "/work/rom.bin" },
      { cleanup: sourceCleanup, filePath: "/work/undo.ppf" },
    ]);
    mocks.invokeRomWeaverPpfUndoWorker.mockResolvedValue({
      files: [{ fileName: "restored.bin", path: "/out/restored.bin" }],
      cleanup,
    });
    mocks.runtime.compression.create.mockRejectedValueOnce(new Error("Unsupported codec"));
    await expect(
      api.undoPpf({ rom: blob("rom.bin"), patch: blob("undo.ppf"), outputName: "restored.bin", compression: "zip" }),
    ).rejects.toThrow("Unsupported codec");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(sourceCleanup).toHaveBeenCalledTimes(2);
  });

  it("constructs each browser workflow controller and applies its asset base", async () => {
    expect(new api.CreateWorkflow({ assetBaseUrl: "/assets" })).toBeInstanceOf(api.CreateWorkflow);
    expect(new api.ApplyWorkflow({ assetBaseUrl: "/assets" })).toBeInstanceOf(api.ApplyWorkflow);
    expect(new api.TrimWorkflow({ assetBaseUrl: "/assets" })).toBeInstanceOf(api.TrimWorkflow);
    expect(mocks.configureBrowserAssetBaseUrl).toHaveBeenCalledTimes(3);
    expect(mocks.configureBrowserAssetBaseUrl).toHaveBeenLastCalledWith("/assets");
  });

  it("reads output blobs and deduplicates runtime preloads by thread count", async () => {
    mocks.runtime.publicOutput.getBlob.mockResolvedValueOnce(new Blob(["output"]));
    await expect(api.getIngestOutputBlob({ path: "/work/out.bin" } as never)).resolves.toBeInstanceOf(Blob);
    const publicOutput = mocks.runtime.publicOutput;
    mocks.runtime.publicOutput = undefined;
    await expect(api.getIngestOutputBlob({ path: "/work/out.bin" } as never)).rejects.toThrow(
      "The rom-weaver output adapter is unavailable",
    );
    mocks.runtime.publicOutput = publicOutput;

    await api.preloadBrowserRuntime({ threads: 3 });
    await api.preloadBrowserRuntime({ threads: 3 });
    expect(mocks.runtime.preload.preloadCapability).toHaveBeenCalledTimes(1);
    expect(mocks.runtime.preload.preloadCapability).toHaveBeenCalledWith("compression", expect.any(Function), {
      threads: 3,
    });
    expect(mocks.scheduleBrowserRuntimeWarmupExtraction).toHaveBeenCalledTimes(1);

    mocks.runtime.preload.preloadCapability.mockRejectedValueOnce(new Error("warmup failed"));
    await api.preloadBrowserRuntime({ threads: 4 });
    await api.preloadBrowserRuntime({ threads: 4 });
    expect(mocks.runtime.preload.preloadCapability).toHaveBeenCalledTimes(3);

    const preload = mocks.runtime.preload;
    mocks.runtime.preload = { preloadCapability: undefined };
    await expect(api.preloadBrowserRuntime({ threads: 5 })).resolves.toBeUndefined();
    mocks.runtime.preload = preload;
  });

  it("selects patch candidates, undoes PPF patches, and cleans staged sources", async () => {
    const candidates = { formats: [{ format: "xdelta", reason: "best" }] };
    mocks.runtime.patch.createPatchCandidates.mockResolvedValueOnce(candidates);
    await expect(
      api.getCreatePatchFormatCandidates({
        assetBaseUrl: "https://cdn.test/",
        modified: blob("modified.gba"),
        original: blob("original.gba"),
        settings: { logging: { level: "debug", sink: vi.fn() }, workers: { threads: 2 } },
      }),
    ).resolves.toBe(candidates);
    expect(mocks.configureBrowserAssetBaseUrl).toHaveBeenCalledWith("https://cdn.test/");
    expect(mocks.runtime.patch.createPatchCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ logLevel: "debug", threads: 2 }),
    );
    await expect(
      api.getCreatePatchFormatCandidates({ modified: new Uint8Array([1]) as never, original: blob("original.gba") }),
    ).rejects.toThrow("Raw byte sources are not public browser inputs");
    mocks.runtime.patch.createPatchCandidates.mockResolvedValueOnce(undefined);
    await expect(
      api.getCreatePatchFormatCandidates({ modified: blob("modified.gba"), original: blob("original.gba") }),
    ).rejects.toThrow("Create patch candidate selection is unavailable");

    const staged = [
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/work/rom.bin" },
      { cleanup: vi.fn().mockResolvedValue(undefined), filePath: "/work/undo.ppf" },
    ];
    mocks.runtime.workerIo.stageSources.mockResolvedValueOnce(staged);
    mocks.invokeRomWeaverPpfUndoWorker.mockResolvedValueOnce({
      filePath: "/work/restored.bin",
      files: [{ fileName: "restored.bin", path: "/work/restored.bin" }],
    });
    const output = { file: "restored.gba" };
    mocks.runtime.workerIo.createWorkerOutput.mockReturnValueOnce(output);
    await expect(
      api.undoPpf({
        logLevel: "info",
        outputName: "restored.gba",
        patch: blob("undo.ppf"),
        rom: blob("game.gba"),
      }),
    ).resolves.toBe(output);
    expect(mocks.invokeRomWeaverPpfUndoWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        outputName: "restored.gba",
        patchFilePath: "/work/undo.ppf",
        romFilePath: "/work/rom.bin",
      }),
    );
    expect(staged[0]?.cleanup).toHaveBeenCalledTimes(1);
    expect(staged[1]?.cleanup).toHaveBeenCalledTimes(1);
    mocks.runtime.workerIo.stageSources.mockResolvedValueOnce([]);
    await expect(api.undoPpf({ outputName: "x.gba", patch: blob("x.ppf"), rom: blob("x.gba") })).rejects.toThrow(
      "PPF undo inputs could not be staged",
    );
  });
});
