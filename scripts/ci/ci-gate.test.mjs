import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const ci = load(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const gate = ci.jobs.gate;
const expression = (value) =>
  String(value)
    .replace(/^\$\{\{\s*/u, "")
    .replace(/\s*\}\}$/u, "");

// Publishers and deploys are deliberately non-gating, `quality-analysis` is
// advisory, and the advisory scan reports warnings only.
const NON_GATING = new Set([
  "gate",
  "deploy",
  "deploy-preview-fast",
  "docker-nightly",
  "docker-prebuilt-nightly",
  "quality-analysis",
  "security",
]);

// Every `name=${{ needs.<job>... }}` pair a gate step asserts, with the
// expression it passes as that group's selection flag.
const assertedGroups = () =>
  gate.steps
    .filter((step) => step.run?.startsWith("node scripts/ci/assert-jobs.mjs"))
    .map((step) => {
      // Arguments are single-quoted and space-separated; a flag expression may
      // itself contain quoted literals, never a quote-space-quote.
      const args = step.run
        .trim()
        .replace(/^[^']*'/u, "")
        .replace(/'$/u, "")
        .split("' '");
      return {
        name: step.name,
        selected: args[1],
        jobs: args.slice(2).map((pair) => pair.match(/\$\{\{ needs\.([\w-]+)\./u)[1]),
      };
    });

test("the gate waits for every gating job and checks each one", () => {
  const gating = Object.keys(ci.jobs).filter((name) => !NON_GATING.has(name));
  assert.deepEqual([...gate.needs].sort(), gating.sort());
  const checked = new Set(
    gate.steps.flatMap((step) =>
      [
        ...JSON.stringify(step).matchAll(/needs\.([\w-]+)\.(?:result|outputs\.(?:bundle|size))/gu),
      ].map(([, job]) => job),
    ),
  );
  for (const job of gate.needs) assert.ok(checked.has(job), `${job} is not asserted by the gate`);
});

test("each asserted group shares its selection flags with the jobs' own conditions", () => {
  const groups = assertedGroups();
  assert.ok(groups.length >= 7, "expected one assert-jobs step per selection flag");
  for (const { name, selected, jobs } of groups) {
    const flags = [...selected.matchAll(/needs\.[\w-]+\.outputs\.\w+/gu)].map(([flag]) => flag);
    for (const job of jobs) {
      if (job === "changes") continue;
      const condition = expression(ci.jobs[job].if ?? "");
      for (const flag of flags)
        assert.ok(condition.includes(flag), `${name}: ${job} must be selected by ${flag}`);
    }
  }
  const browser = groups.find(({ jobs }) => jobs.includes("webapp-browser"));
  assert.equal(browser.selected, "${{ needs.changes.outputs.webapp_browser }}");
  assert.deepEqual(browser.jobs.sort(), ["webapp-browser", "webapp-webkit-e2e"]);
  const lint = groups.find(({ jobs }) => jobs.includes("rust-lint"));
  assert.equal(lint.selected, "${{ needs.changes.outputs.rust_lint }}");
  assert.deepEqual(lint.jobs, ["rust-lint"]);
});

test("every gate step reports on its own, but never on a cancelled run", () => {
  assert.match(expression(gate.if), /^!cancelled\(\)/u);
  for (const step of gate.steps.slice(1))
    assert.match(expression(step.if ?? ""), /^!cancelled\(\)/u, step.name);
});

const labelContext = (eventName, action, label) => ({
  cancelled: () => false,
  format: (template, ...values) =>
    template.replace(/\{(\d+)\}/gu, (_, index) => String(values[index])),
  github: {
    event_name: eventName,
    ref: "refs/pull/1/merge",
    ref_type: "branch",
    run_id: 9,
    event: { action, label: label === undefined ? undefined : { name: label } },
  },
});

test("only the preview label starts a real run", () => {
  assert.ok(!ci.on.pull_request.types.includes("unlabeled"));
  assert.ok(ci.on.pull_request.types.includes("labeled"));
  for (const [eventName, action, label, real] of [
    ["pull_request", "synchronize", undefined, true],
    ["pull_request", "opened", undefined, true],
    ["pull_request", "labeled", "preview", true],
    ["pull_request", "labeled", "bug", false],
    ["pull_request", "labeled", "dependencies", false],
    ["push", undefined, undefined, true],
    ["schedule", undefined, undefined, true],
  ]) {
    const context = labelContext(eventName, action, label);
    const evaluate = (value) => runInNewContext(expression(value), context);
    const caseName = `${eventName} ${action} ${label}`;
    assert.equal(evaluate(ci.jobs.changes.if), real, caseName);
    assert.equal(evaluate(gate.if), real, caseName);
    // A skipped job reports success, so an ignored run's gate MUST NOT carry
    // the required name the real run reports on the same commit.
    assert.equal(evaluate(gate.name) === "CI gate", real, caseName);
  }
});

test("pull requests skip Lighthouse only through the shared classifier flag", () => {
  const steps = ci.jobs["webapp-static"].steps;
  const condition =
    "github.event_name != 'pull_request' || needs.changes.outputs.lighthouse == 'true'";
  for (const [name, wanted] of [
    ["Download webapp bundle", condition],
    ["Lighthouse gates", condition],
    ["Upload Lighthouse reports", `!cancelled() && (${condition})`],
  ]) {
    assert.equal(expression(steps.find((step) => step.name === name).if), wanted, name);
  }
  assert.equal(ci.jobs.changes.outputs.lighthouse, "${{ steps.classify.outputs.lighthouse }}");
});
