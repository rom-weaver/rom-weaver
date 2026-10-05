#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main.mjs";
export const KANI_ARGS = [
  "kani",
  "--manifest-path",
  "fuzz/proofs/Cargo.toml",
  "--harness",
  "full_range_single_chunk",
  "--output-format",
  "terse",
];
export function kaniSummary(output, status) {
  const success = /(?:VERIFICATION:-? SUCCESSFUL|Verification: SUCCESSFUL)/u.test(output);
  if (status === 0 && !success)
    throw new Error("Kani returned success without a successful verification; no proof evidence");
  return {
    harness: "full_range_single_chunk",
    assumptions: "full u64 lengths and chunk sizes, assuming chunk size > 0 and >= length",
    unwind: 3,
    status,
    verified: status === 0 && success,
  };
}
export function runKani(run = spawnSync) {
  const scratch = path.resolve(".agent/quality-kani");
  fs.mkdirSync(scratch, { recursive: true });
  // Compiler wrappers MUST be cleared: sccache cannot recognize kani-compiler.
  const env = {
    ...process.env,
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
  };
  const setup = run("cargo", ["kani", "setup"], { stdio: "inherit", env, timeout: 600000 });
  if (setup.status !== 0) throw new Error("Kani setup failed; no proof ran");
  const result = run("cargo", KANI_ARGS, {
    encoding: "utf8",
    env,
    timeout: 1800000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  fs.writeFileSync(path.join(scratch, "verification.log"), output);
  console.log(output);
  const summary = kaniSummary(output, result.status);
  fs.writeFileSync(path.join(scratch, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return result.status ?? 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runMain(() => runKani());
