import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildSessionOutputFiles: vi.fn(),
  copyRuntimeOutputToPath: vi.fn(async () => ({ filePath: "/work/retained" })),
  parsePatchForApply: vi.fn(),
  prepareInput: vi.fn(),
  prepareInputAssets: vi.fn(),
  prepareMultipleDirectInputAssets: vi.fn(),
  resolvePatchTargets: vi.fn(),
  toPublicOutput: vi.fn(),
  createPatchFileFromPublicOutput: vi.fn(),
}));

vi.mock("../../src/lib/input/input-preparation-service.ts", () => ({
  getBinarySourceSize: (source: { size?: number }) => source.size,
  prepareInput: mocks.prepareInput,
  prepareInputAssets: mocks.prepareInputAssets,
  prepareMultipleDirectInputAssets: mocks.prepareMultipleDirectInputAssets,
}));
vi.mock("../../src/lib/output/output-build-service.ts", () => ({
  buildSessionOutputFiles: mocks.buildSessionOutputFiles,
}));
vi.mock("../../src/storage/vfs/runtime-output.ts", () => ({ copyRuntimeOutputToPath: mocks.copyRuntimeOutputToPath }));
vi.mock("../../src/lib/runtime/public-output-bin-file.ts", () => ({
  createPatchFileFromPublicOutput: mocks.createPatchFileFromPublicOutput,
}));
vi.mock("../../src/lib/apply/patch-apply-service.ts", () => ({
  parsePatchForApply: mocks.parsePatchForApply,
  resolvePatchTargets: mocks.resolvePatchTargets,
  toPublicOutput: mocks.toPublicOutput,
}));

import { retainUncompressedWorkerOutputs, runApplyWorkflow } from "../../src/lib/apply/workflow.ts";

const sourceRef = (fileName: string, size: number) => ({ fileName, size, source: `/work/${fileName}` });
const patchFile = (fileName: string, size = 4) => ({
  _sourceRef: { fileName, size, source: `/work/${fileName}` },
  fileName,
  fileSize: size,
});
const asset = (id = "asset-1", fileName = "game.bin", size = 20) => ({
  file: patchFile(fileName, size),
  fileName,
  id,
  kind: "rom",
  patchable: true,
  size,
});
const parsedPatch = (format = "ips") => ({ constructor: { name: format }, format });

const makeRuntime = () => {
  const output = {
    fileName: "patched.bin",
    path: "/work/patched",
    size: 30,
    vfs: {},
    _applySummary: { timing: { elapsedMs: 9 } },
  };
  const applyPatch = vi.fn(async (input) => {
    input.onProgress?.({ percent: 75 });
    return output;
  });
  return {
    name: "browser",
    patch: { applyPatch },
    sidecars: {},
    vfs: { stat: vi.fn(async () => ({ size: 20 })) },
    output,
  };
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.copyRuntimeOutputToPath.mockResolvedValue({ filePath: "/work/retained" });
  mocks.toPublicOutput.mockImplementation(async (file: { fileName?: string; fileSize?: number; size?: number }) => ({
    fileName: file.fileName || "output.bin",
    size: file.size || file.fileSize || 0,
  }));
  mocks.createPatchFileFromPublicOutput.mockImplementation(async (output: unknown) => output);
});

