#!/usr/bin/env node

// Prebuild step for `npm run dev`. Cargo owns freshness checks, so branch
// switches and older source mtimes cannot leave a stale browser module.
//
// Two stages: build the wasm binary into the @rom-weaver/wasm package, then
// bundle the package (esbuild) so the webapp consumes a fresh dist. The webapp
// resolves the runtime through the built package, never its TypeScript source.
//
// Set ROM_WEAVER_DEV_SKIP_WASM=1 to skip the cargo/WASI binary build (e.g.
// worktrees with a copied artifact and no local WASI toolchain); the package is
// still re-bundled from the existing binary.

import process from "node:process";
import { fileURLToPath } from "node:url";
import { run } from "./build-utils.mjs";

const log = (level, message) => console.log(`[ensure-wasm-build] ${level}: ${message}`);

if (String(process.env.ROM_WEAVER_DEV_SKIP_WASM || "") === "1") {
  log("warn", "ROM_WEAVER_DEV_SKIP_WASM=1 set; skipping WASM binary build");
} else {
  run("mise", ["run", "build-wasm"], { label: "build-wasm", log });
}

const packageBuild = fileURLToPath(new URL("../../rom-weaver-wasm/scripts/build.mjs", import.meta.url));
run("node", [packageBuild], { label: "build @rom-weaver/wasm", log });
