import { describe, expect, it } from "vitest";
import { createPatchedOutputPlan } from "../../src/lib/output/patched-output-plan.ts";
import type { SourceMetadata } from "../../src/types/workflow-source.ts";

const plan = (fileName: string, metadata: SourceMetadata, chdOutputMode = "auto") =>
  createPatchedOutputPlan({
    romFile: { fileName, metadata },
    patchedFileName: fileName,
    compressionFormat: "chd",
    chdOutputMode,
  });

describe("archive CHD output provenance", () => {
  it.each(["game.bin", "game"])("leaves %s identity advisory in native requests", (fileName) => {
    expect(plan(fileName, { format: "CD" })).toMatchObject({ chdCreateMode: "auto" });
    expect(plan(fileName, { format: "CD" })).toHaveProperty("chdSourceMode", undefined);
    expect(plan(fileName, { format: "DVD" }, "raw")).toMatchObject({ chdCreateMode: "raw" });
  });

  it.each<[string, SourceMetadata, string]>([
    ["disc.bin", { mode: "cd", sourceFileName: "disc.chd" }, "cd"],
    ["disc.bin", { mode: "dvd" }, "dvd"],
    ["disc.bin", { cuePath: "disc.cue", format: "CD" }, "cd"],
    ["disc.bin", { cueText: "FILE", format: "CD" }, "cd"],
    ["disc.bin", { gdiText: "1", format: "CD" }, "cd"],
    ["disc.bin", { sourceFileName: "disc.gdi", format: "CD" }, "cd"],
    ["disc.cue", { format: "CD" }, "cd"],
    ["disc.gdi", { format: "CD" }, "cd"],
    ["small.iso", { format: "DVD" }, "dvd"],
  ])("preserves %s optical provenance %j", (fileName, metadata, mode) => {
    expect(plan(fileName, metadata)).toMatchObject({ chdCreateMode: mode, chdSourceMode: mode });
  });
});
