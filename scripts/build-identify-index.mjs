#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const REDUMP_DAT_BASE = "http://redump.org/datfile/";
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "rom-weaver-redump-dats");
const DEFAULT_OUT = path.join(ROOT_DIR, "target/identify");

const PACK_MAGIC = Buffer.from("RWFP1\0\0\0", "binary");
const PACK_MAGIC_V2 = Buffer.from("RWFP2\0\0\0", "binary");
const HASH_MAGIC = Buffer.from("RWH1", "binary");
const PAIR_MAGIC = Buffer.from("RWHP", "binary");
const ROUTE_MAGIC = Buffer.from("RWR2", "binary");
const REFS_MAGIC = Buffer.from("RWX2", "binary");
const CONFLICT_VALUE_FLAG = 0x80000000;
const ROW_CACHE_FORMAT = "rom-weaver-identify-rows-v2";
const GAME_CACHE_FORMAT = "rom-weaver-identify-games-v1";
export const INDEX_FORMAT = "rom-weaver-identify-system-pack-v1";
export const INDEX_FORMAT_V2 = "rom-weaver-identify-system-pack-v2";
export const CATALOG_FORMAT = "rom-weaver-identify-catalog-v1";

// OpenGood (https://github.com/SnowflakePowered/opengood) publishes the
// GoodTools cartridge sets as CC0 Logiqx XML DATs. We prefer it for the
// cartridge platforms it covers: it carries the full GoodTools dump variety
// (verified [!], bad [b], overdump [o], alternate [a], hacks, translations,
// PRG revisions) that No-Intro/Redump deliberately omit, and is license-clean.
// Disc systems and modern handhelds are not in OpenGood, so those fall back to
// the Redump dump (No-Intro/Redump-derived). Each supported platform draws
// from exactly ONE source, so per-system packs never mix sources / hashes.
export const OPENGOOD_REPOSITORY = "https://github.com/SnowflakePowered/opengood";
export const OPENGOOD_REVISION = "5cbd95ef3f5904b9e067042ae8dd08a35c39c89a";
const OPENGOOD_RAW_REPOSITORY = OPENGOOD_REPOSITORY.replace(
  "https://github.com/",
  "https://raw.githubusercontent.com/",
);
const OPENGOOD_RAW_BASE = `${OPENGOOD_RAW_REPOSITORY}/${OPENGOOD_REVISION}/dats/`;
export const OPENGOOD_PLATFORMS = Object.freeze({
  "Atari 2600": ["Open2600.dat"],
  "Atari 5200": ["Open5200.dat"],
  "Atari 7800": ["Open7800.dat"],
  "Atari Lynx": ["OpenLynx.dat"],
  "Neo Geo Pocket": ["OpenNGPx.NGP.dat"],
  "Neo Geo Pocket Color": ["OpenNGPx.NGC.dat"],
  "Nintendo 64": ["OpenN64.N64.dat"],
  "Nintendo Entertainment System": ["OpenNES.dat"],
  "Nintendo Game Boy": ["OpenGBx.GB.dat"],
  "Nintendo Game Boy Advance": ["OpenGBA.GBA.dat"],
  "Nintendo Game Boy Color": ["OpenGBx.GBC.dat"],
  "Nintendo Super Nintendo Entertainment System": ["OpenSNES.SNES.dat"],
  "Sega 32X": ["OpenGen.32X.dat"],
  "Sega Game Gear": ["OpenGG.dat"],
  "Sega Master System": ["OpenSMS.dat"],
  "Sega Mega Drive _ Genesis": ["OpenGen.Gen.dat"],
  "TurboGrafx-16_PC Engine": ["OpenPCE.dat"],
});

// Redump uses these short system identifiers in its public DAT download URLs.
// Keep this list explicit. The site has no machine-readable system DAT index.
export const REDUMP_PLATFORMS = Object.freeze({
  "Acorn Archimedes": "arch",
  "Apple Macintosh": "mac",
  "Atari Jaguar CD Interactive Multimedia System": "ajcd",
  "Bandai Pippin": "pippin",
  "Bandai Playdia Quick Interactive System": "qis",
  "Commodore Amiga CD": "acd",
  "Commodore Amiga CD32": "cd32",
  "Commodore Amiga CDTV": "cdtv",
  "Fujitsu FM Towns series": "fmt",
  "funworld Photo Play": "fpp",
  "IBM PC compatible": "pc",
  "Incredible Technologies Eagle": "ite",
  "Konami e-Amusement": "kea",
  "Konami FireBeat": "kfb",
  "Konami System 573": "ks573",
  "Konami System GV": "ksgv",
  "Mattel Fisher-Price iXL": "ixl",
  "Mattel HyperScan": "hs",
  "Memorex Visual Information System": "vis",
  "Microsoft Xbox": "xbox",
  "Microsoft Xbox 360": "xbox360",
  "Namco - Sega - Nintendo Triforce": "trf",
  "Namco System 246": "ns246",
  "NEC PC Engine CD & TurboGrafx CD": "pce",
  "NEC PC-88 series": "pc-88",
  "NEC PC-98 series": "pc-98",
  "NEC PC-FX & PC-FXGA": "pc-fx",
  "Neo Geo CD": "ngcd",
  "Nintendo GameCube": "gc",
  "Nintendo Wii": "wii",
  "Palm OS": "palm",
  "Panasonic 3DO Interactive Multiplayer": "3do",
  "Philips CD-i": "cdi",
  "Photo CD": "photo-cd",
  "PlayStation GameShark Updates": "psxgs",
  "Pocket PC": "ppc",
  "Sega Chihiro": "chihiro",
  "Sega Dreamcast": "dc",
  "Sega Lindbergh": "lindbergh",
  "Sega Mega CD & Sega CD": "mcd",
  "Sega Naomi": "naomi",
  "Sega Naomi 2": "naomi2",
  "Sega Prologue 21 Multimedia Karaoke System": "sp21",
  "Sega RingEdge": "sre",
  "Sega RingEdge 2": "sre2",
  "Sega Saturn": "ss",
  "Sharp X68000": "x68k",
  "Sony PlayStation": "psx",
  "Sony PlayStation 2": "ps2",
  "Sony PlayStation 3": "ps3",
  "Sony PlayStation Portable": "psp",
  "TAB-Austria Quizard": "quizard",
  "Tomy Kiss-Site": "ksite",
  "VM Labs NUON": "nuon",
  "VTech V.Flash & V.Smile Pro": "vflash",
  "ZAPiT Games Game Wave Family Entertainment System": "gamewave",
});

