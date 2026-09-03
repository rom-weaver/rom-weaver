import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveOutput: vi.fn(),
  createPatchFileFromPublicOutput: vi.fn(),
  prepareInputAssets: vi.fn(),
  romSpecificOutput: vi.fn(),
  toPublicOutput: vi.fn((file: { fileName?: string; fileSize?: number; timing?: unknown }) => ({
    fileName: file.fileName || "output.bin",
    size: file.fileSize ?? (file as { size?: number }).size ?? 0,
    timing: file.timing,
  })),
}));

vi.mock("../../src/lib/input/input-preparation-service.ts", () => ({
  prepareInputAssets: mocks.prepareInputAssets,
}));
vi.mock("../../src/lib/output/archive-output-service.ts", () => ({
  createSingleFileArchiveOutput: mocks.archiveOutput,
  hasArchiveFileName: vi.fn(() => false),
}));
vi.mock("../../src/lib/output/output-build-service.ts", () => ({
  createSingleFileRomSpecificOutput: mocks.romSpecificOutput,
}));
vi.mock("../../src/lib/runtime/public-output-bin-file.ts", () => ({
  createPatchFileFromPublicOutput: mocks.createPatchFileFromPublicOutput,
}));
vi.mock("../../src/lib/apply/patch-apply-service.ts", () => ({ toPublicOutput: mocks.toPublicOutput }));

import { runTrimWorkflow } from "../../src/lib/trim/workflow.ts";

const source = { fileName: "game.bin", fileSize: 100, getExtension: () => "bin" };
const baseRuntime = {
  name: "browser",
  trim: {
    trim: vi.fn(async (input) => {
      input.onProgress?.({ current: 3, label: "Trimming game", percent: 60, total: 5 });
      return {
        output: { fileName: input.outputName, path: "/work/raw", size: 50, timing: { elapsedMs: 7 } },
        sizeSummary: { outputSize: 50 },
      };
    }),
  },
  vfs: {},
};

beforeEach(() => {
  mocks.prepareInputAssets.mockReset();
  mocks.archiveOutput.mockReset();
  mocks.romSpecificOutput.mockReset();
  mocks.createPatchFileFromPublicOutput.mockReset();
  mocks.toPublicOutput.mockClear();
});

describe("runTrimWorkflow validation and raw output", () => {
  it("requires an output name before using the runtime", async () => {
    await expect(runTrimWorkflow({ options: {}, source: source as never }, baseRuntime as never)).rejects.toThrow(
      "output.outputName is required",
    );
  });

  it("requires the trim capability", async () => {
    await expect(
      runTrimWorkflow({ options: { output: { outputName: "trimmed.bin" } }, source: source as never }, {
        name: "browser",
        trim: {},
      } as never),
    ).rejects.toThrow("Trimming requires the rom-weaver wasm runtime");
  });

  it("trims a direct source without preparation and reports the raw size summary", async () => {
    const runtime = { ...baseRuntime, trim: { trim: vi.fn(baseRuntime.trim.trim) } };
    const onProgress = vi.fn();
    const result = await runTrimWorkflow(
      {
        options: { output: { outputName: "trimmed.bin", compression: "none" }, onProgress, workers: { threads: 2 } },
        source: source as never,
      },
      runtime as never,
    );
    expect(mocks.prepareInputAssets).not.toHaveBeenCalled();
    expect(runtime.trim.trim).toHaveBeenCalledWith(expect.objectContaining({ outputName: "trimmed.bin", source }));
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Trimming game", percent: 60, stage: "apply" }),
    );
    expect(result).toMatchObject({
      output: { fileName: "trimmed.bin", size: 50 },
      sizeSummary: { inputSize: 100, outputSize: 50, rawSize: 50 },
    });
  });

  it("prepares a compressed source and selects its primary asset", async () => {
    const prepared = {
      file: { fileName: "game.iso", fileSize: 80 },
      fileName: "game.iso",
      kind: "rom",
      patchable: true,
      size: 80,
    };
    mocks.prepareInputAssets.mockResolvedValue([prepared]);
    const runtime = { ...baseRuntime, trim: { trim: vi.fn(baseRuntime.trim.trim) } };
    await runTrimWorkflow(
      {
        options: { output: { outputName: "trimmed.iso" } },
        selectedSourceEntryName: "game.iso",
        source: { fileName: "game.zip", source: "/work/game.zip" } as never,
      },
      runtime as never,
    );
    expect(mocks.prepareInputAssets).toHaveBeenCalledWith(
      { fileName: "game.zip", source: "/work/game.zip" },
      expect.anything(),
      0,
      runtime,
      "game.iso",
    );
    expect(runtime.trim.trim).toHaveBeenCalledWith(expect.objectContaining({ source: prepared.file }));
  });

  it("throws when preparation returns no trimmable asset", async () => {
    mocks.prepareInputAssets.mockResolvedValue([]);
    await expect(
      runTrimWorkflow(
        {
          options: { output: { outputName: "trimmed.bin" } },
          source: { fileName: "game.zip", source: "/work/game.zip" } as never,
        },
        baseRuntime as never,
      ),
    ).rejects.toThrow("Trim source did not contain a trimmable file");
  });
});

