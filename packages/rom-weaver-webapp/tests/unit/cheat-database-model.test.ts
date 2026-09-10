import { describe, expect, it } from "vitest";
import {
  filterCheats,
  isCheatDatabaseSystem,
  isCheatManualSystem,
  matchCheatGame,
  reconcileSelectedCheatIds,
  resolveCheatDatabaseEntry,
  resolveManualOnlyCheatSystem,
  selectManualGame,
  type CheatDatabaseEntry,
  type CheatDatabaseIndex,
  type CheatDatabaseRecord,
  type CheatSystemShard,
  type CheatRecord,
  type ClassifiedCheatRecord,
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

const cheatRecord = (id: string, description: string): CheatRecord => ({
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
    record: cheatRecord("rom", "Infinite lives"),
    resolution: { type: "romBakeable", writes: [] },
    detectedKind: null,
  },
  {
    record: cheatRecord("ram", "Infinite health"),
    resolution: { type: "unsupported", reason: "the code targets runtime memory" },
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
const masterSystemEntry = entryFor("Sega - Master System - Mark III", "sega-master-system-mark-iii", "mastersystem");
const gameGearEntry = entryFor("Sega - Game Gear", "sega-game-gear", "gamegear");
const megaDriveEntry = entryFor("Sega - Mega Drive - Genesis", "sega-mega-drive-genesis", "genesis");
const sega32xEntry = entryFor("Sega - 32X", "sega-32x", "sega32x");
const index: CheatDatabaseIndex = {
  sourceRevision: "abc123",
  sourceUrl: "https://github.com/libretro/libretro-database",
  license: "CC-BY-SA-4.0",
  entries: [snesEntry, gameBoyEntry, gameBoyColorEntry, masterSystemEntry, gameGearEntry, megaDriveEntry, sega32xEntry],
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

  it("separates database-backed systems from decoder-only ones", () => {
    expect(isCheatDatabaseSystem("snes")).toBe(true);
    expect(isCheatDatabaseSystem("playstation")).toBe(false);
    expect(isCheatManualSystem("snes")).toBe(true);
    expect(isCheatManualSystem("playstation")).toBe(true);
    expect(isCheatManualSystem("n64")).toBe(false);
    expect(isCheatManualSystem(undefined)).toBe(false);
  });

  it("resolves a decoder-only platform the index does not cover", () => {
    expect(resolveManualOnlyCheatSystem(catalog, { platform: "Sony - PlayStation" })).toBe("playstation");
    expect(resolveManualOnlyCheatSystem(undefined, { platform: "psx" })).toBe("playstation");
    expect(resolveManualOnlyCheatSystem(undefined, { platform: "Sony - PlayStation 2" })).toBeUndefined();
    expect(resolveManualOnlyCheatSystem(catalog, { platform: "snes" })).toBeUndefined();
    expect(resolveManualOnlyCheatSystem(catalog, null)).toBeUndefined();
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
    expect(resolveCheatDatabaseEntry(index, catalog, { fileName: "game.sms" })).toBe(masterSystemEntry);
    expect(resolveCheatDatabaseEntry(index, catalog, { fileName: "game.gg" })).toBe(gameGearEntry);
    expect(resolveCheatDatabaseEntry(index, catalog, { fileName: "game.32x" })).toBe(sega32xEntry);
  });

  it("uses the extension to split consoles that share a ROM header", () => {
    expect(
      resolveCheatDatabaseEntry(index, undefined, { platform: "Sega Master System Mark III", fileName: "a.gg" }),
    ).toBe(gameGearEntry);
    expect(
      resolveCheatDatabaseEntry(index, undefined, { platform: "Sega Master System Mark III", fileName: "a.sms" }),
    ).toBe(masterSystemEntry);
    expect(
      resolveCheatDatabaseEntry(index, undefined, { platform: "Sega Mega Drive Genesis", fileName: "a.32x" }),
    ).toBe(sega32xEntry);
    expect(resolveCheatDatabaseEntry(index, undefined, { platform: "Sega Mega Drive Genesis", fileName: "a.md" })).toBe(
      megaDriveEntry,
    );
  });

  it("uses the .gbc extension to split Game Boy Color from the shared Game Boy header", () => {
    expect(resolveCheatDatabaseEntry(index, undefined, { platform: "Nintendo Game Boy", fileName: "a.gbc" })).toBe(
      gameBoyColorEntry,
    );
    expect(resolveCheatDatabaseEntry(index, undefined, { platform: "Nintendo Game Boy", fileName: "a.gb" })).toBe(
      gameBoyEntry,
    );
  });

  it("searches descriptions and codes", () => {
    expect(filterCheats(classified, "health").map(({ record }) => record.id)).toEqual(["ram"]);
    expect(filterCheats(classified, "").map(({ record }) => record.id)).toEqual(["rom", "ram"]);
    expect(filterCheats(classified, "c2b4").map(({ record }) => record.id)).toEqual(["rom", "ram"]);
  });

  it("keeps only selections that exist after records change", () => {
    expect([...reconcileSelectedCheatIds(new Set(["rom", "gone"]), classified)]).toEqual(["rom"]);
  });
});
