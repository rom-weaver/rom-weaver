import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runApplyWorkflow: vi.fn(), runCreateWorkflow: vi.fn() }));
vi.mock("../../src/lib/apply/workflow.ts", () => ({ runApplyWorkflow: mocks.runApplyWorkflow }));

vi.mock("../../src/lib/create/workflow.ts", () => ({ runCreateWorkflow: mocks.runCreateWorkflow }));

import type { CreateResult } from "../../src/types/public.ts";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type Source = { name: string };
type Stage = {
  source: Source;
  parentCompressions: unknown[];
  preparedPatchFile?: Record<string, unknown>;
  parsedPatch?: unknown;
  preparedInputAssets: Array<{
    file: ReturnType<typeof file>;
    fileName: string;
    id: string;
    kind: string;
    patchable: boolean;
    size: number;
  }>;
  state: Record<string, unknown>;
};
type Probe = {
  finalizeInputStableState: () => Promise<boolean>;
  inputSession?: { role: "input"; sources: Source[]; stages: Stage[]; synthetic: boolean; view: Stage };
  inputs: Source[];
  outputState: Record<string, unknown>;
  patches: Stage[];
  recomputeOutputState: () => void;
  refreshPatchReadiness: () => Promise<void>;
  run: () => Promise<Record<string, unknown>>;
  abort: () => void;
  createCombinedPatch: (settings: unknown) => Promise<CreateResult<unknown>>;
  createInitialSource: (role: "input" | "patch", source: Source, index: number) => Stage;
};

const source = (name: string): Source => ({ name });
const candidate = (id: string, fileName: string, kind: "rom" | "patch") => ({
  fileName,
  id,
  kind,
  patchable: true,
  selectable: true,
  size: 8,
  type: "file",
  candidateIds: [],
  warnings: [],
});
const file = (fileName: string) => ({
  fileName,
  fileSize: 8,
  _sourceRef: { fileName, size: 8, source: `/work/${fileName}` },
});

const makeController = () => {
  const runtime = {
    name: "browser",
    publicOutput: {
      getBlob: vi.fn(async () => new Blob(["patched"])),
      getSize: vi.fn(() => 12),
      getStorage: vi.fn(() => "blob"),
      saveAs: vi.fn(async () => undefined),
    },
    patch: { applyPatch: vi.fn() },
    output: { createSource: vi.fn() },
    workerIo: { releaseOwnedSources: vi.fn(async () => undefined), releaseSources: vi.fn(async () => undefined) },
  };
  const controller = new ApplyWorkflowController<Source, unknown>(
    runtime as never,
    { settings: { output: { outputName: "patched.sfc" } } } as never,
  ) as unknown as Probe;
  const input = controller.createInitialSource("input", source("rom.sfc"), 0);
  input.state.status = "ready";
  input.state.candidates = [candidate("input-candidate", "rom.sfc", "rom")];
  input.state.selectedCandidateId = "input-candidate";
  input.preparedInputAssets = [
    { file: file("rom.sfc"), fileName: "rom.sfc", id: "input-candidate", kind: "rom", patchable: true, size: 8 },
  ];
  const patch = controller.createInitialSource("patch", source("update.ips"), 0);
  patch.state.status = "ready";
  patch.state.candidates = [candidate("patch-candidate", "update.ips", "patch")];
  patch.state.selectedCandidateId = "patch-candidate";
  patch.preparedPatchFile = file("update.ips");
  patch.parsedPatch = { format: "IPS" };
  controller.inputSession = { role: "input", sources: [input.source], stages: [input], synthetic: false, view: input };
  controller.inputs = [input.source];
  controller.patches = [patch];
  controller.outputState.outputName = "patched.sfc";
  controller.finalizeInputStableState = vi.fn(async () => false);
  controller.refreshPatchReadiness = vi.fn(async () => undefined);
  controller.recomputeOutputState = vi.fn();
  return { controller, runtime, input, patch };
};

beforeEach(() => {
  mocks.runApplyWorkflow.mockReset();
  mocks.runCreateWorkflow.mockReset();
});

describe("ApplyWorkflowController.run", () => {
  it("runs a validated apply, maps every output, and preserves public output controls", async () => {
    const { controller, runtime } = makeController();
    const runtimeOutput = {
      fileName: "patched.sfc",
      size: 12,
      storage: "blob",
      dispose: vi.fn(async () => undefined),
      prepareDownload: vi.fn(async () => undefined),
    };
    mocks.runApplyWorkflow.mockImplementation(async (_input) => {
      return {
        inputs: ["rom.sfc"],
        outputs: [runtimeOutput],
        patches: ["update.ips"],
        sizeSummary: { outputSize: 12, rawSize: 15 },
      };
    });

    const result = await controller.run();
    const callInput = mocks.runApplyWorkflow.mock.calls[0]?.[0] as {
      options?: { onProgress?: (progress: Record<string, unknown>) => void };
    };
    callInput.options?.onProgress?.({
      stage: "output",
      label: "writing",
      percent: 80,
      hasProgress: true,
      details: { part: 1 },
    });
    expect(mocks.runApplyWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: [expect.objectContaining({ name: "rom.sfc" })],
        patches: [expect.objectContaining({ name: "update.ips" })],
        patchTargets: ["auto"],
      }),
      expect.anything(),
    );
    expect(result).toMatchObject({
      inputs: ["rom.sfc"],
      output: { id: "output-0-patched.sfc", fileName: "patched.sfc", size: 12, storage: "blob" },
      outputs: [{ id: "output-0-patched.sfc" }],
      patches: ["update.ips"],
      sizeSummary: { outputSize: 12, rawSize: 15 },
    });
    await result.output.saveAs("destination" as never);
    expect(runtime.publicOutput.saveAs).toHaveBeenCalledWith(runtimeOutput, "destination");
    await result.output.getBlob?.();
    expect(runtime.publicOutput.getBlob).toHaveBeenCalledWith(runtimeOutput);
    await result.output.dispose();
    expect(runtimeOutput.dispose).toHaveBeenCalledTimes(1);
  });

  it("uses the latest output name and rejects a missing output before running", async () => {
    const { controller } = makeController();
    controller.outputState.outputName = "";
    await expect(controller.run()).rejects.toThrow("Output name is required");
    expect(mocks.runApplyWorkflow).not.toHaveBeenCalled();
  });
});

