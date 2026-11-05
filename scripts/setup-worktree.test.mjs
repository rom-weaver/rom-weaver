import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { copyIdentifyData, generateHookInputs, HOOK_CARGO_PRIMES, IDENTIFY_DATA_DIR, HOOK_INPUT_SCRIPTS, primeHookTargets, shouldPrime } from "./setup-worktree.mjs";

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

test("branch checkouts prime and detached review checkouts skip unless forced", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "setup-worktree-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  assert.equal(shouldPrime(repo, []), true, "an unborn branch is still a branch");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base");
  assert.equal(shouldPrime(repo, []), true);
  assert.equal(shouldPrime(repo, ["--no-prime"]), false);
  git("checkout", "-q", "--detach");
  assert.equal(shouldPrime(repo, []), false);
  assert.equal(shouldPrime(repo, ["--prime"]), true);
});

// The react-types and react-knip hooks fail in a fresh worktree unless the ignored
// Lingui catalogs and generated channel icons exist, so setup must produce them.
test("setup generates the webapp hook inputs from scripts the webapp defines", () => {
  const webapp = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../packages/rom-weaver-webapp/package.json"), "utf8"));
  for (const script of HOOK_INPUT_SCRIPTS) assert.ok(webapp.scripts[script], `webapp has no ${script} script`);
  const calls = [];
  generateHookInputs("/repo", (command, args) => calls.push([command, ...args]));
  assert.deepEqual(calls, [
    ["npm", "run", "i18n:compile", "--prefix", join("/repo", "packages/rom-weaver-webapp")],
    ["npm", "run", "icons:channels", "--prefix", join("/repo", "packages/rom-weaver-webapp")],
  ]);
});

test("setup copies the main checkout's identify data that the webapp Vite config reads", (t) => {
  const mainRoot = mkdtempSync(join(tmpdir(), "setup-worktree-main-"));
  const root = mkdtempSync(join(tmpdir(), "setup-worktree-root-"));
  t.after(() => {
    rmSync(mainRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const viteConfig = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../packages/rom-weaver-webapp/scripts/vite-config/identify-data.mjs"), "utf8");
  assert.match(viteConfig, /"crates", "rom-weaver-cli", "data", "identify", "v1"/);
  assert.doesNotThrow(() => copyIdentifyData(mainRoot, root), "missing identify data is advisory");
  assert.equal(existsSync(join(root, IDENTIFY_DATA_DIR)), false);
  mkdirSync(join(mainRoot, IDENTIFY_DATA_DIR), { recursive: true });
  writeFileSync(join(mainRoot, IDENTIFY_DATA_DIR, "index.json"), "{}");
  writeFileSync(join(mainRoot, IDENTIFY_DATA_DIR, "nes.pack.br"), "pack");
  copyIdentifyData(mainRoot, root);
  assert.equal(readFileSync(join(root, IDENTIFY_DATA_DIR, "index.json"), "utf8"), "{}");
  assert.equal(readFileSync(join(root, IDENTIFY_DATA_DIR, "nes.pack.br"), "utf8"), "pack");
});

// Icon generation launches Chromium; a missing browser must not strand the checkout.
test("a failing hook input script does not stop setup", () => {
  const calls = [];
  assert.doesNotThrow(() =>
    generateHookInputs("/repo", (_command, args) => {
      calls.push(args[1]);
      throw new Error("Executable doesn't exist");
    }),
  );
  assert.deepEqual(calls, ["i18n:compile", "icons:channels"]);
});
