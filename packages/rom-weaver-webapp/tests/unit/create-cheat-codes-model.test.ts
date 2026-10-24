import { describe, expect, it } from "vitest";
import { createLocalizer, preloadCatalog } from "../../src/presentation/localization/index.ts";

import {
  describeCheatCodes,
  formatCheatWrite,
  getCheatCodesPatchName,
  getCheatCodesValidationMessage,
  getCheatCodeWrites,
  getCheatCompareLabel,
  getClassifiedCheatCodes,
  splitPlainCheatCodes,
  type CreateCheatCodeEntry,
} from "../../src/public/react/create-cheat-codes-model.ts";
import type { ClassifiedCheatRecord } from "../../src/lib/cheats/index.ts";

const record = (
  overrides: Partial<ClassifiedCheatRecord> & { resolution: ClassifiedCheatRecord["resolution"] },
): ClassifiedCheatRecord => ({
  detectedKind: "game-genie",
  record: {
    description: "Infinite lives",
    gameId: "smb",
    id: "cheat-1",
    rawCode: "SXIOPO",
    rawFields: {},
    sourceFile: "manual",
    sourceIndex: 0,
    sourceRevision: "manual",
    system: "nes",
  },
  ...overrides,
});

const entry = (overrides: Partial<CreateCheatCodeEntry> = {}): CreateCheatCodeEntry => ({
  code: "SXIOPO",
  description: "Infinite lives",
  id: "0:SXIOPO",
  record: record({ resolution: { type: "romBakeable", writes: [{ offset: 0x4000, value: 0x12, width: 1 }] } }),
  ...overrides,
});

// The Xploder and GBA pairing rules live in Rust (`cheats::split_for_kind`, run
// against crates/rom-weaver-cli/tests/fixtures/cheat-code-splits.json); the UI
// reads the engine's `codes` and only falls back to the plain split.
describe("splitPlainCheatCodes", () => {
  it("splits on +, commas, semicolons, whitespace, keeping intra-code separators", () => {
    expect(splitPlainCheatCodes("SXIOPO+AEEPYZ, GXNENV;004-BCE-E66\nAAAAAA")).toEqual([
      "SXIOPO",
      "AEEPYZ",
      "GXNENV",
      "004-BCE-E66",
      "AAAAAA",
    ]);
    expect(splitPlainCheatCodes("  \n + , ")).toEqual([]);
  });
});

describe("getClassifiedCheatCodes", () => {
  it("returns the engine's split codes untouched", () => {
    const classified = record({
      codes: ["800B4CD40063"],
      resolution: { type: "unsupported", reason: "x" },
    });
    classified.record.rawCode = "800B4CD4 0063";
    expect(getClassifiedCheatCodes(classified)).toEqual(["800B4CD40063"]);
  });

  it("falls back to the plain split when the record carries no codes", () => {
    const classified = record({ resolution: { type: "unsupported", reason: "x" } });
    classified.record.rawCode = "AAA+BBB";
    expect(getClassifiedCheatCodes(classified)).toEqual(["AAA", "BBB"]);
  });
});

describe("formatCheatWrite", () => {
  it("renders the offset and value as hex, sizing the value by the write width", () => {
    expect(formatCheatWrite({ offset: 0x4000, value: 0x12, width: 1 })).toBe("$004000 ← $12");
    expect(formatCheatWrite({ offset: 0x20, value: 0x1234, width: 2 })).toBe("$000020 ← $1234");
  });
});

describe("getCheatCompareLabel", () => {
  it("names the compare byte only when the classifier reported one", () => {
    expect(getCheatCompareLabel({ compare: 0xff, offset: 0, value: 1, width: 1 }, createLocalizer("en"))).toBe(
      "compare $FF found",
    );
    expect(getCheatCompareLabel({ offset: 0, value: 1, width: 1 }, createLocalizer("en"))).toBe("");
    expect(getCheatCompareLabel({ compare: null, offset: 0, value: 1, width: 1 }, createLocalizer("en"))).toBe("");
  });
});

