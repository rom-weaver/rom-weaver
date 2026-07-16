#!/usr/bin/env node

import childProcess from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
const CORPUS_DIR = path.join(REPO_ROOT, "target", "e2e-corpus");

const generate = childProcess.spawnSync(
  process.execPath,
  ["scripts/generate-e2e-corpus.mjs", ...process.argv.slice(2)],
  {
    cwd: PACKAGE_DIR,
    env: process.env,
    stdio: "inherit",
  },
);
if (generate.error) throw generate.error;
if (generate.status !== 0) process.exit(generate.status || 1);

process.stdout.write("Open the printed LAN URL with /mobile-safari-matrix.html?profile=stress on the iPhone.\n");
const server = childProcess.spawn(process.execPath, ["scripts/dev-server.mjs"], {
  cwd: PACKAGE_DIR,
  env: { ...process.env, ROM_WEAVER_E2E_CORPUS_DIR: CORPUS_DIR },
  stdio: "inherit",
});
server.on("error", (error) => {
  throw error;
});
server.on("close", (code) => {
  process.exitCode = code ?? 1;
});
