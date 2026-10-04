import type { CheatDatabaseIndex, CheatSystemShard } from "../../lib/cheats/index.ts";

const PRACTICE_ROM_SHA1 = "22f56591eb4dbb85fbb6398cd0c4554558f70603";

const PRACTICE_CHEAT_INDEX: CheatDatabaseIndex = {
  entries: [
    {
      cheatSystem: "nes",
      cheats: 2,
      file: "cheats-nintendo-nintendo-entertainment-system.json",
      games: 1,
      platform: "Nintendo Entertainment System",
      rawBytes: 0,
      sha256: "practice",
      slug: "nintendo-nintendo-entertainment-system",
    },
  ],
  license: "CC0-1.0",
  sourceRevision: "rom-weaver-practice-v1",
  sourceUrl: "https://rom-weaver.com/",
};

const PRACTICE_CHEAT_SHARD: CheatSystemShard = {
  schemaVersion: 2,
  system: "nes",
  games: [
    {
      checksums: [{ sha1: PRACTICE_ROM_SHA1, size: 24_592 }],
      cheats: [
        {
          codeKind: "pro-action-replay",
          description: "Make the greeting start with M",
          gameId: "rom-weaver-practice",
          id: "practice_greeting_m",
          rawCode: "80970D",
          rawFields: { code: "80970D", desc: "Make the greeting start with M", enable: "false" },
          sourceFile: "rom-weaver-practice",
          sourceIndex: 0,
          sourceRevision: "rom-weaver-practice-v1",
          system: "nes",
        },
        {
          codeKind: "pro-action-replay",
          description: "Change the background color",
          gameId: "rom-weaver-practice",
          id: "practice_background_color",
          rawCode: "8077300F",
          rawFields: { code: "8077300F", desc: "Change the background color", enable: "false" },
          sourceFile: "rom-weaver-practice",
          sourceIndex: 1,
          sourceRevision: "rom-weaver-practice-v1",
          system: "nes",
        },
      ],
      id: "rom-weaver-practice",
      normalizedTitle: "rom weaver practice",
      regions: ["World"],
      revisions: ["1.0"],
      title: "RomWeaver practice ROM",
    },
  ],
};

const getPracticeCheatCatalog = (checksums?: Record<string, string | string[]> | null) => {
  const sha1 = checksums?.sha1;
  if (sha1 !== PRACTICE_ROM_SHA1 && !(Array.isArray(sha1) && sha1.includes(PRACTICE_ROM_SHA1))) return {};
  return { index: PRACTICE_CHEAT_INDEX, shard: PRACTICE_CHEAT_SHARD };
};

export { getPracticeCheatCatalog, PRACTICE_CHEAT_SHARD, PRACTICE_ROM_SHA1 };
