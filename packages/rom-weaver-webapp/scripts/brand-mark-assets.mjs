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
const VIRTUAL_ID_FILTER = /^virtual:rom-weaver-brand-marks$/;
const RESOLVED_ID_FILTER = new RegExp(`^${RESOLVED_ID}$`);

const logoSourcePath = path.resolve(import.meta.dirname, "../src/assets/app/root/logo.svg");

const tintBrandMark = (svg, accent) => {
  const madder = ACCENTS.find((entry) => entry.value === DEFAULT_ACCENT);
  if (!madder) throw new Error(`brand marks: default accent '${DEFAULT_ACCENT}' missing from the palette`);
  if (!(svg.includes(madder.swatch) && svg.includes("#88a9cb"))) {
    throw new Error("brand marks: source must contain both the orange and dusty-blue bands");
  }
  if (accent.value === DEFAULT_ACCENT) return svg;
  return svg.replaceAll(madder.swatch, accent.swatch).replaceAll("#88a9cb", accent.highlight);
};

const createBrandMarks = () => {
  const logoSvg = fs.readFileSync(logoSourcePath, "utf8");
  return ACCENTS.map((accent) => {
    const source = tintBrandMark(logoSvg, accent);
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
      server.watcher.add(logoSourcePath);
      const reloadOnLogoChange = (file) => {
        if (path.resolve(String(file)) !== logoSourcePath) return;
        cachedMarks = null;
        const graphs = [
          server.environments?.client?.moduleGraph,
          server.environments?.ssr?.moduleGraph,
          server.moduleGraph,
        ];
        for (const graph of graphs) {
          const module = graph?.getModuleById?.(RESOLVED_ID);
          if (module) graph.invalidateModule(module);
        }
        server.hot.send({ type: "full-reload" });
      };
      server.watcher.on("add", reloadOnLogoChange);
      server.watcher.on("change", reloadOnLogoChange);
      server.watcher.on("unlink", reloadOnLogoChange);
      server.middlewares.use(middleware);
    },
    load: {
      filter: { id: RESOLVED_ID_FILTER },
      handler(id) {
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
    },
    name: "rom-weaver-brand-mark-assets",
    resolveId: {
      filter: { id: VIRTUAL_ID_FILTER },
      handler(id) {
        return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
      },
    },
  };
};

export { brandMarkAssets, tintBrandMark };
