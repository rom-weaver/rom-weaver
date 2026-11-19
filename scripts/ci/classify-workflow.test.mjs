import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { git, isolatedEnv } from "../test-git.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "classify-workflow.mjs");

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

function classify({
  cwd,
  base,
  head,
  usePrior = "",
  eventName = "pull_request",
  headRef = "fix/x",
  greenSha = "",
  ref = "",
}) {
  const output = join(cwd, "github-output.txt");
  writeFileSync(output, "");
  const result = spawnSync("node", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: isolatedEnv({
      GITHUB_OUTPUT: output,
      EVENT_NAME: eventName,
      HEAD_REF: headRef,
      BASE_SHA: base,
      HEAD_SHA: head,
      PRIOR_GREEN_SHA: usePrior,
      MAIN_GREEN_SHA: greenSha,
      GITHUB_REF: ref,
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

test("a push reuses ARM WASM only when its range leaves the image plumbing alone", (t) => {
  const repo = history(t);
  assert.equal(classify({ ...repo, eventName: "push", headRef: "" }).outputs.docker_arm_wasm_cache, "true");

  const dockerfile = join("packages", "rom-weaver-webapp", "Dockerfile");
  mkdirSync(join(repo.cwd, "packages", "rom-weaver-webapp"), { recursive: true });
  writeFileSync(join(repo.cwd, dockerfile), "FROM scratch\n");
  git(repo.cwd, "add", "-A");
  git(repo.cwd, "commit", "-q", "-m", "docker");
  const head = git(repo.cwd, "rev-parse", "HEAD");
  assert.equal(classify({ ...repo, head, eventName: "push", headRef: "" }).outputs.docker_arm_wasm_cache, "false");
});

test("a ci.yml or local action edit compiles ARM WASM only when it reaches the docker job", (t) => {
  const repo = history(t);
  const commitFiles = (files) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo.cwd, path)), { recursive: true });
      writeFileSync(join(repo.cwd, path), body);
    }
    git(repo.cwd, "add", "-A");
    git(repo.cwd, "commit", "-q", "-m", "ci");
    return git(repo.cwd, "rev-parse", "HEAD");
  };
  const workflow = ({ header = "on: push", docker = "x", other = "x" } = {}) => ({
    ".github/workflows/ci.yml": `name: CI\n${header}\njobs:\n  changes:\n    runs-on: x\n  docker:\n    runs-on: x\n  # A comment at job-key indentation.\n    steps:\n      - uses: ./.github/actions/extra\n        with:\n          arch: ${docker}\n\n  # The next job.\n  other:\n    runs-on: ${other}\n`,
  });
  const extraAction = { ".github/actions/extra/action.yml": "name: y\n" };
  const uncalledAction = { ".github/actions/uncalled/action.yml": "name: y\n" };
  const base = commitFiles({
    ...workflow(),
    ".github/actions/extra/action.yml": "name: x\n",
    ".github/actions/uncalled/action.yml": "name: x\n",
  });
  for (const [edit, expected] of [
    [workflow({ other: "y" }), "true"],
    [workflow({ docker: "y" }), "false"],
    [workflow({ header: "on: pull_request" }), "false"],
    [extraAction, "false"],
    [uncalledAction, "true"],
  ]) {
    git(repo.cwd, "reset", "-q", "--hard", base);
    const head = commitFiles(edit);
    for (const eventName of ["pull_request", "push"])
      assert.equal(
        classify({ ...repo, base, head, eventName, headRef: "" }).outputs.docker_arm_wasm_cache,
        expected,
        `${eventName} ${JSON.stringify(edit)}`,
      );
  }
  // A commit without the docker job, or without the workflow, counts as a change.
  git(repo.cwd, "reset", "-q", "--hard", base);
  const noDockerJob = commitFiles({ ".github/workflows/ci.yml": "name: CI\njobs:\n  other:\n    runs-on: x\n" });
  for (const missing of [noDockerJob, repo.head])
    assert.equal(classify({ ...repo, base: missing, head: base }).outputs.docker_arm_wasm_cache, "false", missing);
  const actionWithoutDockerJob = commitFiles(uncalledAction);
  assert.equal(
    classify({ ...repo, base: noDockerJob, head: actionWithoutDockerJob }).outputs.docker_arm_wasm_cache,
    "false",
  );
});

