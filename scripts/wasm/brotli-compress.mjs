#!/usr/bin/env node
// Use Node's bundled Brotli to avoid another CI dependency. Pin LGWIN to the CLI default because
// Node's smaller default produces larger artifacts.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const BROTLI_LGWIN = 24;
const BROTLI_VERSION = process.versions.brotli;

// Quality 11 on the ~7 MB wasm costs ~15s, and every webapp build stages
// sidecars now - not just deploys - so an untouched asset would pay that on
// every rebuild, every preview and every E2E run. Brotli is deterministic for a
// fixed parameter set, so the output is addressable by the input digest and
// those parameters: hashing the same 7 MB takes ~15ms.
const CACHE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  ".cache",
  "rom-weaver-brotli",
);
const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const cacheEnabled = () => process.env.ROM_WEAVER_BROTLI_CACHE !== "0";

let pruned = false;

// Hashed asset names change on every content change, so entries are abandoned
// rather than replaced and the directory would otherwise grow without bound.
const pruneCache = (now) => {
  if (pruned) return;
  pruned = true;
  let names = [];
  try {
    names = fs.readdirSync(CACHE_ROOT);
  } catch {
    return;
  }
  for (const name of names) {
    const entry = path.join(CACHE_ROOT, name);
    try {
      if (now - fs.statSync(entry).mtimeMs > CACHE_MAX_AGE_MS) fs.rmSync(entry, { force: true });
    } catch {
      // A concurrent build may have pruned or replaced it already.
    }
  }
};

const cacheEntryPath = (source, quality, parameterProfile) =>
  path.join(
    CACHE_ROOT,
    `${crypto
      .createHash("sha256")
      .update(source)
      .update(
        `\0q${quality}\0profile${parameterProfile}\0size${source.byteLength}\0brotli${BROTLI_VERSION}`,
      )
      .digest(
        "hex",
      )}-q${quality}-${parameterProfile}-size${source.byteLength}-brotli${BROTLI_VERSION}.br`,
  );

// Verified by decompressing rather than trusted on the strength of its name: a
// truncated entry, or one written by a Node whose brotli emits different bytes,
// costs one rebuild instead of shipping a sidecar that does not match its
// asset.
const readCachedBrotli = (entryPath, source) => {
  try {
    const cached = fs.readFileSync(entryPath);
    if (!zlib.brotliDecompressSync(cached).equals(source)) return null;
    // Refresh the timestamp so an asset still in use survives pruning.
    fs.utimesSync(entryPath, new Date(), new Date());
    return cached;
  } catch {
    return null;
  }
};

// Written through a unique temporary name so a parallel build never observes a
// half-written entry under the final path.
const writeCachedBrotli = (entryPath, compressed) => {
  try {
    fs.mkdirSync(CACHE_ROOT, { recursive: true });
    const temporaryPath = `${entryPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, compressed);
    fs.renameSync(temporaryPath, entryPath);
  } catch {
    // A cache miss is only ever a slow build, never a wrong one.
  }
};

export function brotliCompressFile({
  inputPath,
  outputPath,
  quality,
  parameterProfile = "large-window",
}) {
  const source = fs.readFileSync(inputPath);
  const normalizedQuality = Number(quality);
  const entryPath = cacheEnabled()
    ? cacheEntryPath(source, normalizedQuality, parameterProfile)
    : null;

  if (entryPath) {
    pruneCache(Date.now());
    const cached = readCachedBrotli(entryPath, source);
    if (cached) {
      fs.writeFileSync(outputPath, cached);
      return { cached: true, compressedSize: cached.byteLength, sourceSize: source.byteLength };
    }
  }

  const compressed = brotliCompressBuffer(source, {
    parameterProfile,
    quality: normalizedQuality,
  });
  fs.writeFileSync(outputPath, compressed);
  if (entryPath) writeCachedBrotli(entryPath, compressed);
  return { cached: false, compressedSize: compressed.byteLength, sourceSize: source.byteLength };
}

export function brotliCompressBuffer(source, { quality, parameterProfile = "large-window" }) {
  const normalizedQuality = Number(quality);
  if (parameterProfile !== "default" && parameterProfile !== "large-window") {
    throw new Error(`unknown Brotli parameter profile: ${parameterProfile}`);
  }
  const params = { [zlib.constants.BROTLI_PARAM_QUALITY]: normalizedQuality };
  if (parameterProfile === "large-window") {
    params[zlib.constants.BROTLI_PARAM_LGWIN] = BROTLI_LGWIN;
    params[zlib.constants.BROTLI_PARAM_SIZE_HINT] = source.byteLength;
  }
  return zlib.brotliCompressSync(source, {
    params,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, outputPath, quality = "11"] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    process.stderr.write("usage: brotli-compress.mjs <input> <output> [quality]\n");
    process.exit(2);
  }
  const { cached, compressedSize, sourceSize } = brotliCompressFile({
    inputPath,
    outputPath,
    quality,
  });
  process.stdout.write(
    `brotli q${quality}${cached ? " (cached)" : ""}: ${sourceSize} -> ${compressedSize} bytes (${((compressedSize / sourceSize) * 100).toFixed(1)}%)\n`,
  );
}
