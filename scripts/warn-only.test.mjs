import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureCombined, runWarnOnly } from "./warn-only.mjs";

// The point of the single descriptor: a tool that alternates streams keeps its
// order. Collecting two pipes would group all of stdout ahead of all of stderr.
test("captures both streams in the order the child wrote them", () => {
  const { result, output } = captureCombined(["node", "-e", 'process.stdout.write("one\\n"); process.stderr.write("two\\n"); process.stdout.write("three\\n");'], process.env);
  assert.equal(result.status, 0);
  assert.equal(output, "one\ntwo\nthree\n");
});

test("survives output far past a pipe's default maxBuffer", () => {
  const { output } = captureCombined(["node", "-e", 'process.stdout.write("x".repeat(4 * 1024 * 1024))'], process.env);
  assert.equal(output.length, 4 * 1024 * 1024);
});

// The whole contract: findings are reported, never fatal.
test("a failing command still exits zero and lands in the job summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "warn-only-"));
  const summary = join(directory, "summary.md");
  try {
    const status = runWarnOnly("advisories", ["node", "-e", 'process.stderr.write("1 high severity\\n"); process.exit(1)'], { ...process.env, GITHUB_STEP_SUMMARY: summary });
    assert.equal(status, 0);
    const written = readFileSync(summary, "utf8");
    assert.match(written, /### ⚠️ advisories/);
    assert.match(written, /1 high severity/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a command that cannot run warns rather than failing the job", () => {
  const status = runWarnOnly("missing", ["definitely-not-a-real-binary-9f3d"], { ...process.env, GITHUB_STEP_SUMMARY: "" });
  assert.equal(status, 0);
});

test("a successful command writes no summary entry", () => {
  const directory = mkdtempSync(join(tmpdir(), "warn-only-"));
  const summary = join(directory, "summary.md");
  try {
    assert.equal(runWarnOnly("clean", ["node", "-e", ""], { ...process.env, GITHUB_STEP_SUMMARY: summary }), 0);
    assert.throws(() => readFileSync(summary, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
