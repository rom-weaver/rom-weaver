import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateSizeBudget,
  measureSizeBudget,
} from "../packages/rom-weaver-webapp/scripts/check-size-budget.mjs";
import {
  aggregate,
  evaluateThreshold,
  lighthouseArguments,
  median,
  reportIndex,
} from "../packages/rom-weaver-webapp/scripts/run-lighthouse.mjs";

test("size budgets warn at the expected value and fail at the maximum", () => {
  const budget = {
    expectedRawBytes: 10,
    maxRawBytes: 20,
    expectedBrotliBytes: 10,
    maxBrotliBytes: 20,
  };
  assert.equal(evaluateSizeBudget(budget, { rawBytes: 10, brotliBytes: 10 }), "pass");
  assert.equal(evaluateSizeBudget(budget, { rawBytes: 11, brotliBytes: 10 }), "warning");
  assert.equal(evaluateSizeBudget(budget, { rawBytes: 10, brotliBytes: 21 }), "error");
});

test("size measurement totals every matching built asset", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-size-budget-"));
  try {
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(path.join(directory, "assets", "a.js"), "one");
    fs.writeFileSync(path.join(directory, "assets", "b.js"), "two");
    fs.writeFileSync(path.join(directory, "assets", "a.js.br"), "x");
    fs.writeFileSync(path.join(directory, "assets", "b.js.br"), "yz");
    fs.writeFileSync(path.join(directory, "assets", "ignore.css"), "three");
    const measured = measureSizeBudget(
      directory,
      { name: "JavaScript", directory: "assets", extension: ".js", requireBrotliMinBytes: 1 },
      1,
    );
    assert.equal(measured.fileCount, 2);
    assert.equal(measured.rawBytes, 6);
    assert.equal(measured.brotliBytes, 3);
    fs.rmSync(path.join(directory, "assets", "b.js.br"));
    assert.throws(
      () =>
        measureSizeBudget(
          directory,
          { name: "JavaScript", directory: "assets", extension: ".js", requireBrotliMinBytes: 1 },
          1,
        ),
      /missing a Brotli sidecar/,
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("Lighthouse gates use the median and the configured warn/error bands", () => {
  assert.equal(median([0.8, 1, 0.9]), 0.9);
  assert.equal(aggregate([6000, 42000, 6500], "optimistic", false), 6000);
  assert.equal(evaluateThreshold(0.9, { expected: 0.9, minimum: 0.8 }, true), "pass");
  assert.equal(evaluateThreshold(0.89, { expected: 0.9, minimum: 0.8 }, true), "warning");
  assert.equal(evaluateThreshold(0.79, { expected: 0.9, minimum: 0.8 }, true), "error");
  assert.equal(evaluateThreshold(101, { expected: 100, maximum: 200 }, false), "warning");
  assert.equal(evaluateThreshold(201, { expected: 100, maximum: 200 }, false), "error");
});

test("Lighthouse can ignore only the preview noindex audit", () => {
  const ordinary = lighthouseArguments("https://rom-weaver.com/", "/tmp/report");
  const preview = lighthouseArguments("https://pr-1.example.com/", "/tmp/report", true);
  assert.equal(ordinary.includes("--skip-audits=is-crawlable"), false);
  assert.equal(preview.includes("--skip-audits=is-crawlable"), true);
});

test("Lighthouse report index links every detailed HTML run", () => {
  const html = reportIndex(
    [{ label: "Weave performance", severity: "pass", value: "0.90" }],
    [
      { name: "Weave", path: "/" },
      { name: "Create", path: "/create/" },
    ],
    2,
  );
  assert.match(html, /Weave performance/);
  assert.match(html, /weave-2\.report\.html/);
  assert.match(html, /create-2\.report\.html/);
  assert.match(html, /noindex,nofollow/);
});
