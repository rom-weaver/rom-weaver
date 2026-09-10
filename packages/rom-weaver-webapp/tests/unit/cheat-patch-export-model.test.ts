import { describe, expect, it } from "vitest";

import {
  getCheatPatchCodes,
  getCheatPatchFileName,
  getCheatPatchFormat,
  getCheatPatchStatus,
  getRomCheats,
} from "../../src/public/react/cheat-patch-export-model.ts";
import { getCreatePatchFormatsForSizes } from "../../src/lib/create/patch-format-limits.ts";
import type { CheatRecord, ClassifiedCheatRecord } from "../../src/lib/cheats/index.ts";

const cheatRecord = (id: string, description: string, rawCode: string): CheatRecord => ({
  description,
  gameId: "smw-us",
  id,
  rawCode,
  rawFields: {},
  sourceFile: "Super Mario World (USA).cht",
  sourceIndex: 0,
  sourceRevision: "abc123",
  system: "snes",
});

const romCheat = (id: string, description: string, rawCode: string): ClassifiedCheatRecord => ({
  detectedKind: "game-genie",
  record: cheatRecord(id, description, rawCode),
  resolution: { type: "romBakeable", writes: [{ offset: 1, value: 2, width: 1 }] },
});

const ramCheat = (id: string, description: string): ClassifiedCheatRecord => ({
  detectedKind: "pro-action-replay",
  record: cheatRecord(id, description, "7E0DBE3F"),
  resolution: { reason: "the code targets runtime memory", type: "unsupported" },
});

const mixed = [
  romCheat("a", "Infinite lives", "C2B4-6D07"),
  ramCheat("b", "Infinite health"),
  romCheat("c", "Moon jump", "DDEE-1234"),
];

describe("getRomCheats", () => {
  it("keeps only the ROM-bakeable rows", () => {
    expect(getRomCheats(mixed).map(({ record }) => record.id)).toEqual(["a", "c"]);
  });
});

describe("getCheatPatchCodes", () => {
  it("returns only the ROM cheats' raw codes", () => {
    expect(getCheatPatchCodes(mixed)).toEqual(["C2B4-6D07", "DDEE-1234"]);
  });
});

describe("getCheatPatchFormat", () => {
  it("uses IPS below the 16 MiB IPS addressing limit and BPS at or above it", () => {
    expect(getCheatPatchFormat(4 * 1024 * 1024)).toBe("ips");
    expect(getCheatPatchFormat(16 * 1024 * 1024)).toBe("bps");
    expect(getCheatPatchFormat(undefined)).toBe("ips");
  });

  // Regression: past the legacy 256 MiB limit the create policy offers neither
  // IPS nor BPS, so hand-picking BPS made the run throw UNSUPPORTED_FORMAT.
  it("never returns a format the create policy excludes for that ROM size", () => {
    const huge = 500 * 1024 * 1024;
    expect(getCheatPatchFormat(huge)).toBe("xdelta");
    for (const size of [0, 1024, 16 * 1024 * 1024, 64 * 1024 * 1024, huge]) {
      expect(getCreatePatchFormatsForSizes(size)).toContain(getCheatPatchFormat(size));
    }
  });
});

describe("getCheatPatchFileName", () => {
  it("names up to three cheats and counts the rest", () => {
    const many = [
      romCheat("a", "One", "AAAA"),
      romCheat("b", "Two", "BBBB"),
      romCheat("c", "Three", "CCCC"),
      romCheat("d", "Four", "DDDD"),
      romCheat("e", "Five", "EEEE"),
    ];
    expect(getCheatPatchFileName("Super Mario World.sfc", many, "ips")).toBe(
      "Super Mario World - One + Two + Three and 2 more.ips",
    );
  });

  it("ignores the unbakeable cheats and keeps the format extension", () => {
    expect(getCheatPatchFileName("Super Mario World.sfc", mixed, "bps")).toBe(
      "Super Mario World - Infinite lives + Moon jump.bps",
    );
  });

  it("falls back to 'cheats' when no ROM cheat has a description", () => {
    expect(getCheatPatchFileName("game.sfc", [romCheat("a", "", "AAAA")], "ips")).toBe("game - cheats.ips");
  });

  it("replaces characters a file name cannot carry", () => {
    expect(getCheatPatchFileName("game.sfc", [romCheat("a", "Lives: 9/9", "AAAA")], "ips")).toBe(
      "game - Lives- 9-9.ips",
    );
  });

  it("caps a very long description suffix with an ellipsis", () => {
    const name = getCheatPatchFileName("game.sfc", [romCheat("a", "A".repeat(200), "AAAA")], "ips");
    expect(name).toBe(`game - ${"A".repeat(80)}….ips`);
  });
});

describe("getCheatPatchStatus", () => {
  it("counts the baked cheats", () => {
    expect(getCheatPatchStatus("game - A.ips", 2)).toBe("Created game - A.ips from the 2 ROM cheats that are On.");
    expect(getCheatPatchStatus("game - A.ips", 1)).toBe("Created game - A.ips from the 1 ROM cheat that is On.");
  });
});
