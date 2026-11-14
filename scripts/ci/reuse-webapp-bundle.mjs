#!/usr/bin/env node

// Decides whether a deploy with no bundle may restamp the restored bundle instead of building.
// It may restamp only if CI's change rule sees no webapp change since then.
// This run's `wasm-prod` files MUST also match the bundle's manifest.
// Writes `reuse=true|false` to $GITHUB_OUTPUT.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { changedPathsBetween, classifyChanges } from "./classify-changes.mjs";
import { checkManifestEntries, parseManifest } from "./wasm-manifest.mjs";

const BUNDLE_COMMIT_FILE = "build/bundle-commit";
const BUNDLE_WASM_MANIFEST_FILE = "build/bundle-wasm.sha256";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Returns why the bundle restored into `webappDir` cannot be reused, or null when it can. */
export function bundleRejection({ repoDir, wasmDir, webappDir }) {
  const commitPath = join(webappDir, BUNDLE_COMMIT_FILE);
  if (!existsSync(commitPath)) return "no tested bundle was restored";
  const commit = readFileSync(commitPath, "utf8").trim();
  if (!COMMIT_SHA.test(commit)) return `${BUNDLE_COMMIT_FILE} holds no commit`;

  let changedPaths;
  try {
    changedPaths = changedPathsBetween(commit, "HEAD", repoDir);
  } catch (error) {
    return `cannot diff ${commit} against HEAD: ${error.message}`;
  }
  if (classifyChanges(changedPaths).webapp) return `webapp inputs changed since ${commit}`;

  let wasmManifest;
  try {
    wasmManifest = parseManifest(readFileSync(join(webappDir, BUNDLE_WASM_MANIFEST_FILE), "utf8"));
  } catch (error) {
    return `cannot read ${BUNDLE_WASM_MANIFEST_FILE}: ${error.message}`;
  }
  try {
    checkManifestEntries(wasmDir, wasmManifest);
  } catch (error) {
    return `wasm-prod ${error.message}`;
  }
  return null;
}

export function main(repoDir = process.cwd(), env = process.env) {
  const webappDir = join(repoDir, "packages", "rom-weaver-webapp");
  const rejection = bundleRejection({ repoDir, wasmDir: join(webappDir, "src", "wasm"), webappDir });
  console.log(rejection ? `building the webapp: ${rejection}` : "restamping the tested webapp bundle");
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `reuse=${rejection === null}\n`);
  return rejection === null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
