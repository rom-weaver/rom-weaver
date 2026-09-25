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
import { createDocsRouteHtml, DOC_ROUTES, docSourcePath } from "../../src/webapp/docs-pages.mjs";
import { DOC_SOURCES } from "../../src/webapp/docs-routing.mjs";
import { WORKFLOW_SEO_ROUTES } from "../../src/webapp/workflow-seo.mjs";
import { createRootManifestSource } from "./channel.mjs";
import { copyEmulatorJsAssets } from "./emulatorjs.mjs";
import { rootDir } from "./paths.mjs";
import { PRERENDER_ROOT } from "./prerender-shell.mjs";
import {
  generatedLicenseAssetSources,
  generatedSampleAssetPaths,
  getGeneratedSampleAsset,
  LEGACY_WORKFLOW_ROUTES,
  rootStaticAssetSourcesForChannel,
} from "./root-static-assets.mjs";
import { withRoutePreloadLinks } from "./route-preload.mjs";
import {
  createNotFoundHtml,
  createRobotsSource,
  createSitemapSource,
  createWorkflowRouteHtml,
  injectLdJson,
  makeBetaRouteNoindex,
} from "./seo-html.mjs";

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

export const writeWebappStaticAssets = (channel, channelLabel, prerenderedShells, routePreloadLinks) => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      copyEmulatorJsAssets(distDir);
      const rootStaticAssetSources = rootStaticAssetSourcesForChannel(channel);
      for (const assetPath of Object.keys(rootStaticAssetSources)) {
        const outputPath = path.join(distDir, assetPath);
        if (assetPath === "/manifest.json") {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, createRootManifestSource(channel, channelLabel));
          continue;
        }
        copyFile(rootStaticAssetSources[assetPath], outputPath);
      }
      for (const assetPath of generatedSampleAssetPaths) {
        const outputPath = path.join(distDir, assetPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, getGeneratedSampleAsset(assetPath));
      }
      for (const [assetPath, sourcePath] of Object.entries(generatedLicenseAssetSources)) {
        copyFile(sourcePath, path.join(distDir, assetPath));
      }
      const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
      const homeRoot = PRERENDER_ROOT(prerenderedShells.get("home"));
      if (!indexHtml.includes(homeRoot))
        throw new Error("rom-weaver-static-assets: prerendered home shell not found in dist/index.html");
      // index.html is the landing page at the apex. Every other route page is
      // this same document with the landing shell swapped for its own, so each
      // one hydrates onto the view its markup was rendered as.
      const withShell = (view) => {
        const shell = prerenderedShells.get(view);
        if (!shell) throw new Error(`rom-weaver-static-assets: no prerendered shell for ${view}`);
        return indexHtml.replace(homeRoot, PRERENDER_ROOT(shell));
      };
      // Only the apex carries the site-level WebSite entity.
      fs.writeFileSync(
        path.join(distDir, "index.html"),
        injectLdJson(
          createWorkflowRouteHtml(indexHtml, WORKFLOW_SEO_ROUTES.home, channel, channelLabel),
          WORKFLOW_SEO_ROUTES.home,
          true,
        ),
      );
      const patcherHtml = withRoutePreloadLinks(withShell("patcher"), routePreloadLinks.get("patcher"));
      const applyHtml = injectLdJson(
        createWorkflowRouteHtml(patcherHtml, WORKFLOW_SEO_ROUTES.patcher, channel, channelLabel),
        WORKFLOW_SEO_ROUTES.patcher,
      );
      const bundleHtml = injectLdJson(
        createWorkflowRouteHtml(
          withRoutePreloadLinks(withShell("bundle"), routePreloadLinks.get("bundle")),
          WORKFLOW_SEO_ROUTES.bundle,
          channel,
          channelLabel,
        ),
        WORKFLOW_SEO_ROUTES.bundle,
      );
      fs.writeFileSync(
        path.join(distDir, "404.html"),
        createNotFoundHtml(withShell("notFound"), channel, channelLabel),
      );
      const creatorHtml = withRoutePreloadLinks(withShell("creator"), routePreloadLinks.get("creator"));
      const createHtml = injectLdJson(
        createWorkflowRouteHtml(creatorHtml, WORKFLOW_SEO_ROUTES.creator, channel, channelLabel),
        WORKFLOW_SEO_ROUTES.creator,
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
      const trimHtml = withRoutePreloadLinks(
        makeBetaRouteNoindex(withShell("trim"), "trim-rom"),
        routePreloadLinks.get("trim"),
      );
      const ppfUndoHtml = withRoutePreloadLinks(
        makeBetaRouteNoindex(withShell("ppf-undo"), "ppf-undo"),
        routePreloadLinks.get("ppf-undo"),
      );
      const saveEditorHtml = withRoutePreloadLinks(
        makeBetaRouteNoindex(withShell("save-editor"), "save-editor"),
        routePreloadLinks.get("save-editor"),
      );
      const whatsNewHtml = withRoutePreloadLinks(withShell("whats-new"), routePreloadLinks.get("whats-new"));
      for (const route of DOC_ROUTES) {
        const routeShellHtml = withRoutePreloadLinks(withShell(route.slug), routePreloadLinks.get("docs"));
        const docsHtml = createDocsRouteHtml(routeShellHtml, route, channel, channelLabel);
        const extensionlessPath = path.join(distDir, `${route.slug}.html`);
        const directoryIndexPath = path.join(distDir, route.slug, "index.html");
        fs.mkdirSync(path.dirname(extensionlessPath), { recursive: true });
        fs.mkdirSync(path.dirname(directoryIndexPath), { recursive: true });
        fs.writeFileSync(extensionlessPath, docsHtml);
        fs.writeFileSync(directoryIndexPath, docsHtml);
        const source = DOC_SOURCES.find((entry) => entry.slug === route.slug);
        writeDocsMarkdown(path.join(distDir, `${route.slug}.md`), source, docSourcePath(source));
      }
      for (const [slug, html] of [
        ["apply-patches", applyHtml],
        ["bundle-patches", bundleHtml],
        ["create-patch", createHtml],
        ["identify-rom", identifyHtml],
        ["test-rom", testHtml],
        ["trim-rom", trimHtml],
        ["ppf-undo", ppfUndoHtml],
        // What's new needs a document of its own or the host serves 404.html,
        // whose not-found flag hides the route on a direct load or reload. Its
        // content is fetched release notes, so it stays out of the index.
        ["whats-new", makeBetaRouteNoindex(whatsNewHtml, "whats-new")],
        ["save-editor", saveEditorHtml],
        // The old /tools/ URL stays reachable; it canonicalizes to /ppf-undo.
        ["tools", ppfUndoHtml],
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
      }
      if (channel === "prod") fs.writeFileSync(path.join(distDir, "sitemap.xml"), createSitemapSource());
      // Every channel serves the catalog. Its links use the canonical production
      // origin, matching the canonical URLs and Markdown headers; only the
      // sitemap stays production-only. This also lets a PR preview verify the
      // catalog on Cloudflare Pages before merge.
      fs.mkdirSync(path.join(distDir, path.dirname(API_CATALOG_PATH)), { recursive: true });
      fs.writeFileSync(path.join(distDir, API_CATALOG_PATH), createApiCatalogSource());
      fs.writeFileSync(path.join(distDir, OPENAPI_PATH), createOpenApiSource());
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
