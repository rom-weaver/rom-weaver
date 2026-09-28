#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import avifEncode, { init as initAvif } from "@jsquash/avif/encode.js";
import { chromium } from "playwright";
import { createFirstSampleAssets } from "./first-sample-assets.mjs";
import { decodeRgba } from "./optimize-png.mjs";
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

const prepareScreenshot = async (page, name) => {
  if (name === "identify-checks") {
    await page.locator("#identify-input-picker").setInputFiles({
      buffer: createFirstSampleAssets().originalRom,
      mimeType: "application/octet-stream",
      name: "hello-world.nes",
    });
    await page.getByRole("button", { name: "Copy SHA-1", exact: true }).first().waitFor();
    return;
  }
  if (name === "save-editor") {
    await page.getByRole("button", { name: "Choose a game", exact: true }).click();
    await page.getByRole("button", { name: "Create save", exact: true }).click();
    await page.getByRole("searchbox", { name: "Find a property" }).fill("player name");
    await page.getByRole("textbox", { name: "File 1 player name" }).fill("HERO");
    await page.getByRole("button", { name: "Preview changes", exact: true }).click();
    await page.getByText(/1 field changes · integrity valid/).waitFor();
    return;
  }
  if (name === "test-player") {
    const player = page.frameLocator("iframe");
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
      await player.locator(".ejs_start_button").click();
    }
    await player.locator("canvas").waitFor({ state: "visible" });
    return;
  }
  if (name === "cheat-step") {
    await page.getByRole("button", { name: /Add cheats to the patch order/ }).click();
    await page.getByRole("button", { name: "Add code manually", exact: true }).click();
    await page.getByRole("textbox", { name: "Description", exact: true }).fill("Example ROM write");
    await page.getByRole("textbox", { name: "Cheat code", exact: true }).fill("SXIOPO");
    await page.getByRole("button", { name: "Check code", exact: true }).click();
    await page.getByRole("button", { name: "Add this cheat", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add cheats", exact: true });
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("checkbox", { name: "Include Example ROM write", exact: true }).waitFor();
  }
};

const capture = async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  await initAvif(
    await WebAssembly.compile(
      fs.readFileSync(path.join(PACKAGE_DIR, "node_modules/@jsquash/avif/codec/enc/avif_enc.wasm")),
    ),
  );
  const launchOptions = process.env.ROM_WEAVER_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {};
  const browser = await chromium.launch({ ...launchOptions, args: ["--mute-audio"] });
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
          if (captureCase.dismissGuide) {
            const exitGuide = page.getByRole("button", { name: "Exit tutorial", exact: true });
            await exitGuide.evaluate((button) => button.click());
            await exitGuide.waitFor({ state: "detached" });
          }
          await prepareScreenshot(page, captureCase.name);
          await waitForStableContent(page);
          await assertNoDevBadge(page);
          await page.locator(".skip-link").evaluate((element) => element.setAttribute("hidden", ""));
          await page.locator(".dock").evaluate((element) => {
            element.style.visibility = "hidden";
          });
          const outputName = `${captureCase.name}-${viewport.name}-${theme}`;
          const { crop, shot } = await captureRegion(page, captureCase.target);
          const cropped = execFileSync(IMAGE_MAGICK, ["png:-", "-crop", crop, "+repage", "-depth", "8", "PNG24:-"], {
            input: shot,
            maxBuffer: 64 * 1024 * 1024,
          });
          for (const { extension } of DOCS_SCREENSHOT_FORMATS) {
            const image =
              extension === "avif"
                ? Buffer.from(await avifEncode(decodeRgba(cropped), { quality: 80 }))
                : execFileSync(
                    IMAGE_MAGICK,
                    ["png:-", "-define", "webp:lossless=true", "-define", "webp:method=6", "webp:-"],
                    { input: cropped, maxBuffer: 64 * 1024 * 1024 },
                  );
            if (!image.length) throw new Error(`Screenshot encoder returned no ${extension} data for ${outputName}`);
            fs.writeFileSync(path.join(OUTPUT_DIR, `${outputName}.${extension}`), image);
          }
          await context.close();
          console.log(
            `Captured ${path.relative(PACKAGE_DIR, path.join(OUTPUT_DIR, outputName))}.{${CAPTURE_EXTENSION_LIST}}`,
          );
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
