import { describe, expect, it } from "vitest";
import type { ApplyWorkflowInputState } from "../../src/types/apply-workflow.ts";
import { toPatchStageInfo, toStagedInputInfos } from "../../src/public/react/apply-workflow-staging-model.ts";

describe("apply workflow staging model", () => {
  it("reports a disc's combined raw-file checksum time on every grouped row", () => {
    const input: ApplyWorkflowInputState = {
      candidates: [],
      id: "disc",
      parentCompressions: [],
      resolvedInputs: [
        {
          checksumTimeMs: 136,
          fileName: "track-1.bin",
          groupId: "disc",
          id: "track-1",
          parentCompressions: [],
          selected: true,
        },
        {
          checksumTimeMs: 155,
          fileName: "track-2.bin",
          groupId: "disc",
          id: "track-2",
          parentCompressions: [],
          selected: true,
        },
      ],
      status: "ready",
      warnings: [],
    };

    expect(toStagedInputInfos(input, []).map((row) => row.checksumTiming)).toEqual(["291ms", "291ms"]);
  });

  it("shows the identified ROM title on the staged input row", () => {
    const input: ApplyWorkflowInputState = {
      candidates: [],
      id: "rom",
      identification: {
        matches: [
          {
            algorithm: "sha1",
            database: "gba.rwfp1",
            name: "Advance Wars (USA)",
            alternateNames: ["Advance Wars (U) [!]"],
            platform: "Game Boy Advance",
            variant: "raw",
          },
        ],
        status: "matched",
      },
      parentCompressions: [],
      status: "ready",
      warnings: [],
    };

    expect(toStagedInputInfos(input, [])[0]?.identificationStatus).toBe("matched");
    expect(toStagedInputInfos(input, [])[0]?.romInfo).toBe("Advance Wars (USA) · Advance Wars (U) [!]");
  });

  it("shows an expected ROM title in patch validation details", () => {
    const info = toPatchStageInfo(
      {
        candidates: [],
        id: "patch",
        parentCompressions: [],
        requirements: { sourceTitles: ["Advance Wars (USA)"] },
        status: "ready",
        warnings: [],
      },
      "hack.bps",
      0,
      "Input 1",
    );

    expect(info?.validationValues).toContain("in rom=Advance Wars (USA)");
    expect(info?.validationState).toBe("unknown");
  });
});
