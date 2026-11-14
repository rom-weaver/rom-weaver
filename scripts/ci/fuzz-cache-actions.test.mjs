import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { FUZZ_TOOLCHAIN } from "../quality-fuzz.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const action = read(".github/actions/fuzz-cache/action.yml");
const steps = action.split(/^    - name: /mu);
const step = (name) => {
  const body = steps.find((entry) => entry.startsWith(`${name}\n`));
  assert.ok(body, `missing fuzz cache step: ${name}`);
  return body;
};
const restoreKeys = (body) => body.match(/restore-keys: \|\n([\s\S]+?)(?:\n\s*\n|$)/u)?.[1].trim().split("\n").map((line) => line.trim());
const field = (body, name) => body.match(new RegExp(`^        ${name}: (.+)$`, "mu"))?.[1];

const selected = (name, save, ref) => {
  const condition = step(name).match(/^      if: (.+)$/mu)?.[1];
  assert.ok(condition, `missing condition: ${name}`);
  return runInNewContext(condition.replace(/^\$\{\{\s*(.*?)\s*\}\}$/u, "$1"), { inputs: { save }, github: { ref } });
};

for (const [label, save, ref, saves, restores] of [
  ["a trusted writer on main", "true", "refs/heads/main", true, false],
  ["a pull request that asks to save", "true", "refs/pull/7/merge", false, true],
  ["a tag that asks to save", "true", "refs/tags/v0.15.1", false, true],
  ["main without the save input", "false", "refs/heads/main", false, true],
  ["main with an unrecognised save value", "yes", "refs/heads/main", false, true],
]) {
  test(`fuzz cache persistence: ${label}`, () => {
    assert.equal(selected("Cache fuzz build artifacts", save, ref), saves);
    assert.equal(selected("Restore fuzz build artifacts", save, ref), restores);
  });
}

test("saving and restoring use the fuzz workspace's target directory with the same key", () => {
  const [saving, restoring] = [step("Cache fuzz build artifacts"), step("Restore fuzz build artifacts")];
  assert.equal(field(saving, "path"), "fuzz/target");
  assert.equal(field(restoring, "path"), "fuzz/target");
  assert.equal(field(saving, "key"), field(restoring, "key"));
});

test("the key names the toolchain, platform, commit, and every file that fixes the build", () => {
  const pin = step("Resolve fuzz cache key");
  for (const part of ["RUNNER_OS", "RUNNER_ARCH", "FUZZ_TOOLCHAIN", "INPUTS_HASH"]) {
    assert.ok(pin.includes(part), `the key step lacks ${part}`);
  }
  assert.ok(field(step("Cache fuzz build artifacts"), "key").includes("github.sha"));
  const patterns = [...pin.matchAll(/hashFiles\(([^)]*)\)/gu)].flatMap(([, list]) => [...list.matchAll(/'([^']+)'/gu)].map((match) => match[1]));
  for (const required of ["fuzz/Cargo.toml", "fuzz/Cargo.lock", "Cargo.lock", ".config/mise.toml", "scripts/quality-fuzz.mjs"]) {
    assert.ok(patterns.includes(required), `key does not hash ${required}`);
  }
  for (const pattern of patterns) {
    const root = new URL("../../", import.meta.url).pathname;
    const files = pattern.includes("*") ? globSync(pattern, { cwd: root }) : existsSync(`${root}${pattern}`) ? [pattern] : [];
    assert.ok(files.length > 0, `hashFiles pattern matches nothing: ${pattern}`);
  }
});

test("a restoring run may fall back to an older lock generation, a saving run may not", () => {
  const inputs = "${{ steps.pin.outputs.inputs }}";
  assert.deepEqual(restoreKeys(step("Restore fuzz build artifacts")), [inputs, "${{ steps.pin.outputs.prefix }}"]);
  assert.deepEqual(restoreKeys(step("Cache fuzz build artifacts")), [inputs]);
});

test("both workflows install the toolchain the script pins and restore the cache only for the fuzz signal", () => {
  for (const [path, saves] of [
    [".github/workflows/quality-deep.yml", 'save: "true"'],
    [".github/workflows/ci.yml", null],
  ]) {
    const workflow = read(path);
    const installed = [...workflow.matchAll(/rustup toolchain install (nightly-[\d-]+)/gu)].map((match) => match[1]);
    assert.ok(installed.length > 0 && installed.every((name) => name === FUZZ_TOOLCHAIN), `${path} installs ${installed}`);
    const block = workflow.match(/- name: Restore fuzz build artifacts\n([\s\S]+?)\n      - name:/u)?.[1];
    assert.ok(block, `${path} does not restore fuzz build artifacts`);
    assert.match(block, /if: matrix\.signal == 'fuzz'/u);
    assert.match(block, /uses: \.\/\.github\/actions\/fuzz-cache/u);
    if (saves) assert.ok(block.includes(saves));
    else assert.doesNotMatch(block, /save:/u);
  }
});
