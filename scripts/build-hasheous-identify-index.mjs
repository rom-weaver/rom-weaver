#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import zlib from "node:zlib";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const MAIN_DUMP_URL = "https://hasheous.org/api/v1/Dumps/MetadataMap.zip";
const MAIN_DUMP_FILE_NAME = "MetadataMap.zip";
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), "rom-weaver-hasheous-main-dump");
const DEFAULT_OUT = path.join(ROOT_DIR, "target/hasheous/hasheous-identify.pack");

const PACK_MAGIC = Buffer.from("RWFP1\0\0\0", "binary");
const HASH_MAGIC = Buffer.from("RWH1", "binary");
const PAIR_MAGIC = Buffer.from("RWHP", "binary");
const CONFLICT_VALUE_FLAG = 0x80000000;
const ROW_CACHE_FORMAT = "rom-weaver-hasheous-identify-rows-v1";
const INDEX_FORMAT = "rom-weaver-hasheous-identify-pack-v1";

const SUPPORTED_PLATFORMS = Object.freeze([
  "Atari 2600",
  "Atari 5200",
  "Atari 7800",
  "Atari Lynx",
  "Family Computer Disk System",
  "Megadrive 32X",
  "NEC PC-Engine CD & TurboGrafx-16 CD",
  "Neo Geo Pocket",
  "Neo Geo Pocket Color",
  "Nintendo 3DS",
  "Nintendo 64",
  "Nintendo DS",
  "Nintendo DSi",
  "Nintendo Entertainment System",
  "Nintendo Famicom Disk System",
  "Nintendo Game Boy",
  "Nintendo Game Boy Advance",
  "Nintendo Game Boy Color",
  "Nintendo GameCube",
  "Nintendo New 3DS",
  "Nintendo Super Nintendo Entertainment System",
  "Nintendo Wii",
  "Playstation minis",
  "Sega 32X",
  "Sega Dreamcast",
  "Sega Game Gear",
  "Sega Master System",
  "Sega Mega CD _ Sega CD",
  "Sega Mega Drive _ Genesis",
  "Sega Saturn",
  "Sony PlayStation",
  "Sony PlayStation 2",
  "Sony Playstation Portable",
  "TurboGrafx-16_PC Engine",
]);

const ALGORITHMS = Object.freeze({
  crc32: { code: 0, hashBytes: 4 },
  md5: { code: 1, hashBytes: 16 },
  sha1: { code: 2, hashBytes: 20 },
});

const usage = () => `Usage:
  node scripts/build-hasheous-identify-index.mjs
  node scripts/build-hasheous-identify-index.mjs --dump /path/to/MetadataMap.zip

Options:
  --cache-dir <path>       Download and row-cache directory. Defaults to ${DEFAULT_CACHE_DIR}
  --dump <path>            Use an existing MetadataMap.zip instead of downloading.
  --out <path>             Output pack path. Defaults to ${DEFAULT_OUT}
  --refresh-dump           Revalidate/redownload the cached dump instead of trusting it.
  --force-row-cache        Rebuild the normalized row cache even if it matches.
  --download-only          Download/resolve the main dump, then stop.
  --no-brotli              Do not emit <out>.br.
  --brotli-quality <n>     Brotli quality 0-11 for <out>.br. Defaults to 11.
  --max-objects <n>        Parse only the first n game objects for smoke tests.
  --allow-missing-platforms
                          Skip supported platforms missing from a fixture/dump.
  --print-platforms        Print the hard-coded supported platform list.
  --help                   Show this help.
`;

