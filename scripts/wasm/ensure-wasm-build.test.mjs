import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shouldBuildWasm } from "../../packages/rom-weaver-webapp/scripts/ensure-wasm-build.mjs";
import { createWasmSourceFingerprint } from "./wasm-source-fingerprint.mjs";

test("skips the dev WASM build when the copied artifact matches its source fingerprint", () => {
  assert.equal(
    shouldBuildWasm({
      artifactExists: true,
      recordedFingerprint: "same",
      sourceFingerprint: "same",
    }),
    false,
  );
});

test("builds the dev WASM artifact when it is missing or stale", () => {
  assert.equal(
    shouldBuildWasm({
      artifactExists: false,
      recordedFingerprint: "same",
      sourceFingerprint: "same",
    }),
    true,
  );
  assert.equal(
    shouldBuildWasm({ artifactExists: true, recordedFingerprint: "old", sourceFingerprint: "new" }),
    true,
  );
});

test("WASM source fingerprints change with compiler inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-wasm-source-"));
  try {
    for (const file of ["Cargo.lock", "Cargo.toml", ".cargo/config.toml", ".config/mise.toml"])
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, "Cargo.lock"), "lock");
    fs.writeFileSync(path.join(root, "Cargo.toml"), "manifest");
    fs.writeFileSync(path.join(root, ".cargo/config.toml"), "config");
    fs.writeFileSync(path.join(root, ".config/mise.toml"), "mise");
    fs.mkdirSync(path.join(root, "crates/example"), { recursive: true });
    fs.writeFileSync(path.join(root, "crates/example/lib.rs"), "one");
    fs.mkdirSync(path.join(root, "scripts/wasm"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts/wasm/build-app.mjs"), "build");

    const initial = createWasmSourceFingerprint(root);
    fs.writeFileSync(path.join(root, "crates/example/lib.rs"), "two");
    assert.notEqual(createWasmSourceFingerprint(root), initial);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
