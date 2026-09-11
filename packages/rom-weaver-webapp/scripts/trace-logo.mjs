#!/usr/bin/env node
/**
 * Trace the brand mark from its reference render into src/assets/app/root/logo.svg.
 *
 * The mark is a raster comp, so the vector is a trace of it rather than a
 * hand-drawn approximation - three flat colours, one potrace layer each. Pixels
 * are snapped to the brand palette first, so the accent layer comes out as the
 * single `#d9690f` fill that `tintBrandMark` re-dyes and `--thread` overrides.
 *
 * Cream that touches the image border is the page behind the comp, not part of
 * the mark; it is flood-filled away so the logo stays transparent outside the
 * cartridge.
 *
 * Needs potrace on PATH (`brew install potrace`).
 *
 *   node scripts/trace-logo.mjs [--check]
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(root, "..", "..");
const source = path.join(repoRoot, "design", "logo-concepts", "thread-weave.png");
const target = path.join(root, "src", "assets", "app", "root", "logo.svg");
const component = path.join(root, "src", "webapp", "components", "brand-mark.tsx");

// Layer order is paint order; the regions are disjoint, so it only decides ties.
const LAYERS = [
  { fill: "#20282d", name: "dark", rgb: [0x20, 0x28, 0x2d] },
  { fill: "#f6ecda", name: "cream", rgb: [0xf6, 0xec, 0xda] },
  { band: true, fill: "#d9690f", name: "accent", rgb: [0xd9, 0x69, 0x0f] },
];
// Below this many pixels a region is comp grain, not artwork.
const TURD_SIZE = 100;
// potrace units (tenths of a source pixel) below which a subpath is an edge sliver.
const HAIRLINE = 60;

const readPixels = (file, work) => {
  const raw = path.join(work, "src.raw");
  execFileSync("magick", [file, "-depth", "8", `RGB:${raw}`]);
  const size = JSON.parse(execFileSync("magick", [file, "-format", "[%w,%h]", "info:"], { encoding: "utf8" }));
  return { height: size[1], rgb: fs.readFileSync(raw), width: size[0] };
};

/** Snap every pixel to the nearest palette entry and return its layer index. */
const quantize = ({ height, rgb, width }) => {
  const labels = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const r = rgb[3 * i];
    const g = rgb[3 * i + 1];
    const b = rgb[3 * i + 2];
    let best = 0;
    let bestDistance = Infinity;
    LAYERS.forEach((layer, index) => {
      const [lr, lg, lb] = layer.rgb;
      const distance = (r - lr) ** 2 + (g - lg) ** 2 + (b - lb) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    labels[i] = best;
  }
  return labels;
};

/** Flood-fill the border-connected cream: the page behind the comp. */
const findBackdrop = (labels, width, height) => {
  const cream = LAYERS.findIndex((layer) => layer.name === "cream");
  const backdrop = new Uint8Array(width * height);
  const stack = [];
  const push = (index) => {
    if (labels[index] === cream && !backdrop[index]) {
      backdrop[index] = 1;
      stack.push(index);
    }
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (stack.length) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) push(index - 1);
    if (x < width - 1) push(index + 1);
    if (y > 0) push(index - width);
    if (y < height - 1) push(index + width);
  }
  return backdrop;
};

