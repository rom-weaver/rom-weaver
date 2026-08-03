#!/usr/bin/env node

// Run each browser-test file in its own Vitest process and origin. Sharing one
// origin leaks OPFS state between files and can hang Vitest at file boundaries.
// Retry failures once alone to distinguish CPU-contention flakes from failures.
//
// Usage:
//   node scripts/run-browser-tests.mjs [file ...] [summary-preserving vitest flags ...]
//   node scripts/run-browser-tests.mjs --shard=1/2        # run one half of the files
//   node scripts/run-browser-tests.mjs --shard=1/2 --list # print that half, run nothing
//   BROWSER_TEST_CONCURRENCY=3 node scripts/run-browser-tests.mjs
//   BROWSER_TEST_SHARD=2/2 node scripts/run-browser-tests.mjs
//   ROM_WEAVER_BROWSER=webkit node scripts/run-browser-tests.mjs

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Runner-owned flags, pulled out before the vitest passthrough split so they
// are never mistaken for a vitest flag (vitest has its own `--shard`, which
// splits differently and would silently double-shard if it ever saw ours).
const extractRunnerFlags = (argv) => {
  let shardSpec = process.env.BROWSER_TEST_SHARD || "";
  let shardSource = shardSpec ? "BROWSER_TEST_SHARD" : "";
  let listOnly = false;
  const rest = [];
  const queue = [...argv];
  while (queue.length) {
    const entry = queue.shift();
    if (entry === "--list") {
      listOnly = true;
    } else if (entry.startsWith("--shard=")) {
      shardSpec = entry.slice("--shard=".length);
      shardSource = "--shard";
    } else if (entry === "--shard") {
      shardSpec = queue.shift() ?? "";
      shardSource = "--shard";
    } else {
      rest.push(entry);
    }
  }
  return { listOnly, shard: parseShard(shardSpec, shardSource), rest };
};

// "<index>/<total>", 1-based. Anything else is a typo that would otherwise run
// the wrong subset - or the whole suite twice - so it has to be fatal.
export const parseShard = (spec, source) => {
  if (!spec) {
    if (source) throw new Error(`Missing ${source} value: expected <index>/<total> (e.g. 1/2)`);
    return null;
  }
  const match = /^(\d+)\/(\d+)$/.exec(spec.trim());
  const index = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  if (!match || total < 1 || index < 1 || index > total) {
    throw new Error(`Invalid ${source} value "${spec}": expected <index>/<total> with 1 <= index <= total (e.g. 1/2)`);
  }
  return { index, total };
};

// Greedy longest-processing-time: hand each file, largest first, to whichever
// shard is currently lightest. File size is the only cheap proxy for runtime we
// have, and it is a decent one - these files are dominated by per-test setup -
// whereas an alphabetical or round-robin split leaves one runner minutes behind.
export const selectShard = (files, shard) => {
  if (!shard) return files;
  const weighed = files
    // A path that does not exist is left for Vitest to report; weigh it as 0
    // rather than turning a typo'd filename into a stat stack trace.
    .map((file) => ({ file, weight: fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0 }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
  const buckets = Array.from({ length: shard.total }, () => ({ files: [], weight: 0 }));
  for (const { file, weight } of weighed) {
    const target = buckets.reduce((lightest, bucket) => (bucket.weight < lightest.weight ? bucket : lightest));
    target.files.push(file);
    target.weight += weight;
  }
  return buckets[shard.index - 1].files.sort();
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

export const discoverTestFiles = (requestedFiles) => {
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

export const main = async () => {
  const { listOnly, shard, rest } = extractRunnerFlags(process.argv.slice(2));
  const { files: requestedFiles, vitestArgs } = partitionRunnerArgs(rest);
  assertSummaryPreservingArgs(vitestArgs);
  // Sharding applies to whatever set was selected, explicit list included, so
  // `--shard` composes with a hand-picked subset instead of overriding it.
  const files = selectShard(discoverTestFiles(requestedFiles), shard);
  if (listOnly) {
    for (const file of files) process.stdout.write(`${path.basename(file)}\n`);
    return;
  }
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
  const shardLabel = shard ? `, shard ${shard.index}/${shard.total}` : "";
  process.stdout.write(
    `Running ${files.length} browser test files (${browser}, concurrency ${concurrency}${shardLabel})\n\n`,
  );

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
      process.stdout.write(`\n──── initial ${path.basename(file)} failure ────\n`);
      process.stdout.write(results.get(file).output.trimEnd());
      process.stdout.write("\n");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
