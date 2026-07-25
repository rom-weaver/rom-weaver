import assert from "node:assert/strict";
import test from "node:test";

import { findTool } from "./parity-check.mjs";

const executable = (paths) => (path) => paths.includes(path);

test("resolves a bare name against PATH", () => {
  assert.equal(findTool("chdman", { PATH: "/a:/b" }, executable(["/b/chdman"])), "/b/chdman");
});

test("takes the first PATH hit", () => {
  assert.equal(findTool("chdman", { PATH: "/a:/b" }, executable(["/a/chdman", "/b/chdman"])), "/a/chdman");
});

// The reason this is a lookup and not `<tool> --help`: a file that exists but
// carries no executable bit is not a usable tool, and running it to find out
// assumes a flag the tool need not support.
test("a path-bearing name must itself be executable", () => {
  assert.equal(findTool("/opt/chdman", {}, executable(["/opt/chdman"])), "/opt/chdman");
  assert.equal(findTool("/opt/chdman", {}, executable([])), "");
});

test("reports nothing rather than guessing when PATH is unset", () => {
  assert.equal(findTool("chdman", {}, executable(["/usr/bin/chdman"])), "");
});
