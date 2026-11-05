// Content-addressed store of built WASM artifacts, shared by every checkout on
// the machine. Each checkout has its own Cargo target directory, so without it
// a new worktree pays a cold wasm-release build for inputs another checkout
// already built.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// Entries hold one dev or prod module (10-25 MB), so a handful covers the
// branches in flight without filling the disk.
const DEFAULT_KEEP = 8;
const STALE_TMP_MS = 60 * 60 * 1000;

export const wasmArtifactCacheRoot = (env) =>
  env.ROM_WEAVER_WASM_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "rom-weaver", "wasm");

// Keys MUST cover every input that can change the output bytes; a missed input
// serves another build's module. Labels keep values from running together.
export function wasmArtifactCacheKey(inputs) {
  const hash = createHash("sha256");
  for (const [label, value] of Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(label);
    hash.update("\0");
    hash.update(String(value));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// Copies every file of a complete entry into outDir; false when the entry is
// absent or a file vanished, so the caller builds instead.
export function restoreWasmArtifacts({ root, key, files, outDir }) {
  const entry = join(root, key);
  if (!files.every((file) => existsSync(join(entry, file)))) return false;
  try {
    for (const file of files) cpSync(join(entry, file), join(outDir, file));
  } catch {
    return false;
  }
  const now = new Date();
  try {
    utimesSync(entry, now, now);
  } catch {
    // A concurrent prune removed the entry after the copy; the copy is complete.
  }
  return true;
}

// Entries are staged and renamed into place, so a reader never sees a partial
// one. An existing entry stays unless replace is set: the same key means the
// same inputs. Replacing evicts an entry built from an input the key missed; a
// restore that races it fails and builds instead. An entry missing a file never
// restores, so it is replaced too.
export function storeWasmArtifacts({ root, key, files, sourceDir, keep = DEFAULT_KEEP, replace = false }) {
  const entry = join(root, key);
  mkdirSync(root, { recursive: true });
  if (replace || !files.every((file) => existsSync(join(entry, file)))) rmSync(entry, { recursive: true, force: true });
  if (!existsSync(entry)) {
    const staging = join(root, `.tmp-${key}-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    try {
      mkdirSync(staging);
      for (const file of files) cpSync(join(sourceDir, file), join(staging, file));
      renameSync(staging, entry);
    } catch (error) {
      // A concurrent writer renamed the same key first.
      if (!existsSync(entry)) throw error;
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  pruneWasmArtifacts(root, keep);
}

export function pruneWasmArtifacts(root, keep = DEFAULT_KEEP, now = Date.now()) {
  const entries = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    if (/^\.tmp-[0-9a-f]{64}-\d+$/.test(name)) {
      // Staging directories of a crashed build; a live build finishes well within the hour.
      if (now - stats.mtimeMs > STALE_TMP_MS) rmSync(path, { recursive: true, force: true });
      continue;
    }
    // ROM_WEAVER_WASM_CACHE_DIR MAY name a directory holding other files; only entries this module wrote are pruned.
    if (/^[0-9a-f]{64}$/.test(name)) entries.push({ path, mtimeMs: stats.mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { path } of entries.slice(keep)) rmSync(path, { recursive: true, force: true });
}
