import assert from "node:assert/strict";
import test from "node:test";
import { updateAutoMergePrs } from "./update-auto-merge-prs.mjs";

const repo = "rom-weaver/rom-weaver";
const pull = (number, overrides = {}) => ({
  number,
  state: "open",
  draft: false,
  auto_merge: {},
  mergeable: true,
  base: { ref: "main", sha: "base" },
  head: { sha: `head-${number}`, repo: { full_name: repo } },
  ...overrides,
});
function harness(prs, { fresh = {}, comparisons = {}, rejected = [] } = {}) {
  const updates = [];
  const reads = [];
  return {
    updates,
    reads,
    options: {
      repo,
      log: () => {},
      paginate: async (path) => {
        assert.equal(path, `/repos/${repo}/pulls?state=open&base=main`);
        return prs;
      },
      api: async (path, options = {}) => {
        reads.push(path);
        if (path.includes("/compare/")) {
          const number = Number(path.split("head-")[1]);
          return comparisons[number] ?? { behind_by: 1 };
        }
        const number = Number(path.match(/\/pulls\/(\d+)/)[1]);
        if (options.method === "PUT") {
          assert.equal(path, `/repos/${repo}/pulls/${number}/update-branch`);
          if (rejected.includes(number)) throw new Error("422: head changed");
          updates.push({ number, body: options.body });
          return {};
        }
        return fresh[number] ?? prs.find((pr) => pr.number === number);
      },
    },
  };
}

test("updates only opted-in, open, non-draft, same-repository main PRs that are behind", async () => {
  const h = harness(
    [
      pull(1),
      pull(2, { draft: true }),
      pull(3, { auto_merge: null }),
      pull(4, { head: { repo: { full_name: "other/fork" } } }),
      pull(5),
      pull(6),
      pull(7),
    ],
    {
      fresh: { 5: pull(5, { state: "closed" }), 6: pull(6, { base: { ref: "release" } }) },
      comparisons: { 7: { behind_by: 0 } },
    },
  );
  assert.deepEqual(await updateAutoMergePrs(h.options), [1]);
  assert.deepEqual(h.updates, [{ number: 1, body: { expected_head_sha: "head-1" } }]);
});

test("fresh opt-out, draft, and fork states prevent updates", async () => {
  for (const overrides of [{ auto_merge: null }, { draft: true }, { head: { repo: null } }]) {
    const h = harness([pull(1)], { fresh: { 1: pull(1, overrides) } });
    assert.deepEqual(await updateAutoMergePrs(h.options), []);
    assert.deepEqual(h.updates, []);
  }
});

test("conflicts and pending mergeability are left unchanged", async () => {
  const h = harness([pull(1, { mergeable: false }), pull(2, { mergeable: null })]);
  assert.deepEqual(await updateAutoMergePrs(h.options), []);
  assert.deepEqual(h.updates, []);
});

test("dry-run reports eligible PRs without issuing writes", async () => {
  const h = harness([pull(1)]);
  assert.deepEqual(await updateAutoMergePrs({ ...h.options, dryRun: true }), [1]);
  assert.deepEqual(h.updates, []);
});

test("a racing head update is rejected while other eligible PRs still update", async () => {
  const h = harness([pull(1), pull(2)], { rejected: [1] });
  await assert.rejects(updateAutoMergePrs(h.options), /Branch updates failed for PRs: 1/);
  assert.deepEqual(
    h.updates.map((update) => update.number),
    [2],
  );
});
