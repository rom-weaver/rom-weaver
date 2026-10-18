import { expect, it, vi } from "vitest";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

type ControllerInternals = {
  getPatchableInputAssets: () => unknown[];
  patches: unknown[];
  pushWarning: (stage: StageLike, error: { code?: string; message: string }) => void;
  recomputeOutputState: () => void;
  refreshPatchReadiness: () => Promise<void>;
  setPatchOption: (index: number, option: Record<string, unknown>) => Promise<void>;
  setWeaveRom: (expectation: { checks: string; member?: string } | undefined) => void;
};
type StageLike = {
  state: { status: string; targetInputId?: string; warnings: { message?: string }[] };
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

const makeOptionStage = () => {
  const stage = makeStage("romA.bin");
  delete (stage.state as { patchTarget?: unknown }).patchTarget;
  return stage;
};

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

it("reports the member mismatch for a lone bare file that matches no member", async () => {
  const controller = makeController(bareAsset("unrelated.bin"));
  const stage = makeStage("romA.bin");
  controller.patches = [stage];
  await controller.refreshPatchReadiness();
  expect(stage.state.warnings.map((warning) => warning.message)).toEqual([
    "weave ROM member `romA.bin` was not found in `unrelated.bin`: the input is not an archive and neither its file name nor its checks match the member",
  ]);
});

it("uses the input checks passed with the target to match a renamed bare file", async () => {
  const controller = makeController(bareAsset("unrelated.bin"));
  const stage = makeOptionStage();
  controller.patches = [stage];
  controller.recomputeOutputState = vi.fn();
  await controller.setPatchOption(0, {
    target: { rom: true, member: "romA.bin" },
    inputChecks: "crc32=00000000",
  });
  expect(stage.state.targetInputId).toBe("input-0-unrelated.bin");
});

it("uses the weave rom checks to match a renamed bare file when the weave names no rom.member", async () => {
  const controller = makeController(bareAsset("unrelated.bin"));
  const stage = makeStage("romA.bin");
  controller.patches = [stage];
  controller.setWeaveRom({ checks: "crc32=00000000" });
  await controller.refreshPatchReadiness();
  expect(stage.state.targetInputId).toBe("input-0-unrelated.bin");
  expect(stage.state.status).toBe("ready");
});
