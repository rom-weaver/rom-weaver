#!/usr/bin/env node

// Prebuild step for `npm run dev`. The copied artifact carries the fingerprint
// of the WASM inputs that produced it, so unchanged worktrees skip Cargo and
// the post-build strip/license work entirely.
//
// Set ROM_WEAVER_DEV_SKIP_WASM=1 to skip the build entirely (e.g. worktrees with a
// copied artifact and no local WASI toolchain).

import { existsSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  createWasmSourceFingerprint,
  recordedSourceFingerprint,
} from "../../../scripts/wasm/wasm-source-fingerprint.mjs";
import { REPO_ROOT, run, WASM_ARTIFACT } from "./build-utils.mjs";

const log = (level, message) => console.log(`[ensure-wasm-build] ${level}: ${message}`);

export const shouldBuildWasm = ({ artifactExists, recordedFingerprint, sourceFingerprint }) =>
  !artifactExists || recordedFingerprint !== sourceFingerprint;

const main = (env = process.env) => {
  if (String(env.ROM_WEAVER_DEV_SKIP_WASM || "") === "1") {
    log("warn", "ROM_WEAVER_DEV_SKIP_WASM=1 set; skipping WASM build");
  } else if (
    shouldBuildWasm({
      artifactExists: existsSync(WASM_ARTIFACT),
      recordedFingerprint: recordedSourceFingerprint(WASM_ARTIFACT),
      sourceFingerprint: createWasmSourceFingerprint(REPO_ROOT),
    })
  ) {
    run("mise", ["run", "build-wasm"], { label: "build-wasm", log });
  } else {
    log("info", "WASM inputs unchanged; skipping build-wasm");
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
