import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { isWasmCompilerInput } from "./wasm-compiler-inputs.mjs";

const SOURCE_ROOTS = ["crates", "scripts/wasm"];
const SOURCE_FILES = ["Cargo.lock", "Cargo.toml", ".cargo/config.toml", ".config/mise.toml"];

// Dotfiles (editor swap files, .DS_Store) and crate-local target/ trees are never compiler inputs;
// hashing them would force a full WASM rebuild whenever a tool leaves one behind.
const isLocalNoise = (path) => {
  const name = posix.basename(path);
  return name.startsWith(".") || name === "target";
};

const collectFiles = (root, path, files) => {
  if (isLocalNoise(path)) return;
  const entry = join(root, path);
  let stats;
  try {
    stats = statSync(entry);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (!path.startsWith("crates/") || isWasmCompilerInput(path)) files.push(path);
    return;
  }
  for (const child of readdirSync(entry)) collectFiles(root, posix.join(path, child), files);
};

const wasmSourceFiles = (root) => {
  const files = [...SOURCE_FILES];
  for (const sourceRoot of SOURCE_ROOTS) collectFiles(root, sourceRoot, files);
  return files.sort();
};

// File timestamps come from a coarse kernel clock that lags Date.now() by a few
// milliseconds, so a write just after `sinceMs` can carry an earlier time.
const TIMESTAMP_SLACK_MS = 1000;

// True when a fingerprinted file was written at or after `sinceMs`, which an
// edit reverted before a later fingerprint still shows. ctime also catches a
// revert that restored the old mtime (`cp -p`).
export const wasmSourcesModifiedSince = (root, sinceMs) =>
  wasmSourceFiles(root).some((path) => {
    try {
      const { mtimeMs, ctimeMs } = statSync(join(root, path));
      return Math.max(mtimeMs, ctimeMs) >= sinceMs - TIMESTAMP_SLACK_MS;
    } catch {
      return true;
    }
  });

export const createWasmSourceFingerprint = (root) => {
  const hash = createHash("sha256");
  for (const path of wasmSourceFiles(root)) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
};
