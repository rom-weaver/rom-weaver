import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runApplyWorkflow: vi.fn() }));
vi.mock("../../src/lib/apply/workflow.ts", () => ({ runApplyWorkflow: mocks.runApplyWorkflow }));

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type Source = { name: string };
type Stage = {
  source: Source;
  parentCompressions: unknown[];
  preparedPatchFile?: Record<string, unknown>;
  parsedPatch?: unknown;
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

beforeEach(() => mocks.runApplyWorkflow.mockReset());

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
