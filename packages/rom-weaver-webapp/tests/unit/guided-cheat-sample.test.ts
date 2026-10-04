import { describe, expect, it } from "vitest";
import { resolveCheatDatabaseEntry } from "../../src/lib/cheats/index.ts";
import {
  getPracticeCheatCatalog,
  PRACTICE_CHEAT_SHARD,
  PRACTICE_ROM_SHA1,
} from "../../src/public/react/guided-cheat-sample.ts";

describe("guided cheat sample catalog", () => {
  it("is available only for the bundled practice ROM checksum", () => {
    expect(getPracticeCheatCatalog({ sha1: PRACTICE_ROM_SHA1 })).toMatchObject({ shard: PRACTICE_CHEAT_SHARD });
    expect(getPracticeCheatCatalog({ sha1: ["other", PRACTICE_ROM_SHA1] })).toMatchObject({
      shard: PRACTICE_CHEAT_SHARD,
    });
    expect(getPracticeCheatCatalog({ sha1: "other" })).toEqual({});
    expect(getPracticeCheatCatalog()).toEqual({});
  });

  it("contains deterministic NES ROM writes for visible text and color bytes", () => {
    expect(PRACTICE_CHEAT_SHARD.games[0]?.cheats).toMatchObject([
      { description: "Make the greeting start with M", rawCode: "80970D" },
      { description: "Change the background color", rawCode: "8077300F" },
    ]);
  });

  it("resolves the practice entry for the platform returned by NES ingestion", () => {
    const catalog = getPracticeCheatCatalog({ sha1: PRACTICE_ROM_SHA1 });
    expect(
      resolveCheatDatabaseEntry(catalog.index, undefined, {
        fileName: "hello-world.nes",
        platform: "Nintendo Entertainment System",
      }),
    ).toMatchObject({ cheatSystem: "nes", slug: "nintendo-nintendo-entertainment-system" });
  });
});
