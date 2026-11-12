import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { A11Y_STEP, planPrePush, PRODUCTION_BUNDLE_STEPS, pushedCommits, WEBAPP_BUNDLE_STEPS } from "./pre-push.mjs";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const ZERO = "0".repeat(40);

test("pushed commits come from git's stdin lines, without deletions", () => {
  const stdin = [
    `refs/heads/feat ${HEAD} refs/heads/feat ${ZERO}`,
    `(delete) ${ZERO} refs/heads/gone ${OTHER}`,
    "",
    "garbage",
  ].join("\n");
  assert.deepEqual(pushedCommits(stdin), { refs: 2, commits: [HEAD] });
  assert.deepEqual(pushedCommits(""), { refs: 0, commits: [] });
});

test("webapp and published-doc changes run the bundle checks", () => {
  for (const path of ["packages/rom-weaver-webapp/src/app.tsx", "crates/rom-weaver-core/src/lib.rs"]) {
    const plan = planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: [path] });
    assert.deepEqual(plan.steps, WEBAPP_BUNDLE_STEPS, path);
  }
});

test("the production WASM build is opt-in and replaces only the WASM step", () => {
  const pushed = { refs: 1, commits: [HEAD] };
  const changedPaths = ["crates/rom-weaver-core/src/lib.rs"];
  assert.deepEqual(planPrePush({ pushed, head: HEAD, changedPaths }).steps[0].args, ["run", "build-wasm-fast"]);
  const plan = planPrePush({ pushed, head: HEAD, changedPaths, productionWasm: true });
  assert.deepEqual(plan.steps, PRODUCTION_BUNDLE_STEPS);
  assert.deepEqual(plan.steps[0].args, ["run", "build-wasm-prod"]);
  assert.deepEqual(plan.steps.slice(1), WEBAPP_BUNDLE_STEPS.slice(1));
});

test("changes CI's webapp build ignores skip the checks", () => {
  const plan = planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: ["docs/development/commits.md"] });
  assert.deepEqual(plan.steps, []);
  assert.match(plan.reason, /no webapp/);
  assert.deepEqual(planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: [] }).steps, []);
});

test("the browser reminder follows CI's pull-request selection", () => {
  const pushed = { refs: 1, commits: [HEAD] };
  const docs = planPrePush({ pushed, head: HEAD, changedPaths: ["docs/faq.md"], e2e: true });
  assert.deepEqual(docs.steps, WEBAPP_BUNDLE_STEPS);
  assert.equal(docs.browser, false);
  assert.equal(planPrePush({ pushed, head: HEAD, changedPaths: ["packages/rom-weaver-webapp/src/app.tsx"] }).browser, true);
});

test("an unresolved base runs every check", () => {
  assert.deepEqual(planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths: undefined }).steps, WEBAPP_BUNDLE_STEPS);
});

test("pushes the working tree cannot represent skip the checks", () => {
  const webapp = ["packages/rom-weaver-webapp/src/app.tsx"];
  assert.match(planPrePush({ pushed: { refs: 1, commits: [] }, head: HEAD, changedPaths: webapp }).reason, /deletes/);
  assert.match(planPrePush({ pushed: pushedCommits("garbage\n"), head: HEAD, changedPaths: webapp }).reason, /no pushed refs/);
  assert.match(planPrePush({ pushed: { refs: 1, commits: [OTHER] }, head: HEAD, changedPaths: webapp }).reason, /HEAD is not/);
  assert.deepEqual(planPrePush({ pushed: { refs: 2, commits: [OTHER, HEAD] }, head: HEAD, changedPaths: webapp }).steps, WEBAPP_BUNDLE_STEPS);
});

test("accessibility E2E is opt-in and reuses the checked bundle", () => {
  const changedPaths = ["packages/rom-weaver-webapp/src/app.tsx"];
  const plan = planPrePush({ pushed: { refs: 1, commits: [HEAD] }, head: HEAD, changedPaths, e2e: true });
  assert.equal(plan.browser, true);
  assert.deepEqual(plan.steps, [...WEBAPP_BUNDLE_STEPS, A11Y_STEP]);
  assert.equal(A11Y_STEP.env.ROM_WEAVER_E2E_USE_PREBUILT_DIST, "1");
  assert.equal(A11Y_STEP.env.ROM_WEAVER_CHANNEL, WEBAPP_BUNDLE_STEPS[1].env.ROM_WEAVER_CHANNEL);
});

test("the Windows hook runs npm's JavaScript entrypoint with the production bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "rom-weaver hook ; "));
  try {
    const calls = join(dir, "calls.jsonl");
    const cli = join(dir, "npm-cli.js");
    const preload = join(dir, "preload.mjs");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
    writeFileSync(cli, `require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), channel: process.env.ROM_WEAVER_CHANNEL, prebuilt: process.env.ROM_WEAVER_E2E_USE_PREBUILT_DIST }) + "\\n");`);
    writeFileSync(preload, `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      Object.defineProperty(process, "platform", { value: "win32" });
      const original = childProcess.execFileSync;
      childProcess.execFileSync = (command, args, options) => {
        if (command === "git") {
          if (args[0] === "rev-parse" && args[1] === "HEAD") return ${JSON.stringify(HEAD)};
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ${JSON.stringify(dir)};
          if (args[0] === "diff") return "packages/rom-weaver-webapp/src/app.tsx";
          if (args[0] === "status") return "";
          return ${JSON.stringify(OTHER)};
        }
        if (command === "mise") return;
        if (command === "npm") throw new Error("batch wrapper cannot be executed directly");
        return original(command, args, options);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("./pre-push.mjs", import.meta.url)), "origin"], {
      encoding: "utf8",
      input: `refs/heads/feat ${HEAD} refs/heads/feat ${ZERO}\n`,
      env: { ...process.env, HOME: dir, XDG_CACHE_HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, npm_execpath: cli, ROM_WEAVER_PRE_PUSH_E2E: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(observed.map((call) => call.args), [
      ["--prefix", "packages/rom-weaver-webapp", "run", "build"],
      ["--prefix", "packages/rom-weaver-webapp", "run", "check:worker-chunk"],
      ["--prefix", "packages/rom-weaver-webapp", "run", "test:e2e:a11y"],
    ]);
    assert.equal(observed[0].channel, "prod");
    assert.equal(observed[2].channel, "prod");
    assert.equal(observed[2].prebuilt, "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
