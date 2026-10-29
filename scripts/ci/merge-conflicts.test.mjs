import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../.github/workflows/merge-conflicts.yml", import.meta.url), "utf8");
const script = workflow.split("          script: |\n")[1].replace(/^ {12}/gm, "");
const repository = { owner: "base-owner", repo: "base-repo" };
const makePr = (number = 1, overrides = {}) => ({
  number,
  state: "open",
  head: { sha: `head-${number}`, repo: { owner: { login: "fork-owner" }, name: "fork-repo" } },
  base: { ref: "release/next" },
  mergeable: true,
  ...overrides,
});

async function run({ event = "pull_request_target", seed = makePr(), pages = [[seed]], get = () => seed, post, ref = "refs/heads/release/next" } = {}) {
  const statuses = [];
  const reads = [];
  const lists = [];
  const delays = [];
  const failures = [];
  const warnings = [];
  const messages = [];
  const list = Symbol("pulls.list");
  const context = {
    repo: repository,
    eventName: event,
    payload: { pull_request: seed },
    ref,
    serverUrl: "https://github.example",
    runId: 123,
  };
  await runInNewContext(`(async () => {${script}\n})()`, {
    context,
    github: {
      rest: {
        pulls: {
          list,
          get: async args => {
            reads.push(args);
            return { data: await get(args, reads.length) };
          },
        },
        repos: {
          createCommitStatus: async args => {
            statuses.push(args);
            await post?.(args);
          },
        },
      },
      paginate: {
        async *iterator(endpoint, args) {
          assert.equal(endpoint, list);
          lists.push(args);
          for (const data of pages) {
            if (data instanceof Error) throw data;
            yield { data };
          }
        },
      },
    },
    core: {
      setFailed: message => failures.push(message),
      warning: message => warnings.push(message),
      error: message => messages.push(message),
      info: message => messages.push(message),
    },
    setTimeout: (resolve, milliseconds) => {
      delays.push(milliseconds);
      resolve();
    },
  });
  return { statuses, reads, lists, delays, failures, warnings, messages };
}