export function slugifyPlatform(platform) {
  return platform
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

// Curated media-profile hints for known platform names. This map MUST NOT gate
// which platforms build. Unknown platforms get the default profile below.
export const DEFAULT_MEDIA_PROFILE = "nointro-single-image-v1";
export const REDUMP_DEFAULT_MEDIA_PROFILE = "redump-optical-single-image-v1";
export const KNOWN_PLATFORM_PROFILES = Object.freeze({
  "NEC PC Engine CD & TurboGrafx CD": "redump-cd-track-v1",
  "Neo Geo CD": "redump-cd-track-v1",
  "Nintendo 3DS": "3ds-decoded-card-v1",
  "Nintendo GameCube": "gamecube-decoded-iso-v1",
  "Nintendo New 3DS": "3ds-decoded-card-v1",
  "Nintendo Wii": "wii-decoded-iso-v1",
  "Playstation minis": "psp-decoded-iso-v1",
  "Sega Dreamcast": "redump-gdrom-track-v1",
  "Sega Mega CD & Sega CD": "redump-cd-track-v1",
  "Sega Saturn": "redump-cd-track-v1",
  "Sony PlayStation": "redump-cd-track-v1",
  "Sony PlayStation 2": "redump-cd-track-v1",
  "Sony PlayStation Portable": "psp-decoded-iso-v1",
});

// Curated alias table, keyed by canonical platform name. Alias matching is
// case-insensitive after normalizing: lowercase, collapse [^a-z0-9]+ to one
// space, trim. A platform's own normalized name always wins over another
// platform's curated alias (e.g. a discovered "GBA" dump directory claims
// "gba"); a collision between two platforms' own names is a build error.
export const CURATED_ALIASES = Object.freeze({
  "Family Computer Disk System": ["fds", "famicom disk system"],
  "Neo Geo Pocket": ["ngp"],
  "Neo Geo Pocket Color": ["ngpc"],
  "Nintendo 3DS": ["3ds"],
  "Nintendo DS": ["nds", "ds"],
  "Nintendo Entertainment System": ["nes", "famicom", "family computer"],
  "Nintendo Famicom Disk System": ["nintendo fds"],
  "Nintendo Game Boy": ["game boy", "gb"],
  "Nintendo Game Boy Advance": ["game boy advance", "gba"],
  "Nintendo Game Boy Color": ["game boy color", "gbc"],
  "Nintendo GameCube": ["gamecube", "gc", "ngc"],
  "Nintendo Super Nintendo Entertainment System": ["snes", "super famicom", "super nintendo"],
  "Nintendo Wii": ["wii"],
  "Sega Game Gear": ["game gear", "gg"],
  "Sega Master System": ["master system", "sms"],
  "Sega Mega Drive _ Genesis": [
    "genesis",
    "mega drive",
    "megadrive",
    "sega genesis",
    "sega mega drive",
  ],
  "Sony PlayStation": ["playstation", "psx", "ps1"],
  "Sony PlayStation 2": ["ps2", "playstation 2"],
  "Sony PlayStation Portable": ["psp", "playstation portable"],
  "TurboGrafx-16_PC Engine": ["turbografx", "turbografx 16", "pc engine"],
});

export function normalizeAlias(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

const ALGORITHMS = Object.freeze({
  crc32: { code: 0, hashBytes: 4 },
  md5: { code: 1, hashBytes: 16 },
  sha1: { code: 2, hashBytes: 20 },
});

const usage = () => `Build per-system ROM-identify packs from OpenGood (CC0 cartridge DATs) and
Redump (optical-disc DATs). OpenGood platforms emit RWFP1 packs. Redump
platforms emit grouped RWFP2 packs. index.json and catalog.json are written
next to the packs.

Usage:
  node scripts/build-identify-index.mjs
  node scripts/build-identify-index.mjs --only "Nintendo Entertainment System"

Options:
  --out <dir>              Output directory for per-system packs. Defaults to ${DEFAULT_OUT}
  --only <platforms>       Comma-separated platform name(s) to build (repeatable).
                          OpenGood-only selections skip Redump downloads.
  --opengood-only          Build every license-clear OpenGood platform.
  --redump-all             Build all configured Redump optical platforms too.
  --cache-dir <path>       Download and row-cache directory. Defaults to ${DEFAULT_CACHE_DIR}
  --refresh-dump           Redownload cached Redump DAT ZIP files.
  --force-row-cache        Rebuild the per-system row cache even if it matches.
  --keep-shared            RWFP1 only: keep ROMs that are byte-identical across
                          >1 game (shared CD audio tracks); default drops them.
                          RWFP2 always keeps them, marked non-discriminating.
  --download-only          Download/resolve sources, then stop.
  --no-brotli              Do not emit <pack>.br files.
  --brotli-quality <n>     Brotli quality 0-11. Defaults to 11.
  --max-objects <n>        Parse only the first n games per system (smoke tests).
  --allow-missing-platforms
                          Skip unknown requested platforms.
  --print-platforms        Print supported platforms with their source.
  --help                   Show this help.
`;

function parseArgs(argv) {
  const options = {
    allowMissingPlatforms: false,
    brotli: true,
    brotliQuality: 11,
    cacheDir: process.env.ROM_WEAVER_REDUMP_CACHE_DIR || DEFAULT_CACHE_DIR,
    downloadOnly: false,
    forceRowCache: false,
    keepShared: false,
    maxObjects: undefined,
    only: [],
    openGoodOnly: false,
    outPath: DEFAULT_OUT,
    printPlatforms: false,
    refreshDump: false,
    redumpAll: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };

    if (arg === "--cache-dir") options.cacheDir = readValue();
    else if (arg === "--out") options.outPath = readValue();
    else if (arg === "--only") {
      for (const name of readValue().split(",")) {
        const trimmed = name.trim();
        if (trimmed) options.only.push(trimmed);
      }
    } else if (arg === "--keep-shared") options.keepShared = true;
    else if (arg === "--opengood-only") options.openGoodOnly = true;
    else if (arg === "--redump-all") options.redumpAll = true;
    else if (arg === "--refresh-dump") options.refreshDump = true;
    else if (arg === "--force-row-cache") options.forceRowCache = true;
    else if (arg === "--download-only") options.downloadOnly = true;
    else if (arg === "--no-brotli") options.brotli = false;
    else if (arg === "--allow-missing-platforms") options.allowMissingPlatforms = true;
    else if (arg === "--print-platforms") options.printPlatforms = true;
    else if (arg === "--brotli-quality") options.brotliQuality = Number.parseInt(readValue(), 10);
    else if (arg === "--max-objects") options.maxObjects = Number.parseInt(readValue(), 10);
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.openGoodOnly && options.redumpAll) {
    throw new Error("--opengood-only cannot be combined with --redump-all");
  }

  if (
    !Number.isInteger(options.brotliQuality) ||
    options.brotliQuality < 0 ||
    options.brotliQuality > 11
  ) {
    throw new Error("--brotli-quality must be an integer from 0 through 11");
  }
  if (
    options.maxObjects !== undefined &&
    (!Number.isInteger(options.maxObjects) || options.maxObjects < 1)
  ) {
    throw new Error("--max-objects must be a positive integer");
  }
  return options;
}

function formatBytes(bytes) {
  return `${bytes.toLocaleString("en-US")} bytes (${(bytes / (1024 * 1024)).toFixed(2)} MiB)`;
}

function requireExecutable(name) {
  const check = spawnSync("sh", ["-lc", `command -v ${name}`], { stdio: "ignore" });
  if (check.status !== 0) throw new Error(`Required executable not found on PATH: ${name}`);
}

async function fileStat(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

async function runCurl(url, outputPath, expectedBytes) {
  const maxTimeSeconds = Math.max(900, Math.ceil(Number(expectedBytes || 0) / (384 * 1024)));
  const curl = spawn("curl", [
    "--fail",
    "--http1.1",
    "--location",
    "--show-error",
    "--silent",
    "--retry",
    "5",
    "--retry-all-errors",
    "--connect-timeout",
    "20",
    "--continue-at",
    "-",
    "--max-time",
    String(maxTimeSeconds),
    "--speed-limit",
    "32768",
    "--speed-time",
    "60",
    "--output",
    outputPath,
    url,
  ]);

  let stderr = "";
  curl.stderr.setEncoding("utf8");
  curl.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise((resolve, reject) => {
    curl.on("error", reject);
    curl.on("close", resolve);
  });
  if (exitCode !== 0) throw new Error(`curl failed with exit code ${exitCode}: ${stderr.trim()}`);
}

async function runCommandText(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0)
    throw new Error(`${command} failed with exit code ${exitCode}: ${stderr.trim()}`);
  return stdout;
}

async function downloadRedumpDat(platform, cacheDir, refresh) {
  const systemSlug = REDUMP_PLATFORMS[platform];
  if (!systemSlug) throw new Error(`Redump platform is not configured: ${platform}`);
  const dir = path.join(cacheDir, "redump");
  const destination = path.join(dir, `${systemSlug}.zip`);
  await mkdir(dir, { recursive: true });
  const existing = await fileStat(destination);
  if (existing?.isFile() && existing.size > 0 && !refresh) return destination;

  const temporary = `${destination}.part`;
  console.error(`[identify] downloading Redump DAT: ${platform} (${systemSlug})`);
  await runCurl(`${REDUMP_DAT_BASE}${systemSlug}/`, temporary, undefined);
  const downloaded = await fileStat(temporary);
  if (!downloaded?.isFile() || downloaded.size === 0) {
    throw new Error(`Redump download produced no data: ${platform}`);
  }
  const listing = await runCommandText("unzip", ["-Z1", temporary]);
  if (!listing.trim()) throw new Error(`Redump download is not a DAT ZIP: ${platform}`);
  await rename(temporary, destination);
  return destination;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function normalizeHex(value, expectedLength) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized.length !== expectedLength) return "";
  return /^[0-9a-f]+$/u.test(normalized) ? normalized : "";
}

