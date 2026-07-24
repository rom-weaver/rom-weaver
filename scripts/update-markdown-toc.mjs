#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "docs",
  ".github/CODE_OF_CONDUCT.md",
  ".github/RELEASING.md",
  ".github/SECURITY.md",
  "packages/rom-weaver-webapp/design/icon-masters/README.md",
  "packages/rom-weaver-webapp/src/wasm/README.md",
  "scripts/wasm/README.md",
];

const isDirectory = (file) => {
  try { return statSync(file).isDirectory(); } catch { return false; }
};

// doctoc only filters by extension when it walks a directory; an explicit file
// argument is rewritten whatever it is. lefthook hands us the staged paths under
// docs/, so without this guard a staged docs/*.json gets TOC markers appended
// and stops being valid JSON.
export function tocFiles(files, directory = isDirectory) {
  const readme = files.includes("README.md");
  const other = files.filter((file) => file !== "README.md" && (file.endsWith(".md") || directory(file)));
  return { other, readme };
}

export function main(files = process.argv.slice(2)) {
  const selected = tocFiles(files.length ? files : DEFAULT_FILES);
  const command = ["--no-install", "doctoc", "--github", "--toc-pragma-style", "compact", "--toc-location", "before", "--minlevel", "2"];
  if (selected.readme) {
    const result = spawnSync("npx", [...command, "--notitle", "--maxlevel", "2", "README.md"], { stdio: "inherit" });
    if (result.status !== 0) return result.status ?? 1;
  }
  if (selected.other.length) return spawnSync("npx", [...command, "--title", "## Table of contents", ...selected.other], { stdio: "inherit" }).status ?? 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
