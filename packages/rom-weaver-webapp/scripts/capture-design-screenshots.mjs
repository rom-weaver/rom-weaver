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
  waitForDocsScreenshotReady,
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

// Every docs capture is one whole viewport, so each viewport's images share
// one size and the docs markup can never disagree with a crop. The README's
// full-page capture shows the complete page instead.
const captureView = async (page, { fullPage = false, target: selector }) => {
  if (fullPage) return page.screenshot({ animations: "disabled", fullPage: true, type: "png" });
  await page
    .locator(selector)
    .first()
    .evaluate((element) => {
      if (element.closest("dialog")) return;
      const top = element.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ behavior: "instant", top: Math.max(0, top - 16) });
    });
  return page.screenshot({ animations: "disabled", type: "png" });
};

// A PPF3 patch with undo data, so PPF Undo can restore the original sample ROM.
const createPpfUndoSample = () => {
  const { firstPatchResult, originalRom } = createFirstSampleAssets();
  const header = Buffer.alloc(60);
  header.write("PPF30", 0, "ascii");
  header[5] = 2;
  header.write("rom-weaver PPF undo sample", 6, "ascii");
  header[58] = 1;
  const records = [];
  for (let offset = 0; offset < originalRom.length;) {
    if (originalRom[offset] === firstPatchResult[offset]) {
      offset += 1;
      continue;
    }
    let end = offset;
    while (end < originalRom.length && end - offset < 255 && originalRom[end] !== firstPatchResult[end]) end += 1;
    const position = Buffer.alloc(9);
    position.writeBigUInt64LE(BigInt(offset));
    position[8] = end - offset;
    records.push(position, firstPatchResult.subarray(offset, end), originalRom.subarray(offset, end));
    offset = end;
  }
  return { patch: Buffer.concat([header, ...records]), patchedRom: firstPatchResult };
};

const openConsoleTab = async (page, tab) => {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#console-${tab}`);
  await page.locator("dialog[open]").waitFor({ state: "visible" });
};

const prepareScreenshot = async (page, name) => {
  if (name === "settings" || name === "offline") {
    await openConsoleTab(page, name);
    return;
  }
  if (name === "cheat-apply-cheats") {
    await page.getByRole("button", { name: /Add cheats to the patch order/ }).click();
    await page.getByRole("button", { name: "Add code manually", exact: true }).waitFor();
    return;
  }
  if (name === "cheat-create-cheats") {
    await page.getByRole("button", { name: "Cheat codes", exact: true }).click();
    await page.getByRole("button", { name: /Pick from the cheat database/ }).click();
    await page.getByRole("button", { name: "Add code manually", exact: true }).waitFor();
    return;
  }
  if (name === "compress-select-files" || name === "compress") {
    await page.locator("#compress-input-picker").setInputFiles({
      buffer: createFirstSampleAssets().firstWeaveZip,
      mimeType: "application/zip",
      name: "rom-weaver-sample.zip",
    });
    await page.getByText("rom-weaver-bundle.json", { exact: true }).click();
    await page.getByText("world-to-weaver.ips", { exact: true }).click();
    const addFiles = page.getByRole("button", { name: "Add 2 files", exact: true });
    await addFiles.waitFor();
    if (name === "compress") {
      await addFiles.click();
      await addFiles.waitFor({ state: "detached" });
    }
    return;
  }
  if (name === "ppf-undo") {
    const { patch, patchedRom } = createPpfUndoSample();
    await page.locator("#ppf-undo-input-picker").setInputFiles([
      { buffer: patchedRom, mimeType: "application/octet-stream", name: "rom-world.nes" },
      { buffer: patch, mimeType: "application/octet-stream", name: "hello-to-rom.ppf" },
    ]);
    await page.getByRole("button", { name: /Restore original ROM/i }).click();
    await page
      .getByRole("button", { name: /Download/i })
      .first()
      .waitFor();
    return;
  }
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
  const browser = await chromium.launch({ ...launchOptions, headless: true, args: ["--mute-audio"] });
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
          const outputName = `${captureCase.name}-${viewport.name}-${theme}`;
          const startedAt = performance.now();
          const diagnostics = [];
          const recordDiagnostic = (message) => {
            diagnostics.push(message.slice(0, 1000));
            if (diagnostics.length > 20) diagnostics.shift();
          };
          page.on("pageerror", (error) => recordDiagnostic(`Page error: ${error.message}`));
          page.on("console", (message) => {
            if (message.type() === "error") recordDiagnostic(`Console error: ${message.text()}`);
          });
          console.log(`Capturing ${outputName}: ${pageUrl(captureCase.route)}`);
          try {
            await page.goto(pageUrl(captureCase.route), { waitUntil: "domcontentloaded" });
            await waitForDocsScreenshotReady(page, captureCase);
            if (captureCase.dismissGuide) {
              const exitGuide = page.getByRole("button", { name: "Leave the guide", exact: true });
              await exitGuide.evaluate((button) => button.click());
              await exitGuide.waitFor({ state: "detached" });
            }
            await prepareScreenshot(page, captureCase.name);
            await waitForStableContent(page);
            await assertNoDevBadge(page);
            await page.locator(".skip-link").evaluate((element) => element.setAttribute("hidden", ""));
            await page.locator(".dock").evaluateAll((elements) => {
              for (const element of elements) element.style.visibility = "hidden";
            });
            const shot = await captureView(page, captureCase);
            const png = execFileSync(IMAGE_MAGICK, ["png:-", "-depth", "8", "PNG24:-"], {
              input: shot,
              maxBuffer: 64 * 1024 * 1024,
            });
            for (const { extension } of DOCS_SCREENSHOT_FORMATS) {
              const image =
                extension === "avif"
                  ? Buffer.from(await avifEncode(decodeRgba(png), { quality: 80 }))
                  : execFileSync(
                      IMAGE_MAGICK,
                      ["png:-", "-define", "webp:lossless=true", "-define", "webp:method=6", "webp:-"],
                      { input: png, maxBuffer: 64 * 1024 * 1024 },
                    );
              if (!image.length) throw new Error(`Screenshot encoder returned no ${extension} data for ${outputName}`);
              fs.writeFileSync(path.join(OUTPUT_DIR, `${outputName}.${extension}`), image);
            }
            console.log(
              `Captured ${path.relative(PACKAGE_DIR, path.join(OUTPUT_DIR, outputName))}.{${CAPTURE_EXTENSION_LIST}} in ${Math.round(performance.now() - startedAt)}ms`,
            );
          } catch (error) {
            const failurePath = path.join(OUTPUT_DIR, `${outputName}-failure.png`);
            const results = await Promise.allSettled([
              page.screenshot({ path: failurePath, animations: "disabled", timeout: 5000 }),
              page.locator("body").innerText({ timeout: 2000 }),
            ]);
            const [screenshot, body] = results;
            process.stderr.write(
              `Capture failed: ${outputName} after ${Math.round(performance.now() - startedAt)}ms\n` +
                `URL: ${page.url()}\nTarget: ${captureCase.target}\n` +
                `Screenshot: ${screenshot.status === "fulfilled" ? failurePath : String(screenshot.reason).slice(0, 1000)}\n` +
                `Body: ${body.status === "fulfilled" ? body.value.slice(0, 4000) : String(body.reason).slice(0, 1000)}\n` +
                `${diagnostics.join("\n")}\n`,
            );
            throw error;
          } finally {
            await context.close();
          }
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
