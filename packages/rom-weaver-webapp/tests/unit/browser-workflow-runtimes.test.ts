import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  archiveCreate: vi.fn(),
  extract: vi.fn(),
  ingest: vi.fn(),
  probe: vi.fn(),
  compressionCreate: vi.fn(),
  staged: [] as Array<{
    cleanup: ReturnType<typeof vi.fn>;
    fileName: string;
    filePath: string;
    size?: number;
    virtual?: boolean;
  }>,
  virtualSources: new Map<string, unknown>(),
  updatedVirtual: [] as Array<{ path: string; source: unknown }>,
  removed: [] as string[],
  fallbackAvailable: true,
}));

vi.mock("../../src/lib/compression/container-format-registry.ts", () => ({
  isRomSpecificCompressionFormat: (format: string) => ["chd", "rvz", "z3ds"].includes(format),
  getRomSpecificExtractedFileName: (format: string, input: { fileName?: string }) =>
    `${String(input.fileName || "input").replace(/\.[^.]+$/u, "")}.${format === "chd" ? "bin" : "iso"}`,
  ROM_SPECIFIC_COMPRESSION_FORMAT_REGISTRY: {
    chd: {
      pathPrefix: { create: "chd-create", extract: "chd-extract", sidecar: "chd-sidecar" },
      scope: "chd",
      fallbackFileName: "input.chd",
    },
    rvz: { pathPrefix: { create: "rvz-create", extract: "rvz-extract" }, scope: "rvz", fallbackFileName: "input.rvz" },
    z3ds: {
      pathPrefix: { create: "z3ds-create", extract: "z3ds-extract" },
      scope: "z3ds",
      fallbackFileName: "input.z3ds",
    },
  },
}));
vi.mock("../../src/lib/input/rom-specific-file-utils.ts", () => ({
  replaceCuePatchFileName: (contents: string, target: string) => contents.replace("track.bin", target),
}));
vi.mock("../../src/lib/path-utils.ts", () => ({
  getPathBaseName: (path: string, fallback = "") =>
    String(path || fallback)
      .split(/[\\/]/u)
      .pop() || fallback,
}));
vi.mock("../../src/lib/runtime/run-output-paths.ts", () => ({
  createRomWeaverOutputScope: vi.fn(() => ({
    cleanup: vi.fn(async () => undefined),
    createOutputCleanups: vi.fn(async (paths) => paths.map(() => vi.fn(async () => undefined))),
    rootPath: "/work/output-scope",
    selectOutputPath: vi.fn((_dir: string, name: string) => `/work/output-scope/${name}`),
  })),
}));
vi.mock("../../src/lib/runtime/run-result-parsing.ts", () => ({
  romTypeFromEmittedFile: (entry: unknown) => (entry as { platform?: string })?.platform,
}));
vi.mock("../../src/lib/runtime/wasm-command-runtime.ts", () => ({
  invokeRomWeaverCompressionCreateWorker: state.compressionCreate,
  invokeRomWeaverExtractWorker: state.extract,
  invokeRomWeaverIngestWorker: state.ingest,
  runRomWeaverProbeWorker: state.probe,
  normalizeCodecEntries: (value: unknown) => (Array.isArray(value) ? value : value ? [value] : []),
}));
vi.mock("../../src/lib/runtime/workflow-runtime-worker-helpers.ts", () => ({
  attachRomSpecificOutputMetadata: (output: Record<string, unknown>, metadata: Record<string, unknown>) =>
    Object.assign(output, metadata),
  createCompressionExtractResult: (outputs: unknown[]) => ({ outputs }),
  normalizeCompressionWorkerEntries: (entries: unknown[]) => entries,
}));
vi.mock("../../src/storage/browser/browser-output-storage-guard.ts", () => ({
  ensureBrowserStorageAvailableForOutput: vi.fn(async () => undefined),
  withBrowserOutputStorageFailureContext: async (error: unknown) => error,
}));
vi.mock("../../src/workers/protocol/browser-virtual-files.ts", () => ({
  getBrowserVirtualFileSource: (path: string) => state.virtualSources.get(path),
  updateBrowserVirtualFileSource: (path: string, source: unknown) => state.updatedVirtual.push({ path, source }),
}));
vi.mock("../../src/workers/protocol/cue-file-utils.ts", () => ({
  parseCueFile: () => ({ files: [{ name: "track.bin" }] }),
}));
vi.mock("../../src/platform/browser/workflow-runtime-helpers.ts", () => ({
  EXTRACT_CHECKSUM_ALGORITHMS: ["crc32", "md5"],
  emitBrowserWorkflowTrace: vi.fn(),
  findExtractedFile: (entries: Array<{ fileName?: string; path?: string }>, wanted: string) =>
    entries.find(
      (entry) => (entry.fileName || entry.path || "") === wanted || (entry.path || "").endsWith(`/${wanted}`),
    ) ?? null,
  getFileStem: (value: string) => value.replace(/\.[^.]+$/u, ""),
  getPathDerivedFileName: (_path: string, name: string) => `staged-${name}`,
  getPathDirectory: (path: string) => String(path).split("/").slice(0, -1).join("/") || "/",
  getPathBaseName: (path: string, fallback = "") =>
    String(path || fallback)
      .split("/")
      .pop() || fallback,
  isCueEntryName: (name: string) => /\.cue$/iu.test(name),
  joinPath: (...parts: string[]) => parts.join("/").replace(/\/+/gu, "/"),
  normalizeEntryPath: (path: string) => path.replace(/\\/gu, "/"),
  normalizeRomSpecificEntryNameForSource: (entry: string, _staged: string, source: string) =>
    entry.replace(/^staged-/u, "").replace(/^[^.]+/u, source.replace(/\.[^.]+$/u, "")),
  replaceProgressSourceLabel: (progress: unknown) => progress,
  toLevelProfile: (level: unknown) => level,
  uniqueNonEmptyStrings: (values: string[]) => [...new Set(values.filter(Boolean))],
  withCodecLevel: (codec: unknown, level: unknown) =>
    level === undefined ? codec : `${String(codec || "")}:${String(level)}`,
}));
vi.mock("../../src/platform/browser/workflow-runtime-vfs-cleanup.ts", () => ({
  browserVfs: {
    remove: vi.fn(async (path: string) => {
      state.removed.push(path);
    }),
    stat: vi.fn(async () => (state.fallbackAvailable ? { size: 33 } : null)),
  },
  filterOutputCandidatesAwayFromSource: (paths: string[], source: string) => paths.filter((path) => path !== source),
  getBrowserExtractOutputPathCandidates: (_root: string, name: string) => [
    `/work/output-scope/${name}`,
    `/work/fallback/${name}`,
  ],
  readTextFromBrowserVfs: vi.fn(async () => 'FILE "track.bin" BINARY'),
  selectPreferredExtractedFile: vi.fn(async ({ emittedFiles }: { emittedFiles: unknown[] }) => emittedFiles[0]),
  sumBrowserVfsPathBytes: vi.fn(async (paths: string[]) => paths.length * 10),
  waitForBrowserVfsPath: vi.fn(async () => true),
  writeTextToBrowserVfs: vi.fn(async () => undefined),
}));

