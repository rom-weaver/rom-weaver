#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(PACKAGE_ROOT, "dist");

// The worker runtime chunk guard. `rom-weaver-share-worker-runtime-chunks` (scripts/vite-config/worker-chunks.mjs) emits
// each `?worker&url` entry into the main rollup graph so the `wasm-runtime` codeSplitting group can
// hoist the modules only worker entries reach into one chunk both workers import. The grouping leans
// on two rolldown behaviours that a Vite/rolldown upgrade can silently change: `ctx.getModuleInfo`
// being usable inside a group `name` function, and `includeDependenciesRecursively` staying off. If
// either breaks, the build still succeeds and only the size budget drifts - so assert the chunk graph
// itself. See the "Workers share one runtime chunk" bullet in docs/development/ARCHITECTURE.md.
const RUNTIME_CHUNK_PATTERN = /^wasm-runtime-[\w-]+\.js$/;
const WORKER_ENTRY_CHUNK_PATTERNS = [/^browser-runner-worker-[\w-]+\.js$/, /^browser-wasi-thread-worker-[\w-]+\.js$/];
// Count static ESM dependencies only; dynamic imports and __vite__mapDeps strings
// do not establish a static dependency by themselves.
const STATIC_IMPORT_PATTERN = /(?:^|[;}\n])import\s*(?:[\w$*{},\s]+?\s*from\s*)?"([^"]+)"/g;
const GUARD_REFERENCE =
  'the "Workers share one runtime chunk" bullet in docs/development/ARCHITECTURE.md, and the ' +
  "`rom-weaver-share-worker-runtime-chunks` plugin plus the `wasm-runtime` codeSplitting group in " +
  "packages/rom-weaver-webapp/vite.config.mjs";

const staticImportsOf = (assetsDir, fileName) => {
  const code = fs.readFileSync(path.join(assetsDir, fileName), "utf8");
  const imported = new Set();
  for (const match of code.matchAll(STATIC_IMPORT_PATTERN)) {
    if (match[1].startsWith("./")) imported.add(match[1].slice(2));
  }
  return imported;
};

/** Follow document script/preload references and static imports; runtime fetches are outside this check. */
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
      .sort((left, right) => Number(left > right) - Number(left < right));
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

export function main() {
  return reportWorkerRuntimeChunk() === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
