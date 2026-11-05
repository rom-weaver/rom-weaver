import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
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

export function createCargoConfigSnapshot({ root, cwd, cargoHome, sinceMs }) {
  const files = new Set();
  const addDirectory = (directory) => {
    files.add(join(directory, "config"));
    files.add(join(directory, "config.toml"));
  };
  addDirectory(resolve(cwd, cargoHome));
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    addDirectory(join(directory, ".cargo"));
    if (directory === dirname(directory)) break;
  }
  const contents = [];
  const state = [];
  const directories = new Set();
  let modified = false;
  const recordTime = (stats) => {
    if (Math.max(stats.mtimeMs, stats.ctimeMs) >= sinceMs - TIMESTAMP_SLACK_MS) modified = true;
  };
  for (const file of [...files].sort()) {
    let directory = dirname(file);
    while (true) {
      try {
        const stats = statSync(directory);
        recordTime(stats);
        if (!directories.has(directory)) state.push([directory, stats.mtimeMs, stats.ctimeMs]);
        directories.add(directory);
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || directory === dirname(directory)) throw error;
        directory = dirname(directory);
      }
    }
    try {
      const stats = statSync(file);
      recordTime(stats);
      const label = dirname(file) === join(resolve(root), ".cargo") ? relative(root, file) : file;
      contents.push([label, readFileSync(file).toString("base64")]);
      state.push([file, stats.size, stats.mtimeMs, stats.ctimeMs]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state.push([file, null]);
    }
  }
  contents.sort(([left], [right]) => left.localeCompare(right));
  return {
    fingerprint: createHash("sha256").update(JSON.stringify(contents)).digest("hex"),
    state: JSON.stringify(state),
    modified,
  };
}
