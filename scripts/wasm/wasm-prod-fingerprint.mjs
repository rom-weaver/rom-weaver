#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function createWasmProdFingerprint({
  artifactPath,
  brotliQuality,
  brotliVersion,
  buildScriptPath,
  stripVersion,
  wasmOptArgs = [],
  wasmOptVersion,
}) {
  const hash = createHash("sha256");
  const add = (label, value) => {
    hash.update(label);
    hash.update("\0");
    hash.update(value);
    hash.update("\0");
  };

  add("artifact", fs.readFileSync(artifactPath));
  add("build-script", fs.readFileSync(buildScriptPath));
  add("fingerprint-script", fs.readFileSync(fileURLToPath(import.meta.url)));
  add("brotli-quality", brotliQuality);
  add("brotli-version", brotliVersion);
  add("strip-version", stripVersion);
  add("wasm-opt-version", wasmOptVersion);
  // The build-script hash above already covers a flag list defined in
  // build-app.mjs; this explicit input keeps invalidation correct if the
  // flags ever become env- or argv-driven.
  add("wasm-opt-args", JSON.stringify(wasmOptArgs));
  return hash.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [artifactPath, buildScriptPath, brotliQuality, wasmOptVersion, stripVersion, brotliVersion, ...wasmOptArgs] =
    process.argv.slice(2);
  if (!brotliVersion) {
    process.stderr.write(
      "usage: wasm-prod-fingerprint.mjs <artifact> <build-script> <brotli-quality> <wasm-opt-version> <strip-version> <brotli-version> [wasm-opt-arg...]\n",
    );
    process.exit(2);
  }
  process.stdout.write(
    `${createWasmProdFingerprint({
      artifactPath,
      brotliQuality,
      brotliVersion,
      buildScriptPath,
      stripVersion,
      wasmOptArgs,
      wasmOptVersion,
    })}\n`,
  );
}
