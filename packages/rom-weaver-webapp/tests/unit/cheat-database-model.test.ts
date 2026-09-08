import { describe, expect, it } from "vitest";
import {
  filterCheats,
  matchCheatGame,
  reconcileSelectedCheatIds,
  resolveCheatDatabaseEntry,
  selectManualGame,
  type CheatDatabaseEntry,
  type CheatDatabaseIndex,
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

const entryFor = (
  platform: string,
  slug: string,
  cheatSystem: CheatDatabaseEntry["cheatSystem"],
): CheatDatabaseEntry => ({
  platform,
  slug,
  cheatSystem,
  file: `cheats-${slug}.json`,
  rawBytes: 10,
  sha256: "b".repeat(64),
  games: 1,
  cheats: 1,
});

const snesEntry = entryFor(
  "Nintendo - Super Nintendo Entertainment System",
  "nintendo-super-nintendo-entertainment-system",
  "snes",
);
const gameBoyEntry = entryFor("Nintendo - Game Boy", "nintendo-game-boy", "gameboy");
const gameBoyColorEntry = entryFor("Nintendo - Game Boy Color", "nintendo-game-boy-color", "gameboy-color");
const index: CheatDatabaseIndex = {
  sourceRevision: "abc123",
  sourceUrl: "https://github.com/libretro/libretro-database",
  license: "CC-BY-SA-4.0",
  entries: [snesEntry, gameBoyEntry, gameBoyColorEntry],
};
const catalog = {
  format: "rom-weaver-identify-catalog-v1",
  platforms: [
    {
      aliases: ["snes", "super famicom"],
      canonicalPlatform: "Nintendo - Super Nintendo Entertainment System",
      mediaProfiles: [],
      packFormat: "RWFP1",
      packSha256: "",
      packSlug: "nintendo-super-nintendo-entertainment-system",
      source: "libretro" as const,
    },
  ],
};

describe("cheat database catalog", () => {
  it("matches a known checksum before it considers the title", () => {
    expect(
      matchCheatGame(
        { key: "rom-a", platform: snesEntry.platform, title: "Wrong title", checksums: { sha1: "aa11" } },
        snesEntry,
        shard,
      ),
    ).toMatchObject({ kind: "exact", game: { id: "smw-us" } });
  });

  it("marks a title-only and manual match as unverified", () => {
    expect(
      matchCheatGame(
        { key: "rom-a", platform: snesEntry.platform, fileName: "Super Mario World (Europe).sfc" },
        snesEntry,
        shard,
      ),
    ).toMatchObject({ kind: "title", game: { id: "smw-us" } });
    expect(selectManualGame(shard, "smw-us")).toMatchObject({ kind: "manual", game: { id: "smw-us" } });
  });

  it("does not offer unsupported systems", () => {
    expect(matchCheatGame({ key: "rom-a", platform: "Nintendo - Nintendo 64" }, undefined, undefined)).toEqual({
      kind: "unsupported-system",
      platform: "Nintendo - Nintendo 64",
    });
  });

  it("resolves a platform tag through the identify catalog aliases", () => {
    expect(resolveCheatDatabaseEntry(index, catalog, { platform: "super famicom" })).toBe(snesEntry);
    expect(
      resolveCheatDatabaseEntry(index, catalog, { platform: "Nintendo Super Nintendo Entertainment System" }),
    ).toBe(snesEntry);
    expect(resolveCheatDatabaseEntry(index, catalog, { platform: "Nintendo - Nintendo 64" })).toBeUndefined();
    expect(resolveCheatDatabaseEntry(index, catalog, null)).toBeUndefined();
    expect(resolveCheatDatabaseEntry(undefined, catalog, { platform: "snes" })).toBeUndefined();
  });

  it("falls back to the index platform names without a catalog", () => {
    expect(resolveCheatDatabaseEntry(index, undefined, { platform: "Nintendo Game Boy" })).toBe(gameBoyEntry);
  });

  it("falls back to the cartridge extension when ingest reported no platform tag", () => {
    expect(resolveCheatDatabaseEntry(index, catalog, { fileName: "game.GBA" })).toBeUndefined();
    expect(resolveCheatDatabaseEntry(index, catalog, { fileName: "game.gbc" })).toBe(gameBoyColorEntry);
    expect(resolveCheatDatabaseEntry(index, catalog, { fileName: "game.gb" })).toBe(gameBoyEntry);
    expect(resolveCheatDatabaseEntry(index, catalog, { fileName: "game.nes" })).toBeUndefined();
  });

  it("uses the .gbc extension to split Game Boy Color from the shared Game Boy header", () => {
    expect(resolveCheatDatabaseEntry(index, undefined, { platform: "Nintendo Game Boy", fileName: "a.gbc" })).toBe(
      gameBoyColorEntry,
    );
    expect(resolveCheatDatabaseEntry(index, undefined, { platform: "Nintendo Game Boy", fileName: "a.gb" })).toBe(
      gameBoyEntry,
    );
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
