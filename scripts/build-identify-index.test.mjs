import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PACK_PLATFORMS,
  IDENTIFY_GENERATION_DATE,
  LIBRETRO_DAT_PATHS,
  LIBRETRO_PLATFORM_PATHS,
  LIBRETRO_REVISION,
  OPENGOOD_ONLY_PLATFORMS,
  OPENGOOD_REVISION,
  buildCatalogPlatforms,
  buildSystemPackV1,
  extractGoodToolsDumpTags,
  main,
  mediaProfileFor,
  mergeLegacyFallbackGames,
  packGroupFor,
  parseClrMameProDat,
  parseLibretroGames,
  parseOpenGoodGames,
} from "./build-identify-index.mjs";

const NES = "Nintendo - Nintendo Entertainment System";

test("fantasy console packs are optional", () => {
  for (const platform of ["LowRes NX", "MicroW8", "PICO-8", "TIC-80", "WASM-4"]) {
    assert.ok(!DEFAULT_PACK_PLATFORMS.includes(platform), platform);
    assert.equal(packGroupFor(platform), "optional-fantasy", platform);
  }
});

test("the consoles a ROM is most often identified against ship by default", () => {
  for (const platform of [
    "Microsoft - Xbox",
    "Nintendo - Wii U",
    "Sony - PlayStation 3",
    "Sony - PlayStation Vita",
  ]) {
    assert.equal(packGroupFor(platform), "default", platform);
  }
  // Store-only variants stay optional: they are separate dumps of the same
  // console, and most users never hold one.
  for (const platform of [
    "Nintendo - Wii U (Digital)",
    "Sony - PlayStation 3 (PSN)",
    "Sony - PlayStation Vita (PSN)",
  ]) {
    assert.notEqual(packGroupFor(platform), "default", platform);
  }
  // Arcade boards stay optional; Atomiswave is one, not a console.
  assert.equal(packGroupFor("Atomiswave"), "optional-arcade");
});
const LIBRETRO_DAT = `clrmamepro (
 name "Nintendo - Nintendo Entertainment System"
 description "Pinned Libretro NES DAT"
 date "2026-08-27"
)
game (
 name "Alpha Quest (USA)"
 description "The Libretro title"
 region "USA"
 rom ( name "alpha.nes" size 16 crc AABBCCDD md5 00112233445566778899AABBCCDDEEFF sha1 00112233445566778899AABBCCDDEEFF00112233 )
)
game (
 name "Beta Quest (USA)"
 description "Libretro only"
 region "USA"
 rom ( name "beta.nes" size 8 crc 11223344 )
)`;
const OPENGOOD_DAT = `<?xml version="1.0"?><datafile><header><date>2021-12-27</date></header>
<game name="Alpha Quest (U) [!]"><rom name="alpha.nes" size="16" crc="aabbccdd" md5="00112233445566778899aabbccddeeff" sha1="00112233445566778899aabbccddeeff00112233"/></game>
<game name="Legacy Quest (U) [b1][T-Eng]"><rom name="legacy.nes" size="32" crc="deadbeef"/></game></datafile>`;
const REDUMP_DAT = `clrmamepro ( name "Sony - PlayStation" )
game ( name "Disc" rom ( name "Disc (Track 1).bin" size 16 crc AABBCCDD ) )`;

function tempDir(prefix) {
  return mkdtempSync(join(os.tmpdir(), `rw-identify-${prefix}-`));
}

function writeCachedDat(cacheDir, source, revision, datFile, bytes) {
  const relativePath = datFile.includes("/")
    ? datFile
    : source === "libretro"
      ? `dat/${datFile}`
      : `dats/${datFile}`;
  const target = join(cacheDir, source, revision, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function parsePack(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("binary"), "RWFP1\0\0\0");
  const count = bytes.readUInt32LE(8);
  let cursor = 12;
  const directory = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = bytes.readUInt16LE(cursor);
    cursor += 2;
    const size = Number(bytes.readBigUInt64LE(cursor));
    cursor += 8;
    const name = bytes.subarray(cursor, cursor + nameLength).toString("utf8");
    cursor += nameLength;
    directory.push({ name, size });
  }
  const members = new Map();
  for (const entry of directory) {
    members.set(entry.name, bytes.subarray(cursor, cursor + entry.size));
    cursor += entry.size;
  }
  return members;
}

test("the Libretro manifest contains all pinned root and metadata DAT files", () => {
  assert.equal(LIBRETRO_DAT_PATHS.filter((value) => value.startsWith("dat/")).length, 52);
  assert.equal(
    LIBRETRO_DAT_PATHS.filter((value) => value.startsWith("metadat/no-intro/")).length,
    92,
  );
  assert.equal(
    LIBRETRO_DAT_PATHS.filter((value) => value.startsWith("metadat/redump/")).length,
    22,
  );
  assert.deepEqual(LIBRETRO_PLATFORM_PATHS[NES], [
    "metadat/no-intro/Nintendo - Nintendo Entertainment System.dat",
    "dat/Nintendo - Nintendo Entertainment System.dat",
  ]);
});

