import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACCENTS, DEFAULT_ACCENT } from "../src/webapp/accent-palette.mjs";

/**
 * Pre-tints the masthead logo once per accent and serves the result to the app
 * as `virtual:rom-weaver-brand-marks` - a map of accent value to asset URL.
 *
 * The mark used to ship as `logo.svg?raw` plus string tinting in the client
 * (an `<img src="logo.svg">` is a separate document CSS can't reach into), but
 * that inlined ~18 kB of SVG text into a first-paint chunk to produce six
 * variants that never change at runtime. Tinting here moves that work - and
 * those bytes - to the build.
 *
 * The emitted file names hash the tinted content, not the build: the prerender
 * SSR pass and the dev server run this same module and compute identical URLs,
 * so the prerendered `<img>` always matches what the client renders (no
 * hydration mismatch) and the assets stay safe under the immutable
 * `/assets/*` cache policy.
 */

const VIRTUAL_ID = "virtual:rom-weaver-brand-marks";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const logoSourcePath = path.resolve(import.meta.dirname, "../src/assets/app/root/logo.svg");

const createBrandMarks = () => {
  const logoSvg = fs.readFileSync(logoSourcePath, "utf8");
  const madder = ACCENTS.find((accent) => accent.value === DEFAULT_ACCENT);
  if (!madder) throw new Error(`brand marks: default accent '${DEFAULT_ACCENT}' missing from the palette`);
  return ACCENTS.map((accent) => {
    const source = logoSvg.replaceAll(madder.swatch, accent.swatch).replaceAll(madder.highlight, accent.highlight);
    if (source.includes(madder.swatch) && accent.value !== DEFAULT_ACCENT) {
      throw new Error(`brand marks: ${madder.swatch} survived the ${accent.value} tint - logo.svg palette changed?`);
    }
    const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 8);
    return { fileName: `assets/brand-mark-${accent.value}-${hash}.svg`, source, value: accent.value };
  });
};

/** @param {import("node:http").ServerResponse} res @param {string} source */
const sendSvg = (res, source) => {
  res.statusCode = 200;
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "no-cache");
  res.end(source);
};

const brandMarkAssets = () => {
  let isBuild = false;
  /** @type {ReturnType<typeof createBrandMarks> | null} */
  let cachedMarks = null;
  const getMarks = () => {
    cachedMarks ??= createBrandMarks();
    return cachedMarks;
  };
  const middleware = (req, res, next) => {
    const requestPath = req.url ? req.url.split("?")[0] : "";
    // Matched by suffix: a dev document without a <base> tag (e.g. /create/)
    // resolves the relative URL against its own path.
    const mark = getMarks().find((entry) => requestPath.endsWith(`/${entry.fileName}`));
    if (!mark) {
      next();
      return;
    }
    sendSvg(res, mark.source);
  };
  return {
    configResolved(config) {
      isBuild = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined;
      const marks = getMarks();
      if (isBuild) {
        for (const mark of marks) this.emitFile({ fileName: mark.fileName, source: mark.source, type: "asset" });
      }
      const entries = marks
        .map((mark) => `  ${JSON.stringify(mark.value)}: ${JSON.stringify(`./${mark.fileName}`)},`)
        .join("\n");
      return `export const BRAND_MARK_SRC = {\n${entries}\n};\n`;
    },
    name: "rom-weaver-brand-mark-assets",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
    },
  };
};

export { brandMarkAssets };