function parseArgs(argv) {
  const options = {
    allowMissingPlatforms: false,
    brotli: true,
    brotliQuality: 11,
    cacheDir: process.env.ROM_WEAVER_HASHEOUS_CACHE_DIR || DEFAULT_CACHE_DIR,
    downloadOnly: false,
    dumpPath: undefined,
    forceRowCache: false,
    maxObjects: undefined,
    outPath: DEFAULT_OUT,
    printPlatforms: false,
    refreshDump: false,
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
    else if (arg === "--dump") options.dumpPath = readValue();
    else if (arg === "--out") options.outPath = readValue();
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

  if (
    !Number.isInteger(options.brotliQuality) ||
    options.brotliQuality < 0 ||
    options.brotliQuality > 11
  ) {
    throw new Error("--brotli-quality must be an integer from 0 through 11");
  }
  if (options.maxObjects !== undefined && (!Number.isInteger(options.maxObjects) || options.maxObjects < 1)) {
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

async function getMainDumpMetadata() {
  const response = await fetch(`${MAIN_DUMP_URL}?x=${encodeURIComponent(crypto.randomUUID())}`, {
    method: "HEAD",
  });
  if (!response.ok) throw new Error(`HEAD ${MAIN_DUMP_URL} failed with HTTP ${response.status}`);
  const contentLengthRaw = response.headers.get("content-length");
  const contentLength = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : undefined;
  return {
    contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
    etag: response.headers.get("etag") || undefined,
    lastModified: response.headers.get("last-modified") || undefined,
    url: MAIN_DUMP_URL,
  };
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

async function resolveDumpPath(options) {
  if (options.dumpPath) {
    const absolute = path.resolve(options.dumpPath);
    const existing = await fileStat(absolute);
    if (!existing?.isFile()) throw new Error(`Dump file does not exist: ${absolute}`);
    return {
      dumpPath: absolute,
      source: {
        fileName: path.basename(absolute),
        localPath: absolute,
        sizeBytes: existing.size,
      },
    };
  }

  await mkdir(options.cacheDir, { recursive: true });
  const dumpPath = path.join(options.cacheDir, MAIN_DUMP_FILE_NAME);
  const existing = await fileStat(dumpPath);
  if (existing?.isFile() && !options.refreshDump) {
    console.error(`[hasheous] using cached main dump: ${dumpPath} (${formatBytes(existing.size)})`);
    return {
      dumpPath,
      source: {
        cached: true,
        fileName: MAIN_DUMP_FILE_NAME,
        localPath: dumpPath,
        sizeBytes: existing.size,
      },
    };
  }

  const metadata = await getMainDumpMetadata();
  if (existing?.isFile() && metadata.contentLength && existing.size === metadata.contentLength) {
    console.error(`[hasheous] cached main dump is current: ${dumpPath} (${formatBytes(existing.size)})`);
    return {
      dumpPath,
      source: {
        ...metadata,
        cached: true,
        fileName: MAIN_DUMP_FILE_NAME,
        localPath: dumpPath,
        sizeBytes: existing.size,
      },
    };
  }

  const tempPath = `${dumpPath}.part`;
  const downloadUrl = `${MAIN_DUMP_URL}?x=${encodeURIComponent(crypto.randomUUID())}`;
  console.error(
    `[hasheous] downloading main dump (${metadata.contentLength ? formatBytes(metadata.contentLength) : "unknown size"})`,
  );
  await runCurl(downloadUrl, tempPath, metadata.contentLength);

  const downloaded = await fileStat(tempPath);
  if (!downloaded?.isFile()) throw new Error(`Download did not create ${tempPath}`);
  if (metadata.contentLength && downloaded.size !== metadata.contentLength) {
    throw new Error(
      `Main dump size mismatch; expected ${metadata.contentLength}, got ${downloaded.size}. Remove ${tempPath} and retry.`,
    );
  }
  await rename(tempPath, dumpPath);
  return {
    dumpPath,
    source: {
      ...metadata,
      cached: false,
      fileName: MAIN_DUMP_FILE_NAME,
      localPath: dumpPath,
      sizeBytes: downloaded.size,
    },
  };
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
  if (exitCode !== 0) throw new Error(`${command} failed with exit code ${exitCode}: ${stderr.trim()}`);
  return stdout;
}

async function collectZipPlatforms(dumpPath) {
  const stdout = await runCommandText("zipinfo", ["-1", dumpPath]);
  const platforms = new Set();
  for (const entry of stdout.trimEnd().split("\n")) {
    const slash = entry.indexOf("/");
    if (slash > 0) platforms.add(entry.slice(0, slash));
  }
  return platforms;
}

function normalizeHex(value, expectedLength) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized.length !== expectedLength) return "";
  return /^[0-9a-f]+$/u.test(normalized) ? normalized : "";
}

async function parseJsonObjects(readable, onObject, shouldStop) {
  const decoder = new StringDecoder("utf8");
  let current = "";
  let depth = 0;
  let escaped = false;
  let inString = false;
  let started = false;

  const consume = async (text) => {
    for (const char of text) {
      if (shouldStop()) return;
      if (!started) {
        if (char === "{") {
          current = "{";
          depth = 1;
          started = true;
        }
        continue;
      }

      current += char;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }

      if (char === "\"") inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          await onObject(JSON.parse(current));
          current = "";
          started = false;
        }
      }
    }
  };

  for await (const chunk of readable) {
    await consume(decoder.write(chunk));
    if (shouldStop()) return;
  }
  await consume(decoder.end());
  if (!shouldStop() && (started || depth !== 0)) throw new Error("Unterminated JSON object stream from unzip");
}

