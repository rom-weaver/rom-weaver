import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCatalogPlatforms,
  CATALOG_FORMAT,
  INDEX_FORMAT,
  INDEX_FORMAT_V2,
  main,
  mediaProfileFor,
  normalizeAlias,
  OPENGOOD_PLATFORMS,
  OPENGOOD_REVISION,
  REDUMP_PLATFORMS,
  REDUMP_DEFAULT_MEDIA_PROFILE,
  slugifyPlatform,
} from "./build-identify-index.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(scriptDir, "../tests/fixtures/identify");
const CONFLICT_VALUE_FLAG = 0x80000000;

function tempDir(prefix) {
  return mkdtempSync(join(os.tmpdir(), `rw-identify-${prefix}-`));
}

// Every OpenGood platform maps to fixture DATs so no test touches the network.
// The cache is pre-seeded at the exact path downloadOpenGoodDat would use.
function seedOpenGoodCache(cacheDir) {
  const datDir = join(cacheDir, "opengood", OPENGOOD_REVISION);
  mkdirSync(datDir, { recursive: true });
  const fixture = readFileSync(join(fixtureDir, "OpenNES.dat"));
  for (const datFiles of Object.values(OPENGOOD_PLATFORMS)) {
    for (const datFile of datFiles) writeFileSync(join(datDir, datFile), fixture);
  }
}

function seedRedumpCache(cacheDir) {
  const datDir = join(cacheDir, "redump");
  mkdirSync(datDir, { recursive: true });
  for (const slug of Object.values(REDUMP_PLATFORMS)) {
    const result = spawnSync("zip", ["-q", "-X", join(datDir, `${slug}.zip`), "Redump.dat"], {
      cwd: fixtureDir,
    });
    assert.equal(result.status, 0, String(result.stderr));
  }
}

// Parse the RWFP1/RWFP2 outer container: magic(8), count u32, directory of
// (nameLen u16, size u64, name), then payloads in directory order.
function parsePack(bytes) {
  const magic = bytes.subarray(0, 8).toString("binary");
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
  assert.equal(cursor, bytes.length, "trailing bytes after pack payloads");
  return { magic, memberOrder: directory.map((entry) => entry.name), members };
}

function parseRoute(bytes) {
  assert.equal(bytes.subarray(0, 4).toString("binary"), "RWR2");
  assert.equal(bytes.readUInt16LE(4), 1);
  assert.equal(bytes.readUInt16LE(6), 0);
  const keyCount = bytes.readUInt32LE(8);
  const conflictEntries = bytes.readUInt32LE(12);
  const conflictValueCount = bytes.readUInt32LE(16);
  let cursor = 20;
  const records = [];
  for (let index = 0; index < keyCount; index += 1) {
    const crc32 = bytes.subarray(cursor, cursor + 4).toString("hex");
    cursor += 4;
    const size = Number(bytes.readBigUInt64LE(cursor));
    cursor += 8;
    const value = bytes.readUInt32LE(cursor);
    cursor += 4;
    records.push({ crc32, size, value });
  }
  const conflictOffsets = [];
  for (let index = 0; index <= conflictEntries; index += 1) {
    conflictOffsets.push(bytes.readUInt32LE(cursor));
    cursor += 4;
  }
  const conflictValues = [];
  for (let index = 0; index < conflictValueCount; index += 1) {
    conflictValues.push(bytes.readUInt32LE(cursor));
    cursor += 4;
  }
  assert.equal(cursor, bytes.length, "trailing bytes after route.bin");
  return { conflictOffsets, conflictValues, records };
}

function parseRefs(bytes) {
  assert.equal(bytes.subarray(0, 4).toString("binary"), "RWX2");
  assert.equal(bytes.readUInt16LE(4), 1);
  assert.equal(bytes.readUInt16LE(6), 6);
  const refs = [];
  for (let cursor = 8; cursor < bytes.length; cursor += 6) {
    refs.push({
      gameIndex: bytes.readUInt32LE(cursor),
      componentIndex: bytes.readUInt16LE(cursor + 4),
    });
  }
  return refs;
}

// Resolve one (crc32, size) key against a parsed route + refs pair, mirroring
// what the Rust RWFP2 reader will do.
function routeLookup(route, refs, crc32, size) {
  const record = route.records.find(
    (candidate) => candidate.crc32 === crc32 && candidate.size === size,
  );
  if (!record) return [];
  if (record.value < CONFLICT_VALUE_FLAG) return [refs[record.value]];
  const conflictIndex = record.value - CONFLICT_VALUE_FLAG;
  const start = route.conflictOffsets[conflictIndex];
  const end = route.conflictOffsets[conflictIndex + 1];
  return route.conflictValues.slice(start, end).map((refId) => refs[refId]);
}

