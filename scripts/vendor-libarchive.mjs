#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRUNE_PATHS = [
  ".git", ".github", ".cirrus.yml", "libarchive/test", "cat/test", "cpio/test", "tar/test", "unzip/test", "test_utils", "doc", "examples", "contrib",
  "build/autoconf", "build/ci", "build/release", "build/utils", "build/autogen.sh", "build/bump-version.sh", "build/clean.sh", "build/makerelease.sh",
];

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function vendorLibarchive(sourceDir, ref = "HEAD", repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd())) {
  if (!sourceDir) throw new Error("usage: node scripts/vendor-libarchive.mjs <path-to-libarchive-checkout> [ref]");
  if (!existsSync(join(sourceDir, "CMakeLists.txt"))) throw new Error(`vendor-libarchive: ${sourceDir} is not a libarchive checkout`);
  const commit = git(["rev-parse", ref], sourceDir);
  let described;
  try { described = git(["describe", "--tags", ref], sourceDir); } catch { described = commit; }
  try { execFileSync("git", ["diff", "--quiet", ref, "--"], { cwd: sourceDir, stdio: "ignore" }); }
  catch { throw new Error(`vendor-libarchive: ${sourceDir} has uncommitted changes against ${ref}`); }

  const destination = join(repoRoot, "crates/rom-weaver-containers/libarchive/vendor/libarchive");
  // Staged beside the destination, not in os.tmpdir(): the final move is a
  // rename, which fails with EXDEV whenever /tmp is its own filesystem.
  mkdirSync(dirname(destination), { recursive: true });
  const staged = mkdtempSync(`${destination}.staging-`);
  try {
    process.stdout.write(`vendor-libarchive: staging ${described} (${commit})\n`);
    // maxBuffer is unbounded because the tar is tens of megabytes and Node's
    // 1 MiB default kills the child and truncates the archive.
    const archive = spawnSync("git", ["archive", "--format=tar", ref], { cwd: sourceDir, maxBuffer: Infinity });
    if (archive.status !== 0) throw new Error(`vendor-libarchive: git archive ${ref} failed: ${archive.stderr?.toString().trim() || archive.error?.message || ""}`);
    const extract = spawnSync("tar", ["-x", "-C", staged], { input: archive.stdout, maxBuffer: Infinity, stdio: ["pipe", "inherit", "inherit"] });
    if (extract.status !== 0) throw new Error(`vendor-libarchive: tar extraction failed with status ${extract.status}`);
    for (const path of PRUNE_PATHS) rmSync(join(staged, path), { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
    renameSync(staged, destination);
    writeFileSync(join(dirname(destination), "LIBARCHIVE_VERSION"), `source: https://github.com/brandonocasey/libarchive\nref: ${described}\ncommit: ${commit}\npruned: ${PRUNE_PATHS.join(" ")}\nrefreshed-by: scripts/vendor-libarchive.mjs\n`);
    process.stdout.write(`vendor-libarchive: wrote ${destination} (${described})\n`);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { vendorLibarchive(process.argv[2], process.argv[3]); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