test("a push without a known earlier commit compiles ARM WASM", (t) => {
  const repo = history(t);
  for (const base of ["0".repeat(40), "d".repeat(40), ""])
    assert.equal(classify({ ...repo, base, eventName: "push", headRef: "" }).outputs.docker_arm_wasm_cache, "false", base);
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

test("a Rust path with non-ASCII characters still selects Rust", (t) => {
  const repo = history(t);
  writeFileSync(join(repo.cwd, "crates/rom-weaver-core/src/näme.rs"), "// edit\n");
  git(repo.cwd, "add", "-A");
  git(repo.cwd, "commit", "-q", "-m", "name");
  const head = git(repo.cwd, "rev-parse", "HEAD");
  const { outputs } = classify({ ...repo, head, base: repo.head });
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

test("release_pr is true only for a pull request from the release branch", (t) => {
  const repo = history(t);
  const releaseRef = `${RELEASE_PR_BRANCH_PREFIX}cli`;
  for (const [eventName, headRef, expected] of [
    ["pull_request", releaseRef, "true"],
    // Workflow expressions that test the same prefix ignore case.
    ["pull_request", releaseRef.toUpperCase(), "true"],
    ["pull_request", "fix/x", "false"],
    ["pull_request", `wip-${releaseRef}`, "false"],
    ["push", releaseRef, "false"],
    ["schedule", releaseRef, "false"],
  ]) {
    const { outputs } = classify({ ...repo, eventName, headRef });
    assert.equal(outputs.release_pr, expected, `${eventName} ${headRef}`);
  }
});

// Commits the files on top of the current HEAD and returns the new commit.
function commitFiles(cwd, files) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", Object.keys(files).join(","));
  return git(cwd, "rev-parse", "HEAD");
}

const MAIN = "refs/heads/main";
const EVERY_STACK = ["rust", "rust_lint", "fuzz", "security", "docker_cli", "docker_webapp", "docker_cli_arm64", "docker_webapp_arm64", "webapp", "docker_prebuilt"];

function mainPush(repo, extra) {
  return classify({ ...repo, eventName: "push", headRef: "", ref: MAIN, ...extra }).outputs;
}

test("a docs-only push to main skips the Docker CLI image and Rust but keeps the webapp", (t) => {
  const repo = history(t);
  const head = commitFiles(repo.cwd, { "docs/faq.md": "# faq\n" });
  const outputs = mainPush(repo, { base: repo.head, head, greenSha: repo.head });
  for (const key of ["rust", "rust_lint", "fuzz", "security", "docker_cli", "docker_webapp", "docker_cli_arm64", "docker_webapp_arm64", "full"])
    assert.equal(outputs[key], "false", key);
  for (const key of ["webapp", "webapp_browser", "docker_prebuilt"]) assert.equal(outputs[key], "true", key);
});

test("a docs-only push to main still rebuilds the webapp source image for the self-hosting guide", (t) => {
  const repo = history(t);
  const head = commitFiles(repo.cwd, { "docs/hosting/self-hosting.md": "# host\n" });
  const outputs = mainPush(repo, { base: repo.head, head, greenSha: repo.head });
  assert.equal(outputs.docker_webapp, "true");
  assert.equal(outputs.docker_webapp_arm64, "true");
  assert.equal(outputs.docker_cli, "false");
});

test("a push to main selects every stack when the range since the last green push is not docs-only", (t) => {
  const repo = history(t);
  let greenSha = repo.head;
  for (const file of ["Dockerfile", "crates/rom-weaver-cli/src/lib.rs", "docs/reference/cli.md", "docs/man/rom-weaver.1"]) {
    const head = commitFiles(repo.cwd, { [file]: "x\n", "docs/faq.md": `${file}\n` });
    const outputs = mainPush(repo, { base: greenSha, head, greenSha });
    for (const key of EVERY_STACK) assert.equal(outputs[key], "true", `${file}: ${key}`);
    greenSha = head;
  }
});

test("a docs-only push that replaced a pending run still builds what the replaced push changed", (t) => {
  const repo = history(t);
  const replaced = commitFiles(repo.cwd, { Dockerfile: "FROM scratch\n" });
  const head = commitFiles(repo.cwd, { "docs/faq.md": "# faq\n" });
  // The push's own range (replaced..head) is docs-only; the range since the last green run is not.
  const outputs = mainPush(repo, { base: replaced, head, greenSha: repo.head });
  for (const key of EVERY_STACK) assert.equal(outputs[key], "true", key);
});

test("without a usable last green push, or off main, a docs-only push selects every stack", (t) => {
  const repo = history(t);
  const head = commitFiles(repo.cwd, { "docs/faq.md": "# faq\n" });
  for (const extra of [
    { greenSha: "" },
    { greenSha: "d".repeat(40) },
    { greenSha: repo.head, ref: "refs/tags/v1.0.0" },
    { greenSha: repo.head, ref: "refs/heads/feature" },
    { greenSha: repo.head, eventName: "workflow_dispatch" },
  ]) {
    const outputs = mainPush(repo, { base: repo.head, head, ...extra });
    for (const key of EVERY_STACK) assert.equal(outputs[key], "true", JSON.stringify(extra) + key);
  }
});

test("a push to main identical to the last green push is not narrowed", (t) => {
  const repo = history(t);
  const outputs = mainPush(repo, { base: repo.head, head: repo.head, greenSha: repo.head });
  for (const key of EVERY_STACK) assert.equal(outputs[key], "true", key);
});
