import assert from "node:assert/strict";
import test from "node:test";

import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";
import { artifactsAvailable, isTrustedRun, normalizePrNumber, resolveWasmRun, trustedRuns, WORKFLOW_PATH } from "./resolve-wasm-run.mjs";

const REPO = "octo/rom-weaver";
const SHA = "a".repeat(40);
const RELEASE_BRANCH = `${RELEASE_PR_BRANCH_PREFIX}cli`;

const pushRun = (overrides = {}) => ({
  id: 1,
  path: WORKFLOW_PATH,
  event: "push",
  head_branch: "main",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  created_at: "2026-10-03T00:00:00Z",
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  pull_requests: [],
  ...overrides,
});
const prRun = (overrides = {}) =>
  pushRun({
    id: 2,
    event: "pull_request",
    head_branch: RELEASE_BRANCH,
    pull_requests: [{ number: 7, base: { ref: "main" } }],
    ...overrides,
  });
const trusted = (run, prNumber = "") => isTrustedRun(run, { repository: REPO, prNumber });

test("a successful push-to-main ci.yml run is trusted with or without a release pull request", () => {
  assert.equal(trusted(pushRun()), true);
  assert.equal(trusted(pushRun(), "7"), true);
});

test("the release pull request's own run is trusted only for that number", () => {
  assert.equal(trusted(prRun(), "7"), true);
  assert.equal(trusted(prRun(), 7), true);
  assert.equal(trusted(prRun(), ""), false, "no number: push-to-main runs only");
  assert.equal(trusted(prRun(), "8"), false, "another pull request");
  assert.equal(trusted(prRun(), "07"), false);
  assert.equal(trusted(prRun(), "7 "), false);
});

test("a pull request run must target main, including when other pull requests share its head", () => {
  const attackerBase = prRun({ pull_requests: [{ number: 7, base: { ref: "attacker/branch" } }] });
  assert.equal(trusted(attackerBase, "7"), false);
  assert.equal(trusted(prRun({ pull_requests: [] }), "7"), false);
  assert.equal(trusted(prRun({ pull_requests: undefined }), "7"), false);
  const shared = prRun({ pull_requests: [{ number: 9, base: { ref: "attacker/branch" } }, { number: 7, base: { ref: "main" } }] });
  assert.equal(trusted(shared, "7"), true);
  assert.equal(trusted(shared, "9"), false);
});

test("a pull request run from a branch that is not a release branch is rejected", () => {
  assert.equal(trusted(prRun({ head_branch: "feature/wasm" }), "7"), false);
  assert.equal(trusted(prRun({ head_branch: `wip-${RELEASE_BRANCH}` }), "7"), false);
});

test("a manual dispatch run of main is trusted like a push", () => {
  assert.equal(trusted(pushRun({ event: "workflow_dispatch" }), ""), true);
  assert.equal(trusted(pushRun({ event: "workflow_dispatch", head_branch: "feature" }), ""), false, "a dispatch of another branch");
});

test("other events are rejected", () => {
  for (const event of ["schedule", "pull_request_target", "workflow_run", "release", "merge_group", ""])
    assert.equal(trusted(pushRun({ event }), "7"), false, event);
});

test("a push run must be on main, not another branch or a tag", () => {
  for (const head_branch of ["feature", "v1.2.3", RELEASE_BRANCH, "main2", "refs/heads/main", ""])
    assert.equal(trusted(pushRun({ head_branch })), false, head_branch);
});

test("only the exact ci.yml workflow path is accepted", () => {
  for (const path of [
    `${WORKFLOW_PATH}@refs/heads/main`,
    ".github/workflows/evil/.github/workflows/ci.yml",
    `x${WORKFLOW_PATH}`,
    `${WORKFLOW_PATH}x`,
    ".github/workflows/ci.yaml",
    ".github/workflows/Ci.yml",
    ".github/workflows/parity.yml",
    "ci.yml",
    "/.github/workflows/ci.yml",
    "",
  ]) {
    assert.equal(trusted(pushRun({ path })), false, path);
    assert.equal(trusted(prRun({ path }), "7"), false, path);
  }
  assert.equal(trusted(pushRun({ path: undefined })), false);
});

test("runs from another head repository or repository are rejected", () => {
  for (const full_name of ["attacker/rom-weaver", `${REPO}-fork`, undefined]) {
    assert.equal(trusted(pushRun({ head_repository: { full_name } })), false, String(full_name));
    assert.equal(trusted(prRun({ head_repository: { full_name } }), "7"), false, String(full_name));
  }
  assert.equal(trusted(pushRun({ head_repository: null })), false);
  assert.equal(trusted(pushRun({ repository: { full_name: "attacker/rom-weaver" } })), false);
});

test("only a completed successful run is trusted", () => {
  for (const overrides of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { conclusion: null }, { status: "in_progress" }, { status: "queued", conclusion: "success" }])
    assert.equal(trusted(pushRun(overrides)), false, JSON.stringify(overrides));
  assert.equal(trusted(null), false);
  assert.equal(trusted(undefined), false);
});

test("normalizePrNumber keeps only plain positive integers", () => {
  assert.equal(normalizePrNumber("12"), "12");
  assert.equal(normalizePrNumber(12), "12");
  for (const value of ["", undefined, null, "0", "-1", "1.5", "1a", "../1", " 1"]) assert.equal(normalizePrNumber(value), "", String(value));
});

