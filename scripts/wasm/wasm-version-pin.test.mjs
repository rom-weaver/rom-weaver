import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { git, isolatedEnv } from "../test-git.mjs";
import { createWasmSourceFingerprint } from "./wasm-source-fingerprint.mjs";

const COMPILER_INPUTS = fileURLToPath(new URL("./wasm-compiler-inputs.mjs", import.meta.url));

// The manifests release-please bumps, at workspace `version`. scripts/ci/parity-cli-key.test.mjs
// covers which versions are pinned.
const workspaceManifests = (version, { serdeFeature = "derive" } = {}) => ({
  "Cargo.toml": `[workspace]\nmembers = ["crates/app", "crates/core"]\n\n[workspace.package]\nedition = "2024"\nversion = "${version}"\n\n[workspace.dependencies]\nserde = { version = "1.2.3", features = ["${serdeFeature}"] }\n`,
  "Cargo.lock": `version = 4\n\n[[package]]\nname = "app"\nversion = "${version}"\ndependencies = [\n "core",\n]\n\n[[package]]\nname = "core"\nversion = "${version}"\n\n[[package]]\nname = "serde"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`,
  "crates/app/Cargo.toml": `[package]\nname = "app"\nversion.workspace = true\n\n[dependencies]\ncore = { path = "../core", version = "${version}" }\nserde = { version = "1.2.3" }\n`,
  "crates/core/Cargo.toml": `[package]\nname = "core"\nversion.workspace = true\n`,
});

test("the local source fingerprint ignores a version-only release but not other manifest edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-version-pin-"));
  const fingerprintOf = (manifests) => {
    for (const [file, text] of Object.entries(manifests)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    }
    return createWasmSourceFingerprint(root);
  };
  try {
    const released = fingerprintOf({ ...workspaceManifests("1.2.3"), ".cargo/config.toml": "", ".config/mise.toml": "" });
    assert.equal(fingerprintOf(workspaceManifests("1.2.4")), released);
    assert.notEqual(fingerprintOf(workspaceManifests("1.2.4", { serdeFeature: "std" })), released);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the CI cache basis ignores a version-only release but not other manifest edits", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-cache-basis-"));
  // The same pipeline .github/actions/wasm-cache/action.yml runs on the committed tree.
  const basisOf = (manifests) => {
    for (const [file, text] of Object.entries(manifests)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--allow-empty", "-m", "change");
    const tree = git(repo, "ls-tree", "-r", "HEAD");
    return execFileSync(process.execPath, [COMPILER_INPUTS, "--cache-inputs"], { cwd: repo, encoding: "utf8", env: isolatedEnv(), input: tree });
  };
  try {
    git(repo, "init", "-q");
    const released = basisOf({ ...workspaceManifests("1.2.3"), "crates/core/src/lib.rs": "" });
    assert.match(released, /\tcrates\/core\/src\/lib\.rs\n/);
    assert.equal(basisOf(workspaceManifests("10.20.30")), released);
    assert.notEqual(basisOf(workspaceManifests("10.20.30", { serdeFeature: "std" })), released);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
