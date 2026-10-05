#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runMain } from "./run-main.mjs";

export const coverageSelections = [
  { name: "workspace", args: ["--workspace"] },
  {
    name: "feature-gated examples",
    args: [
      "-p",
      "rom-weaver-cli",
      "--features",
      "typescript-types,wasm-app",
      "--example",
      "rom-weaver-typegen",
      "--example",
      "rom-weaver-app",
    ],
  },
];

export function testCounts(output) {
  const results = [
    ...output.matchAll(
      /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/g,
    ),
  ];
  return results.reduce(
    (counts, match) => {
      for (const [index, key] of ["passed", "failed", "ignored", "measured", "filtered"].entries())
        counts[key] += Number(match[index + 1]);
      return counts;
    },
    { passed: 0, failed: 0, ignored: 0, measured: 0, filtered: 0, targets: results.length },
  );
}

export function collectCoverage(output, run, { branch = false } = {}) {
  run(["llvm-cov", "clean", "--workspace"]);
  const selection = [];
  for (const suite of coverageSelections) {
    const listed = run(["test", ...suite.args, "--", "--list"]);
    writeFileSync(join(output, `${suite.name.replaceAll(" ", "-")}-selected.txt`), listed);
    const log = run([
      "llvm-cov",
      ...suite.args,
      "--no-clean",
      "--no-report",
      ...(branch ? ["--branch"] : []),
    ]);
    writeFileSync(join(output, `${suite.name.replaceAll(" ", "-")}-run.txt`), log);
    const counts = testCounts(log);
    if (!counts.targets || !counts.passed)
      throw new Error(`${suite.name}: no passing tests were recorded`);
    selection.push({ name: suite.name, args: suite.args, ...counts });
  }
  // Stable llvm-cov does not instrument doctests. Execute them and record the limitation explicitly.
  const docs = run(["test", "--quiet", "--doc", "--workspace"]);
  writeFileSync(join(output, "doctests-run.txt"), docs);
  writeFileSync(
    join(output, "selection.json"),
    `${JSON.stringify({ suites: selection, doctests: { ...testCounts(docs), instrumented: false }, branchCoverage: branch ? "nightly Rust branch instrumentation" : "not collected by the stable lane" }, null, 2)}\n`,
  );
  run(["llvm-cov", "report", "--html", "--output-dir", output]);
  run(["llvm-cov", "report", "--lcov", "--output-path", join(output, "lcov.info")]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMain(() => {
    const branch = process.argv.slice(2).includes("--branch");
    if (process.argv.slice(2).some((arg) => arg !== "--branch"))
      throw new Error("Usage: coverage-rust.mjs [--branch]");
    const output = resolve(process.env.MISE_PROJECT_ROOT || process.cwd(), "dist/coverage/rust");
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    collectCoverage(
      output,
      (args) => {
        const result = spawnSync("cargo", branch ? ["+nightly-2026-08-25", ...args] : args, {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          timeout: 60 * 60 * 1000,
        });
        process.stdout.write(result.stdout || "");
        process.stderr.write(result.stderr || "");
        if (result.error || result.status !== 0)
          throw new Error(
            `cargo ${args.join(" ")} failed: ${result.error?.message || result.status}`,
          );
        return `${result.stdout || ""}\n${result.stderr || ""}`;
      },
      { branch },
    );
  });
