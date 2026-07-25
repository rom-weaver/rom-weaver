#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function worktreePaths(cwd = process.cwd()) {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const commonDir = resolve(cwd, git(["rev-parse", "--git-common-dir"], cwd));
  return { root, main: dirname(commonDir) };
}

export function main(cwd = process.cwd()) {
  const { root, main: mainRoot } = worktreePaths(cwd);
  if (root === mainRoot) throw new Error("setup-worktree: run this from inside a worktree, not the main checkout");
  process.stdout.write("setup-worktree: npm ci (root)\n");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefix", root], { stdio: "inherit" });
  process.stdout.write("setup-worktree: npm ci (packages/rom-weaver-webapp)\n");
  execFileSync("npm", ["ci", "--no-audit", "--no-fund", "--prefix", join(root, "packages/rom-weaver-webapp")], { stdio: "inherit" });

  const source = join(mainRoot, "packages/rom-weaver-webapp/src/wasm");
  const destination = join(root, "packages/rom-weaver-webapp/src/wasm");
  mkdirSync(destination, { recursive: true });
  for (const artifact of ["rom-weaver-app.wasm", "rom-weaver-app.wasm.br", "NOTICE"]) {
    if (!existsSync(join(source, artifact))) continue;
    cpSync(join(source, artifact), join(destination, artifact));
    process.stdout.write(`  copied ${artifact} from main checkout\n`);
  }
  if (existsSync(join(source, "third_party"))) {
    rmSync(join(destination, "third_party"), { recursive: true, force: true });
    cpSync(join(source, "third_party"), join(destination, "third_party"), { recursive: true });
    process.stdout.write("  copied third_party/ from main checkout\n");
  }
  process.stdout.write(`setup-worktree: done for ${root}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
