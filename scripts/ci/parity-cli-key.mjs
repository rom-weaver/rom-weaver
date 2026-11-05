#!/usr/bin/env node

// Prints the cache key for the native CLI that the parity job builds.
//
// The key covers the repository files the build reads, with one exception: the workspace's own
// version. The runner image (its C compiler and system packages) is not keyed; KEY_EPOCH discards
// the cache when that matters.
// release-please rewrites it in Cargo.toml, crates/*/Cargo.toml (the path-dependency pins), and
// Cargo.lock on every release pull request, and that changes the binary only by the
// `CARGO_PKG_VERSION` strings compiled into it (`--version`, the xdelta application header,
// SARIF and identify-setup output). Hashing those files verbatim would rebuild the CLI for
// every release.
//
// Normalizing MUST NOT hide anything else: a changed third-party version, feature list, path, or
// source file still changes the key. The binary a cache hit restores reports an older version, so
// the parity and performance checks MUST NOT compare anything version-dependent (see
// parity-cli-key.test.mjs).
//
// Usage: node scripts/ci/parity-cli-key.mjs [<revision>]    (default HEAD)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

// What the native CLI build reads, including every script setup-build-env runs. parity.yml and this
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
  "scripts/ensure-emulatorjs.mjs",
  "scripts/ci/install-system-dependencies.mjs",
  "scripts/ci/select-mise-tools.mjs",
  "scripts/ci/parity-cli-key.mjs",
];

// Bump to discard every saved binary when the key's meaning changes.
export const KEY_EPOCH = "e2";

const VERSION_ASSIGNMENT = /^(\s*version\s*=\s*)"[^"]*"/u;
const INLINE_VERSION = /((?<![\w-])version\s*=\s*)"[^"]*"/u;
const PLACEHOLDER = '"0.0.0"';

// A `[package]` or `[workspace.package]` version, or the `version` beside a `path` in a
// dependency (inline table or its own table), is the workspace's own and moves with every release.
export function normalizeCargoToml(text) {
  const sections = [{ header: "", body: [] }];
  for (const line of text.split("\n")) {
    if (/^\s*\[/u.test(line)) sections.push({ header: line, body: [] });
    else sections.at(-1).body.push(line);
  }
  return sections
    .flatMap(({ header, body }) => {
      const ownVersion =
        /^\s*\[(workspace\.)?package\]\s*$/u.test(header) ||
        body.some((line) => /^\s*path\s*=/u.test(line));
      const lines = body.map((line) => {
        if (ownVersion && VERSION_ASSIGNMENT.test(line))
          return line.replace(VERSION_ASSIGNMENT, `$1${PLACEHOLDER}`);
        if (/(?<![\w-])path\s*=\s*"/u.test(line) && INLINE_VERSION.test(line))
          return line.replace(INLINE_VERSION, `$1${PLACEHOLDER}`);
        return line;
      });
      return header === "" ? lines : [header, ...lines];
    })
    .join("\n");
}

// A lockfile entry without a `source` is a workspace member (or path dependency); registry and git
// packages carry one and keep their versions.
export function normalizeCargoLock(text) {
  return text
    .split(/\n(?=\[\[package\]\]\n)/u)
    .map((block) =>
      block.startsWith("[[package]]") && !/^source\s*=/mu.test(block)
        ? block.replace(/^(version\s*=\s*)"[^"]*"/mu, `$1${PLACEHOLDER}`)
        : block,
    )
    .join("\n");
}

export function normalizeFile(path, text) {
  if (path === "Cargo.lock") return normalizeCargoLock(text);
  if (path === "Cargo.toml" || path.endsWith("/Cargo.toml")) return normalizeCargoToml(text);
  return null;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// `entries` are `git ls-tree -r` lines: "<mode> <type> <oid>\t<path>". `readBlob(oid)` returns the
// file text.
export function keyBasis(entries, readBlob) {
  return entries.map((entry) => {
    const [meta, path] = entry.split("\t");
    const [mode, type, oid] = meta.split(" ");
    const normalized = type === "blob" ? normalizeFile(path, readBlob(oid)) : null;
    return `${mode} ${type} ${normalized === null ? oid : `normalized-${sha256(normalized)}`}\t${path}`;
  });
}

export function keyHash(entries, readBlob) {
  if (entries.length === 0) throw new Error("no files matched the parity CLI key paths");
  return sha256(`${keyBasis(entries, readBlob).join("\n")}\n`);
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
