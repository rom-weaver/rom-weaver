#!/usr/bin/env node

import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createWasmSourceFingerprint } from "./wasm/wasm-source-fingerprint.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// The pre-commit hook runs typegen-check and wasm-check in their own target
// dirs so the three cargo commands stop serializing on Cargo's build lock (see
// .config/lefthook.yml). A fresh worktree starts with both empty, which turns
// its first Rust commit into a multi-minute build. Warm them here instead.
//
// The env has to match the hook's exactly or the fingerprints differ and the
// warm-up buys nothing; setup-worktree.test.mjs asserts these stay in sync with
// the hook. Primed in parallel - separate target dirs is the whole point.
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
      // Advisory: wasm-check needs the WASI SDK, and a worktree is still usable
      // without it. Failing setup here would strand a checkout that works.
      process.stdout.write(error ? `  ${prime.task} could not be primed (${error.message.split("\n")[0]})\n` : `  primed ${prime.targetDir}\n`);
      done();
    }).stderr?.pipe(process.stderr);
  })));
}

export function worktreePaths(cwd = process.cwd()) {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const commonDir = resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd));
  return { root, main: dirname(commonDir) };
}

export async function main(cwd = process.cwd(), { prime = true } = {}) {
  const { root, main: mainRoot } = worktreePaths(cwd);
  if (root === mainRoot) throw new Error("setup-worktree: run this from inside a worktree, not the main checkout");
  process.stdout.write("setup-worktree: npm ci (root)\n");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefix", root], { stdio: "inherit" });
  process.stdout.write("setup-worktree: npm ci (packages/rom-weaver-webapp)\n");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefix", join(root, "packages/rom-weaver-webapp")], { stdio: "inherit" });

  const source = join(mainRoot, "packages/rom-weaver-webapp/src/wasm");
  const destination = join(root, "packages/rom-weaver-webapp/src/wasm");
  mkdirSync(destination, { recursive: true });
  // notices.md belongs here with the other generated license files: vite.config.mjs
  // reads it while *loading the config*, so a worktree without it cannot run vitest,
  // lint, or the dev server at all.
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
  if (prime) {
    process.stdout.write("setup-worktree: priming pre-commit cargo target dirs (minutes; --no-prime to skip)\n");
    await primeHookTargets(root);
  }
  process.stdout.write(`setup-worktree: done for ${root}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.cwd(), { prime: !process.argv.includes("--no-prime") })
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