describe("ApplyWorkflowController.createCombinedPatch", () => {
  const arrange = () => {
    const setup = makeController();
    const worker = { fileName: "final.sfc", size: 12, dispose: vi.fn(async () => undefined) };
    const normalized = { ...worker, path: "/fake", dispose: vi.fn(async () => undefined) };
    const finalPatch = { fileName: "combined.bps", size: 4, dispose: vi.fn(async () => undefined) };
    const realSource = { source: "/real/opfs/final.sfc", fileName: "final.sfc", size: 12 };
    setup.runtime.patch.applyPatch.mockResolvedValue(worker);
    setup.runtime.output.createSource.mockResolvedValue(normalized);
    mocks.runApplyWorkflow.mockImplementation(async (_input, runtime) => {
      await runtime.patch.applyPatch({});
      const output = await runtime.output.createSource(realSource, "final.sfc");
      return { output, outputs: [output], warnings: ["apply warning"] };
    });
    mocks.runCreateWorkflow.mockResolvedValue({ format: "bps", output: finalPatch });
    return { ...setup, worker, normalized, finalPatch, realSource };
  };

  it("diffs prepared original against the real final source and releases intermediates", async () => {
    const { controller, worker, normalized, finalPatch, realSource } = arrange();
    const result = await controller.createCombinedPatch({ format: "bps", output: { outputName: "combined.bps" } });
    expect(mocks.runApplyWorkflow.mock.calls[0][0].options.output).toMatchObject({
      compression: "none",
      header: "keep",
    });
    expect(mocks.runCreateWorkflow.mock.calls[0][0]).toMatchObject({
      original: { source: "/work/rom.sfc" },
      modified: realSource,
      options: { format: "bps", output: { outputName: "combined.bps" } },
    });
    expect(result).toMatchObject({ type: "bps", warnings: ["apply warning"] });
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(normalized.dispose).toHaveBeenCalledOnce();
    expect(finalPatch.dispose).not.toHaveBeenCalled();
    await controller.createCombinedPatch({ output: { outputName: "again.bps" } });
    expect(mocks.runCreateWorkflow).toHaveBeenCalledTimes(2);
  });

  it("names the intermediate ROM after the original, not the compressed output name", async () => {
    const { controller } = arrange();
    controller.outputState.outputName = "MyHack.zip";
    await controller.createCombinedPatch({ format: "bps", output: { outputName: "combined.bps" } });
    expect(mocks.runApplyWorkflow.mock.calls[0][0].options.output.outputName).toBe("rom.sfc");
  });

  it("releases the worker output when apply fails after producing it", async () => {
    const { controller, runtime, worker } = arrange();
    mocks.runApplyWorkflow.mockImplementation(async (_input, adapter) => {
      await adapter.patch.applyPatch({});
      throw new Error("apply failed");
    });
    await expect(controller.createCombinedPatch({ output: { outputName: "combined.bps" } })).rejects.toThrow(
      "apply failed",
    );
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(runtime.workerIo.releaseSources).not.toHaveBeenCalled();
  });

  it("releases intermediate outputs when create fails", async () => {
    const { controller, worker, normalized } = arrange();
    mocks.runCreateWorkflow.mockRejectedValue(new Error("create failed"));
    await expect(controller.createCombinedPatch({ output: { outputName: "combined.bps" } })).rejects.toThrow(
      "create failed",
    );
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(normalized.dispose).toHaveBeenCalledOnce();
  });

  it("disposes a final patch produced after cancellation", async () => {
    const { controller, finalPatch, worker } = arrange();
    mocks.runCreateWorkflow.mockImplementation(async () => {
      controller.abort();
      return { format: "bps", output: finalPatch };
    });
    await expect(controller.createCombinedPatch({ output: { outputName: "combined.bps" } })).rejects.toThrow();
    expect(finalPatch.dispose).toHaveBeenCalledOnce();
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it("rejects multi-file ROMs before applying", async () => {
    const { controller, input } = arrange();
    input.preparedInputAssets.push({ ...input.preparedInputAssets[0], id: "second" });
    await expect(controller.createCombinedPatch({ output: { outputName: "combined.bps" } })).rejects.toThrow(
      "exactly one ROM file",
    );
    expect(mocks.runApplyWorkflow).not.toHaveBeenCalled();
  });
});
