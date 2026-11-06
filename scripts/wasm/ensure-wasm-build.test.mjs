import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { shouldBuildWasm } from "../../packages/rom-weaver-webapp/scripts/ensure-wasm-build.mjs";
import { createWasmSourceFingerprint, wasmSourcesModifiedSince } from "./wasm-source-fingerprint.mjs";

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
    fs.mkdirSync(path.join(root, "crates/example/data"), { recursive: true });
    const pack = path.join(root, "crates/example/data/builtin-save.json");
    fs.writeFileSync(pack, '{"schema_version":1,"games":[]}');
    const withPack = createWasmSourceFingerprint(root);
    fs.writeFileSync(pack, '{"schema_version":1,"games":[{"id":"changed"}]}');
    assert.notEqual(createWasmSourceFingerprint(root), withPack);

    const sourceFingerprint = createWasmSourceFingerprint(root);
    fs.mkdirSync(path.join(root, "crates/example/tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "crates/example/tests/integration.rs"), "test only");
    assert.equal(createWasmSourceFingerprint(root), sourceFingerprint);

    fs.writeFileSync(path.join(root, "crates/example/.lib.rs.swp"), "editor swap");
    fs.writeFileSync(path.join(root, "crates/example/.DS_Store"), "finder");
    fs.mkdirSync(path.join(root, "crates/example/target/debug"), { recursive: true });
    fs.writeFileSync(path.join(root, "crates/example/target/debug/build.rs"), "build output");
    assert.equal(createWasmSourceFingerprint(root), sourceFingerprint);

    fs.mkdirSync(path.join(root, "crates/example/src"), { recursive: true });
    fs.writeFileSync(path.join(root, "crates/example/src/embedded.json"), '{"value":1}');
    assert.notEqual(createWasmSourceFingerprint(root), sourceFingerprint);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("an edit reverted since a source read still counts as modified", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-wasm-source-"));
  try {
    const past = new Date(Date.now() - 60_000);
    const source = path.join(root, "crates/example/lib.rs");
    for (const file of ["Cargo.lock", "Cargo.toml", ".cargo/config.toml", ".config/mise.toml", "crates/example/lib.rs"]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), "one");
      fs.utimesSync(path.join(root, file), past, past);
    }
    // ctime cannot be backdated, so wait out the check's timestamp slack.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const readAt = Date.now();
    assert.equal(wasmSourcesModifiedSince(root, readAt), false);
    fs.writeFileSync(source, "two");
    fs.writeFileSync(source, "one");
    // A revert that also restores the old mtime still updates ctime.
    fs.utimesSync(source, past, past);
    assert.equal(wasmSourcesModifiedSince(root, readAt), true);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
