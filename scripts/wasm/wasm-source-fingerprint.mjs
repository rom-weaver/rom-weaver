import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { isWasmCompilerInput } from "./wasm-compiler-inputs.mjs";

const SOURCE_ROOTS = ["crates", "scripts/wasm"];
const SOURCE_FILES = ["Cargo.lock", "Cargo.toml", ".cargo/config.toml", ".config/mise.toml"];

const collectFiles = (root, path, files) => {
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

export const createWasmSourceFingerprint = (root) => {
  const files = [...SOURCE_FILES];
  for (const sourceRoot of SOURCE_ROOTS) collectFiles(root, sourceRoot, files);
  files.sort();

  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
};