test("triggers cover retargeting and every base branch without checking out PR code", () => {
  assert.match(workflow, /pull_request_target:\n    types: \[opened, reopened, synchronize, edited\]/);
  assert.match(workflow, /push:\n    branches: \["\*\*"\]/);
  assert.match(workflow, /github\.event\.changes\.base != null/);
  assert.match(workflow, /!github\.event\.deleted/);
  assert.match(workflow, /permissions:\n  pull-requests: read\n  statuses: write/);
  assert.match(workflow, /uses: actions\/github-script@v9/);
  assert.match(workflow, /retries: 2/);
  assert.match(workflow, /retry-exempt-status-codes: 400,401,403,404,422,429/);
  assert.doesNotMatch(workflow, /actions\/checkout|\brun:|contents: write|pull-requests: write/);
  assert.doesNotMatch(script, /\$\{\{/);
});

for (const [mergeable, state, description] of [
  [true, "success", "No merge conflicts"],
  [false, "failure", "Merge conflicts detected"],
]) {
  test(`a fork PR with mergeable=${mergeable} publishes ${state} on its head in the base repository`, async () => {
    const result = await run({ seed: makePr(1, { mergeable }) });
    assert.deepEqual(result.statuses.map(status => status.state), ["pending", state]);
    assert.equal(result.statuses[1].description, description);
    for (const status of result.statuses) {
      assert.equal(status.owner, repository.owner);
      assert.equal(status.repo, repository.repo);
      assert.equal(status.sha, "head-1");
      assert.equal(status.context, "Merge Conflict Check");
      assert.equal(status.target_url, "https://github.example/base-owner/base-repo/actions/runs/123");
    }
    assert.equal(result.reads.length, 1);
    assert.equal(result.lists.length, 0);
    assert.equal(result.delays.length, 0);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.messages, [`PR #1: ${state} (${description})`]);
  });
}

test("unknown mergeability retries briefly and publishes a resolved conflict without duplicate pending statuses", async () => {
  const result = await run({ get: (_args, attempt) => makePr(1, { mergeable: attempt < 3 ? null : false }) });
  assert.equal(result.reads.length, 3);
  assert.deepEqual(result.delays, [3000, 3000]);
  assert.deepEqual(result.statuses.map(status => status.state), ["pending", "failure"]);
});

test("unknown mergeability remains pending after five reads and four delays", async () => {
  const result = await run({ seed: makePr(1, { mergeable: null }) });
  assert.equal(result.reads.length, 5);
  assert.deepEqual(result.delays, [3000, 3000, 3000, 3000]);
  assert.deepEqual(result.statuses.map(status => status.state), ["pending"]);
  assert.equal(result.statuses[0].description, "GitHub hasn't determined mergeability yet");
  assert.match(result.warnings[0], /unknown after 5 attempts/);
});

test("a new head during retries receives its own pending and final status", async () => {
  const result = await run({ get: (_args, attempt) => makePr(1, {
    head: { sha: "new-head" }, mergeable: attempt < 2 ? null : true,
  }) });
  assert.deepEqual(result.statuses.map(status => [status.sha, status.state]), [
    ["head-1", "pending"], ["new-head", "pending"], ["new-head", "success"],
  ]);
});

test("pushes paginate only affected open PRs, including non-default base branches", async () => {
  const result = await run({ event: "push", pages: [[makePr(1)], [makePr(2)]],
    get: args => makePr(args.pull_number, { mergeable: args.pull_number === 1 }),
  });
  assert.equal(result.lists.length, 1);
  assert.equal(result.lists[0].base, "release/next");
  assert.equal(result.lists[0].state, "open");
  assert.equal(result.lists[0].per_page, 100);
  assert.deepEqual(result.reads.map(args => args.pull_number), [1, 2]);
  assert.deepEqual(result.statuses.map(status => status.state), ["pending", "success", "pending", "failure"]);
});

test("base pushes re-evaluate the same head after a clean verdict becomes conflicting", async () => {
  const clean = await run();
  const conflict = await run({ event: "push", get: () => makePr(1, { mergeable: false }) });
  assert.equal(clean.statuses.at(-1).sha, conflict.statuses.at(-1).sha);
  assert.equal(clean.statuses.at(-1).state, "success");
  assert.equal(conflict.statuses.at(-1).state, "failure");
});

test("retargeted PR events use live mergeability rather than the event snapshot", async () => {
  const result = await run({ get: () => makePr(1, { base: { ref: "other-base" }, mergeable: false }) });
  assert.equal(result.statuses.at(-1).state, "failure");
});

test("PRs closed or retargeted during a push sweep get no obsolete verdict", async () => {
  for (const overrides of [{ state: "closed" }, { base: { ref: "elsewhere" } }]) {
    const result = await run({ event: "push", get: () => makePr(1, overrides) });
    assert.deepEqual(result.statuses.map(status => status.state), ["pending"]);
  }
});

test("pushes without affected PRs do no detail reads or status writes", async () => {
  const result = await run({ event: "push", pages: [[]] });
  assert.deepEqual(result.reads, []);
  assert.deepEqual(result.statuses, []);
});

test("an API error leaves pending, fails the run, and does not prevent checking other PRs", async () => {
  const result = await run({ event: "push", pages: [[makePr(1), makePr(2)]], get: args => {
    if (args.pull_number === 1) throw new Error("GitHub unavailable");
    return makePr(2);
  } });
  assert.deepEqual(result.failures, ["GitHub unavailable"]);
  assert.deepEqual(result.statuses.map(status => [status.sha, status.state]), [
    ["head-1", "pending"], ["head-2", "pending"], ["head-2", "success"],
  ]);
});

test("fork status permission errors fail visibly without writing to the fork", async () => {
  const result = await run({ post: () => { throw Object.assign(new Error("Resource not accessible by integration"), { status: 403 }); } });
  assert.deepEqual(result.failures, ["Resource not accessible by integration"]);
  assert.equal(result.reads.length, 0);
  assert.equal(result.statuses[0].owner, repository.owner);
});

test("rate limits stop the sweep and report GitHub's retry guidance", async () => {
  for (const status of [403, 429]) {
    const result = await run({ event: "push", pages: [[makePr(1), makePr(2)]], get: () => {
      throw Object.assign(new Error("API rate limit exceeded"), {
        status, response: { headers: { "retry-after": "60", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1234567890" } },
      });
    } });
    assert.equal(result.reads.length, 1);
    assert.equal(result.statuses.length, 1);
    assert.equal(result.failures.length, 1);
    assert.match(result.warnings[0], /Retry-After=60 seconds/);
    assert.match(result.warnings[0], /X-RateLimit-Reset=1234567890/);
  }
});

test("pagination errors fail the run after preserving completed results", async () => {
  const result = await run({ event: "push", pages: [[makePr(1)], new Error("Page unavailable")] });
  assert.equal(result.statuses.at(-1).state, "success");
  assert.deepEqual(result.failures, ["Page unavailable"]);
});

test("a thousand PRs need only one detail read and two status writes each", async () => {
  const prs = Array.from({ length: 1000 }, (_value, index) => makePr(index + 1));
  const pages = Array.from({ length: 10 }, (_value, index) => prs.slice(index * 100, (index + 1) * 100));
  const result = await run({ event: "push", pages, get: args => prs[args.pull_number - 1] });
  assert.equal(result.reads.length, 1000);
  assert.equal(result.statuses.length, 2000);
  assert.deepEqual(result.failures, []);
});
