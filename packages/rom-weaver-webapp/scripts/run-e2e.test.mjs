import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runE2EProfile } from "./run-e2e.mjs";

const recordingRunner = (calls, failedName) => async (name, command, args, cwd, environment) => {
  calls.push({ args, command, cwd, environment, name });
  return { code: name === failedName ? 1 : 0, durationMs: 1, name };
};

test("fast regression builds and checks production assets before running either browser suite", async () => {
  const calls = [];
  const environment = { ROM_WEAVER_CHANNEL: "dev", TEST_MARKER: "preserved" };
  const report = await runE2EProfile("fast", recordingRunner(calls), environment);

  assert.deepEqual(
    calls.slice(0, 3).map(({ args }) => args),
    [
      ["run", "build-wasm-prod"],
      ["run", "build"],
      ["run", "check:size"],
    ],
  );
  assert.deepEqual(
    calls
      .slice(3)
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right)),
    ["browser", "CLI", "WASM", "webapp E2E"],
  );
  assert.equal(calls.filter(({ args }) => args.includes("build")).length, 1);
  for (const call of calls) {
    assert.equal(call.environment.ROM_WEAVER_CHANNEL, "prod");
    assert.equal(call.environment.TEST_MARKER, "preserved");
  }
  assert.equal(calls.find(({ name }) => name === "webapp E2E").environment.ROM_WEAVER_E2E_USE_PREBUILT_DIST, "1");
  assert.equal(environment.ROM_WEAVER_CHANNEL, "dev");
  assert.equal(report.results.length, calls.length);
  assert.ok(report.durationMs >= 0);
});

test("nightly retains its development module and exhaustive coverage", async () => {
  const calls = [];
  await runE2EProfile("nightly", recordingRunner(calls), {});
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      ["run", "build-wasm"],
      ["test", "-p", "rom-weaver-cli", "--test", "integration", "cli_smoke::"],
      ["run", "test:browser:wasm:exhaustive"],
      ["run", "test:e2e:webapp"],
    ],
  );
  assert.equal(calls.at(-1).environment.ROM_WEAVER_E2E_USE_PREBUILT_DIST, undefined);
});

test("reusing WASM still prepares identify data, rebuilds the webapp, and checks sizes", async () => {
  const calls = [];
  await runE2EProfile("fast", recordingRunner(calls), { ROM_WEAVER_E2E_SKIP_WASM_BUILD: "1" });
  assert.equal(calls[0].command, "node");
  assert.deepEqual(calls[0].args, ["scripts/ensure-identify-data.mjs"]);
  assert.deepEqual(calls[1].args, ["run", "build"]);
  assert.deepEqual(calls[2].args, ["run", "check:size"]);
});

test("failed build and size gates prevent tests from passing against old assets", async () => {
  for (const [failedName, count] of [
    ["WASM build", 1],
    ["production webapp build", 2],
    ["asset size budgets", 3],
  ]) {
    const calls = [];
    const report = await runE2EProfile("fast", recordingRunner(calls, failedName), {});
    assert.equal(calls.length, count, failedName);
    assert.equal(report.results.at(-1).code, 1, failedName);
    assert.equal(report.results.at(-1).name, failedName);
  }
});

test("a failed CLI lane remains failed after the other regression lanes finish", async () => {
  const calls = [];
  const report = await runE2EProfile("fast", recordingRunner(calls, "CLI"), {});
  assert.equal(calls.length, 7);
  assert.deepEqual(
    report.results.filter(({ code }) => code !== 0).map(({ name }) => name),
    ["CLI"],
  );
  assert.equal(report.results.at(-1).code, 0);
});

test("unknown profiles fail before running any commands", async () => {
  const calls = [];
  await assert.rejects(runE2EProfile("unknown", recordingRunner(calls), {}), /unknown E2E profile: unknown/);
  assert.deepEqual(calls, []);
});

test("the command reports invalid profiles with a failing exit status", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./run-e2e.mjs", import.meta.url)), "unknown"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown E2E profile: unknown/);
});
