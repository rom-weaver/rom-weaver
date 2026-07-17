import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const check = (subjects) =>
  spawnSync(process.execPath, ["scripts/check-conventional-commits.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    input: `${subjects.join("\n")}\n`,
  });

test("accepts Conventional Commit subjects", () => {
  assert.equal(check(["feat(cli): publish images", "fix!: remove old API", "dx(worktree): clean up"]).status, 0);
});

test("rejects free-form subjects", () => {
  const result = check(["publish images"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publish images/);
});
