import { docsDirectory, docSourcePath, generatedDocsDirectory, readDocRoutes } from "../src/webapp/docs-pages.mjs";
import { DOC_SOURCES } from "../src/webapp/docs-routing.mjs";
import { createDocsSearchIndex } from "../src/webapp/docs-search.mjs";

// The guides are Markdown build inputs, but the browser must never pay for a
// Markdown parser: `marked` renders them here, at build time, and the client
// imports the finished HTML. Keeping the parser out of the bundle also keeps it
// honestly a devDependency - `scripts/gen-third-party-licenses.mjs` walks the
// shipped dependency graph, so a bundled parser would be missing from NOTICE.
//
// The rendered output is split across four module kinds so a docs visit only
// downloads what it uses:
// - `virtual:rom-weaver-docs` - route metadata (nav shelves, titles, sections)
//   plus one dynamic-import loader per page, so each guide's HTML becomes its
//   own lazy chunk instead of every visit shipping all of them.
// - `virtual:rom-weaver-docs-page/<slug>` - one guide's rendered HTML.
// - `virtual:rom-weaver-docs-html` - the shared section-link icon, restored
//   by page modules without changing their HTML.
// - `virtual:rom-weaver-docs-search` - the prebuilt search entries (plain text,
//   no HTML), loaded only when the reader interacts with search.
const VIRTUAL_ID = "virtual:rom-weaver-docs";
const PAGE_VIRTUAL_PREFIX = "virtual:rom-weaver-docs-page/";
const SEARCH_VIRTUAL_ID = "virtual:rom-weaver-docs-search";
const HTML_VIRTUAL_ID = "virtual:rom-weaver-docs-html";
const RESOLVED_PREFIX = "\0";
const VIRTUAL_ID_FILTER = /^virtual:rom-weaver-docs(?:$|-search$|-html$|-page\/)/;
const RESOLVED_ID_FILTER = new RegExp(`^${RESOLVED_PREFIX}virtual:rom-weaver-docs(?:$|-search$|-html$|-page/)`);

// Escape HTML delimiters and Unicode line separators in generated JavaScript.
// This also keeps the serialized values safe if a caller later embeds them in HTML.
const UNSAFE_IN_CODE = { "<": "\\u003C", ">": "\\u003E", "\u2028": "\\u2028", "\u2029": "\\u2029" };

/** @param {unknown} value */
const serializeIntoCode = (value) =>
  JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (character) => UNSAFE_IN_CODE[character]);

// A slug is also the shape of a published URL, so anything outside that shape is
// an authoring mistake rather than something to encode around. Failing the build
// beats generating a route that can never resolve.
const SAFE_SLUG = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

/** @param {string} id */
const isDocsVirtualId = (id) =>
  id === VIRTUAL_ID || id === SEARCH_VIRTUAL_ID || id === HTML_VIRTUAL_ID || id.startsWith(PAGE_VIRTUAL_PREFIX);

const resolvedDocsVirtualIds = () => [
  `${RESOLVED_PREFIX}${VIRTUAL_ID}`,
  `${RESOLVED_PREFIX}${SEARCH_VIRTUAL_ID}`,
  `${RESOLVED_PREFIX}${HTML_VIRTUAL_ID}`,
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

// Only omit an ID when this exact derivation reproduces it; custom and duplicate IDs stay explicit.
const SECTION_ID_CODE = '(label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")';
const sectionId = (label) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const compactId = (id, label) => (id === sectionId(label) ? 0 : id);
const sectionIcon = (routes) =>
  routes.flatMap(({ html }) => html.match(/<svg\b[^>]*class="docs-section-link-icon"[^>]*>[\s\S]*?<\/svg>/g) ?? [])[0];

/** @param {readonly import("../src/webapp/docs-content.mjs").DocRoute[]} routes */
const createMetadataModuleSource = (routes) => {
  const metadata = routes.map(({ html: _html, sections, ...route }) => ({
    ...route,
    sections: sections?.map(({ id, label }) => [compactId(id, label), label]),
  }));
  const loaders = routes
    .map(({ slug }) => {
      if (!SAFE_SLUG.test(slug)) throw new Error(`docs virtual module: docs slug '${slug}' is not a safe route slug`);
      return `  ${serializeIntoCode(slug)}: () => import(${serializeIntoCode(`${PAGE_VIRTUAL_PREFIX}${slug}`)}),`;
    })
    .join("\n");
  return [
    `const sectionId = ${SECTION_ID_CODE};`,
    `export const DOC_ROUTES = ${serializeIntoCode(metadata)}.map(route => route.sections ? ({ ...route, sections: route.sections.map(([id, label]) => ({ id: id === 0 ? sectionId(label) : id, label })) }) : route);`,
    "export const DOC_PAGE_LOADERS = {",
    loaders,
    "};",
    "",
  ].join("\n");
};

/** @param {readonly import("../src/webapp/docs-content.mjs").DocRoute[]} routes */
const createSearchModuleSource = (routes) => {
  const entries = Object.fromEntries(
    createDocsSearchIndex(routes).map((route) => [
      route.slug,
      route.searchEntries.map(({ id, label, text }) =>
        text.startsWith(label)
          ? [compactId(id, label), label, text.slice(label.length)]
          : [compactId(id, label), label, text, 0],
      ),
    ]),
  );
  // The downloaded index MUST retain every entry while storing a repeated heading only once.
  return `const sectionId = ${SECTION_ID_CODE};\nexport const SEARCH_ENTRIES = Object.fromEntries(Object.entries(${serializeIntoCode(entries)}).map(([slug, entries]) => [slug, entries.map(([id, label, text, full]) => ({ id: id === 0 ? sectionId(label) : id, label, text: full === 0 ? text : label + text }))]));\n`;
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
        if (virtualId === HTML_VIRTUAL_ID)
          return `export const icon = ${serializeIntoCode(sectionIcon(getRoutes()) ?? "")};\n`;
        const slug = virtualId.slice(PAGE_VIRTUAL_PREFIX.length);
        const route = getRoutes().find((entry) => entry.slug === slug);
        if (!route) throw new Error(`docs virtual module: no docs route for slug '${slug}'`);
        const icon = sectionIcon(getRoutes());
        if (icon && route.html.includes(icon)) {
          return `import { icon } from "${HTML_VIRTUAL_ID}";\nexport const html = ${serializeIntoCode(route.html.split(icon))}.join(icon);\n`;
        }
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