function base64Utf8(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

// Normalize one ROM's hashes and append a row to the shared rows stream.
// Shared by the Redump (JSON) and OpenGood (XML) producers so both emit the
// identical `crc\tmd5\tsha1\tplatformB64\tnameB64` line format.
async function writeRow(state, rawCrc, rawMd5, rawSha1, platform, name) {
  state.romRows += 1;
  const crc32 = normalizeHex(rawCrc, 8);
  const md5 = normalizeHex(rawMd5, 32);
  const sha1 = normalizeHex(rawSha1, 40);
  if (!crc32 && !md5 && !sha1) {
    state.rowsMissingAllHashes += 1;
    return;
  }
  if (
    !state.stream.write(`${crc32}\t${md5}\t${sha1}\t${base64Utf8(platform)}\t${base64Utf8(name)}\n`)
  ) {
    await once(state.stream, "drain");
  }
  state.rowsWithAnyHash += 1;
}

const XML_ENTITIES = Object.freeze({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' });

function xmlUnescape(value) {
  return value.replace(/&(amp|apos|gt|lt|quot|#x?[0-9a-fA-F]+);/gu, (match, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[entity] ?? match;
  });
}

function parseAttributes(tag) {
  const attributes = {};
  const matcher = /([\w-]+)\s*=\s*"([^"]*)"/gu;
  let match = matcher.exec(tag);
  while (match) {
    attributes[match[1]] = xmlUnescape(match[2]);
    match = matcher.exec(tag);
  }
  return attributes;
}

// Parse a Logiqx XML DAT (OpenGood / clrmamepro export). The <game name="...">
// attribute is the exact dump name we want to surface (e.g.
// `Legend of Zelda, The (U) (PRG0) [!]`); each nested <rom> carries the
// crc/md5/sha1. One normalized row is emitted per <rom>.
async function parseOpenGoodDat(text, platform, state) {
  const gameChunks = text.split(/<game\b/u);
  for (let index = 1; index < gameChunks.length; index += 1) {
    if (state.stopParsing) return;
    state.jsonObjects += 1;
    if (state.maxObjects && state.jsonObjects > state.maxObjects) {
      state.stopParsing = true;
      return;
    }
    const chunk = gameChunks[index];
    const headerEnd = chunk.indexOf(">");
    if (headerEnd < 0) continue;
    const nameMatch = chunk.slice(0, headerEnd).match(/\bname="([^"]*)"/u);
    if (!nameMatch) continue;
    const gameName = xmlUnescape(nameMatch[1]).trim();
    if (!gameName) continue;

    const romMatcher = /<rom\b([^>]*?)\/?>/gu;
    let romMatch = romMatcher.exec(chunk);
    while (romMatch) {
      const rom = parseAttributes(romMatch[1]);
      await writeRow(state, rom.crc, rom.md5, rom.sha1, platform, gameName);
      romMatch = romMatcher.exec(chunk);
    }

    if (state.jsonObjects % 25000 === 0) {
      console.error(
        `[identify] parsed ${state.jsonObjects.toLocaleString("en-US")} game object(s), ` +
          `${state.rowsWithAnyHash.toLocaleString("en-US")} hash row(s)`,
      );
    }
  }
}

async function downloadOpenGoodDat(datFile, cacheDir) {
  const dir = path.join(cacheDir, "opengood", OPENGOOD_REVISION);
  await mkdir(dir, { recursive: true });
  const destination = path.join(dir, datFile);
  const existing = await fileStat(destination);
  if (existing?.isFile() && existing.size > 0) {
    return destination;
  }
  const temporary = `${destination}.part`;
  console.error(`[identify] downloading OpenGood DAT: ${datFile}`);
  await runCurl(`${OPENGOOD_RAW_BASE}${datFile}`, temporary, undefined);
  const downloaded = await fileStat(temporary);
  if (!downloaded?.isFile() || downloaded.size === 0) {
    throw new Error(`OpenGood download produced no data: ${datFile}`);
  }
  await rename(temporary, destination);
  return destination;
}

function redumpGameRecord(chunk, platform) {
  const headerEnd = chunk.indexOf(">");
  if (headerEnd < 0) return undefined;
  const game = parseAttributes(chunk.slice(0, headerEnd));
  const gameName = String(game.name || "").trim();
  if (!gameName) return undefined;

  const components = [];
  const romMatcher = /<rom\b([^>]*?)\/?>/gu;
  let romMatch = romMatcher.exec(chunk);
  while (romMatch) {
    const rom = parseAttributes(romMatch[1]);
    const component = {
      ordinal: components.length,
      size: /^\d+$/u.test(rom.size || "") ? Number.parseInt(rom.size, 10) : 0,
    };
    const filename = String(rom.name || "").trim();
    if (filename) component.filename = filename;
    const crc32 = normalizeHex(rom.crc, 8);
    const md5 = normalizeHex(rom.md5, 32);
    const sha1 = normalizeHex(rom.sha1, 40);
    if (crc32) component.crc32 = crc32;
    if (md5) component.md5 = md5;
    if (sha1) component.sha1 = sha1;
    if (crc32 || md5 || sha1) components.push(component);
    romMatch = romMatcher.exec(chunk);
  }
  if (components.length === 0) return undefined;

  return {
    name: gameName,
    platform,
    upstreamSource: "redump",
    components,
  };
}

async function datFingerprint(datPath) {
  const info = await stat(datPath);
  return {
    fileName: path.basename(datPath),
    mtimeMs: Math.trunc(info.mtimeMs),
    sizeBytes: info.size,
  };
}

async function openGoodFingerprint(platform, ctx) {
  const fingerprint = [];
  for (const datFile of OPENGOOD_PLATFORMS[platform]) {
    const info = await stat(ctx.openGoodPaths.get(datFile));
    fingerprint.push({ datFile, mtimeMs: Math.trunc(info.mtimeMs), sizeBytes: info.size });
  }
  return fingerprint;
}

function platformRowPaths(cacheDir, slug) {
  const dir = path.join(cacheDir, "identify-rows");
  return {
    dir,
    manifestPath: path.join(dir, `${slug}.manifest.json`),
    rowsPath: path.join(dir, `${slug}.tsv`),
  };
}

