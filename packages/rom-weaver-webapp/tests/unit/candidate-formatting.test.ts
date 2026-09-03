import { describe, expect, it } from "vitest";
import { getCandidateDisplayItems } from "../../src/presentation/formatting/candidates.ts";
import { createLocalizer } from "../../src/presentation/localization/index.ts";
import type { CandidateSelectionRequest } from "../../src/types/selection.ts";

describe("candidate display formatting", () => {
  it("associates files with groups and combines their warnings", () => {
    const request: CandidateSelectionRequest = {
      candidates: [
        {
          candidateIds: ["track-1"],
          id: "disc-1",
          kind: "cue-disc",
          label: "Disc 1",
          selectable: true,
          type: "group",
          warnings: ["Track set is incomplete"],
        },
        {
          fileName: "track01.bin",
          id: "track-1",
          kind: "track",
          reason: "Track needs its cue file",
          selectable: true,
          size: 1500,
          type: "file",
        },
        {
          fileName: "readme.txt",
          id: "readme",
          kind: "unknown",
          selectable: false,
          size: Number.NaN,
          type: "file",
        },
      ],
      role: "input",
      sourceName: "disc.zip",
      warnings: ["Archive contains extra files"],
    };

    const items = getCandidateDisplayItems(request, createLocalizer("en"));

    expect(items[0]).toMatchObject({
      metadata: "",
      sizeLabel: "",
      warnings: ["Track set is incomplete", "Archive contains extra files"],
    });
    expect(items[1]).toMatchObject({
      group: request.candidates[0],
      metadata: "1.5 KB",
      sizeLabel: "1.5 KB",
      warningLabel: "3 warning(s)",
      warnings: ["Track needs its cue file", "Track set is incomplete", "Archive contains extra files"],
    });
    expect(items[2]).toMatchObject({
      group: undefined,
      metadata: "",
      sizeLabel: "",
      warningLabel: "1 warning(s)",
      warnings: ["Archive contains extra files"],
    });
  });
});
