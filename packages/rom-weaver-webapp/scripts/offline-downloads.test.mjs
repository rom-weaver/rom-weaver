import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import zlib from "node:zlib";
import { initialPrecacheUrls, writeOfflineDownloads } from "./offline-downloads.mjs";

const MEBIBYTE = 1024 * 1024;
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

const temporaryDirectories = [];
const makeDist = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "offline-downloads-"));
  temporaryDirectories.push(directory);
  return directory;
};
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true });
});

const write = (distDir, relativePath, contents) => {
  const outputPath = path.join(distDir, relativePath);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
};

const bytes = (length) => Buffer.from({ length }, (_, index) => (index * 31 + Math.floor(index / 257)) % 251);

test("writeOfflineDownloads: writes gzip chunks that reconstruct the original bytes", () => {
  const distDir = makeDist();
  const original = bytes(MEBIBYTE + 91);
  write(distDir, "assets/runtime.wasm", original);

  const result = writeOfflineDownloads(distDir, [{ revision: null, url: "assets/runtime.wasm" }]);
  const entry = result.manifest["assets/runtime.wasm"];

  assert.equal(entry.revision, sha256(original));
  assert.equal(entry.sizeBytes, original.length);
  assert.equal(entry.contentType, "application/wasm");
  assert.equal(entry.chunks.length, 2);
  const restored = Buffer.concat(
    entry.chunks.map((chunk) => {
      const compressed = readFileSync(path.join(distDir, chunk.url));
      const decoded = zlib.gunzipSync(compressed);
      assert.equal(chunk.sha256, sha256(decoded));
      assert.equal(chunk.sizeBytes, decoded.length);
      assert.equal(chunk.encoding, "gzip");
      return decoded;
    }),
  );
  assert.deepEqual(restored, original);
  assert.equal(result.revision, sha256(readFileSync(path.join(distDir, result.url))));
});

test("writeOfflineDownloads: decodes a brotli-only source and omits small files", () => {
  const distDir = makeDist();
  const original = bytes(MEBIBYTE);
  write(distDir, "assets/identify-system.pack.br", zlib.brotliCompressSync(original));
  write(distDir, "assets/small.bin", bytes(MEBIBYTE - 1));

  const packUrl = "assets/identify-system.pack?sha256=known";
  const { manifest } = writeOfflineDownloads(distDir, [packUrl, "assets/small.bin"]);

  assert.equal(manifest[packUrl].revision, sha256(original));
  assert.equal(manifest[packUrl].contentType, "application/octet-stream");
  assert.equal(manifest["assets/small.bin"], undefined);
});

test("writeOfflineDownloads: sorts entries and reuses immutable chunk files", () => {
  const distDir = makeDist();
  const original = bytes(MEBIBYTE);
  write(distDir, "assets/a.bin", original);
  write(distDir, "assets/b.bin", original);

  const first = writeOfflineDownloads(distDir, ["assets/b.bin", "assets/a.bin"]);
  const second = writeOfflineDownloads(distDir, ["assets/a.bin", "assets/b.bin"]);

  assert.deepEqual(first, second);
  assert.equal(first.manifest["assets/a.bin"].chunks[0].url, first.manifest["assets/b.bin"].chunks[0].url);
});

test("writeOfflineDownloads: rejects missing and traversal URLs", () => {
  const distDir = makeDist();

  assert.throws(() => writeOfflineDownloads(distDir, ["assets/missing.bin"]), /missing from dist/u);
  assert.throws(() => writeOfflineDownloads(distDir, ["../outside.bin"]), /escapes dist/u);
});

test("initialPrecacheUrls: keeps only root-document static imports and root references", () => {
  const distDir = makeDist();
  write(
    distDir,
    ".vite/manifest.json",
    JSON.stringify({
      "index.html": {
        css: ["assets/root.css"],
        dynamicImports: ["src/lazy.ts"],
        file: "assets/root.js",
        imports: ["_shared.js"],
        isEntry: true,
        src: "index.html",
      },
      "_shared.js": { css: ["assets/shared.css"], file: "assets/shared.js", imports: ["_nested.js"] },
      "_nested.js": { file: "assets/nested.js" },
      "src/lazy.ts": { css: ["assets/lazy.css"], file: "assets/lazy.js", imports: ["_lazy-dependency.js"] },
      "_lazy-dependency.js": { file: "assets/lazy-dependency.js" },
      "src/wasm.ts": { file: "assets/runtime.wasm" },
    }),
  );
  write(
    distDir,
    "index.html",
    '<script type="module" src="./assets/html-entry.js"></script><link rel="modulepreload" href="./assets/preload.js"><link rel="stylesheet" href="./assets/html.css"><link rel="preload" as="font" href="./assets/font.woff2"><link rel="preload" as="script" href="./assets/skip.js">',
  );

  assert.deepEqual(
    initialPrecacheUrls(distDir),
    new Set([
      "404.html",
      "assets/font.woff2",
      "assets/html-entry.js",
      "assets/html.css",
      "assets/nested.js",
      "assets/preload.js",
      "assets/root.css",
      "assets/root.js",
      "assets/shared.css",
      "assets/shared.js",
      "index.html",
      "logo.svg",
      "manifest.json",
    ]),
  );
});
