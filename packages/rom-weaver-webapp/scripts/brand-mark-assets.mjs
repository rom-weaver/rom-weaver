import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACCENTS, DEFAULT_ACCENT } from "../src/webapp/accent-palette.mjs";

// SSR and client builds MUST use the same content hash for each logo.

const VIRTUAL_ID = "virtual:rom-weaver-brand-marks";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const VIRTUAL_ID_FILTER = /^virtual:rom-weaver-brand-marks$/;
const RESOLVED_ID_FILTER = new RegExp(`^${RESOLVED_ID}$`);

const logoSourcePath = path.resolve(import.meta.dirname, "../src/assets/app/root/logo.svg");

const tintBrandMark = (svg, accent) => {
  const base = ACCENTS.find((entry) => entry.value === DEFAULT_ACCENT);
  if (!base) throw new Error(`brand marks: unknown default accent '${DEFAULT_ACCENT}'`);
  if (!svg.includes(base.swatch)) throw new Error("brand marks: source is missing the accent band");
  return svg.replaceAll(base.swatch, accent.swatch);
};

const createBrandMarks = () => {
  const logo = fs.readFileSync(logoSourcePath, "utf8");
  return ACCENTS.map((accent) => {
    const source = tintBrandMark(logo, accent);
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
        const urls = Object.fromEntries(marks.map((mark) => [mark.value, `./${mark.fileName}`]));
        return `export const BRAND_MARK_SRC = ${JSON.stringify(urls)};\n`;
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