function platformGamePaths(cacheDir, slug) {
  const dir = path.join(cacheDir, "identify-games");
  return {
    dir,
    gamesPath: path.join(dir, `${slug}.jsonl`),
    manifestPath: path.join(dir, `${slug}.manifest.json`),
  };
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function rowsCacheValid(manifest, fingerprint, source, maxObjects) {
  if (!manifest || manifest.format !== ROW_CACHE_FORMAT) return false;
  if (manifest.source !== source) return false;
  if (manifest.maxObjects !== (maxObjects ?? null)) return false;
  return JSON.stringify(manifest.fingerprint) === JSON.stringify(fingerprint);
}

async function produceOpenGoodRows(platform, state, ctx) {
  for (const datFile of OPENGOOD_PLATFORMS[platform]) {
    if (state.stopParsing) break;
    const text = await readFile(ctx.openGoodPaths.get(datFile), "utf8");
    await parseOpenGoodDat(text, platform, state);
  }
}

async function produceRedumpGames(platform, state, ctx) {
  const text = await runCommandText("unzip", ["-p", ctx.redumpPaths.get(platform)]);
  const gameChunks = text.split(/<game\b/u);
  for (let index = 1; index < gameChunks.length; index += 1) {
    state.jsonObjects += 1;
    if (state.maxObjects && state.jsonObjects > state.maxObjects) break;
    const record = redumpGameRecord(gameChunks[index], platform);
    if (!record) continue;
    state.games += 1;
    state.components += record.components.length;
    if (!state.stream.write(`${JSON.stringify(record)}\n`)) {
      await once(state.stream, "drain");
    }
  }
}

// Build (or reuse a cached) normalized rows.tsv for a single OpenGood platform.
// Each platform is cached independently so re-runs only rebuild what changed.
async function buildPlatformRows(platform, ctx) {
  const source = "opengood";
  const slug = slugifyPlatform(platform);
  const paths = platformRowPaths(ctx.cacheDir, slug);
  const fingerprint = await openGoodFingerprint(platform, ctx);

  const rowsStat = await fileStat(paths.rowsPath);
  const manifest = await readJsonFile(paths.manifestPath);
  if (
    rowsStat?.isFile() &&
    !ctx.forceRowCache &&
    rowsCacheValid(manifest, fingerprint, source, ctx.maxObjects)
  ) {
    console.error(`[identify] ${platform}: using cached rows (${formatBytes(rowsStat.size)})`);
    return { ...paths, manifest, slug, source };
  }

  await mkdir(paths.dir, { recursive: true });
  const tempRowsPath = `${paths.rowsPath}.part`;
  const stream = createWriteStream(tempRowsPath);
  const state = {
    jsonObjects: 0,
    maxObjects: ctx.maxObjects,
    romRows: 0,
    rowsMissingAllHashes: 0,
    rowsWithAnyHash: 0,
    stopParsing: false,
    stream,
  };

  console.error(`[identify] ${platform}: extracting rows from ${source}`);
  await produceOpenGoodRows(platform, state, ctx);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
  await rename(tempRowsPath, paths.rowsPath);

  const nextManifest = {
    format: ROW_CACHE_FORMAT,
    generatedAt: ctx.generatedAt,
    platform,
    source,
    fingerprint,
    maxObjects: ctx.maxObjects ?? null,
    stats: {
      gameObjects: state.jsonObjects,
      romRows: state.romRows,
      rowsMissingAllHashes: state.rowsMissingAllHashes,
      rowsWithAnyHash: state.rowsWithAnyHash,
    },
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  const written = await stat(paths.rowsPath);
  console.error(
    `[identify] ${platform}: wrote rows (${formatBytes(written.size)}, ` +
      `${state.rowsWithAnyHash.toLocaleString("en-US")} hash row(s))`,
  );
  return { ...paths, manifest: nextManifest, slug, source };
}

// Build (or reuse a cached) grouped games.jsonl for a single Redump platform:
// one JSON game record per line, components preserved with their dump order.
async function buildPlatformGames(platform, ctx) {
  const slug = slugifyPlatform(platform);
  const paths = platformGamePaths(ctx.cacheDir, slug);
  const fingerprint = await datFingerprint(ctx.redumpPaths.get(platform));

  const gamesStat = await fileStat(paths.gamesPath);
  const manifest = await readJsonFile(paths.manifestPath);
  if (
    gamesStat?.isFile() &&
    !ctx.forceRowCache &&
    manifest?.format === GAME_CACHE_FORMAT &&
    manifest.source === "redump" &&
    manifest.maxObjects === (ctx.maxObjects ?? null) &&
    JSON.stringify(manifest.fingerprint) === JSON.stringify(fingerprint)
  ) {
    console.error(`[identify] ${platform}: using cached games (${formatBytes(gamesStat.size)})`);
    return { ...paths, manifest, slug, source: "redump" };
  }

  await mkdir(paths.dir, { recursive: true });
  const tempGamesPath = `${paths.gamesPath}.part`;
  const stream = createWriteStream(tempGamesPath);
  const state = {
    components: 0,
    games: 0,
    jsonObjects: 0,
    maxObjects: ctx.maxObjects,
    stopParsing: false,
    stream,
  };

  console.error(`[identify] ${platform}: extracting grouped games from redump`);
  await produceRedumpGames(platform, state, ctx);

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
  await rename(tempGamesPath, paths.gamesPath);

  const nextManifest = {
    format: GAME_CACHE_FORMAT,
    generatedAt: ctx.generatedAt,
    platform,
    source: "redump",
    fingerprint,
    maxObjects: ctx.maxObjects ?? null,
    stats: {
      components: state.components,
      gameObjects: state.jsonObjects,
      games: state.games,
    },
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  const written = await stat(paths.gamesPath);
  console.error(
    `[identify] ${platform}: wrote games (${formatBytes(written.size)}, ` +
      `${state.games.toLocaleString("en-US")} game(s))`,
  );
  return { ...paths, manifest: nextManifest, slug, source: "redump" };
}

class IdTable {
  constructor(seedValues = []) {
    this.ids = new Map();
    this.values = [];
    for (const value of seedValues) this.getId(value);
  }

  getId(value) {
    const existing = this.ids.get(value);
    if (existing !== undefined) return existing;
    const id = this.values.length;
    this.ids.set(value, id);
    this.values.push(value);
    return id;
  }
}

class PairTable {
  constructor() {
    this.ids = new Map();
    this.values = [];
  }

  getId(nameId, platformId) {
    const key = `${nameId}:${platformId}`;
    const existing = this.ids.get(key);
    if (existing !== undefined) return existing;
    const id = this.values.length;
    this.ids.set(key, id);
    this.values.push({ nameId, platformId });
    return id;
  }
}

function decodeRow(line) {
  const [crc32, md5, sha1, platformBase64, nameBase64] = line.split("\t");
  if (nameBase64 === undefined) return undefined;
  return {
    crc32,
    md5,
    name: Buffer.from(nameBase64, "base64").toString("utf8"),
    platform: Buffer.from(platformBase64, "base64").toString("utf8"),
    sha1,
  };
}

async function* readRows(rowsPath) {
  const lines = readline.createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(rowsPath),
  });
  for await (const line of lines) {
    if (!line) continue;
    const row = decodeRow(line);
    if (row) yield row;
  }
}

function addHashValue(map, hash, pairId) {
  if (!hash) return;
  const existing = map.get(hash);
  if (existing === undefined) {
    map.set(hash, pairId);
    return;
  }
  if (existing === pairId) return;
  if (Array.isArray(existing)) {
    if (!existing.includes(pairId)) existing.push(pairId);
    return;
  }
  map.set(hash, [existing, pairId]);
}

function ambiguousHashes(map) {
  const ambiguous = new Set();
  for (const [hash, value] of map) {
    if (Array.isArray(value) && value.length > 1) ambiguous.add(hash);
  }
  return ambiguous;
}

function mapCounts(map) {
  let conflictEntries = 0;
  let conflictValues = 0;
  for (const value of map.values()) {
    if (Array.isArray(value)) {
      conflictEntries += 1;
      conflictValues += value.length;
    }
  }
  return {
    conflictEntries,
    conflictValues,
    keys: map.size,
  };
}

async function countRows(rowsPath) {
  let rows = 0;
  let crcOnlyRows = 0;
  let md5OnlyRows = 0;
  let sha1OnlyRows = 0;
  for await (const row of readRows(rowsPath)) {
    rows += 1;
    if (row.crc32 && !row.md5 && !row.sha1) crcOnlyRows += 1;
    if (!row.crc32 && row.md5 && !row.sha1) md5OnlyRows += 1;
    if (!row.crc32 && !row.md5 && row.sha1) sha1OnlyRows += 1;
  }
  return { crcOnlyRows, md5OnlyRows, rows, sha1OnlyRows };
}

// Find ROMs that are byte-identical across MORE THAN ONE game within a system:
// rows sharing the same (crc, md5, sha1) but mapping to ≥2 distinct game names.
// These are overwhelmingly shared CD audio tracks (silence/standard pre-gaps),
// which can never identify a single game and which otherwise force large md5/
// sha1 fallback maps. md5 must be present to prove byte-identity. Returns the
// set of `crc|md5|sha1` triples to drop.
async function collectSharedTriples(rowsPath) {
  const firstPair = new Map();
  const shared = new Set();
  for await (const row of readRows(rowsPath)) {
    if (!row.md5) continue;
    const triple = `${row.crc32}|${row.md5}|${row.sha1}`;
    if (shared.has(triple)) continue;
    const pairKey = `${row.name}\0${row.platform}`;
    const existing = firstPair.get(triple);
    if (existing === undefined) {
      firstPair.set(triple, pairKey);
    } else if (existing !== pairKey) {
      shared.add(triple);
      firstPair.delete(triple);
    }
  }
  return shared;
}

function isSharedRow(row, sharedTriples) {
  return Boolean(row.md5) && sharedTriples.has(`${row.crc32}|${row.md5}|${row.sha1}`);
}

async function buildIndexParts(rowsPath, selectedPlatforms, dropShared = true) {
  const names = new IdTable();
  const platforms = new IdTable(selectedPlatforms);
  const pairs = new PairTable();
  const crc32 = new Map();
  const sharedTriples = dropShared ? await collectSharedTriples(rowsPath) : new Set();

  let rows = 0;
  let droppedSharedRows = 0;
  for await (const row of readRows(rowsPath)) {
    rows += 1;
    if (isSharedRow(row, sharedTriples)) {
      droppedSharedRows += 1;
      continue;
    }
    const nameId = names.getId(row.name);
    const platformId = platforms.getId(row.platform);
    const pairId = pairs.getId(nameId, platformId);
    addHashValue(crc32, row.crc32, pairId);
  }

  const crcAmbiguous = ambiguousHashes(crc32);
  const md5 = new Map();
  let md5RowsAddedForMissingCrc = 0;
  let md5RowsAddedForAmbiguousCrc = 0;
  for await (const row of readRows(rowsPath)) {
    if (isSharedRow(row, sharedTriples)) continue;
    if (!row.md5) continue;
    if (row.crc32 && !crcAmbiguous.has(row.crc32)) continue;
    const nameId = names.getId(row.name);
    const platformId = platforms.getId(row.platform);
    const pairId = pairs.getId(nameId, platformId);
    addHashValue(md5, row.md5, pairId);
    if (row.crc32) md5RowsAddedForAmbiguousCrc += 1;
    else md5RowsAddedForMissingCrc += 1;
  }

  const md5Ambiguous = ambiguousHashes(md5);
  const sha1 = new Map();
  let sha1RowsAddedForMissingCrcMd5 = 0;
  let sha1RowsAddedForAmbiguousCrcWithoutMd5 = 0;
  let sha1RowsAddedForAmbiguousMd5 = 0;
  for await (const row of readRows(rowsPath)) {
    if (isSharedRow(row, sharedTriples)) continue;
    if (!row.sha1) continue;
    const crcAmbiguousForRow = row.crc32 && crcAmbiguous.has(row.crc32);
    const md5FallbackForRow = row.md5 && (!row.crc32 || crcAmbiguousForRow);
    const shouldAdd =
      (!row.crc32 && !row.md5) ||
      (crcAmbiguousForRow && !row.md5) ||
      (md5FallbackForRow && md5Ambiguous.has(row.md5));
    if (!shouldAdd) continue;

    const nameId = names.getId(row.name);
    const platformId = platforms.getId(row.platform);
    const pairId = pairs.getId(nameId, platformId);
    addHashValue(sha1, row.sha1, pairId);
    if (!row.crc32 && !row.md5) sha1RowsAddedForMissingCrcMd5 += 1;
    else if (crcAmbiguousForRow && !row.md5) sha1RowsAddedForAmbiguousCrcWithoutMd5 += 1;
    else sha1RowsAddedForAmbiguousMd5 += 1;
  }

  return {
    fallbackStats: {
      crcAmbiguousKeys: crcAmbiguous.size,
      droppedSharedRows,
      droppedSharedTriples: sharedTriples.size,
      md5RowsAddedForAmbiguousCrc,
      md5RowsAddedForMissingCrc,
      sha1RowsAddedForAmbiguousCrcWithoutMd5,
      sha1RowsAddedForAmbiguousMd5,
      sha1RowsAddedForMissingCrcMd5,
    },
    maps: { crc32, md5, sha1 },
    names: names.values,
    pairs: pairs.values,
    platforms: platforms.values,
    rowCounts: await countRows(rowsPath),
    rows,
  };
}

function writeHashMap(algorithm, values) {
  const info = ALGORITHMS[algorithm];
  const keys = [...values.keys()].sort();
  const encodedValues = new Map();
  const conflictOffsets = [0];
  const conflictValues = [];

  for (const key of keys) {
    const value = values.get(key);
    if (Array.isArray(value)) {
      const uniqueIds = [...new Set(value)].sort((a, b) => a - b);
      const conflictIndex = conflictOffsets.length - 1;
      if (conflictIndex >= CONFLICT_VALUE_FLAG)
        throw new Error(`Too many conflicts in ${algorithm}`);
      encodedValues.set(key, CONFLICT_VALUE_FLAG + conflictIndex);
      conflictValues.push(...uniqueIds);
      conflictOffsets.push(conflictValues.length);
    } else {
      if (value >= CONFLICT_VALUE_FLAG)
        throw new Error(`Pair id exceeds binary format limit in ${algorithm}`);
      encodedValues.set(key, value);
    }
  }

  const recordWidth = info.hashBytes + 4;
  const headerBytes = 20;
  const buffer = Buffer.allocUnsafe(
    headerBytes +
      keys.length * recordWidth +
      conflictOffsets.length * 4 +
      conflictValues.length * 4,
  );
  HASH_MAGIC.copy(buffer, 0);
  buffer.writeUInt8(info.code, 4);
  buffer.writeUInt8(0, 5);
  buffer.writeUInt8(info.hashBytes, 6);
  buffer.writeUInt8(0, 7);
  buffer.writeUInt32LE(keys.length, 8);
  buffer.writeUInt32LE(conflictOffsets.length - 1, 12);
  buffer.writeUInt32LE(conflictValues.length, 16);

  let cursor = headerBytes;
  for (const key of keys) {
    Buffer.from(key, "hex").copy(buffer, cursor);
    cursor += info.hashBytes;
    buffer.writeUInt32LE(encodedValues.get(key), cursor);
    cursor += 4;
  }
  for (const offset of conflictOffsets) {
    buffer.writeUInt32LE(offset, cursor);
    cursor += 4;
  }
  for (const pairId of conflictValues) {
    buffer.writeUInt32LE(pairId, cursor);
    cursor += 4;
  }
  return buffer;
}

function writeNamePlatformPairs(pairs) {
  if (pairs.some((pair) => pair.platformId > 0xffff)) {
    throw new Error("Too many platforms for u16 name-platform pair table");
  }
  const buffer = Buffer.allocUnsafe(8 + pairs.length * 6);
  PAIR_MAGIC.copy(buffer, 0);
  buffer.writeUInt16LE(1, 4);
  buffer.writeUInt16LE(6, 6);
  let cursor = 8;
  for (const pair of pairs) {
    buffer.writeUInt32LE(pair.nameId, cursor);
    cursor += 4;
    buffer.writeUInt16LE(pair.platformId, cursor);
    cursor += 2;
  }
  return buffer;
}

function writePack(entries, magic = PACK_MAGIC) {
  const headerBytes =
    magic.length +
    4 +
    entries.reduce((sum, entry) => sum + 2 + 8 + Buffer.byteLength(entry.name, "utf8"), 0);
  const payloadBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const buffer = Buffer.allocUnsafe(headerBytes + payloadBytes);
  magic.copy(buffer, 0);
  let cursor = magic.length;
  buffer.writeUInt32LE(entries.length, cursor);
  cursor += 4;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    buffer.writeUInt16LE(name.length, cursor);
    cursor += 2;
    buffer.writeBigUInt64LE(BigInt(entry.bytes.length), cursor);
    cursor += 8;
    name.copy(buffer, cursor);
    cursor += name.length;
  }
  for (const entry of entries) {
    entry.bytes.copy(buffer, cursor);
    cursor += entry.bytes.length;
  }
  return buffer;
}

