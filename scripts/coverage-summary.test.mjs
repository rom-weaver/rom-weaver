import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCoverageSummary, mergeCoverage, parseLcov } from "./coverage-summary.mjs";

test("parseLcov and mergeCoverage union covered source lines", () => {
  const first = parseLcov("SF:/repo/source.js\nDA:1,1\nDA:2,0\nend_of_record\n");
  const second = parseLcov("SF:/repo/source.js\nDA:2,3\nDA:3,0\nend_of_record\n");
  assert.deepEqual([...mergeCoverage([first, second]).values()], [1, 3, 0]);
});

test("buildCoverageSummary requires every coverage suite and deduplicates lines", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-coverage-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const report = "SF:/repo/source.js\nDA:1,1\nDA:2,0\nend_of_record\n";
  for (const directory of ["rust", "react-unit", "react-browser/shard", "react-wasm"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, "lcov.info"), report);
  }

  assert.deepEqual(buildCoverageSummary(root).aggregate, { covered: 1, total: 2, percent: 50 });
  fs.rmSync(path.join(root, "react-wasm"), { force: true, recursive: true });
  assert.throws(() => buildCoverageSummary(root), /Missing coverage directory/u);
});

test("parseLcov rejects reports without line data", () => {
  assert.throws(() => parseLcov("TN:\nSF:/repo/source.js\nend_of_record\n"), /no line records/u);
});

test("all-zero instrumentation cannot claim successful suite coverage", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-empty-coverage-"));
  context.after(() => fs.rmSync(root, { force: true, recursive: true }));
  for (const directory of ["rust", "react-unit", "react-browser", "react-wasm"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(
      path.join(root, directory, "lcov.info"),
      "SF:/repo/source.js\nDA:1,0\nend_of_record\n",
    );
  }
  assert.throws(() => buildCoverageSummary(root), /no executed source lines/);
});
