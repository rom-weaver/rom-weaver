import { describe, expect, it } from "vitest";
import { createPatchedRomSavePlan } from "../../src/lib/output/output-save-plan.ts";
import { withOutputExtension } from "../../src/lib/output/output-name-validation.ts";

describe("typed Apply output names", () => {
  it("keeps a dotted version in the zip name and gives the entry the source extension", () => {
    const romFile = { getExtension: () => "sfc" } as never;
    const plan = createPatchedRomSavePlan({
      compressionFormat: "zip",
      patchedFileName: "Zelda Hack v1.2",
      romFile,
    });
    expect(plan.finalOutputFileName).toBe("Zelda Hack v1.2.zip");
    expect(plan.archiveEntryFileName).toBe("Zelda Hack v1.2.sfc");
  });

  it("withOutputExtension appends unless the exact extension is present", () => {
    expect(withOutputExtension("Hack v1.2", ".sfc")).toBe("Hack v1.2.sfc");
    expect(withOutputExtension("Hack.SFC", "sfc")).toBe("Hack.SFC");
    expect(withOutputExtension("Hack", "")).toBe("Hack");
    expect(withOutputExtension("Game 2.2", "sfc")).toBe("Game 2.2.sfc");
    expect(withOutputExtension("MyRenamedGame.gba", "bin")).toBe("MyRenamedGame.gba");
    expect(withOutputExtension("pack.7z", "zip")).toBe("pack.7z");
  });

  it.each([
    ["Hack v1.2b", "Hack v1.2b.sfc"],
    ["Hack v1.0-beta", "Hack v1.0-beta.sfc"],
    ["Game (USA) (v1.1)", "Game (USA) (v1.1).sfc"],
    ["Mario.Bros", "Mario.Bros.sfc"],
    ["MyRenamedGame.gba", "MyRenamedGame.gba"],
    ["game.SFC", "game.SFC"],
  ])("only treats a supported extension as typed: %s", (name, expected) => {
    expect(withOutputExtension(name, "sfc")).toBe(expected);
  });
});
