import { describe, expect, it, vi } from "vitest";
import { createRunBareMemberRule } from "../../src/lib/apply/bare-member-target.ts";
import { resolvePatchTargets } from "../../src/lib/apply/patch-apply-service.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";
import type { PatchInput } from "../../src/types/workflow-runtime-types.ts";

type StageLike = {
  state: {
    inputChecks?: string;
    patchTarget?: { member: string; rom: true };
    status: string;
    targetInputId?: string;
    warnings: { message?: string }[];
  };
};
type ControllerInternals = {
  createPatchInput: () => PatchInput;
  disabledPatches: ReadonlySet<StageLike>;
  getPatchableInputAssets: () => InputAsset[];
  patches: StageLike[];
  pushWarning: (stage: StageLike, error: { message: string }) => void;
  refreshPatchReadiness: () => Promise<void>;
  setWeaveRom: (expectation: { checks?: string; member?: string } | undefined) => void;
};

const CHECKS = "crc32=00000000";

const romAsset = (fileName: string, member?: string) =>
  ({
    checksums: { crc32: "00000000" },
    file: { fileName, fileSize: 16 },
    fileName,
    id: `input-${member ?? fileName}`,
    kind: "rom",
    patchable: true,
    size: 16,
    ...(member ? { member } : {}),
  }) as unknown as InputAsset;

const makeStage = (index: number, member?: string, inputChecks?: string): StageLike =>
  ({
    parsedPatch: { format: "ips" },
    preparedPatchFile: { fileName: `p${index}.ips`, fileSize: 14 },
    source: {},
    state: {
      fileName: `p${index}.ips`,
      id: `p${index}`,
      role: "patch",
      selectedCandidateId: "c",
      status: "ready",
      warnings: [],
      ...(member ? { patchTarget: { member, rom: true } } : {}),
      ...(inputChecks ? { inputChecks } : {}),
    },
  }) as StageLike;

type PatchSpec = { disabled?: boolean; inputChecks?: string; member?: string };
type Case = {
  name: string;
  assets: InputAsset[];
  weaveRom?: { checks?: string; member?: string };
  patches: PatchSpec[];
  /** The conflict members, or undefined when every enabled member patch must bind. */
  conflict?: [string, string];
};

const cases: Case[] = [
  {
    conflict: ["disc-a/track.bin", "disc-b/track.bin"],
    name: "untargeted root step plus a same-named member, rom.member without checks",
    assets: [romAsset("track.bin")],
    patches: [{}, { member: "disc-b/track.bin" }],
    weaveRom: { member: "disc-a/track.bin" },
  },
  {
    conflict: ["disc-a/track.bin", "disc-b/track.bin"],
    name: "rom.checks verify rom.member while no step reads the root lane",
    assets: [romAsset("track.bin")],
    patches: [{ member: "disc-b/track.bin" }],
    weaveRom: { checks: CHECKS, member: "disc-a/track.bin" },
  },
  {
    conflict: ["disc-a/track.bin", "disc-b/track.bin"],
    name: "unselected optional root step",
    assets: [romAsset("track.bin")],
    patches: [{ disabled: true }, { member: "disc-b/track.bin" }],
    weaveRom: { checks: CHECKS, member: "disc-a/track.bin" },
  },
  {
    conflict: ["first.bin", "second.bin"],
    name: "two members bound through rom.checks",
    assets: [romAsset("game.bin")],
    patches: [{ member: "first.bin" }, { member: "second.bin" }],
    weaveRom: { checks: CHECKS },
  },
  {
    name: "renamed file for a target naming rom.member, with checks",
    assets: [romAsset("mygame.bin")],
    patches: [{ member: "disc-a/game.bin" }],
    weaveRom: { checks: CHECKS, member: "disc-a/game.bin" },
  },
  {
    name: "renamed file for a target naming rom.member, without checks",
    assets: [romAsset("mygame.bin")],
    patches: [{ member: "disc-a/game.bin" }],
    weaveRom: { member: "disc-a/game.bin" },
  },
  {
    name: "single member matched by name",
    assets: [romAsset("game.bin")],
    patches: [{ member: "disc-a/game.bin" }],
  },
  {
    name: "single member matched by rom.checks",
    assets: [romAsset("game.bin")],
    patches: [{ member: "first.bin" }],
    weaveRom: { checks: CHECKS },
  },
  {
    name: "single member matched by the patch's input checks",
    assets: [romAsset("game.bin")],
    patches: [{ inputChecks: CHECKS, member: "first.bin" }],
  },
  {
    name: "disabled patch naming a second same-named member",
    assets: [romAsset("track.bin")],
    patches: [{ member: "disc-a/track.bin" }, { disabled: true, member: "disc-b/track.bin" }],
    weaveRom: { member: "disc-a/track.bin" },
  },
  {
    name: "archive input holding both members",
    assets: [romAsset("track.bin", "disc-a/track.bin"), romAsset("track.bin", "disc-b/track.bin")],
    patches: [{ member: "disc-b/track.bin" }],
    weaveRom: { checks: CHECKS, member: "disc-a/track.bin" },
  },
];

