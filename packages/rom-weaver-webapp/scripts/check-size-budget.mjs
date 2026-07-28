#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(PACKAGE_ROOT, "performance-budgets.json");
const DIST_DIR = path.join(PACKAGE_ROOT, "dist");

const listFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
  });

export function measureSizeBudget(distDir, budget, brotliQuality) {
  const files = budget.path
    ? [path.join(distDir, budget.path)]
    : listFiles(path.join(distDir, budget.directory || "")).filter((file) => file.endsWith(budget.extension));
  if (files.length === 0 || files.some((file) => !fs.statSync(file).isFile())) {
    throw new Error(`${budget.name} matched no built files`);
  }
  if (
    budget.requireBrotliMinBytes &&
    files.some((file) => fs.statSync(file).size >= budget.requireBrotliMinBytes && !fs.existsSync(`${file}.br`))
  ) {
    throw new Error(`${budget.name} is missing a Brotli sidecar`);
  }
  const buffers = files.map((file) => fs.readFileSync(file));
  const brotliOptions = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality } };
  return {
    brotliBytes: files.reduce(
      (total, file, index) =>
        total +
        (fs.existsSync(`${file}.br`)
          ? fs.statSync(`${file}.br`).size
          : zlib.brotliCompressSync(buffers[index], brotliOptions).length),
      0,
    ),
    fileCount: files.length,
    rawBytes: buffers.reduce((total, buffer) => total + buffer.length, 0),
  };
}

export function evaluateSizeBudget(budget, measured) {
  if (measured.rawBytes > budget.maxRawBytes || measured.brotliBytes > budget.maxBrotliBytes) return "error";
  if (measured.rawBytes > budget.expectedRawBytes || measured.brotliBytes > budget.expectedBrotliBytes)
    return "warning";
  return "pass";
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const difference = (actual, expected) => `${actual >= expected ? "+" : ""}${kib(actual - expected)}`;

export function runSizeBudget(config, distDir = DIST_DIR) {
  const rows = [];
  let failures = 0;
  for (const budget of config.assetSizes.budgets) {
    const measured = measureSizeBudget(distDir, budget, config.assetSizes.brotliQuality);
    const severity = evaluateSizeBudget(budget, measured);
    const detail =
      `raw ${kib(measured.rawBytes)} (${difference(measured.rawBytes, budget.expectedRawBytes)}), ` +
      `brotli ${kib(measured.brotliBytes)} (${difference(measured.brotliBytes, budget.expectedBrotliBytes)})`;
    rows.push({ ...measured, budget, detail, severity });
    process.stdout.write(`${severity.toUpperCase().padEnd(7)} ${budget.name}: ${detail}\n`);
    if (severity === "warning")
      process.stdout.write(`::warning title=Asset size budget::${budget.name} exceeded its expected size; ${detail}\n`);
    if (severity === "error") {
      failures += 1;
      process.stdout.write(`::error title=Asset size budget::${budget.name} exceeded its maximum size; ${detail}\n`);
    }
  }
  return { failures, rows };
}

const summary = (rows) =>
  [
    "### Asset size budgets",
    "",
    "| Asset | Files | Raw | Brotli | Result |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows.map(
      ({ brotliBytes, budget, fileCount, rawBytes, severity }) =>
        `| ${budget.name} | ${fileCount} | ${kib(rawBytes)} | ${kib(brotliBytes)} | ${severity} |`,
    ),
    "",
  ].join("\n");

export function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const result = runSizeBudget(config);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result.rows));
  return result.failures === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
