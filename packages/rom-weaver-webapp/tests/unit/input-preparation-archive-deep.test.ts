import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildPatchArchiveLeaves: vi.fn(),
  createPatchFileFromPublicOutput: vi.fn(),
  resolvePatchArchiveLeaf: vi.fn(),
}));

vi.mock("../../src/lib/input/input-archive-patch-leaves.ts", () => ({
  buildPatchArchiveLeaves: mocks.buildPatchArchiveLeaves,
  getPatchLeafFileForSelection: vi.fn(),
  getPatchLeafParentCompressionsForSelection: vi.fn(),
  resolvePatchArchiveLeaf: mocks.resolvePatchArchiveLeaf,
}));
vi.mock("../../src/lib/runtime/public-output-bin-file.ts", () => ({
  createPatchFileFromPublicOutput: mocks.createPatchFileFromPublicOutput,
}));

import {
  attachBareRomIngestMetadata,
  describeArchiveFileForTrace,
  getCompressionFormat,
  getCompressionRuntimeSource,
  isCompressionFile,
  resolveArchiveInput,
  resolveArchiveInputAssets,
  traceArchivePreparation,
} from "../../src/lib/input/input-preparation-archive.ts";

const archive = (fileName: string, size = 20) => ({
  _sourceRef: { fileName, size, source: `/work/${fileName}` },
  _u8array: new Uint8Array(size),
  fileName,
  fileSize: size,
});
const output = (fileName: string, size = 8) => ({
  fileName,
  path: `/vfs/${fileName}`,
  size,
  timing: { elapsedMs: 3.2 },
});

const runtime = {
  name: "browser",
  workerIo: {},
  compression: {
    extract: vi.fn(),
    probe: vi.fn(),
  },
  ingest: { run: vi.fn() },
};

beforeEach(() => {
  mocks.buildPatchArchiveLeaves.mockReset();
  mocks.createPatchFileFromPublicOutput.mockReset();
  mocks.resolvePatchArchiveLeaf.mockReset();
  runtime.compression.extract.mockReset();
  runtime.compression.probe.mockReset();
  runtime.ingest.run.mockReset();
  mocks.resolvePatchArchiveLeaf.mockResolvedValue(undefined);
});

describe("archive source primitives", () => {
  it("describes files and resolves compression-backed source metadata", () => {
    const file = archive("nested.zip", 12);
    expect(describeArchiveFileForTrace(file as never)).toMatchObject({
      fileName: "nested.zip",
      fileSize: 12,
      filePath: "",
      isLazyExternal: false,
      romSpecificOutput: false,
    });
    expect(getCompressionFormat(file as never)).toBe("zip");
    expect(isCompressionFile(file as never)).toBe(true);
    expect(getCompressionRuntimeSource(file as never)).toEqual({
      fileName: "nested.zip",
      size: 12,
      source: "/work/nested.zip",
    });
    expect(isCompressionFile(archive("game.sfc") as never)).toBe(false);
    expect(() => getCompressionFormat(archive("game.sfc") as never)).toThrow("game.sfc is not a compression input");
  });

  it("traces only at trace level and returns no payload for disabled or raw inputs", async () => {
    const onLog = vi.fn();
    traceArchivePreparation({ logging: { level: "debug" } } as never, "ignored", { value: 1 });
    traceArchivePreparation({ logging: { level: "trace" }, onLog } as never, "listed", { value: 1 });
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: "listed", details: { operation: "input-archive", value: 1 } }),
    );

    const file = archive("game.zip");
    await expect(
      resolveArchiveInput(
        file as never,
        "rom",
        { input: { containerInputsEnabled: false } } as never,
        runtime as never,
      ),
    ).resolves.toBe(file);
    await expect(
      resolveArchiveInput(archive("game.sfc") as never, "rom", undefined, runtime as never),
    ).resolves.toMatchObject({ fileName: "game.sfc" });
    await expect(
      resolveArchiveInputAssets(
        file as never,
        { input: { containerInputsEnabled: false } } as never,
        2,
        runtime as never,
      ),
    ).resolves.toEqual([]);
    await expect(
      resolveArchiveInputAssets(archive("game.sfc") as never, undefined, 2, runtime as never),
    ).resolves.toEqual([]);
  });
});

