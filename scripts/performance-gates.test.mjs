import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  evaluateReports,
  evaluateThreshold,
  lighthouseArguments,
  median,
  reportIndex,
} from "../packages/rom-weaver-webapp/scripts/run-lighthouse.mjs";
import { brotliCompressFile } from "./wasm/brotli-compress.mjs";

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

// The gates audit a locally served production build, so every audit in the four
// budgeted categories has to run. Skipping one silently reweights its category:
// dropping `is-crawlable` alone would rescore SEO over 9 audits instead of
// 13.04 weight, so the same regression would score differently run to run.
test("Lighthouse scores the full set of budgeted categories", () => {
  const args = lighthouseArguments("https://localhost:4173/", "/tmp/report");
  assert.equal(
    args.some((argument) => argument.startsWith("--skip-audits")),
    false,
  );
  assert.equal(
    args.includes("--only-categories=performance,accessibility,best-practices,seo"),
    true,
  );
  assert.equal(args.includes("--output-path=/tmp/report"), true);
});

test("a metric Lighthouse could not collect fails instead of passing", () => {
  const config = {
    metrics: { "largest-contentful-paint": { expected: 3500, maximum: 5000, unit: "ms" } },
    scores: { performance: { expected: 0.85, minimum: 0.75 } },
  };
  const collected = evaluateReports(
    { name: "Weave", path: "/" },
    [{ audits: {}, categories: {} }],
    config,
  );
  assert.equal(collected.failures, 2);
  assert.deepEqual(
    collected.rows.map((row) => row.severity),
    ["error", "error"],
  );

  const scored = evaluateReports(
    { name: "Weave", path: "/" },
    [
      {
        audits: { "largest-contentful-paint": { numericValue: 0 } },
        categories: { performance: { score: 0 } },
      },
    ],
    config,
  );
  assert.equal(scored.failures, 1);
  assert.equal(scored.rows[1].severity, "pass");
});

test("brotli output is cached by content and verified before reuse", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-brotli-cache-"));
  try {
    const input = path.join(directory, "asset.js");
    // Unique per run: the cache outlives the test, so fixed content would be a
    // hit the second time the suite is run on one checkout.
    fs.writeFileSync(input, `console.log('${crypto.randomUUID()}');`.repeat(64));
    const first = brotliCompressFile({
      inputPath: input,
      outputPath: path.join(directory, "a.br"),
      quality: 11,
    });
    const second = brotliCompressFile({
      inputPath: input,
      outputPath: path.join(directory, "b.br"),
      quality: 11,
    });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.compressedSize, first.compressedSize);
    assert.deepEqual(
      fs.readFileSync(path.join(directory, "b.br")),
      fs.readFileSync(path.join(directory, "a.br")),
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
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
