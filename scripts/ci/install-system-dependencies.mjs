#!/usr/bin/env node

// Installs the job's apt packages, then points bindgen at whichever libclang
// they brought in.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

// Best-effort by design: /usr/lib64 does not exist on arm64 runners, and find
// exits non-zero on any unreadable subtree. A missing libclang is not fatal
// here - only the jobs that actually need it fail, and they say so clearly.
export function findLibclangDir(roots = ["/usr/lib", "/usr/lib64"]) {
  const present = roots.filter((root) => existsSync(root));
  if (!present.length) return "";
  const result = spawnSync("find", [...present, "-name", "libclang.so*"], { encoding: "utf8" });
  const first = (result.stdout || "").split(/\r?\n/).filter(Boolean)[0];
  return first ? dirname(first) : "";
}

const packages = (process.env.APT_PACKAGES || "").split(/\s+/).filter(Boolean);
if (!packages.length) process.exit(0);

try {
  execFileSync("sudo", ["apt-get", "update"], { stdio: "inherit" });
  execFileSync("sudo", ["apt-get", "install", "--yes", ...packages], { stdio: "inherit" });
} catch (error) {
  process.stderr.write(`installing apt packages failed: ${error.message}\n`);
  process.exit(1);
}

const libclang = findLibclangDir();
if (libclang && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `LIBCLANG_PATH=${libclang}\n`);
process.stdout.write(libclang ? `LIBCLANG_PATH=${libclang}\n` : "no libclang found; leaving LIBCLANG_PATH unset\n");
