import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "classify-workflow.mjs");

// Git hooks export GIT_DIR, GIT_INDEX_FILE, and friends. Inherited, they point
// these commands at the repository running the hook instead of the scratch one.
const isolatedEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  ...extra,
});

const IDENTITY = {
  GIT_AUTHOR_NAME: "ci",
  GIT_AUTHOR_EMAIL: "ci@example.com",
  GIT_COMMITTER_NAME: "ci",
  GIT_COMMITTER_EMAIL: "ci@example.com",
};

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: isolatedEnv(IDENTITY),
  }).trim();
}

// base -> prior (a Rust edit, tested green) -> head (a guide edit only).
function history(t) {
  const cwd = mkdtempSync(join(tmpdir(), "classify-workflow-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q");
  assert.equal(realpathSync(git(cwd, "rev-parse", "--show-toplevel")), realpathSync(cwd));
  const commit = (path, body) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", path);
    return git(cwd, "rev-parse", "HEAD");
  };
  const base = commit("README.md", "base\n");
  const prior = commit("crates/rom-weaver-core/src/lib.rs", "// edit\n");
  const head = commit("CHANGELOG.md", "# log\n");
  return { cwd, base, prior, head };
}

function classify({ cwd, base, head, usePrior = "", eventName = "pull_request" }) {
  const output = join(cwd, "github-output.txt");
  writeFileSync(output, "");
  const result = spawnSync("node", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: isolatedEnv({
      GITHUB_OUTPUT: output,
      EVENT_NAME: eventName,
      HEAD_REF: "fix/x",
      BASE_SHA: base,
      HEAD_SHA: head,
      PRIOR_GREEN_SHA: usePrior,
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    stdout: result.stdout,
    outputs: Object.fromEntries(
      readFileSync(output, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("=")),
    ),
  };
}

test("without an earlier green run the whole pull request selects work", (t) => {
  const { outputs } = classify(history(t));
  assert.equal(outputs.rust, "true");
});

test("an earlier green run limits selection to what changed since", (t) => {
  const repo = history(t);
  const { outputs, stdout } = classify({ ...repo, usePrior: repo.prior });
  assert.equal(outputs.rust, "false");
  assert.match(stdout, /paths changed since the earlier green run/u);
});

test("the cache eligibility still reads the whole pull request diff", (t) => {
  const repo = history(t);
  const dockerfile = join("packages", "rom-weaver-webapp", "Dockerfile");
  mkdirSync(join(repo.cwd, "packages", "rom-weaver-webapp"), { recursive: true });
  writeFileSync(join(repo.cwd, dockerfile), "FROM scratch\n");
  git(repo.cwd, "add", "-A");
  git(repo.cwd, "commit", "-q", "-m", "docker");
  const dockerPrior = git(repo.cwd, "rev-parse", "HEAD");
  writeFileSync(join(repo.cwd, "CHANGELOG.md"), "# later\n");
  git(repo.cwd, "commit", "-q", "-am", "later");
  const head = git(repo.cwd, "rev-parse", "HEAD");
  const { outputs } = classify({ ...repo, head, usePrior: dockerPrior });
  assert.equal(outputs.docker_arm_wasm_cache, "false");
});

test("an unreachable earlier green run falls back to the whole pull request", (t) => {
  const repo = history(t);
  const { outputs, stdout } = classify({ ...repo, usePrior: "d".repeat(40) });
  assert.equal(outputs.rust, "true");
  assert.match(stdout, /is unreachable; using the full diff/u);
});

test("a rename out of a Rust directory still selects Rust", (t) => {
  const repo = history(t);
  git(repo.cwd, "mv", "crates/rom-weaver-core/src/lib.rs", "CHANGELOG-lib.md");
  git(repo.cwd, "commit", "-q", "-am", "move");
  const head = git(repo.cwd, "rev-parse", "HEAD");
  const { outputs } = classify({ ...repo, head, base: repo.prior });
  assert.equal(outputs.rust, "true");
});

test("a push touching only a changelog does not reselect Rust", (t) => {
  const repo = history(t);
  // The earlier run covered the Rust edit; only a changelog differs since, so
  // the jobs that edit selects stay off even though the whole diff selects them.
  const { outputs } = classify({ ...repo, usePrior: repo.prior });
  assert.equal(outputs.rust, "false");
  assert.equal(outputs.webapp, "false");
});

test("a push selects every stack whatever the diff", (t) => {
  const repo = history(t);
  const { outputs } = classify({ ...repo, base: repo.prior, eventName: "push" });
  for (const key of ["rust", "rust_lint", "fuzz", "webapp", "webapp_browser", "docker_prebuilt"]) {
    assert.equal(outputs[key], "true", key);
  }
});
