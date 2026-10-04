import assert from "node:assert/strict";
import test from "node:test";

import { runCi } from "./run-ci.mjs";

test("local CI measures one production build before browser checks and reuses it for E2E", () => {
  const calls = [];
  runCi((args, environment) => calls.push({ task: args.at(-1), environment }));
  const tasks = calls.map(({ task }) => task);
  const build = tasks.indexOf("build");
  const size = tasks.indexOf("check:size");
  assert.equal(tasks.filter((task) => task === "build").length, 1);
  assert.ok(build >= 0 && size === build + 1);
  for (const task of ["test:browser:wasm", "test:browser", "test:e2e:webapp"]) {
    assert.ok(tasks.indexOf(task) > size, `${task} must wait for the size gate`);
  }
  assert.deepEqual(calls[build].environment, { ROM_WEAVER_CHANNEL: "prod" });
  assert.deepEqual(calls.find(({ task }) => task === "test:e2e:webapp").environment, {
    ROM_WEAVER_CHANNEL: "prod",
    ROM_WEAVER_E2E_USE_PREBUILT_DIST: "1",
  });
  for (const task of ["lint", "test", "test:scripts", "test:unit"]) {
    assert.ok(
      tasks.indexOf(task) >= 0 && tasks.indexOf(task) < build,
      `${task} must run before the build`,
    );
  }
});

for (const failedTask of ["test:scripts", "build", "check:size"]) {
  test(`a failed ${failedTask} stops local CI before browser checks`, () => {
    const tasks = [];
    const failure = new Error(`${failedTask} failed`);
    assert.throws(
      () =>
        runCi((args) => {
          const task = args.at(-1);
          tasks.push(task);
          if (task === failedTask) throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(tasks.at(-1), failedTask);
    assert.ok(!tasks.includes("test:browser:wasm"));
    assert.ok(!tasks.includes("test:browser"));
    assert.ok(!tasks.includes("test:e2e:webapp"));
  });
}
