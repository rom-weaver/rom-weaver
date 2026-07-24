import { describe, expect, it } from "vitest";
import { getProgressStagedInputInfo } from "../../src/public/react/apply-session-inputs.ts";
import type { ProgressEvent } from "../../src/types/workflow-runtime-types.ts";

const event = (details: Record<string, unknown>): ProgressEvent => ({
  details,
  label: "",
  stage: "input",
});

describe("getProgressStagedInputInfo romType from probe-manifest", () => {
  it("surfaces platform + disc format from the early probe manifest", () => {
    const info = getProgressStagedInputInfo(
      event({ probe_manifest: { disc_format: "CD", is_rom: true, platform: "Sony PlayStation" }, sourceId: "input-1" }),
    );
    expect(info.romType).toEqual({ discFormat: "CD", platform: "Sony PlayStation" });
  });

  it("surfaces a cartridge platform with no disc format", () => {
    const info = getProgressStagedInputInfo(
      event({ probe_manifest: { is_rom: true, platform: "Nintendo Game Boy Advance" }, sourceId: "input-1" }),
    );
    expect(info.romType).toEqual({ discFormat: undefined, platform: "Nintendo Game Boy Advance" });
  });

  it("leaves romType undefined when the manifest carries no identity (e.g. an archive)", () => {
    const info = getProgressStagedInputInfo(event({ probe_manifest: { is_rom: true }, sourceId: "input-1" }));
    expect(info.romType).toBeUndefined();
  });

  it("leaves romType undefined for non-manifest progress events", () => {
    const info = getProgressStagedInputInfo(event({ sourceId: "input-1", stage: "checksum" }));
    expect(info.romType).toBeUndefined();
  });
});

describe("getProgressStagedInputInfo checksumVariantPlan from probe-variant-plan", () => {
  it("surfaces the planned variant ids/labels from the early plan event", () => {
    const info = getProgressStagedInputInfo(
      event({
        checksum_variant_plan: [
          { id: "raw", label: "Raw" },
          { id: "remove-header", label: "Remove header" },
        ],
        sourceId: "input-1",
      }),
    );
    expect(info.checksumVariantPlan).toEqual([
      { id: "raw", label: "Raw" },
      { id: "remove-header", label: "Remove header" },
    ]);
  });

  it("keeps the well-formed entries and drops the malformed ones", () => {
    const info = getProgressStagedInputInfo(
      event({
        checksum_variant_plan: [{ id: "raw" }, { id: "raw", label: "Raw" }, { label: "no id" }, ["raw", "Raw"], 5],
        sourceId: "input-1",
      }),
    );
    expect(info.checksumVariantPlan).toEqual([{ id: "raw", label: "Raw" }]);
  });

  it("undefined-s a plan whose entries are all malformed", () => {
    const info = getProgressStagedInputInfo(
      event({ checksum_variant_plan: [{ id: "raw" }, { label: "no id" }, 5], sourceId: "input-1" }),
    );
    expect(info.checksumVariantPlan).toBeUndefined();
  });

  it("leaves checksumVariantPlan undefined for events without a plan", () => {
    const info = getProgressStagedInputInfo(event({ sourceId: "input-1", stage: "checksum" }));
    expect(info.checksumVariantPlan).toBeUndefined();
  });
});

describe("getProgressStagedInputInfo isRom from probe-manifest", () => {
  it("surfaces is_rom=true for a ROM-bearing archive (stays in the ROM bucket)", () => {
    const info = getProgressStagedInputInfo(event({ probe_manifest: { is_rom: true }, sourceId: "input-1" }));
    expect(info.isRom).toBe(true);
  });

  it("surfaces is_rom=false for a patch-only bundle (drives reclassification to the patch bucket)", () => {
    const info = getProgressStagedInputInfo(event({ probe_manifest: { is_rom: false }, sourceId: "input-1" }));
    expect(info.isRom).toBe(false);
  });

  it("leaves isRom undefined when the manifest omits the flag", () => {
    const info = getProgressStagedInputInfo(event({ probe_manifest: { platform: "Sony PlayStation" }, sourceId: "1" }));
    expect(info.isRom).toBeUndefined();
  });

  it("leaves isRom undefined for non-manifest progress events (bare ROMs never reclassify)", () => {
    const info = getProgressStagedInputInfo(event({ sourceId: "input-1", stage: "checksum" }));
    expect(info.isRom).toBeUndefined();
  });
});
