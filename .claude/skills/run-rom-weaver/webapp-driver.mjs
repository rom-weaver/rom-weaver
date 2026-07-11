#!/usr/bin/env node
// rom-weaver webapp driver - launches a headless Chromium against the running
// dev/preview server, drives the Apply workflow end-to-end (upload ROM + patch,
// click "Apply & download", capture the produced file), and screenshots.
//
// Playwright + chromium are ALREADY installed as deps of this package, so this
// script MUST be run from packages/rom-weaver-react (node resolves "playwright"
// from there). The dev server uses a self-signed cert → ignoreHTTPSErrors.
//
// Usage (from packages/rom-weaver-react):
//   node ../../.claude/skills/run-rom-weaver/webapp-driver.mjs load        # just boot + screenshot
//   node ../../.claude/skills/run-rom-weaver/webapp-driver.mjs apply       # full apply flow + screenshot
//
// Env:
//   RW_URL   server URL (default https://localhost:5191/)
//   RW_OUT   screenshot/output dir (default /tmp/rw-driver)
//   RW_HEAD  set to 1 for a headed browser

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
// playwright is a dep of the React package, not of the repo root - resolve it
// from there regardless of where this script lives or runs.
const require = createRequire(path.join(REPO, "packages/rom-weaver-react/package.json"));
const { chromium } = require("playwright");
const URL = process.env.RW_URL || "https://localhost:5191/";
const OUT = process.env.RW_OUT || "/tmp/rw-driver";
const HEADLESS = process.env.RW_HEAD !== "1";
const cmd = process.argv[2] || "load";

// Fixtures shipped in the repo. source.bin is a 64 KiB raw "ROM"; the xdelta
// patches it to secondary-target.bin (CRC32 221d2d6c - the parity check below).
const ROM = path.join(REPO, "tests/fixtures/vcdiff/secondary-source.bin");
const PATCH = path.join(REPO, "tests/fixtures/vcdiff/secondary-djw.xdelta");

fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("[driver]", ...a);

async function boot() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  log("navigating", URL);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  // The unified file input is the stable anchor that the app has mounted.
  await page.locator("#rom-weaver-input-file-unified").waitFor({ state: "attached", timeout: 60000 });
  // Give the wasm warmup extraction a moment to finish before driving inputs.
  await page.waitForTimeout(3000);
  return { browser, ctx, page, errors };
}

async function shot(page, name) {
  const p = path.join(OUT, name);
  await page.screenshot({ path: p, fullPage: false });
  log("screenshot", p);
}

async function load() {
  const { browser, page, errors } = await boot();
  log("title", await page.title());
  await shot(page, "load.png");
  await browser.close();
  if (errors.length) { console.error("PAGE ERRORS:", errors); process.exit(1); }
  log("OK: app booted and rendered");
}

async function apply() {
  const { browser, page, errors } = await boot();
  log("uploading ROM + patch", path.basename(ROM), path.basename(PATCH));
  await page.locator("#rom-weaver-input-file-unified").setInputFiles([ROM, PATCH]);
  // The ROM (0x02) and Patches (0x03) cards populate from the unified drop.
  await page.getByText("secondary-source", { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByText("secondary-djw", { exact: false }).first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  await shot(page, "apply-staged.png");

  const runBtn = page.getByRole("button", { name: /Apply & download/i }).first();
  await runBtn.waitFor({ timeout: 30000 });
  log("clicking Apply & download");
  const downloadP = page.waitForEvent("download", { timeout: 60000 });
  await runBtn.click();
  const download = await downloadP;
  const saved = path.join(OUT, await download.suggestedFilename());
  await download.saveAs(saved);
  const size = fs.statSync(saved).size;
  log("downloaded", saved, size, "bytes");
  await page.waitForTimeout(1500);
  await shot(page, "apply-done.png");
  await browser.close();
  if (errors.length) { console.error("PAGE ERRORS:", errors); process.exit(1); }
  if (size <= 0) { console.error("download was empty"); process.exit(1); }
  log("OK: apply produced", path.basename(saved), `(${size} bytes)`);
}

if (cmd === "load") await load();
else if (cmd === "apply") await apply();
else { console.error("unknown command:", cmd, "(load|apply)"); process.exit(2); }
