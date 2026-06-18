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