async function brotliCompress(buffer, quality) {
  return new Promise((resolve, reject) => {
    zlib.brotliCompress(
      buffer,
      { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } },
      (error, compressed) => {
        if (error) reject(error);
        else resolve(compressed);
      },
    );
  });
}

// Split the requested platform names into the OpenGood half (static list) and
// the Redump half. A plain build stays OpenGood-only. Release builds opt in to
// every configured optical platform with --redump-all.
function resolveSelection(options) {
  const openGoodAll = Object.keys(OPENGOOD_PLATFORMS);
  if (options.openGoodOnly) {
    if (options.only.length > 0) throw new Error("--opengood-only cannot be combined with --only");
    return { openGoodSelected: openGoodAll, redumpRequested: [], redumpAll: false };
  }
  if (!options.only || options.only.length === 0) {
    return {
      openGoodSelected: openGoodAll,
      redumpRequested: [],
      redumpAll: options.redumpAll,
    };
  }
  const openGoodSet = new Set(openGoodAll);
  return {
    openGoodSelected: options.only.filter((platform) => openGoodSet.has(platform)),
    redumpRequested: options.only.filter((platform) => !openGoodSet.has(platform)),
    redumpAll: false,
  };
}

function discoverRedumpPlatforms(selection, options) {
  const configured = new Set(Object.keys(REDUMP_PLATFORMS));
  if (selection.redumpAll) return [...configured].sort();
  const missing = selection.redumpRequested.filter((platform) => !configured.has(platform));
  if (missing.length > 0 && !options.allowMissingPlatforms) {
    throw new Error(
      `Redump platform(s) are not configured: ${missing.join(", ")}. Use --print-platforms to list valid names.`,
    );
  }
  if (missing.length > 0) {
    console.error(`[identify] skipping ${missing.length} unknown Redump platform(s)`);
  }
  return selection.redumpRequested.filter((platform) => configured.has(platform)).sort();
}