test("the OpenGood manifest uses split DATs, never aggregate siblings", () => {
  const files = Object.values(OPENGOOD_ONLY_PLATFORMS).flat();
  for (const aggregate of [
    "OpenGBA.dat",
    "OpenGBx.dat",
    "OpenGen.dat",
    "OpenN64.dat",
    "OpenNGPx.dat",
    "OpenSNES.dat",
    "OpenWSx.dat",
  ]) {
    assert.ok(!files.includes(aggregate), aggregate);
  }
  assert.ok(files.includes("OpenGBA.GBA.dat"));
  assert.ok(files.includes("OpenWSx.WSC.dat"));
});

test("the ClrMamePro parser preserves upstream metadata", () => {
  const parsed = parseClrMameProDat(LIBRETRO_DAT);
  assert.equal(parsed.header.date, "2026-08-27");
  assert.equal(parsed.games[0].metadata.description, "The Libretro title");
  assert.equal(parsed.games[0].roms[0].crc, "AABBCCDD");
});

test("Redump metadata uses track fingerprints and a track media profile", () => {
  const parsed = parseLibretroGames(
    REDUMP_DAT,
    "Sony - PlayStation",
    "metadat/redump/Sony - PlayStation.dat",
  );
  assert.equal(parsed.games[0].components[0].hashScope, "track_file");
  assert.equal(parsed.games[0].components[0].role, "data_track");
  assert.equal(parsed.games[0].components[0].track, 1);
  assert.equal(mediaProfileFor("Sony - PlayStation", "libretro"), "redump-cd-track-v1");
});

test("Redump metadata for a decoded-ISO platform keeps full-file fingerprints", () => {
  const dat = `clrmamepro ( name "Nintendo - GameCube" )
game ( name "Disc" rom ( name "Disc.iso" size 16 crc AABBCCDD ) )`;
  const parsed = parseLibretroGames(
    dat,
    "Nintendo - GameCube",
    "metadat/redump/Nintendo - GameCube.dat",
  );
  assert.equal(parsed.games[0].components[0].hashScope, "full_file");
  assert.equal(parsed.games[0].components[0].role, undefined);
  assert.equal(parsed.games[0].components[0].track, undefined);
});

test("Redump metadata scopes a mixed CD/DVD platform per rom extension", () => {
  const dat = `clrmamepro ( name "Sony - PlayStation 2" )
game ( name "DVD Game" rom ( name "DVD Game.iso" size 16 crc AABBCCDD ) )
game ( name "CD Game" rom ( name "CD Game.bin" size 16 crc DDCCBBAA ) )`;
  const parsed = parseLibretroGames(
    dat,
    "Sony - PlayStation 2",
    "metadat/redump/Sony - PlayStation 2.dat",
  );
  const dvd = parsed.games.find((game) => game.name === "DVD Game").components[0];
  const cd = parsed.games.find((game) => game.name === "CD Game").components[0];
  assert.equal(dvd.hashScope, "full_file");
  assert.equal(dvd.role, undefined);
  assert.equal(cd.hashScope, "track_file");
  assert.equal(cd.role, "data_track");
  assert.equal(cd.track, 1);
});

test("merge prefers the OpenGood name and retains every other name", () => {
  const primary = parseLibretroGames(
    LIBRETRO_DAT,
    NES,
    "Nintendo - Nintendo Entertainment System.dat",
  );
  const fallback = parseOpenGoodGames(OPENGOOD_DAT, NES, "OpenNES.dat");
  const additionalFallback = parseOpenGoodGames(
    `<?xml version="1.0"?><datafile><game name="Alpha Quest (J) [!]"><rom name="alpha.nes" size="16" crc="aabbccdd"/></game></datafile>`,
    NES,
    "OpenNES-duplicates.dat",
  );
  const games = mergeLegacyFallbackGames(primary.games, [...fallback.games, ...additionalFallback.games]);
  assert.equal(games.length, 3);
  assert.equal(games[0].components.length, 1);
  assert.deepEqual(games[0].dumpTags, ["!"]);
  assert.equal(games[0].provenance.length, 3);
  assert.equal(games[0].name, "Alpha Quest (U) [!]");
  assert.deepEqual(games[0].alternateNames, ["Alpha Quest (J) [!]", "Alpha Quest (USA)"]);
  const legacy = games.find((game) => game.name.startsWith("Legacy Quest"));
  assert.equal(legacy.legacyVariant, true);
  assert.deepEqual(legacy.dumpTags, ["b1", "T-Eng"]);
  assert.deepEqual(extractGoodToolsDumpTags("Title [!][b1]"), ["!", "b1"]);
});

