import { describe, expect, it } from "vitest";

import {
  describeCheatCodes,
  formatCheatWrite,
  getCheatCodesPatchName,
  getCheatCodesValidationMessage,
  getCheatCodeWrites,
  getCheatCompareLabel,
  splitCheatCodes,
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

describe("splitCheatCodes", () => {
  it("splits on +, commas, newlines and spaces, keeping intra-code separators", () => {
    expect(splitCheatCodes("SXIOPO+AEEPYZ, GXNENV\n004-BCE-E66")).toEqual([
      "SXIOPO",
      "AEEPYZ",
      "GXNENV",
      "004-BCE-E66",
    ]);
  });

  it("returns nothing for blank input", () => {
    expect(splitCheatCodes("  \n + , ")).toEqual([]);
  });

  // Regression: whitespace splitting alone tore an Xploder code in half, so
  // "800B4CD4 0063" reached the classifier as two unusable codes.
  it("keeps an 8+4 Xploder pair together for PlayStation", () => {
    expect(splitCheatCodes("800B4CD4 0063", "playstation")).toEqual(["800B4CD40063"]);
  });

  it("keeps a four-word GBA ROM patch together", () => {
    expect(splitCheatCodes("00000000 1801F2E0 00000063 00000000", "gameboyadvance")).toEqual([
      "000000001801F2E00000006300000000",
    ]);
  });

  it("uses the Xploder splitter when the kind override says so, whatever the system", () => {
    expect(splitCheatCodes("800B4CD4 0063", "nes", "xploder")).toEqual(["800B4CD40063"]);
  });

  it("keeps the plain split for systems whose codes are single words", () => {
    expect(splitCheatCodes("SXIOPO AEEPYZ", "nes")).toEqual(["SXIOPO", "AEEPYZ"]);
  });

  it("splits on semicolons the way the engine does", () => {
    expect(splitCheatCodes("SXIOPO;AEEPYZ", "nes")).toEqual(["SXIOPO", "AEEPYZ"]);
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
    expect(getCheatCompareLabel({ compare: 0xff, offset: 0, value: 1, width: 1 })).toBe("compare $FF found");
    expect(getCheatCompareLabel({ offset: 0, value: 1, width: 1 })).toBe("");
    expect(getCheatCompareLabel({ compare: null, offset: 0, value: 1, width: 1 })).toBe("");
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
    expect(describeCheatCodes([entry(), entry({ id: "1:AEEPYZ" })])).toBe("NES · Game Genie · 2 writes");
  });

  it("says nothing until a code has been classified", () => {
    expect(describeCheatCodes([entry({ record: undefined })])).toBe("");
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
    expect(describeCheatCodes([entry(), other])).toBe("NES · Mixed code types · 1 write");
  });
});

describe("getCheatCodesPatchName", () => {
  it("joins the original name with the first cheat description and the format", () => {
    expect(getCheatCodesPatchName("Zelda (USA).nes", [entry()], "ips")).toBe("Zelda (USA) - Infinite lives.ips");
  });

  // Regression: only the apply-side name builder sanitized these characters.
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
    expect(getCheatCodesValidationMessage([], false)).toContain("at least one cheat code");
  });

  it("blocks the run while a classification is still in flight", () => {
    expect(getCheatCodesValidationMessage([entry()], true)).toContain("Checking");
  });

  it("allows the run once every code is ROM-bakeable", () => {
    expect(getCheatCodesValidationMessage([entry()], false)).toBe("");
  });

  it("names the code the decoder could not resolve into ROM writes", () => {
    const blocked = entry({
      id: "1:BLOCKED",
      record: record({ resolution: { reason: "the code targets runtime memory", type: "unsupported" } }),
    });
    expect(getCheatCodesValidationMessage([entry(), blocked], false)).toBe("SXIOPO: the code targets runtime memory");
  });

  it("reports the classifier's own complaint verbatim", () => {
    expect(getCheatCodesValidationMessage([entry({ error: "bad code", record: undefined })], false)).toBe(
      "SXIOPO: bad code",
    );
  });
});
