#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseLcov, findLcovFiles } from "./coverage-summary.mjs";
import { runMain } from "./run-main.mjs";

// Vitest reports src/ paths relative to its webapp package, while Rust uses repository paths.
const repositoryPaths = (report) =>
  report.replace(/^SF:(?:\.\/)?src\//gm, "SF:packages/rom-weaver-webapp/src/");

export function addedLines(diff) {
  const lines = new Set();
  let file;
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      const name = text.slice(4);
      if (name.startsWith('"'))
        throw new Error("Quoted diff paths are unsupported; changed coverage was not measured");
      file = name === "/dev/null" ? undefined : name.replace(/^[abciow]\//u, "");
    } else if (text.startsWith("@@")) line = Number(/\+(\d+)/.exec(text)?.[1]);
    else if (text.startsWith("+") && !text.startsWith("+++")) {
      if (file) lines.add(`${file}:${line}`);
      line += 1;
    } else if (!text.startsWith("-") && !text.startsWith("\\")) line += 1;
  }
  return lines;
}
export function parseBranches(report, sourceRoot) {
  const branches = new Map();
  let source;
  for (const line of repositoryPaths(report).split("\n")) {
    if (line.startsWith("SF:"))
      source = [...parseLcov(`${line}\nDA:1,0\n`, sourceRoot).keys()][0].slice(0, -2);
    if (!line.startsWith("BRDA:")) continue;
    const match = /^BRDA:(\d+),(\d+),(\d+),(-?\d+|-)$/u.exec(line);
    if (!match || !source) throw new Error(`Invalid branch record: ${line}`);
    // V8 shard LCOV can contain negative counts; they provide no coverage evidence.
    branches.set(
      `${source}:${match[1]}:${match[2]}:${match[3]}`,
      match[4] === "-" || Number(match[4]) < 0 ? null : Number(match[4]),
    );
  }
  return branches;
}
export function diffCoverage(diff, reports) {
  const sources = reports.map((report) =>
    typeof report === "string" ? { contents: report, sourceRoot: undefined } : report,
  );
  const measured = new Map();
  for (const { contents, sourceRoot } of sources)
    for (const [location, hits] of parseLcov(repositoryPaths(contents), sourceRoot))
      measured.set(location, Math.max(hits, measured.get(location) || 0));
  const result = { covered: [], uncovered: [], notMeasured: [] };
  for (const location of addedLines(diff)) {
    if (!measured.has(location)) result.notMeasured.push(location);
    else if (measured.get(location) > 0) result.covered.push(location);
    else result.uncovered.push(location);
  }
  const changed = addedLines(diff);
  const branches = new Map();
  for (const { contents, sourceRoot } of sources)
    for (const [key, hits] of parseBranches(contents, sourceRoot)) {
      if (
        !branches.has(key) ||
        (hits !== null && (branches.get(key) === null || hits > branches.get(key)))
      )
        branches.set(key, hits);
    }
  result.branches = {
    covered: [],
    uncovered: [],
    unknown: [],
    recordsAvailable: branches.size > 0,
  };
  for (const [key, hits] of branches) {
    const location = key.split(":").slice(0, -2).join(":");
    if (!changed.has(location)) continue;
    if (hits === null) result.branches.unknown.push(key);
    else if (hits === 0) result.branches.uncovered.push(key);
    else result.branches.covered.push(key);
  }
  return result;
}
export function coverageInputs(argv) {
  const [base, ...args] = argv;
  const reports = [];
  for (let i = 0; i < args.length; i++) {
    const browser = args[i] === "--webapp-lcov";
    const file = browser ? args[++i] : args[i];
    if (!file || file.startsWith("--")) throw new Error("Missing or invalid LCOV path");
    reports.push({ file, sourceRoot: browser ? resolve("packages/rom-weaver-webapp") : undefined });
  }
  if (!base || !reports.length)
    throw new Error("Usage: quality-diff-coverage BASE LCOV [--webapp-lcov LCOV ...]");
  return { base, reports };
}
export function readCoverageReports(reports) {
  return reports.flatMap(({ file, sourceRoot }) => {
    const files = statSync(file).isDirectory() ? findLcovFiles(file) : [file];
    if (!files.length) throw new Error(`No LCOV reports selected in ${file}`);
    return files.map((report) => ({ contents: readFileSync(report, "utf8"), sourceRoot }));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMain(() => {
    const { base, reports } = coverageInputs(process.argv.slice(2));
    const mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], {
      encoding: "utf8",
    }).trim();
    const diff = execFileSync(
      "git",
      [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=0",
        mergeBase,
        "--",
        "crates",
        "packages/rom-weaver-webapp/src",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const result = diffCoverage(diff, readCoverageReports(reports));
    mkdirSync("dist/coverage", { recursive: true });
    writeFileSync(
      resolve("dist/coverage/changed-lines.json"),
      `${JSON.stringify({ mergeBase, ...result }, null, 2)}\n`,
    );
    process.stdout.write(
      `Changed lines: ${result.covered.length} covered, ${result.uncovered.length} uncovered, ${result.notMeasured.length} not measured (includes non-executable lines).\n${result.uncovered.join("\n")}\nChanged branches: ${result.branches.covered.length} covered, ${result.branches.uncovered.length} uncovered, ${result.branches.unknown.length} unknown; branch records available=${result.branches.recordsAvailable}.\n`,
    );
  });
