#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
export const WASM_ARTIFACT = path.join(PACKAGE_DIR, "src", "wasm", "rom-weaver-app.wasm");

export const mtimeMs = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

export const newestMtime = (roots, files, extensions) => {
  let newest = { mtimeMs: 0, file: null };
  const consider = (filePath, ms) => {
    if (ms !== null && ms > newest.mtimeMs) newest = { mtimeMs: ms, file: filePath };
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !extensions.has(path.extname(entry.name))) continue;
      consider(full, mtimeMs(full));
    }
  };

  for (const root of roots) walk(root);
  for (const file of files) consider(file, mtimeMs(file));
  return newest;
};

export const run = (command, args, { env = process.env, label, log }) => {
  log("info", `running: ${command} ${args.join(" ")}`);
  const result = childProcess.spawnSync(command, args, { cwd: REPO_ROOT, env, stdio: "inherit" });
  if (result.error) {
    if (result.error.code === "ENOENT") log("error", `${label} failed: command not found: ${command}`);
    else log("error", `${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    log("error", `${label} exited with status ${result.status}`);
    process.exit(result.status || 1);
  }
};
