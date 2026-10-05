#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const STANDALONE_RUST_TARGET =
  /(?:^|\/)(?:tests?|examples|benches)\/|\/src\/(?:.*\/)?test[^/]*\.rs$/u;

export const isWasmCompilerInput = (path) =>
  path.startsWith("crates/") && !STANDALONE_RUST_TARGET.test(path);

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

export const filterWasmCacheInputTree = (tree) =>
  filterTree(tree, (path) => {
    if (path.startsWith("crates/")) return isWasmCompilerInput(path);
    if (path.startsWith("scripts/wasm/")) {
      return !path.endsWith(".test.mjs") && path !== "scripts/wasm/README.md";
    }
    return true;
  });

const main = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const filter = process.argv.includes("--cache-inputs")
    ? filterWasmCacheInputTree
    : filterWasmCompilerInputTree;
  const filtered = filter(Buffer.concat(chunks).toString("utf8"));
  if (filtered) process.stdout.write(`${filtered}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
