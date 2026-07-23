#!/usr/bin/env node

// Build @rom-weaver/wasm into a bundler-agnostic package.
//
// Two esbuild passes plus an asset copy:
//   1. Workers  - the three worker entrypoints are bundled self-contained
//      (splitting off, deps inlined) so `new Worker(new URL('./workers/x.js',
//      import.meta.url))` loads one standalone ES module with nothing left to
//      resolve.
//   2. Library  - every other module is emitted per-entry with code splitting,
//      keeping npm deps external, so a consumer's bundler dedupes them and the
//      granular subpath imports (`@rom-weaver/wasm/browser-format-matrix`, ...)
//      resolve to real files.
// The wasm binary and its Brotli sibling are copied beside the output; the
// runtime resolves them via `new URL('./rom-weaver-app.wasm', import.meta.url)`.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const srcDir = path.join(packageRoot, "src");
const distDir = path.join(packageRoot, "dist");

const log = (message) => console.log(`[build:wasm] ${message}`);

// The three worker entrypoints spawned by URL - bundled self-contained.
const WORKER_ENTRYPOINTS = [
  "workers/browser-runner-worker.ts",
  "workers/browser-wasi-thread-worker.ts",
  "workers/browser-opfs-proxy-worker.ts",
].map((rel) => path.join(srcDir, rel));

// npm dependencies kept external for the library pass so the consumer dedupes
// them; the worker pass inlines them because a URL-loaded worker cannot resolve
// bare specifiers at runtime.
const EXTERNAL_DEPS = ["@bjorn3/browser_wasi_shim"];

// After bundling, `new URL("./...", import.meta.url)` asset references can point
// at the wrong depth or a `.ts` extension (the code carries dead dev fallbacks
// superseded by the URLs threaded through init options). A consumer's bundler
// still statically resolves every such literal, so a stale one aborts the module
// transform and the worker fails to load. Rewrite each asset reference to the
// correct relative path to its real built sibling, per the file's own location.
const ASSET_TARGETS = [
  { re: /browser-opfs-proxy-worker\.(?:ts|js)/, rel: "workers/browser-opfs-proxy-worker.js" },
  { re: /browser-wasi-thread-worker\.(?:ts|js)/, rel: "workers/browser-wasi-thread-worker.js" },
  { re: /browser-runner-worker\.(?:ts|js)/, rel: "workers/browser-runner-worker.js" },
  { re: /rom-weaver-app\.wasm/, rel: "rom-weaver-app.wasm" },
];
const NEW_URL_RE = /new URL\(\s*(["'])((?:\.\.?\/)[^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;

const rewriteAssetUrls = (distDir) => {
  const toPosix = (p) => p.split(path.sep).join("/");
  const relFromFile = (fileDir, targetAbs) => {
    const out = toPosix(path.relative(fileDir, targetAbs));
    return out.startsWith(".") ? out : `./${out}`;
  };
  let rewritten = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      const original = readFileSync(full, "utf8");
      const fileDir = path.dirname(full);
      const next = original.replace(NEW_URL_RE, (match, quote, spec) => {
        const target = ASSET_TARGETS.find((candidate) => candidate.re.test(spec));
        if (!target) return match;
        const correct = relFromFile(fileDir, path.join(distDir, target.rel));
        return `new URL(${quote}${correct}${quote}, import.meta.url)`;
      });
      if (next !== original) {
        writeFileSync(full, next);
        rewritten += 1;
      }
    }
  };
  walk(distDir);
  return rewritten;
};

const walkTsFiles = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
      continue;
    }
    if (entry.name.endsWith(".d.ts")) continue; // type-only, no runtime emit
    if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

const sharedOptions = {
  absWorkingDir: packageRoot,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outbase: srcDir,
  outdir: distDir,
  sourcemap: true,
  logLevel: "info",
};

const run = async () => {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const workerSet = new Set(WORKER_ENTRYPOINTS);
  const libraryEntrypoints = walkTsFiles(srcDir).filter((file) => !workerSet.has(file));

  log(`worker entrypoints: ${WORKER_ENTRYPOINTS.length}`);
  await build({
    ...sharedOptions,
    entryPoints: WORKER_ENTRYPOINTS,
    splitting: false,
  });

  log(`library entrypoints: ${libraryEntrypoints.length}`);
  await build({
    ...sharedOptions,
    entryPoints: libraryEntrypoints,
    splitting: true,
    external: EXTERNAL_DEPS,
  });

  const rewritten = rewriteAssetUrls(distDir);
  log(`rewrote import.meta.url asset refs in ${rewritten} files`);

  for (const asset of ["rom-weaver-app.wasm", "rom-weaver-app.wasm.br"]) {
    const from = path.join(srcDir, asset);
    if (!existsSync(from)) {
      log(`WARNING: missing wasm asset ${asset} (build the wasm binary with \`mise run build-wasm\`)`);
      continue;
    }
    cpSync(from, path.join(distDir, asset));
    log(`copied ${asset} (${(statSync(from).size / (1024 * 1024)).toFixed(1)} MiB)`);
  }

  log(`done -> ${path.relative(packageRoot, distDir)}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
