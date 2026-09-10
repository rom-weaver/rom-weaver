import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { expandCheatShard } from "../packages/rom-weaver-webapp/src/lib/cheats/shard-format.mjs";

import { LIBRETRO_PLATFORM_PATHS, packGroupFor } from "./build-identify-index.mjs";
import {
  CHEAT_PLATFORMS,
  CHEAT_SHARD_SCHEMA_VERSION,
  buildCheatShard,
  cheatShardFileName,
  encodeCheatShard,
  isBakeableCandidate,
  normalizeReleaseName,
  parseCht,
  releasesFromIdentifyGames,
  stableCheatId,
} from "./import-libretro-cheats.mjs";

const REVISION = "4968f556a0bf749378901086646b78bc78703b88";
const NES_DIRECTORY = "cht/Nintendo - Nintendo Entertainment System";

// Synthetic Libretro `.cht` inputs. They are hand-written, not copied from the
// Libretro database, so they exercise parser edge cases without shipping data.
const NES_FIXTURES = Object.freeze({
  "Test Game (USA).cht": `# The count is wrong on purpose.
cheats = 1

cheat0_desc = "Infinite \\"Things\\""
cheat0_code = "AAAA-BBBB+CCCC-DDDD"
cheat0_enable = false
cheat0_unknown_field = "keep\\\\this"

cheat2_desc = Duplicate description
cheat2_code = "7E1234??"
cheat2_enable = false

cheat7_desc = Duplicate description
cheat7_code = "01050EC6;013F0DC6"
cheat7_enable = false
cheat7_address = "4660"
cheat7_value = "63"
cheat7_handler = "1"
cheat7_big_endian = "false"
`,
  "Test Game (USA) (Game Genie).cht": `cheats = 2
cheat4_desc = "Infinite \\"Things\\""
cheat4_code = "AAAA-BBBB+CCCC-DDDD"
cheat4_enable = true
cheat4_unknown_field = "keep\\\\this"

cheat9_desc = "A distinct variant"
cheat9_code = "AAAA-BBBC"
cheat9_enable = false

cheat11_desc = "A distinct variant"
cheat11_code = "AAAA-BBBC"
cheat11_enable = true
`,
  "Unknown Homebrew (World).cht": `cheat3_desc = "Public-domain fixture"
cheat3_code = 0010:01
cheat3_enable = false
`,
});
const MASTER_SYSTEM_SAMPLE_GAME = `cheat0_desc = "Infinite lives (Game Genie)"
cheat0_code = "1F2-3C4"
cheat0_enable = false

cheat1_desc = "Max score (Action Replay, RAM)"
cheat1_code = "00C00001"
cheat1_enable = false

cheat2_desc = "Invincible (Fusion RAM code)"
cheat2_code = "C000:01"
cheat2_enable = false
`;

const fixtureFiles = () =>
  Object.entries(NES_FIXTURES).map(([name, text]) => ({
    sourcePath: `${NES_DIRECTORY}/${name}`,
    text,
  }));

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
    ["gameboy", "gameboy-color", "gameboyadvance", "gamegear", "genesis", "mastersystem", "nes", "sega32x", "snes"],
  );
  assert.equal(cheatShardFileName("nintendo-game-boy"), "cheats-nintendo-game-boy.json");
});