describe("runTrimWorkflow compressed outputs", () => {
  it("compresses the trimmed output into an archive and includes compression timing", async () => {
    mocks.createPatchFileFromPublicOutput.mockResolvedValue({ fileName: "trimmed.bin", fileSize: 50 });
    mocks.archiveOutput.mockResolvedValue({ fileName: "trimmed.zip", size: 30, timing: { elapsedMs: 12 } });
    const runtime = { ...baseRuntime, trim: { trim: vi.fn(baseRuntime.trim.trim) } };
    const result = await runTrimWorkflow(
      { options: { output: { compression: "zip", outputName: "trimmed.zip" } }, source: source as never },
      runtime as never,
    );
    expect(mocks.createPatchFileFromPublicOutput).toHaveBeenCalledWith(expect.anything(), "trimmed.bin", undefined);
    expect(mocks.archiveOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        compression: "zip",
        entryNameDetailKey: "trimEntryName",
        fallbackEntryName: "trimmed.bin",
      }),
    );
    expect(result).toMatchObject({
      output: { fileName: "trimmed.zip", size: 30 },
      sizeSummary: { compressionTimeMs: 12, inputSize: 100, outputSize: 30, rawSize: 50 },
    });
  });

  it("uses the lazy output path for ROM-specific compression", async () => {
    mocks.createPatchFileFromPublicOutput.mockResolvedValue({ fileName: "trimmed.iso", fileSize: 50 });
    mocks.romSpecificOutput.mockResolvedValue({ fileName: "trimmed.chd", size: 20, timing: { elapsedMs: 6 } });
    const runtime = { ...baseRuntime, trim: { trim: vi.fn(baseRuntime.trim.trim) } };
    const result = await runTrimWorkflow(
      { options: { output: { compression: "chd", outputName: "trimmed.chd" } }, source: source as never },
      runtime as never,
    );
    expect(mocks.createPatchFileFromPublicOutput).toHaveBeenCalledWith(expect.anything(), "trimmed.bin", {
      materializeBlob: false,
      preferExternalFilePath: true,
    });
    expect(mocks.romSpecificOutput).toHaveBeenCalledWith(
      expect.objectContaining({ compression: "chd", outputFile: { fileName: "trimmed.iso", fileSize: 50 } }),
    );
    expect(result).toMatchObject({
      output: { fileName: "trimmed.chd", size: 20 },
      sizeSummary: { compressionTimeMs: 6, outputSize: 20, rawSize: 50 },
    });
  });

  it("fails clearly when a ROM-specific compressor returns no output", async () => {
    mocks.createPatchFileFromPublicOutput.mockResolvedValue({ fileName: "trimmed.iso", fileSize: 50 });
    mocks.romSpecificOutput.mockResolvedValue(undefined);
    await expect(
      runTrimWorkflow(
        { options: { output: { compression: "chd", outputName: "trimmed.chd" } }, source: source as never },
        baseRuntime as never,
      ),
    ).rejects.toThrow("Runtime disc compression create capability is unavailable");
  });
});