function base64Utf8(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

async function processGameObject(game, platform, state) {
  state.jsonObjects += 1;
  if (state.maxObjects && state.jsonObjects > state.maxObjects) {
    state.stopParsing = true;
    return;
  }

  const gameName = String(game?.Name || "").trim();
  if (!gameName || !Array.isArray(game?.Attributes)) return;
  const romAttribute = game.Attributes.find((attribute) => attribute?.attributeName === "ROMs");
  if (!Array.isArray(romAttribute?.Value)) return;

  for (const rom of romAttribute.Value) {
    state.romRows += 1;
    const crc32 = normalizeHex(rom?.Crc, 8);
    const md5 = normalizeHex(rom?.Md5, 32);
    const sha1 = normalizeHex(rom?.Sha1, 40);
    if (!crc32 && !md5 && !sha1) {
      state.rowsMissingAllHashes += 1;
      continue;
    }
    if (!state.stream.write(`${crc32}\t${md5}\t${sha1}\t${base64Utf8(platform)}\t${base64Utf8(gameName)}\n`)) {
      await once(state.stream, "drain");
    }
    state.rowsWithAnyHash += 1;
  }

  if (state.jsonObjects % 25000 === 0) {
    console.error(
      `[hasheous] parsed ${state.jsonObjects.toLocaleString("en-US")} game object(s), ` +
        `${state.rowsWithAnyHash.toLocaleString("en-US")} hash row(s)`,
    );
  }
}

async function dumpFingerprint(dumpPath) {
  const info = await stat(dumpPath);
  return {
    fileName: path.basename(dumpPath),
    mtimeMs: Math.trunc(info.mtimeMs),
    sizeBytes: info.size,
  };
}

function rowCachePaths(cacheDir) {
  const dir = path.join(cacheDir, "identify-index");
  return {
    dir,
    manifestPath: path.join(dir, "rows.manifest.json"),
    rowsPath: path.join(dir, "rows.tsv"),
  };
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function rowCacheMatches(manifest, fingerprint, selectedPlatforms, maxObjects) {
  if (!manifest || manifest.format !== ROW_CACHE_FORMAT) return false;
  if (manifest.maxObjects !== (maxObjects ?? null)) return false;
  if (JSON.stringify(manifest.dumpFingerprint) !== JSON.stringify(fingerprint)) return false;
  if (JSON.stringify(manifest.supportedPlatforms) !== JSON.stringify(SUPPORTED_PLATFORMS)) return false;
  if (JSON.stringify(manifest.selectedPlatforms) !== JSON.stringify(selectedPlatforms)) return false;
  return true;
}

async function buildRowCache(dumpPath, selectedPlatforms, options) {
  const paths = rowCachePaths(options.cacheDir);
  const fingerprint = await dumpFingerprint(dumpPath);
  const rowsStat = await fileStat(paths.rowsPath);
  const manifest = await readJsonFile(paths.manifestPath);
  if (
    rowsStat?.isFile() &&
    !options.forceRowCache &&
    rowCacheMatches(manifest, fingerprint, selectedPlatforms, options.maxObjects)
  ) {
    console.error(`[hasheous] using cached normalized rows: ${paths.rowsPath} (${formatBytes(rowsStat.size)})`);
    return { ...paths, manifest };
  }

  await mkdir(paths.dir, { recursive: true });
  const tempRowsPath = `${paths.rowsPath}.part`;
  const stream = createWriteStream(tempRowsPath);
  const state = {
    jsonObjects: 0,
    maxObjects: options.maxObjects,
    romRows: 0,
    rowsMissingAllHashes: 0,
    rowsWithAnyHash: 0,
    stopParsing: false,
    stream,
  };

  for (const platform of selectedPlatforms) {
    if (state.stopParsing) break;
    console.error(`[hasheous] extracting selected platform: ${platform}`);
    const unzip = spawn("unzip", ["-p", dumpPath, `${platform}/*`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    unzip.stderr.setEncoding("utf8");
    unzip.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await parseJsonObjects(
      unzip.stdout,
      (game) => processGameObject(game, platform, state),
      () => state.stopParsing,
    );
    if (state.stopParsing) unzip.kill("SIGTERM");
    const exitCode = await new Promise((resolve, reject) => {
      unzip.on("error", reject);
      unzip.on("close", resolve);
    });
    if (!state.stopParsing && exitCode !== 0) {
      throw new Error(`unzip failed for platform ${platform} with exit code ${exitCode}: ${stderr.trim()}`);
    }
  }

  await new Promise((resolve, reject) => {
    stream.on("error", reject);
    stream.end(resolve);
  });
  await rename(tempRowsPath, paths.rowsPath);

  const nextManifest = {
    format: ROW_CACHE_FORMAT,
    generatedAt: new Date().toISOString(),
    dumpFingerprint: fingerprint,
    maxObjects: options.maxObjects ?? null,
    selectedPlatforms,
    stats: {
      gameObjects: state.jsonObjects,
      romRows: state.romRows,
      rowsMissingAllHashes: state.rowsMissingAllHashes,
      rowsWithAnyHash: state.rowsWithAnyHash,
    },
    supportedPlatforms: SUPPORTED_PLATFORMS,
  };
  await writeFile(paths.manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  const written = await stat(paths.rowsPath);
  console.error(`[hasheous] wrote normalized rows: ${paths.rowsPath} (${formatBytes(written.size)})`);
  return { ...paths, manifest: nextManifest };
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

async function buildIndexParts(rowsPath, selectedPlatforms) {
  const names = new IdTable();
  const platforms = new IdTable(selectedPlatforms);
  const pairs = new PairTable();
  const crc32 = new Map();

  let rows = 0;
  for await (const row of readRows(rowsPath)) {
    rows += 1;
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
      if (conflictIndex >= CONFLICT_VALUE_FLAG) throw new Error(`Too many conflicts in ${algorithm}`);
      encodedValues.set(key, CONFLICT_VALUE_FLAG + conflictIndex);
      conflictValues.push(...uniqueIds);
      conflictOffsets.push(conflictValues.length);
    } else {
      if (value >= CONFLICT_VALUE_FLAG) throw new Error(`Pair id exceeds binary format limit in ${algorithm}`);
      encodedValues.set(key, value);
    }
  }

  const recordWidth = info.hashBytes + 4;
  const headerBytes = 20;
  const buffer = Buffer.allocUnsafe(
    headerBytes + keys.length * recordWidth + conflictOffsets.length * 4 + conflictValues.length * 4,
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

function writePack(entries) {
  const headerBytes =
    PACK_MAGIC.length +
    4 +
    entries.reduce((sum, entry) => sum + 2 + 8 + Buffer.byteLength(entry.name, "utf8"), 0);
  const payloadBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  const buffer = Buffer.allocUnsafe(headerBytes + payloadBytes);
  PACK_MAGIC.copy(buffer, 0);
  let cursor = PACK_MAGIC.length;
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

async function resolveSelectedPlatforms(dumpPath, options) {
  requireExecutable("zipinfo");
  const zipPlatforms = await collectZipPlatforms(dumpPath);
  const missing = SUPPORTED_PLATFORMS.filter((platform) => !zipPlatforms.has(platform));
  if (missing.length > 0 && !options.allowMissingPlatforms) {
    throw new Error(`Supported platform(s) not found in dump: ${missing.join(", ")}`);
  }
  if (missing.length > 0) {
    console.error(`[hasheous] skipping ${missing.length} supported platform(s) missing from this dump/fixture`);
  }
  return SUPPORTED_PLATFORMS.filter((platform) => zipPlatforms.has(platform));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.printPlatforms) {
    console.log(SUPPORTED_PLATFORMS.join("\n"));
    return;
  }

  if (!options.dumpPath) requireExecutable("curl");
  requireExecutable("unzip");

  const { dumpPath, source } = await resolveDumpPath(options);
  if (options.downloadOnly) {
    console.log(JSON.stringify({ dumpPath, source, supportedPlatforms: SUPPORTED_PLATFORMS }, null, 2));
    return;
  }

  const selectedPlatforms = await resolveSelectedPlatforms(dumpPath, options);
  if (selectedPlatforms.length === 0) throw new Error("No supported platforms were found in the dump");

  const rowCache = await buildRowCache(dumpPath, selectedPlatforms, options);
  console.error("[hasheous] building crc-primary identify index");
  const parts = await buildIndexParts(rowCache.rowsPath, selectedPlatforms);
  const crc32 = writeHashMap("crc32", parts.maps.crc32);
  const md5 = writeHashMap("md5", parts.maps.md5);
  const sha1 = writeHashMap("sha1", parts.maps.sha1);
  const namePlatforms = writeNamePlatformPairs(parts.pairs);
  const names = Buffer.from(JSON.stringify(parts.names), "utf8");
  const platforms = Buffer.from(JSON.stringify(parts.platforms), "utf8");

  const manifest = {
    format: INDEX_FORMAT,
    generatedAt: new Date().toISOString(),
    hashStrategy: "crc-primary-md5-sha1-fallback-global-name-platform",
    selectedPlatforms,
    source,
    supportedPlatforms: SUPPORTED_PLATFORMS,
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
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const pack = writePack([
    { name: "crc32.bin", bytes: crc32 },
    { name: "manifest.json", bytes: manifestBytes },
    { name: "md5.bin", bytes: md5 },
    { name: "name-platforms.bin", bytes: namePlatforms },
    { name: "names.json", bytes: names },
    { name: "platforms.json", bytes: platforms },
    { name: "sha1.bin", bytes: sha1 },
  ]);

  await mkdir(path.dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, pack);
  const result = {
    counts: manifest.counts,
    outPath: options.outPath,
    rawBytes: pack.length,
    rawHuman: formatBytes(pack.length),
  };
  if (options.brotli) {
    const compressed = await brotliCompress(pack, options.brotliQuality);
    await writeFile(`${options.outPath}.br`, compressed);
    result.brotliBytes = compressed.length;
    result.brotliHuman = formatBytes(compressed.length);
    result.brotliPath = `${options.outPath}.br`;
  }
  await writeFile(`${options.outPath}.summary.json`, `${JSON.stringify({ ...manifest, result }, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`error: ${error.stack || error.message || error}`);
  process.exit(1);
});
