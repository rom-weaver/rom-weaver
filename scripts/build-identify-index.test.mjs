import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DEFAULT_PACK_PLATFORMS,
  GOODTOOLS_DAT_PATH,
  GOODTOOLS_ARCHIVE_SHA256,
  GOODTOOLS_RELEASE,
  IDENTIFY_GENERATION_DATE,
  LIBRETRO_DAT_PATHS,
  LIBRETRO_PLATFORM_PATHS,
  LIBRETRO_REVISION,
  OPENGOOD_HEADERED_REVISION,
  OPENGOOD_ONLY_PLATFORMS,
  OPENGOOD_REVISION,
  extractArchiveMembers,
  normalizeArchivePath,
  stripLeadingComponent,
  buildCatalogPlatforms,
  buildSystemPackV1,
  extractGoodToolsDumpTags,
  main,
  mediaProfileFor,
  mergeLegacyFallbackGames,
  packGroupFor,
  parseClrMameProDat,
  parseGoodToolsHeaderedGames,
  parseLibretroGames,
  parseOpenGoodGames,
} from "./build-identify-index.mjs";
import {
  CHECKSUM_ROUTER_FORMAT,
  parseChecksumRouter,
  routeChecksums,
} from "../packages/rom-weaver-webapp/src/lib/identify/checksum-router.mjs";

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
const OPENGOOD_HEADERED_DAT = OPENGOOD_DAT.replace(
  'size="16" crc="aabbccdd" md5="00112233445566778899aabbccddeeff" sha1="00112233445566778899aabbccddeeff00112233"',
  'size="32" crc="cafebabe"',
);
const GOODTOOLS_HEADERED_DAT = `<?xml version="1.0"?><datafile>
<header><date>2025-04-01</date></header>
<game name="GoodSNES v3.27">
<rom name="SNESRen/Alpha Quest (U) [!].smc" size="1536" crc="cafebabe"/>
<rom name="SNESRen/Gamma Quest (U) [b1].smc" size="1536" crc="feedface"/>
<rom name="GoodSNES.db" size="12" crc="12345678"/>
</game></datafile>`;
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