const { createBrowserArchiveRuntime } = await import("../../src/platform/browser/workflow-runtime-archive.ts");
const { createBrowserChdRuntime, stripPrimaryChdTrackSuffix } =
  await import("../../src/platform/browser/workflow-runtime-chd.ts");
const { createBrowserDiscFormatsRuntime } = await import("../../src/platform/browser/workflow-runtime-disc-formats.ts");

function makeIo() {
  return {
    createWorkerOutput: vi.fn(async (result: Record<string, unknown>, fallback: string) => ({
      dispose: vi.fn(async () => {
        if (typeof result.cleanup === "function") await result.cleanup();
      }),
      fileName: result.fileName || fallback,
      path: result.filePath || "/work/output.bin",
      size: result.size || 0,
    })),
    runPathWorkerToOutput: vi.fn(async (request: { run: (source: unknown) => Promise<unknown> }) => {
      const staged = { filePath: "/work/input.bin", fileName: "input.bin" };
      const result = await request.run(staged);
      return { fileName: (result as { fileName?: string })?.fileName || "output.bin", path: "/work/output.bin" };
    }),
    stageSource: vi.fn(async (request: { source: unknown; fallbackFileName: string }) => {
      const staged = state.staged.shift() || {
        cleanup: vi.fn(async () => undefined),
        fileName: request.fallbackFileName,
        filePath: `/work/${request.fallbackFileName}`,
        size: 10,
      };
      return staged;
    }),
    stageSources: vi.fn(async (requests: Array<{ fallbackFileName: string }>) =>
      requests.map(
        (request) =>
          state.staged.shift() || {
            cleanup: vi.fn(async () => undefined),
            fileName: request.fallbackFileName,
            filePath: `/work/${request.fallbackFileName}`,
            size: 10,
          },
      ),
    ),
  };
}

