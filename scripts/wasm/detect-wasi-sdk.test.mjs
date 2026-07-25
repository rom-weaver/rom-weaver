import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./detect-wasi-sdk.sh", import.meta.url));

// The real fixed locations are /opt paths that may exist on the machine running
// these tests, so every case passes its own candidate list. One that cannot
// exist stands in for "no fixed location matches" - the script falls back to
// the defaults only when given no arguments at all.
const NO_FIXED_CANDIDATES = ["/nonexistent-wasi-sdk-candidate"];

const detect = (home, { env = {}, candidates = NO_FIXED_CANDIDATES } = {}) =>
  execFileSync("sh", [script, ...candidates], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, ...env },
  });

const freshHome = () => mkdtempSync(join(os.tmpdir(), "wasi-sdk-test-"));

test("prefers an explicit SDK path, then the newest local toolchain", () => {
  const home = freshHome();
  const toolchains = join(home, ".local", "toolchains");
  mkdirSync(join(toolchains, "wasi-sdk-22"), { recursive: true });
  mkdirSync(join(toolchains, "wasi-sdk-24"), { recursive: true });
  assert.equal(detect(home), join(toolchains, "wasi-sdk-24"));
  const explicit = join(home, "explicit");
  mkdirSync(explicit);
  assert.equal(detect(home, { env: { WASI_SDK_PATH: explicit } }), explicit);
});

test("orders toolchains numerically, not lexically", () => {
  const home = freshHome();
  const toolchains = join(home, ".local", "toolchains");
  mkdirSync(join(toolchains, "wasi-sdk-9"), { recursive: true });
  mkdirSync(join(toolchains, "wasi-sdk-25"), { recursive: true });
  assert.equal(detect(home), join(toolchains, "wasi-sdk-25"), "lexical order would pick wasi-sdk-9");
});

test("reports no SDK rather than a directory that is not one", () => {
  const home = freshHome();
  assert.equal(detect(home), "", "no toolchains directory at all");
  mkdirSync(join(home, ".local", "toolchains", "unrelated-tool"), { recursive: true });
  assert.equal(detect(home), "", "toolchains directory holds no wasi-sdk-*");
  assert.equal(detect(home, { env: { WASI_SDK_PATH: join(home, "missing") } }), "", "WASI_SDK_PATH points at nothing");
});

test("takes a fixed location over a local toolchain", () => {
  const home = freshHome();
  mkdirSync(join(home, ".local", "toolchains", "wasi-sdk-24"), { recursive: true });
  const fixed = join(home, "opt-wasi-sdk");
  mkdirSync(fixed);
  assert.equal(detect(home, { candidates: [fixed] }), fixed);
});

test("survives a path containing whitespace", () => {
  const home = join(freshHome(), "home with spaces");
  const toolchains = join(home, ".local", "toolchains");
  mkdirSync(join(toolchains, "wasi-sdk-24"), { recursive: true });
  assert.equal(detect(home), join(toolchains, "wasi-sdk-24"));
});
