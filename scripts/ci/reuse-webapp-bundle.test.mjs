import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildManifest } from "./wasm-manifest.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "reuse-webapp-bundle.mjs");
const WEBAPP = "packages/rom-weaver-webapp";

// Git hooks export GIT_DIR and similar variables. Inherited, they point git at the hook's repository.
const isolatedEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_NAME: "ci",
  GIT_AUTHOR_EMAIL: "ci@example.com",
  GIT_COMMITTER_NAME: "ci",
  GIT_COMMITTER_EMAIL: "ci@example.com",
  ...extra,
});

const write = (root, path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};

// A repository with `laterChanges` and `laterMoves` after the bundle commit. This run's
// `wasm-prod` files go in src/wasm; the bundle's commit and manifest go in build.
function restoredBundle(t, { bundleCommit, laterChanges = {}, laterMoves = {}, runWasm = "module", wasmManifest = true }) {
  const repo = mkdtempSync(join(tmpdir(), "reuse-webapp-bundle-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", env: isolatedEnv() }).trim();
  git("init", "-q");
  write(repo, "README.md", "base\n");
  write(repo, `${WEBAPP}/src/webapp/app.ts`, "export {};\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const bundled = git("rev-parse", "HEAD");
  for (const [path, body] of Object.entries(laterChanges)) write(repo, path, body);
  for (const [from, to] of Object.entries(laterMoves)) {
    mkdirSync(dirname(join(repo, to)), { recursive: true });
    git("mv", from, to);
  }
  if (Object.keys(laterChanges).length || Object.keys(laterMoves).length) {
    git("add", "-A");
    git("commit", "-q", "-m", "later");
  }

  const artifact = join(repo, "artifact");
  write(artifact, "rom-weaver-app.wasm", "module");
  write(artifact, "third_party/licenses/zlib.txt", "zlib\n");
  if (bundleCommit !== undefined) write(repo, `${WEBAPP}/build/bundle-commit`, `${bundleCommit ?? bundled}\n`);
  if (wasmManifest) write(repo, `${WEBAPP}/build/bundle-wasm.sha256`, buildManifest(artifact));
  write(repo, `${WEBAPP}/src/wasm/rom-weaver-app.wasm`, runWasm);
  write(repo, `${WEBAPP}/src/wasm/third_party/licenses/zlib.txt`, "zlib\n");
  return { bundled, repo };
}

function decide(repo) {
  const output = join(repo, "github-output.txt");
  writeFileSync(output, "");
  const result = spawnSync("node", [SCRIPT], { cwd: repo, encoding: "utf8", env: isolatedEnv({ GITHUB_OUTPUT: output }) });
  assert.equal(result.status, 0, result.stderr);
  return { log: result.stdout, output: readFileSync(output, "utf8") };
}

test("reuses the restored bundle only when nothing it was built from changed", async (t) => {
  for (const { name, options, reuse, reason } of [
    { name: "same commit", options: { bundleCommit: null }, reuse: true },
    { name: "only non-webapp files changed", options: { bundleCommit: null, laterChanges: { "README.md": "edited\n" } }, reuse: true },
    { name: "no bundle restored", options: {}, reuse: false, reason: /no tested bundle was restored/ },
    { name: "unreadable bundle commit", options: { bundleCommit: "main" }, reuse: false, reason: /holds no commit/ },
    { name: "bundle commit not in history", options: { bundleCommit: "f".repeat(40) }, reuse: false, reason: /cannot diff/ },
    {
      name: "webapp input changed",
      options: { bundleCommit: null, laterChanges: { [`${WEBAPP}/src/webapp/app.ts`]: "export const x = 1;\n" } },
      reuse: false,
      reason: /webapp inputs changed/,
    },
    {
      name: "webapp input moved out of the webapp",
      options: { bundleCommit: null, laterMoves: { [`${WEBAPP}/src/webapp/app.ts`]: "notes/app.ts" } },
      reuse: false,
      reason: /webapp inputs changed/,
    },
    { name: "wasm module differs", options: { bundleCommit: null, runWasm: "rebuilt" }, reuse: false, reason: /rom-weaver-app\.wasm differs/ },
    { name: "no wasm manifest", options: { bundleCommit: null, wasmManifest: false }, reuse: false, reason: /cannot read/ },
  ]) {
    await t.test(name, (t) => {
      const { repo } = restoredBundle(t, options);
      const { log, output } = decide(repo);
      assert.equal(output, `reuse=${reuse}\n`);
      if (reason) assert.match(log, reason);
    });
  }
});