test("family variants resolve to their shared pack", () => {
  const [entry] = buildCatalogPlatforms([
    {
      platform: "Nintendo - Nintendo 64",
      slug: "nintendo-nintendo-64",
      source: "libretro",
      packFormat: "RWFP1",
    },
  ]);
  assert.ok(entry.aliases.includes("nintendo nintendo 64dd"));
});

test("the builder emits deterministic mixed and fallback-only RWFP1 packs", async () => {
  const work = tempDir("mixed");
  const cacheDir = join(work, "cache");
  const outDir = join(work, "out");
  writeCachedDat(
    cacheDir,
    "libretro",
    LIBRETRO_REVISION,
    "dat/Nintendo - Nintendo Entertainment System.dat",
    LIBRETRO_DAT,
  );
  writeCachedDat(
    cacheDir,
    "libretro",
    LIBRETRO_REVISION,
    "metadat/no-intro/Nintendo - Nintendo Entertainment System.dat",
    LIBRETRO_DAT,
  );
  writeCachedDat(cacheDir, "opengood", OPENGOOD_REVISION, "OpenNES.dat", OPENGOOD_DAT);
  writeCachedDat(cacheDir, "opengood", OPENGOOD_REVISION, "OpenCoCo.dat", OPENGOOD_DAT);
  await main([
    "--cache-dir",
    cacheDir,
    "--out",
    outDir,
    "--no-brotli",
    "--only",
    `${NES},Tandy - Color Computer`,
  ]);

  const nes = parsePack(readFileSync(join(outDir, "nintendo-nintendo-entertainment-system.pack")));
  const manifest = JSON.parse(nes.get("manifest.json").toString("utf8"));
  assert.equal(manifest.source, "libretro");
  assert.equal(manifest.format, "rom-weaver-identify-system-pack-v1");
  assert.equal(manifest.generationDate, IDENTIFY_GENERATION_DATE);
  for (const name of [
    "strings.bin",
    "hashes.bin",
    "components.bin",
    "games.bin",
    "owners.bin",
    "routes.bin",
    "sets.bin",
  ]) {
    assert.equal(nes.get(name).readUInt8(4), 1, name);
    assert.equal(nes.get(name).subarray(0, 4).toString("ascii"), `${name === "strings.bin" ? "RWS" : name === "hashes.bin" ? "RWH" : name === "components.bin" ? "RWC" : name === "games.bin" ? "RWG" : name === "owners.bin" ? "RWO" : name === "routes.bin" ? "RWR" : "RWX"}5`, name);
  }

  const tandy = parsePack(readFileSync(join(outDir, "tandy-color-computer.pack")));
  const tandyManifest = JSON.parse(tandy.get("manifest.json").toString("utf8"));
  assert.equal(tandyManifest.source, "opengood");
  assert.ok(
    tandyManifest.provenance.every((entry) => entry.source === "SnowflakePowered/opengood"),
  );

  const catalog = JSON.parse(readFileSync(join(outDir, "catalog.json"), "utf8"));
  const nesCatalog = catalog.platforms.find((entry) => entry.canonicalPlatform === NES);
  assert.ok(nesCatalog.aliases.includes("nintendo entertainment system"));
  assert.ok(nesCatalog.aliases.includes("nes"));
  const index = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
  assert.deepEqual(index.groups.find(({ id }) => id === "default").systems, [
    "nintendo-nintendo-entertainment-system",
  ]);
  assert.deepEqual(index.groups.find(({ id }) => id === "optional-computers").systems, [
    "tandy-color-computer",
  ]);

  const outDir2 = join(work, "out2");
  await main([
    "--cache-dir",
    cacheDir,
    "--out",
    outDir2,
    "--no-brotli",
    "--only",
    `${NES},Tandy - Color Computer`,
  ]);
  for (const file of [
    "nintendo-nintendo-entertainment-system.pack",
    "tandy-color-computer.pack",
    "catalog.json",
    "index.json",
  ]) {
    assert.deepEqual(readFileSync(join(outDir, file)), readFileSync(join(outDir2, file)), file);
  }
});

test("RWFP1 rejects games outside the scoped pack", () => {
  const game = {
    name: "Title",
    platform: NES,
    source: "libretro",
    components: [],
  };
  assert.throws(
    () => buildSystemPackV1("Other", [game]),
    /game platform does not match pack/u,
  );
  assert.throws(
    () => buildSystemPackV1(NES, [{ ...game, source: "opengood" }]),
    /game source does not match pack/u,
  );
});
