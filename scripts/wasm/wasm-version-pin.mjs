// Pins the workspace's own crate version in Cargo manifests, so a version-only release keeps the
// WASM module's bytes and cache keys. Pinning MUST NOT hide any other manifest or source change.

import { createHash } from "node:crypto";

// Distinct from every release version: a match means a crate version leaked into the module.
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

const isCargoManifest = (path) => path === "Cargo.lock" || path === "Cargo.toml" || path.endsWith("/Cargo.toml");

/** `text` with the workspace's own version replaced, or null when `path` is not a Cargo manifest. */
export function pinWorkspaceVersions(path, text) {
  if (!isCargoManifest(path)) return null;
  return path === "Cargo.lock" ? pinCargoLock(text) : pinCargoToml(text);
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * `entries` are `git ls-tree -r` lines: "<mode> <type> <oid>\t<path>". `readBlob(oid)` returns
 * the file text. Each manifest's object ID becomes a hash of its pinned text.
 */
export function pinTreeEntries(entries, readBlob) {
  return entries.map((entry) => {
    const [meta, path] = entry.split("\t");
    const [mode, type, oid] = meta.split(" ");
    // Reads only manifests: the key paths hold about a thousand other blobs.
    const pinned = type === "blob" && isCargoManifest(path) ? pinWorkspaceVersions(path, readBlob(oid)) : null;
    return `${mode} ${type} ${pinned === null ? oid : `pinned-${sha256(pinned)}`}\t${path}`;
  });
}
