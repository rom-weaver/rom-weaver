#!/usr/bin/env node

// A checksum manifest for the `wasm-prod` artifact. The artifact is hundreds of files (the
// third-party license texts alone are about 500), so ci.yml attests this one manifest and the
// release verifies the single attestation, then checks every downloaded file against it.
// Format: one `<sha256>  <relative path>` line per file, sorted by path, like `sha256sum`.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const MANIFEST_NAME = "wasm-prod.sha256";

// Plain relative POSIX paths only: no empty, `.`, or `..` segments, no spaces or newlines that
// could split a line.
const SAFE_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u;
const isSafePath = (path) => SAFE_PATH.test(path) && path.split("/").every((part) => part !== "." && part !== "..");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// Regular files only: a symlink or device in a downloaded artifact is a reason to refuse it.
function listFiles(root, relative = "") {
  const files = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) files.push(...listFiles(root, path));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`${path} is not a regular file`);
  }
  return files;
}

export function buildManifest(root) {
  const entries = listFiles(root).map((path) => {
    if (!isSafePath(path)) throw new Error(`unsupported path in the artifact: ${JSON.stringify(path)}`);
    return { path, hash: sha256(join(root, path)) };
  });
  if (entries.length === 0) throw new Error("the artifact has no files");
  return entries.sort(byPath).map(({ hash, path }) => `${hash}  ${path}\n`).join("");
}

export function parseManifest(text) {
  if (!text.endsWith("\n")) throw new Error("the manifest does not end with a newline");
  const entries = new Map();
  for (const line of text.slice(0, -1).split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
    if (!match) throw new Error(`malformed manifest line: ${JSON.stringify(line)}`);
    const [, hash, path] = match;
    if (!isSafePath(path)) throw new Error(`unsafe manifest path: ${JSON.stringify(path)}`);
    if (entries.has(path)) throw new Error(`duplicate manifest path: ${path}`);
    entries.set(path, hash);
  }
  return entries;
}

// Throws unless `root` holds exactly the manifest's files with exactly its hashes: a missing,
// extra, or altered file all fail.
export function checkManifest(root, text) {
  const expected = parseManifest(text);
  const actual = listFiles(root);
  for (const path of actual) if (!expected.has(path)) throw new Error(`${path} is not in the manifest`);
  const present = new Set(actual);
  for (const [path, hash] of expected) {
    if (!present.has(path)) throw new Error(`${path} is in the manifest but missing from the artifact`);
    if (sha256(join(root, path)) !== hash) throw new Error(`${path} does not match its manifest checksum`);
  }
  return [...expected.keys()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [directory, output] = process.argv.slice(2);
    if (!directory || !output) throw new Error("usage: wasm-manifest.mjs <artifact-dir> <manifest-file>");
    const text = buildManifest(directory);
    writeFileSync(output, text);
    process.stdout.write(`wrote ${text.split("\n").length - 1} checksums to ${output}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