async function buildFromFixtureDump(only, extraArgs = []) {
  const work = tempDir("build");
  const cacheDir = join(work, "cache");
  const outDir = join(work, "out");
  seedOpenGoodCache(cacheDir);
  seedRedumpCache(cacheDir);
  await main([
    "--cache-dir",
    cacheDir,
    "--out",
    outDir,
    "--no-brotli",
    ...(only ? ["--only", only] : []),
    ...extraArgs,
  ]);
  return { cacheDir, outDir, work };
}

test("opengood platforms build RWFP1 packs from the OpenGood source", async () => {
  const work = tempDir("opengood");
  const cacheDir = join(work, "cache");
  const outDir = join(work, "out");
  seedOpenGoodCache(cacheDir);
  await main([
    "--cache-dir",
    cacheDir,
    "--out",
    outDir,
    "--no-brotli",
    "--only",
    "Nintendo Entertainment System",
  ]);

  const index = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
  assert.equal(index.format, INDEX_FORMAT);
  assert.equal(index.catalog, "catalog.json");
  assert.equal(index.systems.length, 1);
  assert.equal(index.systems[0].source, "opengood");
  assert.equal(index.systems[0].packFormat, "RWFP1");

  const pack = parsePack(readFileSync(join(outDir, "nintendo-entertainment-system.pack")));
  assert.equal(pack.magic, "RWFP1\0\0\0");
  const manifest = JSON.parse(pack.members.get("manifest.json").toString("utf8"));
  assert.equal(manifest.format, INDEX_FORMAT);
  assert.deepEqual(JSON.parse(pack.members.get("names.json").toString("utf8")), [
    "Alpha Quest (U) [!]",
    "Beta Blaster (U) (PRG1) [!]",
  ]);
});

test("the Redump map includes systems outside the original app catalog", () => {
  assert.equal(REDUMP_PLATFORMS["Atari Jaguar CD Interactive Multimedia System"], "ajcd");
  assert.equal(REDUMP_PLATFORMS["Panasonic 3DO Interactive Multiplayer"], "3do");
  assert.equal(REDUMP_PLATFORMS["Microsoft Xbox"], "xbox");
  assert.equal(REDUMP_PLATFORMS["Sony PlayStation 3"], "ps3");
  assert.equal(
    mediaProfileFor("Atari Jaguar CD Interactive Multimedia System", "redump"),
    REDUMP_DEFAULT_MEDIA_PROFILE,
  );
  assert.equal(mediaProfileFor("Sega Dreamcast", "redump"), "redump-gdrom-track-v1");
});

test("redump DATs build grouped RWFP2 packs", async () => {
  const { outDir } = await buildFromFixtureDump("Sony PlayStation,Sega Saturn");

  const index = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
  const bySlug = new Map(index.systems.map((system) => [system.slug, system]));
  assert.equal(bySlug.get("sony-playstation").packFormat, "RWFP2");
  assert.equal(bySlug.get("sega-saturn").packFormat, "RWFP2");
  assert.equal(bySlug.get("sega-saturn").source, "redump");

  const pack = parsePack(readFileSync(join(outDir, "sony-playstation.pack")));
  assert.equal(pack.magic, "RWFP2\0\0\0");
  assert.deepEqual(pack.memberOrder, ["games.json", "route.bin", "refs.bin", "manifest.json"]);

  const games = JSON.parse(pack.members.get("games.json").toString("utf8"));
  assert.deepEqual(
    games.map((game) => game.name),
    ["Alpha & Omega", "Beta", "Delta"],
  );

  const alpha = games[0];
  assert.equal(alpha.platform, "Sony PlayStation");
  assert.equal(alpha.source, "redump");
  assert.equal(alpha.upstreamSource, "redump");
  assert.equal(alpha.components.length, 5);
  assert.deepEqual(
    alpha.components.map((component) => component.ordinal),
    [0, 1, 2, 3, 4],
  );
  assert.equal(alpha.components[0].filename, "Alpha (USA) (Track 1).bin");
  assert.equal(alpha.components[0].size, 1000);
  assert.equal(alpha.components[0].crc32, "aaaaaaaa");
  assert.equal(alpha.components[0].md5, "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a");
  assert.equal(alpha.components[0].sha1, "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a");
  assert.equal(alpha.components[0].required, true);
  assert.equal(alpha.components[0].discriminating, true);
  assert.ok(!("crc32" in alpha.components[3]), "chd component has no crc32 key");
  assert.equal(alpha.components[3].sha1, "1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c");

  const manifest = JSON.parse(pack.members.get("manifest.json").toString("utf8"));
  assert.equal(manifest.format, INDEX_FORMAT_V2);
  assert.equal(manifest.canonicalizationProfile, "redump-cd-track-v1");
  assert.equal(manifest.canonicalizationVersion, 1);
  assert.equal(manifest.counts.games, 3);
  assert.equal(manifest.provenance.dat.url, "http://redump.org/datfile/psx/");
  assert.ok(manifest.provenance.dat.sha256.match(/^[0-9a-f]{64}$/u));
});