// Assemble one RWFP1 pack for a single platform from its built index parts.
// Format is identical to the original single global pack, just scoped to one
// platform so a reader can lazy-load only the system it needs.
function buildSystemPack(platform, source, parts) {
  const crc32 = writeHashMap("crc32", parts.maps.crc32);
  const md5 = writeHashMap("md5", parts.maps.md5);
  const sha1 = writeHashMap("sha1", parts.maps.sha1);
  const namePlatforms = writeNamePlatformPairs(parts.pairs);
  const names = Buffer.from(JSON.stringify(parts.names), "utf8");
  const platforms = Buffer.from(JSON.stringify(parts.platforms), "utf8");

  const manifest = {
    format: INDEX_FORMAT,
    platform,
    source,
    hashStrategy: "crc-primary-md5-sha1-fallback-per-system",
    counts: {
      crcKeys: parts.maps.crc32.size,
      md5FallbackKeys: parts.maps.md5.size,
      namePlatformPairs: parts.pairs.length,
      names: parts.names.length,
      platforms: parts.platforms.length,
      sha1FallbackKeys: parts.maps.sha1.size,
    },
    fallbackStats: {
      ...parts.fallbackStats,
      crcConflictValues: mapCounts(parts.maps.crc32).conflictValues,
      md5ConflictValues: mapCounts(parts.maps.md5).conflictValues,
      sha1ConflictValues: mapCounts(parts.maps.sha1).conflictValues,
    },
    rowCounts: parts.rowCounts,
    sizes: {
      crc32: { rawBytes: crc32.length, ...mapCounts(parts.maps.crc32) },
      md5: { rawBytes: md5.length, ...mapCounts(parts.maps.md5) },
      namePlatforms: { rawBytes: namePlatforms.length },
      names: { rawBytes: names.length },
      platforms: { rawBytes: platforms.length },
      sha1: { rawBytes: sha1.length, ...mapCounts(parts.maps.sha1) },
    },
  };
  return writePack([
    { name: "crc32.bin", bytes: crc32 },
    { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "md5.bin", bytes: md5 },
    { name: "name-platforms.bin", bytes: namePlatforms },
    { name: "names.json", bytes: names },
    { name: "platforms.json", bytes: platforms },
    { name: "sha1.bin", bytes: sha1 },
  ]);
}

async function writeSystemPack(platform, rows, options) {
  console.error(`[identify] ${platform}: building per-system pack`);
  const parts = await buildIndexParts(rows.rowsPath, [platform], !options.keepShared);
  const pack = buildSystemPack(platform, rows.source, parts);
  const fileName = `${rows.slug}.pack`;
  const outPath = path.join(options.outPath, fileName);
  await writeFile(outPath, pack);

  const system = {
    platform,
    slug: rows.slug,
    source: rows.source,
    file: fileName,
    rawBytes: pack.length,
    sha256: crypto.createHash("sha256").update(pack).digest("hex"),
    entries: {
      crcKeys: parts.maps.crc32.size,
      md5FallbackKeys: parts.maps.md5.size,
      sha1FallbackKeys: parts.maps.sha1.size,
      names: parts.names.length,
    },
    droppedSharedRows: parts.fallbackStats.droppedSharedRows,
    rowCounts: parts.rowCounts,
  };
  if (options.brotli) {
    const compressed = await brotliCompress(pack, options.brotliQuality);
    await writeFile(`${outPath}.br`, compressed);
    system.brotliFile = `${fileName}.br`;
    system.brotliBytes = compressed.length;
  }
  console.error(
    `[identify] ${platform}: wrote ${fileName} (${formatBytes(pack.length)}` +
      `${system.brotliBytes ? `, br ${formatBytes(system.brotliBytes)}` : ""}` +
      `${system.droppedSharedRows ? `, dropped ${system.droppedSharedRows.toLocaleString("en-US")} shared` : ""})`,
  );
  return system;
}

async function* readGames(gamesPath) {
  const lines = readline.createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(gamesPath),
  });
  for await (const line of lines) {
    if (line) yield JSON.parse(line);
  }
}

// Load every game for one platform and sort deterministically. The spec orders
// games.json by (platform, name); gameId and input order break ties so a dump
// with duplicate names still rebuilds byte-identically.
// The Rust reader rejects a whole pack when any record exceeds its caps
// (4096-byte strings, 10,000 components per game, 4,000,000 games), so the
// writer MUST drop an oversized record instead of emitting an unreadable pack.
const READER_MAX_STRING_BYTES = 4096;
const READER_MAX_COMPONENTS_PER_GAME = 10000;
const READER_MAX_GAMES = 4000000;

function gameWithinPackCaps(game) {
  const stringOk = (value) =>
    value === undefined || Buffer.byteLength(String(value), "utf8") <= READER_MAX_STRING_BYTES;
  return (
    stringOk(game.name) &&
    stringOk(game.platform) &&
    stringOk(game.gameId) &&
    stringOk(game.region) &&
    stringOk(game.language) &&
    game.components.length <= READER_MAX_COMPONENTS_PER_GAME &&
    game.components.every((component) => stringOk(component.filename))
  );
}

async function loadSortedGames(gamesPath) {
  const games = [];
  let skippedOverCaps = 0;
  for await (const game of readGames(gamesPath)) {
    if (!gameWithinPackCaps(game) || games.length >= READER_MAX_GAMES) {
      skippedOverCaps += 1;
      continue;
    }
    game.inputIndex = games.length;
    games.push(game);
  }
  if (skippedOverCaps > 0) {
    console.error(
      `[identify] skipped ${skippedOverCaps} game record(s) that exceed the RWFP2 reader caps`,
    );
  }
  // Codepoint comparison, never localeCompare: ICU collation varies by
  // machine and would break the byte-identical rebuild promise.
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  games.sort(
    (a, b) =>
      compare(a.platform, b.platform) ||
      compare(a.name, b.name) ||
      compare(String(a.gameId ?? ""), String(b.gameId ?? "")) ||
      a.inputIndex - b.inputIndex,
  );
  return games;
}

