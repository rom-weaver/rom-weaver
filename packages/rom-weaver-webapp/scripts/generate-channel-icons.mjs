#!/usr/bin/env node
/**
 * Rasterize the production and per-channel app icons.
 *
 * The cartridge MUST stay cream on the launcher background; only the tab uses the channel accent.
 *
 * Rendering matches design/icon-masters/README.md: headless Chrome, because
 * ImageMagick's SVG delegate does not render these masters exactly. Playwright's
 * chromium is already a dev dependency, so this adds none.
 *
 *   node scripts/generate-channel-icons.mjs [--check]
 *
 * --check re-renders into memory and diffs against what's committed, exiting
 * non-zero on drift, so CI can prove the icons match their sources.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ACCENTS, DEFAULT_ACCENT } from "../src/webapp/accent-palette.mjs";
import { tintBrandMark } from "../src/webapp/brand-mark-assets.mjs";
import { assertSamePixels, optimizePng } from "./optimize-png.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(rootDir, "..", "..");
const assetRoot = path.join(rootDir, "src", "assets", "app", "root");
const masterRoot = path.join(rootDir, "design", "icon-masters");
const outputRoot = path.join(assetRoot, "channels");
const variantRoot = path.join(repoRoot, "design", "logo-variants");

// Channel defaults MUST match src/webapp/build-channel.ts.
const CHANNEL_ACCENTS = { production: DEFAULT_ACCENT, beta: "woad", nightly: "verdigris", preview: "plum" };

// Sizes come from design/icon-masters/README.md; each master already bakes in
// its own scale/offset for the mask it targets.
const RASTER_TARGETS = [
  { master: "icon-maskable.svg", output: "icon-maskable-512.png", size: 512 },
  { master: "icon-maskable.svg", output: "icon-maskable-192.png", size: 192 },
  { master: "apple-touch-icon.svg", output: "apple-touch-icon.png", size: 180 },
];

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 12);

/**
 * Screenshot an SVG at an exact pixel size. The SVG is handed over as a data
 * URI inside a bare page so nothing else can contribute pixels.
 */
const rasterize = async (page, svg, size) => {
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setViewportSize({ height: size, width: size });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${dataUri}">`,
  );
  await page.locator("img").waitFor({ state: "visible" });
  await page.locator("img").evaluate((img) => img.decode());
  const shot = await page.screenshot({ omitBackground: true, type: "png" });
  // Chrome writes a conservatively-filtered, middling-deflate PNG. Squeeze it
  // here rather than as a later pass so the bytes `--check` compares against
  // are the bytes that get committed.
  const optimized = optimizePng(shot);
  assertSamePixels(shot, optimized, `rasterized ${size}px icon`);
  return optimized;
};

// ICO directory offsets MUST address the PNG payloads from the start of the file.
const encodeFavicon = (images) => {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  for (const [index, { size, png }] of images.entries()) {
    const entry = 6 + index * 16;
    directory.writeUInt8(size, entry);
    directory.writeUInt8(size, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
};

const main = async () => {
  const checkOnly = process.argv.includes("--check");
  const launchOptions = process.env.ROM_WEAVER_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {};
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const drift = [];
  let written = 0;

  const emit = (target, buffer) => {
    const relative = path.relative(repoRoot, target);
    const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (existing && existing.equals(buffer)) return;
    if (checkOnly) {
      drift.push(`${relative} (${existing ? `is ${digest(existing)}` : "missing"}, want ${digest(buffer)})`);
      return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    written += 1;
    console.log(`  wrote ${relative}`);
  };

  try {
    for (const [channel, accentName] of Object.entries(CHANNEL_ACCENTS)) {
      const accent = ACCENTS.find((entry) => entry.value === accentName);
      if (!accent) throw new Error(`Unknown channel accent: ${accentName}`);
      const channelDir = channel === "production" ? assetRoot : path.join(outputRoot, channel);

      console.log(channel);
      emit(
        path.join(channelDir, "logo.svg"),
        Buffer.from(tintBrandMark(fs.readFileSync(path.join(assetRoot, "logo.svg"), "utf8"), accent)),
      );

      for (const target of RASTER_TARGETS) {
        const master = tintBrandMark(fs.readFileSync(path.join(masterRoot, target.master), "utf8"), accent);
        emit(path.join(channelDir, target.output), await rasterize(page, master, target.size));
      }

      const favicon = tintBrandMark(fs.readFileSync(path.join(masterRoot, "favicon.svg"), "utf8"), accent);
      const images = [];
      for (const size of [16, 32, 48, 64]) {
        images.push({ size, png: await rasterize(page, favicon, size) });
      }
      emit(path.join(channelDir, "favicon.ico"), encodeFavicon(images));
    }

    const logo = fs.readFileSync(path.join(assetRoot, "logo.svg"), "utf8");
    for (const accent of ACCENTS) {
      emit(path.join(variantRoot, `${accent.value}.svg`), Buffer.from(tintBrandMark(logo, accent)));
    }
  } finally {
    await browser.close();
  }

  if (checkOnly && drift.length) {
    console.error("\nApp icons are stale - re-run `npm run icons:channels`:");
    for (const entry of drift) console.error(`  ${entry}`);
    process.exit(1);
  }
  console.log(checkOnly ? "\nApp icons are up to date." : `\nDone (${written} file(s) changed).`);
};

await main();
