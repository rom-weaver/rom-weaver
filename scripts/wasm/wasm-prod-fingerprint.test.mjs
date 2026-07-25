import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWasmProdFingerprint } from "./wasm-prod-fingerprint.mjs";

test("production fingerprint covers the raw artifact and post-processing inputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-wasm-fingerprint-"));
  try {
    const artifactPath = path.join(dir, "app.wasm");
    const buildScriptPath = path.join(dir, "build.mjs");
    fs.writeFileSync(artifactPath, "wasm-a");
    fs.writeFileSync(buildScriptPath, "wasm-opt -O4");
    const options = {
      artifactPath,
      brotliQuality: "11",
      brotliVersion: "brotli 1",
      buildScriptPath,
      stripVersion: "strip 1",
      wasmOptVersion: "wasm-opt 1",
    };
    const initial = createWasmProdFingerprint(options);

    assert.equal(createWasmProdFingerprint(options), initial);
    fs.writeFileSync(artifactPath, "wasm-b");
    assert.notEqual(createWasmProdFingerprint(options), initial);
    fs.writeFileSync(artifactPath, "wasm-a");
    fs.writeFileSync(buildScriptPath, "wasm-opt -O3");
    assert.notEqual(createWasmProdFingerprint(options), initial);
    fs.writeFileSync(buildScriptPath, "wasm-opt -O4");
    assert.notEqual(createWasmProdFingerprint({ ...options, wasmOptVersion: "wasm-opt 2" }), initial);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});
