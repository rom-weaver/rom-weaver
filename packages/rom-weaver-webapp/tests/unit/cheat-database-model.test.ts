import { describe, expect, it } from "vitest";
import {
  filterCheats,
  matchCheatGame,
  reconcileSelectedCheatIds,
  selectManualGame,
  type CheatDatabaseRecord,
  type CheatSystemShard,
  type ClassifiedCheatRecord,
  type RuntimeCheatRecord,
} from "../../src/lib/cheats/index.ts";

const raw = (id: string, description: string): CheatDatabaseRecord => ({
  id,
  system: "snes",
  gameId: "smw-us",
  description,
  rawCode: "C2B4-6D07",
  rawFields: { code: "C2B4-6D07" },
  sourceFile: "Nintendo - Super Nintendo Entertainment System/Super Mario World (USA).cht",
  sourceIndex: 0,
  sourceRevision: "abc123",
});

const runtimeRecord = (id: string, description: string): RuntimeCheatRecord => ({
  id,
  system: "snes",
  gameId: "smw-us",
  description,
  rawCode: "C2B4-6D07",
  rawFields: { code: "C2B4-6D07" },
  sourceFile: "Nintendo - Super Nintendo Entertainment System/Super Mario World (USA).cht",
  sourceIndex: 0,
  sourceRevision: "abc123",
});

const shard: CheatSystemShard = {
  schemaVersion: 1,
  system: "snes",
  games: [
    {
      id: "smw-us",
      title: "Super Mario World",
      normalizedTitle: "super mario world",
      regions: ["USA"],
      revisions: ["Rev 1"],
      sourceFiles: ["Super Mario World (USA).cht"],
      checksums: [{ sha1: "AA11", crc32: "BB22" }, { crc32: "CC33" }],
      cheats: [raw("rom", "Infinite lives"), raw("ram", "Infinite health")],
    },
  ],
};

const classified: ClassifiedCheatRecord[] = [
  {
    record: runtimeRecord("rom", "Infinite lives"),
    resolution: { type: "romBakeable", writes: [] },
    detectedKind: null,
  },
  {
    record: runtimeRecord("ram", "Infinite health"),
    resolution: { type: "runtime", payload: { record: runtimeRecord("ram", "Infinite health") } },
    detectedKind: null,
  },
  {
    record: runtimeRecord("mixed", "Moon jump"),
    resolution: {
      type: "mixed",
      writes: [],
      payload: { record: runtimeRecord("mixed", "Moon jump") },
    },
    detectedKind: null,
  },
  {
    record: runtimeRecord("parameter", "Starting lives XX"),
    resolution: {
      type: "requiresParameter",
      payload: { record: runtimeRecord("parameter", "Starting lives XX") },
    },
    detectedKind: null,
  },
];

describe("cheat database catalog", () => {
  it("matches a known checksum before it considers the title", () => {
    expect(
      matchCheatGame({ key: "rom-a", system: "snes", title: "Wrong title", checksums: { sha1: "aa11" } }, shard),
    ).toMatchObject({ kind: "exact", game: { id: "smw-us" } });
  });

  it("marks a title-only and manual match as unverified", () => {
    expect(
      matchCheatGame({ key: "rom-a", system: "snes", fileName: "Super Mario World (Europe).sfc" }, shard),
    ).toMatchObject({ kind: "title", game: { id: "smw-us" } });
    expect(selectManualGame(shard, "smw-us")).toMatchObject({ kind: "manual", game: { id: "smw-us" } });
  });

  it("does not offer unsupported systems", () => {
    expect(matchCheatGame({ key: "rom-a", system: "n64" }, undefined)).toEqual({
      kind: "unsupported-system",
      system: "n64",
    });
  });

  it("searches descriptions and filters the Rust classification results", () => {
    expect(filterCheats(classified, "health", "all").map(({ record }) => record.id)).toEqual(["ram"]);
    expect(filterCheats(classified, "", "rom").map(({ record }) => record.id)).toEqual(["rom"]);
    expect(filterCheats(classified, "", "runtime").map(({ record }) => record.id)).toEqual(["ram", "mixed"]);
    expect(filterCheats(classified, "", "requires-parameter").map(({ record }) => record.id)).toEqual(["parameter"]);
  });

  it("keeps only selections that exist after records change", () => {
    expect([...reconcileSelectedCheatIds(new Set(["rom", "gone"]), classified)]).toEqual(["rom"]);
  });
});
