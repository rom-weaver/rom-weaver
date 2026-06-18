#!/usr/bin/env node

// Prebuild gate for `npm run preview`. Keeps the previewed bundle honest by
// rebuilding the prod WASM module and the vite bundle when their inputs have
// changed, then hands off to the preview server.
//
// Staleness is decided by filesystem mtimes, which reflect uncommitted (dirty)
// edits as well as committed ones:
//   - WASM rebuild  : any Rust source / Cargo manifest newer than the built
//                     artifact, or a missing artifact / missing brotli sibling
//                     (the brotli file marks a *prod* build; a dev build lacks
//                     it and must be promoted to prod for preview).
//   - vite rebuild  : missing dist, or any web source / config / WASM artifact
//                     newer than the built dist/index.html.
//
// Override with ROM_WEAVER_PREVIEW_FORCE=wasm|vite|all to force a rebuild, or
// ROM_WEAVER_PREVIEW_SKIP_BUILD=1 to skip the gate entirely.

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const WASM_ARTIFACT = path.join(PACKAGE_DIR, "src", "wasm", "rom-weaver-app.wasm");
const WASM_BROTLI = `${WASM_ARTIFACT}.br`;
const DIST_INDEX = path.join(PACKAGE_DIR, "dist", "index.html");

// Inputs that gate the WASM rebuild. Dirty edits bump these files' mtimes.
const RUST_ROOTS = [path.join(REPO_ROOT, "crates")];
const RUST_FILES = [path.join(REPO_ROOT, "Cargo.toml"), path.join(REPO_ROOT, "Cargo.lock")];
const RUST_EXTENSIONS = new Set([".rs", ".toml"]);

// Inputs that gate the vite rebuild (in addition to the WASM artifact itself).
const WEB_ROOTS = [path.join(PACKAGE_DIR, "src")];
const WEB_FILES = [
  path.join(PACKAGE_DIR, "index.html"),
  path.join(PACKAGE_DIR, "vite.config.mjs"),
  path.join(PACKAGE_DIR, "package.json"),
];

const log = (level, message) => console.log(`[ensure-preview-build] ${level}: ${message}`);

const mtimeMs = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

// Walk roots + explicit files, returning the newest mtime and the file holding it.
const newestMtime = (roots, files, extensions) => {
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

const run = (command, args, label) => {
  log("info", `running: ${command} ${args.join(" ")}`);
  const result = childProcess.spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      log("error", `${label} failed: command not found: ${command}`);
    } else {
      log("error", `${label} failed: ${result.error.message}`);
    }
    process.exit(1);
  }
  if (result.status !== 0) {
    log("error", `${label} exited with status ${result.status}`);
    process.exit(result.status || 1);
  }
};

const force = String(process.env.ROM_WEAVER_PREVIEW_FORCE || "").toLowerCase();
const forceWasm = force === "wasm" || force === "all";
const forceVite = force === "vite" || force === "all";

if (String(process.env.ROM_WEAVER_PREVIEW_SKIP_BUILD || "") === "1") {
  log("warn", "ROM_WEAVER_PREVIEW_SKIP_BUILD=1 set; skipping build gate");
} else {
  // --- WASM gate ----------------------------------------------------------
  const wasmMtime = mtimeMs(WASM_ARTIFACT);
  const brotliMtime = mtimeMs(WASM_BROTLI);
  const newestRust = newestMtime(RUST_ROOTS, RUST_FILES, RUST_EXTENSIONS);

  let wasmReason = null;
  if (forceWasm) wasmReason = "forced via ROM_WEAVER_PREVIEW_FORCE";
  else if (wasmMtime === null) wasmReason = "artifact missing";
  else if (brotliMtime === null) wasmReason = "brotli sibling missing (artifact is a dev build, not prod)";
  else if (newestRust.mtimeMs > wasmMtime)
    wasmReason = `Rust source newer than artifact (${path.relative(REPO_ROOT, newestRust.file)})`;

  if (wasmReason) {
    log("info", `WASM rebuild needed: ${wasmReason}`);
    run("mise", ["run", "build-wasm-prod"], "build-wasm-prod");
  } else {
    log("debug", "WASM artifact up to date; skipping prod build");
  }

  // --- vite gate ----------------------------------------------------------
  const distMtime = mtimeMs(DIST_INDEX);
  const newestWeb = newestMtime(WEB_ROOTS, WEB_FILES, null);
  const newestWasmMtime = mtimeMs(WASM_ARTIFACT) || 0;

  let viteReason = null;
  if (forceVite) viteReason = "forced via ROM_WEAVER_PREVIEW_FORCE";
  else if (distMtime === null) viteReason = "dist/index.html missing";
  else if (newestWasmMtime > distMtime) viteReason = "WASM artifact newer than dist";
  else if (newestWeb.mtimeMs > distMtime)
    viteReason = `web source newer than dist (${path.relative(PACKAGE_DIR, newestWeb.file)})`;

  if (viteReason) {
    log("info", `vite rebuild needed: ${viteReason}`);
    run("npm", ["--prefix", "packages/rom-weaver-react", "run", "build"], "vite build");
  } else {
    log("debug", "dist up to date; skipping vite build");
  }

  log("info", "build gate complete");
}
