import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// SSR and client builds MUST use the same content hash for the fixed logo.

const VIRTUAL_ID = "virtual:rom-weaver-brand-marks";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const VIRTUAL_ID_FILTER = /^virtual:rom-weaver-brand-marks$/;
const RESOLVED_ID_FILTER = new RegExp(`^${RESOLVED_ID}$`);

const logoSourcePath = path.resolve(import.meta.dirname, "../src/assets/app/root/logo.svg");

const createBrandMarks = () => {
  const source = fs.readFileSync(logoSourcePath, "utf8");
  const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 8);
  return [{ fileName: `assets/brand-mark-${hash}.svg`, source }];
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
        return `export const BRAND_MARK_SRC = ${JSON.stringify(`./${marks[0].fileName}`)};\n`;
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

export { brandMarkAssets };
