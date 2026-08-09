import assert from "node:assert/strict";
import test from "node:test";

import { findTool, requireOneOf, SEVENZIP_NAMES } from "./parity-check.mjs";

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

const env = { PATH: "/usr/bin" };

// Debian and Ubuntu ship 7-Zip as `7z` and provide no `7zz`, so hardcoding the
// upstream name failed every nightly parity run on the CI runner.
test("accepts the Debian/Ubuntu 7-Zip name", () => {
  assert.equal(requireOneOf("SEVENZIP", SEVENZIP_NAMES, env, executable(["/usr/bin/7z"])), "7z");
});

test("prefers 7zz over a possibly-legacy p7zip 7z", () => {
  assert.equal(requireOneOf("SEVENZIP", SEVENZIP_NAMES, env, executable(["/usr/bin/7z", "/usr/bin/7zz"])), "7zz");
});

test("names every candidate it tried when none is installed", () => {
  assert.throws(() => requireOneOf("SEVENZIP", SEVENZIP_NAMES, env, executable([])), /tried 7zz, 7z/);
});
