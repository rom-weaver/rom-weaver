import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { dedupeTree } from "../../scripts/dedupe-tree.mjs";
import { brotliCompressFile } from "../../scripts/wasm/brotli-compress.mjs";
import { sidecarContentType } from "./functions/assets/content-types.js";
import { createPreactAliases } from "./preact-aliases.mjs";
import { criticalAssetLinkHeaders } from "./scripts/critical-asset-hints.mjs";
import { docsVirtualModule } from "./scripts/docs-virtual-module.mjs";
import { createFirstSampleAssetFiles } from "./scripts/first-sample-assets.mjs";
import { getBuildInfo, getChangelog } from "./scripts/version.mjs";
import { createDocsRouteHtml, DOC_ROUTES } from "./src/webapp/docs-pages.mjs";
import { readDocsSlugFromPathname } from "./src/webapp/docs-routing.mjs";
import { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES } from "./src/webapp/workflow-seo.mjs";

const rootDir = process.cwd();
/** Shared chunks below this many raw bytes are folded back into their importer; see build.rollupOptions.output. */
const SHARED_CHUNK_MIN_SIZE = 30_000;
const repoRoot = path.resolve(rootDir, "../..");

const rootManifestSourcePath = path.join(rootDir, "src", "assets", "app", "root", "manifest.json");
const rootAssetDir = path.join(rootDir, "src", "assets", "app", "root");
const docsScreenshotCaptures = [
  "apply-output-desktop-dark",
  "apply-output-desktop-light",
  "apply-output-mobile-dark",
  "apply-output-mobile-light",
  "apply-patches-desktop-dark",
  "apply-patches-desktop-light",
  "apply-patches-mobile-dark",
  "apply-patches-mobile-light",
  "bundle-output-desktop-dark",
  "bundle-output-desktop-light",
  "bundle-output-mobile-dark",
  "bundle-output-mobile-light",
  "create-inputs-desktop-dark",
  "create-inputs-desktop-light",
  "create-inputs-mobile-dark",
  "create-inputs-mobile-light",
  "create-output-desktop-dark",
  "create-output-desktop-light",
  "create-output-mobile-dark",
  "create-output-mobile-light",
];
const docsScreenshotNames = [
  ...docsScreenshotCaptures.flatMap((name) => [`${name}.avif`, `${name}.webp`]),
  "first-sample-hello-world.webp",
  "first-sample-modified-world.webp",
  "first-sample-modified-rom.webp",
];
const docsScreenshotSources = Object.fromEntries(
  docsScreenshotNames.map((name) => [`/docs/screenshots/${name}`, path.join(rootDir, "design", name)]),
);

// A manifest's icons are read at install time, so an installed PWA's icon can
// only follow the build channel - unlike the in-app mark, which follows the
// user's accent. scripts/generate-channel-icons.mjs pre-renders (and commits) a
// tinted set per channel; channels defaulting to madder have no directory and
// fall through to the stock icons.
const channelAssetPath = (channel, name) => {
  const override = path.join(rootAssetDir, "channels", channel, name);
  return fs.existsSync(override) ? override : path.join(rootAssetDir, name);
};

const rootStaticAssetSourcesForChannel = (channel) => ({
  "/_redirects": path.join(rootAssetDir, "_redirects"),
  "/apple-touch-icon.png": channelAssetPath(channel, "apple-touch-icon.png"),
  "/favicon.ico": channelAssetPath(channel, "favicon.ico"),
  "/icon-maskable-192.png": channelAssetPath(channel, "icon-maskable-192.png"),
  "/icon-maskable-512.png": channelAssetPath(channel, "icon-maskable-512.png"),
  "/llms.txt": path.join(rootAssetDir, "llms.txt"),
  "/logo.svg": channelAssetPath(channel, "logo.svg"),
  "/manifest.json": rootManifestSourcePath,
  "/social-preview.avif": path.join(rootDir, "design", "social-preview.avif"),
  "/social-preview.png": path.join(rootDir, "design", "social-preview.png"),
  "/social-preview.webp": path.join(rootDir, "design", "social-preview.webp"),
  ...docsScreenshotSources,
});
const generatedSampleAssetPaths = new Set([
  "/first-create.zip",
  "/first-weave.zip",
  "/hello-world.nes",
  "/modified-world.nes",
]);
let generatedSampleAssets;
const getGeneratedSampleAsset = (requestPath) => {
  if (!generatedSampleAssetPaths.has(requestPath)) return null;
  generatedSampleAssets ||= createFirstSampleAssetFiles();
  return generatedSampleAssets.get(requestPath.slice(1));
};
const generatedLicenseAssetSources = {
  "/NOTICE": path.join(rootDir, "src", "wasm", "NOTICE"),
  "/WEBAPP_NOTICE": path.join(rootDir, "src", "wasm", "WEBAPP_NOTICE"),
};
// SharedArrayBuffer (the wasm thread pool) needs a cross-origin isolated page: COOP/COEP on the
// document and COEP on every dedicated-worker script, so these apply to every response. Also the
// source for the deployed _headers file - see writeCloudflareHeadersAsset.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const securityHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  ...crossOriginIsolationHeaders,
  Expires: "0",
  Pragma: "no-cache",
};
const runtimeScratchIgnorePatterns = [
  "**/dist/**",
  "**/.rpjs-vfs",
  "**/.rpjs-vfs/**",
  "**/src/wasm/*.wasm",
  "**/src/wasm/*.wasm.br",
  path.join(os.tmpdir(), "rpjs-vfs*").replace(/\\/g, "/"),
];
const getHotUpdateLabel = (filePath) => path.relative(rootDir, filePath) || path.basename(filePath);

