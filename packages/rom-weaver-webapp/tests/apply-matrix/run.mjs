#!/usr/bin/env node
// Apply-matrix runner: drives every case through the real Apply UI in headless Chromium and prints a
// pass/fail/skip table. Exits non-zero when any case fails.
//
//   node tests/apply-matrix/run.mjs [--filter ips,bps] [--group patch-format] [--list] [--workers 2]
//        [--base-url https://localhost:5191/] [--port 5191] [--out DIR] [--json FILE] [--keep-going]
//
// --filter matches case ids / tags (comma list, substring, any-match). Skips always carry a reason.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCases } from "./cases.mjs";
import { generate } from "../fixtures/apply-matrix/generate.mjs";
import { ensureServer } from "./lib/server.mjs";
import { chromium } from "./lib/ui.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

const port = Number(option("port", process.env.RW_PORT || 5191));
const baseUrl = option("base-url", process.env.RW_URL || `https://localhost:${port}/`);
const outDir = path.resolve(option("out", path.join(os.tmpdir(), "rw-apply-matrix")));
const filters = (option("filter", "") || "")
  .split(",")
  .map((part) => part.trim().toLowerCase())
  .filter(Boolean);
const groups = (option("group", "") || "")
  .split(",")
  .map((part) => part.trim().toLowerCase())
  .filter(Boolean);
const workers = Number(option("workers", 2));
const jsonOut = option("json", null);

const manifest = generate({ writeManifest: false });
const cases = buildCases({ manifest }).filter((entry) => {
  if (groups.length && !groups.includes(entry.group)) return false;
  if (!filters.length) return true;
  const haystack = [entry.id, entry.group, ...(entry.tags || [])].join(" ").toLowerCase();
  return filters.some((filter) => haystack.includes(filter));
});

if (flag("list")) {
  for (const entry of cases) console.log(`${entry.group.padEnd(14)} ${entry.id}  [${(entry.tags || []).join(",")}]`);
  console.log(`${cases.length} case(s)`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
const server = await ensureServer(baseUrl, port);
const browser = await chromium.launch({ headless: true });
const results = [];
let next = 0;

const runOne = async (entry) => {
  const started = Date.now();
  const caseDir = path.join(outDir, entry.id.replace(/[^\w.-]+/g, "_"));
  fs.mkdirSync(caseDir, { recursive: true });
  const harness = { baseUrl, browser, caseDir, outDir };
  let result;
  try {
    if (entry.skip) result = { detail: entry.skip, status: "skip" };
    else {
      const detail = await entry.run(harness);
      result = { detail: detail || "", status: "pass" };
    }
  } catch (error) {
    if (error?.skipReason) result = { detail: error.skipReason, status: "skip" };
    else
      result = {
        detail: String(error?.message || error)
          .split("\n")
          .slice(0, 6)
          .join(" | "),
        status: "fail",
      };
  }
  result = { ...entry, ...result, run: undefined, ms: Date.now() - started };
  results.push(result);
  const mark = { fail: "FAIL", pass: "pass", skip: "skip" }[result.status];
  console.log(`${mark}  ${entry.id}  (${result.ms} ms)${result.status === "pass" ? "" : `  ${result.detail}`}`);
};

const worker = async () => {
  while (next < cases.length) await runOne(cases[next++]);
};
try {
  await Promise.all(Array.from({ length: Math.max(1, workers) }, worker));
} finally {
  await browser.close();
  await server.close();
}

const byGroup = new Map();
for (const result of results) {
  const row = byGroup.get(result.group) || { fail: 0, pass: 0, skip: 0 };
  row[result.status]++;
  byGroup.set(result.group, row);
}
console.log("\ngroup".padEnd(16), "pass  fail  skip");
for (const [group, row] of [...byGroup].sort(([a], [b]) => a.localeCompare(b)))
  console.log(
    group.padEnd(15),
    String(row.pass).padStart(4),
    String(row.fail).padStart(5),
    String(row.skip).padStart(5),
  );
const failed = results.filter((result) => result.status === "fail");
console.log(
  `\nTOTAL ${results.length}: ${results.length - failed.length - results.filter((r) => r.status === "skip").length} pass, ${failed.length} fail, ${results.filter((r) => r.status === "skip").length} skip`,
);
if (jsonOut)
  fs.writeFileSync(
    jsonOut,
    `${JSON.stringify(
      results.sort((a, b) => a.id.localeCompare(b.id)),
      null,
      2,
    )}\n`,
  );
process.exit(failed.length ? 1 : 0);
