import fs from "node:fs";
import path from "node:path";
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
// Each stamp reads these back. The saved service worker still holds its manifest placeholder.
const TEMPLATE = {
  defines: "defines.json",
  icons: "channel-icons",
  index: "index.html",
  routePreloadLinks: "route-preload-links.json",
  serviceWorker: SERVICE_WORKER_NAME,
  serviceWorkerMap: `${SERVICE_WORKER_NAME}.map`,
};

/** Replaces the saved templates with the ones from the fresh build in `distDir`. */
const saveChannelStampTemplates = ({ define, distDir, routePreloadLinks, templatesDir }) => {
  const stagingDir = `${templatesDir}.tmp`;
  fs.rmSync(stagingDir, { force: true, recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const name of [TEMPLATE.index, TEMPLATE.serviceWorker, TEMPLATE.serviceWorkerMap]) {
    fs.copyFileSync(path.join(distDir, name), path.join(stagingDir, name));
  }
  fs.cpSync(generatedIconAssetsDir, path.join(stagingDir, TEMPLATE.icons), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, TEMPLATE.defines), `${JSON.stringify(define, null, 2)}\n`);
  fs.writeFileSync(
    path.join(stagingDir, TEMPLATE.routePreloadLinks),
    `${JSON.stringify(Object.fromEntries(routePreloadLinks), null, 2)}\n`,
  );
  fs.rmSync(templatesDir, { force: true, recursive: true });
  fs.renameSync(stagingDir, templatesDir);
};

/** Rewrites the channel-dependent files in `distDir` from the templates, leaving `dist/assets` alone. */
export const stampChannel = async ({ channel, channelLabel, distDir, siteOrigin, templatesDir }) => {
  const readTemplate = (name) => fs.readFileSync(path.join(templatesDir, name), "utf8");
  const define = JSON.parse(readTemplate(TEMPLATE.defines));
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
    indexHtml: applyChannelIdentity(readTemplate(TEMPLATE.index), channel, channelLabel),
    prerenderedShells: await renderPrerenderedShells({ channel, channelLabel, define }),
    routePreloadLinks,
    siteOrigin,
  });
  writeChangelog(distDir, releaseVersionForChannel(channel, JSON.parse(define.__APP_VERSION__)));
  minifyDocumentInlineScripts(distDir);
  writeCloudflareHeaders(distDir, channel);
  // Last: the manifest revisions hash the documents written above.
  await injectPrecacheManifest({
    distDir,
    swDest: path.join(distDir, SERVICE_WORKER_NAME),
    swSrc: path.join(templatesDir, TEMPLATE.serviceWorker),
  });
};

/** Saves the templates, then stamps the build's own channel after VitePWA emits the service worker. */
export const stampBuildChannel = ({ channel, channelLabel, define, routePreloadLinks, siteOrigin }) => {
  let distDir = path.join(rootDir, "dist");
  return {
    apply: "build",
    closeBundle: {
      async handler() {
        saveChannelStampTemplates({
          define,
          distDir,
          routePreloadLinks,
          templatesDir: CHANNEL_STAMP_TEMPLATES_DIR,
        });
        await stampChannel({
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
