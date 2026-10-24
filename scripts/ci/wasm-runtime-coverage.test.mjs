import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyChanges } from "./classify-changes.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// Mirrors `test.include` in packages/rom-weaver-webapp/vitest.wasm.browser.config.mjs.
// Benches are deliberately out: `webapp-wasm-browser` never runs them, so their
// inputs are not coverage this classifier owes anything to.
const SUITE_DIR = "packages/rom-weaver-webapp/tests/wasm";
const SUITE_ENTRY = /\.test\.mjs$/;
// Mirrors `test.include` in packages/rom-weaver-webapp/vitest.unit.config.mjs.
const UNIT_SUITE_DIR = "packages/rom-weaver-webapp/tests/unit";
const UNIT_SUITE_ENTRY = /\.test\.tsx?$/;

const PARSEABLE = /\.(?:mjs|js|ts|tsx)$/;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.mjs"];

// Static and dynamic imports, plus the `new URL(..., import.meta.url)` form the
// suite uses to reach wasm modules and the Rust fixture trees. Both are real
// edges: editing what they point at changes what the suite observes.
const REFERENCE_PATTERNS = [
  /(?:^|[\s;{(])(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
];

function references(source) {
  const found = new Set();
  for (const pattern of REFERENCE_PATTERNS) {
    for (const [, specifier] of source.matchAll(pattern)) {
      // Vite query suffixes (`?worker&url`) are not part of the path.
      const path = specifier.split("?")[0];
      // Bare specifiers are node_modules; the classifier covers those through
      // the lockfiles, not through a source path.
      if (path.startsWith(".")) found.add(path);
    }
  }
  return found;
}

function resolveReference(fromFile, specifier) {
  const base = resolve(repoRoot, dirname(fromFile), specifier);
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate)) return relative(repoRoot, candidate);
  }
  // Build artifacts (`src/wasm/rom-weaver-app.wasm`) are not committed, so an
  // unresolved path is still a real dependency and still has to be covered.
  return relative(repoRoot, base);
}

function reachableFiles(suiteDir = SUITE_DIR, suiteEntry = SUITE_ENTRY, recursive = false) {
  const entries = readdirSync(join(repoRoot, suiteDir), { recursive })
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => suiteEntry.test(name))
    .map((name) => `${suiteDir}/${name}`);
  assert.ok(entries.length > 0, `${suiteDir} has no test entry points`);

  const seen = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!PARSEABLE.test(file) || !existsSync(join(repoRoot, file))) continue;
    for (const specifier of references(readFileSync(join(repoRoot, file), "utf8"))) {
      const target = resolveReference(file, specifier);
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return [...seen].sort();
}

// The `wasm_runtime` flag is a hand-written path list gating a suite whose real
// inputs are its import graph. Without this the two drift silently: one new
// `import ... from "../lib/something.ts"` inside src/wasm/ and edits to that
// file stop selecting the suite, with nothing red to say so.
test("every file the WASM browser suite reads selects the wasm_runtime stack", () => {
  const uncovered = reachableFiles().filter(
    (path) => classifyChanges([path]).wasm_runtime !== true,
  );
  assert.deepEqual(
    uncovered,
    [],
    `these are reachable from ${SUITE_DIR} but do not select webapp-wasm-browser; ` +
      "widen the wasm_runtime block in scripts/ci/classify-changes.mjs",
  );
});

// A resolver that silently stopped following edges would make the test above
// pass by walking nothing. Pin the shapes it has to keep resolving.
test("the walk reaches sources, workers, and the Rust fixture trees", () => {
  const reachable = new Set(reachableFiles());
  for (const path of [
    "packages/rom-weaver-webapp/src/wasm/rom-weaver-command.ts",
    "packages/rom-weaver-webapp/src/wasm/workers/browser-worker-client.ts",
    "packages/rom-weaver-webapp/src/lib/runtime/op-memory-estimate.ts",
    "tests/fixtures/vcdiff/secondary-source.bin",
    "crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin",
  ]) {
    assert.ok(reachable.has(path), `${path} should be reachable from the suite`);
  }
});

// Unit tests read crate files directly to share case tables with a Rust test.
// Crate test trees otherwise select Rust alone, so a table missing from
// `SHARED_CASE_TABLE` would let one side change while the other never runs.
test("every crate file the webapp unit suite reads selects the webapp", () => {
  const reachable = reachableFiles(UNIT_SUITE_DIR, UNIT_SUITE_ENTRY, true);
  assert.ok(
    reachable.includes("crates/rom-weaver-checksum/src/platform-names.json"),
    "the walk should follow JSON imports into crates/",
  );
  const uncovered = reachable.filter(
    (path) => path.startsWith("crates/") && classifyChanges([path]).webapp !== true,
  );
  assert.deepEqual(
    uncovered,
    [],
    `these are reachable from ${UNIT_SUITE_DIR} but do not select the webapp; ` +
      "widen SHARED_CASE_TABLE in scripts/ci/classify-changes.mjs",
  );
});
