#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEPENDENCIES, readManifest } from "./vendor/manifest.mjs";
import { replay } from "./vendor/patches.mjs";
import { extractSource, sourceArchive } from "./vendor/source.mjs";
import { copy, differences, inside } from "./vendor/tree.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheHome = () => process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
const stateHome = () => process.env.XDG_STATE_HOME || join(homedir(), ".local/state");

function install(root, manifest, source, backupRoot) {
  const destination = inside(root, manifest.destination);
  if (!differences(source, destination, manifest.preserve).length) return null;
  mkdirSync(dirname(destination), { recursive: true });
  const staged = mkdtempSync(join(dirname(destination), `.${basename(destination)}-refresh-`));
  let previous;
  let backup;
  try {
    copy(source, staged);
    for (const path of manifest.preserve ?? []) {
      const current = inside(destination, path);
      if (!existsSync(current))
        throw new Error(`${manifest.name}: preserved file is missing: ${path}`);
      copy(current, inside(staged, path));
    }
    if (existsSync(destination)) {
      mkdirSync(backupRoot, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const saved = mkdtempSync(join(backupRoot, `${stamp}-${manifest.name}-`));
      backup = inside(saved, manifest.destination);
      copy(destination, backup);
      previous = `${staged}.previous`;
      renameSync(destination, previous);
    }
    try {
      renameSync(staged, destination);
    } catch (error) {
      if (previous) renameSync(previous, destination);
      throw error;
    }
    if (previous) rmSync(previous, { recursive: true });
    return backup;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export async function runVendor({
  root = repository,
  command,
  name = "all",
  offline = false,
  keepWork = false,
  cache = join(cacheHome(), "rom-weaver/vendor-sources"),
  backupRoot = join(stateHome(), "agents/backups/rom-weaver/dependency-refresh"),
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  if (!["list", "check", "refresh"].includes(command))
    throw new Error("Expected list, check, or refresh");
  const names = name === "all" ? DEPENDENCIES : [name];
  const manifests = names.map((dependency) => readManifest(root, dependency));
  if (command === "list") {
    for (const manifest of manifests) {
      log(`${manifest.name}: ${manifest.source.revision} (${manifest.patches.length} patches)`);
      for (const patch of manifest.patches) {
        log(`  ${patch.file} [${patch.stage}; ${patch.upstream.status}] ${patch.reason}`);
        if (patch.upstream.url) log(`    ${patch.upstream.url}`);
      }
    }
    return manifests;
  }
  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, "replay-"));
  try {
    const prepared = [];
    for (const manifest of manifests) {
      const directory = join(work, manifest.name);
      mkdirSync(directory);
      const archive = await sourceArchive(manifest, cache, offline);
      const pristine = extractSource(manifest, archive, directory);
      const expected = replay(root, manifest, pristine, directory);
      const drift = differences(expected, inside(root, manifest.destination), manifest.preserve);
      prepared.push({ manifest, expected, drift });
    }
    if (command === "check") {
      const failures = prepared.filter((item) => item.drift.length);
      if (failures.length) {
        throw new Error(
          failures
            .map(
              ({ manifest, drift }) =>
                `${manifest.name}: unexplained vendor drift\n${drift.map((path) => `  ${path}`).join("\n")}`,
            )
            .join("\n"),
        );
      }
    }
    const result = [];
    for (const { manifest, expected, drift } of prepared) {
      const backup = command === "refresh" ? install(root, manifest, expected, backupRoot) : null;
      log(
        `${manifest.name}: ${command === "check" ? "verified" : "refreshed"} ${manifest.patches.length} patches; ${drift.length} changed files`,
      );
      if (backup) log(`  backup: ${backup}`);
      result.push({
        name: manifest.name,
        patches: manifest.patches.length,
        changed: drift.length,
        backup,
      });
    }
    return result;
  } finally {
    if (keepWork) log(`replay files: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

const HELP = `Usage: node scripts/vendor-dependencies.mjs <list|check|refresh> [all|libarchive|lzma-sdk|nod|xdvdfs] [--offline] [--keep-work]

list     Explain the ordered local patches and their upstream status.
check    Verify archive checksums, patch replay, and committed source equality.
refresh  Replay pinned sources and patches, then replace changed vendor trees.
         Original trees are backed up under XDG_STATE_HOME/agents/backups/rom-weaver.
--offline  Use already downloaded, checksum-verified source archives only.
--keep-work  Retain extracted and patched scratch trees to inspect conflicts.

Edit the dependency manifest's pinned source and patches before upgrading.
Normal Cargo builds never call this maintainer command.
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) process.stdout.write(HELP);
  else {
    const positional = args.filter((arg) => !["--offline", "--keep-work"].includes(arg));
    if (
      positional.length < 1 ||
      positional.length > 2 ||
      positional.some((arg) => arg.startsWith("-"))
    ) {
      process.stderr.write(HELP);
      process.exitCode = 1;
    } else {
      runVendor({
        command: positional[0],
        name: positional[1],
        offline: args.includes("--offline"),
        keepWork: args.includes("--keep-work"),
      }).catch((error) => {
        process.stderr.write(`vendor: ${error.message}\n`);
        process.exitCode = 1;
      });
    }
  }
}
