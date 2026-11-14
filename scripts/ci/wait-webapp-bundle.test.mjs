import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

import { SAVED, waitForBundle } from "./wait-webapp-bundle.mjs";

const SHA = "a".repeat(40);
const KEY = `webapp-bundle-Linux-${SHA}`;
const bundle = { repository: "owner/repo", sha: SHA, key: KEY };
const mainCache = { key: KEY, ref: "refs/heads/main" };

// Answers each poll from the next entry of `polls`: the caches main holds, and its runs for SHA.
// A poll that finds no cache reads the caches again after the runs, as the save can land between.
function fakeApi(polls) {
  let poll = 0;
  let cacheReads = 0;
  const api = async (path) => {
    const { caches = [], recheckCaches = caches, runs = [] } = polls[Math.min(poll, polls.length - 1)];
    const url = new URL(path, "https://api.example.test");
    if (url.pathname.endsWith("/actions/caches")) {
      assert.equal(url.searchParams.get("key"), KEY);
      assert.equal(url.searchParams.get("ref"), "refs/heads/main");
      cacheReads += 1;
      return { actions_caches: cacheReads === 1 ? caches : recheckCaches };
    }
    assert.ok(url.pathname.endsWith("/actions/workflows/ci.yml/runs"), path);
    assert.equal(url.searchParams.get("branch"), "main");
    assert.equal(url.searchParams.get("event"), "push");
    assert.equal(url.searchParams.get("head_sha"), SHA);
    return { workflow_runs: runs };
  };
  // Each poll starts a fresh count of cache reads.
  const wait = async () => {
    poll += 1;
    cacheReads = 0;
  };
  return { api, wait, polls: () => poll };
}

test("waits while main's run is in progress and stops once it saves or ends", async (t) => {
  const running = { runs: [{ status: "in_progress" }] };
  for (const { name, polls, state, waits } of [
    { name: "already saved", polls: [{ caches: [mainCache] }], state: SAVED, waits: 0 },
    { name: "saved after two polls", polls: [running, running, { caches: [mainCache] }], state: SAVED, waits: 2 },
    {
      name: "saved as the run completed",
      polls: [{ recheckCaches: [mainCache], runs: [{ status: "completed" }] }],
      state: SAVED,
      waits: 0,
    },
    { name: "no main run for the commit", polls: [{ runs: [] }], state: "main has no CI run for this commit", waits: 0 },
    {
      name: "run ended without saving",
      polls: [running, { runs: [{ status: "completed" }] }],
      state: "main's CI run ended without saving a bundle",
      waits: 1,
    },
    {
      name: "a rerun is still in progress",
      polls: [{ runs: [{ status: "completed" }, { status: "queued" }] }, { caches: [mainCache] }],
      state: SAVED,
      waits: 1,
    },
    {
      name: "a longer key or another ref is not the bundle",
      polls: [
        {
          caches: [
            { key: `${KEY}-other`, ref: "refs/heads/main" },
            { key: KEY, ref: "refs/pull/7/merge" },
          ],
          runs: [{ status: "completed" }],
        },
      ],
      state: "main's CI run ended without saving a bundle",
      waits: 0,
    },
  ]) {
    await t.test(name, async () => {
      const fake = fakeApi(polls);
      assert.equal(await waitForBundle({ api: fake.api, bundle, wait: fake.wait }), state);
      assert.equal(fake.polls(), waits);
    });
  }
});

test("gives up after the wait limit", async () => {
  let clock = 0;
  const fake = fakeApi([{ runs: [{ status: "in_progress" }] }]);
  const wait = async (ms) => {
    clock += ms;
    await fake.wait();
  };
  const state = await waitForBundle({ api: fake.api, bundle, now: () => clock, wait, limitMs: 90_000, intervalMs: 30_000 });
  assert.equal(state, "timed out");
  assert.equal(clock, 90_000);
});

test("an unexpected API response fails instead of reading as no bundle", async () => {
  await assert.rejects(waitForBundle({ api: async () => ({}), bundle }), /missing actions_caches/);
});

test("tag deploys wait for the key main saves and the deploy restores", () => {
  const { load } = createRequire(import.meta.url)("js-yaml");
  const readYaml = (path) => load(readFileSync(new URL(path, import.meta.url), "utf8"));
  const { jobs } = readYaml("../../.github/workflows/ci.yml");
  const action = readYaml("../../.github/actions/deploy-webapp-pages/action.yml");
  const stepWith = (steps, uses) => steps.find((step) => step.uses?.startsWith(uses));
  const savedKey = stepWith(jobs["save-webapp-bundle"].steps, "actions/cache/save@").with.key;
  assert.equal(jobs["wait-webapp-bundle"].steps.find((step) => step.env?.BUNDLE_KEY).env.BUNDLE_KEY, savedKey);
  assert.equal(stepWith(action.runs.steps, "actions/cache/restore@").with.key, savedKey);
  assert.ok(jobs.deploy.needs.includes("wait-webapp-bundle"));
});