const writeBitmap = (file, labels, backdrop, layer, width, height) => {
  const stride = Math.ceil(width / 8);
  const bits = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (labels[index] !== layer || backdrop[index]) continue;
      bits[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P4\n${width} ${height}\n`), bits]));
};

/**
 * potrace closes a run of pixels one unit wide as a zero-area sliver where two
 * colours share an edge. Such a subpath paints nothing but bloats the file, so
 * it is dropped on its bounding box. Coordinates after the leading M are
 * relative, so the box has to be walked rather than read off the numbers.
 */
const isHairline = (subpath) => {
  const tokens = subpath.match(/[MmCcLlHhVvZz]|-?\d+(?:\.\d+)?/g);
  if (!tokens) return true;
  let x = 0;
  let y = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const mark = () => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  let command = "M";
  let index = 0;
  const next = () => Number(tokens[index++]);
  while (index < tokens.length) {
    if (/[MmCcLlHhVvZz]/.test(tokens[index])) command = tokens[index++];
    if (index >= tokens.length && !/[Zz]/.test(command)) break;
    switch (command) {
      case "M":
        x = next();
        y = next();
        mark();
        command = "L";
        break;
      case "m":
        x += next();
        y += next();
        mark();
        command = "l";
        break;
      case "C":
        next();
        next();
        next();
        next();
        x = next();
        y = next();
        mark();
        break;
      case "c":
        next();
        next();
        next();
        next();
        x += next();
        y += next();
        mark();
        break;
      case "L":
        x = next();
        y = next();
        mark();
        break;
      case "l":
        x += next();
        y += next();
        mark();
        break;
      case "H":
        x = next();
        mark();
        break;
      case "h":
        x += next();
        mark();
        break;
      case "V":
        y = next();
        mark();
        break;
      case "v":
        y += next();
        mark();
        break;
      default:
        index = tokens.length;
        break;
    }
  }
  return maxX - minX < HAIRLINE || maxY - minY < HAIRLINE;
};

const trace = (bitmap, work, name) => {
  const out = path.join(work, `${name}.svg`);
  execFileSync("potrace", [
    "-s",
    "--turdsize",
    String(TURD_SIZE),
    "--alphamax",
    "1.0",
    "--opttolerance",
    "0.2",
    "-o",
    out,
    bitmap,
  ]);
  const text = fs.readFileSync(out, "utf8");
  const paths = [...text.matchAll(/<path d="(.*?)"\/>/gs)].map((match) => match[1]);
  if (!paths.length) throw new Error(`trace-logo: potrace produced no path for the ${name} layer`);
  const kept = paths
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?=M)/)
    .map((sub) => sub.trim())
    .filter((sub) => sub && !isHairline(sub));
  if (!kept.length) throw new Error(`trace-logo: every ${name} subpath was filtered out`);
  return kept.join(" ");
};

/** Run the generated component through oxfmt so --check compares like for like. */
const formatTsx = (tsx, work) => {
  const scratch = path.join(work, "brand-mark.tsx");
  fs.writeFileSync(scratch, tsx);
  execFileSync("npx", ["oxfmt", scratch], { cwd: root, stdio: "ignore" });
  return fs.readFileSync(scratch, "utf8");
};

const main = () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "rom-weaver-trace-"));
  try {
    const image = readPixels(source, work);
    const { width, height } = image;
    if (width !== height) throw new Error(`trace-logo: ${source} must be square, got ${width}x${height}`);
    const labels = quantize(image);
    const backdrop = findBackdrop(labels, width, height);

    const traced = LAYERS.map((layer, index) => {
      const bitmap = path.join(work, `${layer.name}.pbm`);
      writeBitmap(bitmap, labels, backdrop, index, width, height);
      return trace(bitmap, work, layer.name);
    });
    const body = LAYERS.map((layer, index) => {
      const className = layer.band ? ' class="brand-mark-band"' : "";
      return `    <path${className} fill="${layer.fill}" d="${traced[index]}"/>`;
    }).join("\n");

    // potrace emits tenths of a pixel with the y axis flipped; the outer scale
    // maps that back onto the 32-unit viewBox every other asset is built on.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <title>rom-weaver logo</title>
  <!--
    Traced from design/logo-concepts/thread-weave.png by scripts/trace-logo.mjs.
    Do not hand-edit the path data - re-run the script instead.
  -->
  <g transform="scale(${(32 / width).toFixed(7)}) translate(0 ${height}) scale(0.1 -0.1)">
${body}
  </g>
</svg>
`;
    const tsx = `import type { SVGProps } from "react";

/**
 * The logo is inlined, not an <img> asset, so the accent layer can be dyed by
 * \`--thread\` in CSS (see masthead.css). A per-accent image cannot read a custom
 * property, so its \`src\` had to be chosen in JS: the prerendered shell shipped
 * the build's default accent, React wanted the stored one, and React does not
 * patch a hydration attribute mismatch - leaving the mark on the wrong dye.
 *
 * Generated by scripts/trace-logo.mjs alongside logo.svg. Do not hand-edit.
 */
const BrandMark = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" className="brand-mark" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" {...props}>
    <g transform="scale(${(32 / width).toFixed(7)}) translate(0 ${height}) scale(0.1 -0.1)">
${LAYERS.map((layer, index) => {
  const d = traced[index];
  const className = layer.band ? ' className="brand-mark-band"' : "";
  return `      <path${className} d="${d}" fill="${layer.fill}" />`;
}).join("\n")}
    </g>
  </svg>
);

export { BrandMark };
`;

    const formatted = formatTsx(tsx, work);

    if (process.argv.includes("--check")) {
      const stale = [
        [target, svg],
        [component, formatted],
      ].filter(([file, want]) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") !== want);
      if (stale.length) {
        console.error("Traced logo files are stale - re-run `node scripts/trace-logo.mjs`:");
        for (const [file] of stale) console.error(`  ${path.relative(repoRoot, file)}`);
        process.exit(1);
      }
      console.log("Traced logo files match their reference render.");
      return;
    }
    fs.writeFileSync(target, svg);
    fs.writeFileSync(component, formatted);
    console.log(`wrote ${path.relative(repoRoot, target)} (${svg.length} bytes)`);
    console.log(`wrote ${path.relative(repoRoot, component)} (${formatted.length} bytes)`);
  } finally {
    fs.rmSync(work, { force: true, recursive: true });
  }
};

main();
