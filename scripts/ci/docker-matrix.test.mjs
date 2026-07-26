import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./docker-matrix.mjs", import.meta.url));

const plan = (env) => JSON.parse(execFileSync(process.execPath, [script], { env: { ...process.env, ...env }, encoding: "utf8" }).match(/\[[^\n]+\]/)[0]);

test("ordinary PRs keep the CLI prebuilt smoke without source image builds", () => {
  assert.deepEqual(plan({ CLI_SELECTED: "true", WEBAPP_SELECTED: "true", SOURCE_BUILD: "false" }), [
    { name: "CLI", image: "rom-weaver-cli", file: "Dockerfile", source: false },
  ]);
});

test("Docker source inputs retain both source image legs", () => {
  assert.deepEqual(plan({ CLI_SELECTED: "true", WEBAPP_SELECTED: "true", SOURCE_BUILD: "true" }), [
    { name: "CLI", image: "rom-weaver-cli", file: "Dockerfile", source: true },
    { name: "webapp", image: "rom-weaver-webapp", file: "packages/rom-weaver-webapp/Dockerfile", source: true },
  ]);
});

test("main builds both source image legs", () => {
  assert.deepEqual(plan({ CLI_SELECTED: "false", WEBAPP_SELECTED: "false", FULL_BUILD: "true" }), [
    { name: "CLI", image: "rom-weaver-cli", file: "Dockerfile", source: true },
    { name: "webapp", image: "rom-weaver-webapp", file: "packages/rom-weaver-webapp/Dockerfile", source: true },
  ]);
});
