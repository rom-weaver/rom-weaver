#!/usr/bin/env node

import childProcess from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

const PROFILES = {
  fast: {
    buildName: "wasm build",
    suites: [
      ["CLI", "cargo", ["test", "-p", "rom-weaver-cli", "--test", "cli_smoke"], REPO_ROOT],
      ["WASM", "npm", ["run", "test:browser:wasm"], PACKAGE_DIR],
      ["browser", "npm", ["run", "test:browser:parallel"], PACKAGE_DIR],
      ["webapp E2E", "npm", ["run", "test:e2e:webapp"], PACKAGE_DIR],
    ],
    wallTimeLabel: "Fast E2E wall time",
  },
  nightly: {
    buildName: "WASM build",
    suites: [
      ["CLI matrix", "cargo", ["test", "-p", "rom-weaver-cli", "--test", "cli_smoke"], REPO_ROOT],
      ["exhaustive WASM matrix", "npm", ["run", "test:browser:wasm:exhaustive"], PACKAGE_DIR],
      ["webapp E2E", "npm", ["run", "test:e2e:webapp"], PACKAGE_DIR],
    ],
  },
};

const run = (name, command, args, cwd) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = childProcess.spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    child.on("error", (error) => resolve({ code: 1, durationMs: Date.now() - startedAt, error, name }));
    child.on("close", (code) => resolve({ code: code ?? 1, durationMs: Date.now() - startedAt, name }));
  });

const main = async () => {
  const profile = PROFILES[process.argv[2]];
  if (!profile) throw new Error(`unknown E2E profile: ${process.argv[2] ?? "(missing)"}`);

  if (process.env.ROM_WEAVER_E2E_SKIP_WASM_BUILD !== "1") {
    const build = await run(profile.buildName, "mise", ["run", "build-wasm"], REPO_ROOT);
    if (build.code !== 0) process.exit(build.code);
  }

  const startedAt = Date.now();
  const results = await Promise.all(profile.suites.map(([name, command, args, cwd]) => run(name, command, args, cwd)));
  const elapsedSeconds = profile.wallTimeLabel ? ((Date.now() - startedAt) / 1000).toFixed(1) : null;
  for (const result of results) {
    const duration = (result.durationMs / 1000).toFixed(1);
    process.stdout.write(`${result.code === 0 ? "PASS" : "FAIL"} ${result.name} (${duration}s)\n`);
    if (result.error) process.stderr.write(`${result.error.stack || result.error}\n`);
  }
  if (profile.wallTimeLabel) {
    process.stdout.write(`${profile.wallTimeLabel}: ${elapsedSeconds}s\n`);
  }
  if (results.some((result) => result.code !== 0)) process.exitCode = 1;
};

main().catch((error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  process.exitCode = 1;
});