// Mark components byte-identical across MORE THAN ONE game (same size plus the
// same md5 or the same sha1) as non-discriminating. They stay in games.json but
// are excluded from route.bin: a shared CD audio track can never pick one game.
function markSharedComponents(games) {
  const owners = new Map();
  const keysOf = (component) => {
    const keys = [];
    if (component.md5) keys.push(`${component.size}|m|${component.md5}`);
    if (component.sha1) keys.push(`${component.size}|s|${component.sha1}`);
    return keys;
  };
  games.forEach((game, gameIndex) => {
    for (const component of game.components) {
      for (const key of keysOf(component)) {
        const owner = owners.get(key);
        if (owner === undefined) owners.set(key, gameIndex);
        else if (owner !== gameIndex) owners.set(key, -1);
      }
    }
  });
  let sharedComponents = 0;
  for (const game of games) {
    for (const component of game.components) {
      component.discriminating = !keysOf(component).some((key) => owners.get(key) === -1);
      if (!component.discriminating) sharedComponents += 1;
    }
  }
  return sharedComponents;
}

// Serialize games.json with a fixed key order and optional keys omitted, so
// identical input always produces identical bytes.
function gamesJsonBytes(games) {
  const serialized = games.map((game) => {
    const out = {
      name: game.name,
      platform: game.platform,
      source: "redump",
      upstreamSource: game.upstreamSource || "unknown",
    };
    if (game.gameId !== undefined) out.gameId = game.gameId;
    if (game.region !== undefined) out.region = game.region;
    if (game.language !== undefined) out.language = game.language;
    out.components = game.components.map((component) => {
      const entry = { role: "primary_payload", ordinal: component.ordinal };
      if (component.filename !== undefined) entry.filename = component.filename;
      entry.size = component.size;
      if (component.crc32 !== undefined) entry.crc32 = component.crc32;
      if (component.md5 !== undefined) entry.md5 = component.md5;
      if (component.sha1 !== undefined) entry.sha1 = component.sha1;
      if (component.sha256 !== undefined) entry.sha256 = component.sha256;
      entry.required = true;
      entry.discriminating = component.discriminating;
      return entry;
    });
    return out;
  });
  return Buffer.from(JSON.stringify(serialized), "utf8");
}

// Build route.bin (RWR2) and refs.bin (RWX2). Only discriminating components
// with a crc32 and size > 0 get routed; a ref id is the index of the
// (game_index, component_index) record in refs.bin.
function buildRouteAndRefs(games) {
  const refs = [];
  const byKey = new Map();
  games.forEach((game, gameIndex) => {
    if (gameIndex > 0xffffffff) throw new Error("Too many games for u32 game index");
    game.components.forEach((component, componentIndex) => {
      if (componentIndex > 0xffff) throw new Error("Too many components for u16 component index");
      if (!component.discriminating || !component.crc32 || !(component.size > 0)) return;
      const refId = refs.length;
      refs.push({ gameIndex, componentIndex });
      const key = `${component.crc32}|${component.size}`;
      const existing = byKey.get(key);
      if (existing === undefined) byKey.set(key, [refId]);
      else existing.push(refId);
    });
  });

  const keys = [...byKey.keys()].sort((a, b) => {
    const [crcA, sizeA] = a.split("|");
    const [crcB, sizeB] = b.split("|");
    return crcA < crcB ? -1 : crcA > crcB ? 1 : Number(sizeA) - Number(sizeB);
  });

  const conflictOffsets = [0];
  const conflictValues = [];
  const values = [];
  for (const key of keys) {
    const refIds = byKey.get(key);
    if (refIds.length === 1) {
      if (refIds[0] >= CONFLICT_VALUE_FLAG) throw new Error("Ref id exceeds RWR2 format limit");
      values.push(refIds[0]);
    } else {
      const conflictIndex = conflictOffsets.length - 1;
      if (conflictIndex >= CONFLICT_VALUE_FLAG) throw new Error("Too many conflicts in route.bin");
      values.push(CONFLICT_VALUE_FLAG + conflictIndex);
      conflictValues.push(...refIds);
      conflictOffsets.push(conflictValues.length);
    }
  }

  const headerBytes = 20;
  const recordWidth = 16;
  const route = Buffer.allocUnsafe(
    headerBytes +
      keys.length * recordWidth +
      conflictOffsets.length * 4 +
      conflictValues.length * 4,
  );
  ROUTE_MAGIC.copy(route, 0);
  route.writeUInt16LE(1, 4);
  route.writeUInt16LE(0, 6);
  route.writeUInt32LE(keys.length, 8);
  route.writeUInt32LE(conflictOffsets.length - 1, 12);
  route.writeUInt32LE(conflictValues.length, 16);
  let cursor = headerBytes;
  keys.forEach((key, index) => {
    const [crc, size] = key.split("|");
    Buffer.from(crc, "hex").copy(route, cursor);
    cursor += 4;
    route.writeBigUInt64LE(BigInt(size), cursor);
    cursor += 8;
    route.writeUInt32LE(values[index], cursor);
    cursor += 4;
  });
  for (const offset of conflictOffsets) {
    route.writeUInt32LE(offset, cursor);
    cursor += 4;
  }
  for (const refId of conflictValues) {
    route.writeUInt32LE(refId, cursor);
    cursor += 4;
  }

  const refsBuffer = Buffer.allocUnsafe(8 + refs.length * 6);
  REFS_MAGIC.copy(refsBuffer, 0);
  refsBuffer.writeUInt16LE(1, 4);
  refsBuffer.writeUInt16LE(6, 6);
  cursor = 8;
  for (const ref of refs) {
    refsBuffer.writeUInt32LE(ref.gameIndex, cursor);
    cursor += 4;
    refsBuffer.writeUInt16LE(ref.componentIndex, cursor);
    cursor += 2;
  }
  return { refsBuffer, refsCount: refs.length, route, routedKeys: keys.length };
}

export function mediaProfileFor(platform, source) {
  if (source === "opengood") return "opengood-cartridge-v1";
  if (source === "redump") {
    return KNOWN_PLATFORM_PROFILES[platform] ?? REDUMP_DEFAULT_MEDIA_PROFILE;
  }
  return KNOWN_PLATFORM_PROFILES[platform] ?? DEFAULT_MEDIA_PROFILE;
}

// Assemble one RWFP2 pack for a single Redump platform. Same outer container
// layout as RWFP1 with magic RWFP2, members in this exact directory order.
export function buildSystemPackV2(platform, games, provenance) {
  const sharedComponents = markSharedComponents(games);
  const gamesBytes = gamesJsonBytes(games);
  const { refsBuffer, refsCount, route, routedKeys } = buildRouteAndRefs(games);
  const componentCount = games.reduce((sum, game) => sum + game.components.length, 0);
  const manifest = {
    format: INDEX_FORMAT_V2,
    platform,
    source: "redump",
    canonicalizationProfile: mediaProfileFor(platform, "redump"),
    canonicalizationVersion: 1,
    provenance,
    counts: {
      games: games.length,
      components: componentCount,
      routedKeys,
      refs: refsCount,
      sharedComponents,
    },
  };
  const pack = writePack(
    [
      { name: "games.json", bytes: gamesBytes },
      { name: "route.bin", bytes: route },
      { name: "refs.bin", bytes: refsBuffer },
      { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest), "utf8") },
    ],
    PACK_MAGIC_V2,
  );
  return { componentCount, pack, routedKeys, sharedComponents };
}

async function writeSystemPackV2(platform, gamesInfo, options, provenance) {
  console.error(`[identify] ${platform}: building RWFP2 pack`);
  const games = await loadSortedGames(gamesInfo.gamesPath);
  const { componentCount, pack, routedKeys, sharedComponents } = buildSystemPackV2(
    platform,
    games,
    provenance,
  );
  const fileName = `${gamesInfo.slug}.pack`;
  const outPath = path.join(options.outPath, fileName);
  await writeFile(outPath, pack);

  const system = {
    platform,
    slug: gamesInfo.slug,
    source: "redump",
    packFormat: "RWFP2",
    file: fileName,
    rawBytes: pack.length,
    sha256: crypto.createHash("sha256").update(pack).digest("hex"),
    entries: {
      games: games.length,
      components: componentCount,
      routedKeys,
      sharedComponents,
    },
  };
  if (options.brotli) {
    const compressed = await brotliCompress(pack, options.brotliQuality);
    await writeFile(`${outPath}.br`, compressed);
    system.brotliFile = `${fileName}.br`;
    system.brotliBytes = compressed.length;
  }
  console.error(
    `[identify] ${platform}: wrote ${fileName} (${formatBytes(pack.length)}` +
      `${system.brotliBytes ? `, br ${formatBytes(system.brotliBytes)}` : ""}` +
      `, ${games.length.toLocaleString("en-US")} game(s), ${routedKeys.toLocaleString("en-US")} routed key(s))`,
  );
  return system;
}

