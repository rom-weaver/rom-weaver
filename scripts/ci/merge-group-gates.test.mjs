import assert from "node:assert/strict";
import test from "node:test";

import { checkMergeGroupGates } from "./merge-group-gates.mjs";

const repo = "owner/repo";
const group = { head_sha: "queue-two", base_ref: "refs/heads/main" };
const contexts = ["PR Title Lint", "CLA Signed"];
const entry = (number) => ({
  position: number,
  headCommit: { oid: `queue-${number === 2 ? "two" : number}` },
  pullRequest: { number, headRefOid: `pr-${number}`, baseRefName: "main", state: "OPEN" },
});
const success = (context) => ({
  context,
  state: "success",
  creator: { login: "github-actions[bot]" },
});

async function run({
  nodes = [entry(1), entry(2), entry(3)],
  hasNextPage = false,
  statuses = () => contexts.map(success),
  errors,
} = {}) {
  const posted = [];
  const read = [];
  const promise = checkMergeGroupGates({
    repo,
    group,
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    api: async (path, options) => {
      if (path === "/graphql") {
        assert.deepEqual(options.body.variables, { owner: "owner", name: "repo", branch: "main" });
        return {
          errors,
          data: { repository: { mergeQueue: { entries: { nodes, pageInfo: { hasNextPage } } } } },
        };
      }
      assert.equal(path, `/repos/${repo}/statuses/${group.head_sha}`);
      posted.push(options.body);
    },
    paginate: async (path) => {
      read.push(path);
      return statuses(path);
    },
  });
  return { promise, posted, read };
}

test("checks each included PR head, excludes later entries, and posts both required group statuses", async () => {
  const result = await run();
  await result.promise;
  assert.deepEqual(result.read, [
    "/repos/owner/repo/commits/pr-1/statuses",
    "/repos/owner/repo/commits/pr-2/statuses",
  ]);
  assert.deepEqual(
    result.posted.map(({ context, state }) => [context, state]),
    [
      [contexts[0], "pending"],
      [contexts[1], "pending"],
      [contexts[0], "success"],
      [contexts[1], "success"],
    ],
  );
});

for (const [name, options] of [
  ["missing queue entry", { nodes: [entry(1)] }],
  ["incomplete queue", { hasNextPage: true }],
  ["GraphQL error", { errors: [{ message: "Forbidden" }] }],
  [
    "closed PR",
    { nodes: [{ ...entry(2), pullRequest: { ...entry(2).pullRequest, state: "CLOSED" } }] },
  ],
  [
    "different target branch",
    { nodes: [{ ...entry(2), pullRequest: { ...entry(2).pullRequest, baseRefName: "other" } }] },
  ],
  ["missing status", { statuses: () => [success(contexts[0])] }],
  [
    "pending status",
    { statuses: () => [{ ...success(contexts[0]), state: "pending" }, success(contexts[1])] },
  ],
  [
    "newer failure before stale success",
    { statuses: () => [{ ...success(contexts[0]), state: "failure" }, ...contexts.map(success)] },
  ],
  [
    "status from an untrusted actor",
    {
      statuses: () =>
        contexts.map((context) => ({ ...success(context), creator: { login: "contributor" } })),
    },
  ],
  [
    "failed gate on earlier PR",
    { statuses: (path) => (path.includes("pr-1") ? [] : contexts.map(success)) },
  ],
]) {
  test(`fails both group statuses for ${name}`, async () => {
    const result = await run(options);
    await assert.rejects(result.promise);
    assert.deepEqual(
      result.posted.slice(-2).map(({ context, state }) => [context, state]),
      contexts.map((context) => [context, "failure"]),
    );
  });
}
