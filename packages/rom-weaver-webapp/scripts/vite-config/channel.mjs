import fs from "node:fs";
import path from "node:path";
import { escapeHtml } from "../../src/webapp/escape-html.mjs";
import { SITE_NAME } from "../../src/webapp/workflow-seo.mjs";
import { rootDir } from "./paths.mjs";

export const rootManifestSourcePath = path.join(rootDir, "src", "assets", "app", "root", "manifest.json");
export const APP_CHANNELS = new Set(["prod", "beta", "nightly", "preview", "dev"]);
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

// Where this build is served from. Canonical URLs, sitemaps and canonical
// headers always name production; the machine-readable endpoints (llms.txt, the
// Markdown alternates, openapi.json and the API catalog) name the deployment
// that ships them, so a nightly, preview or self-hosted copy points readers and
// agents at itself. Unset means production; deploys and self-hosters set
// ROM_WEAVER_SITE_ORIGIN to the origin their copy is served from.
export const PRODUCTION_SITE_ORIGIN = "https://rom-weaver.com";
export const resolveSiteOrigin = (value) => {
  const text = String(value || "").trim();
  if (!text) return PRODUCTION_SITE_ORIGIN;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`ROM_WEAVER_SITE_ORIGIN '${text}' is not a URL; expected an origin such as https://example.com`);
  }
  if (!(url.protocol === "https:" || url.protocol === "http:") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`ROM_WEAVER_SITE_ORIGIN '${text}' must be an http(s) origin without a path, query, or fragment`);
  }
  return url.origin;
};

// Only released channels list the release being served in "What's new".
export const releaseVersionForChannel = (channel, appVersion) =>
  channel === "prod" || channel === "beta" || channel === "nightly" ? appVersion : "";

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

/** The `<html>` attributes the bundle reads its channel from (src/webapp/build-channel.ts). */
export const channelAttributes = (channel, channelLabel) =>
  `data-channel="${channel}" data-channel-label="${escapeHtml(channelLabel)}"`;

/** The `<html>` attribute the bundle reads its version and commit from (src/webapp/build-version.ts). */
export const buildInfoAttribute = (buildInfo) => `data-build-info="${escapeHtml(JSON.stringify(buildInfo))}"`;

// The tab title and iOS home-screen label need the channel before the bundle boots.
// The accent MUST stay the first `<html>` attribute: verify-seo-build matches `<html data-accent=`.
export const applyChannelIdentity = (html, { buildInfo, channel, channelLabel }) => {
  const accent = CHANNEL_DEFAULT_ACCENTS[channel] || CHANNEL_DEFAULT_ACCENTS.dev;
  const label = escapeHtml(channelLabel);
  const accentAttribute = accent === "madder" ? "" : `data-accent="${accent}" `;
  // Replacer functions keep `$` sequences in the label literal.
  const stampedHtml = html.replace(
    "<html ",
    () => `<html ${accentAttribute}${channelAttributes(channel, channelLabel)} ${buildInfoAttribute(buildInfo)} `,
  );
  if (channel === "prod") return stampedHtml;
  return stampedHtml
    .replace(`<title>${SITE_NAME}`, () => `<title>${SITE_NAME} ${label}`)
    .replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />')
    .replace(
      /(<meta name="apple-mobile-web-app-title" content=")([^"]*)(")/,
      (_match, open, name, close) => `${open}${name} ${label}${close}`,
    );
};

// A build leaves the channel and build info to the stamp step. That keeps index.html
// the same for every deployment. The dev server stamps directly.
export const stampChannelIdentity = ({ buildInfo, channel, channelLabel, serviceWorkerEnabled }) => ({
  name: "rom-weaver-channel-identity",
  transformIndexHtml: {
    handler(html, ctx) {
      const serviceWorkerHtml = html.replace("<html ", `<html data-service-worker-enabled="${serviceWorkerEnabled}" `);
      return ctx.server
        ? applyChannelIdentity(serviceWorkerHtml, { buildInfo, channel, channelLabel })
        : serviceWorkerHtml;
    },
    order: "pre",
  },
});
