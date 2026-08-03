#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  DOCS_SCREENSHOT_CASES,
  DOCS_SCREENSHOT_FORMATS,
  DOCS_SCREENSHOT_THEMES,
  DOCS_SCREENSHOT_VIEWPORTS,
} from "./docs-screenshot-manifest.mjs";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PACKAGE_DIR, "../..");
const OUTPUT_DIR = path.resolve(
  process.env.ROM_WEAVER_SCREENSHOT_OUTPUT || path.join(REPO_ROOT, "docs", "screenshots"),
);
const BASE_URL = process.env.ROM_WEAVER_SCREENSHOT_BASE_URL || "https://localhost:4173/";
const CASE_FILTER = process.env.ROM_WEAVER_SCREENSHOT_CASE;
const CAPTURE_CASES = CASE_FILTER
  ? DOCS_SCREENSHOT_CASES.filter(({ name }) => name === CASE_FILTER)
  : DOCS_SCREENSHOT_CASES;
if (!CAPTURE_CASES.length) throw new Error(`Unknown screenshot case: ${CASE_FILTER}`);
const IMAGE_MAGICK = ["magick", "convert"].find(
  (command) => spawnSync(command, ["-version"], { stdio: "ignore" }).status === 0,
);
const CAPTURE_EXTENSION_LIST = DOCS_SCREENSHOT_FORMATS.map(({ extension }) => extension).join(",");

if (!IMAGE_MAGICK)
  throw new Error("Screenshot capture requires ImageMagick (magick or convert) for the configured formats");

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

const captureRegion = async (page, selector) => {
  const target = page.locator(selector);
  await target.first().scrollIntoViewIfNeeded();
  const { bounds, deviceScaleFactor, pageSize } = await target.evaluateAll((elements) => {
    const boxes = elements.map((element) => element.getBoundingClientRect());
    if (!boxes.length) throw new Error("Screenshot target has no elements");
    return {
      bounds: {
        bottom: Math.max(...boxes.map((box) => box.bottom)) + window.scrollY,
        left: Math.min(...boxes.map((box) => box.left)) + window.scrollX,
        right: Math.max(...boxes.map((box) => box.right)) + window.scrollX,
        top: Math.min(...boxes.map((box) => box.top)) + window.scrollY,
      },
      deviceScaleFactor: window.devicePixelRatio,
      pageSize: {
        height: document.documentElement.scrollHeight,
        width: document.documentElement.scrollWidth,
      },
    };
  });
  const padding = 14;
  const x = Math.max(0, bounds.left - padding);
  const y = Math.max(0, bounds.top - padding);
  const height = Math.min(pageSize.height, bounds.bottom + padding) - y;
  const width = Math.min(pageSize.width, bounds.right + padding) - x;
  const cropWidth = Math.round(width * deviceScaleFactor);
  const cropHeight = Math.round(height * deviceScaleFactor);
  const cropX = Math.round(x * deviceScaleFactor);
  const cropY = Math.round(y * deviceScaleFactor);
  return {
    crop: `${cropWidth}x${cropHeight}+${cropX}+${cropY}`,
    shot: await page.screenshot({ animations: "disabled", fullPage: true, type: "png" }),
  };
};

const capture = async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    for (const viewport of DOCS_SCREENSHOT_VIEWPORTS) {
      for (const theme of DOCS_SCREENSHOT_THEMES) {
        for (const captureCase of CAPTURE_CASES) {
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
          await page.getByText(captureCase.waitFor, { exact: true }).last().waitFor({ state: "visible" });
          if (captureCase.dismissGuide) await page.getByRole("button", { name: "End guide", exact: true }).click();
          if (captureCase.openOutputOptions) {
            const output = page.locator("#rom-weaver-row-output-file-name");
            const options = output.locator(".cks > .cks-head");
            if ((await options.getAttribute("aria-expanded")) === "false") await options.click();
            await output.locator("#rom-weaver-bundle-export-format").waitFor({ state: "visible" });
          }
          await waitForStableContent(page);
          await assertNoDevBadge(page);
          await page.locator(".skip-link").evaluate((element) => element.setAttribute("hidden", ""));
          const outputBase = path.join(OUTPUT_DIR, `${captureCase.name}-${viewport.name}-${theme}`);
          const { crop, shot } = await captureRegion(page, captureCase.target);
          for (const { extension, imageMagickArgs } of DOCS_SCREENSHOT_FORMATS) {
            const image = execFileSync(IMAGE_MAGICK, ["png:-", "-crop", crop, "+repage", ...imageMagickArgs], {
              input: shot,
              maxBuffer: 64 * 1024 * 1024,
            });
            fs.writeFileSync(`${outputBase}.${extension}`, image);
          }
          await context.close();
          console.log(`Captured ${path.relative(PACKAGE_DIR, outputBase)}.{${CAPTURE_EXTENSION_LIST}}`);
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
