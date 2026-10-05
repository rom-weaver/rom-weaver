#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main.mjs";
export const MIRI_TOOLCHAIN = "nightly-2026-08-25";
export const MIRI_FILTERS = ["chunk_planner", "ordered_writer"];
export function selectedMiriTests(output) {
  const tests = output
    .split(/\r?\n/u)
    .filter((line) => line.endsWith(": test"))
    .map((line) => line.slice(0, -6));
  if (!tests.length)
    throw new Error("Miri selected no tests; this is not a successful verification");
  return tests;
}
export function miriPlan() {
  return [0, 1].flatMap((seed) =>
    MIRI_FILTERS.map((filter) => ({
      seed,
      filter,
      args: [`+${MIRI_TOOLCHAIN}`, "miri", "test", "-p", "rom-weaver-core", "--lib", filter],
    })),
  );
}
export function runMiri(run = spawnSync) {
  const scratch = path.resolve(".agent/quality-miri");
  fs.mkdirSync(scratch, { recursive: true });
  // Miri sysroot generation MUST use an external directory: its generated Cargo
  // package otherwise inherits this workspace and Cargo refuses to build it.
  const temporary = path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "agents/scratch/rom-weaver-quality-miri",
  );
  fs.mkdirSync(temporary, { recursive: true });
  const records = [];
  for (const entry of miriPlan()) {
    const env = {
      ...process.env,
      MIRIFLAGS: `-Zmiri-seed=${entry.seed}`,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    };
    const listing = run("cargo", [...entry.args, "--", "--list"], {
      encoding: "utf8",
      env,
      timeout: 1200000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (listing.status !== 0) throw new Error(`Miri discovery failed: ${listing.stderr}`);
    const tests = selectedMiriTests(listing.stdout);
    const result = run("cargo", entry.args, { stdio: "inherit", env, timeout: 1200000 });
    records.push({ ...entry, tests, status: result.status, error: result.error?.message ?? null });
    fs.writeFileSync(path.join(scratch, "selection.json"), `${JSON.stringify(records, null, 2)}\n`);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => runMiri());
