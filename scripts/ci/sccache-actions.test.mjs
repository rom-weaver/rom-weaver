import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const action = readFileSync(
  new URL("../../.github/actions/setup-build-env/action.yml", import.meta.url),
  "utf8",
);
const steps = action.split(/^    - name: /mu);
const step = (name) => {
  const body = steps.find((entry) => entry.startsWith(`${name}\n`));
  assert.ok(body, `missing setup step: ${name}`);
  return body;
};

const selected = (name, inputs, ref) => {
  const condition = step(name).match(/^      if: (.+)$/mu)?.[1];
  assert.ok(condition, `missing condition: ${name}`);
  return runInNewContext(condition.replaceAll("inputs.cache-save", "inputs.cacheSave"), {
    inputs,
    github: { ref },
  });
};

for (const [name, sccache, cacheSave, ref, saves, restores] of [
  ["main", "true", "true", "refs/heads/main", true, false],
  ["pull request", "true", "true", "refs/pull/7/merge", false, true],
  ["tag", "true", "true", "refs/tags/v0.15.1", false, true],
  ["restore-only main", "true", "false", "refs/heads/main", false, true],
  ["disabled main", "false", "true", "refs/heads/main", false, false],
  ["disabled pull request", "false", "true", "refs/pull/7/merge", false, false],
]) {
  test(`sccache persistence: ${name}`, () => {
    const inputs = { sccache, cacheSave };
    assert.equal(selected("Cache sccache objects", inputs, ref), saves);
    assert.equal(selected("Restore sccache objects", inputs, ref), restores);
    assert.equal(selected("Install sccache", inputs, ref), sccache === "true");
    assert.equal(selected("Zero sccache statistics", inputs, ref), sccache === "true");
  });
}

test("both sccache restore paths use the same store and compatible prefix", () => {
  const paths = [step("Cache sccache objects"), step("Restore sccache objects")];
  const entries = paths.map((body) => ({
    path: body.match(/^        path: (.+)$/mu)?.[1],
    key: body.match(/^        key: (.+)$/mu)?.[1],
    prefix: body.match(/restore-keys: \|\n          (.+)/u)?.[1],
  }));
  assert.deepEqual(entries[0], entries[1]);
  assert.equal(entries[0].path, "${{ runner.temp }}/sccache");
  assert.equal(entries[0].key, `${entries[0].prefix}${"${{ github.sha }}"}`);
  assert.match(entries[0].prefix, /github\.job.*runner\.os.*runner\.arch/u);
});

test("sccache setup exports a bounded store before mise resolves the wrapper", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "wasm-ci-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "sccache"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const envFile = join(directory, "github-env");
  const body = step("Install sccache").match(/      run: \|\n((?: {8}.*\n|\n)+)/u)?.[1];
  assert.ok(body, "missing sccache install script");
  execFileSync("bash", ["-e", "-o", "pipefail", "-c", body.replace(/^ {8}/gmu, "")], {
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
      RUNNER_OS: "Linux",
      RUNNER_TEMP: directory,
      GITHUB_ENV: envFile,
    },
  });
  assert.equal(
    readFileSync(envFile, "utf8"),
    `SCCACHE_DIR=${directory}/sccache\nSCCACHE_CACHE_SIZE=1G\n`,
  );
  assert.ok(
    action.indexOf("- name: Install sccache") < action.indexOf("- name: Install mise-pinned tools"),
  );
  assert.ok(
    action.indexOf("- name: Restore sccache objects") <
      action.indexOf("- name: Zero sccache statistics"),
  );
});

test("CI only installs the Rust compiler cache when it must compile WASM", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflowSteps = workflow.split(/^      - name: /mu);
  const miss = workflowSteps.find((body) => body.startsWith("Set up WASM build environment\n"));
  const hit = workflowSteps.find((body) => body.startsWith("Set up cached WASM environment\n"));
  assert.ok(miss);
  assert.ok(hit);
  assert.match(miss, /if: steps\.wasm-cache\.outputs\.cache-hit != 'true'/u);
  assert.match(miss, /sccache: "true"/u);
  assert.doesNotMatch(hit, /sccache: "true"/u);
});