// Build the catalog.json platform entries and enforce the alias rules: a
// platform's own normalized name always claims its alias (a curated alias that
// collides with another platform's own name is dropped); any remaining
// duplicate alias, and any duplicate packSlug, is a build error.
export function buildCatalogPlatforms(systems) {
  const ownNames = new Map();
  const slugOwners = new Map();
  for (const system of systems) {
    const slugOwner = slugOwners.get(system.slug);
    if (slugOwner !== undefined && slugOwner !== system.platform) {
      throw new Error(
        `Duplicate packSlug "${system.slug}" between "${slugOwner}" and "${system.platform}"`,
      );
    }
    slugOwners.set(system.slug, system.platform);
    const own = normalizeAlias(system.platform);
    const existingOwn = ownNames.get(own);
    if (existingOwn !== undefined && existingOwn !== system.platform) {
      throw new Error(
        `Duplicate platform alias "${own}" between "${existingOwn}" and "${system.platform}"`,
      );
    }
    ownNames.set(own, system.platform);
  }

  const aliasOwners = new Map(ownNames);
  const platforms = systems.map((system) => {
    const aliases = new Set([normalizeAlias(system.platform)]);
    for (const alias of CURATED_ALIASES[system.platform] ?? []) {
      const normalized = normalizeAlias(alias);
      const ownOwner = ownNames.get(normalized);
      // Another platform's own name wins over this curated alias.
      if (ownOwner !== undefined && ownOwner !== system.platform) continue;
      const owner = aliasOwners.get(normalized);
      if (owner !== undefined && owner !== system.platform) {
        throw new Error(
          `Duplicate platform alias "${normalized}" between "${owner}" and "${system.platform}"`,
        );
      }
      aliasOwners.set(normalized, system.platform);
      aliases.add(normalized);
    }
    const entry = {
      canonicalPlatform: system.platform,
      aliases: [...aliases].sort(),
      source: system.source,
      mediaProfiles: [mediaProfileFor(system.platform, system.source)],
      packSlug: system.slug,
      packFormat: system.packFormat ?? "RWFP1",
      canonicalizationVersion: 1,
    };
    if (system.sha256) entry.packSha256 = system.sha256;
    return entry;
  });
  return platforms;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.printPlatforms) {
    for (const platform of Object.keys(OPENGOOD_PLATFORMS).sort())
      console.log(`opengood\t${platform}`);
    for (const [platform, slug] of Object.entries(REDUMP_PLATFORMS).sort())
      console.log(`redump\t${platform}\t${REDUMP_DAT_BASE}${slug}/`);
    return;
  }

  requireExecutable("curl");
  const selection = resolveSelection(options);
  const openGoodSelected = [...selection.openGoodSelected].sort();
  let redumpSelected = [];

  // Pre-download (cache) every OpenGood DAT the selected platforms need.
  const neededDats = new Set();
  for (const platform of openGoodSelected) {
    for (const datFile of OPENGOOD_PLATFORMS[platform]) neededDats.add(datFile);
  }
  const openGoodPaths = new Map();
  for (const datFile of neededDats) {
    openGoodPaths.set(datFile, await downloadOpenGoodDat(datFile, options.cacheDir));
  }

  const redumpPaths = new Map();
  const redumpSources = new Map();
  if (selection.redumpAll || selection.redumpRequested.length > 0) {
    requireExecutable("unzip");
    redumpSelected = discoverRedumpPlatforms(selection, options);
    for (const platform of redumpSelected) {
      const datPath = await downloadRedumpDat(platform, options.cacheDir, options.refreshDump);
      redumpPaths.set(platform, datPath);
      const info = await stat(datPath);
      redumpSources.set(platform, {
        fileName: path.basename(datPath),
        sha256: await sha256File(datPath),
        sizeBytes: info.size,
        url: `${REDUMP_DAT_BASE}${REDUMP_PLATFORMS[platform]}/`,
      });
    }
    if (options.downloadOnly) {
      console.log(
        JSON.stringify(
          { openGood: [...neededDats], redump: Object.fromEntries(redumpSources) },
          null,
          2,
        ),
      );
      return;
    }
  } else if (options.downloadOnly) {
    console.log(JSON.stringify({ openGood: [...neededDats] }, null, 2));
    return;
  }

  if (openGoodSelected.length + redumpSelected.length === 0) {
    throw new Error("No platforms selected to build");
  }

  const ctx = {
    cacheDir: options.cacheDir,
    forceRowCache: options.forceRowCache,
    generatedAt: new Date().toISOString(),
    maxObjects: options.maxObjects,
    openGoodPaths,
    redumpPaths,
  };

  await mkdir(options.outPath, { recursive: true });
  const systems = [];
  for (const platform of openGoodSelected) {
    const rows = await buildPlatformRows(platform, ctx);
    systems.push({ ...(await writeSystemPack(platform, rows, options)), packFormat: "RWFP1" });
  }
  for (const platform of redumpSelected) {
    const games = await buildPlatformGames(platform, ctx);
    systems.push(
      await writeSystemPackV2(platform, games, options, {
        dat: redumpSources.get(platform),
        url: "http://redump.org/",
      }),
    );
  }

  // catalog.json always lists every OpenGood platform (with aliases) plus each
  // built Redump platform, so a reader can resolve any known alias even when
  // only a subset of packs was built.
  const builtBySlug = new Map(systems.map((system) => [system.slug, system]));
  const catalogSystems = [];
  for (const platform of Object.keys(OPENGOOD_PLATFORMS).sort()) {
    const slug = slugifyPlatform(platform);
    const built = builtBySlug.get(slug);
    catalogSystems.push(built ?? { platform, slug, source: "opengood", packFormat: "RWFP1" });
  }
  for (const system of systems) {
    if (system.source === "redump") catalogSystems.push(system);
  }
  const catalog = {
    format: CATALOG_FORMAT,
    generated: {
      opengoodRevision: OPENGOOD_REVISION,
      ...(redumpSources.size > 0
        ? { redumpDats: Object.fromEntries([...redumpSources].sort()) }
        : {}),
    },
    platforms: buildCatalogPlatforms(catalogSystems),
  };
  await writeFile(
    path.join(options.outPath, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );

  const index = {
    format: INDEX_FORMAT,
    hashStrategy: "crc-primary-md5-sha1-fallback-per-system",
    catalog: "catalog.json",
    sources: {
      opengood: {
        url: OPENGOOD_REPOSITORY,
        license: "CC0-1.0",
        revision: OPENGOOD_REVISION,
      },
      redump: {
        url: "http://redump.org/",
        note: "Redump permits redistribution of its DAT files and derived metadata.",
      },
    },
    systems,
  };
  await writeFile(path.join(options.outPath, "index.json"), `${JSON.stringify(index, null, 2)}\n`);

  const totals = systems.reduce(
    (acc, system) => {
      acc.raw += system.rawBytes;
      acc.brotli += system.brotliBytes || 0;
      acc.crcKeys += system.entries.crcKeys ?? system.entries.routedKeys ?? 0;
      return acc;
    },
    { brotli: 0, crcKeys: 0, raw: 0 },
  );
  console.log(
    JSON.stringify(
      {
        outDir: options.outPath,
        systemCount: systems.length,
        totalCrcKeys: totals.crcKeys,
        totalRawBytes: totals.raw,
        totalRawHuman: formatBytes(totals.raw),
        totalBrotliBytes: totals.brotli,
        totalBrotliHuman: formatBytes(totals.brotli),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`error: ${error.stack || error.message || error}`);
    process.exit(1);
  });
}
