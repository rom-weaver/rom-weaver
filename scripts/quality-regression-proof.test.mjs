import assert from "node:assert/strict";
import test from "node:test";
import { classifyTest, validateOptions } from "./quality-regression-proof.mjs";
const name = "regression::bounds";
const failure =
  "test regression::bounds ... FAILED\nassertion failed: offset must remain within source\ntest result: FAILED. 0 passed; 1 failed; 0 ignored";
test("proof requires a named behavioral failure and matching diagnostic", () => {
  assert.equal(
    classifyTest({ status: 101, stdout: failure }, name, "offset must remain within source"),
    "behavioral-failure",
  );
  for (const stdout of [
    "error: could not compile",
    "running 0 tests",
    failure.replace("bounds", "unrelated"),
    failure.replace("offset must remain within source", "unrelated assertion"),
  ])
    assert.equal(
      classifyTest({ status: 101, stdout }, name, "offset must remain within source"),
      "unproven",
    );
  assert.equal(
    classifyTest(
      { status: 101, signal: "SIGTERM", stdout: failure },
      name,
      "offset must remain within source",
    ),
    "setup-failure",
  );
});
test("success requires the exact selected test, not an empty green test command", () => {
  assert.equal(
    classifyTest(
      { status: 0, stdout: "test regression::bounds ... ok\ntest result: ok. 1 passed; 0 failed" },
      name,
      "diagnostic",
    ),
    "passed",
  );
  assert.equal(
    classifyTest({ status: 0, stdout: "test result: ok. 0 passed; 0 failed" }, name, "diagnostic"),
    "unproven",
  );
});
test("overlays cannot replace implementation, manifests or traverse out of tests", () => {
  const options = {
    base: "main",
    package: "rom-weaver-core",
    target: "regression",
    test: name,
    diagnostic: "offset must remain within source",
    files: ["crates/rom-weaver-core/tests/regression.rs"],
  };
  validateOptions(options);
  for (const file of [
    "Cargo.toml",
    "crates/core/src/lib.rs",
    "crates/core/tests/../../src/lib.rs",
    "/absolute.rs",
  ])
    assert.throws(() => validateOptions({ ...options, files: [file] }), /Only Rust test files/);
});

test("real CLI proof overlays tests while preserving the base implementation", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const parent = resolve(".agent/quality-signals");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(`${parent}/proof-fixture-`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = (exe, args) =>
    execFileSync(exe, args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
        RUSTC_WRAPPER: "",
        CARGO_TARGET_DIR: `${root}/target`,
      },
    });
  mkdirSync(`${root}/crates/sample/src`, { recursive: true });
  writeFileSync(
    `${root}/Cargo.toml`,
    '[package]\nname="proof-fixture"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="crates/sample/src/lib.rs"\n[workspace]\n',
  );
  writeFileSync(`${root}/crates/sample/src/lib.rs`, "pub fn bounded(x: u8) -> u8 { x + 1 }\n");
  command("cargo", ["generate-lockfile", "--offline"]);
  command("git", ["init", "-q"]);
  command("git", ["add", "Cargo.toml", "Cargo.lock", "crates/sample/src/lib.rs"]);
  command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "base",
  ]);
  writeFileSync(`${root}/crates/sample/src/lib.rs`, "pub fn bounded(x: u8) -> u8 { x }\n");
  mkdirSync(`${root}/crates/sample/tests`, { recursive: true });
  writeFileSync(
    `${root}/crates/sample/tests/regression.rs`,
    '#[test]\nfn bounds() { assert_eq!(proof_fixture::bounded(0), 0, "offset must remain within source"); }\n',
  );
  writeFileSync(
    `${root}/Cargo.toml`,
    `${readFileSyncForTest(`${root}/Cargo.toml`)}\n[[test]]\nname="regression"\npath="crates/sample/tests/regression.rs"\n`,
  );
  // The target declaration MUST exist at the base too; a missing target is not behavioral proof.
  command("git", ["add", "Cargo.toml"]);
  command("git", [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "declare regression target",
  ]);
  const output = command("node", [
    resolve("scripts/quality-regression-proof.mjs"),
    "--base",
    "HEAD",
    "--package",
    "proof-fixture",
    "--target",
    "regression",
    "--test",
    "bounds",
    "--diagnostic",
    "offset must remain within source",
    "--test-file",
    "crates/sample/tests/regression.rs",
  ]);
  assert.match(output, /"proven": true/);
});

import { readFileSync as readFileSyncForTest } from "node:fs";
import process from "node:process";
