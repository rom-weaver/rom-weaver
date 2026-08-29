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
  rustToolchain,
  stripVersion,
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
  // The compiler identity and its size flags, so a stable fallback module is
  // never reused as if it were the smaller nightly one.
  add("rust-toolchain", rustToolchain);
  add("build-script", fs.readFileSync(buildScriptPath));
  add("fingerprint-script", fs.readFileSync(fileURLToPath(import.meta.url)));
  add("brotli-quality", brotliQuality);
  add("brotli-version", brotliVersion);
  add("strip-version", stripVersion);
  add("wasm-opt-version", wasmOptVersion);
  return hash.digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [artifactPath, buildScriptPath, brotliQuality, wasmOptVersion, stripVersion, brotliVersion, rustToolchain] =
    process.argv.slice(2);
  if (!rustToolchain) {
    process.stderr.write(
      "usage: wasm-prod-fingerprint.mjs <artifact> <build-script> <brotli-quality> <wasm-opt-version> <strip-version> <brotli-version> <rust-toolchain>\n",
    );
    process.exit(2);
  }
  process.stdout.write(
    `${createWasmProdFingerprint({
      artifactPath,
      brotliQuality,
      brotliVersion,
      buildScriptPath,
      rustToolchain,
      stripVersion,
      wasmOptVersion,
    })}\n`,
  );
}
