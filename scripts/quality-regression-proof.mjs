#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runMain } from "./run-main.mjs";

export function classifyTest(result, testName, diagnostic) {
  if (result.error || result.signal) return "setup-failure";
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (
    result.status === 0 &&
    new RegExp(`test ${escaped} \\.\\.\\. ok`).test(output) &&
    /1 passed; 0 failed/.test(output)
  )
    return "passed";
  if (
    result.status !== 0 &&
    new RegExp(`test ${escaped} \\.\\.\\. FAILED`).test(output) &&
    /0 passed; 1 failed/.test(output) &&
    output.includes(diagnostic)
  )
    return "behavioral-failure";
  return "unproven";
}

export function validateOptions(options) {
  for (const name of ["base", "package", "target", "test", "diagnostic"])
    if (!options[name]) throw new Error(`--${name} is required`);
  if (!options.files?.length) throw new Error("At least one --test-file is required");
  for (const file of options.files)
    if (
      !/^crates\/[^/]+\/tests\/(?:[\w.-]+\/)*[\w.-]+\.rs$/.test(file) ||
      file.split("/").includes("..")
    )
      throw new Error(`Only Rust test files can be overlaid: ${file}`);
  if (options.diagnostic.trim().length < 8)
    throw new Error("Use a specific behavioral diagnostic of at least eight characters");
}

export function prove(options, root = process.cwd()) {
  validateOptions(options);
  const base = execFileSync("git", ["merge-base", options.base, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const parent = resolve(root, ".agent/quality-signals");
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(`${parent}/regression-`);
  const baseline = resolve(output, "base");
  mkdirSync(baseline, { recursive: true });
  const archive = execFileSync("git", ["archive", base], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  const unpack = spawnSync("tar", ["-xf", "-", "-C", baseline], { input: archive });
  if (unpack.status !== 0) throw new Error("Could not unpack merge-base implementation");
  const overlays = options.files.map((file) => {
    const dest = resolve(baseline, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(resolve(root, file), dest);
    return file;
  });
  const args = ["test", "--locked", "-p", options.package, "--test", options.target];
  if (options.features) args.push("--features", options.features);
  args.push("--", options.test, "--exact", "--nocapture");
  const results = {};
  for (const [label, cwd] of [
    ["candidate", root],
    ["base", baseline],
  ]) {
    const result = spawnSync("cargo", args, {
      cwd,
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CARGO_TARGET_DIR: resolve(output, `target-${label}`) },
    });
    writeFileSync(
      resolve(output, `${label}.log`),
      `${result.stdout || ""}\n${result.stderr || ""}`,
    );
    results[label] = classifyTest(result, options.test, options.diagnostic);
  }
  const candidateDiff = execFileSync("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const candidateChangesSha256 = createHash("sha256")
    .update(candidateDiff)
    .update(
      options.files
        .map((file) => `${file}\n${readFileSync(resolve(root, file), "utf8")}`)
        .join("\n"),
    )
    .digest("hex");
  const report = {
    base,
    candidateDirty: candidateDiff.length > 0,
    candidateChangesSha256,
    candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    overlays,
    args,
    diagnostic: options.diagnostic,
    results,
    proven: results.candidate === "passed" && results.base === "behavioral-failure",
  };
  writeFileSync(resolve(output, "proof.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nEvidence: ${output}\n`);
  if (!report.proven)
    throw new Error(
      "Regression proof failed; inspect logs. Compilation, setup, and discovery failures are not evidence.",
    );
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMain(() => {
    const options = { files: [] };
    const argv = process.argv.slice(2);
    for (let index = 0; index < argv.length; index += 2) {
      const name = argv[index];
      const value = argv[index + 1];
      if (
        !value ||
        ![
          "--base",
          "--package",
          "--target",
          "--test",
          "--diagnostic",
          "--test-file",
          "--features",
        ].includes(name)
      )
        throw new Error(`Invalid option: ${name}`);
      if (name === "--test-file") options.files.push(value);
      else options[name.slice(2)] = value;
    }
    prove(options);
  });
