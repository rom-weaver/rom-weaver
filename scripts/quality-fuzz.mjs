#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main.mjs";
export const FUZZ_TARGETS = [
  "ips_apply",
  "save_parse",
  "disc_sheet",
  "bundle_parse",
  "dcp_zip",
  "iso9660",
];
export const FUZZ_TOOLCHAIN = "nightly-2026-08-25";
export function fuzzPlan(mode, target) {
  if (!["smoke", "deep"].includes(mode)) throw new Error("Fuzz mode must be smoke or deep");
  const targets = target ? [target] : FUZZ_TARGETS;
  if (targets.some((name) => !FUZZ_TARGETS.includes(name)))
    throw new Error("Unknown owned fuzz target");
  const seconds = mode === "smoke" ? 15 : 900;
  return targets.map((name) => ({
    name,
    seconds,
    args: [
      `+${FUZZ_TOOLCHAIN}`,
      "fuzz",
      "run",
      name,
      `fuzz/corpus/${name}`,
      "--",
      `-max_total_time=${seconds}`,
      "-max_len=8192",
      "-rss_limit_mb=1024",
      "-timeout=10",
      "-seed=1",
    ],
  }));
}
export function runFuzz(argv, run = spawnSync, root = process.cwd()) {
  const [mode = "smoke", target] = argv;
  const plan = fuzzPlan(mode, target);
  const scratch = path.resolve(root, ".agent/quality-fuzz");
  fs.mkdirSync(scratch, { recursive: true });
  for (const name of FUZZ_TARGETS) fs.rmSync(path.join(scratch, `${name}.json`), { force: true });
  fs.writeFileSync(
    path.join(scratch, "selection.json"),
    `${JSON.stringify({ mode, targets: plan.map((entry) => entry.name) })}\n`,
  );
  for (const entry of plan) {
    fs.writeFileSync(
      path.join(scratch, `${entry.name}.json`),
      `${JSON.stringify({ target: entry.name, seed: 1, seconds: entry.seconds, status: null, error: "not executed" })}\n`,
    );
  }
  for (const entry of plan) {
    const corpus = path.resolve(root, `fuzz/corpus/${entry.name}`);
    fs.mkdirSync(corpus, { recursive: true });
    const seeds =
      entry.name === "disc_sheet"
        ? [
            Buffer.from('FILE "track.bin" BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00\n'),
            Buffer.from('1\n1 0 4 2352 "track.bin" 0\n'),
          ]
        : [Buffer.from([0, 0, 1, 0, 0x42]), Buffer.from([1, 255, 31, 1, 0xff])];
    seeds.forEach((seed, index) => fs.writeFileSync(path.join(corpus, `seed-${index}`), seed));
    const targetScratch = path.join(scratch, entry.name);
    fs.mkdirSync(targetScratch, { recursive: true });
    const result = run("cargo", entry.args, {
      stdio: "inherit",
      cwd: root,
      timeout: (entry.seconds + 1200) * 1000,
      env: {
        ...process.env,
        ROM_WEAVER_FUZZ_SCRATCH: targetScratch,
        TMPDIR: targetScratch,
        TMP: targetScratch,
        TEMP: targetScratch,
      },
    });
    fs.writeFileSync(
      path.join(scratch, `${entry.name}.json`),
      `${JSON.stringify({ target: entry.name, seed: 1, seconds: entry.seconds, status: result.status, error: result.error?.message ?? null })}\n`,
    );
    if (result.error || result.status !== 0) return result.status || 1;
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => runFuzz(process.argv.slice(2)));
