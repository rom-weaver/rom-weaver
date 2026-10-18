import { expect, it, vi } from "vitest";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type ControllerInternals = {
  getPatchableInputAssets: () => unknown[];
  patches: unknown[];
  pushWarning: (stage: StageLike, error: { code?: string; message: string }) => void;
  refreshPatchReadiness: () => Promise<void>;
};
type StageLike = {
  state: { status: string; targetInputId?: string; warnings: unknown[] };
};

const makeController = (bare: Record<string, unknown>) => {
  const controller = new ApplyWorkflowController(
    { workerIo: { releaseOwnedSources: vi.fn(async () => undefined) } } as never,
    {},
  ) as never as ControllerInternals;
  controller.getPatchableInputAssets = () => [bare];
  controller.pushWarning = (stage, error) => stage.state.warnings.push({ code: error.code, message: error.message });
  return controller;
};

const makeStage = (member: string) => ({
  source: {},
  preparedPatchFile: { fileName: "a.ips", fileSize: 14 },
  parsedPatch: { format: "ips" },
  state: {
    id: "p0",
    role: "patch",
    fileName: "a.ips",
    status: "ready",
    selectedCandidateId: "c",
    warnings: [] as unknown[],
    patchTarget: { rom: true, member },
  },
});

const bareAsset = (fileName: string) => ({
  id: `input-0-${fileName}`,
  fileName,
  kind: "rom",
  size: 16,
  patchable: true,
  file: { fileName, fileSize: 16 },
  checksums: { crc32: "00000000" },
});

it("leaves a bare file that does not match the targeted member unassigned", async () => {
  const controller = makeController(bareAsset("unrelated.bin"));
  const stage = makeStage("romA.bin");
  controller.patches = [stage];
  await controller.refreshPatchReadiness();
  expect(stage.state.targetInputId).toBeUndefined();
  expect(stage.state.status).toBe("needsSelection");
});

it("assigns a bare file whose name matches the targeted member", async () => {
  const controller = makeController(bareAsset("romA.bin"));
  const stage = makeStage("romA.bin");
  controller.patches = [stage];
  await controller.refreshPatchReadiness();
  expect(stage.state.targetInputId).toBe("input-0-romA.bin");
  expect(stage.state.status).toBe("ready");
});
