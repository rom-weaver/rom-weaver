import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { build, defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { dedupeTree } from "../../scripts/dedupe-tree.mjs";
import { resolveIdentifyPackGroups } from "../../scripts/identify-pack-groups.mjs";
import { brotliCompressFile } from "../../scripts/wasm/brotli-compress.mjs";
import { sidecarContentType } from "./functions/assets/content-types.js";
import { compileLinguiCatalogs } from "./scripts/compile-lingui-catalogs.mjs";
import { docsVirtualModule } from "./scripts/docs-virtual-module.mjs";
import { readDocLastmod, writeDocsMarkdown } from "./scripts/docs-discovery.mjs";
import { revisionUnhashedAssets } from "./scripts/precache-revisions.mjs";
import { DOCS_SCREENSHOT_NAMES } from "./scripts/docs-screenshot-manifest.mjs";
import { createFirstSampleAssetFiles } from "./scripts/first-sample-assets.mjs";
import { generatedChannelAssetPath, generatedSocialPreviewPath } from "./scripts/generated-icon-assets.mjs";
import { minifyInlineScripts } from "./scripts/minify-inline-scripts.mjs";
import { initialPrecacheUrls } from "./scripts/offline-downloads.mjs";
import { getBuildInfo, getChangelog, getVersionBranch } from "./scripts/version.mjs";
import { createDocsRouteHtml, DOC_ROUTES, docSourcePath } from "./src/webapp/docs-pages.mjs";
import { DOC_SOURCES, readDocsSlugFromPathname } from "./src/webapp/docs-routing.mjs";
import { SITE_ALTERNATE_NAMES, SITE_NAME, WORKFLOW_SEO_ROUTES } from "./src/webapp/workflow-seo.mjs";

const rootDir = process.cwd();
/** Shared chunks below this many raw bytes are folded back into their importer; see build.rollupOptions.output. */
const SHARED_CHUNK_MIN_SIZE = 30_000;
const repoRoot = path.resolve(rootDir, "../..");
const identifyDataDir = path.join(repoRoot, "crates", "rom-weaver-cli", "data", "identify", "v1");
const identifyDataIndex = JSON.parse(fs.readFileSync(path.join(identifyDataDir, "index.json"), "utf8"));
// Packs and cheat shards ship only as `.br` sidecars; the license text is
// inlined into the attribution bundle instead of served as an asset.
// The two manifests carry the content hash every pack, shard, router, and title
// index is fetched with, so a stale manifest would hide a newer data set. They are
// content-addressed like every emitted bundle: the hash goes in the file name, the
// bundle imports that name through `__IDENTIFY_MANIFEST_FILES__`, and a build with
// new data changes both. That keeps the whole of /assets/* immutable.
const identifyManifestFile = (name) => {
  const [stem, extension] = name.split(".");
  const hash = createHash("sha256")
    .update(fs.readFileSync(path.join(identifyDataDir, name)))
    .digest("hex");
  return `identify-${stem}-${hash.slice(0, 16)}.${extension}`;
};
const identifyManifestFiles = {
  catalog: fs.existsSync(path.join(identifyDataDir, "catalog.json")) ? identifyManifestFile("catalog.json") : null,
  index: identifyManifestFile("index.json"),
};
const identifyDataSources = Object.fromEntries(
  fs
    .readdirSync(identifyDataDir)
    .filter((name) => {
      if (name.endsWith(".pack")) return false;
      if (name.startsWith("cheats-") && name.endsWith(".json")) return false;
      return name !== identifyDataIndex.sources?.libretro?.licenseFile;
    })
    .map((name) => {
      const assetName = { "catalog.json": identifyManifestFiles.catalog, "index.json": identifyManifestFiles.index }[
        name
      ];
      return [`/assets/${assetName ?? `identify-${name}`}`, path.join(identifyDataDir, name)];
    }),
);
const identifyPackGroups = resolveIdentifyPackGroups(identifyDataIndex);
const identifyPackEntry = (system) => ({
  sha256: system.sha256,
  sizeBytes: system.rawBytes || 0,
  url: `assets/identify-${system.file}?sha256=${system.sha256}`,
});
// A cheat shard installs with the group that owns its platform's pack, so the
// Settings toggle, the warm-up and `install-group` all carry cheats along.
const identifyCheatEntriesForSlugs = (slugs) =>
  (identifyDataIndex.cheats ?? []).filter((entry) => slugs.includes(entry.slug)).map(identifyPackEntry);
// Default packs are downloaded by the background warm-up rather than precached:
// they are three quarters of what a first visit would otherwise pull down, and
// an identify run fetches whatever it needs on demand long before the warm-up
// reaches it. `required` marks the group as never opt-out.
// The checksum router rides with the default packs: cached by the same warm-up,
// fetched on demand before that, and never part of the install-time precache.
const identifyChecksumRouterEntries = identifyDataIndex.checksumRoutes
  ? [identifyPackEntry(identifyDataIndex.checksumRoutes)]
  : [];
// The title index rides with the default packs for the same reason as the
// router: the cross-platform name search needs it before any pack is loaded.
const identifyTitleIndexEntries = identifyDataIndex.titleIndex ? [identifyPackEntry(identifyDataIndex.titleIndex)] : [];
const identifyDefaultPackGroup = {
  id: "default",
  label: "Built-in systems",
  packs: [
    ...identifyPackGroups.defaultSystems.map(identifyPackEntry),
    ...identifyCheatEntriesForSlugs(identifyPackGroups.defaultSystems.map((system) => system.slug)),
    ...identifyChecksumRouterEntries,
    ...identifyTitleIndexEntries,
  ],
  required: true,
};
const identifyOptionalPackGroups = [
  identifyDefaultPackGroup,
  ...identifyPackGroups.groups
    .filter((group) => !group.default)
    .map((group) => ({
      id: group.id,
      label: group.label,
      packs: [
        ...group.systems.map((slug) => {
          const system = identifyDataIndex.systems.find((candidate) => candidate.slug === slug);
          if (!system) throw new Error(`identify group ${group.id} names unknown system ${slug}`);
          return identifyPackEntry(system);
        }),
        ...identifyCheatEntriesForSlugs(group.systems),
      ],
    })),
];

const rootManifestSourcePath = path.join(rootDir, "src", "assets", "app", "root", "manifest.json");
const rootAssetDir = path.join(rootDir, "src", "assets", "app", "root");
const docsScreenshotSources = Object.fromEntries(
  DOCS_SCREENSHOT_NAMES.map((name) => [`/docs/screenshots/${name}`, path.join(repoRoot, "docs", "screenshots", name)]),
);

const rootStaticAssetSourcesForChannel = (channel) => ({
  "/_redirects": path.join(rootAssetDir, "_redirects"),
  "/apple-touch-icon.png": generatedChannelAssetPath(channel, "apple-touch-icon.png"),
  "/favicon.ico": generatedChannelAssetPath(channel, "favicon.ico"),
  "/icon-maskable-192.png": generatedChannelAssetPath(channel, "icon-maskable-192.png"),
  "/icon-maskable-512.png": generatedChannelAssetPath(channel, "icon-maskable-512.png"),
  "/llms.txt": path.join(rootAssetDir, "llms.txt"),
  "/logo.svg": generatedChannelAssetPath(channel, "logo.svg"),
  "/manifest.json": rootManifestSourcePath,
  "/social-preview.avif": generatedSocialPreviewPath("social-preview.avif"),
  "/social-preview.png": generatedSocialPreviewPath("social-preview.png"),
  "/social-preview.webp": generatedSocialPreviewPath("social-preview.webp"),
  ...identifyDataSources,
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
const EMULATORJS_DATA_PREFIX = "/emulatorjs/data/";
const EMULATORJS_MANIFEST_PATH = "/emulatorjs/manifest.json";
const emulatorJsDataSourceDir = path.join(rootDir, "vendor", "emulatorjs", "data");
const emulatorJsLock = JSON.parse(fs.readFileSync(path.join(rootDir, "vendor", "emulatorjs.lock.json"), "utf8"));

const isRegularFile = (sourcePath) => {
  try {
    return fs.statSync(sourcePath).isFile();
  } catch {
    return false;
  }
};

const emulatorJsRelativePath = (requestPath) => {
  if (!requestPath.startsWith(EMULATORJS_DATA_PREFIX)) return null;
  let relativePath;
  try {
    relativePath = decodeURIComponent(requestPath.slice(EMULATORJS_DATA_PREFIX.length));
  } catch {
    return null;
  }
  const segments = relativePath.split("/");
  if (!relativePath || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return relativePath;
};

const resolveEmulatorJsSource = (requestPath) => {
  const relativePath = emulatorJsRelativePath(requestPath);
  if (!relativePath) return null;
  const commonSourcePath = path.join(emulatorJsDataSourceDir, ...relativePath.split("/"));
  if (isRegularFile(commonSourcePath)) return commonSourcePath;
  return null;
};

const createEmulatorJsManifest = (assetRoot) => ({
  version: emulatorJsLock.version,
  files: Object.keys(emulatorJsLock.files).map((relativePath) => {
    const sourcePath = path.join(assetRoot, "data", ...relativePath.split("/"));
    if (!isRegularFile(sourcePath)) {
      throw new Error(`rom-weaver-emulatorjs: locked asset is missing: ${relativePath}`);
    }
    return { path: relativePath, sizeBytes: fs.statSync(sourcePath).size };
  }),
});

const setEmulatorJsContentType = (requestPath, res) => {
  if (requestPath.endsWith(".js")) res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  else if (requestPath.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
  else if (requestPath.endsWith(".css")) res.setHeader("Content-Type", "text/css; charset=utf-8");
  else if (requestPath.endsWith(".zip")) res.setHeader("Content-Type", "application/zip");
  else if (requestPath.endsWith(".pack") || requestPath.endsWith(".bin"))
    res.setHeader("Content-Type", "application/octet-stream");
  else if (requestPath.endsWith(".wasm.data")) res.setHeader("Content-Type", "application/octet-stream");
};

const serveEmulatorJsAssets = () => {
  const middleware = (req, res, next) => {
    const requestPath = req.url ? req.url.split("?")[0] : "";
    if (requestPath === EMULATORJS_MANIFEST_PATH) {
      res.statusCode = 200;
      setEmulatorJsContentType(requestPath, res);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(JSON.stringify(createEmulatorJsManifest(path.join(rootDir, "vendor", "emulatorjs"))) + "\n");
      return;
    }
    if (!requestPath.startsWith(EMULATORJS_DATA_PREFIX)) {
      next();
      return;
    }
    const relativePath = emulatorJsRelativePath(requestPath);
    const sourcePath = resolveEmulatorJsSource(requestPath);
    if (!(relativePath && sourcePath)) {
      res.statusCode = 404;
      res.end("EmulatorJS asset not found");
      return;
    }
    fs.readFile(sourcePath, (err, source) => {
      if (err) {
        next(err);
        return;
      }
      res.statusCode = 200;
      setEmulatorJsContentType(requestPath, res);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.end(source);
    });
  };
  return {
    apply: "serve",
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    name: "rom-weaver-emulatorjs-assets",
  };
};

const copyEmulatorJsAssets = (distDir) => {
  const outputDir = path.join(distDir, "emulatorjs");
  fs.cpSync(path.join(rootDir, "vendor", "emulatorjs"), outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(createEmulatorJsManifest(outputDir)) + "\n");
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
  else if (requestPath.endsWith(".md")) res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  else if (requestPath.endsWith(".avif")) res.setHeader("Content-Type", "image/avif");
  else if (requestPath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
  else if (requestPath.endsWith(".zip")) res.setHeader("Content-Type", "application/zip");
  else if (requestPath.endsWith(".webp")) res.setHeader("Content-Type", "image/webp");
  else if (requestPath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  else if (requestPath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
  else if (requestPath.endsWith(".pack")) res.setHeader("Content-Type", "application/octet-stream");
  else if (requestPath.endsWith("NOTICE")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
};

const LEGACY_WORKFLOW_ROUTES = {
  apply: "apply-patch",
  create: "create-patch",
  identify: "identify-rom",
  test: "test-rom",
  trim: "trim-rom",
  weave: "apply-patch",
};

const applyRootStaticAssetMiddleware = (middlewares, channel, channelLabel) => {
  const rootStaticAssetSources = rootStaticAssetSourcesForChannel(channel);
  middlewares.use((req, res, next) => {
    const requestPath = req.url ? req.url.split("?")[0] : "";
    const legacySlug = requestPath.replace(/^\//, "").replace(/(?:\/index\.html|\/|\.html)$/, "");
    const destination = Object.hasOwn(LEGACY_WORKFLOW_ROUTES, legacySlug) && LEGACY_WORKFLOW_ROUTES[legacySlug];
    if (destination) {
      res.writeHead(301, { Location: `/${destination}${req.url.slice(requestPath.length)}` });
      res.end();
      return;
    }
    const generatedSampleAsset = getGeneratedSampleAsset(requestPath);
    const sourcePath = rootStaticAssetSources[requestPath] ?? generatedLicenseAssetSources[requestPath];
    // Pages serves the .br sidecars with Content-Encoding: br for browser decoding.
    // Dev decodes them here to answer the same logical identify-asset URLs.
    const sidecarSourcePath = sourcePath ? undefined : rootStaticAssetSources[`${requestPath}.br`];
    if (!(generatedSampleAsset || sourcePath || sidecarSourcePath)) {
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
    fs.readFile(sourcePath ?? sidecarSourcePath, (err, source) => {
      if (err) {
        next(err);
        return;
      }
      const finish = (decodeError, body) => {
        if (decodeError) {
          next(decodeError);
          return;
        }
        res.statusCode = 200;
        setRootStaticAssetContentType(requestPath, res);
        res.setHeader("Cache-Control", "no-cache");
        res.end(body);
      };
      if (sidecarSourcePath) zlib.brotliDecompress(source, finish);
      else finish(null, source);
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

// The Trim, PPF undo, and Save Editor tabs are still beta - they navigate in production but must
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
  // Cloudflare serves 404.html as the body at whatever URL missed, so the
  // base:"./" relative asset URLs resolve wrong at any nested path without this.
  let notFoundHtml = html
    .replace("<html ", '<html data-page="not-found" ')
    .replace("<head>", '<head>\n    <base href="/" />')
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
  <url><loc>https://rom-weaver.com/</loc></url>
  <url><loc>https://rom-weaver.com/apply-patch</loc></url>
  <url><loc>https://rom-weaver.com/create-patch</loc></url>
  <url><loc>https://rom-weaver.com/identify-rom</loc></url>
  <url><loc>https://rom-weaver.com/test-rom</loc></url>
${DOC_SOURCES.map((source) => {
  const lastmod = readDocLastmod(docSourcePath(source), repoRoot);
  return `  <url><loc>https://rom-weaver.com/${source.slug}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
}).join("\n")}
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

const PRERENDER_RUNTIME_SLOT = '<span class="shell-identity" hidden=""></span>';
const PRERENDER_RUNTIME_RESOLVER =
  "<script>try{window.ROM_WEAVER_RESOLVE_SHELL_IDENTITY()}finally{document.currentScript.remove()}</script>";
const DOC_SHELF_STATE_KEY = "rom-weaver-docs-shelves";
// Restore the reader's docs shelves while the parser is still handling the
// prerendered shell. The first client render reads the same storage value, so
// hydration never paints the server's default closed state first.
const PRERENDER_DOC_SHELF_RESTORER = `<script>
try {
  const stored = JSON.parse(sessionStorage.getItem(${JSON.stringify(DOC_SHELF_STATE_KEY)}) || "{}");
  for (const shelf of document.querySelectorAll(".guide-shelf, .docs-index-shelf")) {
    const title = shelf.querySelector(".guide-shelf-title, .docs-index-title")?.textContent?.trim() || "";
    if (typeof stored[title] === "boolean") shelf.open = stored[title];
  }
} catch {}
</script>`;
// The hero loom starts while the parser is still in the prerendered home shell:
// src/webapp/home-loom-shell.ts is bundled as a standalone classic script and
// inlined right after the canvas, and HomeLoom adopts the running loop on
// mount. The document must carry it inline - a module script would wait for
// the HTML to finish parsing - so it is built here, once per source change,
// and only the shell that has the canvas pays for its bytes.
const SHELL_LOOM_ENTRY = path.resolve(rootDir, "src/webapp/home-loom-shell.ts");
const SHELL_LOOM_SOURCES = [SHELL_LOOM_ENTRY, path.resolve(rootDir, "src/webapp/home-loom-runtime.ts")];
const PRERENDER_LOOM_CANVAS = /<canvas\b[^>]*\bclass="home-loom-canvas"[^>]*><\/canvas>/;
let shellLoomScript = { html: "", stamp: "" };
const buildShellLoomScript = async () => {
  const stamp = SHELL_LOOM_SOURCES.map((file) => String(fs.statSync(file).mtimeMs)).join(":");
  if (shellLoomScript.stamp === stamp) return shellLoomScript.html;
  const result = await build({
    build: {
      emptyOutDir: false,
      lib: {
        entry: SHELL_LOOM_ENTRY,
        fileName: () => "home-loom-shell.js",
        formats: ["iife"],
        name: "romWeaverShellLoom",
      },
      minify: true,
      target: "es2022",
      write: false,
    },
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    root: rootDir,
  });
  const chunk = (Array.isArray(result) ? result : [result])
    .flatMap((bundle) => ("output" in bundle ? bundle.output : []))
    .find((item) => item.type === "chunk");
  if (!chunk) throw new Error("rom-weaver-prerender-shell: the shell loom script produced no chunk");
  const code = chunk.code.trim();
  // A literal `</script` in the bundle would close the inline tag early.
  if (/<\/script/i.test(code)) throw new Error("rom-weaver-prerender-shell: the shell loom script contains </script");
  shellLoomScript = { html: `<script>${code}</script>`, stamp };
  return shellLoomScript.html;
};
// The home shell MUST carry the canvas the script attaches to; a silent
// non-match would ship the empty-canvas load this script exists to remove,
// and no later check (the size budget only bounds growth) would notice.
const assertShellLoomCanvas = (shell) => {
  if (!PRERENDER_LOOM_CANVAS.test(shell))
    throw new Error("rom-weaver-prerender-shell: the home shell has no home-loom canvas for the shell loom script");
};
// Callers MUST await buildShellLoomScript() first: closeBundle rebuilds these
// strings synchronously to find the home root in dist/index.html, so the loom
// script is read from the cache filled by transformIndexHtml.
const PRERENDER_ROOT = (shell) =>
  `<div id="webapp-root" aria-busy="true">${shell
    .replace(PRERENDER_RUNTIME_SLOT, `${PRERENDER_RUNTIME_SLOT}${PRERENDER_RUNTIME_RESOLVER}`)
    .replace(
      PRERENDER_LOOM_CANVAS,
      (canvas) => `${canvas}${shellLoomScript.html}`,
    )}</div>${PRERENDER_DOC_SHELF_RESTORER}`;

const writeWebappStaticAssets = (channel, channelLabel, prerenderedShells, routePreloadLinks) => {
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
        ["apply-patch", applyHtml],
        ["create-patch", createHtml],
        ["identify-rom", identifyHtml],
        ["test-rom", testHtml],
        [
          "trim-rom",
          withRoutePreloadLinks(makeBetaRouteNoindex(patcherHtml, "trim-rom"), routePreloadLinks.get("trim")),
        ],
        [
          "ppf-undo",
          withRoutePreloadLinks(makeBetaRouteNoindex(patcherHtml, "ppf-undo"), routePreloadLinks.get("ppf-undo")),
        ],
        // What's new needs a document of its own or the host serves 404.html,
        // whose not-found flag hides the route on a direct load or reload. Its
        // content is fetched release notes, so it stays out of the index.
        [
          "whats-new",
          withRoutePreloadLinks(makeBetaRouteNoindex(patcherHtml, "whats-new"), routePreloadLinks.get("whats-new")),
        ],
        [
          "save-editor",
          withRoutePreloadLinks(makeBetaRouteNoindex(patcherHtml, "save-editor"), routePreloadLinks.get("save-editor")),
        ],
        // The old /tools/ URL stays reachable; it canonicalizes to /ppf-undo.
        [
          "tools",
          withRoutePreloadLinks(makeBetaRouteNoindex(patcherHtml, "ppf-undo"), routePreloadLinks.get("ppf-undo")),
        ],
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

// Every route document is derived from dist/index.html after the bundle is
// written, and PRERENDER_ROOT injects two more inline scripts on the way, so
// the minifier runs over the finished files rather than through
// transformIndexHtml. It must stay ahead of VitePWA in the plugin list: the
// precache manifest hashes these documents from disk.
const minifyDocumentInlineScripts = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      for (const name of fs.readdirSync(distDir, { recursive: true })) {
        const relativePath = String(name);
        if (!relativePath.endsWith(".html")) continue;
        const filePath = path.join(distDir, relativePath);
        const html = fs.readFileSync(filePath, "utf8");
        const minified = minifyInlineScripts(html, relativePath);
        if (minified !== html) fs.writeFileSync(filePath, minified);
      }
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-minify-inline-scripts",
  };
};

// Emit isolation headers for Pages' static responses; Functions set their own.
// Hosts without header control use the service worker's isolation fallback.
const writeCloudflareHeadersAsset = (channel) => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const headers = {
        ...crossOriginIsolationHeaders,
        // Deploys replace the whole asset set, so HTML held past a redeploy
        // references hashed URLs that now 404 - force revalidation on every
        // document load. The service worker script needs the same treatment and
        // inherits it from here; only /assets/* detaches it below.
        "Cache-Control": "no-cache",
        "Content-Signal": `ai-train=no, search=${channel === "prod" ? "yes" : "no"}, ai-input=yes`,
        ...(channel === "prod" ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
      };
      const distDir = path.resolve(rootDir, outDir);
      const outputPath = path.join(distDir, "_headers");
      const headerLines = Object.entries(headers)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join("\n");
      // The attribution files are named `LICENSE-APACHE`, `COPYING`, `NOTICE`
      // and so on. With no extension Cloudflare types them as a binary
      // download, which both skips its on-the-fly compression (2.1 MB of text
      // over the wire) and makes a browser download rather than display them.
      const licenseContentType =
        "/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8\n\n/NOTICE\n  Content-Type: text/plain; charset=utf-8\n\n/WEBAPP_NOTICE\n  Content-Type: text/plain; charset=utf-8\n";
      const markdownHeaders = DOC_SOURCES.map(
        ({ slug }) =>
          `/${slug}.md\n  Content-Type: text/markdown; charset=utf-8\n  Link: <https://rom-weaver.com/${slug}>; rel="canonical"\n`,
      ).join("\n");
      fs.writeFileSync(
        outputPath,
        `/*\n${headerLines}\n  ! Link\n\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n\n${licenseContentType}\n${markdownHeaders}`,
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-cloudflare-headers-asset",
  };
};

// The service worker cannot see how big its own precache is: workbox measures
// every entry, sums the sizes for its build log, then deletes the field from
// each entry before injecting the manifest (workbox-build's transform-manifest
// - ManifestEntry is {integrity?, revision, url}). A manifestTransform runs
// while the sizes are still there, so this writes them out beside the bundle
// for the worker to fetch when it installs. Without it the install stage can
// only count entries, and a 4 MB wasm module weighs the same as a translation
// file. Emitted at the dist root, which keeps it out of the precache globs.
const PRECACHE_SIZES_FILENAME = "precache-sizes.json";

const writePrecacheSizes =
  () =>
  (manifestEntries, _compilation, distDir = path.resolve(rootDir, "dist")) => {
    const sizes = {};
    for (const entry of manifestEntries) {
      if (typeof entry.size === "number") sizes[entry.url] = entry.size;
    }
    fs.writeFileSync(path.join(distDir, PRECACHE_SIZES_FILENAME), `${JSON.stringify(sizes)}\n`);
    return { manifest: manifestEntries };
  };

const preparePrecacheEntries = () => (entries) => {
  const distDir = path.resolve(rootDir, "dist");
  const initial = initialPrecacheUrls(distDir);
  const manifest = entries.map((entry) => ({
    ...entry,
    install: initial.has(entry.url),
    sizeBytes: entry.size,
  }));
  return { manifest };
};

// Every webapp bundle carries quality-11 brotli sidecars for immutable assets
// where q11 saves at least 2%. Cloudflare's Pages Function uses _routes.json
// to serve those exact URLs; Docker and self-hosters can serve the same static
// siblings directly. Already-compressed formats (woff2, png, zip) fail the
// savings bar and stay on the ordinary static path. Mutable root files (such
// as index.html, the service worker, and changelog.json) stay off this path.
const PAGES_BROTLI_MIN_SAVINGS = 0.02;
// Pages limits _routes.json to 100 include/exclude entries; identify assets
// share one wildcard route to stay within that limit.
const PAGES_ROUTES_MAX_INCLUDES = 100;

const writeBrotliSidecars = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      const assetsDir = path.join(distDir, "assets");
      const allWasmNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".wasm"));
      const wasmNames = allWasmNames.filter((name) => name.startsWith("rom-weaver-app-"));
      if (wasmNames.length !== 1) {
        throw new Error(
          `expected exactly one rom-weaver app WASM asset in ${assetsDir}, found: ${wasmNames.join(", ") || "none"}`,
        );
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
      // Packs and cheat shards are staged as `.br`-only sidecars, all under one
      // wildcard include; each still needs a known content type.
      const identifySidecars = fs
        .readdirSync(assetsDir)
        .filter((name) => name.startsWith("identify-") && (name.endsWith(".pack.br") || name.endsWith(".json.br")));
      if (identifySidecars.length > 0) {
        for (const name of identifySidecars) assertSidecarTypeIsKnown(`/assets/${name.slice(0, -3)}`);
        sidecarUrls.push("/assets/identify-*");
      }
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
        // Every identify asset rides the one wildcard include staged above. An exact
        // entry per pack, shard, and manifest would be redundant and eat the budget
        // asserted below.
        const route = name.startsWith("identify-") ? "/assets/identify-*" : `/assets/${name}`;
        if (!sidecarUrls.includes(route)) sidecarUrls.push(route);
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
  // No route segment is the app base itself, which serves the landing page.
  if (!slug) return { docsSlug: "docs", view: "home" };
  const routeSlug = slug.replace(/\.html$/, "");
  const canonical = Object.hasOwn(LEGACY_WORKFLOW_ROUTES, routeSlug) ? LEGACY_WORKFLOW_ROUTES[routeSlug] : routeSlug;
  const view = Object.entries(WORKFLOW_SEO_ROUTES).find(([, route]) => route.slug === canonical)?.[0] ?? "patcher";
  return { docsSlug: "docs", view };
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
      await buildShellLoomScript();
      // Dev reuses the running dev server's SSR loader (no second Vite server
      // per request) so the shell - and its prerender->mount handoff - matches
      // production locally. Build renders the creator variant too, which
      // writeWebappStaticAssets emits as a second static entry point.
      if (ctx.server) {
        const route = devPrerenderRoute(ctx.originalUrl ?? ctx.path);
        const shell = await prerender.renderLandingShellWithServer(ctx.server, route.view, false, route.docsSlug);
        if (route.view === "home") assertShellLoomCanvas(shell);
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
      const homeShell = await prerender.withPrerenderServer(async (server) => {
        const render = (view, notFound, docsSlug) =>
          prerender.renderLandingShellWithServer(server, view, notFound, docsSlug);
        prerenderedShells.set("home", await render("home"));
        assertShellLoomCanvas(prerenderedShells.get("home"));
        prerenderedShells.set("patcher", await render("patcher"));
        prerenderedShells.set("creator", await render("creator"));
        prerenderedShells.set("identify", await render("identify"));
        prerenderedShells.set("test", await render("test"));
        prerenderedShells.set("notFound", await render("patcher", true));
        for (const route of DOC_ROUTES) {
          prerenderedShells.set(route.slug, await render("docs", false, route.slug));
        }
        return prerenderedShells.get("home");
      });
      // index.html is served at the apex, so it carries the landing shell; every
      // other route page is derived from it by swapping that root out.
      return html.replace(PRERENDER_MOUNT_POINT, PRERENDER_ROOT(homeShell));
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
// Markers let writeWebappStaticAssets replace the landing page's preload set
// with the set for each derived route document.
const ROUTE_PRELOAD_MARKER_START = "<!--rw-route-preload-->";
const ROUTE_PRELOAD_MARKER_END = "<!--/rw-route-preload-->";

const WORKFLOW_ROUTE_MODULES = {
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
const WORKER_OR_URL_IMPORT_FILTER = /[?&](?:worker|url)(?:&|$)/;

// Filled by the plugin below with the absolute path of every emitted worker
// entry, so the chunk grouping can tell worker-only modules from app modules.
const workerEntryFiles = new Set();
/** Memoized worker graph classifications; the module graph is rebuilt per build. */
const workerModuleKinds = new Map();

const shareWorkerRuntimeChunks = () => {
  const chunkRefs = new Map();
  return {
    apply: "build",
    buildStart() {
      chunkRefs.clear();
      workerEntryFiles.clear();
      workerModuleKinds.clear();
    },
    enforce: "pre",
    load: {
      filter: { id: WORKER_OR_URL_IMPORT_FILTER },
      handler(id) {
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
    },
    name: "rom-weaver-share-worker-runtime-chunks",
  };
};

// Classify worker reachability and whether document code can also reach a module.
// Directory names alone cannot distinguish shared helpers from worker-only code.
const classifyWorkerModule = (moduleId, ctx) => {
  const cached = workerModuleKinds.get(moduleId);
  if (cached) return cached;
  const visited = new Set([moduleId]);
  const pending = [moduleId];
  let workerOnly = true;
  let workerReachable = false;
  while (pending.length > 0 && !(workerReachable && !workerOnly)) {
    const id = pending.pop();
    // Only the bare path is the worker entry; the `?worker&url` module of the same file is the
    // URL stub the app imports, and its own importers decide where it belongs.
    if (workerEntryFiles.has(id)) {
      workerReachable = true;
      continue;
    }
    const info = ctx.getModuleInfo(id);
    if (!info || (info.importers.length === 0 && info.dynamicImporters.length === 0)) {
      workerOnly = false;
      continue;
    }
    for (const importer of [...info.importers, ...info.dynamicImporters]) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      pending.push(importer);
    }
  }
  const result = { workerOnly, workerReachable };
  workerModuleKinds.set(moduleId, result);
  return result;
};

const isWorkerOnlyModule = (moduleId, ctx) => classifyWorkerModule(moduleId, ctx).workerOnly;

// True when at least one import path reaching this module starts at a worker
// entry. `isWorkerOnlyModule` above answers the stricter question; this one
// catches the modules a worker and the document both use, which is what decides
// whether a worker has to download the document's chunk to reach them.
const isWorkerReachableModule = (moduleId, ctx) => {
  return classifyWorkerModule(moduleId, ctx).workerReachable;
};

/** Everything a worker can reach that is not worker-only: the overlap between a
 * worker's graph and the document's. Without a chunk of its own it lands in
 * `shared`, and since a chunk is the unit of loading, an 8 kB thread worker then
 * pulls the whole document chunk - React and all - into every worker realm. */
const nameWorkerSharedGroup = (moduleId, ctx) => (isWorkerReachableModule(moduleId, ctx) ? "worker-shared" : null);

/**
 * Group worker-only modules before the worker-shared and general shared groups.
 * includeDependenciesRecursively MUST stay off to keep app-facing dependencies separate.
 */
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
  const versionBranch = getVersionBranch(gitBranch, versionIsTagged);
  // An unset channel builds as production; dev and preview set their own default.
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
      manifest: true,
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
          codeSplitting: {
            groups: [
              { includeDependenciesRecursively: false, minShareCount: 2, name: nameWorkerRuntimeGroup, priority: 2 },
              { includeDependenciesRecursively: false, minShareCount: 2, name: nameWorkerSharedGroup, priority: 1 },
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
      __EMULATORJS_VERSION__: JSON.stringify(emulatorJsLock.version),
      __IDENTIFY_MANIFEST_FILES__: JSON.stringify(identifyManifestFiles),
      __IDENTIFY_OPTIONAL_PACK_GROUPS__: JSON.stringify(identifyOptionalPackGroups),
      __GIT_BRANCH__: JSON.stringify(gitBranch),
      __VERSION_BRANCH__: JSON.stringify(versionBranch),
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
      compileLinguiCatalogs(),
      docsVirtualModule(DOC_ROUTES),
      shareWorkerRuntimeChunks(),
      serveRootStaticAssets(appChannel, appChannelLabel),
      serveEmulatorJsAssets(),
      serveChangelogAsset(releaseVersion),
      deferDevHotUpdates(),
      stampChannelIdentity(appChannel, appChannelLabel, serviceWorkerEnabled),
      react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
      prerenderWebappShell(prerenderedShells),
      preloadWorkflowRouteChunks(routePreloadLinks),
      writeWebappStaticAssets(appChannel, appChannelLabel, prerenderedShells, routePreloadLinks),
      writeChangelogAsset(releaseVersion),
      minifyDocumentInlineScripts(),
      writeCloudflareHeadersAsset(appChannel),
      writeBrotliSidecars(),
      VitePWA({
        devOptions: {
          disableRuntimeConfig: true,
          enabled: devServiceWorkerEnabled,
          type: "module",
        },
        filename: "rom-weaver-service-worker.ts",
        injectManifest: {
          // Manifest revisions track precached shell assets; identify packs load
          // through background warm-up or on demand, outside the precache.
          manifestTransforms: [revisionUnhashedAssets(), preparePrecacheEntries(), writePrecacheSizes()],
          // The checksum router and the title index are warm-up data like the
          // packs, so neither the raw files nor their brotli sidecars join the
          // precache.
          globIgnores: [
            "**/*.map",
            "assets/identify-*.pack.br",
            "assets/identify-*.bin",
            "assets/identify-*.bin.br",
            "assets/identify-cheats-*.json.br",
            "assets/identify-title-index.json",
            "assets/identify-title-index.json.br",
          ],
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
            "assets/**/*.{css,js,mjs,json,png,svg,jpg,jpeg,webp,woff2,wasm}",
            "icon-maskable-192.png",
            "icon-maskable-512.png",
          ],
          // Large WASM entries MUST remain in the deferred manifest for the offline installer.
          maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
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
      preserveSymlinks: false,
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
