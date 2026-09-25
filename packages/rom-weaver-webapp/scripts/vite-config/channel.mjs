import fs from "node:fs";
import path from "node:path";
import { SITE_NAME } from "../../src/webapp/workflow-seo.mjs";
import { rootDir } from "./paths.mjs";

export const rootManifestSourcePath = path.join(rootDir, "src", "assets", "app", "root", "manifest.json");
const APP_CHANNELS = new Set(["prod", "beta", "nightly", "preview", "dev"]);
const CHANNEL_DEFAULT_ACCENTS = {
  beta: "woad",
  dev: "madder",
  nightly: "verdigris",
  preview: "plum",
  prod: "madder",
};

// An unset channel is a plain production build: the Docker image, the
// `rom-weaver-webapp.tar.gz` release asset, and anyone self-hosting from a
// checkout all reach this path, and none of them is a dev build. Only the dev
// server and preview mark themselves, which they do by setting the variable
// (see scripts/dev-server.mjs); the deploy job passes its channel explicitly.
//
// A *typo* still degrades to "dev" rather than silently impersonating a
// channel it is not - an explicit-but-unrecognized value means the caller
// believed it was choosing something, so mark it and warn.
export const resolveAppChannel = (value) => {
  const channel = String(value || "").trim();
  if (!channel) return "prod";
  if (APP_CHANNELS.has(channel)) return channel;
  console.warn(`[rom-weaver] unknown ROM_WEAVER_CHANNEL '${channel}', falling back to 'dev'`);
  return "dev";
};

// Installed PWAs are identified by their manifest name, so without a per-channel
// one a nightly install is indistinguishable from production on the home screen.
export const createRootManifestSource = (channel, channelLabel) => {
  const source = fs.readFileSync(rootManifestSourcePath, "utf8").replace(/"src\/assets\/app\//g, '"assets/app/');
  if (channel === "prod") return source;
  const manifest = JSON.parse(source);
  manifest.name = `${manifest.name} ${channelLabel}`;
  manifest.short_name = `${manifest.short_name} ${channelLabel}`;
  return `${JSON.stringify(manifest, null, 2)}\n`;
};
// The tab title and the iOS home-screen label are the two places the channel has
// to show up before the bundle has even booted. Non-production deployments also
// opt out of indexing here; the deployed response repeats the policy as a header.
export const stampChannelIdentity = (channel, channelLabel, serviceWorkerEnabled) => ({
  name: "rom-weaver-channel-identity",
  transformIndexHtml: {
    handler(html) {
      const accent = CHANNEL_DEFAULT_ACCENTS[channel] || CHANNEL_DEFAULT_ACCENTS.dev;
      const serviceWorkerHtml = html.replace("<html ", `<html data-service-worker-enabled="${serviceWorkerEnabled}" `);
      const stampedHtml =
        accent === "madder" ? serviceWorkerHtml : serviceWorkerHtml.replace("<html ", `<html data-accent="${accent}" `);
      if (channel === "prod") return stampedHtml;
      return stampedHtml
        .replace(`<title>${SITE_NAME}`, `<title>${SITE_NAME} ${channelLabel}`)
        .replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />')
        .replace(/(<meta name="apple-mobile-web-app-title" content=")([^"]*)(")/, `$1$2 ${channelLabel}$3`);
    },
    order: "pre",
  },
});
