import { describe, expect, it } from "vitest";
import { getCompressionIntermediateFileName } from "../../src/lib/output/output-files.ts";
import { createPatchedRomSavePlan } from "../../src/lib/output/output-save-plan.ts";

const nesRom = { fileName: "hello-world.nes", getExtension: () => "nes" };

describe("output names with a dotted version stem", () => {
  it("adds the ROM extension to a raw output", () => {
    expect(getCompressionIntermediateFileName("Practice 3.5.1", "none", nesRom)).toBe("Practice 3.5.1.nes");
  });

  it("names the archive and its ROM entry from the whole stem", () => {
    const plan = createPatchedRomSavePlan({
      compressionFormat: "zip",
      patchedFileName: "Practice 3.5.1",
      romFile: nesRom,
    });
    expect(plan.finalOutputFileName).toBe("Practice 3.5.1.zip");
    expect(plan.archiveEntryFileName).toBe("Practice 3.5.1.nes");
  });

  it("keeps a name that already carries the ROM's or another known extension", () => {
    expect(getCompressionIntermediateFileName("Practice 3.5.1.nes", "none", nesRom)).toBe("Practice 3.5.1.nes");
    expect(getCompressionIntermediateFileName("Typed.sfc", "none", nesRom)).toBe("Typed.sfc");
    expect(getCompressionIntermediateFileName("Typed.zip", "zip", nesRom)).toBe("Typed.nes");
  });
});
