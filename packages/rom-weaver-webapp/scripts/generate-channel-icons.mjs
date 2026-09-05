#!/usr/bin/env node
/**
 * Rasterize the per-channel app icons.
 *
 * A manifest's icons are read at install time, so an installed PWA's icon can
 * only vary per BUILD CHANNEL - it cannot follow the user's accent setting the
 * way the in-app mark does. This bakes one icon set per channel whose default
 * accent isn't madder, so a nightly install is a green tile on the home screen
 * and beta an indigo one.
 *
 * Outputs are COMMITTED (like the stock icons) and picked up by vite's static
 * asset copy. Nothing regenerates them during a normal build, so CI needs no
 * browser and the deploy job stays a plain node build. Re-run this by hand when
 * logo.svg, the icon masters, or an accent's colours change.
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
import { ACCENTS } from "../src/webapp/accent-palette.mjs";
import { tintBrandMark } from "./brand-mark-assets.mjs";
import { assertSamePixels, optimizePng } from "./optimize-png.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(rootDir, "..", "..");
const assetRoot = path.join(rootDir, "src", "assets", "app", "root");
const masterRoot = path.join(rootDir, "design", "icon-masters");
const outputRoot = path.join(assetRoot, "channels");

// Channel defaults MUST match src/webapp/build-channel.ts.
const CHANNEL_ACCENTS = {
  beta: "woad",
  nightly: "verdigris",
  preview: "plum",
};

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
  const shot = await page.screenshot({ omitBackground: true, type: "png" });
  // Chrome writes a conservatively-filtered, middling-deflate PNG. Squeeze it
  // here rather than as a later pass so the bytes `--check` compares against
  // are the bytes that get committed.
  const optimized = optimizePng(shot);
  assertSamePixels(shot, optimized, `rasterized ${size}px icon`);
  return optimized;
};

const main = async () => {
  const checkOnly = process.argv.includes("--check");
  const launchOptions = process.env.ROM_WEAVER_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {};
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const drift = [];
  let written = 0;

  try {
    for (const [channel, accentName] of Object.entries(CHANNEL_ACCENTS)) {
      const accent = ACCENTS.find((entry) => entry.value === accentName);
      if (!accent) throw new Error(`Unknown channel accent: ${accentName}`);
      const channelDir = path.join(outputRoot, channel);
      const emit = (name, buffer) => {
        const target = path.join(channelDir, name);
        const relative = path.relative(repoRoot, target);
        const existing = fs.existsSync(target) ? fs.readFileSync(target) : null;
        if (existing && existing.equals(buffer)) return;
        if (checkOnly) {
          drift.push(`${relative} (${existing ? `is ${digest(existing)}` : "missing"}, want ${digest(buffer)})`);
          return;
        }
        fs.mkdirSync(channelDir, { recursive: true });
        fs.writeFileSync(target, buffer);
        written += 1;
        console.log(`  wrote ${relative}`);
      };

      console.log(`${channel} (${accent.swatch})`);
      // The SVG favicon is the primary icon in index.html and the manifest, and
      // needs no rasterizing - a string swap is the whole job.
      emit("logo.svg", Buffer.from(tintBrandMark(fs.readFileSync(path.join(assetRoot, "logo.svg"), "utf8"), accent)));

      for (const target of RASTER_TARGETS) {
        const master = tintBrandMark(fs.readFileSync(path.join(masterRoot, target.master), "utf8"), accent);
        emit(target.output, await rasterize(page, master, target.size));
      }
    }
  } finally {
    await browser.close();
  }

  if (checkOnly && drift.length) {
    console.error("\nChannel icons are stale - re-run `npm run icons:channels`:");
    for (const entry of drift) console.error(`  ${entry}`);
    process.exit(1);
  }
  console.log(checkOnly ? "\nChannel icons are up to date." : `\nDone (${written} file(s) changed).`);
};

await main();
