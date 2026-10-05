#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COVERAGE_ROOT = path.join(REPO_ROOT, "dist", "coverage");
const WEBAPP_ROOT = path.join(REPO_ROOT, "packages", "rom-weaver-webapp");

const SUITES = [
  { name: "Rust native", directory: "rust", sourceRoot: REPO_ROOT },
  { name: "React unit", directory: "react-unit", sourceRoot: WEBAPP_ROOT },
  { name: "React UI", directory: "react-browser", sourceRoot: WEBAPP_ROOT },
  { name: "Browser WASM host TS (not guest Rust)", directory: "react-wasm", sourceRoot: WEBAPP_ROOT },
];

const findLcovFiles = (directory) => {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`Missing coverage directory: ${path.relative(REPO_ROOT, directory)}`);
  }
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findLcovFiles(entryPath));
    else if (entry.name === "lcov.info") files.push(entryPath);
  }
  return files.sort();
};

const normalizeSource = (source, sourceRoot) => {
  const raw = source.startsWith("file://") ? fileURLToPath(source) : source;
  let absolute = path.isAbsolute(raw) ? raw : path.resolve(REPO_ROOT, raw);
  if (!path.isAbsolute(raw) && !fs.existsSync(absolute)) absolute = path.resolve(sourceRoot, raw);
  const relative = path.relative(REPO_ROOT, absolute);
  return relative.startsWith(`..${path.sep}`) || relative === ".."
    ? absolute
    : relative.split(path.sep).join("/");
};

export const parseLcov = (contents, sourceRoot = REPO_ROOT) => {
  const lines = new Map();
  let source = null;
  for (const rawLine of contents.split(/\r?\n/u)) {
    if (rawLine.startsWith("SF:")) {
      source = normalizeSource(rawLine.slice(3), sourceRoot);
      continue;
    }
    if (!rawLine.startsWith("DA:")) continue;
    if (!source) throw new Error("LCOV DA record appeared before its SF record");
    const match = /^DA:(\d+),(\d+)/u.exec(rawLine);
    if (!match) throw new Error(`Malformed LCOV line record: ${rawLine}`);
    const key = `${source}:${match[1]}`;
    lines.set(key, (lines.get(key) || 0) + Number(match[2]));
  }
  if (!lines.size) throw new Error("LCOV report contained no line records");
  return lines;
};

export const mergeCoverage = (reports) => {
  const merged = new Map();
  for (const report of reports) {
    for (const [line, hits] of report) merged.set(line, Math.max(merged.get(line) || 0, hits));
  }
  return merged;
};

const summarize = (lines) => {
  const total = lines.size;
  const covered = [...lines.values()].filter((hits) => hits > 0).length;
  return { covered, total, percent: Number(((covered / total) * 100).toFixed(2)) };
};

const markdownTable = (summaries, aggregate) => {
  const rows = summaries.map(
    ({ name, files, summary }) =>
      `| ${name} | ${files} | ${summary.covered.toLocaleString("en-US")} / ${summary.total.toLocaleString("en-US")} | ${summary.percent.toFixed(2)}% |`,
  );
  return [
    "## Coverage summary",
    "",
    "| Suite | LCOV files | Lines | Coverage |",
    "| --- | ---: | ---: | ---: |",
    ...rows,
    `| **Aggregate (deduplicated)** | **${summaries.reduce((sum, suite) => sum + suite.files, 0)}** | **${aggregate.covered.toLocaleString("en-US")} / ${aggregate.total.toLocaleString("en-US")}** | **${aggregate.percent.toFixed(2)}%** |`,
    "",
  ].join("\n");
};

export const buildCoverageSummary = (coverageRoot = COVERAGE_ROOT) => {
  const suiteResults = SUITES.map((suite) => {
    const directory = path.join(coverageRoot, suite.directory);
    const files = findLcovFiles(directory);
    if (!files.length)
      throw new Error(`No lcov.info files found in ${path.relative(REPO_ROOT, directory)}`);
    const coverage = mergeCoverage(
      files.map((file) => parseLcov(fs.readFileSync(file, "utf8"), suite.sourceRoot)),
    );
    return { name: suite.name, files: files.length, coverage, summary: summarize(coverage) };
  });
  const aggregate = summarize(mergeCoverage(suiteResults.map(({ coverage }) => coverage)));
  return {
    aggregate,
    suites: suiteResults.map(({ name, files, summary }) => ({ name, files, ...summary })),
  };
};

const main = () => {
  const result = buildCoverageSummary();
  const summaries = result.suites.map(({ name, files, ...summary }) => ({ name, files, summary }));
  const markdown = markdownTable(summaries, result.aggregate);
  fs.mkdirSync(COVERAGE_ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(COVERAGE_ROOT, "summary.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(COVERAGE_ROOT, "summary.md"), `${markdown}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  process.stdout.write(`${markdown}\n`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Coverage summary failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
