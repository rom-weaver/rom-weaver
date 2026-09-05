import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ACTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "actions");

// Two composite actions run the identify build independently, with different
// cache keys. Fixing one and not the other is exactly how the node-tar switch
// kept failing, so every action that runs the build is checked, not a named one.
const actionsRunningTheBuild = () =>
  readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: join(ACTIONS_DIR, entry.name, "action.yml") }))
    .flatMap((action) => {
      let body;
      try {
        body = readFileSync(action.path, "utf8");
      } catch {
        return [];
      }
      return body.includes("node scripts/ensure-identify-data.mjs") ? [{ ...action, body }] : [];
    });

test("every action that builds identify data installs its npm dependencies", () => {
  const actions = actionsRunningTheBuild();
  // If this ever reads zero, the check has stopped checking anything.
  assert.ok(actions.length > 0, "no action runs the identify build; the matcher is stale");
  const missing = actions
    .filter((action) => !action.body.includes("npm ci --ignore-scripts"))
    .map((action) => action.name);
  assert.deepEqual(missing, [], `these run the identify build without installing first: ${missing}`);
});

test("the identify build install is gated on a cache miss", () => {
  // A cache hit makes the build a no-op. Installing unconditionally would put
  // an npm ci on every job that only wants the prebuilt packs, including the
  // slow Windows runner.
  for (const action of actionsRunningTheBuild()) {
    const lines = action.body.split("\n");
    const install = lines.findIndex((line) => line.includes("npm ci --ignore-scripts"));
    assert.notEqual(install, -1, `${action.name} has no identify install step`);
    // The step's `if:` sits between its `- name:` and its `run:`.
    const start = lines.slice(0, install).findLastIndex((line) => line.trimStart().startsWith("- name:"));
    const condition = lines.slice(start, install).find((line) => line.trimStart().startsWith("if:"));
    assert.ok(condition, `${action.name}: the identify install step has no condition`);
    assert.match(condition, /cache-hit != 'true'/u, `${action.name}: ${condition.trim()}`);
  }
});

// The composite actions are only half the surface: a workflow job can also
// reach the identify build through `mise run test-rust`, which bypasses the
// actions entirely. `rust-macos` did exactly that and broke on the node-tar
// switch, so the jobs are checked too.
const WORKFLOW = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".github",
  "workflows",
  "ci.yml",
);

test("every job that runs the Rust tests sets up the identify data", () => {
  const body = readFileSync(WORKFLOW, "utf8");
  // Job blocks start at a two-space-indented `<name>:` key.
  const jobs = body.split(/\n(?=  [\w-]+:\n)/u).filter((job) => job.includes("mise run test-rust"));
  assert.ok(jobs.length > 0, "no job runs the Rust tests; the matcher is stale");
  const missing = jobs
    .filter((job) => !(job.includes('identify-data-cache: "true"') && /tools:.*\bnode\b/u.test(job)))
    .map((job) => job.trimStart().split(":", 1)[0]);
  assert.deepEqual(missing, [], `these run the Rust tests without node + the identify packs: ${missing}`);
});
