#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import zlib from "node:zlib";

// libuv sizes its pool on first use, so this MUST run before any async zlib call.
const threads = availableParallelism();
process.env.UV_THREADPOOL_SIZE ??= String(Math.min(threads, 16));

// Compress unknown extensions so extensionless license files also get sidecars.
// writeIfSmaller discards output that does not beat the source size.
const SKIP_COMPRESSION_EXTENSIONS = new Set([
  ".avif",
  ".br",
  ".gif",
  ".gz",
  // Favicon frames already use compressed PNG payloads.
  ".ico",
  ".jpeg",
  ".jpg",
  // Not precompressed - just never fetched outside devtools. Source maps are
  // the largest text in the bundle, so a q11 pass over them is the slowest part
  // of the image build for bytes nobody downloads on a normal visit.
  ".map",
  ".mp4",
  ".png",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
  ".zst",
]);

const writeIfSmaller = (filePath, compressed, source) => {
  if (compressed.byteLength < source.byteLength) fs.writeFileSync(filePath, compressed);
  else fs.rmSync(filePath, { force: true });
};

// Build Brotli sidecars once; static-web-server can compress on demand for
// clients that need another encoding. Compression runs on libuv's thread pool, so
// files compress in parallel; the bytes match the synchronous call (same input and
// parameters), only the wall time changes.
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

const compressFile = async (filePath) => {
  const source = await fs.promises.readFile(filePath);
  const outputPath = `${filePath}.br`;
  if (fs.existsSync(outputPath)) {
    try {
      if ((await brotliDecompress(await fs.promises.readFile(outputPath))).equals(source)) return;
    } catch {
      // Replace an invalid or stale sidecar below.
    }
  }
  writeIfSmaller(
    outputPath,
    await brotliCompress(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
    source,
  );
};

const collectFiles = (directory, files = []) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(filePath, files);
      continue;
    }
    if (SKIP_COMPRESSION_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    files.push(filePath);
  }
  return files;
};

const directory = process.argv[2];
if (!directory) {
  process.stderr.write("usage: compress-static-assets.mjs <directory>\n");
  process.exit(2);
}
const files = collectFiles(directory);
let next = 0;
const worker = async () => {
  while (next < files.length) await compressFile(files[next++]);
};
await Promise.all(Array.from({ length: Math.min(files.length, threads) }, worker));
