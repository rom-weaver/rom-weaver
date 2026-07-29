import { docsDirectory, readDocRoutes } from "../src/webapp/docs-pages.mjs";

// The guides are Markdown in the repository, but the browser must never pay for
// a Markdown parser: `marked` renders them here, at build time, and the client
// imports the finished HTML. Keeping the parser out of the bundle also keeps it
// honestly a devDependency - `scripts/gen-third-party-licenses.mjs` walks the
// shipped dependency graph, so a bundled parser would be missing from NOTICE.
const VIRTUAL_ID = "virtual:rom-weaver-docs";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

/** @param {{ environments?: Record<string, { moduleGraph?: unknown }>, moduleGraph?: unknown }} server */
const invalidateDocsModule = (server) => {
  const graphs = [server.environments?.client?.moduleGraph, server.environments?.ssr?.moduleGraph, server.moduleGraph];
  for (const graph of graphs) {
    const module = /** @type {any} */ (graph)?.getModuleById?.(RESOLVED_ID);
    if (module) /** @type {any} */ (graph).invalidateModule(module);
  }
};

/** Serves the rendered guides to the app as `virtual:rom-weaver-docs`. */
const docsVirtualModule = () => ({
  configureServer(server) {
    server.watcher.add(docsDirectory);
    const reloadOnGuideChange = (file) => {
      if (!String(file).startsWith(docsDirectory)) return;
      invalidateDocsModule(server);
      server.hot.send({ type: "full-reload" });
    };
    server.watcher.on("add", reloadOnGuideChange);
    server.watcher.on("change", reloadOnGuideChange);
    server.watcher.on("unlink", reloadOnGuideChange);
  },
  load(id) {
    if (id !== RESOLVED_ID) return undefined;
    return `export const DOC_ROUTES = ${JSON.stringify(readDocRoutes())};\n`;
  },
  name: "rom-weaver-docs-virtual-module",
  resolveId(id) {
    return id === VIRTUAL_ID ? RESOLVED_ID : undefined;
  },
});

export { docsVirtualModule };