let io: ReturnType<typeof makeIo>;

beforeEach(() => {
  vi.clearAllMocks();
  state.staged.length = 0;
  state.virtualSources.clear();
  state.updatedVirtual.length = 0;
  state.removed.length = 0;
  state.fallbackAvailable = true;
  io = makeIo();
  state.compressionCreate.mockResolvedValue({ fileName: "output.bin", filePath: "/work/output.bin", size: 30 });
  state.extract.mockResolvedValue({ fileName: "game.bin", filePath: "/work/game.bin", sizeBytes: 20 });
  state.probe.mockResolvedValue({ entries: [{ filename: "game.bin" }] });
});

describe("browser archive runtime", () => {
  it("stages archive entries and creates a zip with codec and size metadata", async () => {
    const runtime = createBrowserArchiveRuntime(io as never);
    const result = await runtime.create?.({
      entries: [
        { fileName: "a.bin", text: "hello" },
        { fileName: "b.bin", u8array: new Uint8Array([1]) },
      ],
      format: "zip",
      options: { compression: "7z", zipCodec: "deflate", zipLevel: 6, outputName: "files.zip", threads: 2 },
    } as never);
    expect(result?.output.fileName).toBe("output.bin");
    expect(state.compressionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        codecs: "deflate:6",
        format: "zip",
        inputPaths: expect.any(Array),
        outputFileName: "files.zip",
        totalBytes: 20,
      }),
      expect.any(Function),
      undefined,
    );
    expect(io.stageSources).not.toHaveBeenCalled();
    expect(io.stageSource).toHaveBeenCalledTimes(2);
  });

  it("extracts one selected entry directly and rejects ambiguous selections", async () => {
    const runtime = createBrowserArchiveRuntime(io as never);
    state.staged.push({
      cleanup: vi.fn(async () => undefined),
      fileName: "bundle.epub",
      filePath: "/work/bundle.epub",
    });
    const result = await runtime.extract?.({
      source: { name: "bundle.epub" },
      entries: ["game.bin"],
      options: { directExtract: true },
    } as never);
    expect(result?.outputs[0]).toMatchObject({ fileName: "game.bin", path: "/work/game.bin" });
    expect(state.extract).toHaveBeenCalledWith(
      expect.objectContaining({ noIgnore: true, noNestedExtract: true, select: ["game.bin"] }),
      expect.any(Function),
      undefined,
    );

    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "bundle.zip", filePath: "/work/bundle.zip" });
    await expect(
      runtime.extract?.({ source: "bundle.zip", entries: ["a", "b"], options: { directExtract: true } } as never),
    ).rejects.toThrow("exactly one selected entry");
  });

  it("descends patch and ROM payloads, preserving disc metadata and track naming", async () => {
    const runtime = createBrowserArchiveRuntime(io as never);
    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "disc.chd", filePath: "/work/disc.chd" });
    state.ingest.mockResolvedValueOnce({
      assets: [],
      patches: [{ fileName: "patch.ips", leafPath: "/work/patch.ips", sizeBytes: 4 }],
    });
    const patchResult = await runtime.extract?.({
      source: "disc.chd",
      entries: ["patch.ips"],
      descendSinglePayload: true,
      format: "chd",
      options: { patchFilter: true },
    } as never);
    expect(patchResult?.outputs[0]).toMatchObject({ fileName: "patch.ips", path: "/work/patch.ips" });

    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "disc.chd", filePath: "/work/disc.chd" });
    state.probe.mockResolvedValueOnce({ entries: [{ filename: "disc.cue" }] });
    state.ingest.mockResolvedValueOnce({
      assets: [
        {
          checksums: {},
          checksumVariants: [],
          fileName: "disc (Track 1).bin",
          path: "/work/track1.bin",
          sizeBytes: 11,
          trackNumber: 1,
        },
        {
          checksums: { CRC32: "ab" },
          checksumVariants: [],
          cueText: "FILE",
          discGroupId: "disc",
          fileName: "disc.cue",
          gdiText: "",
          kind: "cue",
          path: "/work/disc.cue",
          sizeBytes: 5,
        },
        {
          checksums: { CRC32: "cd" },
          checksumVariants: [],
          fileName: "disc (Track 2).bin",
          path: "/work/track2.bin",
          sizeBytes: 12,
          trackNumber: 2,
        },
      ],
      patches: [],
    });
    const romResult = await runtime.extract?.({
      source: "disc.chd",
      entries: [],
      descendSinglePayload: true,
      format: "chd",
      options: { chdSplitBin: true },
    } as never);
    expect(romResult?.outputs).toHaveLength(3);
    expect(romResult?.outputs[0]).toMatchObject({ fileName: "disc.bin" });
    expect(io.createWorkerOutput).toHaveBeenCalledWith(
      expect.objectContaining({ cueText: "FILE", discGroupId: "disc" }),
      expect.any(String),
      expect.any(String),
    );
  });

  it("extracts and probes regular archive entries, including missing-output errors", async () => {
    const runtime = createBrowserArchiveRuntime(io as never);
    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "one.zip", filePath: "/work/one.zip" });
    state.ingest.mockResolvedValueOnce({
      assets: [{ checksums: { CRC32: "aa" }, fileName: "game.bin", path: "/work/game.bin", sizeBytes: 8 }],
      patches: [],
    });
    const result = await runtime.extract?.({ source: "one.zip", entries: ["game.bin"], options: {} } as never);
    expect(result?.outputs[0]).toMatchObject({ fileName: "game.bin", path: "/work/game.bin" });

    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "empty.zip", filePath: "/work/empty.zip" });
    state.ingest.mockResolvedValueOnce({ assets: [], patches: [] });
    state.fallbackAvailable = false;
    await expect(
      runtime.extract?.({ source: "empty.zip", entries: ["missing.bin"], options: {} } as never),
    ).rejects.toThrow("Archive entry was not extracted");

    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "one.zip", filePath: "/work/one.zip" });
    await expect(runtime.probe?.({ source: "one.zip", options: { romFilter: true } } as never)).resolves.toEqual({
      entries: [{ filename: "game.bin" }],
    });
  });
});

