import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveMocks = vi.hoisted(() => ({
  attachBareRomIngestMetadata: vi.fn(async () => undefined),
  resolveArchiveInput: vi.fn(),
  resolveArchiveInputAssets: vi.fn(),
}));

vi.mock("../../src/lib/input/input-preparation-archive.ts", () => ({
  attachBareRomIngestMetadata: archiveMocks.attachBareRomIngestMetadata,
  describeArchiveFileForTrace: (file: { fileName?: string; fileSize?: number }) => ({
    fileName: file.fileName || "input.bin",
    fileSize: file.fileSize || 0,
  }),
  resolveArchiveInput: archiveMocks.resolveArchiveInput,
  resolveArchiveInputAssets: archiveMocks.resolveArchiveInputAssets,
}));

import { resolveCompressedInputAssets, resolveCompressedInputFile } from "../../src/lib/input/input-decompression.ts";

type InputFile = {
  fileName: string;
  fileSize: number;
  filePath?: string;
  _extractTimeMs?: number;
  _browserFileBacked?: boolean;
  _romSpecificDecompressionOutput?: boolean;
};

const file = (fileName: string, fileSize = 100, extra: Partial<InputFile> = {}): InputFile => ({
  fileName,
  fileSize,
  ...extra,
});

const options = {
  input: { containerInputsEnabled: true },
  logging: { level: "trace" },
  onLog: vi.fn(),
  onProgress: vi.fn(),
};

beforeEach(() => {
  archiveMocks.attachBareRomIngestMetadata.mockReset().mockResolvedValue(undefined);
  archiveMocks.resolveArchiveInput.mockReset();
  archiveMocks.resolveArchiveInputAssets.mockReset();
});

describe("resolveCompressedInputFile", () => {
  it("returns a raw file without decompression and preserves empty metrics", async () => {
    const input = file("game.bin", 42);
    const result = await resolveCompressedInputFile(input as never, "rom", undefined);

    expect(result).toEqual({
      decompressionTimeMs: 0,
      file: input,
      parentCompressions: [],
      sourceSize: 42,
      wasDecompressed: false,
    });
    expect(archiveMocks.resolveArchiveInput).not.toHaveBeenCalled();
  });

  it("can disable container handling without calling extraction", async () => {
    const input = file("game.zip", 42);
    const result = await resolveCompressedInputFile(input as never, "rom", {
      input: { containerInputsEnabled: false },
    } as never);

    expect(result.file).toBe(input);
    expect(result.wasDecompressed).toBe(false);
    expect(result.parentCompressions).toEqual([]);
    expect(archiveMocks.resolveArchiveInput).not.toHaveBeenCalled();
  });

  it("unwraps a compressed input, uses the worker extraction time, and reports progress", async () => {
    const input = file("game.zip", 100);
    const extracted = file("game.bin", 80, { _extractTimeMs: 17 });
    archiveMocks.resolveArchiveInput.mockResolvedValueOnce(extracted);
    const progress = vi.fn();

    const result = await resolveCompressedInputFile(
      input as never,
      "rom",
      { ...options, onProgress: progress } as never,
      { name: "browser" } as never,
      "nested/game.bin",
      2,
    );

    expect(result.file).toBe(extracted);
    expect(result.decompressionTimeMs).toBe(17);
    expect(result.wasDecompressed).toBe(true);
    expect(result.sourceSize).toBe(100);
    expect(result.parentCompressions).toEqual([
      {
        decompressionTimeMs: 17,
        depth: 0,
        fileName: "game.zip",
        kind: "zip",
        outputSize: 80,
        sourceSize: 100,
      },
    ]);
    expect(archiveMocks.resolveArchiveInput).toHaveBeenCalledWith(
      input,
      "rom",
      expect.objectContaining({ onProgress: progress }),
      { name: "browser" },
      "nested/game.bin",
      2,
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Extracting game.zip...", percent: null, stage: "input" }),
    );
  });

  it("rejects when extraction returns the same file identity", async () => {
    const input = file("loop.zip", 12, { filePath: "/same" });
    archiveMocks.resolveArchiveInput.mockResolvedValueOnce(file("loop.zip", 12, { filePath: "/same" }));

    await expect(resolveCompressedInputFile(input as never, "patch", options as never)).rejects.toMatchObject({
      code: "COMPRESSION_FAILED",
      message: "Recursive input decompression stalled on the same compressed output",
      details: { fileName: "loop.zip", fileSize: 12 },
    });
  });

  it("rejects after the maximum number of recursive compression passes", async () => {
    const input = file("layer-0.zip", 100);
    let pass = 0;
    archiveMocks.resolveArchiveInput.mockImplementation(async () => {
      pass += 1;
      return file(`layer-${pass}.zip`, 100 + pass, { filePath: `/layer-${pass}` });
    });

    await expect(resolveCompressedInputFile(input as never, "rom", undefined)).rejects.toMatchObject({
      code: "COMPRESSION_FAILED",
      message: "Recursive input decompression exceeded the supported limit",
      details: { maxDecompressionPasses: 12 },
    });
    expect(pass).toBe(12);
  });
});

