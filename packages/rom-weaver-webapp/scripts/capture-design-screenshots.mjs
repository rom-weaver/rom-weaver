#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.resolve(process.env.ROM_WEAVER_SCREENSHOT_OUTPUT || path.join(PACKAGE_DIR, "design"));
const BASE_URL = process.env.ROM_WEAVER_SCREENSHOT_BASE_URL || "https://localhost:4173/";
const CASES = [
  {
    name: "weave",
    route: "/weave?bundle=first-weave.zip",
    waitFor: "Changes HELLO to MODIFIED in the message displayed by the NES ROM.",
  },
  {
    name: "create",
    route: "/create",
    waitFor: "Checksum from extract",
    click: "Start guided Create",
    dismissGuide: true,
  },
];
const VIEWPORTS = [
  { name: "desktop", viewport: { width: 1164, height: 100 }, deviceScaleFactor: 2, isMobile: false },
  { name: "mobile", viewport: { width: 390, height: 100 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
];
const THEMES = ["light", "dark"];
const IMAGE_MAGICK = ["magick", "convert"].find(
  (command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);

if (!IMAGE_MAGICK)
  throw new Error("Screenshot capture requires ImageMagick (magick or convert) for lossless WebP output");

const pageUrl = (route) => new URL(route, BASE_URL).toString();

const assertNoDevBadge = async (page) => {
  const badges = await page.locator(".channel-badge").allTextContents();
  if (badges.some((badge) => badge.trim() === "DEV")) throw new Error("Screenshot page still shows the DEV badge");
};

const waitForStableContent = (page) =>
  page.waitForFunction(
    () => {
      if (/(Reading|Checksumming)(?:…|\.\.\.)/.test(document.body.innerText)) {
        globalThis.__romWeaverScreenshotStableAt = undefined;
        return false;
      }
      globalThis.__romWeaverScreenshotStableAt ??= performance.now();
      return performance.now() - globalThis.__romWeaverScreenshotStableAt >= 500;
    },
    undefined,
    { polling: 50, timeout: 30_000 },
  );

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
          if (captureCase.click) await page.getByRole("button", { name: captureCase.click, exact: true }).click();
          await page.getByText(captureCase.waitFor, { exact: true }).last().waitFor({ state: "visible" });
          if (captureCase.dismissGuide) await page.getByRole("button", { name: "End guide", exact: true }).click();
          await waitForStableContent(page);
          await assertNoDevBadge(page);
          // Chromium's full-page compositor can paint this translated, visually
          // hidden fixed link in a later capture tile.
          await page.locator(".skip-link").evaluate((element) => element.setAttribute("hidden", ""));
          const outputPath = path.join(OUTPUT_DIR, `${captureCase.name}-${viewport.name}-${theme}.webp`);
          const shot = await page.screenshot({ animations: "disabled", fullPage: true, type: "png" });
          // Keep text and fine UI edges lossless; the 2x desktop and 3x mobile
          // captures prevent retina docs pages from upscaling a 1x source.
          const webp = execFileSync(IMAGE_MAGICK, ["png:-", "-define", "webp:lossless=true", "webp:-"], {
            input: shot,
            maxBuffer: 64 * 1024 * 1024,
          });
          fs.writeFileSync(outputPath, webp);
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
