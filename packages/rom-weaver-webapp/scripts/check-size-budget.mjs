#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(PACKAGE_ROOT, "performance-budgets.json");
const DIST_DIR = path.join(PACKAGE_ROOT, "dist");

const listFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });

// The worker runtime chunk guard. `rom-weaver-share-worker-runtime-chunks` (vite.config.mjs) emits
// each `?worker&url` entry into the main rollup graph so the `wasm-runtime` advancedChunks group can
// hoist the modules only worker entries reach into one chunk both workers import. The grouping leans
// on two rolldown behaviours that a Vite/rolldown upgrade can silently change: `ctx.getModuleInfo`
// being usable inside a group `name` function, and `includeDependenciesRecursively` staying off. If
// either breaks, the build still succeeds and only the size budget drifts - so assert the chunk graph
// itself. See the "Workers share one runtime chunk" bullet in docs/development/ARCHITECTURE.md.
const RUNTIME_CHUNK_PATTERN = /^wasm-runtime-[\w-]+\.js$/;
const WORKER_ENTRY_CHUNK_PATTERNS = [/^browser-runner-worker-[\w-]+\.js$/, /^browser-wasi-thread-worker-[\w-]+\.js$/];
const FORBIDDEN_RUNTIME_SOURCE_PATTERN = /(?:^|\/)node_modules\/(react-dom|react|scheduler)(?:\/|$)/;
const PREACT_RUNTIME_SOURCE_PATTERN = /(?:^|\/)node_modules\/preact(?:\/|$)/;
// Static ESM imports only, at a statement boundary. `import("./x.js")` (dynamic) and the plain
// strings inside Vite's `__vite__mapDeps` array must not match - neither costs a first-paint fetch.
const STATIC_IMPORT_PATTERN = /(?:^|[;}\n])import\s*(?:[\w$*{},\s]+?\s*from\s*)?"([^"]+)"/g;
const GUARD_REFERENCE =
  'the "Workers share one runtime chunk" bullet in docs/development/ARCHITECTURE.md, and the ' +
  "`rom-weaver-share-worker-runtime-chunks` plugin plus the `wasm-runtime` advancedChunks group in " +
  "packages/rom-weaver-webapp/vite.config.mjs";

const staticImportsOf = (assetsDir, fileName) => {
  const code = fs.readFileSync(path.join(assetsDir, fileName), "utf8");
  const imported = new Set();
  for (const match of code.matchAll(STATIC_IMPORT_PATTERN)) {
    if (match[1].startsWith("./")) imported.add(match[1].slice(2));
  }
  return imported;
};

/** Every chunk the document pulls in before paint: its entry script, its modulepreloads, and their
 * static import closure. Dynamic route imports are deliberately excluded - they are not first paint. */
const documentChunkClosure = (distDir, assetsDir, chunkNames) => {
  const html = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
  const roots = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g)].map((match) => match[1]);
  if (roots.length === 0) throw new Error("worker runtime chunk guard: index.html referenced no JavaScript assets");
  const reached = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (reached.has(fileName) || !chunkNames.has(fileName)) continue;
    reached.add(fileName);
    pending.push(...staticImportsOf(assetsDir, fileName));
  }
  return reached;
};

