import { docsDirectory, docSourcePath, generatedDocsDirectory, readDocRoutes } from "../src/webapp/docs-pages.mjs";
import { DOC_SOURCES } from "../src/webapp/docs-routing.mjs";
import { createDocsSearchIndex } from "../src/webapp/docs-search.mjs";

// The guides are Markdown build inputs, but the browser must never pay for a
// Markdown parser: `marked` renders them here, at build time, and the client
// imports the finished HTML. Keeping the parser out of the bundle also keeps it
// honestly a devDependency - `scripts/gen-third-party-licenses.mjs` walks the
// shipped dependency graph, so a bundled parser would be missing from NOTICE.
//
// The rendered output is split across three module kinds so a docs visit only
// downloads what it uses:
// - `virtual:rom-weaver-docs` - route metadata (nav shelves, titles, sections)
//   plus one dynamic-import loader per page, so each guide's HTML becomes its
//   own lazy chunk instead of every visit shipping all of them.
// - `virtual:rom-weaver-docs-page/<slug>` - one guide's rendered HTML.
// - `virtual:rom-weaver-docs-search` - the prebuilt search entries (plain text,
//   no HTML), loaded only when the reader interacts with search.
const VIRTUAL_ID = "virtual:rom-weaver-docs";
const PAGE_VIRTUAL_PREFIX = "virtual:rom-weaver-docs-page/";
const SEARCH_VIRTUAL_ID = "virtual:rom-weaver-docs-search";
const RESOLVED_PREFIX = "\0";
const VIRTUAL_ID_FILTER = /^virtual:rom-weaver-docs(?:$|-search$|-page\/)/;
const RESOLVED_ID_FILTER = new RegExp(`^${RESOLVED_PREFIX}virtual:rom-weaver-docs(?:$|-search$|-page/)`);

// Route data is interpolated into the module source generated below.
// `JSON.stringify` alone is not a code-injection barrier: it leaves `<` and the
// two Unicode line separators intact, so its output can still close a `<script>`
// tag or break a string literal. Every value written into generated code goes
// through this instead (js/bad-code-sanitization). The other escapes the rule
// names - \b \f \n \r \t \0 - `JSON.stringify` already handles.
const UNSAFE_IN_CODE = { "<": "\\u003C", ">": "\\u003E", "\u2028": "\\u2028", "\u2029": "\\u2029" };

/** @param {unknown} value */
const serializeIntoCode = (value) =>
  JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (character) => UNSAFE_IN_CODE[character]);

// A slug is also the shape of a published URL, so anything outside that shape is
// an authoring mistake rather than something to encode around. Failing the build
// beats generating a route that can never resolve.
const SAFE_SLUG = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

/** @param {string} id */
const isDocsVirtualId = (id) => id === VIRTUAL_ID || id === SEARCH_VIRTUAL_ID || id.startsWith(PAGE_VIRTUAL_PREFIX);

const resolvedDocsVirtualIds = () => [
  `${RESOLVED_PREFIX}${VIRTUAL_ID}`,
  `${RESOLVED_PREFIX}${SEARCH_VIRTUAL_ID}`,
  ...DOC_SOURCES.map((source) => `${RESOLVED_PREFIX}${PAGE_VIRTUAL_PREFIX}${source.slug}`),
];

/** @param {{ environments?: Record<string, { moduleGraph?: unknown }>, moduleGraph?: unknown }} server */
const invalidateDocsModules = (server) => {
  const graphs = [server.environments?.client?.moduleGraph, server.environments?.ssr?.moduleGraph, server.moduleGraph];
  for (const graph of graphs) {
    for (const id of resolvedDocsVirtualIds()) {
      const module = /** @type {any} */ (graph)?.getModuleById?.(id);
      if (module) /** @type {any} */ (graph).invalidateModule(module);
    }
  }
};

/** @param {readonly import("../src/webapp/docs-content.mjs").DocRoute[]} routes */
const createMetadataModuleSource = (routes) => {
  const metadata = routes.map(({ html: _html, ...route }) => route);
  const loaders = routes
    .map(({ slug }) => {
      if (!SAFE_SLUG.test(slug)) throw new Error(`docs virtual module: docs slug '${slug}' is not a safe route slug`);
      return `  ${serializeIntoCode(slug)}: () => import(${serializeIntoCode(`${PAGE_VIRTUAL_PREFIX}${slug}`)}),`;
    })
    .join("\n");
  return [
    `export const DOC_ROUTES = ${serializeIntoCode(metadata)};`,
    "export const DOC_PAGE_LOADERS = {",
    loaders,
    "};",
    "",
  ].join("\n");
};

/** @param {readonly import("../src/webapp/docs-content.mjs").DocRoute[]} routes */
const createSearchModuleSource = (routes) => {
  const entries = Object.fromEntries(createDocsSearchIndex(routes).map((route) => [route.slug, route.searchEntries]));
  return `export const SEARCH_ENTRIES = ${serializeIntoCode(entries)};\n`;
};

/** Serves the rendered guides to the app as `virtual:rom-weaver-docs*` modules. */
const docsVirtualModule = (initialRoutes = null) => {
  /** One render of the guides feeds every virtual module of a build; dev edits clear it below. */
  let cachedRoutes = initialRoutes;
  const getRoutes = () => {
    cachedRoutes ??= readDocRoutes();
    return cachedRoutes;
  };
  return {
    buildStart() {
      cachedRoutes = initialRoutes;
    },
    configureServer(server) {
      const watchedDocs = [
        docsDirectory,
        ...DOC_SOURCES.map(docSourcePath).filter((file) => file.startsWith(generatedDocsDirectory)),
      ];
      server.watcher.add(watchedDocs);
      const reloadOnGuideChange = (file) => {
        const changedFile = String(file);
        if (!watchedDocs.some((watched) => changedFile === watched || changedFile.startsWith(`${watched}/`))) return;
        cachedRoutes = null;
        invalidateDocsModules(server);
        server.hot.send({ type: "full-reload" });
      };
      server.watcher.on("add", reloadOnGuideChange);
      server.watcher.on("change", reloadOnGuideChange);
      server.watcher.on("unlink", reloadOnGuideChange);
    },
    load: {
      filter: { id: RESOLVED_ID_FILTER },
      handler(id) {
        if (!id.startsWith(RESOLVED_PREFIX)) return undefined;
        const virtualId = id.slice(RESOLVED_PREFIX.length);
        if (!isDocsVirtualId(virtualId)) return undefined;
        if (virtualId === VIRTUAL_ID) return createMetadataModuleSource(getRoutes());
        if (virtualId === SEARCH_VIRTUAL_ID) return createSearchModuleSource(getRoutes());
        const slug = virtualId.slice(PAGE_VIRTUAL_PREFIX.length);
        const route = getRoutes().find((entry) => entry.slug === slug);
        if (!route) throw new Error(`docs virtual module: no docs route for slug '${slug}'`);
        return `export const html = ${serializeIntoCode(route.html)};\n`;
      },
    },
    name: "rom-weaver-docs-virtual-module",
    resolveId: {
      filter: { id: VIRTUAL_ID_FILTER },
      handler(id) {
        return isDocsVirtualId(id) ? `${RESOLVED_PREFIX}${id}` : undefined;
      },
    },
  };
};

export { docsVirtualModule };
