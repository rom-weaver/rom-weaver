import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { LIBRETRO_PLATFORM_PATHS, packGroupFor } from "./build-identify-index.mjs";
import {
  CHEAT_PLATFORMS,
  CHEAT_SHARD_SCHEMA_VERSION,
  buildCheatShard,
  cheatShardFileName,
  encodeCheatShard,
  normalizeReleaseName,
  parseCht,
  releasesFromIdentifyGames,
  stableCheatId,
} from "./import-libretro-cheats.mjs";

const REVISION = "4968f556a0bf749378901086646b78bc78703b88";
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "libretro-cheats");
const NES_DIRECTORY = "cht/Nintendo - Nintendo Entertainment System";

const fixtureFiles = () =>
  ["Test Game (USA).cht", "Test Game (USA) (Game Genie).cht", "Unknown Homebrew (World).cht"].map(
    (name) => ({
      sourcePath: `${NES_DIRECTORY}/${name}`,
      text: readFileSync(path.join(FIXTURE_ROOT, ...NES_DIRECTORY.split("/"), name), "utf8"),
    }),
  );

// The shape parseLibretroGames emits for one platform game record.
const identifyGames = () => [
  {
    components: [
      {
        crc32: "abcdef01",
        filename: "Test Game (USA).nes",
        md5: "0123456789abcdef0123456789abcdef",
        ordinal: 0,
        sha1: "0123456789abcdef0123456789abcdef01234567",
        size: 24592,
      },
    ],
    legacyVariant: false,
    name: "Test Game (USA)",
    region: "USA",
  },
  {
    components: [{ crc32: "11111111", ordinal: 0, size: 8 }],
    legacyVariant: true,
    name: "Test Game (U) [!]",
  },
];

test("every cheat platform is an identify platform in the default group", () => {
  for (const [platform, spec] of Object.entries(CHEAT_PLATFORMS)) {
    assert.ok(LIBRETRO_PLATFORM_PATHS[platform], `${platform} has no identify pack`);
    assert.equal(packGroupFor(platform), "default");
    assert.equal(spec.directory, `cht/${platform}`);
  }
  assert.deepEqual(
    Object.values(CHEAT_PLATFORMS)
      .map((spec) => spec.cheatSystem)
      .sort(),
    ["gameboy", "gameboy-color", "gameboyadvance", "genesis", "nes", "snes"],
  );
  assert.equal(cheatShardFileName("nintendo-game-boy"), "cheats-nintendo-game-boy.json");
});

test("parseCht tolerates real-world indexes, counts, quoting, and fields", () => {
  const source = readFileSync(
    path.join(FIXTURE_ROOT, ...NES_DIRECTORY.split("/"), "Test Game (USA).cht"),
    "utf8",
  );
  const records = parseCht(source, {
    sourceFile: "cht/Test Game (USA).cht",
    sourceRevision: REVISION,
  });

  assert.deepEqual(
    records.map((record) => record.sourceIndex),
    [0, 2, 7],
  );
  assert.equal(records[0].description, 'Infinite "Things"');
  assert.equal(records[0].rawFields.unknown_field, "keep\\this");
  assert.equal(records[1].rawCode, "7E1234??");
  assert.equal(records[2].rawCode, "01050EC6;013F0DC6");
  assert.deepEqual(Object.keys(records[2].rawFields), [
    "desc",
    "code",
    "enable",
    "address",
    "value",
    "handler",
    "big_endian",
  ]);
  assert.equal(records[1].description, records[2].description);
});

test("parseCht preserves unknown escapes and reports malformed quotes", () => {
  const [record] = parseCht('cheat0_desc = "line\\q"\ncheat0_code = XXXX\n');
  assert.equal(record.description, "line\\q");
  assert.equal(record.rawCode, "XXXX");
  assert.throws(() => parseCht("cheat0_code = 1234", { maxFileBytes: 2 }), /limit is 2 bytes/u);
  const [malformed] = parseCht('cheat0_desc = "broken');
  assert.equal(malformed.description, "broken");
  assert.match(malformed.importWarnings[0], /unterminated quoted value/u);
  const [bom] = parseCht("\uFEFFcheat0_code = 1234\n");
  assert.equal(bom.rawCode, "1234");
});

test("releasesFromIdentifyGames keeps one row per hashed component and drops legacy variants", () => {
  assert.deepEqual(releasesFromIdentifyGames(identifyGames()), [
    {
      checksum: {
        crc32: "abcdef01",
        md5: "0123456789abcdef0123456789abcdef",
        name: "Test Game (USA).nes",
        sha1: "0123456789abcdef0123456789abcdef01234567",
        size: 24592,
      },
      name: "Test Game (USA)",
      region: "USA",
    },
  ]);
});

