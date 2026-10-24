import assert from "node:assert/strict";
import test from "node:test";
import { isPublicationFresh } from "./publication-freshness.mjs";

const env = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_RUN_ID: "1",
  PUBLICATION_JOB_NAME: "publish",
  PUBLICATION_STEP_NAME: "write",
};
const mock = (jobs) => async (path) => {
  if (path.endsWith("/runs/1")) return { run_number: 10 };
  if (path.includes("/workflows/"))
    return {
      workflow_runs: [
        { id: 2, run_number: 11 },
        { id: 1, run_number: 10 },
      ],
    };
  assert.match(path, /\/runs\/2\/jobs\?/);
  assert.match(path, /filter=all/);
  return { jobs };
};

test("only a successful newer write to the same destination supersedes main publication", async () => {
  assert.equal(
    await isPublicationFresh(
      env,
      mock([{ name: "publish", steps: [{ name: "write", conclusion: "success" }] }]),
    ),
    false,
  );
  for (const jobs of [
    [],
    [{ name: "publish", steps: [{ name: "write", conclusion: "failure" }] }],
    [{ name: "other destination", steps: [{ name: "write", conclusion: "success" }] }],
    [
      {
        name: "publish",
        steps: [
          { name: "freshness", conclusion: "success" },
          { name: "write", conclusion: "skipped" },
        ],
      },
    ],
  ]) {
    assert.equal(await isPublicationFresh(env, mock(jobs)), true);
  }
});

test("explicit dispatch, release tags and previews preserve their publication policy", async () => {
  for (const input of [
    { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" },
    { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/tags/v1.0.0" },
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" },
  ])
    assert.equal(await isPublicationFresh(input, () => assert.fail("unexpected API call")), true);
});

test("API failures and malformed responses fail closed", async () => {
  await assert.rejects(
    isPublicationFresh(env, async () => {
      throw new Error("unavailable");
    }),
    /unavailable/,
  );
  await assert.rejects(
    isPublicationFresh(env, async () => ({})),
    /missing run number/,
  );
});

test("checks later job pages and workflow pages before allowing publication", async () => {
  const api = async (path) => {
    if (path.endsWith("/runs/1")) return { run_number: 10 };
    if (path.includes("/workflows/")) {
      if (path.endsWith("page=1"))
        return {
          workflow_runs: Array.from({ length: 100 }, (_, index) => ({
            id: index + 100,
            run_number: index + 100,
          })),
        };
      return {
        workflow_runs: [
          { id: 2, run_number: 11 },
          { id: 1, run_number: 10 },
        ],
      };
    }
    if (path.includes("/runs/2/jobs")) {
      if (path.endsWith("page=1"))
        return { jobs: Array.from({ length: 100 }, () => ({ name: "other" })) };
      return { jobs: [{ name: "publish", steps: [{ name: "write", conclusion: "success" }] }] };
    }
    return { jobs: [] };
  };
  assert.equal(await isPublicationFresh(env, api), false);
});
