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

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  build,
  copyDeclarationSources,
  emitDeclarations,
  rewriteDeclarationExtensions,
  rewriteNewUrlAssetRefs,
} from "./build-shared.mjs";

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
//
// Each pattern is anchored to the end of the specifier so a future
// `./rom-weaver-app.wasm.br` reference can never be rewritten to the `.wasm`
// path (`\.wasm$` does not match `...wasm.br`), and a worker basename is matched
// exactly rather than as a substring.
const ASSET_TARGETS = [
  { re: /(?:^|\/)browser-opfs-proxy-worker\.(?:ts|js)$/, rel: "workers/browser-opfs-proxy-worker.js" },
  { re: /(?:^|\/)browser-wasi-thread-worker\.(?:ts|js)$/, rel: "workers/browser-wasi-thread-worker.js" },
  { re: /(?:^|\/)browser-runner-worker\.(?:ts|js)$/, rel: "workers/browser-runner-worker.js" },
  { re: /(?:^|\/)rom-weaver-app\.wasm$/, rel: "rom-weaver-app.wasm" },
];

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
  // `prepare` runs on every install, including the webapp Dockerfile's
  // manifest-only layer where only package.json/lock are copied and src/ does
  // not exist yet (npm runs a workspace `prepare` even under --ignore-scripts).
  // No src means nothing to bundle; the later webapp `prebuild` rebuilds once
  // the full tree is copied. Bail cleanly so the install never breaks.
  if (!existsSync(srcDir)) {
    log("src/ is not present (manifest-only install); skipping bundle");
    return;
  }

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

  const rewritten = rewriteNewUrlAssetRefs(distDir, ASSET_TARGETS);
  log(`rewrote import.meta.url asset refs in ${rewritten} files`);

  log("emitting type declarations");
  emitDeclarations(packageRoot, "tsconfig.build.json");
  const copiedDecls = copyDeclarationSources(srcDir, distDir);
  const rewrittenDecls = rewriteDeclarationExtensions(distDir);
  log(`copied ${copiedDecls} declaration sources; normalized specifiers in ${rewrittenDecls} declarations`);

  // The wasm binary and its attribution set come from `mise run build-wasm`
  // (CI stages them into src/). A dev bundle without them is fine, but a
  // published tarball must never ship without the binary or the third-party
  // attribution that redistributing it requires (AGPL) - and a burned npm
  // version can never be re-cut, so hard-fail under prepack. The webapp's
  // prepack chains this script with npm_lifecycle_event inherited, so also
  // require that the package being packed is this one.
  const isPrepack =
    process.env.npm_lifecycle_event === "prepack" && process.env.npm_package_name === "@rom-weaver/wasm";
  const missingAsset = (message) => {
    if (isPrepack) {
      throw new Error(`${message}; refusing to pack an incomplete package`);
    }
    log(`WARNING: ${message}`);
  };

  for (const asset of ["rom-weaver-app.wasm", "rom-weaver-app.wasm.br"]) {
    const from = path.join(srcDir, asset);
    if (!existsSync(from)) {
      missingAsset(`missing wasm asset ${asset} (build the wasm binary with \`mise run build-wasm\`)`);
      continue;
    }
    cpSync(from, path.join(distDir, asset));
    log(`copied ${asset} (${(statSync(from).size / (1024 * 1024)).toFixed(1)} MiB)`);
  }

  for (const attribution of ["NOTICE", "THIRD_PARTY_LICENSES.md", "third_party"]) {
    const from = path.join(srcDir, attribution);
    if (!existsSync(from)) {
      missingAsset(`missing attribution ${attribution} (produced by \`mise run build-wasm\`)`);
      continue;
    }
    cpSync(from, path.join(distDir, attribution), { recursive: true });
    log(`copied ${attribution}`);
  }

  log(`done -> ${path.relative(packageRoot, distDir)}`);
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
