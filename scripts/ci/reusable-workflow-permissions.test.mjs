import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const directory = new URL("../../.github/workflows/", import.meta.url);
const workflows = Object.fromEntries(
  readdirSync(directory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => [name, load(readFileSync(new URL(name, directory), "utf8"))]),
);

const LEVEL = { none: 0, read: 1, write: 2 };

// GitHub rejects a whole run at startup when any job of a called workflow, including one its `if`
// would skip, asks for a permission its caller does not grant. actionlint does not check this.
test("every reusable workflow caller grants what each called job asks for", () => {
  let checked = 0;
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const match = typeof job.uses === "string" && job.uses.match(/^\.\/\.github\/workflows\/(.+)$/u);
      if (!match) continue;
      const granted = job.permissions ?? workflow.permissions;
      // Without an explicit grant the caller passes the repository default, which nothing here can
      // see, so every call must grant explicitly.
      assert.ok(granted !== undefined, `${name} ${jobName} calls ${match[1]} without a permissions block`);
      const called = workflows[match[1]];
      assert.ok(called, `${name} ${jobName} calls a missing ${match[1]}`);
      for (const [calledName, calledJob] of Object.entries(called.jobs)) {
        const asked = calledJob.permissions ?? called.permissions ?? {};
        assert.equal(typeof asked, "object", `${match[1]} ${calledName} names each permission it needs`);
        for (const [scope, level] of Object.entries(asked)) {
          const have = typeof granted === "string" ? granted.replace("-all", "") : (granted[scope] ?? "none");
          assert.ok(
            LEVEL[have] >= LEVEL[level],
            `${name} ${jobName} grants ${scope}: ${have}, but ${match[1]} ${calledName} asks for ${level}`,
          );
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, "no reusable workflow calls were checked");
});
