import assert from "node:assert/strict";
import test from "node:test";

import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";
import { artifactsAvailable, isReleasePull, isTrustedRun, MAX_CANDIDATES, normalizePrNumber, resolveWasmRun, trustedRuns, WORKFLOW_PATH } from "./resolve-wasm-run.mjs";

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
    // GitHub fills this from the pull requests open now; after the merge it names the next one.
    pull_requests: [{ number: 8, base: { ref: "main" } }],
    ...overrides,
  });
// The merged release pull request 7, as the pulls API reports it.
const releasePull = (overrides = {}) => ({
  number: 7,
  merged: true,
  head: { sha: SHA, ref: RELEASE_BRANCH, repo: { full_name: REPO } },
  base: { ref: "main", repo: { full_name: REPO } },
  ...overrides,
});
const trusted = (run, prNumber = "", pull = releasePull()) => isTrustedRun(run, { repository: REPO, prNumber, pull });

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

test("a pull request run is trusted only while its pull request is the merged release pull request into main", () => {
  const head = releasePull().head;
  const base = releasePull().base;
  for (const [label, pull] of Object.entries({
    "an open or closed pull request": releasePull({ merged: false }),
    "the release head merged into another base": releasePull({ base: { ...base, ref: "attacker/branch" } }),
    "a base in another repository": releasePull({ base: { ...base, repo: { full_name: "attacker/rom-weaver" } } }),
    "another head commit": releasePull({ head: { ...head, sha: "b".repeat(40) } }),
    "not the release branch": releasePull({ head: { ...head, ref: "feature/wasm" } }),
    "a fork's head": releasePull({ head: { ...head, repo: { full_name: "attacker/rom-weaver" } } }),
    "a deleted head repository": releasePull({ head: { ...head, repo: null } }),
    "another number": releasePull({ number: 8 }),
    "no pull request": null,
  }))
    assert.equal(trusted(prRun(), "7", pull), false, label);
  // The run's own pull_requests never decide: GitHub rewrites it once the pull request merges.
  for (const pull_requests of [[], undefined, [{ number: 7, base: { ref: "attacker/branch" } }]])
    assert.equal(trusted(prRun({ pull_requests }), "7"), true, JSON.stringify(pull_requests));
  assert.equal(isReleasePull(releasePull(), { repository: REPO, prNumber: "7", sha: SHA }), true);
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
function stub({ runs = [], artifacts = {}, byId = {}, pull = releasePull() }) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    const path = args[1];
    if (path.includes("/workflows/ci.yml/runs?")) return JSON.stringify(runs);
    const artifactsOf = /actions\/runs\/(\d+)\/artifacts/u.exec(path);
    if (artifactsOf) return JSON.stringify(artifacts[artifactsOf[1]] ?? []);
    const single = /actions\/runs\/(\d+)$/u.exec(path);
    if (single) return JSON.stringify(byId[single[1]] ?? null);
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+$/u.test(path)) {
      if (pull instanceof Error) throw pull;
      return JSON.stringify(pull);
    }
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
  assert.deepEqual(resolve(gh), { runId: "10", runIds: ["10"], available: true });
  assert.ok(!gh.calls.some((args) => args[1].includes("/runs/99")), "the untrusted run's artifacts are never listed");
});

test("the resolver lists only successful runs of the exact commit", () => {
  const gh = stub({ runs: [] });
  assert.deepEqual(resolve(gh), { runId: "", runIds: [], available: false });
  assert.equal(gh.calls[0][1], `repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&status=success&per_page=100`);
});

test("without a pull request number only push-to-main runs resolve", () => {
  const gh = stub({ runs: [prRun({ id: 20 })], artifacts: { 20: BOTH } });
  assert.deepEqual(resolve(gh), { runId: "", runIds: [], available: false });
  assert.deepEqual(resolve(gh, { prNumber: "7" }), { runId: "20", runIds: ["20"], available: true });
  assert.deepEqual(resolve(gh, { prNumber: "8" }), { runId: "", runIds: [], available: false });
  assert.ok(gh.calls.some((args) => args[1] === `repos/${REPO}/pulls/7`), "the pull request itself is read");
});

test("a pull request that is not merged, or cannot be read, leaves only runs of main", () => {
  const runs = [prRun({ id: 20, created_at: "2026-10-09T00:00:00Z" }), pushRun({ id: 21 })];
  const artifacts = { 20: BOTH, 21: BOTH };
  assert.deepEqual(resolve(stub({ runs, artifacts, pull: releasePull({ merged: false }) }), { prNumber: "7" }), { runId: "21", runIds: ["21"], available: true });
  assert.deepEqual(resolve(stub({ runs, artifacts, pull: new Error("HTTP 502") }), { prNumber: "7" }), { runId: "21", runIds: ["21"], available: true });
  assert.deepEqual(resolve(stub({ runs, artifacts }), { prNumber: "7" }), { runId: "20", runIds: ["20", "21"], available: true });
});

test("the resolver skips a newer trusted run that never built the module", () => {
  const gh = stub({
    runs: [pushRun({ id: 31, created_at: "2026-10-02T00:00:00Z" }), pushRun({ id: 30, created_at: "2026-10-01T00:00:00Z" })],
    artifacts: { 31: [], 30: BOTH },
  });
  assert.deepEqual(resolve(gh), { runId: "30", runIds: ["30"], available: true });
});

test("a run with the module but no signed manifest is unavailable", () => {
  const gh = stub({ runs: [pushRun({ id: 40 })], artifacts: { 40: [{ name: "wasm-prod", expired: false }] } });
  assert.deepEqual(resolve(gh), { runId: "", runIds: [], available: false });
});

test("a preferred run is used only when it is trusted and for the commit", () => {
  const trustedRun = pushRun({ id: 50 });
  const gh = stub({ runs: [], artifacts: { 50: BOTH }, byId: { 50: trustedRun } });
  assert.deepEqual(resolve(gh, { preferredRunId: "50" }), { runId: "50", runIds: ["50"], available: true });

  const forged = prRun({ id: 51, head_branch: "attacker", pull_requests: [{ number: 51, base: { ref: "attacker/base" } }] });
  const search = stub({ runs: [pushRun({ id: 52 })], artifacts: { 51: BOTH, 52: BOTH }, byId: { 51: forged } });
  assert.deepEqual(resolve(search, { preferredRunId: "51" }), { runId: "52", runIds: ["52"], available: true });

  const otherCommit = stub({ runs: [], byId: { 53: pushRun({ id: 53, head_sha: "b".repeat(40) }) } });
  assert.deepEqual(resolve(otherCommit, { preferredRunId: "53" }), { runId: "", runIds: [], available: false });
});

test("the resolver hands the verifier every candidate with the module, newest first, up to a limit", () => {
  const runs = Array.from({ length: MAX_CANDIDATES + 2 }, (_, index) => pushRun({ id: 60 + index, created_at: `2026-10-${String(10 + index).padStart(2, "0")}T00:00:00Z` }));
  const artifacts = Object.fromEntries(runs.map((run) => [run.id, run.id === 65 ? [] : BOTH]));
  const result = resolve(stub({ runs, artifacts }));
  assert.deepEqual(result.runIds, ["66", "64", "63", "62", "61"], "the newest first, skipping a run without the module");
  assert.equal(result.runId, "66");
  assert.equal(result.available, true);
});
