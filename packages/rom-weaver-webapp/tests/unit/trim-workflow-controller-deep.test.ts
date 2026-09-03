import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runTrimWorkflow: vi.fn(),
  wrapPublicOutput: vi.fn(),
}));

vi.mock("../../src/lib/trim/workflow.ts", () => ({ runTrimWorkflow: mocks.runTrimWorkflow }));
vi.mock("../../src/lib/output/index.ts", () => ({ wrapPublicOutput: mocks.wrapPublicOutput }));

import { TrimWorkflowController } from "../../src/lib/workflow/trim-workflow-controller.ts";

type Stage = {
  parentCompressions: unknown[];
  preparedInputAssets?: Array<Record<string, unknown>>;
  selectedArchiveEntry?: string;
  source: Record<string, unknown>;
  state: Record<string, unknown>;
};

type Probe = {
  buildAutomaticOutputName: () => string;
  finalizeInputStableState: (stage: Stage) => Promise<void>;
  inputStage?: Stage;
  inputStages: Record<string, (...args: unknown[]) => unknown>;
  outputExtension: string;
  outputName: string;
};

const stage = (withAsset = true): Stage => ({
  parentCompressions: [],
  preparedInputAssets: withAsset
    ? [
        {
          file: { fileName: "game.bin", fileSize: 100 },
          fileName: "game.bin",
          id: "rom-1",
          kind: "rom",
          patchable: true,
          size: 100,
        },
      ]
    : [],
  selectedArchiveEntry: withAsset ? undefined : "disc/game.bin",
  source: { fileName: "game.zip", source: "/work/game.zip" },
  state: {
    candidates: [
      {
        fileName: "game.bin",
        id: "rom-1",
        kind: "rom",
        patchable: true,
        selectable: true,
        size: 100,
        type: "file",
      },
    ],
    fileName: "game.bin",
    id: "input-1",
    parentCompressions: [],
    role: "input",
    selectedCandidateId: "rom-1",
    status: "ready",
    warnings: [],
  },
});

const makeController = (settings: Record<string, unknown> = {}) => {
  const controller = new TrimWorkflowController<unknown, unknown>({ name: "browser" }, { settings } as never);
  return controller as unknown as Probe & TrimWorkflowController<unknown, unknown>;
};

describe("TrimWorkflowController execution paths", () => {
  it("runs a prepared source and maps progress stages and the public output", async () => {
    const controller = makeController({ output: { outputName: "trimmed.zip", compression: "zip" } });
    const inputStage = stage();
    controller.inputStage = inputStage;
    const output = { fileName: "trimmed.zip", size: 40 };
    const runtimeOutput = { fileName: "trimmed.zip", fileSize: 40 };
    mocks.wrapPublicOutput.mockReturnValue(output);
    mocks.runTrimWorkflow.mockImplementation(async (input) => {
      input.options.onProgress({
        details: "not-an-object",
        hasProgress: true,
        percent: Number.POSITIVE_INFINITY,
        stage: "input",
      });
      input.options.onProgress({ hasProgress: true, percent: 10, stage: "apply" });
      input.options.onProgress({ hasProgress: true, percent: 20, stage: "output" });
      input.options.onProgress({ label: "Extracting source", stage: "create" });
      return { output: runtimeOutput, sizeSummary: { inputSize: 100, rawSize: 60, trimTimeMs: 4 } };
    });

    const result = await controller.run();

    expect(mocks.runTrimWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ output: expect.objectContaining({ compression: "zip" }) }),
        selectedSourceEntryName: undefined,
        source: inputStage.preparedInputAssets?.[0]?.file,
      }),
      expect.anything(),
    );
    expect(mocks.wrapPublicOutput).toHaveBeenCalledWith(runtimeOutput, expect.anything(), 0);
    expect(result).toEqual({
      input: expect.objectContaining({ id: "input-1", selectedCandidateId: "rom-1" }),
      output,
      sizeSummary: { inputSize: 100, outputSize: 40, rawSize: 60, trimTimeMs: 4 },
    });
    expect(controller.getSnapshot().ready).toBe(true);
  });

  it("passes an archive entry when no prepared asset is available", async () => {
    const controller = makeController({ output: { outputName: "trimmed.bin" } });
    const inputStage = stage(false);
    controller.inputStage = inputStage;
    const output = { fileName: "trimmed.bin", size: 12 };
    mocks.wrapPublicOutput.mockReturnValue(output);
    mocks.runTrimWorkflow.mockResolvedValue({ output: { fileName: "trimmed.bin" }, sizeSummary: {} });

    await expect(controller.run()).resolves.toMatchObject({ output });
    expect(mocks.runTrimWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        selectedSourceEntryName: "disc/game.bin",
        source: inputStage.source,
      }),
      expect.anything(),
    );
  });
});

describe("TrimWorkflowController.setInput recovery", () => {
  it("stages one source, preloads compression, and refreshes automatic output naming", async () => {
    const controller = makeController({ output: { compression: "zip" } });
    const inputStage = stage();
    const stages = controller.inputStages;
    const preloadCapability = vi.fn(async () => undefined);
    (controller as unknown as { runtime: { preload: unknown } }).runtime = {
      preload: { preloadCapability },
    };
    stages.createInitialSource = vi.fn(() => inputStage);
    stages.stageSource = vi.fn(async () => inputStage);
    stages.maybeResolveBlockingStageSelection = vi.fn(async () => false);
    stages.releaseRuntimeSources = vi.fn(async () => undefined);
    controller.finalizeInputStableState = vi.fn(async () => undefined);

    await controller.setInput({ name: "game.zip" });

    expect(preloadCapability).toHaveBeenCalledWith("compression", expect.any(Function), { threads: undefined });
    expect(stages.stageSource).toHaveBeenCalledWith(inputStage);
    expect(controller.inputStage).toBe(inputStage);
    expect(controller.outputName).toContain("game (trimmed).zip");
  });

  it("releases runtime sources when staging fails", async () => {
    const controller = makeController();
    const inputStage = stage();
    const releaseRuntimeSources = vi.fn(async () => undefined);
    const stages = controller.inputStages;
    stages.createInitialSource = vi.fn(() => inputStage);
    stages.stageSource = vi.fn(async () => {
      throw new Error("staging failed");
    });
    stages.maybeResolveBlockingStageSelection = vi.fn(async () => false);
    stages.releaseRuntimeSources = releaseRuntimeSources;
    controller.finalizeInputStableState = vi.fn(async () => undefined);

    await expect(controller.setInput({ name: "game.zip" })).rejects.toThrow("staging failed");
    expect(releaseRuntimeSources).toHaveBeenCalledWith([{ name: "game.zip" }]);
    expect(controller.inputStage).toBeUndefined();
  });
});

describe("TrimWorkflowController automatic naming helpers", () => {
  it("uses a raw extension, preserves an existing trimmed marker, and normalizes matching names", async () => {
    const controller = makeController();
    controller.inputStage = stage();

    await controller.setOutputFormat("nds");
    expect(controller.outputName).toBe("game (trimmed).nds");
    await controller.setOutputName("game.bin");
    expect(controller.outputName).toBe("game (trimmed).bin");
    await controller.setOutputName("  game (trimmed).bin  ");
    expect(controller.outputName).toBe("game (trimmed).bin");
    await controller.setOutputName("other.bin");
    expect(controller.outputName).toBe("other.bin");
  });
});
