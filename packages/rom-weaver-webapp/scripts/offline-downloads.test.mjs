import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { initialPrecacheUrls } from "./offline-downloads.mjs";

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

test("initialPrecacheUrls: accepts a manifest key that Vite assigned to index.html", () => {
  const distDir = makeDist();
  write(
    distDir,
    ".vite/manifest.json",
    JSON.stringify({ "src/main.ts": { file: "assets/root.js", isEntry: true, src: "index.html" } }),
  );
  write(distDir, "index.html", "");

  assert.equal(initialPrecacheUrls(distDir).has("assets/root.js"), true);
});

test("initialPrecacheUrls: fails when Vite did not emit a root entry", () => {
  const distDir = makeDist();
  write(distDir, ".vite/manifest.json", JSON.stringify({ "src/lazy.ts": { file: "assets/lazy.js" } }));
  write(distDir, "index.html", "");

  assert.throws(() => initialPrecacheUrls(distDir), /Vite manifest has no index.html entry/u);
});
