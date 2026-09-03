import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveOutput: vi.fn(),
  createPatchFileFromPublicOutput: vi.fn(),
  prepareInputAssets: vi.fn(),
  toPublicOutput: vi.fn((file: { fileName?: string; fileSize?: number }) => ({
    fileName: file.fileName || "patch.bps",
    size: file.fileSize ?? 0,
  })),
  hasArchiveFileName: vi.fn((name: string, compression: string) =>
    compression === "zip" ? name.endsWith(".zip") : name.endsWith(".7z"),
  ),
}));

vi.mock("../../src/lib/input/input-preparation-service.ts", () => ({
  prepareInputAssets: mocks.prepareInputAssets,
}));
vi.mock("../../src/lib/output/archive-output-service.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/output/archive-output-service.ts")>();
  return {
    ...actual,
    createSingleFileArchiveOutput: mocks.archiveOutput,
    hasArchiveFileName: mocks.hasArchiveFileName,
  };
});
vi.mock("../../src/lib/runtime/public-output-bin-file.ts", () => ({
  createPatchFileFromPublicOutput: mocks.createPatchFileFromPublicOutput,
}));
vi.mock("../../src/lib/apply/patch-apply-service.ts", () => ({ toPublicOutput: mocks.toPublicOutput }));

import { runCreateWorkflow } from "../../src/lib/create/workflow.ts";

const original = { fileName: "original.bin", fileSize: 100, getExtension: () => "bin" };
const modified = { fileName: "modified.bin", fileSize: 120, getExtension: () => "bin" };

const runtime = {
  name: "browser",
  patch: {
    createPatch: vi.fn(async (input) => {
      input.onProgress?.({ current: 2, total: 4, label: "creating", percent: 50 });
      return {
        format: input.format,
        output: { fileName: input.outputName, path: "/work/patch", size: 15 },
        sizeSummary: { outputSize: 15, inputSize: 120 },
      };
    }),
  },
};

beforeEach(() => {
  mocks.archiveOutput.mockReset();
  mocks.createPatchFileFromPublicOutput.mockReset();
  mocks.prepareInputAssets.mockReset();
  mocks.toPublicOutput.mockClear();
  mocks.hasArchiveFileName.mockClear();
  runtime.patch.createPatch.mockClear();
});

describe("runCreateWorkflow validation", () => {
  it("requires an output name before checking runtime capabilities", async () => {
    await expect(runCreateWorkflow({ original, modified, options: {} }, runtime as never)).rejects.toThrow(
      "output.outputName is required",
    );
    expect(runtime.patch.createPatch).not.toHaveBeenCalled();
  });

  it("requires the wasm patch capability", async () => {
    await expect(
      runCreateWorkflow({ original, modified, options: { output: { outputName: "patch.bps" } } }, {
        name: "browser",
        patch: {},
      } as never),
    ).rejects.toThrow("Patch creation requires the rom-weaver wasm runtime");
  });
});

describe("runCreateWorkflow worker path", () => {
  it("creates an uncompressed patch from direct sources with metadata and progress", async () => {
    const onProgress = vi.fn();
    const onLog = vi.fn();
    const result = await runCreateWorkflow(
      {
        original,
        modified,
        originalCrc32: " A1B2C3D4 ",
        options: {
          format: "ips",
          output: { outputName: "custom.ips" },
          patch: { metadata: { title: "demo", version: 2 } },
          workers: { threads: 3 },
          logging: { level: "debug" },
          onLog,
          onProgress,
        },
      },
      runtime as never,
    );

    expect(runtime.patch.createPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        checksumName: true,
        format: "ips",
        logLevel: "debug",
        metadata: { title: "demo", version: 2 },
        modified,
        original,
        outputName: "custom.ips",
        sourceCrc32: "a1b2c3d4",
        threads: 3,
        onLog,
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "creating", percent: 50, stage: "create" }),
    );
    expect(result).toEqual({
      format: "ips",
      output: { fileName: "custom.ips", path: "/work/patch", size: 15 },
      sizeSummary: { outputSize: 15, inputSize: 120 },
    });
  });

  it("prepares archive sources and preserves the role on candidate events", async () => {
    const candidates: unknown[] = [];
    mocks.prepareInputAssets.mockImplementation(async (source, options) => {
      options.onCandidatesFound?.({ candidates: [{ fileName: source.fileName }], sourceName: source.fileName });
      return [{ file: { fileName: `${source.fileName}.iso`, fileSize: 80 }, kind: "rom", patchable: true }];
    });
    const onCandidatesFound = vi.fn((event) => candidates.push(event));

    await runCreateWorkflow(
      {
        original: { fileName: "original.zip", source: "/work/original.zip" } as never,
        modified: { fileName: "modified.zip", source: "/work/modified.zip" } as never,
        selectedOriginalEntryName: "original.iso",
        selectedModifiedEntryName: "modified.iso",
        options: { output: { outputName: "patch.bps" }, onCandidatesFound },
      },
      runtime as never,
    );

    expect(mocks.prepareInputAssets).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fileName: "original.zip" }),
      expect.objectContaining({ onCandidatesFound: expect.any(Function) }),
      0,
      runtime,
      "original.iso",
    );
    expect(mocks.prepareInputAssets).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fileName: "modified.zip" }),
      expect.objectContaining({ onCandidatesFound: expect.any(Function) }),
      0,
      runtime,
      "modified.iso",
    );
    expect(candidates).toEqual([
      expect.objectContaining({ role: "original", candidates: [{ fileName: "original.zip" }] }),
      expect.objectContaining({ role: "modified", candidates: [{ fileName: "modified.zip" }] }),
    ]);
  });

  it("compresses a requested archive output and reports compression timing", async () => {
    mocks.createPatchFileFromPublicOutput.mockResolvedValue({ fileName: "modified.bps", fileSize: 15 });
    mocks.archiveOutput.mockImplementation(async ({ options: _options, ...input }) => {
      input.trace(
        async () => ({ fileName: "patch.zip", size: 9, timing: { elapsedMs: 4.6 } }),
        () => ({}),
      );
      return { fileName: "patch.zip", size: 9, timing: { elapsedMs: 4.6 } };
    });
    const result = await runCreateWorkflow(
      {
        original,
        modified,
        options: { format: "bps", output: { outputName: "patch.zip", compression: "zip" } },
      },
      runtime as never,
    );

    expect(mocks.createPatchFileFromPublicOutput).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: "modified.bps" }),
      "modified.bps",
    );
    expect(mocks.archiveOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        compression: "zip",
        entryNameDetailKey: "patchEntryName",
        fallbackEntryName: "modified.bps",
      }),
    );
    expect(result).toMatchObject({
      format: "bps",
      output: { fileName: "patch.zip", size: 9 },
      sizeSummary: { outputSize: 9, rawSize: 15, compressionTimeMs: 5 },
    });
  });

  it("rejects invalid output compression after the worker result", async () => {
    await expect(
      runCreateWorkflow(
        { original, modified, options: { output: { outputName: "patch.bps", compression: "chd" } } },
        runtime as never,
      ),
    ).rejects.toThrow("Unsupported create patch output compression: chd");
    expect(runtime.patch.createPatch).not.toHaveBeenCalled();
  });

  it("does not enable checksum naming for malformed crc32 input", async () => {
    await runCreateWorkflow(
      { original, modified, originalCrc32: "not-a-crc", options: { output: { outputName: "patch.bps" } } },
      runtime as never,
    );
    expect(runtime.patch.createPatch).toHaveBeenCalledWith(
      expect.objectContaining({ checksumName: false, sourceCrc32: undefined }),
    );
  });
});
