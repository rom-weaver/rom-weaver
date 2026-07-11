import { describe, expect, it } from "vitest";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { createApplyPatchValidationKey } from "../../src/lib/workflow/apply-patch-readiness-state-machine.ts";
import type { InternalPatchChecksumPreflight, StagedSource } from "../../src/lib/workflow/apply-workflow-state.ts";

const patchStage = () =>
  ({
    preparedPatchFile: { fileName: "hack.bps", fileSize: 2048 },
    state: { fileName: "hack.bps", requirements: null, size: 2048 },
  }) as unknown as StagedSource<unknown>;

const inputTarget = (overrides: { id: string; fileName: string; size: number; filePath?: string }): InputAsset =>
  ({
    file: { fileName: overrides.fileName, filePath: overrides.filePath, fileSize: overrides.size },
    fileName: overrides.fileName,
    id: overrides.id,
    kind: "rom",
    patchable: true,
    size: overrides.size,
  }) as unknown as InputAsset;

// No source requirements: the preflight carries no required size/crc, so id/name/size are the only
// other distinguishing fields - exactly the case where two archive entries can collide.
const preflight: InternalPatchChecksumPreflight = { status: "unknown" } as InternalPatchChecksumPreflight;

describe("createApplyPatchValidationKey", () => {
  it("distinguishes candidates that share id/name/size but stage to different files", () => {
    const shared = { fileName: "game.rom", id: "input-0-game.rom", size: 4096 };
    const keyA = createApplyPatchValidationKey(
      patchStage(),
      inputTarget({ ...shared, filePath: "/work/entry-a/game.rom" }),
      preflight,
    );
    const keyB = createApplyPatchValidationKey(
      patchStage(),
      inputTarget({ ...shared, filePath: "/work/entry-b/game.rom" }),
      preflight,
    );
    expect(keyA).not.toBe(keyB);
  });

  it("is stable for the same staged candidate so unchanged inputs reuse the cached validation", () => {
    const target = inputTarget({
      fileName: "game.rom",
      filePath: "/work/entry-a/game.rom",
      id: "input-0-game.rom",
      size: 4096,
    });
    expect(createApplyPatchValidationKey(patchStage(), target, preflight)).toBe(
      createApplyPatchValidationKey(patchStage(), target, preflight),
    );
  });
});
