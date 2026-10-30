import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPlan, hasRecentFile, planTarget } from "./prune-targets.mjs";

const DAY = 86_400;

function file(path, ageDays = 0) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x".repeat(8192));
  const when = Date.now() / 1000 - ageDays * DAY;
  utimesSync(path, when, when);
}

function withTarget(callback) {
  const dir = mkdtempSync(join(tmpdir(), "prune-targets-"));
  try {
    callback(join(dir, "target"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cutoff = () => Date.now() - 7 * DAY * 1000;

test("a target with nothing recent is removed whole", () => {
  withTarget((target) => {
    file(join(target, "debug/deps/a"), 30);
    file(join(target, "debug/.cargo-lock"), 30);
    assert.equal(hasRecentFile(target, cutoff()), false);
    const plan = planTarget(target, cutoff());
    assert.deepEqual(plan.map((item) => item.kind), ["stale target"]);
    applyPlan(plan[0]);
    assert.equal(existsSync(target), false);
  });
});

test("an active target loses only incremental dirs and old deps files", () => {
  withTarget((target) => {
    file(join(target, "debug/deps/old"), 30);
    file(join(target, "debug/deps/new"), 0);
    file(join(target, "debug/incremental/x/y"), 0);
    file(join(target, "wasm32-wasip1-threads/debug/incremental/z"), 0);
    file(join(target, "debug/build/keep"), 30);
    const plan = planTarget(target, cutoff());
    assert.deepEqual(plan.map((item) => item.kind).sort(), ["incremental", "incremental", "old deps"]);
    for (const item of plan) applyPlan(item);
    assert.equal(existsSync(join(target, "debug/deps/old")), false);
    assert.equal(existsSync(join(target, "debug/deps/new")), true);
    assert.equal(existsSync(join(target, "debug/incremental")), false);
    assert.equal(existsSync(join(target, "debug/build/keep")), true);
  });
});

test("a recently read file keeps its deps entry", () => {
  withTarget((target) => {
    file(join(target, "debug/deps/read"), 30);
    const now = new Date();
    utimesSync(join(target, "debug/deps/read"), now, new Date(Date.now() - 30 * DAY * 1000));
    assert.deepEqual(planTarget(target, cutoff()), []);
  });
});
