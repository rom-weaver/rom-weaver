#!/usr/bin/env node

// Parallel browser-test runner: one vitest process per test file.
//
// Each vitest invocation starts its own vite dev server on its own port, so
// every file gets a distinct origin - and therefore its own OPFS. That isolation
// is the whole point: the in-process suite shares one origin's OPFS across files,
// which cascades state between them and hangs the no-arg `vitest run` at a file
// boundary. One-file-per-process removes the shared origin, so failure counts are
// trustworthy and the full suite completes.
//
// CPU contention under parallel load can still flake timing-sensitive files
// (heavy nested extraction), so any file that fails is retried once on its own
// with no neighbours before it counts as a real failure.
//
// Usage:
//   node scripts/run-browser-tests.mjs [file ...] [summary-preserving vitest flags ...]
//   BROWSER_TEST_CONCURRENCY=3 node scripts/run-browser-tests.mjs
//   ROM_WEAVER_BROWSER=webkit node scripts/run-browser-tests.mjs

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(ROOT_DIR, "tests", "browser");
const CONFIG_PATH = path.join(ROOT_DIR, "vitest.browser.config.mjs");
const VITEST_BIN = path.join(ROOT_DIR, "node_modules", ".bin", "vitest");
const TEST_FILE_SUFFIX = ".browser.test.js";
const COVERAGE_ROOT = path.resolve(ROOT_DIR, "..", "..", "dist", "coverage", "react-browser");
// Vitest's summary line ("  Tests  1 failed | 9 passed (10)"), not the
// "⎯ Failed Tests 2 ⎯" section banner - hence the line-start + digit anchors.
const TESTS_LINE_REGEX = /^\s*Tests\s+(\d.*?)\s*$/gm;
// Vitest colourises the summary when it detects CI, wrapping the line in escape
// sequences that defeat the anchors above. Strip them before matching or every
// passing file reports "no test summary". Built with RegExp rather than a
// literal because no-control-regex rejects an escape character in the source.
const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const resolveConcurrency = () => {
  const raw = process.env.BROWSER_TEST_CONCURRENCY;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(4, cores));
};

const partitionRunnerArgs = (argv) => {
  const files = [];
  const vitestArgs = [];
  for (const entry of argv) {
    const resolved = path.resolve(process.cwd(), entry);
    const relativeToTests = path.relative(TEST_DIR, resolved);
    const isBrowserTestPath =
      relativeToTests === "" || (!relativeToTests.startsWith(`..${path.sep}`) && relativeToTests !== "..");
    if (isBrowserTestPath && (entry.endsWith(TEST_FILE_SUFFIX) || fs.existsSync(resolved))) {
      files.push(resolved);
    } else {
      vitestArgs.push(entry);
    }
  }
  return { files, vitestArgs };
};

const assertSummaryPreservingArgs = (vitestArgs) => {
  const unsupported = vitestArgs.find(
    (entry) =>
      entry === "--help" ||
      entry === "-h" ||
      entry === "--version" ||
      entry === "-v" ||
      entry === "--reporter" ||
      entry.startsWith("--reporter="),
  );
  if (unsupported) {
    throw new Error(`Unsupported browser-test runner flag: ${unsupported} (the default Vitest summary is required)`);
  }
};

const discoverTestFiles = (requestedFiles) => {
  if (requestedFiles.length) return requestedFiles;
  return fs
    .readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(TEST_FILE_SUFFIX))
    .sort()
    .map((name) => path.join(TEST_DIR, name));
};

const runFile = (file, vitestArgs) =>
  new Promise((resolve) => {
    const coverageName = path.basename(file, TEST_FILE_SUFFIX);
    const env =
      process.env.ROM_WEAVER_COVERAGE === "1"
        ? {
            ...process.env,
            ROM_WEAVER_COVERAGE_DIR: path.join(COVERAGE_ROOT, coverageName),
            ROM_WEAVER_COVERAGE_SHARD: "1",
          }
        : process.env;
    const child = childProcess.spawn(VITEST_BIN, ["--config", CONFIG_PATH, "run", file, ...vitestArgs], {
      cwd: ROOT_DIR,
      env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: 1, output: `${output}\n${String(error)}` });
    });
    child.on("close", (code) => {
      const exitCode = code ?? 1;
      const missingTestSummary = exitCode === 0 && summarizeOutput(output) === "no test summary";
      resolve({
        code: missingTestSummary ? 1 : exitCode,
        output: missingTestSummary
          ? `${output.trimEnd()}\nVitest exited successfully without reporting a test summary.`
          : output,
      });
    });
  });

const summarizeOutput = (output) => {
  const matches = [...output.replace(ANSI_ESCAPE_REGEX, "").matchAll(TESTS_LINE_REGEX)];
  const last = matches.at(-1);
  return last ? last[1].replace(/\s+/g, " ").trim() : "no test summary";
};

const runPool = async (files, vitestArgs, concurrency, onResult) => {
  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      const result = await runFile(file, vitestArgs);
      onResult(file, result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
};

const main = async () => {
  const { files: requestedFiles, vitestArgs } = partitionRunnerArgs(process.argv.slice(2));
  assertSummaryPreservingArgs(vitestArgs);
  const files = discoverTestFiles(requestedFiles);
  if (!files.length) {
    process.stdout.write("No browser test files found.\n");
    return;
  }
  if (process.env.ROM_WEAVER_COVERAGE === "1") {
    fs.rmSync(COVERAGE_ROOT, { force: true, recursive: true });
  }
  const concurrency = resolveConcurrency();
  const browser = process.env.ROM_WEAVER_BROWSER || "chromium";
  const startedAt = Date.now();
  process.stdout.write(`Running ${files.length} browser test files (${browser}, concurrency ${concurrency})\n\n`);

  const results = new Map();
  const recordResult = (file, result) => {
    results.set(file, result);
    const name = path.basename(file);
    const status = result.code === 0 ? "PASS" : "FAIL";
    process.stdout.write(`  ${status}  ${name}  -  ${summarizeOutput(result.output)}\n`);
  };

  await runPool(files, vitestArgs, concurrency, recordResult);

  // Retry failures once, serially with no neighbours, to absorb contention flakes.
  const initialFailures = files.filter((file) => results.get(file)?.code !== 0);
  if (initialFailures.length) {
    process.stdout.write(`\nRetrying ${initialFailures.length} failed file(s) in isolation…\n`);
    for (const file of initialFailures) {
      const result = await runFile(file, vitestArgs);
      results.set(file, result);
      const name = path.basename(file);
      const status = result.code === 0 ? "PASS (recovered)" : "FAIL";
      process.stdout.write(`  ${status}  ${name}  -  ${summarizeOutput(result.output)}\n`);
    }
  }

  const failures = files.filter((file) => results.get(file)?.code !== 0);
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`\n${files.length - failures.length}/${files.length} files passed in ${elapsedSeconds}s\n`);

  if (failures.length) {
    process.stdout.write(`\n${failures.length} file(s) failed:\n`);
    for (const file of failures) {
      process.stdout.write(`\n──── ${path.basename(file)} ────\n`);
      process.stdout.write(results.get(file).output.trimEnd());
      process.stdout.write("\n");
    }
    process.exitCode = 1;
  }
};

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
