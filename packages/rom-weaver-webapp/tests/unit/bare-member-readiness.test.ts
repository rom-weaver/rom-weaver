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

it("reports a several-members conflict, not a mismatch, when the checks matched but another member cleared it", async () => {
  const controller = makeController(bareAsset("track.bin"));
  const stage = makeStage("disc-a/romA.bin");
  const other = makeStage("disc-b/track.bin");
  delete (stage.state as { patchTarget?: unknown }).patchTarget;
  controller.patches = [stage, other];
  controller.recomputeOutputState = vi.fn();
  await controller.setPatchOption(0, {
    target: { rom: true, member: "disc-a/romA.bin" },
    inputChecks: "crc32=00000000",
  });
  await controller.refreshPatchReadiness();
  expect(stage.state.targetInputId).toBeUndefined();
  expect(stage.state.warnings.at(-1)?.message).toContain("matches several weave ROM members");
});

it("clears an untargeted-root conflict: the weave root member counts as a member the bare file stands in for", async () => {
  const controller = makeController(bareAsset("track.bin"));
  const untargeted = makeOptionStage();
  const other = makeStage("disc-b/track.bin");
  controller.patches = [untargeted, other];
  controller.setWeaveRom({ checks: "crc32=00000000", member: "disc-a/track.bin" });
  await controller.refreshPatchReadiness();
  expect(other.state.targetInputId).toBeUndefined();
  expect(other.state.status).toBe("needsSelection");
});

it("carries the weave rom checks and root member to the run path", async () => {
  const controller = makeController(bareAsset("unrelated.bin")) as never as {
    createPatchInput: () => { patchOptions: Record<string, unknown>[]; rootMember?: string };
    patches: unknown[];
    setWeaveRom: ControllerInternals["setWeaveRom"];
  };
  controller.patches = [makeStage("romA.bin")];
  controller.setWeaveRom({ checks: "crc32=00000000" });
  expect(controller.createPatchInput().patchOptions[0]?.memberChecks).toBe("crc32=00000000");
  controller.setWeaveRom({ checks: "crc32=00000000", member: "disc-a/track.bin" });
  expect(controller.createPatchInput().rootMember).toBe("disc-a/track.bin");
});

it("hashes a declared algorithm staging does not compute to match a renamed bare file", async () => {
  const controller = makeController(bareAsset("unrelated.bin")) as never as ControllerInternals & {
    computeWeaveRomAssetChecksums: (asset: unknown, algorithms: string[]) => Promise<unknown>;
    createPatchInput: () => { bareFileChecksums?: Record<string, string> };
  };
  const hash = vi.fn(async () => ({ checksums: { sha256: "ab".repeat(32) } }));
  controller.computeWeaveRomAssetChecksums = hash;
  const stage = makeStage("romA.bin");
  controller.patches = [stage];
  controller.setWeaveRom({ checks: `sha256=${"ab".repeat(32)}` });
  await controller.refreshPatchReadiness();
  await controller.refreshPatchReadiness();
  expect(hash).toHaveBeenCalledTimes(1);
  expect(hash.mock.calls[0]?.[1]).toEqual(["sha256"]);
  expect(stage.state.targetInputId).toBe("input-0-unrelated.bin");
  expect(stage.state.status).toBe("ready");
  expect(controller.createPatchInput().bareFileChecksums).toEqual({ sha256: "ab".repeat(32) });
});

it("does not auto-assign a lone archive member that the targeted member does not resolve to", async () => {
  const controller = makeController({
    ...bareAsset("romA (USA).bin"),
    id: "zip-member",
    member: "romA (USA).bin",
  });
  const stage = makeStage("romA.bin");
  controller.patches = [stage];
  await controller.refreshPatchReadiness();
  expect(stage.state.targetInputId).toBeUndefined();
  expect(stage.state.status).toBe("needsSelection");
});

it("still assigns a lone archive member that the targeted member resolves to", async () => {
  const controller = makeController({ ...bareAsset("romA.bin"), id: "zip-member", member: "romA.bin" });
  const stage = makeStage("romA.bin");
  controller.patches = [stage];
  await controller.refreshPatchReadiness();
  expect(stage.state.targetInputId).toBe("zip-member");
  expect(stage.state.status).toBe("ready");
});
