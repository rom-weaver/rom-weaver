import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPatchProbeRequirements: vi.fn(),
  parsePatchForApply: vi.fn(),
  prepareInputFile: vi.fn(),
}));

vi.mock("../../src/lib/input/input-preparation-service.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/input/input-preparation-service.ts")>();
  return { ...actual, prepareInputFile: mocks.prepareInputFile };
});
vi.mock("../../src/lib/apply/patch-apply-service.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/apply/patch-apply-service.ts")>();
  return {
    ...actual,
    getPatchProbeRequirements: mocks.getPatchProbeRequirements,
    parsePatchForApply: mocks.parsePatchForApply,
  };
});

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type Source = { name: string };
type Stage = {
  source: Source;
  parentCompressions: unknown[];
  preparedPatchFile?: Record<string, unknown>;
  state: Record<string, unknown>;
};
type Probe = {
  addFannedOutPatch: (...args: unknown[]) => Promise<void>;
  createInitialSource: (role: "input" | "patch", source: Source, index: number) => Stage;
  evaluatePatchReadiness: (...args: unknown[]) => Promise<boolean>;
  inputStages: Record<string, (...args: unknown[]) => unknown>;
  stageSource: (stage: Stage, options?: Record<string, unknown>) => Promise<Stage>;
};

const source = (name: string): Source => ({ name });
const file = (fileName: string, fileSize = 4) => ({
  _sourceRef: { fileName, size: fileSize, source: `/work/${fileName}` },
  _u8array: new Uint8Array(fileSize),
  fileName,
  fileSize,
});
const makeController = () => new ApplyWorkflowController<Source, unknown>({ name: "browser" }, {}) as unknown as Probe;

beforeEach(() => {
  mocks.getPatchProbeRequirements.mockReset();
  mocks.parsePatchForApply.mockReset();
  mocks.prepareInputFile.mockReset();
  mocks.getPatchProbeRequirements.mockReturnValue({ format: "IPS", targetSize: 8 });
  mocks.parsePatchForApply.mockResolvedValue({ format: "IPS" });
});

describe("apply controller staged patch paths", () => {
  it("stages a patch, adds a direct candidate, parses it, and records preparation metadata", async () => {
    const controller = makeController();
    const prepared = file("selected.ips", 6);
    mocks.prepareInputFile.mockResolvedValue({
      decompressionTimeMs: 9,
      file: prepared,
      parentCompressions: [{ depth: 0, kind: "zip", fileName: "bundle.zip", outputSize: 6 }],
      sourceSize: 20,
      wasDecompressed: true,
    });
    const stage = controller.createInitialSource("patch", source("bundle.zip"), 0);
    await controller.stageSource(stage);
    expect(mocks.prepareInputFile).toHaveBeenCalledWith(
      source("bundle.zip"),
      "patch",
      expect.objectContaining({ onCandidatesFound: expect.any(Function) }),
      expect.anything(),
      undefined,
      0,
    );
    expect(stage).toMatchObject({
      preparedPatchFile: prepared,
      parentCompressions: [{ kind: "zip" }],
      state: { status: "ready", fileName: "selected.ips", wasDecompressed: true, decompressionTimeMs: 9 },
    });
    expect(stage.state.candidates).toHaveLength(1);
    expect(stage.state.selectedCandidateId).toBeDefined();
    expect(mocks.parsePatchForApply).toHaveBeenCalledWith(prepared, expect.anything());
    expect(stage.state.requirements).toEqual({ format: "IPS", targetSize: 8 });
  });

  it("stages input through the dedicated input controller and refreshes metadata", async () => {
    const controller = makeController();
    const input = controller.createInitialSource("input", source("rom.sfc"), 0);
    const staged = { ...input, state: { ...input.state, status: "ready" } };
    const stageSource = vi.fn(async () => staged);
    const refresh = vi.fn();
    controller.inputStages.stageSource = stageSource;
    const patch = controller.stageSource(input);
    expect(await patch).toBe(staged);
    expect(stageSource).toHaveBeenCalledWith(input);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("fans out an extracted sidecar into an independently selectable patch row", async () => {
    const controller = makeController();
    controller.evaluatePatchReadiness = vi.fn(async () => true);
    const sidecar = file("game.ips", 7);
    await (
      controller as unknown as { addFannedOutPatch: (file: unknown, parents: unknown[]) => Promise<void> }
    ).addFannedOutPatch(sidecar, [{ depth: 0, kind: "zip", fileName: "game.zip", decompressionTimeMs: 2 }]);
    const patches = (controller as unknown as { patches: Stage[] }).patches;
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      preparedPatchFile: sidecar,
      state: { role: "patch", status: "loading", wasDecompressed: true, decompressionTimeMs: 2 },
    });
    expect(patches[0]?.state.selectedCandidateId).toBeDefined();
    expect(controller.evaluatePatchReadiness).toHaveBeenCalledWith(patches[0]);
  });
});