const deferDevHotUpdates = () => ({
  apply: "serve",
  handleHotUpdate(ctx) {
    ctx.server.ws.send({
      data: {
        label: getHotUpdateLabel(ctx.file),
        source: "vite",
      },
      event: "rom-weaver:reload-available",
      type: "custom",
    });
    return [];
  },
  name: "rom-weaver-defer-dev-hot-updates",
});

const setRootStaticAssetContentType = (requestPath, res) => {
  if (requestPath.endsWith(".html")) res.setHeader("Content-Type", "text/html; charset=utf-8");
  else if (requestPath.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
  else if (requestPath.endsWith(".txt")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
  else if (requestPath.endsWith(".avif")) res.setHeader("Content-Type", "image/avif");
  else if (requestPath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
  else if (requestPath.endsWith(".zip")) res.setHeader("Content-Type", "application/zip");
  else if (requestPath.endsWith(".webp")) res.setHeader("Content-Type", "image/webp");
  else if (requestPath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  else if (requestPath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
  else if (requestPath.endsWith("NOTICE")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
};

const applyRootStaticAssetMiddleware = (middlewares, channel, channelLabel) => {
  const rootStaticAssetSources = rootStaticAssetSourcesForChannel(channel);
  middlewares.use((req, res, next) => {
    const requestPath = req.url ? req.url.split("?")[0] : "";
    const generatedSampleAsset = getGeneratedSampleAsset(requestPath);
    const sourcePath = rootStaticAssetSources[requestPath] ?? generatedLicenseAssetSources[requestPath];
    if (!(generatedSampleAsset || sourcePath)) {
      next();
      return;
    }
    if (generatedSampleAsset) {
      res.statusCode = 200;
      setRootStaticAssetContentType(requestPath, res);
      res.setHeader("Cache-Control", "no-cache");
      res.end(generatedSampleAsset);
      return;
    }
    if (requestPath === "/manifest.json") {
      res.statusCode = 200;
      setRootStaticAssetContentType(requestPath, res);
      res.setHeader("Cache-Control", "no-cache");
      res.end(createRootManifestSource(channel, channelLabel));
      return;
    }
    fs.readFile(sourcePath, (err, source) => {
      if (err) {
        next(err);
        return;
      }
      res.statusCode = 200;
      setRootStaticAssetContentType(requestPath, res);
      res.setHeader("Cache-Control", "no-cache");
      res.end(source);
    });
  });
};

const serveRootStaticAssets = (channel, channelLabel) => ({
  apply: "serve",
  configurePreviewServer(server) {
    applyRootStaticAssetMiddleware(server.middlewares, channel, channelLabel);
  },
  configureServer(server) {
    applyRootStaticAssetMiddleware(server.middlewares, channel, channelLabel);
  },
  name: "rom-weaver-root-static-assets",
});

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

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
const resolveAppChannel = (value) => {
  const channel = String(value || "").trim();
  if (!channel) return "prod";
  if (APP_CHANNELS.has(channel)) return channel;
  console.warn(`[rom-weaver] unknown ROM_WEAVER_CHANNEL '${channel}', falling back to 'dev'`);
  return "dev";
};

// Installed PWAs are identified by their manifest name, so without a per-channel
// one a nightly install is indistinguishable from production on the home screen.
const createRootManifestSource = (channel, channelLabel) => {
  const source = fs.readFileSync(rootManifestSourcePath, "utf8").replace(/"src\/assets\/app\//g, '"assets/app/');
  if (channel === "prod") return source;
  const manifest = JSON.parse(source);
  manifest.name = `${manifest.name} ${channelLabel}`;
  manifest.short_name = `${manifest.short_name} ${channelLabel}`;
  return `${JSON.stringify(manifest, null, 2)}\n`;
};

const createRobotsSource = (channel) =>
  channel === "prod"
    ? "User-agent: *\nAllow: /\nSitemap: https://rom-weaver.com/sitemap.xml\n"
    : "User-agent: *\nDisallow: /\n";

const replaceMetaContent = (html, attribute, name, content) =>
  html.replace(new RegExp(`(<meta\\s+${attribute}="${name}"\\s+content=")[^"]*(")`), `$1${content}$2`);

const createWorkflowRouteHtml = (html, route, channel, channelLabel) => {
  const title = channel === "prod" ? route.title : route.title.replace(SITE_NAME, `${SITE_NAME} ${channelLabel}`);
  const canonicalUrl = `https://rom-weaver.com/${route.slug}`;
  let routeHtml = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${canonicalUrl}$2`);
  for (const [attribute, name, content] of [
    ["name", "description", route.description],
    ["property", "og:title", title],
    ["property", "og:description", route.description],
    ["property", "og:url", canonicalUrl],
    ["name", "twitter:title", title],
    ["name", "twitter:description", route.description],
  ]) {
    routeHtml = replaceMetaContent(routeHtml, attribute, name, content);
  }
  return routeHtml;
};

// Describe both the site name and free browser tool in one graph. alternateName
// keeps legacy spellings discoverable without making the visible brand inconsistent.
const createStructuredDataLdJson = (route, includeWebsite) => {
  const graph = [];
  if (includeWebsite) {
    graph.push({
      "@type": "WebSite",
      alternateName: SITE_ALTERNATE_NAMES,
      name: SITE_NAME,
      url: "https://rom-weaver.com/",
    });
  }
  graph.push({
    "@type": "SoftwareApplication",
    alternateName: SITE_ALTERNATE_NAMES,
    applicationCategory: "UtilitiesApplication",
    description: route.description,
    name: SITE_NAME,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    operatingSystem: "Web browser",
    url: `https://rom-weaver.com/${route.slug}`,
  });
  const data = {
    "@context": "https://schema.org",
    "@graph": graph,
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
};

const injectLdJson = (html, route, includeWebsite = false) =>
  html.replace("</head>", `  ${createStructuredDataLdJson(route, includeWebsite)}\n  </head>`);

// The Trim and Tools tabs are still beta - they navigate in production but must
// not be indexed, and they inherit the Weave page's markup, so strip the shared
// index directive to noindex and point their canonical at themselves (rather
// than leaking a /apply canonical that would fold them into the patcher page).
const makeBetaRouteNoindex = (html, slug) =>
  html
    .replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />')
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1https://rom-weaver.com/${slug}$2`);

const createNotFoundHtml = (html, channel, channelLabel) => {
  const title = `Page not found | ${SITE_NAME}${channel === "prod" ? "" : ` ${channelLabel}`}`;
  const description = "The requested rom-weaver page could not be found.";
  let notFoundHtml = html
    .replace("<html ", '<html data-page="not-found" ')
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta\s+name="robots"\s+content=")[^"]*(")/, "$1noindex$2")
    .replace(
      'aria-selected="true" class="mode" data-mode="patcher"',
      'aria-selected="false" class="mode" data-mode="patcher"',
    )
    .replace(/\s*<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/, "");
  for (const [attribute, name, content] of [
    ["name", "description", description],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", "https://rom-weaver.com/"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
  ]) {
    notFoundHtml = replaceMetaContent(notFoundHtml, attribute, name, content);
  }
  return notFoundHtml;
};

const createSitemapSource = () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://rom-weaver.com/apply</loc></url>
  <url><loc>https://rom-weaver.com/create</loc></url>
${DOC_ROUTES.map(({ slug }) => `  <url><loc>https://rom-weaver.com/${slug}</loc></url>`).join("\n")}
</urlset>
`;

// The tab title and the iOS home-screen label are the two places the channel has
// to show up before the bundle has even booted. Non-production deployments also
// opt out of indexing here; the deployed response repeats the policy as a header.
const stampChannelIdentity = (channel, channelLabel, serviceWorkerEnabled) => ({
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

const PRERENDER_RUNTIME_SLOT = '<span class="masthead-runtime">· web · sw</span>';
const PRERENDER_RUNTIME_RESOLVER =
  "<script>try{window.ROM_WEAVER_RESOLVE_SHELL_IDENTITY()}finally{document.currentScript.remove()}</script>";
const PRERENDER_ROOT = (shell) =>
  `<div id="webapp-root" aria-busy="true">${shell.replace(
    PRERENDER_RUNTIME_SLOT,
    `${PRERENDER_RUNTIME_SLOT}${PRERENDER_RUNTIME_RESOLVER}`,
  )}</div>`;

const writeWebappStaticAssets = (channel, channelLabel, prerenderedShells, routePreloadLinks) => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
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
      const patcherRoot = PRERENDER_ROOT(prerenderedShells.get("patcher"));
      if (!indexHtml.includes(patcherRoot))
        throw new Error("rom-weaver-static-assets: prerendered patcher shell not found in dist/index.html");
      // dist/index.html is served at the apex (the patcher); give it the same
      // structured data the /apply route gets.
      const applyHtml = injectLdJson(indexHtml, WORKFLOW_SEO_ROUTES.patcher, true);
      fs.writeFileSync(path.join(distDir, "index.html"), applyHtml);
      fs.writeFileSync(path.join(distDir, "apply.html"), applyHtml);
      fs.writeFileSync(
        path.join(distDir, "404.html"),
        createNotFoundHtml(
          indexHtml.replace(patcherRoot, PRERENDER_ROOT(prerenderedShells.get("notFound"))),
          channel,
          channelLabel,
        ),
      );
      const creatorHtml = withRoutePreloadLinks(
        indexHtml.replace(patcherRoot, PRERENDER_ROOT(prerenderedShells.get("creator"))),
        routePreloadLinks.get("creator"),
      );
      const createHtml = injectLdJson(
        createWorkflowRouteHtml(creatorHtml, WORKFLOW_SEO_ROUTES.creator, channel, channelLabel),
        WORKFLOW_SEO_ROUTES.creator,
      );
      fs.writeFileSync(path.join(distDir, "create.html"), createHtml);
      for (const route of DOC_ROUTES) {
        const docsShell = prerenderedShells.get(route.slug);
        if (!docsShell) throw new Error(`rom-weaver-static-assets: no prerendered shell for ${route.slug}`);
        const routeShellHtml = withRoutePreloadLinks(
          indexHtml.replace(patcherRoot, PRERENDER_ROOT(docsShell)),
          routePreloadLinks.get("docs"),
        );
        const docsHtml = createDocsRouteHtml(routeShellHtml, route, channel, channelLabel);
        const extensionlessPath = path.join(distDir, `${route.slug}.html`);
        const directoryIndexPath = path.join(distDir, route.slug, "index.html");
        fs.mkdirSync(path.dirname(extensionlessPath), { recursive: true });
        fs.mkdirSync(path.dirname(directoryIndexPath), { recursive: true });
        fs.writeFileSync(extensionlessPath, docsHtml);
        fs.writeFileSync(directoryIndexPath, docsHtml);
      }
      for (const [slug, html] of [
        ["apply", applyHtml],
        ["create", createHtml],
        ["trim", withRoutePreloadLinks(makeBetaRouteNoindex(indexHtml, "trim"), routePreloadLinks.get("trim"))],
        ["tools", withRoutePreloadLinks(makeBetaRouteNoindex(indexHtml, "tools"), routePreloadLinks.get("tools"))],
      ]) {
        const routeDir = path.join(distDir, slug);
        fs.mkdirSync(routeDir, { recursive: true });
        fs.writeFileSync(path.join(routeDir, "index.html"), html.replace("<head>", '<head>\n    <base href="../" />'));
      }
      fs.writeFileSync(path.join(distDir, "robots.txt"), createRobotsSource(channel));
      if (channel === "prod") fs.writeFileSync(path.join(distDir, "sitemap.xml"), createSitemapSource());
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

// See scripts/critical-asset-hints.mjs for why these are emitted and why both use
// `rel=preload`. They ride in the `/*` block rather than an enumerated route list: every
// document in the build - the prerendered workflow routes, 404.html, every docs slug, and
// any route added later - loads the same two assets, and a list would silently stop
// covering new ones. The hint also lands on subresource responses, which ignore it.
const readCriticalAssetLinks = (distDir) =>
  criticalAssetLinkHeaders(fs.readFileSync(path.join(distDir, "index.html"), "utf8"));

// Cloudflare Pages serves dist/_headers on every response, so deployed pages are cross-origin
// isolated from the first network load instead of round-tripping through the service worker's
// COEP-injection reload. Hosts without header control still use the service-worker fallback.
// Emitted at the dist root, which keeps it out of the SW precache globs.
const writeCloudflareHeadersAsset = (channel) => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const headers = {
        ...crossOriginIsolationHeaders,
        "Content-Signal": `ai-train=no, search=${channel === "prod" ? "yes" : "no"}, ai-input=yes`,
        ...(channel === "prod" ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
      };
      const distDir = path.resolve(rootDir, outDir);
      const outputPath = path.join(distDir, "_headers");
      const headerLines = [
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        ...readCriticalAssetLinks(distDir),
      ]
        .map((line) => `  ${line}`)
        .join("\n");
      // The attribution files are named `LICENSE-APACHE`, `COPYING`, `NOTICE`
      // and so on. With no extension Cloudflare types them as a binary
      // download, which both skips its on-the-fly compression (2.1 MB of text
      // over the wire) and makes a browser download rather than display them.
      const licenseContentType =
        "/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8\n\n/NOTICE\n  Content-Type: text/plain; charset=utf-8\n\n/WEBAPP_NOTICE\n  Content-Type: text/plain; charset=utf-8\n";
      fs.writeFileSync(
        outputPath,
        `/*\n${headerLines}\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/cache-service-worker.js\n  Cache-Control: no-cache\n\n${licenseContentType}`,
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-cloudflare-headers-asset",
  };
};

// Every webapp bundle carries quality-11 brotli sidecars for hashed assets
// where q11 saves at least 2%. Cloudflare's Pages Function uses _routes.json
// to serve those exact URLs; Docker and self-hosters can serve the same static
// siblings directly. Already-compressed formats (woff2, png, zip) fail the
// savings bar and stay on the ordinary static path. Only /assets/* is eligible:
// mutable root files (index.html, the service worker, changelog.json) must keep
// their no-cache semantics and never route through the function's immutable
// response.
const PAGES_BROTLI_MIN_SAVINGS = 0.02;
// _routes.json rejects more than 100 combined include/exclude entries; leave
// headroom so an asset-count creep fails the build before Cloudflare does.
const PAGES_ROUTES_MAX_INCLUDES = 90;

const writeBrotliSidecars = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      const assetsDir = path.join(distDir, "assets");
      const wasmNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".wasm"));
      if (wasmNames.length !== 1) {
        throw new Error(`expected exactly one .wasm asset in ${assetsDir}, found: ${wasmNames.join(", ") || "none"}`);
      }
      const sourceWasm = path.join(rootDir, "src", "wasm", "rom-weaver-app.wasm");
      const sourceSidecar = `${sourceWasm}.br`;
      const emittedWasm = path.join(assetsDir, wasmNames[0]);
      if (!fs.readFileSync(emittedWasm).equals(fs.readFileSync(sourceWasm))) {
        throw new Error(`${emittedWasm} does not match ${sourceWasm}; refusing to stage a mismatched brotli sidecar`);
      }
      if (fs.existsSync(sourceSidecar)) fs.copyFileSync(sourceSidecar, `${emittedWasm}.br`);
      else brotliCompressFile({ inputPath: emittedWasm, outputPath: `${emittedWasm}.br`, quality: 11 });
      // The Pages Function reads the type from SIDECAR_CONTENT_TYPES instead of probing
      // the static asset, so a staged sidecar whose extension is missing there would
      // silently fall back to Pages' own compression. Fail the build instead.
      const assertSidecarTypeIsKnown = (assetUrl) => {
        if (sidecarContentType(assetUrl)) return;
        throw new Error(
          `${assetUrl} has a brotli sidecar but no entry in SIDECAR_CONTENT_TYPES (functions/assets/content-types.js); add its content type there`,
        );
      };
      const sidecarUrls = [`/assets/${wasmNames[0]}`];
      assertSidecarTypeIsKnown(sidecarUrls[0]);
      for (const name of fs.readdirSync(assetsDir)) {
        // `.map` sidecars are devtools-only: nothing on a normal page load
        // requests them, so a q11 pass and a _routes.json include each would
        // buy nothing and eat the include budget.
        if (name.endsWith(".wasm") || name.endsWith(".br") || name.endsWith(".map")) continue;
        const assetPath = path.join(assetsDir, name);
        const { compressedSize, sourceSize } = brotliCompressFile({
          inputPath: assetPath,
          outputPath: `${assetPath}.br`,
          quality: 11,
        });
        if (compressedSize > sourceSize * (1 - PAGES_BROTLI_MIN_SAVINGS)) {
          fs.rmSync(`${assetPath}.br`);
          continue;
        }
        assertSidecarTypeIsKnown(`/assets/${name}`);
        sidecarUrls.push(`/assets/${name}`);
      }
      if (sidecarUrls.length > PAGES_ROUTES_MAX_INCLUDES) {
        throw new Error(`${sidecarUrls.length} sidecar routes exceed the ${PAGES_ROUTES_MAX_INCLUDES} budget`);
      }
      fs.writeFileSync(
        path.join(distDir, "_routes.json"),
        `${JSON.stringify({ version: 1, include: sidecarUrls.sort(), exclude: [] }, null, 2)}\n`,
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-brotli-sidecars",
  };
};

// The "What's new" changelog, emitted at the dist root so it stays OUT of the SW
// precache globs (assets/** + named files only). The client fetches it with
// cache: "no-store", so a pending update surfaces the NEW deploy's log rather
// than the stale precached copy the running (old) bundle shipped with.
const CHANGELOG_ASSET_URL = "/changelog.json";

const serveChangelogAsset = (releaseVersion) => {
  const middleware = (req, res, next) => {
    if ((req.url ? req.url.split("?")[0] : "") !== CHANGELOG_ASSET_URL) {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(getChangelog(50, releaseVersion)));
  };
  return {
    apply: "serve",
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    name: "rom-weaver-changelog-serve",
  };
};

const writeChangelogAsset = (releaseVersion) => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const outputPath = path.join(path.resolve(rootDir, outDir), "changelog.json");
      fs.writeFileSync(outputPath, JSON.stringify(getChangelog(50, releaseVersion)));
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-changelog-asset",
  };
};

// Ship the landing shell's real markup inside #webapp-root so the browser can
// paint it as soon as the stylesheet arrives, instead of a blank page until the
// bundle executes and React mounts. Rendered from the actual components via
// react-dom/server (scripts/prerender.mjs), so there is no hand-copied markup
// to drift. The client hydrates the shell in place.
const PRERENDER_MOUNT_POINT = '<div id="webapp-root" aria-busy="true"></div>';

// Which prerendered variant a dev request gets, mirroring the app router.
const devPrerenderRoute = (url) => {
  const pathname = String(url || "").split(/[?#]/)[0];
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  const slug = segments.at(-1) || "";
  if (segments.includes("docs")) return { docsSlug: readDocsSlugFromPathname(pathname), view: "docs" };
  return {
    docsSlug: "docs",
    view: slug === "create" || slug === "create.html" ? "creator" : "patcher",
  };
};

const prerenderWebappShell = (prerenderedShells) => ({
  name: "rom-weaver-prerender-shell",
  transformIndexHtml: {
    async handler(html, ctx) {
      // Dev serves every HTML file in the package, not just the app entry
      // (mobile-safari-matrix.html is the on-device diagnostic harness), so a
      // missing mount point there is expected. It is still a hard build error:
      // index.html is the only HTML rollup input.
      if (!html.includes(PRERENDER_MOUNT_POINT)) {
        if (ctx.server) return html;
        throw new Error("rom-weaver-prerender-shell: #webapp-root mount point not found in index.html");
      }
      const prerender = await import("./scripts/prerender.mjs");
      // Dev reuses the running dev server's SSR loader (no second Vite server
      // per request) so the shell - and its prerender->mount handoff - matches
      // production locally. Build renders the creator variant too, which
      // writeWebappStaticAssets emits as a second static entry point.
      if (ctx.server) {
        const route = devPrerenderRoute(ctx.originalUrl ?? ctx.path);
        const shell = await prerender.renderLandingShellWithServer(ctx.server, route.view, false, route.docsSlug);
        const routeHtml = route.view === "docs" ? html.replace("<head>", '<head>\n    <base href="/" />') : html;
        // Production ships the bundled CSS as a render-blocking <link>, so its
        // prerendered shell paints styled. Dev serves CSS as HMR'd JS modules
        // that only apply after the bundle runs, which would flash the shell
        // unstyled. Inject the same stylesheets render-blocking (Vite serves
        // ?direct as real text/css). index.css pulls in style.css and declares
        // the layer order; the deferred and docs sheets load lazily in
        // production but are linked here so every dev shell paints complete -
        // cascade layers make the double application harmless.
        // These links are outside the module graph, so a CSS edit only reaches
        // them on a full reload; until then the HMR'd <style> (appended after
        // them, so it wins) carries the change and a *deleted* rule lingers.
        return {
          html: routeHtml.replace(PRERENDER_MOUNT_POINT, PRERENDER_ROOT(shell)),
          tags: [
            "/src/webapp/design-system/index.css",
            "/src/webapp/design-system/deferred.css",
            "/src/webapp/design-system/docs-route.css",
          ].map((href) => ({
            attrs: { href: `${href}?direct`, rel: "stylesheet" },
            injectTo: "head",
            tag: "link",
          })),
        };
      }
      // One SSR server renders every shell the build needs; spinning one up per
      // shell would cost more than the rendering does.
      const patcherShell = await prerender.withPrerenderServer(async (server) => {
        const render = (view, notFound, docsSlug) =>
          prerender.renderLandingShellWithServer(server, view, notFound, docsSlug);
        prerenderedShells.set("patcher", await render("patcher"));
        prerenderedShells.set("creator", await render("creator"));
        prerenderedShells.set("notFound", await render("patcher", true));
        for (const route of DOC_ROUTES) {
          prerenderedShells.set(route.slug, await render("docs", false, route.slug));
        }
        return prerenderedShells.get("patcher");
      });
      return html.replace(PRERENDER_MOUNT_POINT, PRERENDER_ROOT(patcherShell));
    },
    order: "post",
  },
});

// Workflow forms are lazy route chunks (src/webapp/workflow-routes.tsx), so
// without help the landing tab's chunk is only requested once the entry bundle
// has downloaded, parsed and evaluated - one serialized round trip added to the
// exact path the prerendered shell exists to speed up. Each emitted route page
// therefore carries modulepreload links for its own route chunks, so they
// download alongside the entry instead of after it.
//
// The links live between markers so writeWebappStaticAssets can swap the
// patcher set baked into index.html for the set belonging to the route page it
// is deriving.
const ROUTE_PRELOAD_MARKER_START = "<!--rw-route-preload-->";
const ROUTE_PRELOAD_MARKER_END = "<!--/rw-route-preload-->";

const WORKFLOW_ROUTE_MODULES = {
  creator: "src/public/react/create-patch-form.tsx",
  docs: "src/webapp/docs-page.tsx",
  patcher: "src/public/react/apply-patch-form.tsx",
  tools: "src/webapp/components/tools-form.tsx",
  trim: "src/public/react/trim-form.tsx",
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

// `?worker&url` makes Vite bundle each worker entry in its own isolated rolldown
// build, so two workers that share a runtime each ship a private copy of it -
// the runner and WASI thread workers overlapped by ~85 kB raw. Intercepting the
// import at build time and emitting the worker as an extra entry chunk of the
// *main* graph instead puts both workers under one code-splitting pass, so the
// shared runtime is hoisted into a chunk both of them import. Build-only: dev
// keeps Vite's own `?worker&url` handling, and the import form stays the rule
// (see "Worker URLs" in docs/development/ARCHITECTURE.md).
const WORKER_URL_IMPORT_PATTERN = /[?&]worker(?:&|$)/;
const URL_IMPORT_PATTERN = /[?&]url(?:&|$)/;

// Filled by the plugin below with the absolute path of every emitted worker
// entry, so the chunk grouping can tell worker-only modules from app modules.
const workerEntryFiles = new Set();
/** Memoized isWorkerOnlyModule answers; the module graph is rebuilt per build, so it resets there. */
const workerOnlyModules = new Map();

const shareWorkerRuntimeChunks = () => {
  const chunkRefs = new Map();
  return {
    apply: "build",
    buildStart() {
      chunkRefs.clear();
      workerEntryFiles.clear();
      workerOnlyModules.clear();
    },
    enforce: "pre",
    load(id) {
      if (!(WORKER_URL_IMPORT_PATTERN.test(id) && URL_IMPORT_PATTERN.test(id))) return null;
      const workerFile = id.split("?")[0];
      let ref = chunkRefs.get(workerFile);
      if (!ref) {
        workerEntryFiles.add(workerFile);
        ref = this.emitFile({
          id: workerFile,
          name: path.basename(workerFile, path.extname(workerFile)),
          preserveSignature: false,
          type: "chunk",
        });
        chunkRefs.set(workerFile, ref);
      }
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
    name: "rom-weaver-share-worker-runtime-chunks",
  };
};

// True when every import path that reaches this module starts at a worker entry.
// Grouping by path instead would sweep up the wasm modules the document entry
// also uses (the OPFS proxy client, the command builders), which would drag the
// whole worker runtime onto the first-paint critical path.
const isWorkerOnlyModule = (moduleId, ctx) => {
  const cached = workerOnlyModules.get(moduleId);
  if (cached !== undefined) return cached;
  const visited = new Set([moduleId]);
  const pending = [moduleId];
  let workerOnly = true;
  while (pending.length > 0 && workerOnly) {
    const id = pending.pop();
    // Only the bare path is the worker entry; the `?worker&url` module of the same file is the
    // URL stub the app imports, and its own importers decide where it belongs.
    if (workerEntryFiles.has(id)) continue;
    const info = ctx.getModuleInfo(id);
    const importers = info ? [...info.importers, ...info.dynamicImporters] : [];
    if (importers.length === 0) {
      workerOnly = false;
      break;
    }
    for (const importer of importers) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      pending.push(importer);
    }
  }
  workerOnlyModules.set(moduleId, workerOnly);
  return workerOnly;
};

/** Captures the worker-only runtime into one `wasm-runtime` chunk; everything else falls through
 * to the `shared` group below it. `includeDependenciesRecursively` has to stay off, or the group
 * also swallows the app-facing wasm modules its members depend on. */
const nameWorkerRuntimeGroup = (moduleId, ctx) => (isWorkerOnlyModule(moduleId, ctx) ? "wasm-runtime" : null);

const preloadWorkflowRouteChunks = (routePreloadLinks) => ({
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
          .sort();
        const routeCss = [...collectChunkCss(bundle, routeFiles)].filter((fileName) => !entryCss.has(fileName)).sort();
        const links = [renderRouteStylesheetLinks(routeCss), renderRoutePreloadLinks(routeFiles)]
          .filter(Boolean)
          .join("\n");
        routePreloadLinks.set(view, links);
      }
      return html.replace(
        "</head>",
        `${ROUTE_PRELOAD_MARKER_START}\n${routePreloadLinks.get("patcher")}\n  ${ROUTE_PRELOAD_MARKER_END}\n  </head>`,
      );
    },
    order: "post",
  },
});

const withRoutePreloadLinks = (html, links) =>
  html.replace(
    new RegExp(`${ROUTE_PRELOAD_MARKER_START}[\\s\\S]*?${ROUTE_PRELOAD_MARKER_END}`),
    `${ROUTE_PRELOAD_MARKER_START}\n${links}\n  ${ROUTE_PRELOAD_MARKER_END}`,
  );

export default defineConfig(({ command, mode }) => {
  const buildInfo = getBuildInfo();
  const devServiceWorkerEnabled = process.env.VITE_SW_DEV === "1";
  const serviceWorkerEnabled = command === "build" || devServiceWorkerEnabled;
  const appVersion =
    process.env.ROM_WEAVER_APP_VERSION || buildInfo.version || process.env.npm_package_version || "0.1.0";
  const commitHash = process.env.ROM_WEAVER_COMMIT_HASH || buildInfo.commitHash || "unknown";
  const commitsSinceVersion = buildInfo.commitsSinceVersion ?? null;
  const dirtyHash = process.env.ROM_WEAVER_DIRTY_HASH ?? buildInfo.dirtyHash ?? "";
  const gitBranch = process.env.ROM_WEAVER_GIT_BRANCH ?? buildInfo.gitBranch ?? "";
  const versionIsTagged = (buildInfo.isVersionTag ?? false) && !dirtyHash;
  // CI's deploy job already resolves which origin this bundle is headed for;
  // an unset channel means a local build or dev server, never production.
  const appChannel = resolveAppChannel(process.env.ROM_WEAVER_CHANNEL);
  const appChannelLabel = process.env.ROM_WEAVER_CHANNEL_LABEL || appChannel;
  const releaseVersion = appChannel === "prod" || appChannel === "beta" || appChannel === "nightly" ? appVersion : "";
  const serviceWorkerDefines = {
    __SERVICE_WORKER_ENABLED__: JSON.stringify(serviceWorkerEnabled),
    __SERVICE_WORKER_UPDATE_INTERVAL_MS__: JSON.stringify(command === "build" ? 60000 : 5000),
  };
  const prerenderedShells = new Map();
  const routePreloadLinks = new Map();

  return {
    assetsInclude: ["**/*.wasm"],
    base: "./",
    build: {
      assetsInlineLimit: 0,
      cssMinify: "lightningcss",
      emptyOutDir: true,
      outDir: "dist",
      rollupOptions: {
        input: path.resolve(rootDir, "index.html"),
        output: {
          // Splitting the workflow forms into route chunks (workflow-routes.tsx)
          // strands their shared leaves in a long tail of sub-kB chunks. Each
          // chunk is its own brotli stream with its own window, so that tail
          // costs far more compressed than it saves raw: on the apex route it
          // was ~8 kB brotli against a ~2 kB raw gain. One shared chunk for
          // everything two or more chunks reach restores the compression
          // context; the size floor keeps a future split from re-stranding it.
          advancedChunks: {
            groups: [
              { includeDependenciesRecursively: false, minShareCount: 2, name: nameWorkerRuntimeGroup, priority: 1 },
              { minShareCount: 2, name: "shared", priority: 0, test: /./ },
            ],
            minSize: SHARED_CHUNK_MIN_SIZE,
          },
        },
      },
      // External `.map` sidecars, never inline: a stack trace from a released
      // bundle is otherwise unreadable, and the maps cost nothing to a user who
      // never opens devtools. They are excluded from the service-worker
      // precache, the brotli sidecars and the Docker compression pass, so the
      // only bytes a normal visit pays for are the `sourceMappingURL` comments.
      sourcemap: true,
      target: "es2022",
    },
    clearScreen: false,
    css: {
      // Dev-only: build-time CSS sourcemaps do not exist in (rolldown-)vite - build.sourcemap
      // only covers JS (vitejs/vite#2830) - but dev serves compiled CSS, and this maps it
      // back to the design-system source files in devtools.
      devSourcemap: true,
      transformer: "lightningcss",
    },
    define: {
      __APP_CHANNEL__: JSON.stringify(appChannel),
      __APP_CHANNEL_LABEL__: JSON.stringify(appChannelLabel),
      __APP_VERSION__: JSON.stringify(appVersion),
      __COMMIT_HASH__: JSON.stringify(commitHash),
      __COMMITS_SINCE_VERSION__: JSON.stringify(commitsSinceVersion),
      __DIRTY_HASH__: JSON.stringify(dirtyHash),
      __GIT_BRANCH__: JSON.stringify(gitBranch),
      __VERSION_IS_TAGGED__: JSON.stringify(versionIsTagged),
      ...serviceWorkerDefines,
    },
    optimizeDeps: {
      include: [
        "@bjorn3/browser_wasi_shim",
        "lucide-react/dist/esm/icons/heart.mjs",
        "lucide-react/dist/esm/icons/refresh-cw.mjs",
        "lucide-react/dist/esm/icons/rotate-ccw.mjs",
        "lucide-react/dist/esm/icons/save.mjs",
        "lucide-react/dist/esm/icons/settings.mjs",
        "react",
        "react-dom",
        "react-dom/client",
      ],
    },
    plugins: [
      docsVirtualModule(),
      shareWorkerRuntimeChunks(),
      serveRootStaticAssets(appChannel, appChannelLabel),
      serveChangelogAsset(releaseVersion),
      deferDevHotUpdates(),
      stampChannelIdentity(appChannel, appChannelLabel, serviceWorkerEnabled),
      react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
      prerenderWebappShell(prerenderedShells),
      preloadWorkflowRouteChunks(routePreloadLinks),
      writeWebappStaticAssets(appChannel, appChannelLabel, prerenderedShells, routePreloadLinks),
      writeChangelogAsset(releaseVersion),
      writeCloudflareHeadersAsset(appChannel),
      writeBrotliSidecars(),
      VitePWA({
        devOptions: {
          disableRuntimeConfig: true,
          enabled: devServiceWorkerEnabled,
          type: "module",
        },
        filename: "cache-service-worker.ts",
        injectManifest: {
          globIgnores: ["**/*.map"],
          globPatterns: [
            // Every route ships its own prerendered document, so precache them all:
            // offline, a route the user has not visited yet has nothing in the runtime
            // cache, and without its own shell it falls back to the patcher one and
            // hydrates through a mismatch. Only the directory-index copy is listed -
            // the `<slug>.html` twin is the same bytes, and the service worker looks
            // routes up by the index form (see matchRouteDocument).
            "index.html",
            "**/index.html",
            "404.html",
            "manifest.json",
            "logo.svg",
            "first-create.zip",
            "first-weave.zip",
            "favicon.ico",
            "apple-touch-icon.png",
            "hello-world.nes",
            "modified-world.nes",
            "icon-maskable-192.png",
            "icon-maskable-512.png",
            "assets/**/*.{css,js,mjs,json,png,svg,jpg,jpeg,webp,woff2,wasm}",
          ],
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        },
        injectRegister: null,
        integration: {
          configureCustomSWViteBuild(inlineConfig) {
            const output = inlineConfig?.build?.rollupOptions?.output;
            if (output && !Array.isArray(output) && "inlineDynamicImports" in output)
              delete output.inlineDynamicImports;
          },
        },
        manifest: false,
        registerType: "prompt",
        srcDir: "src/webapp",
        strategies: "injectManifest",
      }),
      ...(mode === "analyze"
        ? [
            visualizer({
              brotliSize: true,
              filename: path.resolve(rootDir, "dist", "bundle-analysis.html"),
              gzipSize: true,
              projectRoot: repoRoot,
              title: "rom-weaver bundle analysis",
            }),
          ]
        : []),
    ],
    preview: {
      headers: securityHeaders,
      host: "0.0.0.0",
    },
    publicDir: false,
    resolve: {
      alias: createPreactAliases(),
      preserveSymlinks: false,
    },
    ssr: {
      noExternal: ["lucide-react"],
    },
    server: {
      fs: {
        allow: [rootDir, repoRoot],
      },
      headers: securityHeaders,
      host: "0.0.0.0",
      watch: {
        ignored: runtimeScratchIgnorePatterns,
      },
    },
    worker: {
      format: "es",
    },
  };
});