describe("resolveCompressedInputAssets", () => {
  it("finalizes a bare ROM through ingest and attaches source metrics", async () => {
    const input = file("game.bin", 42);
    archiveMocks.attachBareRomIngestMetadata.mockClear();

    const assets = await resolveCompressedInputAssets(
      input as never,
      options as never,
      { name: "browser" } as never,
      3,
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      file: input,
      fileName: "game.bin",
      id: "input-3-game.bin",
      kind: "rom",
      patchable: true,
      preparation: { sourceSize: 42, wasDecompressed: false },
    });
    expect(archiveMocks.attachBareRomIngestMetadata).toHaveBeenCalledWith(input, options, { name: "browser" });
  });

  it("finalizes a container input as a ROM when container extraction is disabled", async () => {
    const input = file("game.zip", 42);
    const assets = await resolveCompressedInputAssets(
      input as never,
      { input: { containerInputsEnabled: false } } as never,
      { name: "browser" } as never,
      0,
    );

    expect(assets[0]).toMatchObject({ file: input, fileName: "game.zip", kind: "rom" });
    expect(assets[0]?.preparation).toEqual({ sourceSize: 42, wasDecompressed: false });
    expect(archiveMocks.resolveArchiveInputAssets).not.toHaveBeenCalled();
  });

  it("returns multiple extracted assets and carries harvested sidecar patches onto the primary asset", async () => {
    const input = file("bundle.zip", 500);
    const sidecar = {
      file: file("fix.ips", 8),
      parentCompressions: [{ depth: 0, kind: "zip", fileName: "bundle.zip" }],
    };
    archiveMocks.resolveArchiveInputAssets.mockResolvedValueOnce([
      {
        file: file("game.bin", 100),
        fileName: "game.bin",
        id: "rom",
        kind: "rom",
        patchable: true,
        size: 100,
        sidecarPatches: [sidecar],
      },
      { file: file("readme.txt", 10), fileName: "readme.txt", id: "text", kind: "rom", patchable: true, size: 10 },
    ]);

    const assets = await resolveCompressedInputAssets(
      input as never,
      options as never,
      { name: "browser" } as never,
      1,
    );

    expect(assets).toHaveLength(2);
    expect(assets[0]?.sidecarPatches).toEqual([sidecar]);
    expect(assets[1]?.sidecarPatches).toBeUndefined();
    expect(assets[0]?.preparation).toMatchObject({
      sourceSize: 500,
      wasDecompressed: true,
      decompressionTimeMs: expect.any(Number),
    });
  });

  it("recurses through one compressed asset and reattaches sidecars after the final pass", async () => {
    const input = file("outer.zip", 400);
    const nested = file("inner.zip", 200);
    const sidecar = { file: file("fix.ips", 8), parentCompressions: [] };
    archiveMocks.resolveArchiveInputAssets
      .mockResolvedValueOnce([
        {
          file: nested,
          fileName: "inner.zip",
          id: "nested",
          kind: "rom",
          patchable: true,
          size: 200,
          sidecarPatches: [sidecar],
        },
      ])
      .mockResolvedValueOnce([
        { file: file("game.bin", 100), fileName: "game.bin", id: "game", kind: "rom", patchable: true, size: 100 },
      ]);

    const assets = await resolveCompressedInputAssets(
      input as never,
      options as never,
      { name: "browser" } as never,
      0,
    );

    expect(assets).toHaveLength(1);
    expect(assets[0]?.file.fileName).toBe("game.bin");
    expect(assets[0]?.sidecarPatches).toEqual([sidecar]);
    expect(assets[0]?.preparation?.parentCompressions).toHaveLength(2);
    expect(assets[0]?.preparation?.parentCompressions?.map((entry) => entry.fileName)).toEqual([
      "outer.zip",
      "inner.zip",
    ]);
  });

  it("rejects a repeating compressed identity during asset descent", async () => {
    const input = file("loop.zip", 12, { filePath: "/loop" });
    archiveMocks.resolveArchiveInputAssets.mockResolvedValueOnce([
      {
        file: file("loop.zip", 12, { filePath: "/loop" }),
        fileName: "loop.zip",
        id: "loop",
        kind: "rom",
        patchable: true,
        size: 12,
      },
    ]);

    await expect(
      resolveCompressedInputAssets(input as never, options as never, { name: "browser" } as never, 0),
    ).rejects.toMatchObject({
      code: "COMPRESSION_FAILED",
      message: "Recursive input decompression stalled on the same compressed output",
    });
  });
});
