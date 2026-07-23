#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { assertSamePixels, optimizePng } from "./optimize-png.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.resolve(process.env.ROM_WEAVER_SCREENSHOT_OUTPUT || path.join(PACKAGE_DIR, "design"));
const BASE_URL = process.env.ROM_WEAVER_SCREENSHOT_BASE_URL || "https://localhost:4173/";
const CASES = [
  {
    name: "weave",
    route: "/weave?bundle=first-weave.zip",
    waitFor: "The woven result will be verified against the expected output.",
  },
  { name: "create", route: "/create", waitFor: "Checksum from extract", click: "Start with sample assets" },
];
const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1164, height: 100 }, deviceScaleFactor: 1, isMobile: false },
  { name: "mobile", viewport: { width: 390, height: 100 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
const THEMES = ["light", "dark"];

const pageUrl = (route) => new URL(route, BASE_URL).toString();

const assertNoDevBadge = async (page) => {
  const badges = await page.locator(".channel-badge").allTextContents();
  if (badges.some((badge) => badge.trim() === "DEV")) throw new Error("Screenshot page still shows the DEV badge");
};

const waitForStableContent = (page) =>
  page.waitForFunction(() => !/(Reading|Checksumming)(?:…|\.\.\.)/.test(document.body.innerText), undefined, {
    timeout: 30_000,
  });

const capture = async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      for (const theme of THEMES) {
        for (const captureCase of CASES) {
          const context = await browser.newContext({
            colorScheme: theme,
            deviceScaleFactor: viewport.deviceScaleFactor,
            hasTouch: viewport.hasTouch,
            ignoreHTTPSErrors: true,
            isMobile: viewport.isMobile,
            viewport: viewport.viewport,
          });
          const page = await context.newPage();
          await page.goto(pageUrl(captureCase.route), { waitUntil: "domcontentloaded" });
          await page.locator("body").waitFor({ state: "visible" });
          await assertNoDevBadge(page);
          if (captureCase.click) await page.getByRole("button", { name: captureCase.click, exact: true }).click();
          await page.getByText(captureCase.waitFor, { exact: true }).last().waitFor({ state: "visible" });
          await waitForStableContent(page);
          const outputPath = path.join(OUTPUT_DIR, `${captureCase.name}-${viewport.name}-${theme}.png`);
          const shot = await page.screenshot({ animations: "disabled", fullPage: true, type: "png" });
          // These are committed docs assets; Chrome's encoder leaves ~25% on
          // the table, so squeeze before writing rather than re-bloating the
          // repo on every recapture.
          const optimized = optimizePng(shot);
          assertSamePixels(shot, optimized, path.basename(outputPath));
          fs.writeFileSync(outputPath, optimized);
          await context.close();
          console.log(`Captured ${path.relative(PACKAGE_DIR, outputPath)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
};

capture().catch((error) => {
  process.stderr.write(`${error?.stack || String(error)}\n`);
  process.exitCode = 1;
});