function writeCachedGoodToolsDat(cacheDir, bytes) {
  const target = join(
    cacheDir,
    "goodtools",
    `${GOODTOOLS_RELEASE}-${GOODTOOLS_ARCHIVE_SHA256}`,
    GOODTOOLS_RELEASE,
    GOODTOOLS_DAT_PATH,
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function writeLegacyCachedGoodToolsDat(cacheDir, bytes) {
  const target = join(cacheDir, "goodtools", GOODTOOLS_RELEASE, GOODTOOLS_DAT_PATH);
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
  const games = mergeLegacyFallbackGames(primary.games, [
    ...fallback.games,
    ...additionalFallback.games,
  ]);
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

test("merge joins headered and headerless OpenGood records without a duplicate game", () => {
  const primary = parseLibretroGames(
    LIBRETRO_DAT,
    NES,
    "Nintendo - Nintendo Entertainment System.dat",
  );
  const current = parseOpenGoodGames(OPENGOOD_DAT, NES, "OpenNES.dat", {
    sourceVariant: "current",
  });
  const headered = parseOpenGoodGames(OPENGOOD_HEADERED_DAT, NES, "OpenNES.Headered.dat", {
    revision: OPENGOOD_HEADERED_REVISION,
    sourceVariant: "headered",
  });
  const games = mergeLegacyFallbackGames(primary.games, [...current.games, ...headered.games]);
  const alpha = games.find((game) => game.name === "Alpha Quest (U) [!]");
  assert.equal(games.length, 3);
  assert.equal(alpha.components.length, 2);
  assert.ok(alpha.components.some((component) => component.crc32 === "cafebabe"));
  assert.equal(alpha.provenance.length, 3);
  assert.ok(alpha.alternateNames.includes("Alpha Quest (USA)"));
});

test("GoodSNES dir2dat keeps only exact full-file copier-header hashes", () => {
  const parsed = parseGoodToolsHeaderedGames(
    GOODTOOLS_HEADERED_DAT,
    "Nintendo - Super Nintendo Entertainment System",
  );
  assert.equal(parsed.header.date, "2025-04-01");
  assert.equal(parsed.games.length, 2);
  assert.equal(parsed.games[0].name, "Alpha Quest (U) [!]");
  assert.equal(parsed.games[0].components[0].size, 1536);
  assert.equal(parsed.games[0].components[0].crc32, "cafebabe");
  assert.equal(parsed.games[0].components[0].filename, "Alpha Quest (U) [!].smc");
  assert.equal(parsed.games[0].provenance[0].source, "Eggmansworld/Datfiles");
  assert.equal(parsed.games[0].sourceVariant, "headered");
});

test("GoodSNES headered hashes merge into the existing SNES records", () => {
  const platform = "Nintendo - Super Nintendo Entertainment System";
  const current = parseOpenGoodGames(OPENGOOD_DAT, platform, "OpenSNES.SNES.dat", {
    sourceVariant: "current",
  });
  const headered = parseGoodToolsHeaderedGames(GOODTOOLS_HEADERED_DAT, platform);
  const games = mergeLegacyFallbackGames([], [...current.games, ...headered.games]);
  const alpha = games.find((game) => game.name === "Alpha Quest (U) [!]");
  assert.equal(games.length, 3);
  assert.equal(alpha.components.length, 2);
  assert.ok(alpha.components.some((component) => component.crc32 === "cafebabe"));
  assert.ok(games.some((game) => game.name === "Gamma Quest (U) [b1]"));
});

test("the builder consumes a cached GoodSNES headered DAT", async () => {
  const platform = "Nintendo - Super Nintendo Entertainment System";
  const work = tempDir("goodsnes-headered");
  const cacheDir = join(work, "cache");
  const outDir = join(work, "out");
  writeCachedDat(
    cacheDir,
    "libretro",
    LIBRETRO_REVISION,
    "dat/Nintendo - Super Nintendo Entertainment System.dat",
    LIBRETRO_DAT,
  );
  writeCachedDat(
    cacheDir,
    "libretro",
    LIBRETRO_REVISION,
    "metadat/no-intro/Nintendo - Super Nintendo Entertainment System.dat",
    LIBRETRO_DAT,
  );
  writeCachedDat(cacheDir, "opengood", OPENGOOD_REVISION, "OpenSNES.SNES.dat", OPENGOOD_DAT);
  writeLegacyCachedGoodToolsDat(
    cacheDir,
    '<?xml version="1.0"?><datafile><header><date>stale</date></header></datafile>',
  );
  writeCachedGoodToolsDat(cacheDir, GOODTOOLS_HEADERED_DAT);
  await main(["--cache-dir", cacheDir, "--out", outDir, "--no-brotli", "--only", platform]);
  const pack = parsePack(
    readFileSync(join(outDir, "nintendo-super-nintendo-entertainment-system.pack")),
  );
  const manifest = JSON.parse(pack.get("manifest.json").toString("utf8"));
  assert.equal(manifest.counts.games, 1188);
  assert.ok(manifest.provenance.some((entry) => entry.source === "Eggmansworld/Datfiles"));
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
  writeCachedDat(
    cacheDir,
    "opengood-headered",
    OPENGOOD_HEADERED_REVISION,
    "OpenNES.Headered.dat",
    OPENGOOD_HEADERED_DAT,
  );
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
    assert.equal(
      nes.get(name).subarray(0, 4).toString("ascii"),
      `${name === "strings.bin" ? "RWS" : name === "hashes.bin" ? "RWH" : name === "components.bin" ? "RWC" : name === "games.bin" ? "RWG" : name === "owners.bin" ? "RWO" : name === "routes.bin" ? "RWR" : "RWX"}5`,
      name,
    );
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
    "checksum-routes.bin",
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
  assert.throws(() => buildSystemPackV1("Other", [game]), /game platform does not match pack/u);
  assert.throws(
    () => buildSystemPackV1(NES, [{ ...game, source: "opengood" }]),
    /game source does not match pack/u,
  );
});

test("the builder emits a checksum router that routes every pack key", async () => {
  const work = tempDir("router");
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
  writeCachedDat(
    cacheDir,
    "opengood-headered",
    OPENGOOD_HEADERED_REVISION,
    "OpenNES.Headered.dat",
    OPENGOOD_HEADERED_DAT,
  );
  const args = [
    "--cache-dir",
    cacheDir,
    "--out",
    outDir,
    "--only",
    `${NES},Tandy - Color Computer`,
  ];
  await main(args);

  const index = JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
  const entry = index.checksumRoutes;
  assert.equal(entry.format, CHECKSUM_ROUTER_FORMAT);
  assert.equal(entry.file, "checksum-routes.bin");
  assert.equal(entry.packs, index.systems.length);
  const bytes = readFileSync(join(outDir, entry.file));
  assert.equal(bytes.length, entry.rawBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  assert.equal(entry.brotliFile, "checksum-routes.bin.br");
  assert.equal(readFileSync(join(outDir, entry.brotliFile)).length, entry.brotliBytes);

  const router = parseChecksumRouter(bytes);
  assert.deepEqual(
    router.packs.map(({ slug }) => slug),
    index.systems.map(({ slug }) => slug),
  );

  // Every digest the fixture DATs carry must route to the pack that holds it.
  const nesSlug = "nintendo-nintendo-entertainment-system";
  const tandySlug = "tandy-color-computer";
  for (const digest of ["aabbccdd", "11223344", "deadbeef", "cafebabe"]) {
    assert.ok(routeChecksums(router, [digest]).includes(nesSlug), digest);
  }
  for (const digest of ["aabbccdd", "deadbeef"]) {
    assert.ok(routeChecksums(router, [digest]).includes(tandySlug), digest);
  }
  // The fixture repeats this digest across both packs, so it routes to both.
  assert.deepEqual(routeChecksums(router, ["aabbccdd"]).sort(), [nesSlug, tandySlug].sort());
  assert.ok(routeChecksums(router, ["00112233445566778899aabbccddeeff"]).includes(nesSlug), "md5");
  assert.ok(
    routeChecksums(router, ["00112233445566778899aabbccddeeff00112233"]).includes(nesSlug),
    "sha1",
  );

  const outDir2 = join(work, "out2");
  await main([
    "--cache-dir",
    cacheDir,
    "--out",
    outDir2,
    "--only",
    `${NES},Tandy - Color Computer`,
  ]);
  assert.deepEqual(readFileSync(join(outDir2, "checksum-routes.bin")), bytes);
});

// The identify build used to shell out to `tar`, and the Windows CI job (whose
// workspace lives on `D:`) broke twice on how tar reparsed the paths it was
// handed: a colon meant `host:file`, and the backslash separators were mangled.
// Extraction now runs in process, so these cover the behaviour that replaced it.
const TAR_PREFIX = "libretro-database-69ea62a2823823820d4f121c2b53bf20fd088ab4";
// Longer than tar's 100-character name field, so the archive carries a PAX long
// name - exactly what a real GitHub source archive does.
const LONG_MEMBER = `metadat/no-intro/${"Nintendo - Nintendo Entertainment System ".repeat(3)}Parent-Clone.dat`;

const buildArchive = async (dir, entries) => {
  const stage = join(dir, "stage");
  for (const [name, body] of Object.entries(entries)) {
    const target = join(stage, TAR_PREFIX, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  const archive = join(dir, "source.tar.gz");
  const { create } = await import("tar");
  await create({ cwd: stage, file: archive, gzip: true }, [TAR_PREFIX]);
  return archive;
};

test("extractArchiveMembers writes the requested members with the top level stripped", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "rw-tar-"));
  const archive = await buildArchive(dir, { "dats/a.dat": "alpha", "dats/b.dat": "beta" });
  const sourceRoot = join(dir, "out");
  mkdirSync(sourceRoot, { recursive: true });

  const resolved = await extractArchiveMembers({
    archive,
    members: [`${TAR_PREFIX}/dats/a.dat`],
    sourceRoot,
  });

  const target = resolved.get(`${TAR_PREFIX}/dats/a.dat`);
  assert.equal(target, join(sourceRoot, "dats/a.dat"));
  assert.equal(readFileSync(target, "utf8"), "alpha");
  // Only what was asked for is written; the archive's other entries are skipped.
  assert.throws(() => readFileSync(join(sourceRoot, "dats/b.dat")));
});

test("extractArchiveMembers resolves a PAX long name", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "rw-tar-pax-"));
  const archive = await buildArchive(dir, { [LONG_MEMBER]: "long" });
  const sourceRoot = join(dir, "out");
  mkdirSync(sourceRoot, { recursive: true });

  const resolved = await extractArchiveMembers({
    archive,
    members: [`${TAR_PREFIX}/${LONG_MEMBER}`],
    sourceRoot,
  });

  assert.ok(`${TAR_PREFIX}/${LONG_MEMBER}`.length > 100, "the fixture must exceed the name field");
  assert.equal(readFileSync(resolved.get(`${TAR_PREFIX}/${LONG_MEMBER}`), "utf8"), "long");
});

