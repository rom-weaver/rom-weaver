#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

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
// clients that need another encoding.
const compressFile = (filePath) => {
  const source = fs.readFileSync(filePath);
  const outputPath = `${filePath}.br`;
  if (fs.existsSync(outputPath)) {
    try {
      if (zlib.brotliDecompressSync(fs.readFileSync(outputPath)).equals(source)) return;
    } catch {
      // Replace an invalid or stale sidecar below.
    }
  }
  writeIfSmaller(
    outputPath,
    zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
    source,
  );
};

const compressDirectory = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      compressDirectory(filePath);
      continue;
    }
    if (SKIP_COMPRESSION_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    compressFile(filePath);
  }
};

const directory = process.argv[2];
if (!directory) {
  process.stderr.write("usage: compress-static-assets.mjs <directory>\n");
  process.exit(2);
}
compressDirectory(directory);
