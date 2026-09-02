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

export function areAptPackagesInstalled(packages, run = execFileSync) {
  return packages.every((packageName) => {
    try {
      const status = run("dpkg-query", ["-W", "-f=${Status}", packageName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return status.trim() === "install ok installed";
    } catch {
      return false;
    }
  });
}

export function installAptPackages(packages, run = execFileSync) {
  if (!packages.length || areAptPackagesInstalled(packages, run)) return false;
  run("sudo", ["apt-get", "update"], { stdio: "inherit" });
  run("sudo", ["apt-get", "install", "--yes", ...packages], { stdio: "inherit" });
  return true;
}

export function main(env = process.env, run = execFileSync) {
  const packages = (env.APT_PACKAGES || "").split(/\s+/).filter(Boolean);
  if (!packages.length) return;

  try {
    const installed = !installAptPackages(packages, run);
    process.stdout.write(
      installed
        ? `apt packages already installed: ${packages.join(" ")}\n`
        : "apt packages installed\n",
    );
  } catch (error) {
    process.stderr.write(`installing apt packages failed: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const libclang = findLibclangDir();
  if (libclang && env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `LIBCLANG_PATH=${libclang}\n`);
  process.stdout.write(
    libclang ? `LIBCLANG_PATH=${libclang}\n` : "no libclang found; leaving LIBCLANG_PATH unset\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