export function checkWorkerRuntimeChunk(distDir = DIST_DIR) {
  const assetsDir = path.join(distDir, "assets");
  const chunkNames = new Set(fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js")));
  const runtimeChunks = [...chunkNames].filter((name) => RUNTIME_CHUNK_PATTERN.test(name));
  const problems = [];

  if (runtimeChunks.length !== 1) {
    problems.push(
      `expected exactly one wasm-runtime chunk in ${assetsDir}, found ${runtimeChunks.length}` +
        `${runtimeChunks.length > 0 ? ` (${runtimeChunks.join(", ")})` : ""}. The shared worker runtime ` +
        "chunk is gone, so each worker has most likely inlined its own copy again - roughly 100 KiB raw " +
        "of duplication. Check that the `?worker&url` interception still runs and that the " +
        "`wasm-runtime` group still matches worker-only modules.",
    );
    return { failures: problems.length, problems };
  }

  const [runtimeChunk] = runtimeChunks;
  for (const pattern of WORKER_ENTRY_CHUNK_PATTERNS) {
    const workerChunks = [...chunkNames].filter((name) => pattern.test(name));
    if (workerChunks.length === 0) {
      problems.push(`no worker entry chunk matched ${pattern} in ${assetsDir}`);
      continue;
    }
    for (const workerChunk of workerChunks) {
      if (!staticImportsOf(assetsDir, workerChunk).has(runtimeChunk)) {
        problems.push(
          `${workerChunk} does not import ${runtimeChunk}. The worker no longer shares the hoisted ` +
            "runtime, so it is carrying a private copy of the wasm/OPFS layer.",
        );
      }
    }
  }

  const documentChunks = documentChunkClosure(distDir, assetsDir, chunkNames);
  if (documentChunks.has(runtimeChunk)) {
    const importers = [...documentChunks]
      .filter((name) => name !== runtimeChunk && staticImportsOf(assetsDir, name).has(runtimeChunk))
      .sort();
    problems.push(
      `${runtimeChunk} is on the first-paint critical path; ${
        importers.length > 0 ? `imported by ${importers.join(", ")}` : "reached from index.html directly"
      }. The worker-only runtime must stay off the document's static import closure. The usual cause is ` +
        "the `wasm-runtime` group capturing modules the document entry also uses: either " +
        "`ctx.getModuleInfo` stopped returning importers inside the group `name` function (so every " +
        "module looks worker-only), or `includeDependenciesRecursively` flipped back on (so the group " +
        "swallows its members' app-facing dependencies).",
    );
  }

  return { failures: problems.length, problems };
}

export function checkReactRuntimeExclusion(distDir = DIST_DIR) {
  // Every emitted `.js.map` under dist, not just `dist/assets`: the service worker and any future
  // root-level or nested entry ship to visitors too, and a React import that lands in one of those is
  // exactly as expensive as one in an app chunk.
  const sourceMaps = listFiles(distDir).filter((file) => file.endsWith(".js.map"));
  if (sourceMaps.length === 0)
    return { failures: 1, problems: [`expected JavaScript source maps in ${distDir}, found none`] };
  const bundledPackages = new Map();
  let sawPreact = false;
  for (const sourceMapPath of sourceMaps) {
    const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, "utf8"));
    const label = path.relative(distDir, sourceMapPath);
    for (const source of sourceMap.sources || []) {
      const normalized = String(source).replaceAll("\\", "/");
      if (PREACT_RUNTIME_SOURCE_PATTERN.test(normalized)) sawPreact = true;
      const packageName = normalized.match(FORBIDDEN_RUNTIME_SOURCE_PATTERN)?.[1];
      if (!packageName) continue;
      const labels = bundledPackages.get(packageName) ?? new Set();
      labels.add(label);
      bundledPackages.set(packageName, labels);
    }
  }
  const problems = [...bundledPackages].map(
    ([packageName, labels]) =>
      `${packageName} was bundled into ${[...labels].sort().join(", ")}; production must use only Preact compat`,
  );
  // A build that ships neither runtime would otherwise report a clean pass: an alias typo that
  // resolves react to an empty shim drops React from the bundle without giving Preact its place.
  if (!sawPreact) problems.push(`no preact module was bundled into ${distDir}; the runtime alias resolved to neither`);
  return { failures: problems.length, problems };
}

export function measureSizeBudget(distDir, budget, brotliQuality) {
  const files = budget.path
    ? [path.join(distDir, budget.path)]
    : listFiles(path.join(distDir, budget.directory || "")).filter((file) => file.endsWith(budget.extension));
  if (files.length === 0 || files.some((file) => !fs.statSync(file).isFile())) {
    throw new Error(`${budget.name} matched no built files`);
  }
  if (
    budget.requireBrotliMinBytes &&
    files.some((file) => fs.statSync(file).size >= budget.requireBrotliMinBytes && !fs.existsSync(`${file}.br`))
  ) {
    throw new Error(`${budget.name} is missing a Brotli sidecar`);
  }
  const buffers = files.map((file) => fs.readFileSync(file));
  const brotliOptions = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality } };
  return {
    brotliBytes: files.reduce(
      (total, file, index) =>
        total +
        (fs.existsSync(`${file}.br`)
          ? fs.statSync(`${file}.br`).size
          : zlib.brotliCompressSync(buffers[index], brotliOptions).length),
      0,
    ),
    fileCount: files.length,
    rawBytes: buffers.reduce((total, buffer) => total + buffer.length, 0),
  };
}

