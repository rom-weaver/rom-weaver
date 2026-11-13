import fs from "node:fs";
import path from "node:path";
import replaceAndUpdateSourceMapModule from "workbox-build/build/lib/replace-and-update-source-map.js";
import { generatedIconAssetsDir } from "../generated-icon-assets.mjs";
import { writeChangelog } from "./changelog.mjs";
import { applyChannelIdentity, releaseVersionForChannel } from "./channel.mjs";
import { writeCloudflareHeaders } from "./headers.mjs";
import { minifyDocumentInlineScripts } from "./minify-document-inline-scripts.mjs";
import { rootDir } from "./paths.mjs";
import { injectPrecacheManifest } from "./precache.mjs";
import { renderPrerenderedShells } from "./prerender-shell.mjs";
import { writeChannelRootStaticAssets } from "./root-static-assets.mjs";
import { writeChannelPages } from "./static-assets.mjs";

// Outside dist, which Pages uploads and the Docker image copies whole.
export const CHANNEL_STAMP_TEMPLATES_DIR = path.join(rootDir, "build", "channel-stamp");
const SERVICE_WORKER_NAME = "rom-weaver-service-worker.js";
// The global that src/webapp/build-version.ts reads. The stamp overwrites it in the
// service worker, which has no <html>.
const SERVICE_WORKER_BUILD_INFO_PLACEHOLDER = "globalThis.__ROM_WEAVER_BUILD_INFO__";
// Each stamp reads these back. The saved service worker still holds its manifest placeholder.
const TEMPLATE = {
  icons: "channel-icons",
  index: "index.html",
  routePreloadLinks: "route-preload-links.json",
  serviceWorker: SERVICE_WORKER_NAME,
  serviceWorkerMap: `${SERVICE_WORKER_NAME}.map`,
};

/** Replaces the saved templates with the ones from the fresh build in `distDir`. */
const saveChannelStampTemplates = ({ distDir, routePreloadLinks, templatesDir }) => {
  const stagingDir = `${templatesDir}.tmp`;
  fs.rmSync(stagingDir, { force: true, recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const name of [TEMPLATE.index, TEMPLATE.serviceWorker, TEMPLATE.serviceWorkerMap]) {
    fs.copyFileSync(path.join(distDir, name), path.join(stagingDir, name));
  }
  fs.cpSync(generatedIconAssetsDir, path.join(stagingDir, TEMPLATE.icons), { recursive: true });
  fs.writeFileSync(
    path.join(stagingDir, TEMPLATE.routePreloadLinks),
    `${JSON.stringify(Object.fromEntries(routePreloadLinks), null, 2)}\n`,
  );
  fs.rmSync(templatesDir, { force: true, recursive: true });
  fs.renameSync(stagingDir, templatesDir);
};

/** Writes `buildInfo` over the placeholder in the service worker at `swPath` and its source map. */
const stampServiceWorkerBuildInfo = async (swPath, buildInfo) => {
  const mapPath = `${swPath}.map`;
  const originalSource = fs.readFileSync(swPath, "utf8");
  if (!originalSource.includes(SERVICE_WORKER_BUILD_INFO_PLACEHOLDER)) {
    throw new Error(`${swPath} has no ${SERVICE_WORKER_BUILD_INFO_PLACEHOLDER} to stamp the build info over`);
  }
  const { map, source } = await replaceAndUpdateSourceMapModule.replaceAndUpdateSourceMap({
    jsFilename: SERVICE_WORKER_NAME,
    originalMap: JSON.parse(fs.readFileSync(mapPath, "utf8")),
    originalSource,
    replaceString: `(${JSON.stringify(buildInfo)})`,
    searchString: SERVICE_WORKER_BUILD_INFO_PLACEHOLDER,
  });
  fs.writeFileSync(swPath, source);
  fs.writeFileSync(mapPath, map);
};

/** Rewrites the deployment-dependent files in `distDir` from the templates, leaving `dist/assets` alone. */
export const stampChannel = async ({ buildInfo, channel, channelLabel, distDir, siteOrigin, templatesDir }) => {
  const readTemplate = (name) => fs.readFileSync(path.join(templatesDir, name), "utf8");
  const routePreloadLinks = new Map(Object.entries(JSON.parse(readTemplate(TEMPLATE.routePreloadLinks))));
  writeChannelRootStaticAssets(distDir, {
    channel,
    channelLabel,
    iconDir: path.join(templatesDir, TEMPLATE.icons),
    siteOrigin,
  });
  writeChannelPages(distDir, {
    channel,
    channelLabel,
    indexHtml: applyChannelIdentity(readTemplate(TEMPLATE.index), { buildInfo, channel, channelLabel }),
    prerenderedShells: await renderPrerenderedShells({ buildInfo, channel, channelLabel }),
    routePreloadLinks,
    siteOrigin,
  });
  writeChangelog(distDir, releaseVersionForChannel(channel, buildInfo.version));
  minifyDocumentInlineScripts(distDir);
  writeCloudflareHeaders(distDir, channel);
  // Last: the manifest revisions hash the documents written above.
  const swDest = path.join(distDir, SERVICE_WORKER_NAME);
  await injectPrecacheManifest({ distDir, swDest, swSrc: path.join(templatesDir, TEMPLATE.serviceWorker) });
  await stampServiceWorkerBuildInfo(swDest, buildInfo);
};

/** Saves the templates, then stamps the build's own channel after VitePWA emits the service worker. */
export const stampBuildChannel = ({ buildInfo, channel, channelLabel, routePreloadLinks, siteOrigin }) => {
  let distDir = path.join(rootDir, "dist");
  return {
    apply: "build",
    closeBundle: {
      async handler() {
        saveChannelStampTemplates({ distDir, routePreloadLinks, templatesDir: CHANNEL_STAMP_TEMPLATES_DIR });
        await stampChannel({
          buildInfo,
          channel,
          channelLabel,
          distDir,
          siteOrigin,
          templatesDir: CHANNEL_STAMP_TEMPLATES_DIR,
        });
      },
      order: "post",
      sequential: true,
    },
    configResolved(config) {
      distDir = path.resolve(config.root, config.build.outDir);
    },
    name: "rom-weaver-channel-stamp",
  };
};