test("extractArchiveMembers reports a member the archive does not hold", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "rw-tar-missing-"));
  const archive = await buildArchive(dir, { "dats/a.dat": "alpha" });
  const sourceRoot = join(dir, "out");
  mkdirSync(sourceRoot, { recursive: true });

  await assert.rejects(
    extractArchiveMembers({ archive, members: [`${TAR_PREFIX}/dats/nope.dat`], sourceRoot }),
    /is missing: .*nope\.dat/u,
  );
});

test("extract targets are joined with the platform separator", async () => {
  // The member name stays `/`-separated because that is what a tar holds, while
  // the path written to disk MUST use the platform's separator.
  const dir = mkdtempSync(join(os.tmpdir(), "rw-tar-sep-"));
  const archive = await buildArchive(dir, { "dats/a.dat": "alpha" });
  const sourceRoot = join(dir, "out");
  mkdirSync(sourceRoot, { recursive: true });

  const resolved = await extractArchiveMembers({
    archive,
    members: [`${TAR_PREFIX}/dats/a.dat`],
    sourceRoot,
  });
  assert.equal(resolved.get(`${TAR_PREFIX}/dats/a.dat`), join(sourceRoot, "dats", "a.dat"));
});

test("archive paths are compared without a leading ./", () => {
  assert.equal(normalizeArchivePath("./prefix/dats/a.dat"), "prefix/dats/a.dat");
  assert.equal(normalizeArchivePath("prefix/dats/a.dat"), "prefix/dats/a.dat");
  // A backslash is a legal character in a tar entry name, never a separator, so
  // it MUST survive untouched.
  assert.equal(normalizeArchivePath("prefix/odd\\name.dat"), "prefix/odd\\name.dat");
});

test("stripLeadingComponent drops exactly the top-level directory", () => {
  assert.equal(stripLeadingComponent(`${TAR_PREFIX}/dats/a.dat`), "dats/a.dat");
  assert.equal(stripLeadingComponent("./prefix/dats/a.dat"), "dats/a.dat");
  assert.equal(stripLeadingComponent("prefix/only.dat"), "only.dat");
});
