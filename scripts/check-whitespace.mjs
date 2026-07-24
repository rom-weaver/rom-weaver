#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { vendoredExclusions } from "./vendored-pathspecs.mjs";

export function diffCheckArgs(env = process.env) {
  const base = env.BASE_SHA || "";
  const head = env.HEAD_SHA || "";
  const empty = "0".repeat(40);
  if (base && base !== empty && head) return ["diff", "--check", base, head, "--", ".", ...vendoredExclusions()];
  if (head) return ["diff-tree", "--check", "--no-commit-id", "-r", head, "--", ".", ...vendoredExclusions()];
  return ["diff", "--cached", "--check", "--", ".", ...vendoredExclusions()];
}

export function main(root = fileURLToPath(new URL("..", import.meta.url))) {
  return spawnSync("git", diffCheckArgs(), { cwd: root, stdio: "inherit" }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
