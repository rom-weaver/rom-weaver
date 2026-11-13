import fs from "node:fs";
import path from "node:path";
import { dedupeTree } from "../../../../scripts/dedupe-tree.mjs";
import { writeDocsMarkdown } from "../docs-discovery.mjs";
import {
  createApiCatalogSource,
  createOpenApiSource,
  API_CATALOG_PATH,
  OPENAPI_PATH,
} from "../../src/webapp/api-catalog.mjs";
import { createDocsRouteHtml, DOC_ROUTES, docSourcePath, withDocsBase } from "../../src/webapp/docs-pages.mjs";
import { DOC_SOURCES } from "../../src/webapp/docs-routing.mjs";
import { LEGACY_WORKFLOW_ROUTES, WORKFLOW_ENTRY_ROUTES, WORKFLOW_SEO_ROUTES } from "../../src/webapp/workflow-seo.mjs";
import { copyEmulatorJsAssets } from "./emulatorjs.mjs";
import { rootDir } from "./paths.mjs";
import { PRERENDER_MOUNT_POINT, PRERENDER_ROOT } from "./prerender-shell.mjs";
import {
  generatedLicenseAssetSources,
  generatedSampleAssetPaths,
  getGeneratedSampleAsset,
  writeNeutralRootStaticAssets,
} from "./root-static-assets.mjs";
import { withRoutePreloadLinks } from "./route-preload.mjs";
import {
  createNotFoundHtml,
  createRobotsSource,
  createSitemapSource,
  createWorkflowRouteHtml,
  createWorkflowMarkdown,
  injectLdJson,
  makeBetaRouteNoindex,
  readDocLastmods,
} from "./seo-html.mjs";

// The view this document's shell was rendered as.
const stampView = (html, view) => html.replace(/<html\b[^>]*/u, `$& data-view="${view}"`);

// The view a prerendered shell key stands for.
const shellView = (key) => {
  if (key === "notFound") return null;
  if (key === "docs" || key.startsWith("docs/")) return "docs";
  return WORKFLOW_ENTRY_ROUTES[key]?.view ?? key;
};

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

// Writes what every channel shares. The channel stamp writes the rest.
export const writeWebappStaticAssets = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      copyEmulatorJsAssets(distDir);
      // The app finds its base from the URL of its own chunks, which holds only while they sit directly in <base>/assets/.
      const nestedAssets = fs
        .readdirSync(path.join(distDir, "assets"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      if (nestedAssets.length)
        throw new Error(`rom-weaver-static-assets: dist/assets must be flat, found ${nestedAssets.join(", ")}`);
      writeNeutralRootStaticAssets(distDir);
      for (const assetPath of generatedSampleAssetPaths) {
        const outputPath = path.join(distDir, assetPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, getGeneratedSampleAsset(assetPath));
      }
      for (const [assetPath, sourcePath] of Object.entries(generatedLicenseAssetSources)) {
        copyFile(sourcePath, path.join(distDir, assetPath));
      }
      const thirdPartyDir = path.join(distDir, "third_party");
      fs.cpSync(path.join(rootDir, "src", "wasm", "third_party"), thirdPartyDir, {
        recursive: true,
      });
      // cpSync expands the generator's hardlinks back into full copies, so the
      // shipped tree has to be collapsed again.
      dedupeTree(thirdPartyDir);
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-static-assets",
  };
};

/**
 * Writes every route document, its Markdown export, robots.txt, the prod-only
 * sitemap and the API catalog for one channel. `indexHtml` is the built
 * index.html with the channel identity applied and an empty mount point.
 */
