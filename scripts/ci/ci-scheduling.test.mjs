import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const job = (name) => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [\w-]+:\n/u)[0];
const evaluate = (
  expression,
  { webapp = false, preview = false, firstParty = true, dependabot = false } = {},
) => {
  expression = expression.replaceAll("github.event.pull_request.labels.*.name", "labels");
  return runInNewContext(expression, {
    contains: (items, item) => items.includes(item),
    labels: preview ? ["preview"] : [],
    github: {
      event_name: "pull_request",
      repository: "owner/repo",
      event: {
        pull_request: {
          head: { repo: { full_name: firstParty ? "owner/repo" : "fork/repo" } },
          user: { login: dependabot ? "dependabot[bot]" : "person" },
        },
      },
    },
    needs: { changes: { outputs: { webapp: String(webapp) } } },
  });
};

test("preview opt-in and validation use the same WASM selection", () => {
  const condition = job("wasm")
    .match(/    if: >-\n([\s\S]*?)\n    env:/u)[1]
    .trim();
  const aggregate = job("plumbing").match(/WASM_SELECTED: \$\{\{ (.*) \}\}/u)[1];
  for (const [options, expected] of [
    [{}, false],
    [{ preview: true }, true],
    [{ webapp: true }, true],
    [{ preview: true, firstParty: false }, false],
    [{ preview: true, dependabot: true }, false],
    [{ webapp: true, firstParty: false }, true],
  ]) {
    assert.equal(evaluate(condition, options), expected);
    assert.equal(evaluate(aggregate, options), expected);
  }
});

test("main validation shares a group without cancelling active runs", () => {
  const concurrency = workflow.split("\nconcurrency:\n")[1].split("\njobs:\n")[0];
  const group = concurrency.match(/group: ci-\$\{\{ (.*) \}\}/u)[1];
  const cancel = concurrency.match(/cancel-in-progress: \$\{\{ (.*) \}\}/u)[1];
  const evaluateConcurrency = (ref, event, runId) => {
    const context = { github: { ref, event_name: event, run_id: runId } };
    return {
      group: runInNewContext(group, context),
      cancel: runInNewContext(cancel, context),
    };
  };
  const main = evaluateConcurrency("refs/heads/main", "push", 1);
  assert.deepEqual(main, { group: "refs/heads/main", cancel: false });
  assert.deepEqual(evaluateConcurrency("refs/heads/main", "push", 2), main);
  assert.deepEqual(evaluateConcurrency("refs/heads/main", "workflow_dispatch", 3), main);
  assert.deepEqual(evaluateConcurrency("refs/heads/main", "schedule", 4), {
    group: "nightly",
    cancel: false,
  });
  assert.deepEqual(evaluateConcurrency("refs/pull/1/merge", "pull_request", 5), {
    group: "refs/pull/1/merge",
    cancel: true,
  });
  assert.notEqual(
    evaluateConcurrency("refs/pull/2/merge", "pull_request", 6).group,
    evaluateConcurrency("refs/pull/1/merge", "pull_request", 5).group,
  );
});

test("publishers serialize and guard writes", () => {
  for (const name of ["docker-nightly", "docker-prebuilt-nightly", "deploy"]) {
    const body = job(name);
    assert.match(body, /concurrency:\n      group: publish-/u);
    assert.match(body, /cancel-in-progress: false/u);
    const steps = body.split(/(?=^      - )/mu).slice(1);
    assert.match(steps[1], /id: freshness/u);
    for (const step of steps.slice(2))
      assert.match(step, /if: .*steps.freshness.outputs.fresh == 'true'/u);
  }
});
