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
 *   node scripts/generate-channel-icons.mjs --output-dir <directory> [--check]
 *
 * Derived icons are build artifacts. They stay outside the webapp's `dist/`,
 * which Vite clears before every build.
 *
 * --check re-renders into memory and diffs against the selected output,
 * exiting non-zero on drift.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ACCENTS, DEFAULT_ACCENT } from "../src/webapp/accent-palette.mjs";
import { tintBrandMark } from "../src/webapp/brand-mark-assets.mjs";
import { assertSamePixels, decodeRgba, optimizePng } from "./optimize-png.mjs";
import { encodeAvif, encodeWebp } from "./social-preview-encoders.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(rootDir, "..", "..");
const assetRoot = path.join(rootDir, "src", "assets", "app", "root");
const designRoot = path.join(rootDir, "design");
const masterRoot = path.join(designRoot, "icon-masters");

const usage = () => {
  throw new Error("Usage: node scripts/generate-channel-icons.mjs --output-dir <directory> [--check]");
};

const parseOptions = (args) => {
  let checkOnly = false;
  let outputDir;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--check") {
      checkOnly = true;
      continue;
    }
    if (argument === "--output-dir") {
      const candidate = args[index + 1];
      if (!candidate || candidate.startsWith("--")) usage();
      outputDir = candidate;
      index += 1;
      continue;
    }
    usage();
  }
  if (!outputDir) usage();
  return { checkOnly, outputDir: path.resolve(process.cwd(), outputDir) };
};

// Channel defaults MUST match src/webapp/build-channel.ts.
const CHANNEL_ACCENTS = { production: DEFAULT_ACCENT, beta: "woad", nightly: "verdigris", preview: "plum" };

// Sizes come from design/icon-masters/README.md; each master already bakes in
// its own scale/offset for the mask it targets.
const RASTER_TARGETS = [
  { master: "icon-maskable.svg", output: "icon-maskable-512.png", size: 512 },
  { master: "icon-maskable.svg", output: "icon-maskable-192.png", size: 192 },
  { master: "apple-touch-icon.svg", output: "apple-touch-icon.png", size: 180 },
];

// The social card renders at 2x its 1280x640 master so it matches the
// dimensions index.html advertises to crawlers. It is one image for every
// channel, as the deployed og:image URL is the same on all of them.
const SOCIAL_PREVIEW = { height: 1280, master: "social-preview.svg", width: 2560 };

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 12);

/**
 * Lay an SVG out at an exact pixel size. It is handed over as a data URI inside
 * a bare page so nothing else can contribute pixels.
 */
const showSvg = async (page, svg, width, height) => {
  const dataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setViewportSize({ height, width });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${width}px;height:${height}px}</style><img src="${dataUri}">`,
  );
  await page.locator("img").waitFor({ state: "visible" });
  await page.locator("img").evaluate((img) => img.decode());
};

/** Screenshot a square master as an optimized PNG. */
const rasterize = async (page, svg, size) => {
  await showSvg(page, svg, size, size);
  const shot = await page.screenshot({ omitBackground: true, type: "png" });
  // Chrome writes a conservatively-filtered, middling-deflate PNG. Squeeze it
  // here rather than as a later pass so the bytes `--check` compares against
  // are the deployed build assets.
  const optimized = optimizePng(shot);
  assertSamePixels(shot, optimized, `rasterized ${size}px icon`);
  return optimized;
};

/**
 * Render the social card once and return it in all three formats crawlers are
 * offered. WebP and AVIF encode from the PNG's own pixels, so the three can
 * never drift apart.
 */
const renderSocialPreview = async (page, svg) => {
  const { height, width } = SOCIAL_PREVIEW;
  await showSvg(page, svg, width, height);
  // The master paints a full-bleed background, so the card is opaque; keep it
  // that way rather than handing crawlers an alpha channel they ignore.
  const shot = await page.screenshot({ type: "png" });
  const png = optimizePng(shot);
  assertSamePixels(shot, png, "rasterized social preview");
  const pixels = decodeRgba(png);
  return { avif: await encodeAvif(pixels), png, webp: await encodeWebp(pixels) };
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
  const { checkOnly, outputDir } = parseOptions(process.argv.slice(2));
  const outputRoot = path.join(outputDir, "channel-icons");
  const variantRoot = path.join(outputDir, "logo-variants");
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
      const channelDir = path.join(outputRoot, channel);

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

    console.log("social preview");
    const socialMaster = fs.readFileSync(path.join(designRoot, SOCIAL_PREVIEW.master), "utf8");
    const social = await renderSocialPreview(page, socialMaster);
    for (const [format, buffer] of Object.entries(social)) {
      emit(path.join(outputDir, `social-preview.${format}`), buffer);
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
