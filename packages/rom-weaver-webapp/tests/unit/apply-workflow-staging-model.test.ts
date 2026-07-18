import { describe, expect, it } from "vitest";
import type { ApplyWorkflowInputState } from "../../src/types/apply-workflow.ts";
import { toStagedInputInfos } from "../../src/public/react/apply-workflow-staging-model.ts";

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
});