export const writeChannelPages = (
  distDir,
  { channel, channelLabel, indexHtml, prerenderedShells, routePreloadLinks, siteOrigin },
) => {
  if (!indexHtml.includes(PRERENDER_MOUNT_POINT))
    throw new Error("rom-weaver-static-assets: #webapp-root mount point not found in the index.html template");
  // Every route page is the index.html template with its own shell in the
  // mount point, so each one hydrates onto the view its markup was rendered as.
  const withShell = (view) => {
    const shell = prerenderedShells.get(view);
    if (!shell) throw new Error(`rom-weaver-static-assets: no prerendered shell for ${view}`);
    const html = indexHtml.replace(PRERENDER_MOUNT_POINT, PRERENDER_ROOT(shell));
    const stamped = shellView(view);
    return stamped ? stampView(html, stamped) : html;
  };
  // index.html is the landing page at the apex. Only the apex carries the site-level WebSite entity.
  fs.writeFileSync(
    path.join(distDir, "index.html"),
    injectLdJson(
      createWorkflowRouteHtml(withShell("home"), WORKFLOW_SEO_ROUTES.home, channel, channelLabel),
      WORKFLOW_SEO_ROUTES.home,
      true,
    ),
  );
  for (const route of [...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)]) {
    fs.writeFileSync(path.join(distDir, `${route.slug || "index"}.md`), createWorkflowMarkdown(route, siteOrigin));
  }
  const patcherHtml = withRoutePreloadLinks(withShell("patcher"), routePreloadLinks.get("patcher"));
  const applyHtml = injectLdJson(
    createWorkflowRouteHtml(patcherHtml, WORKFLOW_SEO_ROUTES.patcher, channel, channelLabel),
    WORKFLOW_SEO_ROUTES.patcher,
  );
  const weaveHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("weave"), routePreloadLinks.get("weave")),
      WORKFLOW_SEO_ROUTES.weave,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.weave,
  );
  fs.writeFileSync(path.join(distDir, "404.html"), createNotFoundHtml(withShell("notFound"), channel, channelLabel));
  const creatorHtml = withRoutePreloadLinks(withShell("creator"), routePreloadLinks.get("creator"));
  const createHtml = injectLdJson(
    createWorkflowRouteHtml(creatorHtml, WORKFLOW_SEO_ROUTES.creator, channel, channelLabel),
    WORKFLOW_SEO_ROUTES.creator,
  );
  const extractHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("extract"), routePreloadLinks.get("extract")),
      WORKFLOW_SEO_ROUTES.extract,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.extract,
  );
  const checksumHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("checksum"), routePreloadLinks.get("checksum")),
      WORKFLOW_SEO_ROUTES.checksum,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.checksum,
  );
  const compressHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("compress"), routePreloadLinks.get("compress")),
      WORKFLOW_SEO_ROUTES.compress,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.compress,
  );
  const identifyHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("identify"), routePreloadLinks.get("identify")),
      WORKFLOW_SEO_ROUTES.identify,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.identify,
  );
  const testHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("test"), routePreloadLinks.get("test")),
      WORKFLOW_SEO_ROUTES.test,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.test,
  );
  const trimHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("trim"), routePreloadLinks.get("trim")),
      WORKFLOW_SEO_ROUTES.trim,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.trim,
  );
  const ppfUndoHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("ppf-undo"), routePreloadLinks.get("ppf-undo")),
      WORKFLOW_SEO_ROUTES["ppf-undo"],
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES["ppf-undo"],
  );
  const playlistHtml = injectLdJson(
    createWorkflowRouteHtml(
      withRoutePreloadLinks(withShell("playlist"), routePreloadLinks.get("playlist")),
      WORKFLOW_SEO_ROUTES.playlist,
      channel,
      channelLabel,
    ),
    WORKFLOW_SEO_ROUTES.playlist,
  );
  const saveEditorHtml = withRoutePreloadLinks(
    makeBetaRouteNoindex(withShell("save-editor"), "rom-save-editor", channel, channelLabel),
    routePreloadLinks.get("save-editor"),
  );
  const whatsNewHtml = withRoutePreloadLinks(
    makeBetaRouteNoindex(withShell("whats-new"), "whats-new", channel, channelLabel),
    routePreloadLinks.get("whats-new"),
  );
  const docLastmods = readDocLastmods();
  for (const route of DOC_ROUTES) {
    const routeShellHtml = withRoutePreloadLinks(withShell(route.slug), routePreloadLinks.get("docs"));
    const docsHtml = createDocsRouteHtml(routeShellHtml, route, channel, channelLabel, docLastmods.get(route.slug));
    const extensionlessPath = path.join(distDir, `${route.slug}.html`);
    const directoryIndexPath = path.join(distDir, route.slug, "index.html");
    fs.mkdirSync(path.dirname(extensionlessPath), { recursive: true });
    fs.mkdirSync(path.dirname(directoryIndexPath), { recursive: true });
    fs.writeFileSync(extensionlessPath, withDocsBase(docsHtml, route.slug, false));
    fs.writeFileSync(directoryIndexPath, withDocsBase(docsHtml, route.slug, true));
    const source = DOC_SOURCES.find((entry) => entry.slug === route.slug);
    writeDocsMarkdown(path.join(distDir, `${route.slug}.md`), source, docSourcePath(source), siteOrigin);
  }
  for (const [slug, html] of [
    ...Object.values(WORKFLOW_ENTRY_ROUTES).map((route) => [
      route.slug,
      injectLdJson(
        createWorkflowRouteHtml(
          withRoutePreloadLinks(withShell(route.slug), routePreloadLinks.get(route.view)),
          route,
          channel,
          channelLabel,
        ),
        route,
      ),
    ]),
    ["apply-rom-patches", applyHtml],
    ["weave-rom-patches", weaveHtml],
    ["create-rom-patch", createHtml],
    ["file-checksum", checksumHtml],
    ["compress-files", compressHtml],
    ["extract-files", extractHtml],
    ["identify-rom", identifyHtml],
    ["play-rom", testHtml],
    ["trim-rom", trimHtml],
    ["ppf-undo", ppfUndoHtml],
    ["create-m3u-playlist", playlistHtml],
    // What's new needs a document of its own or the host serves 404.html,
    // whose not-found flag hides the route on a direct load or reload. Its
    // content is fetched release notes, so it stays out of the index.
    ["whats-new", whatsNewHtml],
    ["rom-save-editor", saveEditorHtml],
    // The old /tools/ URL stays reachable; it canonicalizes to /ppf-undo.
    ["tools", makeBetaRouteNoindex(ppfUndoHtml, "ppf-undo")],
  ]) {
    const routeDir = path.join(distDir, slug);
    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, `${slug}.html`), html);
    fs.writeFileSync(path.join(routeDir, "index.html"), html.replace("<head>", '<head>\n    <base href="../" />'));
  }
  fs.writeFileSync(path.join(distDir, "robots.txt"), createRobotsSource(channel));
  // Static hosts without redirect rules MUST retain usable legacy documents.
  for (const [legacy, destination] of Object.entries(LEGACY_WORKFLOW_ROUTES)) {
    const canonicalHtml = fs.readFileSync(path.join(distDir, destination, "index.html"), "utf8");
    const legacyHtml = canonicalHtml.replace(
      /<meta name="robots" content="[^"]*"\s*\/?\s*>/,
      '<meta name="robots" content="noindex,follow" />',
    );
    fs.mkdirSync(path.join(distDir, legacy), { recursive: true });
    fs.writeFileSync(path.join(distDir, legacy, "index.html"), legacyHtml);
    fs.writeFileSync(
      path.join(distDir, `${legacy}.html`),
      legacyHtml.replace('<base href="../" />', '<base href="./" />'),
    );
    const canonicalMarkdown = path.join(distDir, `${destination}.md`);
    if (fs.existsSync(canonicalMarkdown)) {
      fs.copyFileSync(canonicalMarkdown, path.join(distDir, `${legacy}.md`));
    }
  }
  const sitemapPath = path.join(distDir, "sitemap.xml");
  if (channel === "prod") fs.writeFileSync(sitemapPath, createSitemapSource({ docLastmods }));
  else fs.rmSync(sitemapPath, { force: true });
  // Every channel serves the catalog. Its links use the origin the build is
  // served from (production unless ROM_WEAVER_SITE_ORIGIN says otherwise),
  // while canonical URLs and headers stay on production; only the sitemap
  // stays production-only. This also lets a PR preview verify the catalog on
  // Cloudflare Pages before merge.
  fs.mkdirSync(path.join(distDir, path.dirname(API_CATALOG_PATH)), { recursive: true });
  fs.writeFileSync(path.join(distDir, API_CATALOG_PATH), createApiCatalogSource(siteOrigin));
  fs.writeFileSync(path.join(distDir, OPENAPI_PATH), createOpenApiSource(siteOrigin));
};
