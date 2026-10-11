#!/usr/bin/env node

import childProcess from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

const PROFILES = {
  fast: {
    batches: [
      [
        ["CLI", "cargo", ["test", "-p", "rom-weaver-cli", "--test", "cli_smoke"], REPO_ROOT],
        ["browser", "npm", ["run", "test:browser"], PACKAGE_DIR],
      ],
      [
        ["WASM", "npm", ["run", "test:browser:wasm"], PACKAGE_DIR],
        ["webapp E2E", "npm", ["run", "test:e2e:webapp"], PACKAGE_DIR],
      ],
    ],
    wallTimeLabel: "Fast E2E wall time",
  },
  nightly: {
    batches: [
      [
        ["CLI matrix", "cargo", ["test", "-p", "rom-weaver-cli", "--test", "cli_smoke"], REPO_ROOT],
        ["exhaustive WASM matrix", "npm", ["run", "test:browser:wasm:exhaustive"], PACKAGE_DIR],
        ["webapp E2E", "npm", ["run", "test:e2e:webapp"], PACKAGE_DIR],
      ],
    ],
  },
};

const run = (name, command, args, cwd, environment) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const child = childProcess.spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.on("error", (error) => resolve({ code: 1, durationMs: Date.now() - startedAt, error, name }));
    child.on("close", (code) => resolve({ code: code ?? 1, durationMs: Date.now() - startedAt, name }));
  });

export const runE2EProfile = async (profileName, execute = run, environment = process.env) => {
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown E2E profile: ${profileName ?? "(missing)"}`);
  const production = profileName === "fast";
  const buildEnvironment = production ? { ...environment, ROM_WEAVER_CHANNEL: "prod" } : environment;
  const e2eEnvironment = production ? { ...buildEnvironment, ROM_WEAVER_E2E_USE_PREBUILT_DIST: "1" } : environment;
  const startedAt = Date.now();
  const results = [];
  const preparation = [
    environment.ROM_WEAVER_E2E_SKIP_WASM_BUILD === "1"
      ? ["ROM identify data", "node", ["scripts/ensure-identify-data.mjs"], REPO_ROOT]
      : ["WASM build", "mise", ["run", production ? "build-wasm-prod" : "build-wasm"], REPO_ROOT],
    ...(production
      ? [
          ["production webapp build", "npm", ["run", "build"], PACKAGE_DIR],
          ["asset size budgets", "npm", ["run", "check:size"], PACKAGE_DIR],
        ]
      : []),
  ];
  for (const step of preparation) {
    const result = await execute(...step, buildEnvironment);
    results.push(result);
    if (result.code !== 0) return { durationMs: Date.now() - startedAt, results };
  }
  for (const batch of profile.batches) {
    results.push(...(await Promise.all(batch.map((step) => execute(...step, e2eEnvironment)))));
  }
  return { durationMs: Date.now() - startedAt, results };
};

const main = async () => {
  const profileName = process.argv[2];
  const { durationMs, results } = await runE2EProfile(profileName);
  for (const result of results) {
    const duration = (result.durationMs / 1000).toFixed(1);
    process.stdout.write(`${result.code === 0 ? "PASS" : "FAIL"} ${result.name} (${duration}s)\n`);
    if (result.error) process.stderr.write(`${result.error.stack || result.error}\n`);
  }
  if (PROFILES[profileName].wallTimeLabel) {
    process.stdout.write(`${PROFILES[profileName].wallTimeLabel}: ${(durationMs / 1000).toFixed(1)}s\n`);
  }
  if (results.some((result) => result.code !== 0)) process.exitCode = 1;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || String(error)}\n`);
    process.exitCode = 1;
  });
}