test("buildCheatShard uses stable IDs and exact checksum title associations", () => {
  const build = () =>
    buildCheatShard({
      cheatSystem: "nes",
      files: fixtureFiles().reverse(),
      releases: releasesFromIdentifyGames(identifyGames()),
      sourceRevision: REVISION,
    });
  const first = build();
  const second = build();
  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, CHEAT_SHARD_SCHEMA_VERSION);
  assert.equal(first.system, "nes");
  assert.equal(first.games.length, 2);

  const matched = first.games.find((game) => game.title === "Test Game (USA)");
  assert.equal(matched.sourceFiles.length, 2);
  assert.equal(matched.checksums.length, 1);
  assert.equal(matched.checksums[0].crc32, "abcdef01");
  assert.deepEqual(matched.regions, ["USA"]);
  assert.equal(matched.cheats.length, 5);
  assert.ok(matched.cheats.every((cheat) => cheat.gameId === matched.id && cheat.system === "nes"));
  assert.ok(matched.cheats.every((cheat) => cheat.sourceRevision === REVISION));
  assert.ok(
    matched.cheats
      .filter((cheat) => cheat.sourceFile.includes("Game Genie"))
      .every((cheat) => cheat.codeKind === "game-genie"),
  );
  assert.ok(
    matched.cheats
      .filter((cheat) => !cheat.sourceFile.includes("Game Genie"))
      .every((cheat) => !("codeKind" in cheat)),
  );
  assert.equal(new Set(matched.cheats.map((cheat) => cheat.id)).size, matched.cheats.length);

  const missing = first.games.find((game) => game.title === "Unknown Homebrew (World)");
  assert.deepEqual(missing.checksums, []);
  assert.deepEqual(missing.regions, ["World"]);

  const encoded = encodeCheatShard(first);
  assert.deepEqual(JSON.parse(encoded.toString("utf8")), first);
  assert.deepEqual(encodeCheatShard(second), encoded);
});

test("stable cheat IDs ignore enable state but retain distinct record semantics", () => {
  const base = { rawFields: { desc: "Lives", code: "AAAA", enable: "false" } };
  const enabled = { rawFields: { desc: "Lives", code: "AAAA", enable: "true" } };
  const changed = { rawFields: { desc: "Lives", code: "AAAB", enable: "false" } };
  const typed = { codeKind: "game-genie", rawFields: base.rawFields };
  assert.equal(stableCheatId("nes", "game", base), stableCheatId("nes", "game", enabled));
  assert.notEqual(stableCheatId("nes", "game", base), stableCheatId("nes", "game", changed));
  assert.notEqual(stableCheatId("nes", "game", base), stableCheatId("nes", "game", typed));
});

test("release normalization groups device files without merging regions", () => {
  assert.equal(
    normalizeReleaseName("Test Game (USA) (Game Genie).cht"),
    normalizeReleaseName("Test Game (USA).nes"),
  );
  assert.notEqual(
    normalizeReleaseName("Test Game (USA).cht"),
    normalizeReleaseName("Test Game (Europe).cht"),
  );
  assert.equal(normalizeReleaseName("Dr. Mario (USA).cht"), "dr. mario (usa)");
  assert.equal(
    normalizeReleaseName("Test Game (USA) (Game Genie) (diff2).cht"),
    normalizeReleaseName("Test Game (USA).nes"),
  );
});

test("GBA device annotations use the Xploder decoder family", () => {
  const shard = buildCheatShard({
    cheatSystem: "gameboyadvance",
    files: [
      {
        sourcePath: "cht/Nintendo - Game Boy Advance/Public Test (USA) (Action Replay).cht",
        text: 'cheat0_desc = "Lives"\ncheat0_code = "32000000 0001"\n',
      },
    ],
    releases: [],
    sourceRevision: REVISION,
  });

  assert.equal(shard.games[0].cheats[0].codeKind, "xploder");
});

test("buildCheatShard refuses to build without a system or revision", () => {
  assert.throws(
    () => buildCheatShard({ cheatSystem: "", files: [], releases: [], sourceRevision: REVISION }),
    /needs a cheatSystem/u,
  );
  assert.throws(
    () => buildCheatShard({ cheatSystem: "nes", files: [], releases: [], sourceRevision: "" }),
    /needs a sourceRevision/u,
  );
});