test("parseCht tolerates real-world indexes, counts, quoting, and fields", () => {
  const records = parseCht(NES_FIXTURES["Test Game (USA).cht"], {
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

test("releasesFromIdentifyGames indexes every merged name so renamed records still match", () => {
  const [renamed] = identifyGames();
  renamed.name = "Test Game (U) [!]";
  renamed.alternateNames = ["Test Game (USA)"];
  const releases = releasesFromIdentifyGames([renamed]);
  assert.deepEqual(
    releases.map((release) => release.name),
    ["Test Game (U) [!]", "Test Game (USA)"],
  );
  const shard = buildCheatShard({
    cheatSystem: "nes",
    files: fixtureFiles(),
    releases,
    sourceRevision: REVISION,
  });
  const matched = shard.games.find((game) => game.title === "Test Game (USA)");
  assert.equal(matched.checksums.length, 1);
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
  // "Unknown Homebrew (World)" carries only a Pro Action Replay code whose
  // literal address is RAM ("0010:01" < 0x8000), so the prefilter drops its
  // only record and the game itself never reaches the shard.
  assert.equal(first.games.length, 1);

  const matched = first.games.find((game) => game.title === "Test Game (USA)");
  assert.equal(matched.sourceFiles.length, 2);
  assert.equal(matched.checksums.length, 1);
  assert.equal(matched.checksums[0].crc32, "abcdef01");
  assert.deepEqual(matched.regions, ["USA"]);
  // cheat2 (placeholder "7E1234??") and cheat7 (structured address/value/handler
  // fields) are dropped by the prefilter; cheat9 and cheat11 share one stable
  // ID, so 3 records remain of the original 6.
  assert.equal(matched.cheats.length, 3);
  // The file stores nothing a reader can derive: no per-record id, system,
  // gameId, or sourceRevision, and the source file is an index.
  assert.equal(first.sourceRevision, REVISION);
  const storedKeys = new Set(matched.cheats.flatMap((cheat) => Object.keys(cheat)));
  for (const derived of ["id", "system", "gameId", "sourceRevision"]) {
    assert.ok(!storedKeys.has(derived), `stored record carries ${derived}`);
  }
  const fileOf = (cheat) => matched.sourceFiles[cheat.sourceFile];
  assert.ok(
    matched.cheats
      .filter((cheat) => fileOf(cheat).includes("Game Genie"))
      .every((cheat) => cheat.codeKind === "game-genie"),
  );
  assert.ok(
    matched.cheats.filter((cheat) => !fileOf(cheat).includes("Game Genie")).every((cheat) => !("codeKind" in cheat)),
  );
  // desc, code, and a false enable are restored on read, so only the enabled
  // record and the unknown field reach the stored rawFields.
  assert.deepEqual(
    matched.cheats.map((cheat) => cheat.rawFields),
    [{ enable: "true", unknown_field: "keep\\this" }, undefined, { unknown_field: "keep\\this" }],
  );
  assert.deepEqual(
    matched.cheats.map((cheat) => cheat.description),
    ['Infinite "Things"', "A distinct variant", 'Infinite "Things"'],
  );

  const missing = first.games.find((game) => game.title === "Unknown Homebrew (World)");
  assert.equal(missing, undefined);

  const encoded = encodeCheatShard(first);
  assert.deepEqual(JSON.parse(encoded.toString("utf8")), first);
  assert.deepEqual(encodeCheatShard(second), encoded);
});

const nodeSha256Hex = async (bytes) => createHash("sha256").update(bytes).digest("hex");

test("expandCheatShard restores every derived field and the builder's stable IDs", async () => {
  const shard = buildCheatShard({
    cheatSystem: "nes",
    files: fixtureFiles(),
    releases: releasesFromIdentifyGames(identifyGames()),
    sourceRevision: REVISION,
  });
  const expanded = await expandCheatShard(JSON.parse(encodeCheatShard(shard)), nodeSha256Hex);
  assert.deepEqual(Object.keys(expanded), ["schemaVersion", "system", "games"]);
  const [game] = expanded.games;
  assert.equal(game.cheats.length, 3);
  for (const cheat of game.cheats) {
    assert.equal(cheat.system, "nes");
    assert.equal(cheat.gameId, game.id);
    assert.equal(cheat.sourceRevision, REVISION);
    assert.ok(game.sourceFiles.includes(cheat.sourceFile));
    assert.equal(cheat.rawFields.desc, cheat.description);
    assert.equal(cheat.rawFields.code, cheat.rawCode);
    assert.equal(cheat.id, stableCheatId("nes", game.id, cheat));
  }
  // cheat4 in the Game Genie file is enabled and keeps an unknown field; the
  // stored form kept both and the expansion puts desc/code/enable first.
  const enabled = game.cheats.find((cheat) => cheat.rawFields.enable === "true");
  assert.deepEqual(Object.keys(enabled.rawFields), ["desc", "code", "enable", "unknown_field"]);
  assert.equal(enabled.rawFields.unknown_field, "keep\\this");
  assert.equal(enabled.codeKind, "game-genie");
  assert.equal(new Set(game.cheats.map((cheat) => cheat.id)).size, 3);
});

test("expandCheatShard defaults a record without desc and rejects a bad source file index", async () => {
  const stored = {
    schemaVersion: 1,
    system: "nes",
    sourceRevision: "rev",
    games: [
      {
        id: "game_x",
        title: "X",
        normalizedTitle: "x",
        regions: [],
        revisions: [],
        sourceFiles: ["cht/x.cht"],
        checksums: [],
        cheats: [{ rawCode: "AKE-LVS", sourceFile: 0, sourceIndex: 4 }],
      },
    ],
  };
  const expanded = await expandCheatShard(stored, nodeSha256Hex);
  const [cheat] = expanded.games[0].cheats;
  assert.equal(cheat.description, "Cheat 5");
  assert.deepEqual(cheat.rawFields, { code: "AKE-LVS", enable: "false" });
  assert.equal(cheat.id, "cheat_83275ab42d2759effefab00f");
  stored.games[0].cheats[0].sourceFile = 1;
  await assert.rejects(() => expandCheatShard(stored, nodeSha256Hex), /source file/u);
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
  assert.equal(normalizeReleaseName("Test Game (USA) (Game Genie).cht"), normalizeReleaseName("Test Game (USA).nes"));
  assert.notEqual(normalizeReleaseName("Test Game (USA).cht"), normalizeReleaseName("Test Game (Europe).cht"));
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
        // Type "8" Xploder write with the address in ROM (0x08000000-0x0A000000)
        // so the prefilter keeps the record.
        sourcePath: "cht/Nintendo - Game Boy Advance/Public Test (USA) (Action Replay).cht",
        text: 'cheat0_desc = "Lives"\ncheat0_code = "89000000 0001"\n',
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

// Minimal record shape isBakeableCandidate needs: rawCode plus the raw field
// map (empty unless a case exercises the structured-fields rule).
const record = (rawCode, overrides = {}) => ({ rawCode, rawFields: {}, ...overrides });

test("isBakeableCandidate drops empty codes, placeholders, and structured RetroArch fields", () => {
  assert.equal(isBakeableCandidate("nes", record(null)), false);
  assert.equal(isBakeableCandidate("nes", record("  ")), false);
  assert.equal(isBakeableCandidate("nes", record("7E1234??")), false);
  assert.equal(isBakeableCandidate("nes", record("7E12XX00")), false);
  assert.equal(isBakeableCandidate("nes", record("013F0DC6", { rawFields: { address: "4660", value: "63" } })), false);
  assert.equal(isBakeableCandidate("nes", record("AAAA-BBBB")), true);
});

test("isBakeableCandidate: nes keeps Game Genie letters and drops RAM Pro Action Replay", () => {
  assert.equal(isBakeableCandidate("nes", record("0010:01")), false); // addr 0x0010 < 0x8000
  assert.equal(isBakeableCandidate("nes", record("F010:01")), true); // addr 0xF010 >= 0x8000
  assert.equal(isBakeableCandidate("nes", record("AAAA-BBBC")), true); // letters-only Game Genie
});

test("isBakeableCandidate: snes only filters when the title said Pro Action Replay", () => {
  assert.equal(isBakeableCandidate("snes", record("7E123401")), true); // codeKind unset, kept
  assert.equal(
    isBakeableCandidate("snes", record("7E123401", { codeKind: "pro-action-replay" })),
    false, // bank 7E is RAM
  );
  assert.equal(
    isBakeableCandidate("snes", record("00800001", { codeKind: "pro-action-replay" })),
    true, // system bank, low 0x8000 is not < 0x2000
  );
});

test("isBakeableCandidate: genesis and sega32x drop RAM Pro Action Replay, keep Game Genie", () => {
  for (const cheatSystem of ["genesis", "sega32x"]) {
    assert.equal(isBakeableCandidate(cheatSystem, record("E00000:0001")), false); // >= 0xE00000
    assert.equal(isBakeableCandidate(cheatSystem, record("000000:0001")), true);
    assert.equal(isBakeableCandidate(cheatSystem, record("ABDZ78F7")), true); // Game Genie shape
  }
});

test("isBakeableCandidate: gameboy and gameboy-color drop RAM GameShark, keep Game Genie", () => {
  for (const cheatSystem of ["gameboy", "gameboy-color"]) {
    assert.equal(isBakeableCandidate(cheatSystem, record("01000090")), false); // addr 0x9000 >= 0x8000
    assert.equal(isBakeableCandidate(cheatSystem, record("01000010")), true); // addr 0x1000 < 0x8000
    assert.equal(isBakeableCandidate(cheatSystem, record("014BCE")), true); // 6-digit Game Genie
  }
});

test("isBakeableCandidate: gameboyadvance keeps only the ROM-patch and in-range forms", () => {
  assert.equal(
    isBakeableCandidate("gameboyadvance", record("00000000 18000000 00000001 00000000")),
    true, // four-word ROM patch
  );
  assert.equal(isBakeableCandidate("gameboyadvance", record("89000000 0001")), true); // addr 0x9000000
  assert.equal(isBakeableCandidate("gameboyadvance", record("32000000 0001")), false); // addr 0x2000000, RAM
});

test("isBakeableCandidate: mastersystem, gamegear, sg1000 drop RAM forms, keep Game Genie", () => {
  for (const cheatSystem of ["mastersystem", "gamegear", "sg1000"]) {
    assert.equal(isBakeableCandidate(cheatSystem, record("00C00001")), false); // addr 0xC000 >= 0xC000
    assert.equal(isBakeableCandidate(cheatSystem, record("00300001")), true); // addr 0x3000 < 0xC000
    assert.equal(isBakeableCandidate(cheatSystem, record("C000:01")), false); // Fusion RAM code
    assert.equal(isBakeableCandidate(cheatSystem, record("1F2-3C4")), true); // Game Genie
  }
});

test("a game left with only dropped records disappears from the shard", () => {
  const shard = buildCheatShard({
    cheatSystem: "mastersystem",
    files: [
      {
        sourcePath: "cht/Sega - Master System - Mark III/Only RAM (World).cht",
        text: 'cheat0_desc = "Bad code"\ncheat0_code = "00C00001"\n',
      },
    ],
    releases: [],
    sourceRevision: REVISION,
  });
  assert.deepEqual(shard.games, []);
});

test("Master System fixture keeps the Game Genie code and drops the RAM codes", () => {
  const directory = "cht/Sega - Master System - Mark III";
  const shard = buildCheatShard({
    cheatSystem: "mastersystem",
    files: [{ sourcePath: `${directory}/Sample Game (World).cht`, text: MASTER_SYSTEM_SAMPLE_GAME }],
    releases: [],
    sourceRevision: REVISION,
  });
  assert.equal(shard.games.length, 1);
  assert.equal(shard.games[0].cheats.length, 1);
  assert.equal(shard.games[0].cheats[0].rawCode, "1F2-3C4");
});
