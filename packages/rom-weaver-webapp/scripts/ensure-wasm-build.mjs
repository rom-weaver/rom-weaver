#!/usr/bin/env node

// Prebuild step for `npm run dev`. Cargo owns freshness checks, so branch
// switches and older source mtimes cannot leave a stale browser module.
//
// Set ROM_WEAVER_DEV_SKIP_WASM=1 to skip the build entirely (e.g. worktrees with a
// copied artifact and no local WASI toolchain).

import process from "node:process";
import { run } from "./build-utils.mjs";

const log = (level, message) => console.log(`[ensure-wasm-build] ${level}: ${message}`);

if (String(process.env.ROM_WEAVER_DEV_SKIP_WASM || "") === "1") {
  log("warn", "ROM_WEAVER_DEV_SKIP_WASM=1 set; skipping WASM build");
} else {
  run("mise", ["run", "build-wasm"], { label: "build-wasm", log });
}
