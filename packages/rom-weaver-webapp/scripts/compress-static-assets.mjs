#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

// Denylist, not an allowlist: the attribution bundle ships ~435 files named
// `LICENSE-APACHE`, `COPYING`, `NOTICE` and friends, none of which carry an
// extension an allowlist could match, so they used to ship as 2.1 MB of raw
// text with no `.br` sibling at all. Listing what is already compressed is both
// shorter and self-maintaining - anything new is compressed by default, and
// `writeIfSmaller` discards the result when brotli cannot beat the source.
const PRECOMPRESSED_EXTENSIONS = new Set([
  ".avif",
  ".br",
  ".gif",
  ".gz",
  // scripts/optimize-ico.mjs stores every favicon frame as PNG, so brotli
  // recovers ~100 bytes for the cost of a second 15 KB file in the image.
  ".ico",
  ".jpeg",
  ".jpg",
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
};

// Brotli only. A `.gz` sibling set costs ~2.8 MB in the image and only ever
// serves clients without brotli, which browsers have all shipped since 2016.
// static-web-server's on-demand compression (`compression`, on by default)
// gzips for those; measured at 0.13s for the 6.5 MB wasm, which is affordable
// precisely because almost nothing takes that path. Baking brotli stays
// worthwhile for the opposite reason: quality 11 on that same wasm takes 13.7s,
// far too slow to serve on demand, and sws caches no compressed response.
const compressFile = (filePath) => {
  const source = fs.readFileSync(filePath);
  writeIfSmaller(
    `${filePath}.br`,
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
    if (PRECOMPRESSED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    compressFile(filePath);
  }
};

const directory = process.argv[2];
if (!directory) {
  process.stderr.write("usage: compress-static-assets.mjs <directory>\n");
  process.exit(2);
}
compressDirectory(directory);
