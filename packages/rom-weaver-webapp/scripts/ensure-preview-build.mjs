#!/usr/bin/env node

// Ensure `npm run preview` serves current WASM and Vite output. The WASM build
// skips unchanged wasm-opt/Brotli work; Vite freshness uses filesystem mtimes.
//
// Override with ROM_WEAVER_PREVIEW_FORCE=wasm|vite|all to force a rebuild, or
// ROM_WEAVER_PREVIEW_SKIP_BUILD=1 to skip the gate entirely.

import path from "node:path";
import process from "node:process";
import { mtimeMs, newestMtime, PACKAGE_DIR, run, WASM_ARTIFACT } from "./build-utils.mjs";

// This runs the vite build in its own process ahead of dev-server.mjs, so it
// needs the same default or preview would serve a production-stamped bundle.
process.env.ROM_WEAVER_CHANNEL ||= "dev";

const DIST_INDEX = path.join(PACKAGE_DIR, "dist", "index.html");

// Inputs that gate the vite rebuild (in addition to the WASM artifact itself).
const WEB_ROOTS = [path.join(PACKAGE_DIR, "src")];
const WEB_FILES = [
  path.join(PACKAGE_DIR, "index.html"),
  path.join(PACKAGE_DIR, "vite.config.mjs"),
  path.join(PACKAGE_DIR, "package.json"),
];

const log = (level, message) => console.log(`[ensure-preview-build] ${level}: ${message}`);

const force = String(process.env.ROM_WEAVER_PREVIEW_FORCE || "").toLowerCase();
const forceWasm = force === "wasm" || force === "all";
const forceVite = force === "vite" || force === "all";

if (String(process.env.ROM_WEAVER_PREVIEW_SKIP_BUILD || "") === "1") {
  log("warn", "ROM_WEAVER_PREVIEW_SKIP_BUILD=1 set; skipping build gate");
} else {
  // Cargo performs the authoritative source/dependency freshness check. The
  // production build caches only its deterministic post-processing tail.
  run("mise", ["run", "build-wasm-prod"], {
    env: forceWasm ? { ...process.env, ROM_WEAVER_WASM_FORCE: "1" } : process.env,
    label: "build-wasm-prod",
    log,
  });

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
    run("npm", ["--prefix", "packages/rom-weaver-webapp", "run", "build"], { label: "vite build", log });
  } else {
    log("debug", "dist up to date; skipping vite build");
  }

  log("info", "build gate complete");
}