describe("browser CHD runtime", () => {
  it("rewrites a cue to a staged track and passes the selected CHD format", async () => {
    const runtime = createBrowserChdRuntime(io as never);
    const cue = { filePath: "/work/input.cue", fileName: "input.cue", cleanup: vi.fn(async () => undefined) };
    const track = { filePath: "/work/staged-track.bin", fileName: "track.bin", cleanup: vi.fn(async () => undefined) };
    state.staged.push(cue, track);
    state.virtualSources.set("/work/input.cue", new TextEncoder().encode('FILE "track.bin" BINARY'));
    const result = await runtime.createChd({
      source: "input.cue",
      fileName: "input.cue",
      imageFiles: [{ fileName: "track.bin", source: "track.bin" }],
      mode: "cd",
      outputName: "game.chd",
      compressionCodecs: ["lzma"],
    } as never);
    expect(result).toMatchObject({ fileName: "game.chd", path: "/work/output.bin" });
    expect(state.compressionCreate.mock.calls[0]?.[0]).toMatchObject({
      format: "chd-cd",
      inputPaths: ["/work/input.cue"],
      outputFileName: "game.chd",
    });
    expect(state.updatedVirtual).toHaveLength(1);
  });

  it("extracts cue and split data outputs, and strips the primary track suffix", async () => {
    const runtime = createBrowserChdRuntime(io as never);
    expect(stripPrimaryChdTrackSuffix("game (Track 01).bin")).toBe("game.bin");
    state.staged.push({
      cleanup: vi.fn(async () => undefined),
      fileName: "game.chd",
      filePath: "/work/game.chd",
      virtual: true,
    });
    state.ingest.mockResolvedValueOnce({
      assets: [
        { fileName: "game.cue", kind: "cue", path: "/work/game.cue", sizeBytes: 3 },
        { checksums: { CRC32: "aa" }, fileName: "game (Track 01).bin", path: "/work/game1.bin", sizeBytes: 10 },
        { checksums: { CRC32: "bb" }, fileName: "game (Track 02).bin", path: "/work/game2.bin", sizeBytes: 11 },
      ],
    });
    const result = await runtime.extractChd({
      source: "game.chd",
      fileName: "game.chd",
      mode: "cd",
      splitBin: true,
      outputName: "selected.bin",
    } as never);
    expect(result.outputs).toHaveLength(3);
    expect(result.outputs.map((output: { fileName: string }) => output.fileName)).toContain("selected.bin");
    expect(result.outputs[1]).toMatchObject({ chdCuePath: "/work/game.cue" });
  });

  it("cleans up and reports a CHD extraction with no output files", async () => {
    const runtime = createBrowserChdRuntime(io as never);
    const cleanup = vi.fn(async () => undefined);
    state.staged.push({ cleanup, fileName: "bad.chd", filePath: "/work/bad.chd" });
    state.ingest.mockResolvedValueOnce({ assets: [] });
    await expect(
      runtime.extractChd({ source: "bad.chd", fileName: "bad.chd", mode: "cd", splitBin: false } as never),
    ).rejects.toThrow("did not emit any output files");
    expect(cleanup).toHaveBeenCalled();
  });
});

