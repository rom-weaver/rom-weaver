#!/usr/bin/env node

// Prints the cache key for the native CLI that the parity job builds.
//
// The key covers the repository files the build reads, with one exception: the workspace's own
// version (scripts/wasm/wasm-version-pin.mjs). The runner image (its C compiler and system
// packages) is not keyed; KEY_EPOCH discards the cache when that matters.
// A release changes the binary only by the `CARGO_PKG_VERSION` strings compiled into it
// (`--version`, the xdelta application header, SARIF and identify-setup output). Hashing the
// manifests verbatim would rebuild the CLI for every release.
//
// The binary a cache hit restores reports an older version, so
// the parity and performance checks MUST NOT compare anything version-dependent (see
// parity-cli-key.test.mjs).
//
// Usage: node scripts/ci/parity-cli-key.mjs [<revision>]    (default HEAD)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { pinTreeEntries } from "../wasm/wasm-version-pin.mjs";

// What the native CLI build reads, including every script setup-build-env runs and the local
// modules those import. parity.yml and this
// script are included so an edit to how the binary is built or keyed starts from a clean cache.
export const KEY_PATHS = [
  "crates",
  "Cargo.lock",
  "Cargo.toml",
  ".cargo",
  ".config/mise.toml",
  ".github/actions/setup-build-env",
  ".github/workflows/parity.yml",
  "scripts/install-jwasm.sh",
  "packages/rom-weaver-webapp/scripts/ensure-emulatorjs.mjs",
  "scripts/run-main.mjs",
  "scripts/ci/install-system-dependencies.mjs",
  "scripts/ci/mise-disable-tools.mjs",
  "scripts/ci/select-mise-tools.mjs",
  "scripts/ci/parity-cli-key.mjs",
  "scripts/wasm/wasm-version-pin.mjs",
];

// Bump to discard every saved binary when the key's meaning changes.
export const KEY_EPOCH = "e2";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function keyHash(entries, readBlob) {
  if (entries.length === 0) throw new Error("no files matched the parity CLI key paths");
  return sha256(`${pinTreeEntries(entries, readBlob).join("\n")}\n`);
}

export function parityCliKey(runnerOs, hash) {
  return `parity-cli-${runnerOs}-${KEY_EPOCH}-${hash}`;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const revision = process.argv[2] ?? "HEAD";
  const entries = git(["ls-tree", "-r", revision, "--", ...KEY_PATHS])
    .split("\n")
    .filter(Boolean);
  const hash = keyHash(entries, (oid) => git(["cat-file", "blob", oid]));
  process.stdout.write(`${parityCliKey(process.env.RUNNER_OS ?? "local", hash)}\n`);
}
