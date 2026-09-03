import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ validateApplyPatchTargets: vi.fn() }));
vi.mock("../../src/lib/workflow/apply-patch-target-validation.ts", () => ({
  validateApplyPatchTargets: mocks.validateApplyPatchTargets,
}));

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type Source = { name: string };
type Stage = {
  source: Source;
  preparedPatchFile?: Record<string, unknown>;
  parsedPatch?: unknown;
  parentCompressions: unknown[];
  state: Record<string, unknown>;
};
type Probe = {
  inputSession?: { role: "input"; sources: Source[]; stages: Stage[]; synthetic: boolean; view: Stage };
  latestChainPlans: Map<string, unknown>;
  patches: Stage[];
  validatePatches: (options?: Record<string, unknown>) => Promise<void>;
};

const source = (name: string): Source => ({ name });
const patchFile = (fileName: string) => ({ fileName, fileSize: 5 });
const inputStage = (): Stage => ({
  parentCompressions: [],
  source: source("rom.sfc"),
  state: {
    candidates: [
      {
        fileName: "rom.sfc",
        id: "asset-1",
        kind: "rom",
        patchable: true,
        selectable: true,
        size: 8,
        type: "file",
        candidateIds: [],
        warnings: [],
      },
    ],
    fileName: "rom.sfc",
    id: "input-1",
    role: "input",
    selectedCandidateId: "asset-1",
    status: "ready",
    warnings: [],
  },
});
const patchStage = (id: string, target = "asset-1"): Stage => ({
  parentCompressions: [],
  parsedPatch: { format: "ips" },
  preparedPatchFile: patchFile(`${id}.ips`),
  source: source(`${id}.ips`),
  state: {
    candidates: [],
    checksumPreflight: { status: "ready", inputChecks: [], outputChecks: [] },
    id,
    role: "patch",
    selectedCandidateId: `${id}-candidate`,
    status: "ready",
    targetInputId: target,
    warnings: [],
  },
});

const makeController = () => {
  const controller = new ApplyWorkflowController<Source, unknown>({ name: "browser" }, {
    settings: {},
  } as never) as unknown as Probe;
  const input = inputStage();
  input.preparedInputAssets = [
    { file: patchFile("rom.sfc"), fileName: "rom.sfc", id: "asset-1", kind: "rom", patchable: true, size: 8 },
  ];
  controller.inputSession = { role: "input", sources: [input.source], stages: [input], synthetic: false, view: input };
  return controller;
};

beforeEach(() => mocks.validateApplyPatchTargets.mockReset());

describe("ApplyWorkflowController.validatePatches", () => {
  it("batches live patches by target, records plans, and passes chain declarations", async () => {
    const controller = makeController();
    const first = patchStage("first");
    const second = patchStage("second");
    controller.patches = [first, second];
    const plan = { failed_count: 0, passed_count: 2, status: "valid", suggested_order: ["first", "second"] };
    mocks.validateApplyPatchTargets.mockImplementation(async (pending, adapters) => {
      adapters?.onChainPlan("asset-1", plan);
    });

    await controller.validatePatches({
      chainMeta: new Map([
        [0, { basis: "base", inputChecks: "a" }],
        [1, { basis: "previous", outputChecks: "b" }],
      ]),
    });
    expect(mocks.validateApplyPatchTargets).toHaveBeenCalledTimes(1);
    expect(mocks.validateApplyPatchTargets.mock.calls[0]?.[0]).toHaveLength(2);
    expect(mocks.validateApplyPatchTargets.mock.calls[0]?.[0]?.[0]).toMatchObject({
      chain: { basis: "base", inputChecks: "a" },
      target: { id: "asset-1" },
    });
    expect(controller.latestChainPlans.get("asset-1")).toEqual(plan);
  });

  it("skips disabled and incomplete patches, and clears plans for removed targets", async () => {
    const controller = makeController();
    const ready = patchStage("ready");
    const incomplete = patchStage("incomplete");
    incomplete.state.status = "needsSelection";
    const missingTarget = patchStage("missing", "gone");
    controller.patches = [ready, incomplete, missingTarget];
    controller.latestChainPlans.set("gone", { status: "old" });
    controller.latestChainPlans.set("asset-1", { status: "cached" });
    mocks.validateApplyPatchTargets.mockResolvedValue(undefined);

    await controller.validatePatches({ disabledIndexes: new Set([0]) });
    expect(mocks.validateApplyPatchTargets).toHaveBeenCalledWith([], expect.anything());
    expect(controller.latestChainPlans).toEqual(new Map());

    await controller.validatePatches();
    expect(mocks.validateApplyPatchTargets).toHaveBeenCalledTimes(2);
    expect(mocks.validateApplyPatchTargets.mock.calls[0]?.[0]).toEqual([]);
    expect(mocks.validateApplyPatchTargets.mock.calls[1]?.[0]).toHaveLength(1);
    expect(mocks.validateApplyPatchTargets.mock.calls[1]?.[0]?.[0]?.stage).toBe(ready);
  });

  it("accepts file-name targets and leaves unrelated preflight rows unvalidated", async () => {
    const controller = makeController();
    const stage = patchStage("named", "rom.sfc");
    stage.state.checksumPreflight = { status: "ready" };
    controller.patches = [stage];
    mocks.validateApplyPatchTargets.mockResolvedValue(undefined);
    await controller.validatePatches();
    expect(mocks.validateApplyPatchTargets.mock.calls[0]?.[0]).toHaveLength(1);
    expect(mocks.validateApplyPatchTargets.mock.calls[0]?.[0]?.[0]?.target.fileName).toBe("rom.sfc");
  });
});
