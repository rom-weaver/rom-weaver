// Replaces the workspace's own crate version in Cargo manifests. release-please rewrites it in
// Cargo.toml, crates/*/Cargo.toml (the path-dependency pins), and Cargo.lock on every release.
//
// The WASM module is built from a copy of the workspace with the version pinned to
// PINNED_CRATE_VERSION. Cargo hashes each crate's version into its symbol names, so a release
// that only bumps the version would otherwise change the module's bytes and make every browser
// download it again. The module reads the real version from the host at runtime
// (`rom_weaver_core::app_version`). Cache keys use the same replacement so such a release reuses
// the module and the parity job's native CLI (scripts/ci/parity-cli-key.mjs).
//
// Replacing MUST NOT hide anything else: a changed third-party version, feature list, path, or
// source file still changes the result.

import { createHash } from "node:crypto";

// Its own string so verify-wasm-artifact.mjs can tell when a crate version reaches the module.
export const PINNED_CRATE_VERSION = "0.0.0-wasm";

const VERSION_ASSIGNMENT = /^(\s*version\s*=\s*)"[^"]*"/u;
const INLINE_VERSION = /((?<![\w-])version\s*=\s*)"[^"]*"/u;

// A `[package]` or `[workspace.package]` version, or the `version` beside a `path` in a
// dependency (inline table or its own table), is the workspace's own and moves with every release.
export function pinCargoToml(text) {
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
          return line.replace(VERSION_ASSIGNMENT, `$1"${PINNED_CRATE_VERSION}"`);
        if (/(?<![\w-])path\s*=\s*"/u.test(line) && INLINE_VERSION.test(line))
          return line.replace(INLINE_VERSION, `$1"${PINNED_CRATE_VERSION}"`);
        return line;
      });
      return header === "" ? lines : [header, ...lines];
    })
    .join("\n");
}

// A lockfile entry without a `source` is a workspace member (or path dependency); registry and git
// packages carry one and keep their versions.
export function pinCargoLock(text) {
  return text
    .split(/\n(?=\[\[package\]\]\n)/u)
    .map((block) =>
      block.startsWith("[[package]]") && !/^source\s*=/mu.test(block)
        ? block.replace(/^(version\s*=\s*)"[^"]*"/mu, `$1"${PINNED_CRATE_VERSION}"`)
        : block,
    )
    .join("\n");
}

/** `text` with the workspace's own version replaced, or null when `path` is not a Cargo manifest. */
export function pinWorkspaceVersions(path, text) {
  if (path === "Cargo.lock") return pinCargoLock(text);
  if (path === "Cargo.toml" || path.endsWith("/Cargo.toml")) return pinCargoToml(text);
  return null;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * `entries` are `git ls-tree -r` lines: "<mode> <type> <oid>\t<path>". Each manifest's object ID
 * becomes a hash of its pinned text, so a version-only release keeps the entry. `readBlob(oid)`
 * returns the file text.
 */
export function pinTreeEntries(entries, readBlob) {
  return entries.map((entry) => {
    const [meta, path] = entry.split("\t");
    const [mode, type, oid] = meta.split(" ");
    const pinned = type === "blob" ? pinWorkspaceVersions(path, readBlob(oid)) : null;
    return `${mode} ${type} ${pinned === null ? oid : `pinned-${sha256(pinned)}`}\t${path}`;
  });
}
