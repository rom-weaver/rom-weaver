import { describe, expect, it } from "vitest";

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";

const track = (
  id: string,
  fileName: string,
  member: string,
  size = 1,
  checksums?: Record<string, string>,
): InputAsset =>
  ({
    checksums,
    file: { fileName, fileSize: size },
    fileName,
    id,
    kind: "track",
    member,
    patchable: true,
    size,
  }) as unknown as InputAsset;

const createController = (assets: InputAsset[], targets: string[]) => {
  const controller = new ApplyWorkflowController<unknown, unknown>({ workerIo: {} } as never, {}) as never as {
    getBundleExportSources: () => {
      error?: string;
      patches: Array<{ target?: { rom: true; member?: string } | { patch: string; member?: string } }>;
      rom: { member?: string } | null;
    };
    getSelectedInputOwner: () => undefined;
    inputSession: { view: { preparedInputAssets: InputAsset[]; source: unknown; state: { fileName?: string } } };
    patches: Array<{
      source: unknown;
      state: {
        patchTarget?: { rom: true; member?: string } | { patch: string; member?: string };
        targetInputId: string;
        fileName: string;
        candidates: never[];
      };
    }>;
  };
  controller.getSelectedInputOwner = () => undefined;
  controller.inputSession = {
    view: {
      preparedInputAssets: assets,
      source: { fileName: "disc.cue" },
      state: { fileName: "disc.cue" },
    },
  };
  controller.patches = targets.map((targetInputId, index) => ({
    source: { fileName: `patch-${index + 1}.bps` },
    state: { candidates: [], fileName: `patch-${index + 1}.bps`, targetInputId },
  }));
  return controller;
};

describe("ApplyWorkflowController bundle export targets", () => {
  it("exports each selected track member instead of the primary track", () => {
    const first = track("track-1", "track01.bin", "disc:1");
    const second = track("track-2", "track02.bin", "disc:2");
    const result = createController([first, second], [first.id, second.id]).getBundleExportSources();

    expect(result.rom?.member).toBe("disc:1");
    expect(result.patches.map((patch) => patch.target)).toEqual([
      { rom: true, member: "disc:1" },
      { rom: true, member: "disc:2" },
    ]);
  });

  it("returns staging errors without throwing during render", () => {
    expect(createController([], [""]).getBundleExportSources().error).toContain("no resolved ROM target");
  });

  it("rejects a patch target outside the selected ROM source", () => {
    const first = track("track-1", "track01.bin", "disc:1");
    expect(createController([first], ["other-track"]).getBundleExportSources().error).toContain(
      "target belongs to a different ROM source",
    );
  });

  it("retains primary ROM checks when there is no member selector", () => {
    const primary = { ...track("rom", "game.bin", "", 9, { crc32: "22222222" }), kind: "rom" } as InputAsset;
    expect(createController([primary], [primary.id]).getBundleExportSources().rom).toMatchObject({
      checksums: { crc32: "22222222" },
      size: 9,
    });
  });

  it("uses checks and size from the selected member, not the primary track", () => {
    const primary = track("track-1", "track01.bin", "disc:1", 1, { crc32: "11111111" });
    const selected = track("track-2", "track02.bin", "disc:2", 9, { crc32: "22222222" });
    const result = createController([primary, selected], [selected.id]).getBundleExportSources();

    expect(result.rom).toMatchObject({
      checksums: { crc32: "22222222" },
      member: "disc:2",
      size: 9,
    });
  });

  it("exports the current producer target instead of replacing it with the resolved track", () => {
    const first = track("track-1", "track01.bin", "disc:1");
    const second = track("track-2", "track02.bin", "disc:2");
    const controller = createController([first, second], [second.id]);
    const stagedPatch = controller.patches[0];
    if (!stagedPatch) throw new Error("Test setup did not create a patch");
    stagedPatch.state.patchTarget = { member: "generated/track02.bin", patch: "producer" };

    expect(controller.getBundleExportSources().patches[0]?.target).toEqual({
      member: "generated/track02.bin",
      patch: "producer",
    });
  });

  it("rejects duplicate member locators instead of exporting a guessed basename", () => {
    const first = track("track-1", "track.bin", "track.bin");
    const second = track("track-2", "track.bin", "track.bin");
    expect(createController([first, second], [second.id]).getBundleExportSources().error).toContain(
      "member locator is ambiguous",
    );
  });
});