describe("getCheatCodeWrites", () => {
  it("reads writes from romBakeable records and nothing else", () => {
    expect(getCheatCodeWrites(entry().record)).toHaveLength(1);
    expect(getCheatCodeWrites(record({ resolution: { reason: "nope", type: "unsupported" } }))).toHaveLength(0);
    expect(getCheatCodeWrites(undefined)).toHaveLength(0);
  });
});

describe("describeCheatCodes", () => {
  it("reads the system, code type and total write count off the classifier", () => {
    expect(describeCheatCodes([entry(), entry({ id: "1:AEEPYZ" })], createLocalizer("en"))).toBe(
      "NES · Game Genie · 2 writes",
    );
  });

  it("says nothing until a code has been classified", () => {
    expect(describeCheatCodes([entry({ record: undefined })], createLocalizer("en"))).toBe("");
  });

  it("does not claim one system or code type when the codes disagree", () => {
    const other = entry({
      detectedKind: "pro-action-replay",
      id: "1:X",
      record: record({
        detectedKind: "pro-action-replay",
        resolution: { type: "romBakeable", writes: [] },
      }),
    } as never);
    expect(describeCheatCodes([entry(), other], createLocalizer("en"))).toBe("NES · Mixed code types · 1 write");
  });
});

describe("getCheatCodesPatchName", () => {
  it("joins the original name with the first cheat description and the format", () => {
    expect(getCheatCodesPatchName("Zelda (USA).nes", [entry()], "ips")).toBe("Zelda (USA) - Infinite lives.ips");
  });

  // Created patch names need the same filename sanitization as applied outputs.
  it("replaces characters a file name cannot carry", () => {
    expect(getCheatCodesPatchName("Zelda.nes", [entry({ description: "Lives: 9/9 <max>" })], "ips")).toBe(
      "Zelda - Lives- 9-9 -max-.ips",
    );
  });

  it("caps a very long description with an ellipsis", () => {
    const name = getCheatCodesPatchName("Zelda.nes", [entry({ description: "A".repeat(200) })], "ips");
    expect(name).toBe(`Zelda - ${"A".repeat(80)}….ips`);
  });

  it("falls back to '- cheats' when no code carries a description", () => {
    expect(getCheatCodesPatchName("Zelda (USA).nes", [entry({ description: "" })], "bps")).toBe(
      "Zelda (USA) - cheats.bps",
    );
  });
});

describe("getCheatCodesValidationMessage", () => {
  it("blocks the run when there are no codes", () => {
    expect(getCheatCodesValidationMessage([], false, createLocalizer("en"))).toContain("at least one cheat code");
  });

  it("blocks the run while a classification is still in flight", () => {
    expect(getCheatCodesValidationMessage([entry()], true, createLocalizer("en"))).toContain("Checking");
  });

  it("allows the run once every code is ROM-bakeable", () => {
    expect(getCheatCodesValidationMessage([entry()], false, createLocalizer("en"))).toBe("");
  });

  it("names the code the decoder could not resolve into ROM writes", () => {
    const blocked = entry({
      id: "1:BLOCKED",
      record: record({ resolution: { reason: "the code targets runtime memory", type: "unsupported" } }),
    });
    expect(getCheatCodesValidationMessage([entry(), blocked], false, createLocalizer("en"))).toBe(
      "SXIOPO: the code targets runtime memory",
    );
  });

  it("reports the classifier's own complaint verbatim", () => {
    expect(
      getCheatCodesValidationMessage([entry({ error: "bad code", record: undefined })], false, createLocalizer("en")),
    ).toBe("SXIOPO: bad code");
  });
});

describe("cheat code readouts in German", () => {
  it("translates the detected line, compare badge, and validation messages", async () => {
    await preloadCatalog("de");
    const de = createLocalizer("de");
    expect(describeCheatCodes([entry(), entry({ id: "1:AEEPYZ" })], de)).toBe("NES · Game Genie · 2 Schreibvorgänge");
    expect(getCheatCompareLabel({ compare: 0xff, offset: 0, value: 1, width: 1 }, de)).toBe("Vergleich $FF gefunden");
    expect(getCheatCodesValidationMessage([], false, de)).toContain("mindestens einen Cheat-Code");
  });
});
