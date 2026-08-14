import { describe, expect, it } from "vitest";
import { patchProbeRequirementsFromDescriptor } from "../../src/lib/apply/patch-apply-service.ts";

describe("patch source identification", () => {
  it("maps local title matches into patch source requirements", () => {
    const requirements = patchProbeRequirementsFromDescriptor({
      fileName: "hack.bps",
      filenameChecksums: {},
      format: "BPS",
      isValidPatch: true,
      leafPath: "/work/hack.bps",
      sizeBytes: 128,
      sourceIdentification: {
        matches: [
          {
            algorithm: "crc32",
            database: "gba.rwfp1",
            name: "Advance Wars (USA)",
            platform: "Game Boy Advance",
            variant: "source",
          },
        ],
        status: "matched",
      },
    });

    expect(requirements?.sourceTitles).toEqual(["Advance Wars (USA)"]);
  });
});
