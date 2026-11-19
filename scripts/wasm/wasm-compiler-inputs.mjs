#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { pinTreeEntries } from "./wasm-version-pin.mjs";

const STANDALONE_RUST_TARGET =
  /(?:^|\/)(?:tests?|examples|benches)\/|\/src\/(?:.*\/)?test[^/]*\.rs$/u;

// No crate embeds its Markdown (no `include_str!` of a `.md` file). LICENSE
// files stay inputs: gen-third-party-licenses.mjs copies them into the
// module's attribution bundle. Vendored trees are never narrowed.
const CRATE_PROSE = /\.md$/u;

// Gitignored identify packs that only the native CLI bundles (`bundled-identify-data`).
const IDENTIFY_DATA = "crates/rom-weaver-cli/data/";

export const isWasmCompilerInput = (path) =>
  path.startsWith("crates/") &&
  !path.startsWith(IDENTIFY_DATA) &&
  !STANDALONE_RUST_TARGET.test(path) &&
  (path.includes("/vendor/") || !CRATE_PROSE.test(path));

const filterTree = (tree, select) =>
  tree
    .split(/\r?\n/u)
    .filter((line) => {
      if (!line) return false;
      const separator = line.indexOf("\t");
      return separator !== -1 && select(line.slice(separator + 1));
    })
    .join("\n");

export const filterWasmCompilerInputTree = (tree) => filterTree(tree, isWasmCompilerInput);

export const isWasmCacheInput = (path) => {
  if (path.startsWith("crates/")) return isWasmCompilerInput(path);
  if (path.startsWith("scripts/wasm/")) {
    return !path.endsWith(".test.mjs") && path !== "scripts/wasm/README.md";
  }
  return true;
};

export const filterWasmCacheInputTree = (tree) => filterTree(tree, isWasmCacheInput);

const readGitBlob = (oid) => execFileSync("git", ["cat-file", "blob", oid], { encoding: "utf8" });

// The module never embeds the workspace's own version, so the cache key ignores it.
const pinCacheInputTree = (tree) => {
  const entries = filterWasmCacheInputTree(tree).split("\n").filter(Boolean);
  return pinTreeEntries(entries, readGitBlob).join("\n");
};

const main = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const tree = Buffer.concat(chunks).toString("utf8");
  const filtered = process.argv.includes("--cache-inputs") ? pinCacheInputTree(tree) : filterWasmCompilerInputTree(tree);
  if (filtered) process.stdout.write(`${filtered}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
