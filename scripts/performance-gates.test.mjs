import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib from "node:zlib";

import {
  aggregate,
  evaluateReports,
  evaluateThreshold,
  lighthouseArguments,
  median,
  reportIndex,
  shouldRetryLighthouse,
} from "../packages/rom-weaver-webapp/scripts/run-lighthouse.mjs";
import { summarizeCssCoverage } from "../packages/rom-weaver-webapp/scripts/css-coverage.mjs";
import { brotliCompressBuffer, brotliCompressFile } from "./wasm/brotli-compress.mjs";

test("Lighthouse gates use the median and the configured warn/error bands", () => {
  assert.equal(median([0.8, 1, 0.9]), 0.9);
  assert.equal(aggregate([6000, 42000, 6500], "optimistic", false), 6000);
  assert.equal(evaluateThreshold(0.9, { expected: 0.9, minimum: 0.8 }, true), "pass");
  assert.equal(evaluateThreshold(0.89, { expected: 0.9, minimum: 0.8 }, true), "warning");
  assert.equal(evaluateThreshold(0.79, { expected: 0.9, minimum: 0.8 }, true), "error");
  assert.equal(evaluateThreshold(101, { expected: 100, maximum: 200 }, false), "warning");
  assert.equal(evaluateThreshold(201, { expected: 100, maximum: 200 }, false), "error");
});

test("Lighthouse TBT tolerates one representative clean run", () => {
  const config = JSON.parse(
    fs.readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "packages",
        "rom-weaver-webapp",
        "performance-budgets.json",
      ),
      "utf8",
    ),
  );
  const threshold = config.lighthouse.metrics["total-blocking-time"];
  assert.equal(threshold.aggregation, "optimistic");
  assert.equal(aggregate([818, 46.5, 848], threshold.aggregation, false), 46.5);
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

test("Lighthouse retries only the first runtime collection failure", () => {
  const failedReport = { runtimeError: { code: "NO_NAVSTART" } };
  assert.equal(shouldRetryLighthouse(1, failedReport), true);
  assert.equal(shouldRetryLighthouse(2, failedReport), false);
  assert.equal(shouldRetryLighthouse(1, {}), false);
});

test("CSS coverage totals bundled stylesheets and ignores inline styles", () => {
  assert.deepEqual(
    summarizeCssCoverage([
      {
        ranges: [
          { end: 1, start: 0 },
          { end: 3, start: 2 },
        ],
        text: "aébc",
        url: "https://localhost:4173/assets/index.css",
      },
      {
        ranges: [],
        text: "ignored",
        url: "https://localhost:4173/",
      },
    ]),
    { stylesheetCount: 1, totalBytes: 5, unusedBytes: 3, usedBytes: 2 },
  );
});

test("CSS coverage unions the same stylesheet across pages", () => {
  assert.deepEqual(
    summarizeCssCoverage([
      { ranges: [{ end: 2, start: 0 }], text: "abcdef", url: "https://localhost/assets/index.css" },
      { ranges: [{ end: 6, start: 4 }], text: "abcdef", url: "https://localhost/assets/index.css" },
    ]),
    { stylesheetCount: 1, totalBytes: 6, unusedBytes: 2, usedBytes: 4 },
  );
});

test("a metric Lighthouse could not collect fails instead of passing", (t) => {
  // evaluateReports prints ::error workflow commands; muted here so this fixture's fake
  // route cannot surface as a Lighthouse failure annotation on the CI job running it.
  t.mock.method(process.stdout, "write", () => true);
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
    const defaultProfile = brotliCompressFile({
      inputPath: input,
      outputPath: path.join(directory, "default.br"),
      parameterProfile: "default",
      quality: 11,
    });
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(defaultProfile.cached, false);
    assert.equal(second.compressedSize, first.compressedSize);
    assert.deepEqual(
      fs.readFileSync(path.join(directory, "b.br")),
      fs.readFileSync(path.join(directory, "a.br")),
    );
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("brotli buffer compression is deterministic and round-trips", () => {
  const source = Buffer.from(
    Array.from({ length: 20_000 }, (_, index) => `${index % 997}|${index % 1009}|payload\n`).join(
      "",
    ),
  );
  const first = brotliCompressBuffer(source, { quality: 11 });
  const second = brotliCompressBuffer(source, { quality: 11 });
  assert.deepEqual(first, second);
  assert.deepEqual(zlib.brotliDecompressSync(first), source);
  const defaultProfile = brotliCompressBuffer(source, {
    parameterProfile: "default",
    quality: 11,
  });
  assert.deepEqual(zlib.brotliDecompressSync(defaultProfile), source);
});

test("brotli cache identity and output change with compression quality", () => {
  const source = Buffer.from(
    Array.from({ length: 200_000 }, (_, index) => `${index % 997}|${index % 1009}|payload\n`).join(
      "",
    ),
  );
  const low = brotliCompressBuffer(source, { quality: 0 });
  const high = brotliCompressBuffer(source, { quality: 11 });
  assert.notDeepEqual(low, high);
  assert.deepEqual(zlib.brotliDecompressSync(low), source);
  assert.deepEqual(zlib.brotliDecompressSync(high), source);
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