test("trustedRuns drops other commits and returns the newest first", () => {
  const older = pushRun({ id: 5, created_at: "2026-10-01T00:00:00Z" });
  const newer = pushRun({ id: 6, created_at: "2026-10-02T00:00:00Z" });
  const otherSha = pushRun({ id: 7, created_at: "2026-10-04T00:00:00Z", head_sha: "b".repeat(40) });
  assert.deepEqual(trustedRuns([older, otherSha, newer], { repository: REPO, targetSha: SHA }).map((run) => run.id), [6, 5]);
});

test("artifacts count only when the module and its signed manifest are both live", () => {
  const live = (name) => ({ name, expired: false });
  assert.equal(artifactsAvailable([live("wasm-prod"), live("wasm-prod-manifest")]), true);
  assert.equal(artifactsAvailable([live("wasm-prod")]), false);
  assert.equal(artifactsAvailable([live("wasm-prod-manifest")]), false);
  assert.equal(artifactsAvailable([live("wasm-prod"), { name: "wasm-prod-manifest", expired: true }]), false);
  assert.equal(artifactsAvailable([]), false);
  assert.equal(artifactsAvailable(undefined), false);
});

// A stubbed `gh`: run listings and per-run artifact lists keyed by what the resolver asks for.
function stub({ runs = [], artifacts = {}, byId = {} }) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    const path = args[1];
    if (path.includes("/workflows/ci.yml/runs?")) return JSON.stringify(runs);
    const artifactsOf = /actions\/runs\/(\d+)\/artifacts/u.exec(path);
    if (artifactsOf) return JSON.stringify(artifacts[artifactsOf[1]] ?? []);
    const single = /actions\/runs\/(\d+)$/u.exec(path);
    if (single) return JSON.stringify(byId[single[1]] ?? null);
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, runGh };
}
const BOTH = [{ name: "wasm-prod", expired: false }, { name: "wasm-prod-manifest", expired: false }];
const resolve = (gh, options = {}) => resolveWasmRun({ repository: REPO, targetSha: SHA, runGh: gh.runGh, ...options });

test("the resolver ignores an attacker's newer pull request run whose head is the release commit", () => {
  const attacker = prRun({ id: 99, created_at: "2026-10-09T00:00:00Z", head_branch: "attacker", pull_requests: [{ number: 99, base: { ref: "attacker/base" } }] });
  const legit = pushRun({ id: 10, created_at: "2026-10-01T00:00:00Z" });
  const gh = stub({ runs: [attacker, legit], artifacts: { 99: BOTH, 10: BOTH } });
  assert.deepEqual(resolve(gh), { runId: "10", available: true });
  assert.ok(!gh.calls.some((args) => args[1].includes("/runs/99")), "the untrusted run's artifacts are never listed");
});

test("the resolver lists only successful runs of the exact commit", () => {
  const gh = stub({ runs: [] });
  assert.deepEqual(resolve(gh), { runId: "", available: false });
  assert.equal(gh.calls[0][1], `repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&status=success&per_page=100`);
});

test("without a pull request number only push-to-main runs resolve", () => {
  const gh = stub({ runs: [prRun({ id: 20 })], artifacts: { 20: BOTH } });
  assert.deepEqual(resolve(gh), { runId: "", available: false });
  assert.deepEqual(resolve(gh, { prNumber: "7" }), { runId: "20", available: true });
  assert.deepEqual(resolve(gh, { prNumber: "8" }), { runId: "", available: false });
});

test("the resolver skips a newer trusted run that never built the module", () => {
  const gh = stub({
    runs: [pushRun({ id: 31, created_at: "2026-10-02T00:00:00Z" }), pushRun({ id: 30, created_at: "2026-10-01T00:00:00Z" })],
    artifacts: { 31: [], 30: BOTH },
  });
  assert.deepEqual(resolve(gh), { runId: "30", available: true });
});

test("a run with the module but no signed manifest is unavailable", () => {
  const gh = stub({ runs: [pushRun({ id: 40 })], artifacts: { 40: [{ name: "wasm-prod", expired: false }] } });
  assert.deepEqual(resolve(gh), { runId: "", available: false });
});

test("a preferred run is used only when it is trusted and for the commit", () => {
  const trustedRun = pushRun({ id: 50 });
  const gh = stub({ runs: [], artifacts: { 50: BOTH }, byId: { 50: trustedRun } });
  assert.deepEqual(resolve(gh, { preferredRunId: "50" }), { runId: "50", available: true });

  const forged = prRun({ id: 51, head_branch: "attacker", pull_requests: [{ number: 51, base: { ref: "attacker/base" } }] });
  const search = stub({ runs: [pushRun({ id: 52 })], artifacts: { 51: BOTH, 52: BOTH }, byId: { 51: forged } });
  assert.deepEqual(resolve(search, { preferredRunId: "51" }), { runId: "52", available: true });

  const otherCommit = stub({ runs: [], byId: { 53: pushRun({ id: 53, head_sha: "b".repeat(40) }) } });
  assert.deepEqual(resolve(otherCommit, { preferredRunId: "53" }), { runId: "", available: false });
});
