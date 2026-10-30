#!/usr/bin/env node
// Prunes Cargo target directories of every linked worktree. Dry run unless --yes.
//   - a target nothing has read or written for --days (default 7) is removed whole;
//   - in an active target, incremental/ directories and deps/ files unused for
//     that long are removed.
// Cargo rebuilds whatever is missing and sccache replays the compile work, so
// pruning only costs time. Without --force it runs only when idle (no build
// process, low load) and at most once a day, so callers can invoke it freely.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DAY_MS = 86_400_000;
const BUILD_PROCESSES = new Set([
  "cargo", "rustc", "rustdoc", "rust-lld", "ld", "ld.lld", "mold", "cc1", "cc1plus", "clang", "clang++", "wasm-opt", "cargo-nextest",
]);

const diskBytes = (stats) => (stats.blocks ? stats.blocks * 512 : stats.size);
const recent = (stats, cutoff) => stats.mtimeMs > cutoff || stats.atimeMs > cutoff;

function entries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ entry, path: join(dir, entry.name) }));
  } catch {
    return [];
  }
}

// True when a file within `depth` levels of `dir` was read or written after `cutoff`.
export function hasRecentFile(dir, cutoff, depth = 3) {
  for (const { entry, path } of entries(dir)) {
    if (entry.isDirectory()) {
      if (depth > 1 && hasRecentFile(path, cutoff, depth - 1)) return true;
    } else if (entry.isFile() && recent(lstatSync(path), cutoff)) {
      return true;
    }
  }
  return false;
}

function* filesUnder(dir) {
  for (const { entry, path } of entries(dir)) {
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

// Directories named `name` at most `depth` levels below `dir`, without descending into matches.
function* dirsNamed(dir, name, depth) {
  for (const { entry, path } of entries(dir)) {
    if (!entry.isDirectory()) continue;
    if (entry.name === name) yield path;
    else if (depth > 1) yield* dirsNamed(path, name, depth - 1);
  }
}

function measure(paths) {
  let bytes = 0;
  for (const path of paths) bytes += diskBytes(lstatSync(path));
  return bytes;
}

// What to remove from one `target/` directory: [{ kind, path, bytes, files }].
export function planTarget(target, cutoff) {
  if (!hasRecentFile(target, cutoff)) {
    const files = [...filesUnder(target)];
    return [{ kind: "stale target", path: target, bytes: measure(files), files, remove: target }];
  }
  const plan = [];
  for (const dir of dirsNamed(target, "incremental", 3)) {
    const files = [...filesUnder(dir)];
    plan.push({ kind: "incremental", path: dir, bytes: measure(files), files, remove: dir });
  }
  for (const dir of dirsNamed(target, "deps", 4)) {
    const files = [...filesUnder(dir)].filter((file) => !recent(lstatSync(file), cutoff));
    if (files.length) plan.push({ kind: "old deps", path: dir, bytes: measure(files), files });
  }
  return plan.filter((item) => item.bytes > 0);
}

export function applyPlan(item) {
  if (item.remove) rmSync(item.remove, { recursive: true, force: true });
  else for (const file of item.files) unlinkSync(file);
}

export function worktreeRoots(cwd) {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  return out.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
}

// Why the machine is not idle, or "" when it is.
export function busyReason() {
  if (process.platform === "win32") return "not supported on Windows";
  let names;
  try {
    names = execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" }).split("\n").map((line) => line.trim().split("/").pop());
  } catch {
    return "cannot list processes";
  }
  const running = names.find((name) => BUILD_PROCESSES.has(name));
  if (running) return `${running} is running`;
  const load = loadavg()[0];
  return load >= cpus().length / 4 ? `load ${load.toFixed(1)}` : "";
}

// Modification time of the stamp file, or 0 when no prune has run yet.
function lastPruneMs(stamp) {
  return existsSync(stamp) ? statSync(stamp).mtimeMs : 0;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const yes = argv.includes("--yes");
  const force = argv.includes("--force");
  const daysIndex = argv.indexOf("--days");
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 7;
  if (!(days > 0)) throw new Error("prune-targets: --days needs a positive number");

  const stateDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "rom-weaver");
  const stamp = join(stateDir, "prune-targets");
  if (!force) {
    const reason = busyReason();
    if (reason) return process.stdout.write(`prune-targets: skipped (${reason})\n`);
    if (yes && Date.now() - lastPruneMs(stamp) < DAY_MS) return process.stdout.write("prune-targets: skipped (pruned within a day)\n");
  }

  const cutoff = Date.now() - days * DAY_MS;
  let total = 0;
  for (const root of worktreeRoots(cwd)) {
    const target = join(root, "target");
    let stats;
    try {
      stats = lstatSync(target);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    for (const item of planTarget(target, cutoff)) {
      total += item.bytes;
      process.stdout.write(`${String(Math.round(item.bytes / 1e6)).padStart(7)} MB  ${item.kind.padEnd(12)} ${item.path}\n`);
      if (yes) applyPlan(item);
    }
  }
  process.stdout.write(`prune-targets: ${yes ? "freed" : "would free"} ${(total / 1e9).toFixed(1)} GB${yes ? "" : " (pass --yes to delete)"}\n`);
  if (yes) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stamp, "");
    utimesSync(stamp, new Date(), new Date());
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