test("shared components stay in games.json marked non-discriminating and leave route.bin", async () => {
  const { outDir } = await buildFromFixtureDump("Sony PlayStation");
  const pack = parsePack(readFileSync(join(outDir, "sony-playstation.pack")));
  const games = JSON.parse(pack.members.get("games.json").toString("utf8"));
  const route = parseRoute(pack.members.get("route.bin"));
  const refs = parseRefs(pack.members.get("refs.bin"));

  // The track shared by Alpha and Beta (size 500, identical md5) is kept in
  // both games but must not be routable.
  const alphaShared = games[0].components[2];
  const betaShared = games[1].components[1];
  assert.equal(alphaShared.discriminating, false);
  assert.equal(betaShared.discriminating, false);
  assert.deepEqual(routeLookup(route, refs, "cccccccc", 500), []);

  // A unique component routes to exactly its (game, component) slot.
  assert.deepEqual(routeLookup(route, refs, "aaaaaaaa", 1000), [
    { gameIndex: 0, componentIndex: 0 },
  ]);

  // The same crc at a different, unique size stays routable on its own key:
  // size disambiguates within one crc, ordered numerically (60 before 500).
  assert.deepEqual(routeLookup(route, refs, "cccccccc", 60), [{ gameIndex: 0, componentIndex: 4 }]);

  // Same (crc32, size) with different md5 in Beta and Delta stays
  // discriminating and produces a conflict list of both refs.
  const conflict = routeLookup(route, refs, "eeeeeeee", 300);
  assert.deepEqual(conflict, [
    { gameIndex: 1, componentIndex: 2 },
    { gameIndex: 2, componentIndex: 0 },
  ]);

  // The chd component (size 0, sha1-only) must not be routed.
  assert.equal(
    refs.some((ref) => ref.gameIndex === 0 && ref.componentIndex === 3),
    false,
  );

  // route.bin records are sorted by (crc32 bytes, numeric size) with unique
  // keys. Sizes MUST compare numerically: string order would pass a broken
  // writer and fail a correct one once sizes of different digit counts share
  // one crc.
  const parsed = route.records.map((record) => ({ crc32: record.crc32, size: record.size }));
  const expected = [...parsed].sort((a, b) =>
    a.crc32 < b.crc32 ? -1 : a.crc32 > b.crc32 ? 1 : Number(a.size) - Number(b.size),
  );
  assert.deepEqual(parsed, expected);
  const keys = parsed.map((record) => `${record.crc32}|${record.size}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("catalog.json lists every OpenGood platform plus built redump platforms", async () => {
  const { outDir } = await buildFromFixtureDump("Sega Saturn");
  const catalog = JSON.parse(readFileSync(join(outDir, "catalog.json"), "utf8"));
  assert.equal(catalog.format, CATALOG_FORMAT);
  assert.equal(catalog.generated.opengoodRevision, OPENGOOD_REVISION);
  assert.ok(catalog.generated.redumpDats["Sega Saturn"].sha256.match(/^[0-9a-f]{64}$/u));
  assert.equal(catalog.generated.redumpDats["Sega Saturn"].fileName, "ss.zip");

  const byName = new Map(catalog.platforms.map((entry) => [entry.canonicalPlatform, entry]));
  for (const platform of Object.keys(OPENGOOD_PLATFORMS)) {
    const entry = byName.get(platform);
    assert.ok(entry, `catalog is missing OpenGood platform ${platform}`);
    assert.equal(entry.source, "opengood");
    assert.equal(entry.packFormat, "RWFP1");
    assert.deepEqual(entry.mediaProfiles, ["opengood-cartridge-v1"]);
    assert.equal(entry.packSlug, slugifyPlatform(platform));
    assert.equal(entry.canonicalizationVersion, 1);
    assert.ok(entry.aliases.includes(normalizeAlias(platform)));
  }
  assert.ok(byName.get("Sony PlayStation") === undefined, "unbuilt redump platforms stay out");
  const saturn = byName.get("Sega Saturn");
  assert.equal(saturn.source, "redump");
  assert.equal(saturn.packFormat, "RWFP2");
  assert.deepEqual(saturn.mediaProfiles, ["redump-cd-track-v1"]);
  assert.ok(saturn.packSha256.match(/^[0-9a-f]{64}$/u));

  const gba = byName.get("Nintendo Game Boy Advance");
  assert.ok(gba.aliases.includes("gba"));
  assert.ok(byName.get("Nintendo Entertainment System").aliases.includes("famicom"));

  // No alias appears under two platforms.
  const all = catalog.platforms.flatMap((entry) => entry.aliases);
  assert.equal(new Set(all).size, all.length);
});

test("duplicate alias across platforms fails the build", () => {
  assert.throws(
    () =>
      buildCatalogPlatforms([
        { platform: "Foo Bar", slug: "foo-bar", source: "redump", packFormat: "RWFP2" },
        { platform: "Foo  Bar", slug: "foo--bar", source: "redump", packFormat: "RWFP2" },
      ]),
    /Duplicate platform alias "foo bar"/u,
  );
});

test("duplicate packSlug fails the build", () => {
  assert.throws(
    () =>
      buildCatalogPlatforms([
        { platform: "Foo:Bar", slug: "foo-bar", source: "redump", packFormat: "RWFP2" },
        { platform: "Foo.Bar", slug: "foo-bar", source: "redump", packFormat: "RWFP2" },
      ]),
    /Duplicate packSlug "foo-bar"/u,
  );
});

test("a discovered platform's own name beats another platform's curated alias", () => {
  // The real dump contains a "GBA" directory; its own normalized name claims
  // "gba" and the curated Game Boy Advance alias is dropped, not fatal.
  const platforms = buildCatalogPlatforms([
    {
      platform: "Nintendo Game Boy Advance",
      slug: "nintendo-game-boy-advance",
      source: "opengood",
      packFormat: "RWFP1",
    },
    { platform: "GBA", slug: "gba", source: "redump", packFormat: "RWFP2" },
  ]);
  const gba = platforms.find((entry) => entry.canonicalPlatform === "Nintendo Game Boy Advance");
  assert.ok(!gba.aliases.includes("gba"));
  const dumpGba = platforms.find((entry) => entry.canonicalPlatform === "GBA");
  assert.deepEqual(dumpGba.aliases, ["gba"]);
});

test("rebuilding from identical input is byte-identical", async () => {
  const first = await buildFromFixtureDump("Sony PlayStation,Sega Saturn");
  const outDir2 = join(first.work, "out2");
  await main([
    "--cache-dir",
    first.cacheDir,
    "--out",
    outDir2,
    "--no-brotli",
    "--only",
    "Sony PlayStation,Sega Saturn",
  ]);
  for (const name of ["sony-playstation.pack", "sega-saturn.pack", "catalog.json"]) {
    assert.deepEqual(
      readFileSync(join(first.outDir, name)),
      readFileSync(join(outDir2, name)),
      name,
    );
  }
});

test("--max-objects limits parsed game objects for redump platforms", async () => {
  const { outDir } = await buildFromFixtureDump("Sony PlayStation", ["--max-objects", "2"]);
  const pack = parsePack(readFileSync(join(outDir, "sony-playstation.pack")));
  const games = JSON.parse(pack.members.get("games.json").toString("utf8"));
  assert.ok(games.length >= 1 && games.length <= 2, `expected 1-2 games, got ${games.length}`);
});

test("--only rejects an optical platform without a Redump mapping", async () => {
  const work = tempDir("missing");
  const cacheDir = join(work, "cache");
  seedOpenGoodCache(cacheDir);
  await assert.rejects(
    main([
      "--cache-dir",
      cacheDir,
      "--out",
      join(work, "out"),
      "--no-brotli",
      "--only",
      "No Such Platform",
    ]),
    /not configured/u,
  );
});

test("--redump-all builds every configured optical platform", async () => {
  const work = tempDir("redump-all");
  const cacheDir = join(work, "cache");
  seedOpenGoodCache(cacheDir);
  seedRedumpCache(cacheDir);
  await main(["--cache-dir", cacheDir, "--out", join(work, "out"), "--no-brotli", "--redump-all"]);
  const index = JSON.parse(readFileSync(join(work, "out", "index.json"), "utf8"));
  assert.equal(
    index.systems.filter((system) => system.source === "redump").length,
    Object.keys(REDUMP_PLATFORMS).length,
  );
});
