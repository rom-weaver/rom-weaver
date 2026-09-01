import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HOOK_CARGO_PRIMES, primeHookTargets } from "./setup-worktree.mjs";

const hook = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../.config/lefthook.yml"), "utf8");

// A warm-up built with different flags than the hook uses is a different Cargo
// fingerprint, so it warms nothing and the drift is invisible - the hook just
// quietly goes back to building from scratch. Pin both halves to the hook file.
for (const prime of HOOK_CARGO_PRIMES) {
  const line = hook.split("\n").find((candidate) => candidate.includes(`mise run ${prime.task}`));
  test(`${prime.task} is primed into the target dir the hook uses`, () => {
    assert.ok(line, `no lefthook command runs \`mise run ${prime.task}\``);
    assert.match(line, new RegExp(`CARGO_TARGET_DIR=${prime.targetDir}\\b`));
    assert.match(line, /env -u __MISE_DIFF/);
  });
  test(`${prime.task} is primed with the rustflags the hook uses`, () => {
    const hookFlags = /RUSTFLAGS="\$\{RUSTFLAGS:-\} ([^"]*)"/.exec(line ?? "")?.[1] ?? "";
    assert.equal(prime.rustflags, hookFlags);
  });
}

test("worktree primes do not restore an activated mise environment", () => {
  const source = primeHookTargets.toString();
  assert.match(source, /delete env\.__MISE_DIFF/);
});

// A RUSTFLAGS override replaces the configured [target.*] rustflags rather than
// extending them, so a hook that sets it drops the threaded-WASM target features
// and checks a configuration nobody ships. Lint flags belong in .cargo/config.toml.
test("no hook cargo command overrides RUSTFLAGS", () => {
  const offenders = hook.split("\n").filter((line) => line.includes("RUSTFLAGS") && !line.trimStart().startsWith("#"));
  assert.deepEqual(offenders, []);
});

test("a prime that cannot run is advisory, not fatal", async () => {
  await primeHookTargets(process.cwd(), [{ task: "no-such-task-9f3d", targetDir: "target/none", rustflags: "" }]);
});