export function evaluateSizeBudget(budget, measured) {
  if (measured.rawBytes > budget.maxRawBytes || measured.brotliBytes > budget.maxBrotliBytes) return "error";
  if (measured.rawBytes > budget.expectedRawBytes || measured.brotliBytes > budget.expectedBrotliBytes)
    return "warning";
  return "pass";
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const difference = (actual, expected) => `${actual >= expected ? "+" : ""}${kib(actual - expected)}`;

export function runSizeBudget(config, distDir = DIST_DIR) {
  const rows = [];
  let failures = 0;
  for (const budget of config.assetSizes.budgets) {
    const measured = measureSizeBudget(distDir, budget, config.assetSizes.brotliQuality);
    const severity = evaluateSizeBudget(budget, measured);
    const detail =
      `raw ${kib(measured.rawBytes)} (${difference(measured.rawBytes, budget.expectedRawBytes)}), ` +
      `brotli ${kib(measured.brotliBytes)} (${difference(measured.brotliBytes, budget.expectedBrotliBytes)})`;
    rows.push({ ...measured, budget, detail, severity });
    process.stdout.write(`${severity.toUpperCase().padEnd(7)} ${budget.name}: ${detail}\n`);
    if (severity === "warning")
      process.stdout.write(`::warning title=Asset size budget::${budget.name} exceeded its expected size; ${detail}\n`);
    if (severity === "error") {
      failures += 1;
      process.stdout.write(`::error title=Asset size budget::${budget.name} exceeded its maximum size; ${detail}\n`);
    }
  }
  return { failures, rows };
}

const summary = (rows) =>
  [
    "### Asset size budgets",
    "",
    "| Asset | Files | Raw | Brotli | Result |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows.map(
      ({ brotliBytes, budget, fileCount, rawBytes, severity }) =>
        `| ${budget.name} | ${fileCount} | ${kib(rawBytes)} | ${kib(brotliBytes)} | ${severity} |`,
    ),
    "",
  ].join("\n");

export function reportWorkerRuntimeChunk(distDir = DIST_DIR) {
  const { failures, problems } = checkWorkerRuntimeChunk(distDir);
  if (failures === 0) {
    process.stdout.write("PASS    Worker runtime chunk: workers share one hoisted chunk, off the first-paint path\n");
    return 0;
  }
  for (const problem of problems) {
    process.stdout.write(`ERROR   Worker runtime chunk: ${problem}\n`);
    process.stdout.write(`::error title=Worker runtime chunk::${problem} See ${GUARD_REFERENCE}.\n`);
  }
  process.stdout.write(`        See ${GUARD_REFERENCE}.\n`);
  return failures;
}

export function reportReactRuntimeExclusion(distDir = DIST_DIR) {
  const { failures, problems } = checkReactRuntimeExclusion(distDir);
  if (failures === 0) {
    process.stdout.write("PASS    Preact runtime: no React, React DOM, or Scheduler modules bundled\n");
    return 0;
  }
  for (const problem of problems) {
    process.stdout.write(`ERROR   Preact runtime: ${problem}\n`);
    process.stdout.write(`::error title=Preact runtime::${problem}. Check scripts/preact-aliases.mjs.\n`);
  }
  return failures;
}

export function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const result = runSizeBudget(config);
  const chunkFailures = reportWorkerRuntimeChunk();
  const runtimeFailures = reportReactRuntimeExclusion();
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result.rows));
  return result.failures + chunkFailures + runtimeFailures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
