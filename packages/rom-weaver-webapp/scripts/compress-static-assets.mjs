#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const COMPRESSIBLE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".mjs", ".svg", ".wasm"]);

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
    if (entry.name.endsWith(".br") || entry.name.endsWith(".gz")) continue;
    if (COMPRESSIBLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) compressFile(filePath);
  }
};

const directory = process.argv[2];
if (!directory) {
  process.stderr.write("usage: compress-static-assets.mjs <directory>\n");
  process.exit(2);
}
compressDirectory(directory);
