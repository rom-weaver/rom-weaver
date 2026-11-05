import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const read = (name) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");
const workflow = (name) => load(read(name));

// GitHub expressions in these conditions are also valid JavaScript.
const evaluate = (expression, event, headRef = "") =>
  runInNewContext(expression, {
    github: { event_name: event, head_ref: headRef },
    startsWith: (value, prefix) => value.startsWith(prefix),
    cancelled: () => false,
  });

const EVENTS = [
  ["schedule", "", true],
  ["workflow_dispatch", "", true],
  ["pull_request", "feature/perf", false],
  ["pull_request", `${RELEASE_PR_BRANCH_PREFIX}cli`, true],
  ["pull_request", `wip-${RELEASE_PR_BRANCH_PREFIX}cli`, false],
];

test("every workflow copy of the release branch prefix matches release-pr.mjs", () => {
  for (const name of ["release.yml", "codeql.yml", "parity.yml", "ci.yml"]) {
    const copies = read(name).match(/release-please--branches--[\w-]*/gu) ?? [];
    assert.ok(copies.length > 0, `${name} tests the release branch prefix`);
    for (const copy of copies) assert.equal(copy, RELEASE_PR_BRANCH_PREFIX, name);
  }
});

test("nightly-only workflows also run on release pull requests and skip the rest", () => {
  const parity = workflow("parity.yml");
  const codeql = workflow("codeql.yml");
  for (const [name, wf, job] of [
    ["parity", parity, "parity"],
    ["perf", parity, "perf"],
    ["codeql", codeql, "analyze"],
  ]) {
    assert.deepEqual(wf.on.pull_request.types, ["opened", "synchronize", "reopened"], name);
    assert.ok(wf.on.schedule, `${name} keeps its schedule`);
    for (const [event, headRef, expected] of EVENTS) {
      assert.equal(evaluate(wf.jobs[job].if, event, headRef), expected, `${name} ${event} ${headRef}`);
    }
  }
});

test("release pull requests find the last nightly before the classifier runs", () => {
  const step = workflow("ci.yml").jobs.changes.steps.find((s) => s.id === "last-nightly");
  for (const [event, headRef, expected] of EVENTS) {
    assert.equal(evaluate(step.if, event, headRef), expected, `${event} ${headRef}`);
  }
  assert.equal(evaluate(step.if, "push"), false);
});

test("the perf job times the parity CLI against the latest release", () => {
  const { jobs } = workflow("parity.yml");
  assert.equal(jobs.perf.needs, "parity");
  const upload = jobs.parity.steps.find((s) => s.name === "Upload rom-weaver CLI");
  const parityCheck = jobs.parity.steps.findIndex((s) => s.id === "parity");
  assert.ok(jobs.parity.steps.indexOf(upload) < parityCheck, "the CLI uploads before the parity check");
  const download = jobs.perf.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with.name, upload.with.name);
  const base = jobs.perf.steps.find((s) => s.id === "base");
  assert.ok(base.run.includes("rom-weaver-linux-x64-gnu.tar.gz"));
  const fixtures = jobs.perf.steps.find((s) => s.name === "Write NKit fixtures");
  assert.ok(fixtures.run.includes("--example nkit_fixture"));
  const compare = jobs.perf.steps.find((s) => s.run?.includes("scripts/bench-compare.py"));
  assert.ok(compare.run.includes("--threshold 1.10"));
  assert.ok(compare.run.includes("set -euo pipefail"), "tee keeps the comparison's exit status");
});

test("pushes to a release branch cancel the runs of the commit they replace", () => {
  const codeql = workflow("codeql.yml").concurrency;
  assert.equal(codeql["cancel-in-progress"], true);
  const parity = workflow("parity.yml").concurrency;
  // Pull request runs share one group per branch; every other event gets a group of its own run.
  assert.equal(parity.group, "parity-${{ github.event_name == 'pull_request' && github.head_ref || github.run_id }}");
  assert.equal(parity["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
});

test("the Release job pushes the release branch once, after every commit it makes", () => {
  const release = workflow("release.yml").jobs.release;
  const steps = release.steps;
  const pushes = steps.filter((step) => /git push/u.test(step.run ?? ""));
  assert.equal(pushes.length, 1, "one git push step in the release job");
  assert.equal(steps.at(-1), pushes[0], "the push is the last step");
  assert.match(pushes[0].if, /!cancelled\(\)/u);
  for (const step of steps) {
    if (step === pushes[0]) continue;
    assert.equal(step.env?.RELEASE_PR_BRANCH, undefined, `${step.name} must not be able to push`);
  }
});

test("the release push skips a run that made no commit, even when the branch moved", () => {
  const push = workflow("release.yml").jobs.release.steps.at(-1).run;
  const scratch = resolve(".agent/release-push");
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "push-"));
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (cwd, message) =>
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", message);
  const run = (cwd) =>
    spawnSync("bash", ["-eu", "-c", push], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, RELEASE_PR_BRANCH: "release" },
    });
  try {
    const origin = join(directory, "origin.git");
    git(directory, "init", "-q", "--bare", origin);
    const job = join(directory, "job");
    const other = join(directory, "other");
    git(directory, "clone", "-q", origin, job);
    commit(job, "base");
    git(job, "push", "-q", "origin", "HEAD:release");
    git(directory, "clone", "-q", "--branch", "release", origin, other);
    commit(other, "outside push");
    git(other, "push", "-q", "origin", "HEAD:release");
    const moved = git(origin, "rev-parse", "release");

    const idle = run(job);
    assert.equal(idle.status, 0, idle.stderr);
    assert.equal(git(origin, "rev-parse", "release"), moved, "nothing was pushed");

    git(job, "reset", "-q", "--hard", moved);
    commit(job, "changelog");
    const busy = run(job);
    assert.equal(busy.status, 0, busy.stderr);
    assert.equal(git(origin, "rev-parse", "release"), git(job, "rev-parse", "HEAD"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
