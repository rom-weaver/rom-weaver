import { DOC_ROUTES } from "../../src/webapp/docs-pages.mjs";

// Workflow forms are lazy route chunks (src/webapp/workflow-routes.tsx), so
// without help the landing tab's chunk is only requested once the entry bundle
// has downloaded, parsed and evaluated - one serialized round trip added to the
// exact path the prerendered shell exists to speed up. Each emitted route page
// therefore carries modulepreload links for its own route chunks, so they
// download alongside the entry instead of after it.
//
// Markers let writeWebappStaticAssets replace the landing page's preload set
// with the set for each derived route document.
const ROUTE_PRELOAD_MARKER_START = "<!--rw-route-preload-->";
const ROUTE_PRELOAD_MARKER_END = "<!--/rw-route-preload-->";

const WORKFLOW_ROUTE_MODULES = {
  bundle: "src/public/react/apply-patch-form.tsx",
  creator: "src/public/react/create-patch-form.tsx",
  docs: "src/webapp/docs-page.tsx",
  identify: "src/webapp/components/identify-form.tsx",
  home: "src/webapp/components/home-page.tsx",
  patcher: "src/public/react/apply-patch-form.tsx",
  test: "src/public/react/emulator-test-view.tsx",
  "ppf-undo": "src/webapp/components/ppf-undo-form.tsx",
  "save-editor": "src/webapp/components/save-editor.tsx",
  trim: "src/public/react/trim-form.tsx",
  "whats-new": "src/webapp/whats-new-page.tsx",
};

const findChunkForModule = (bundle, moduleSuffix) =>
  Object.keys(bundle).find((fileName) => {
    const chunk = bundle[fileName];
    if (chunk.type !== "chunk") return false;
    return (chunk.moduleIds || []).some((id) => id.split("?")[0].replace(/\\/g, "/").endsWith(moduleSuffix));
  });

const collectStaticImportClosure = (bundle, entryFileNames) => {
  const seen = new Set();
  const pending = [...entryFileNames];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (!fileName || seen.has(fileName)) continue;
    const chunk = bundle[fileName];
    if (!chunk || chunk.type !== "chunk") continue;
    seen.add(fileName);
    for (const imported of chunk.imports || []) pending.push(imported);
  }
  return seen;
};

const renderRoutePreloadLinks = (fileNames) =>
  fileNames.map((fileName) => `  <link rel="modulepreload" crossorigin href="./${fileName}" />`).join("\n");

// CSS carried by a route's chunks (docs.css rides the docs chunk) is render-critical on
// that route's prerendered document: without a render-blocking link the shell paints
// unstyled until the chunk loads. Emitted before the modulepreloads. When the chunk later
// lazy-loads on an in-app navigation, cascade layers make the runtime-injected duplicate
// link harmless.
const renderRouteStylesheetLinks = (fileNames) =>
  fileNames.map((fileName) => `  <link rel="stylesheet" crossorigin href="./${fileName}" />`).join("\n");

const collectChunkCss = (bundle, chunkFileNames) => {
  const css = new Set();
  for (const fileName of chunkFileNames) {
    for (const cssFileName of bundle[fileName]?.viteMetadata?.importedCss ?? []) css.add(cssFileName);
  }
  return css;
};

export const preloadWorkflowRouteChunks = (routePreloadLinks) => ({
  apply: "build",
  name: "rom-weaver-preload-workflow-route-chunks",
  transformIndexHtml: {
    handler(html, ctx) {
      const bundle = ctx.bundle;
      if (!bundle) return html;
      const entryFileName = html.match(/<script[^>]*\ssrc="\.\/([^"]+\.js)"/)?.[1];
      if (!entryFileName) throw new Error("rom-weaver-preload-workflow-route-chunks: entry script not found");
      const alreadyLoaded = collectStaticImportClosure(bundle, [entryFileName]);
      const entryCss = collectChunkCss(bundle, alreadyLoaded);
      for (const [view, moduleSuffix] of Object.entries(WORKFLOW_ROUTE_MODULES)) {
        const routeChunk = findChunkForModule(bundle, moduleSuffix);
        if (!routeChunk)
          throw new Error(`rom-weaver-preload-workflow-route-chunks: no chunk emitted for ${moduleSuffix}`);
        const routeFiles = [...collectStaticImportClosure(bundle, [routeChunk])]
          .filter((fileName) => !alreadyLoaded.has(fileName))
          .sort((left, right) => Number(left > right) - Number(left < right));
        const routeCss = [...collectChunkCss(bundle, routeFiles)]
          .filter((fileName) => !entryCss.has(fileName))
          .sort((left, right) => Number(left > right) - Number(left < right));
        const links = [renderRouteStylesheetLinks(routeCss), renderRoutePreloadLinks(routeFiles)]
          .filter(Boolean)
          .join("\n");
        routePreloadLinks.set(view, links);
      }
      // Guide HTML is one chunk per docs page (scripts/docs-virtual-module.mjs),
      // and a docs document deliberately does NOT preload the chunk of the guide
      // it is showing: that article is already in the served markup, which
      // docs-page.tsx adopts instead of importing it (adoptPrerenderedDocsHtml).
      // A preload link here would download the article a second time. The chunk
      // must still exist for every guide, because a soft navigation to any other
      // guide loads it on demand.
      for (const route of DOC_ROUTES) {
        if (!findChunkForModule(bundle, `rom-weaver-docs-page/${route.slug}`))
          throw new Error(`rom-weaver-preload-workflow-route-chunks: no chunk emitted for docs page ${route.slug}`);
      }
      return html.replace(
        "</head>",
        `${ROUTE_PRELOAD_MARKER_START}\n${routePreloadLinks.get("home")}\n  ${ROUTE_PRELOAD_MARKER_END}\n  </head>`,
      );
    },
    order: "post",
  },
});

export const withRoutePreloadLinks = (html, links) =>
  html.replace(
    new RegExp(`${ROUTE_PRELOAD_MARKER_START}[\\s\\S]*?${ROUTE_PRELOAD_MARKER_END}`),
    `${ROUTE_PRELOAD_MARKER_START}\n${links}\n  ${ROUTE_PRELOAD_MARKER_END}`,
  );