const setUp = ({ assets, patches, weaveRom }: Case) => {
  const controller = new ApplyWorkflowController(
    { workerIo: { releaseOwnedSources: vi.fn(async () => undefined) } } as never,
    {},
  ) as never as ControllerInternals;
  controller.getPatchableInputAssets = () => assets;
  controller.pushWarning = (stage, error) => stage.state.warnings.push({ message: error.message });
  const stages = patches.map((spec, index) => makeStage(index, spec.member, spec.inputChecks));
  controller.patches = stages;
  controller.disabledPatches = new Set(stages.filter((_, index) => patches[index]?.disabled));
  controller.setWeaveRom(weaveRom);
  const enabledMemberStages = stages.filter((_, index) => !patches[index]?.disabled && patches[index]?.member);
  return { controller, enabledMemberStages, stages };
};

const conflictMessage = ([first, second]: [string, string]) =>
  `matches several weave ROM members (\`${first}\`, \`${second}\`)`;

describe("a lone bare file stands in for rom.member and at most one matching member", () => {
  it.each(cases)("readiness: $name", async (testCase) => {
    const { controller, enabledMemberStages } = setUp(testCase);
    await controller.refreshPatchReadiness();
    for (const stage of enabledMemberStages) {
      if (testCase.conflict) {
        expect(stage.state.status).toBe("needsSelection");
        expect(stage.state.warnings.at(-1)?.message).toContain(conflictMessage(testCase.conflict));
      } else {
        expect(stage.state.status).toBe("ready");
        expect(stage.state.targetInputId).toBeDefined();
      }
    }
  });

  it.each(cases)("run path: $name", async (testCase) => {
    const { controller } = setUp(testCase);
    const input = controller.createPatchInput();
    // The run stages only the enabled patches.
    const options = (input.patchOptions ?? []).filter((_, index) => !testCase.patches[index]?.disabled);
    const resolved = resolvePatchTargets(
      testCase.assets,
      options.map(() => ({ apply: vi.fn(), validateSourceAsync: vi.fn(async () => false) })) as never,
      undefined,
      options.map((option) => option.input),
      options.map((option) => option.id),
      options.map((option) => option.target),
      createRunBareMemberRule(options, input.rootMember),
    );
    if (testCase.conflict) {
      await expect(resolved).rejects.toThrow(conflictMessage(testCase.conflict));
      return;
    }
    const targets = await resolved;
    options.forEach((option, index) => {
      const member = option.target && "rom" in option.target ? option.target.member : undefined;
      const expected = testCase.assets.find((asset) => asset.member === member) ?? testCase.assets[0];
      expect(targets[index]).toBe(expected);
    });
  });
});
