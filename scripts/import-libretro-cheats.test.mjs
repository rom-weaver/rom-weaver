import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { brotliDecompressSync } from "node:zlib";

import {
  SYSTEMS,
  buildSystemShard,
  importLibretroCheats,
  normalizeReleaseName,
  parseCht,
  parseDat,
  stableCheatId,
} from "./import-libretro-cheats.mjs";

const REVISION = "4968f556a0bf749378901086646b78bc78703b88";
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "libretro-cheats");

test("the supported system map names the five decoder families", () => {
  assert.deepEqual(Object.keys(SYSTEMS), ["nes", "snes", "genesis", "gameboy", "gameboy-color"]);
  assert.equal(SYSTEMS.genesis.directory, "Sega - Mega Drive - Genesis");
  assert.equal(SYSTEMS["gameboy-color"].directory, "Nintendo - Game Boy Color");
});

test("parseCht tolerates real-world indexes, counts, quoting, and fields", () => {
  const source = readFileSync(
    path.join(
      FIXTURE_ROOT,
      "cht",
      "Nintendo - Nintendo Entertainment System",
      "Test Game (USA).cht",
    ),
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
});

test("parseDat reads checksums, sizes, regions, and names with parentheses", () => {
  const dat = readFileSync(
    path.join(FIXTURE_ROOT, "metadat", "no-intro", "Nintendo - Nintendo Entertainment System.dat"),
    "utf8",
  );
  assert.deepEqual(parseDat(dat), [
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
      sourceFile: "fixture.dat",
    },
  ]);
});

test("buildSystemShard uses stable IDs and exact checksum title associations", () => {
  const first = buildSystemShard({
    sourceDir: FIXTURE_ROOT,
    sourceRevision: REVISION,
    system: "nes",
  });
  const second = buildSystemShard({
    sourceDir: FIXTURE_ROOT,
    sourceRevision: REVISION,
    system: "nes",
  });
  assert.deepEqual(first, second);
  assert.equal(first.games.length, 2);

  const matched = first.games.find((game) => game.title === "Test Game (USA)");
  assert.equal(matched.sourceFiles.length, 2);
  assert.equal(matched.checksums.length, 1);
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

test("the import is deterministic and records exact manifest sizes", () => {
  const firstDir = mkdtempSync(path.join(os.tmpdir(), "rom-weaver-cheats-first-"));
  const secondDir = mkdtempSync(path.join(os.tmpdir(), "rom-weaver-cheats-second-"));
  const first = importLibretroCheats({
    outputDir: firstDir,
    sourceDir: FIXTURE_ROOT,
    sourceRevision: REVISION,
    systems: ["nes"],
  });
  const second = importLibretroCheats({
    outputDir: secondDir,
    sourceDir: FIXTURE_ROOT,
    sourceRevision: REVISION,
    systems: ["nes"],
  });
  const firstRaw = readFileSync(path.join(firstDir, "nes.json"));
  const secondRaw = readFileSync(path.join(secondDir, "nes.json"));
  const firstCompressed = readFileSync(path.join(firstDir, "nes.json.br"));
  const secondCompressed = readFileSync(path.join(secondDir, "nes.json.br"));

  assert.deepEqual(firstRaw, secondRaw);
  assert.deepEqual(firstCompressed, secondCompressed);
  assert.deepEqual(brotliDecompressSync(firstCompressed), firstRaw);
  assert.equal(first.systems.nes.rawBytes, firstRaw.length);
  assert.equal(first.systems.nes.compressedBytes, firstCompressed.length);
  assert.equal(first.systems.nes.path, `/cheats/nes.json?revision=${REVISION}`);
  assert.equal(first.systems.nes.compressedPath, `/cheats/nes.json.br?revision=${REVISION}`);
  assert.equal(first.systems.nes.games, 2);
  assert.equal(first.systems.nes.cheats, 6);
  assert.equal(first.sourceRevision, REVISION);
  assert.equal(first.license, "CC-BY-SA-4.0");
  assert.equal(
    readFileSync(path.join(firstDir, "LICENSE"), "utf8"),
    readFileSync(path.join(FIXTURE_ROOT, "LICENSE"), "utf8"),
  );
  assert.match(
    readFileSync(path.join(firstDir, "ATTRIBUTION.md"), "utf8"),
    new RegExp(REVISION, "u"),
  );
  assert.deepEqual(first, second);
  assert.equal("generatedAt" in first, false);
});

test("unsupported systems and unsafe source links fail before output", () => {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), "rom-weaver-cheats-output-"));
  assert.throws(
    () =>
      importLibretroCheats({
        outputDir,
        sourceDir: FIXTURE_ROOT,
        sourceRevision: REVISION,
        systems: ["playstation"],
      }),
    /Unsupported system 'playstation'/u,
  );
  assert.throws(
    () =>
      importLibretroCheats({
        outputDir: FIXTURE_ROOT,
        sourceDir: FIXTURE_ROOT,
        sourceRevision: REVISION,
        systems: ["nes"],
      }),
    /output directory must differ/u,
  );

  const sourceDir = mkdtempSync(path.join(os.tmpdir(), "rom-weaver-cheats-source-"));
  const systemDir = path.join(sourceDir, "cht", SYSTEMS.nes.directory);
  mkdirSync(systemDir, { recursive: true });
  const outside = path.join(sourceDir, "outside.cht");
  writeFileSync(outside, "cheat0_code = 0000:00\n");
  symlinkSync(outside, path.join(systemDir, "linked.cht"));
  assert.throws(
    () => buildSystemShard({ sourceDir, sourceRevision: REVISION, system: "nes" }),
    /Symbolic links are not allowed/u,
  );
});