describe("runApplyWorkflow validation and preparation", () => {
  it("requires an output name", async () => {
    await expect(
      runApplyWorkflow({ inputs: sourceRef("game.bin", 20) } as never, makeRuntime() as never),
    ).rejects.toThrow("output.outputName is required");
  });

  it("uses supplied prepared input, patch, and parsed data to apply and materialize output", async () => {
    const inputAsset = asset();
    const preparedPatch = patchFile("fix.ips");
    const parsed = parsedPatch("ips");
    const runtime = makeRuntime();
    mocks.resolvePatchTargets.mockResolvedValue([inputAsset]);
    mocks.buildSessionOutputFiles.mockResolvedValue({
      compressionTimeMs: 5,
      files: [{ fileName: "patched.bin", fileSize: 30 }],
      rawOutputSize: 30,
    });
    const result = await runApplyWorkflow(
      {
        inputs: sourceRef("game.bin", 20),
        options: {
          compatibility: { addHeader: true, fixChecksum: true, removeHeader: false },
          logging: { level: "trace" },
          onProgress: vi.fn(),
          output: { compression: "zip", extension: "sfc", outputName: "result.sfc", suffix: true },
          validation: { requireInputChecksumMatch: true },
          workers: { threads: 3 },
        },
        parsedPatches: [parsed],
        patchOptions: [{ basis: "base", header: "strip", n64ByteOrder: "big-endian" }],
        patches: sourceRef("fix.ips", 4),
        preparedInputAssets: [inputAsset],
        preparedPatchFiles: [preparedPatch],
      } as never,
      runtime as never,
    );
    expect(runtime.patch.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ source: "/work/game.bin" }),
        options: expect.objectContaining({
          addHeader: true,
          appendOutputSuffix: true,
          fixChecksum: true,
          headerModes: ["strip"],
          n64ByteOrders: ["big-endian"],
          outputExtension: "sfc",
          outputHeader: "auto",
          patchBasis: ["base"],
          requireInputChecksumMatch: true,
          threads: 3,
        }),
        patches: [
          {
            patchFile: expect.objectContaining({ source: "/work/fix.ips" }),
            patchFileName: "fix.ips",
            patchFormat: "ips",
          },
        ],
      }),
    );
    expect(mocks.buildSessionOutputFiles).toHaveBeenCalledWith(
      [inputAsset],
      expect.any(Map),
      expect.anything(),
      runtime,
    );
    expect(result).toMatchObject({
      inputs: [{ id: "asset-1", fileName: "game.bin", size: 20 }],
      output: { fileName: "patched.bin", size: 30 },
      outputs: [{ fileName: "patched.bin", size: 30 }],
      patches: [{ fileName: "fix.ips", format: "ips", targetInputId: "asset-1" }],
      rom: { fileName: "game.bin", size: 20 },
      sizeSummary: {
        applyTimeMs: 9,
        compressionTimeMs: 5,
        inputCompressedSize: 20,
        inputSize: 20,
        outputSize: 30,
        patchCompressedSize: 4,
        patchSize: 4,
        rawSize: 30,
      },
    });
  });

  it("prepares multiple direct input assets and reports the no-patch path", async () => {
    const first = asset("one", "one.bin", 5);
    const second = asset("two", "two.bin", 6);
    const runtime = makeRuntime();
    mocks.prepareMultipleDirectInputAssets.mockResolvedValue([first, second]);
    mocks.buildSessionOutputFiles.mockResolvedValue({ files: [{ fileName: "one.bin", size: 5 }], rawOutputSize: 5 });
    const result = await runApplyWorkflow(
      {
        inputs: [sourceRef("one.bin", 5), sourceRef("two.bin", 6)],
        options: { output: { compression: "none", outputName: "result.bin" } },
        patches: [],
      } as never,
      runtime as never,
    );
    expect(mocks.prepareMultipleDirectInputAssets).toHaveBeenCalledTimes(1);
    expect(mocks.prepareInputAssets).not.toHaveBeenCalled();
    expect(result.inputs).toHaveLength(2);
    expect(result.patches).toEqual([]);
    expect(result.sizeSummary).toMatchObject({ inputCompressedSize: 11, inputSize: 11, outputSize: 5, patchSize: 0 });
  });

  it("rejects parsed patches without matching patch files", async () => {
    const runtime = makeRuntime();
    mocks.buildSessionOutputFiles.mockResolvedValue({ files: [], rawOutputSize: 0 });
    await expect(
      runApplyWorkflow(
        {
          inputs: sourceRef("game.bin", 2),
          options: { output: { outputName: "result.bin" } },
          parsedPatches: [parsedPatch()],
          preparedInputAssets: [],
        } as never,
        runtime as never,
      ),
    ).rejects.toThrow("Parsed patches were provided without patch files");
  });
});

describe("retainUncompressedWorkerOutputs", () => {
  it("retains each reusable worker path with its resolved metadata", async () => {
    const input = asset("asset", "game.bin", 12);
    const output = { fileName: "result.sfc", path: "/work/result", romType: { platform: "snes" }, size: 45, vfs: {} };
    const retain = vi.fn(async () => undefined);
    await retainUncompressedWorkerOutputs({
      inputAssets: [input],
      options: { output: { compression: "zip" }, retainUncompressedOutput: retain } as never,
      workerOutputsById: new Map([["asset", output as never]]),
    });
    expect(retain).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: "result.sfc",
        output,
        platform: "snes",
        romType: { platform: "snes" },
        size: 45,
        retain: expect.any(Function),
      }),
    );
    await retain.mock.calls[0]?.[0].retain();
    expect(mocks.copyRuntimeOutputToPath).toHaveBeenCalledWith(output, "result.sfc");
  });

  it("treats retention errors as non-fatal and logs a warning", async () => {
    const onLog = vi.fn();
    const input = asset("asset", "game.bin", 12);
    const output = { fileName: "result.sfc", path: "/work/result", size: 45, vfs: {} };
    const retain = vi.fn(async () => {
      throw new Error("quota");
    });
    await expect(
      retainUncompressedWorkerOutputs({
        inputAssets: [input],
        options: { onLog, output: { compression: "zip" }, retainUncompressedOutput: retain } as never,
        workerOutputsById: new Map([["asset", output as never]]),
      }),
    ).resolves.toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("retention failed") }),
    );
  });

  it("skips retention when disabled, uncompressed, or output is not path-backed", async () => {
    const input = asset();
    const retain = vi.fn();
    const output = { fileName: "out.bin", size: 1 };
    await retainUncompressedWorkerOutputs({
      inputAssets: [input],
      options: { output: { compression: "none" }, retainUncompressedOutput: retain } as never,
      workerOutputsById: new Map([[input.id, output as never]]),
    });
    await retainUncompressedWorkerOutputs({
      inputAssets: [input],
      options: { output: { compression: "zip" } } as never,
      workerOutputsById: new Map([[input.id, output as never]]),
    });
    expect(retain).not.toHaveBeenCalled();
  });
});
