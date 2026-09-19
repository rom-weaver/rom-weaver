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
import {
  BRAND_MARK_TIGHT_VIEWBOX,
  BRAND_MARK_TONES,
  renderBrandMark,
  renderFavicon,
} from "../src/webapp/brand-mark-assets.mjs";
import { assertSamePixels, decodeRgba, optimizePng } from "./optimize-png.mjs";
import { encodeAvif, encodeWebp } from "./social-preview-encoders.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(rootDir, "..", "..");
const designRoot = path.join(rootDir, "design");
const masterRoot = path.join(designRoot, "icon-masters");
const brandMasterPath = path.join(masterRoot, "brand-mark.svg");

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

// Sizes come from design/icon-masters/README.md. The wrappers are generated
// around the transparent light-tone mark so the source master stays reusable.
const APP_ICON_BACKGROUND = "#31343a";
const APP_ICON_TARGETS = [
  { minInsetRatio: 0.09, output: "icon-192.png", scale: 0.9, size: 192 },
  { minInsetRatio: 0.09, output: "icon-512.png", scale: 0.9, size: 512 },
  { minInsetRatio: 0.15, output: "icon-maskable-512.png", scale: 0.72, size: 512 },
];
const APPLE_TOUCH_ICON = { scale: 0.9, size: 180 };
const FAVICON_FALLBACK_SCALE = 0.99;

// Social cards MUST match the dimensions index.html advertises to crawlers.
const SOCIAL_PREVIEW = { height: 1280, width: 2560 };

const digest = (buffer) => createHash("sha256").update(buffer).digest("hex").slice(0, 12);

const readBrandMaster = () => fs.readFileSync(brandMasterPath, "utf8");

const stripSvgShell = (svg) => svg.replace(/<svg\b[^>]*>/, "").replace("</svg>", "");

const appIconWrapper = (logo, scale) => {
  const offset = 32 * (1 - scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><title>rom-weaver app icon</title><path fill="${APP_ICON_BACKGROUND}" d="M0 0h64v64H0z"/><g transform="translate(${offset} ${offset}) scale(${scale})">${stripSvgShell(logo)}</g></svg>`;
};

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

const assertAppIconFit = (png, { label, minInsetRatio, size }) => {
  const { data, height, width } = decodeRgba(png);
  const background = [0x31, 0x34, 0x3a];
  for (let offset = 3; offset < data.length; offset += 4) {
    if (data[offset] !== 255) throw new Error(`${label}: app icon background must be opaque`);
  }
  const isMark = (x, y) => {
    const offset = (y * width + x) * 4;
    return background.some((channel, index) => data[offset + index] !== channel);
  };
  const rowHasMark = (y) => Array.from({ length: width }, (_, x) => isMark(x, y)).some(Boolean);
  const columnHasMark = (x) => Array.from({ length: height }, (_, y) => isMark(x, y)).some(Boolean);
  const top = Array.from({ length: height }, (_, y) => y).find(rowHasMark);
  const bottomY = Array.from({ length: height }, (_, y) => height - 1 - y).find(rowHasMark);
  const left = Array.from({ length: width }, (_, x) => x).find(columnHasMark);
  const rightX = Array.from({ length: width }, (_, x) => width - 1 - x).find(columnHasMark);
  const bottom = bottomY === undefined ? undefined : height - 1 - bottomY;
  const right = rightX === undefined ? undefined : width - 1 - rightX;
  const insets = [top, bottom, left, right];
  const minimumInset = Math.ceil(size * minInsetRatio);
  if (
    width !== size ||
    height !== size ||
    insets.some((inset) => inset === undefined || inset < minimumInset) ||
    Math.abs(top - bottom) > 1 ||
    Math.abs(left - right) > 1
  ) {
    throw new Error(`${label}: mark must be centered inside its mask safe area; got ${insets.join(", ")}`);
  }
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
    const brandMaster = readBrandMaster();
    for (const [channel, accentName] of Object.entries(CHANNEL_ACCENTS)) {
      const accent = ACCENTS.find((entry) => entry.value === accentName);
      if (!accent) throw new Error(`Unknown channel accent: ${accentName}`);
      const channelDir = path.join(outputRoot, channel);

      console.log(channel);
      emit(
        path.join(channelDir, "logo.svg"),
        Buffer.from(renderBrandMark(brandMaster, { accent, viewBox: BRAND_MARK_TIGHT_VIEWBOX })),
      );

      const favicon = renderFavicon(brandMaster, { accent });
      emit(path.join(channelDir, "favicon.svg"), Buffer.from(favicon));

      const appIconMark = renderBrandMark(brandMaster, { accent, tone: "light" });
      for (const target of APP_ICON_TARGETS) {
        const appIcon = await rasterize(page, appIconWrapper(appIconMark, target.scale), target.size);
        assertAppIconFit(appIcon, { ...target, label: target.output });
        emit(path.join(channelDir, target.output), appIcon);
      }

      const appleTouchIcon = await rasterize(
        page,
        appIconWrapper(appIconMark, APPLE_TOUCH_ICON.scale),
        APPLE_TOUCH_ICON.size,
      );
      assertAppIconFit(appleTouchIcon, {
        label: "apple-touch-icon.png",
        minInsetRatio: 0.09,
        size: APPLE_TOUCH_ICON.size,
      });
      emit(path.join(channelDir, "apple-touch-icon.png"), appleTouchIcon);

      const fallbackFavicon = appIconWrapper(appIconMark, FAVICON_FALLBACK_SCALE);
      const images = [];
      for (const size of [16, 32, 48, 64]) {
        const png = await rasterize(page, fallbackFavicon, size);
        assertAppIconFit(png, { label: `favicon ${size}px`, minInsetRatio: 0.04, size });
        if (size === 32) emit(path.join(channelDir, "favicon-32x32.png"), png);
        images.push({ size, png });
      }
      emit(path.join(channelDir, "favicon.ico"), encodeFavicon(images));
    }

    for (const name of ["social-preview", "social-preview-dark"]) {
      console.log(name);
      const socialMaster = fs.readFileSync(path.join(designRoot, `${name}.svg`), "utf8");
      const social = await renderSocialPreview(page, socialMaster);
      for (const [format, buffer] of Object.entries(social)) {
        emit(path.join(outputDir, `${name}.${format}`), buffer);
      }
    }

    const logo = readBrandMaster();
    for (const accent of ACCENTS) {
      emit(
        path.join(variantRoot, `${accent.value}.svg`),
        Buffer.from(renderBrandMark(logo, { accent, viewBox: BRAND_MARK_TIGHT_VIEWBOX })),
      );
      for (const tone of BRAND_MARK_TONES) {
        emit(
          path.join(variantRoot, tone, `${accent.value}.svg`),
          Buffer.from(renderBrandMark(logo, { accent, tone, viewBox: BRAND_MARK_TIGHT_VIEWBOX })),
        );
      }
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
