#!/usr/bin/env node

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hasCurrentData, IDENTIFY_DATA_DIR } from "./ensure-identify-data.mjs";
import { createWasmSourceFingerprint } from "./wasm/wasm-source-fingerprint.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Separate Cargo target directories let the pre-commit checks build in parallel.
// Priming MUST use the environment from .config/lefthook.yml so Cargo reuses the artifacts.
export const HOOK_CARGO_PRIMES = [
  { task: "typegen-check", targetDir: "target/hook-typegen", rustflags: "" },
  { task: "wasm-check", targetDir: "target/hook-wasm", rustflags: "" },
];

export function primeHookTargets(root, primes = HOOK_CARGO_PRIMES) {
  return Promise.all(primes.map((prime) => new Promise((done) => {
    const env = { ...process.env, CARGO_TARGET_DIR: prime.targetDir };
    delete env.__MISE_DIFF;
    if (prime.rustflags) env.RUSTFLAGS = `${process.env.RUSTFLAGS ?? ""} ${prime.rustflags}`.trim();
    execFile("mise", ["run", prime.task], { cwd: root, env }, (error) => {
      // Priming failures are advisory because native work can continue without the WASI SDK.
      process.stdout.write(error ? `  ${prime.task} could not be primed (${error.message.split("\n")[0]})\n` : `  primed ${prime.targetDir}\n`);
      done();
    }).stderr?.pipe(process.stderr);
  })));
}

// Detached checkouts are review checkouts that rarely commit, so they skip the
// prime; the hooks still build their target dirs on the first Rust commit.
export function shouldPrime(cwd, argv) {
  if (argv.includes("--no-prime")) return false;
  if (argv.includes("--prime")) return true;
  return spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd }).status === 0;
}

export function worktreePaths(cwd = process.cwd()) {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const commonDir = resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd));
  return { root, main: dirname(commonDir) };
}

// Pruning is advisory: it skips unless the machine is idle and frees disk for the builds below.
export function pruneTargets(cwd) {
  try {
    execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "prune-targets.mjs"), "--yes"], { cwd, stdio: "inherit" });
  } catch (error) {
    process.stdout.write(`  target pruning failed (${error.message.split("\n")[0]})\n`);
  }
}

// The pre-commit react-types and react-knip checks import these ignored outputs: the compiled
// Lingui catalogs and the generated channel icons that the Vitest browser configs read.
// Advisory like pruning: the icons need Playwright's Chromium, which a fresh Playwright
// version may not have downloaded yet, and the rest of setup still leaves a usable checkout.
export const HOOK_INPUT_SCRIPTS = ["i18n:compile", "icons:channels"];
export function generateHookInputs(root, run = execFileSync) {
  for (const script of HOOK_INPUT_SCRIPTS) {
    process.stdout.write(`setup-worktree: npm run ${script} (packages/rom-weaver-webapp)\n`);
    try {
      run("npm", ["run", script, "--prefix", join(root, "packages/rom-weaver-webapp")], { stdio: "inherit" });
    } catch (error) {
      process.stdout.write(`  ${script} failed (${error.message.split("\n")[0]}); the pre-commit type and knip checks need it. If Chromium is missing, run \`npm --prefix packages/rom-weaver-webapp exec playwright -- install chromium\`, then \`npm --prefix packages/rom-weaver-webapp run ${script}\`.\n`);
    }
  }
}

// The webapp Vite config reads the ignored identify data while loading, so the react-knip
// check needs it too. Building it fetches pinned upstream data, so copy the main checkout's
// when it matches this checkout's pins, and never replace data that already does.
export function copyIdentifyData(mainRoot, root, isCurrent = hasCurrentData) {
  const destination = join(root, IDENTIFY_DATA_DIR);
  if (isCurrent(destination)) return;
  const source = join(mainRoot, IDENTIFY_DATA_DIR);
  if (!isCurrent(source)) {
    process.stdout.write("  main checkout has no current identify data; run `mise run identify-data` before the pre-commit knip check\n");
    return;
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  process.stdout.write("  copied identify data from main checkout\n");
}

export async function main(cwd = process.cwd(), { prime = true, prune = true } = {}) {
  const { root, main: mainRoot } = worktreePaths(cwd);
  if (root === mainRoot) throw new Error("setup-worktree: run this from inside a worktree, not the main checkout");
  if (prune) pruneTargets(cwd);
  process.stdout.write("setup-worktree: npm ci (root)\n");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefix", root], { stdio: "inherit" });
  process.stdout.write("setup-worktree: npm ci (packages/rom-weaver-webapp)\n");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefix", join(root, "packages/rom-weaver-webapp")], { stdio: "inherit" });

  const source = join(mainRoot, "packages/rom-weaver-webapp/src/wasm");
  const destination = join(root, "packages/rom-weaver-webapp/src/wasm");
  mkdirSync(destination, { recursive: true });
  // Vite reads notices.md while loading its config, before lint, tests, or the dev server can start.
  for (const artifact of ["rom-weaver-app.wasm", "rom-weaver-app.wasm.br", "rom-weaver-app.wasm.source.sha256", "NOTICE", "WEBAPP_NOTICE", "notices.md"]) {
    if (!existsSync(join(source, artifact))) continue;
    cpSync(join(source, artifact), join(destination, artifact));
    process.stdout.write(`  copied ${artifact} from main checkout\n`);
  }
  const sourceFingerprint = join(source, "rom-weaver-app.wasm.source.sha256");
  if (existsSync(join(source, "rom-weaver-app.wasm")) && !existsSync(sourceFingerprint)) {
    writeFileSync(join(destination, "rom-weaver-app.wasm.source.sha256"), `${createWasmSourceFingerprint(mainRoot)}\n`);
    process.stdout.write("  recorded copied WASM source fingerprint\n");
  }
  if (existsSync(join(source, "third_party"))) {
    rmSync(join(destination, "third_party"), { recursive: true, force: true });
    cpSync(join(source, "third_party"), join(destination, "third_party"), { recursive: true });
    process.stdout.write("  copied third_party/ from main checkout\n");
  }
  copyIdentifyData(mainRoot, root);
  generateHookInputs(root);
  if (prime) {
    process.stdout.write("setup-worktree: priming pre-commit cargo target dirs (minutes; --no-prime to skip)\n");
    await primeHookTargets(root);
  } else {
    process.stdout.write("setup-worktree: skipped priming pre-commit cargo target dirs (--prime to force)\n");
  }
  process.stdout.write(`setup-worktree: done for ${root}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.cwd(), { prime: shouldPrime(process.cwd(), process.argv), prune: !process.argv.includes("--no-prune") })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