describe("browser disc format runtimes", () => {
  it("creates RVZ and Z3DS outputs with format-specific defaults", async () => {
    const runtime = createBrowserDiscFormatsRuntime(io as never);
    await expect(
      runtime.createRvz({ source: "game.iso", fileName: "game.iso", compressionLevel: 5 } as never),
    ).resolves.toMatchObject({ path: "/work/output.bin" });
    await expect(
      runtime.createZ3ds({ source: "game.3ds", fileName: "game.3ds", compressionLevel: 2 } as never),
    ).resolves.toMatchObject({ path: "/work/output.bin" });
    expect(state.compressionCreate.mock.calls[0]?.[0]).toMatchObject({ format: "rvz" });
    expect(state.compressionCreate.mock.calls[1]?.[0]).toMatchObject({ format: "z3ds" });
  });

  it("extracts RVZ and Z3DS entries and fails fast on an unwritable RVZ path", async () => {
    const runtime = createBrowserDiscFormatsRuntime(io as never);
    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "game.rvz", filePath: "/work/game.rvz" });
    state.ingest.mockResolvedValueOnce({
      assets: [
        {
          checksums: { CRC32: "aa" },
          fileName: "game.iso",
          path: "/work/game.iso",
          sizeBytes: 20,
          platform: "GameCube",
        },
      ],
    });
    await expect(runtime.extractRvz({ source: "game.rvz", fileName: "game.rvz" } as never)).resolves.toMatchObject({
      fileName: "game.iso",
    });

    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "game.z3ds", filePath: "/work/game.z3ds" });
    state.ingest.mockResolvedValueOnce({ assets: [{ fileName: "game.cci", path: "/work/game.cci", sizeBytes: 4 }] });
    await expect(runtime.extractZ3ds({ source: "game.z3ds", fileName: "game.z3ds" } as never)).resolves.toMatchObject({
      fileName: "game.cci",
    });

    state.staged.push({ cleanup: vi.fn(async () => undefined), fileName: "gone.rvz", filePath: "/work/gone.rvz" });
    state.ingest.mockRejectedValueOnce(new Error("createWritable failed"));
    await expect(runtime.extractRvz({ source: "gone.rvz", fileName: "gone.rvz" } as never)).rejects.toThrow(
      "RVZ OPFS extraction is not writable",
    );
  });
});