describe("resolveArchiveInput", () => {
  it("extracts a selected leaf and retains its lazy output path", async () => {
    const extracted = { fileName: "payload.sfc", fileSize: 8 };
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(extracted);
    runtime.compression.extract.mockResolvedValue({ output: output("payload.sfc"), outputs: [output("payload.sfc")] });
    const progress = vi.fn();
    const result = await resolveArchiveInput(
      archive("bundle.zip") as never,
      "rom",
      { input: { containerInputsEnabled: true }, onProgress: progress } as never,
      runtime as never,
      "payload.sfc",
      3,
    );
    expect(runtime.compression.extract).toHaveBeenCalledWith(
      expect.objectContaining({
        descendSinglePayload: true,
        entries: ["payload.sfc"],
        format: "zip",
        source: expect.objectContaining({ fileName: "bundle.zip" }),
        options: expect.objectContaining({ romFilter: true }),
      }),
    );
    expect(mocks.createPatchFileFromPublicOutput).toHaveBeenCalledWith(expect.anything(), "payload.sfc", {
      materializeBlob: false,
      preferExternalFilePath: true,
    });
    expect(result).toMatchObject({ fileName: "payload.sfc", _extractTimeMs: 3.2 });
  });

  it("uses the patch leaf resolver first and reports missing extraction outputs", async () => {
    const leaf = { fileName: "selected.ips", fileSize: 4 };
    mocks.resolvePatchArchiveLeaf.mockResolvedValue(leaf);
    await expect(
      resolveArchiveInput(archive("patches.zip") as never, "patch", undefined, runtime as never),
    ).resolves.toBe(leaf);
    expect(runtime.compression.extract).not.toHaveBeenCalled();

    mocks.resolvePatchArchiveLeaf.mockResolvedValue(undefined);
    runtime.compression.extract.mockResolvedValue({ outputs: [] });
    await expect(
      resolveArchiveInput(archive("empty.zip") as never, "patch", undefined, runtime as never),
    ).rejects.toThrow("empty.zip produced no extractable patch");
  });
});

describe("resolveArchiveInputAssets", () => {
  it("creates ROM assets, carries ingest metadata, and records descent metrics", async () => {
    const sourceFile = archive("game.zip", 40);
    const romOutput = output("game.sfc", 16);
    mocks.createPatchFileFromPublicOutput.mockResolvedValue({ fileName: "game.sfc", fileSize: 16 });
    runtime.ingest.run.mockImplementation(async ({ onProgress }) => {
      onProgress?.({
        details: {
          extract_step: {
            status: "succeeded",
            source_name: "game.zip",
            source: "/work/game.zip",
            out_dir: "/work",
            depth: 0,
            format: "zip",
            outputs: [{ size_bytes: 16 }],
            extract_time_ms: 7,
          },
        },
      });
      return {
        result: { assets: [{ discFormat: "dvd", platform: "snes", recommendedFormat: "sfc" }], patches: [] },
        outputs: [romOutput],
        patchOutputs: [],
      };
    });
    const onProgress = vi.fn();
    const assets = await resolveArchiveInputAssets(sourceFile as never, { onProgress } as never, 1, runtime as never);
    expect(runtime.ingest.run).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "game.zip",
        identify: true,
        source: expect.objectContaining({ source: "/work/game.zip" }),
      }),
    );
    expect(onProgress).toHaveBeenCalled();
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      fileName: "game.sfc",
      kind: "rom",
      patchable: true,
      size: 16,
      preparation: { sourceSize: 40, wasDecompressed: true, parentCompressions: expect.any(Array) },
    });
  });

  it("groups cue and track outputs and reports CHD mode", async () => {
    const cueText = 'FILE "disc.bin" BINARY\nTRACK 01 MODE1/2352\nFILE "audio.bin" BINARY\nTRACK 02 AUDIO\n';
    mocks.createPatchFileFromPublicOutput.mockImplementation(async (file: { fileName: string }) =>
      file.fileName.endsWith(".cue")
        ? { _u8array: new TextEncoder().encode(cueText), fileName: file.fileName, fileSize: cueText.length }
        : { fileName: file.fileName, fileSize: 100 },
    );
    runtime.ingest.run.mockResolvedValue({
      result: { assets: [{ discFormat: "cd" }, { discFormat: "cd" }], patches: [] },
      outputs: [output("disc.cue", 90), output("disc.bin", 100)],
      patchOutputs: [],
    });
    const onProgress = vi.fn();
    const assets = await resolveArchiveInputAssets(
      archive("disc.chd") as never,
      { onProgress } as never,
      0,
      runtime as never,
    );
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      kind: "track",
      groupId: expect.stringContaining("-group"),
      patchable: true,
      size: 100,
    });
    expect(assets[1]).toMatchObject({
      kind: "cue",
      patchable: false,
      groupId: assets[0]?.groupId,
      fileName: "disc.cue",
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Extracting disc.chd...", details: { chdMode: "cd" } }),
    );
  });

  it("attaches extracted sidecar patches and reclassifies patch-only bundles", async () => {
    const sidecar = { file: { fileName: "game.ips", fileSize: 4 }, parentCompressions: [], sidecarOrder: 1 };
    mocks.buildPatchArchiveLeaves.mockResolvedValue([sidecar]);
    runtime.ingest.run.mockResolvedValue({
      result: { assets: [{ discFormat: "dvd" }], patches: [{ file_name: "game.ips" }] },
      outputs: [output("game.sfc")],
      patchOutputs: [output("game.ips")],
    });
    mocks.createPatchFileFromPublicOutput.mockResolvedValue({ fileName: "game.sfc", fileSize: 8 });
    const assets = await resolveArchiveInputAssets(archive("mixed.zip") as never, undefined, 0, runtime as never);
    expect(mocks.buildPatchArchiveLeaves).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      0,
    );
    expect(assets[0]?.sidecarPatches).toEqual([{ file: sidecar.file, parentCompressions: [], sidecarOrder: 1 }]);

    runtime.ingest.run.mockResolvedValue({
      result: { assets: [], patches: [{ file_name: "only.ips" }] },
      outputs: [],
      patchOutputs: [output("only.ips")],
    });
    await expect(
      resolveArchiveInputAssets(archive("only-patches.zip") as never, undefined, 0, runtime as never),
    ).rejects.toThrow("only-patches.zip is a patch-only bundle");
    expect(runtime.ingest.run).toHaveBeenCalled();
  });
});

