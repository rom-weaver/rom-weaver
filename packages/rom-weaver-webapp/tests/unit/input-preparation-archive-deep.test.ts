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
vi.mock("../../src/lib/input/input-preparation-compression.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/input/input-preparation-compression.ts")>()),
  resolveInputPreparationRuntime: async () => runtime,
}));
vi.mock("../../src/lib/runtime/public-output-bin-file.ts", () => ({
  createPatchFileFromPublicOutput: mocks.createPatchFileFromPublicOutput,
}));

import { shouldIdentifySource, skipSourceIdentification } from "../../src/lib/input/input-identification-policy.ts";
import {
  resolveUnclassifiedInputAssets,
  describeArchiveFileForTrace,
  getCompressionFormat,
  listDroppedArchiveEntryNames,
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

  it("uses a named blob or materialized bytes when no external path exists", () => {
    const blobFile = archive("blob.zip") as Record<string, unknown>;
    blobFile._file = new Blob(["archive"]);
    delete blobFile._sourceRef;
    const source = getCompressionRuntimeSource(blobFile as never);
    expect(source).toMatchObject({ fileName: "blob.zip", size: 20, source: expect.any(Blob) });

    const unnamed = archive("bytes.zip") as Record<string, unknown>;
    delete unnamed._sourceRef;
    const first = getCompressionRuntimeSource(unnamed as never);
    const second = getCompressionRuntimeSource(unnamed as never);
    expect(first.source).toBe(second.source);
    expect(first).toMatchObject({ fileName: "bytes.zip", size: 20, source: expect.any(Blob) });
  });
});

describe("resolveArchiveInput", () => {
  it("extracts a selected leaf and retains its lazy output path", async () => {
    const extracted = { fileName: "payload.sfc", fileSize: 8 };
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(extracted);
    runtime.compression.extract.mockResolvedValue({ output: output("payload.sfc"), outputs: [output("payload.sfc")] });
    const progress = vi.fn();
    const result = await resolveArchiveInput(
      archive("weave.zip") as never,
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
        source: expect.objectContaining({ fileName: "weave.zip" }),
        options: expect.objectContaining({ romFilter: true }),
      }),
    );
    expect(mocks.createPatchFileFromPublicOutput).toHaveBeenCalledWith(expect.anything(), "payload.sfc", {
      materializeBlob: false,
      preferExternalFilePath: true,
    });
    expect(result).toMatchObject({ fileName: "payload.sfc", _extractTimeMs: 3.2 });
  });

  it("keeps the skipped identification policy on an extracted leaf", async () => {
    const extracted = { fileName: "payload.sfc", fileSize: 8 };
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(extracted);
    runtime.compression.extract.mockResolvedValue({ output: output("payload.sfc"), outputs: [output("payload.sfc")] });
    const source = archive("weave.zip");
    skipSourceIdentification(source);
    const result = await resolveArchiveInput(
      source as never,
      "rom",
      { input: { containerInputsEnabled: true } } as never,
      runtime as never,
      "payload.sfc",
    );
    expect(shouldIdentifySource(result)).toBe(false);
  });

  it("uses the first output when the extractor omits its singular output field", async () => {
    const extracted = { fileName: "payload.bin", fileSize: 8 };
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(extracted);
    runtime.compression.extract.mockResolvedValue({ outputs: [output("payload.bin", 8)] });
    await expect(resolveArchiveInput(archive("weave.zip") as never, "rom", undefined, runtime as never)).resolves.toBe(
      extracted,
    );
    expect(extracted).toMatchObject({ fileName: "payload.bin", _extractTimeMs: 3.2 });
  });

  it("releases retained extraction ownership when materialization fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    mocks.createPatchFileFromPublicOutput.mockRejectedValue(new Error("cannot materialize"));
    const extractedOutput = { ...output("payload.bin"), dispose: cleanup };
    runtime.compression.extract.mockResolvedValue({
      output: extractedOutput,
      outputs: [extractedOutput],
    });
    await expect(
      resolveArchiveInput(archive("broken.zip") as never, "rom", undefined, runtime as never),
    ).rejects.toThrow("cannot materialize");
    expect(cleanup).toHaveBeenCalled();
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

  it("keeps the skipped identification policy on descent leaves", async () => {
    const sourceFile = archive("game.zip", 40);
    const leaf = { fileName: "game.sfc", fileSize: 16 };
    mocks.createPatchFileFromPublicOutput.mockResolvedValue(leaf);
    runtime.ingest.run.mockResolvedValue({
      result: { assets: [{ platform: "snes", recommendedFormat: "sfc" }], patches: [] },
      outputs: [output("game.sfc", 16)],
      patchOutputs: [],
    });
    skipSourceIdentification(sourceFile);
    await resolveArchiveInputAssets(sourceFile as never, {} as never, 1, runtime as never);
    expect(runtime.ingest.run).toHaveBeenCalledWith(expect.objectContaining({ identify: false }));
    expect(shouldIdentifySource(leaf)).toBe(false);
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

  it("attaches extracted sidecar patches and reclassifies patch-only weaves", async () => {
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
    ).rejects.toThrow("only-patches.zip is a patch-only weave");
    expect(runtime.ingest.run).toHaveBeenCalled();
  });
});

