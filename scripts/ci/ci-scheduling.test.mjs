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

test("main validation has a unique run group and publishers serialize and guard writes", () => {
  assert.match(workflow, /group: ci-.*github.run_id/u);
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