describe("attachBareRomIngestMetadata", () => {
  it("copies checksums, variants, identification, type, and Rust timing", async () => {
    const file = archive("game.sfc", 8) as Record<string, unknown>;
    const identification = { matches: [{ name: "Demo" }] };
    runtime.ingest.run.mockResolvedValue({
      result: {
        isRom: true,
        assets: [
          {
            checksums: { crc32: "a1b2c3d4" },
            checksumVariants: [{ crc32: "deadbeef" }],
            identification,
            platform: "snes",
            recommendedFormat: "sfc",
            checksumMs: 13,
          },
        ],
      },
    });
    await attachBareRomIngestMetadata(
      file as never,
      { input: { containerInputsEnabled: true } } as never,
      runtime as never,
    );
    expect(file).toMatchObject({
      checksums: { crc32: "a1b2c3d4" },
      checksumVariants: [{ crc32: "deadbeef" }],
      identification,
      _precomputedChecksumMs: 13,
      romType: expect.objectContaining({ recommendedFormat: "sfc" }),
    });
  });

  it("is best effort for non-ROM, unavailable, failed, and already computed inputs", async () => {
    const existing = archive("existing.sfc") as Record<string, unknown>;
    existing.checksums = { crc32: "existing" };
    await attachBareRomIngestMetadata(existing as never, undefined, runtime as never);
    expect(runtime.ingest.run).not.toHaveBeenCalled();

    runtime.ingest.run.mockResolvedValueOnce({ result: { isRom: false, assets: [] } });
    const nonRom = archive("text.bin") as Record<string, unknown>;
    await attachBareRomIngestMetadata(nonRom as never, undefined, runtime as never);
    expect(nonRom.checksums).toBeUndefined();

    runtime.ingest.run.mockRejectedValueOnce(new Error("hash failed"));
    const failed = archive("failed.sfc") as Record<string, unknown>;
    await expect(attachBareRomIngestMetadata(failed as never, undefined, runtime as never)).resolves.toBeUndefined();
    expect(failed.checksums).toBeUndefined();
  });
});