describe("resolveUnclassifiedInputAssets", () => {
  it("copies checksums, variants, identification, type, and Rust timing", async () => {
    const file = archive("game.sfc", 8) as Record<string, unknown>;
    const identification = { matches: [{ name: "Demo" }] };
    runtime.ingest.run.mockResolvedValue({
      outputs: [],
      patchOutputs: [],
      result: {
        isRom: true,
        assets: [
          {
            copiedInPlace: true,
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
    await resolveUnclassifiedInputAssets(
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

  it("carries a bounded identify wait as unavailable identification plus the retry", async () => {
    const file = archive("game.sfc", 8) as Record<string, unknown>;
    const identifyRetry = Promise.resolve(true);
    runtime.ingest.run.mockResolvedValue({
      identifyRetry,
      identifyUnavailable: "ROM identify data did not finish within 5000 ms",
      outputs: [],
      patchOutputs: [],
      result: { isRom: true, assets: [{ copiedInPlace: true, checksums: { crc32: "a1b2c3d4" } }] },
    });
    await resolveUnclassifiedInputAssets(file as never, undefined, runtime as never);
    expect(file).toMatchObject({
      checksums: { crc32: "a1b2c3d4" },
      identification: {
        matches: [],
        status: "unavailable",
        unavailableReason: "ROM identify data did not finish within 5000 ms",
      },
      identifyRetry,
    });
  });

  it("is best effort for non-ROM, unavailable, failed, and already computed inputs", async () => {
    const existing = archive("existing.sfc") as Record<string, unknown>;
    existing.checksums = { crc32: "existing" };
    await resolveUnclassifiedInputAssets(existing as never, undefined, runtime as never);
    expect(runtime.ingest.run).not.toHaveBeenCalled();

    runtime.ingest.run.mockResolvedValueOnce({ outputs: [], patchOutputs: [], result: { isRom: false, assets: [] } });
    const nonRom = archive("text.bin") as Record<string, unknown>;
    await resolveUnclassifiedInputAssets(nonRom as never, undefined, runtime as never);
    expect(nonRom.checksums).toBeUndefined();

    runtime.ingest.run.mockRejectedValueOnce(new Error("hash failed"));
    const failed = archive("failed.sfc") as Record<string, unknown>;
    await expect(resolveUnclassifiedInputAssets(failed as never, undefined, runtime as never)).resolves.toBeUndefined();
    expect(failed.checksums).toBeUndefined();

    runtime.ingest.run.mockResolvedValueOnce({ outputs: [], patchOutputs: [], result: { isRom: true, assets: [] } });
    const empty = archive("empty.sfc") as Record<string, unknown>;
    await expect(resolveUnclassifiedInputAssets(empty as never, undefined, runtime as never)).resolves.toBeUndefined();
    expect(empty.checksums).toBeUndefined();

    runtime.ingest.run.mockImplementationOnce(async ({ onProgress }) => {
      onProgress?.({ percent: 10, label: "Hashing" });
      return {
        outputs: [],
        patchOutputs: [],
        result: {
          isRom: true,
          assets: [{ copiedInPlace: true, checksums: { crc32: "abc", md5: "def", sha1: "ghi" }, platform: "snes" }],
        },
      };
    });
    const fallback = archive("fallback.sfc") as Record<string, unknown>;
    await resolveUnclassifiedInputAssets(fallback as never, undefined, runtime as never);
    expect(fallback).toMatchObject({ checksums: { crc32: "abc" }, romType: { platform: "snes" } });
    expect(fallback._precomputedChecksumMs).toEqual(expect.any(Number));
  });
});

describe("nested archive drop classification", () => {
  it.each(["original.bin", "fix.ips", "rom-weaver-weave.json"])(
    "discovers %s behind an archive-only root and releases extracted files",
    async (leaf) => {
      runtime.compression.probe.mockResolvedValue({ entries: [{ filename: "nested/inner.zip" }] });
      const cleanup = vi.fn();
      runtime.compression.extract.mockResolvedValue({
        outputs: [{ ...output(leaf), relativePath: `nested/inner/${leaf}`, cleanup }],
      });
      const names = await listDroppedArchiveEntryNames(new File(["zip"], "nested.zip"));
      expect(names).toEqual([`nested/inner/${leaf}`]);
      expect(runtime.compression.extract).toHaveBeenCalledWith(
        expect.objectContaining({
          extractAll: true,
          options: expect.objectContaining({ interactiveSelectionEnabled: false }),
        }),
      );
      expect(cleanup).toHaveBeenCalledOnce();
    },
  );

  it("releases every recursive output when reading a discovered name fails", async () => {
    runtime.compression.probe.mockResolvedValue({ entries: [{ filename: "inner.zip" }] });
    const cleanups = [vi.fn(), vi.fn()];
    runtime.compression.extract.mockResolvedValue({
      outputs: [
        {
          ...output("first.bin"),
          cleanup: cleanups[0],
          get relativePath() {
            throw new Error("bad leaf metadata");
          },
        },
        { ...output("second.bin"), cleanup: cleanups[1] },
      ],
    });
    await expect(listDroppedArchiveEntryNames(new File(["zip"], "broken.zip"))).rejects.toThrow("bad leaf metadata");
    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledOnce();
  });

  it("lists a dropped container without reading the whole file into memory", async () => {
    runtime.compression.probe.mockResolvedValue({ entries: [{ filename: "game.bin" }] });
    const disc = new File([new Uint8Array(1024 * 1024)], "game.chd");
    const arrayBuffer = vi.spyOn(disc, "arrayBuffer");
    const slice = vi.spyOn(disc, "slice");

    await expect(listDroppedArchiveEntryNames(disc)).resolves.toEqual(["game.bin"]);

    // Drop routing runs on every pick; reading a disc whole there can exceed an iOS tab's memory limit.
    expect(arrayBuffer).not.toHaveBeenCalled();
    for (const [start = 0, end = disc.size] of slice.mock.calls) expect(end - start).toBeLessThan(disc.size);
  });

  it("preserves the cheap listing for direct ROMs, patches, and root manifests", async () => {
    for (const leaf of ["original.bin", "fix.ips", "rom-weaver-weave.json"]) {
      runtime.compression.probe.mockResolvedValue({ entries: [{ filename: leaf }, { filename: "inner.zip" }] });
      await expect(listDroppedArchiveEntryNames(new File(["zip"], `${leaf}.zip`))).resolves.toEqual([
        leaf,
        "inner.zip",
      ]);
    }
    expect(runtime.compression.extract).not.toHaveBeenCalled();
  });
});
