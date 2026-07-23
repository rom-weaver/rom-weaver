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

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
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

// Emit `.d.ts` declarations beside the bundled `.js` so consumers resolve real
// types from `dist` rather than the `.ts` source (which needs
// `allowImportingTsExtensions`). Runs the emit-only tsconfig through the
// workspace's TypeScript.
const emitDeclarations = () => {
  const require = createRequire(import.meta.url);
  const tscBin = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`tsc declaration emit failed with exit code ${result.status ?? "signal"}`);
  }
};

// Hand-authored/generated `.d.ts` source files (rom-weaver-types.d.ts and the
// typegen output under generated/) are declaration-only, so tsc's
// emitDeclarationOnly pass never copies them to the output. Copy them verbatim,
// preserving their relative path, so the emitted declarations that reference
// them resolve.
const copyDeclarationSources = () => {
  let copied = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".d.ts")) continue;
      const rel = path.relative(srcDir, full);
      const dest = path.join(distDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      cpSync(full, dest);
      copied += 1;
    }
  };
  walk(srcDir);
  return copied;
};

// tsc (tsgo) emits declarations that keep the source's explicit `.ts`/`.d.ts`
// import specifiers, which only resolve for a consumer that enables
// `allowImportingTsExtensions`. Normalize every relative specifier to `.js`
// (its sibling `.d.ts` resolves by the standard rule), so the published types
// work under a stock consumer config too.
const REL_SPECIFIER_RE = /(["'])(\.\.?\/[^"']*?)(?:\.d)?\.ts\1/g;

const rewriteDeclarationExtensions = (dir) => {
  let rewritten = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".d.ts")) continue;
      const original = readFileSync(full, "utf8");
      const next = original.replace(REL_SPECIFIER_RE, (_match, quote, spec) => `${quote}${spec}.js${quote}`);
      if (next !== original) {
        writeFileSync(full, next);
        rewritten += 1;
      }
    }
  };
  walk(dir);
  return rewritten;
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

  const rewritten = rewriteAssetUrls(distDir);
  log(`rewrote import.meta.url asset refs in ${rewritten} files`);

  log("emitting type declarations");
  emitDeclarations();
  const copiedDecls = copyDeclarationSources();
  const rewrittenDecls = rewriteDeclarationExtensions(distDir);
  log(`copied ${copiedDecls} declaration sources; normalized specifiers in ${rewrittenDecls} declarations`);

  // The wasm binary and its attribution set come from `mise run build-wasm`
  // (CI stages them into src/). A dev bundle without them is fine, but a
  // published tarball must never ship without the binary or the third-party
  // attribution that redistributing it requires (AGPL) - and a burned npm
  // version can never be re-cut, so hard-fail under prepack.
  const isPrepack = process.env.npm_lifecycle_event === "prepack";
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
