import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { dedupeTree } from "../../scripts/dedupe-tree.mjs";
import { brotliCompressFile } from "../../scripts/wasm/brotli-compress.mjs";
import { getBuildInfo, getChangelog } from "./scripts/version.mjs";
import { WORKFLOW_SEO_ROUTES } from "./src/webapp/workflow-seo.mjs";

const rootDir = process.cwd();
const repoRoot = path.resolve(rootDir, "../..");

const rootManifestSourcePath = path.join(rootDir, "src", "assets", "app", "root", "manifest.json");
const rootAssetDir = path.join(rootDir, "src", "assets", "app", "root");

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
  "/create-modified.bin": path.join(rootAssetDir, "create-modified.bin"),
  "/create-original.bin": path.join(rootAssetDir, "create-original.bin"),
  "/favicon.ico": channelAssetPath(channel, "favicon.ico"),
  "/first-weave.zip": path.join(rootAssetDir, "first-weave.zip"),
  "/icon-maskable-192.png": channelAssetPath(channel, "icon-maskable-192.png"),
  "/icon-maskable-512.png": channelAssetPath(channel, "icon-maskable-512.png"),
  "/logo.svg": channelAssetPath(channel, "logo.svg"),
  "/manifest.json": rootManifestSourcePath,
  "/social-preview.png": path.join(rootDir, "design", "social-preview.png"),
});
const generatedLicenseAssetSources = {
  "/NOTICE": path.join(rootDir, "src", "wasm", "NOTICE"),
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
  if (requestPath.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
  else if (requestPath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
  else if (requestPath.endsWith(".zip")) res.setHeader("Content-Type", "application/zip");
  else if (requestPath.endsWith(".webp")) res.setHeader("Content-Type", "image/webp");
  else if (requestPath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  else if (requestPath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
  else if (requestPath.endsWith("/NOTICE")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
};

const applyRootStaticAssetMiddleware = (middlewares, channel, channelLabel) => {
  const rootStaticAssetSources = rootStaticAssetSourcesForChannel(channel);
  middlewares.use((req, res, next) => {
    const requestPath = req.url ? req.url.split("?")[0] : "";
    const sourcePath = rootStaticAssetSources[requestPath] ?? generatedLicenseAssetSources[requestPath];
    if (!sourcePath) {
      next();
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
  const title = channel === "prod" ? route.title : route.title.replace("RomWeaver", `RomWeaver ${channelLabel}`);
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

// SoftwareApplication structured data lets search engines render a rich result
// for a free browser tool. Injected per indexable route with that route's
// canonical URL and description; the price/offer marks it explicitly free.
const createSoftwareApplicationLdJson = (route) => {
  const data = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "UtilitiesApplication",
    description: route.description,
    name: "RomWeaver",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    operatingSystem: "Web browser",
    url: `https://rom-weaver.com/${route.slug}`,
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
};

const injectLdJson = (html, route) => html.replace("</head>", `  ${createSoftwareApplicationLdJson(route)}\n  </head>`);

// The Trim and Tools tabs are still beta - they navigate in production but must
// not be indexed, and they inherit the Weave page's markup, so strip the shared
// index directive to noindex and point their canonical at themselves (rather
// than leaking a /weave canonical that would fold them into the patcher page).
const makeBetaRouteNoindex = (html, slug) =>
  html
    .replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />')
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1https://rom-weaver.com/${slug}$2`);

const createSitemapSource = () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://rom-weaver.com/weave</loc></url>
  <url><loc>https://rom-weaver.com/create</loc></url>
</urlset>
`;

// The tab title and the iOS home-screen label are the two places the channel has
// to show up before the bundle has even booted. Non-production deployments also
// opt out of indexing here; the deployed response repeats the policy as a header.
const stampChannelIdentity = (channel, channelLabel) => ({
  name: "rom-weaver-channel-identity",
  transformIndexHtml: {
    handler(html) {
      const accent = CHANNEL_DEFAULT_ACCENTS[channel] || CHANNEL_DEFAULT_ACCENTS.dev;
      const stampedHtml = accent === "madder" ? html : html.replace("<html ", `<html data-accent="${accent}" `);
      if (channel === "prod") return stampedHtml;
      return stampedHtml
        .replace("<title>RomWeaver", `<title>RomWeaver ${channelLabel}`)
        .replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />')
        .replace(/(<meta name="apple-mobile-web-app-title" content=")([^"]*)(")/, `$1$2 ${channelLabel}$3`);
    },
    order: "pre",
  },
});

const PRERENDER_ROOT = (shell) => `<div id="webapp-root" aria-busy="true">${shell}</div>`;

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
      for (const [assetPath, sourcePath] of Object.entries(generatedLicenseAssetSources)) {
        copyFile(sourcePath, path.join(distDir, assetPath));
      }
      const indexHtml = fs.readFileSync(path.join(distDir, "index.html"), "utf8");
      const patcherRoot = PRERENDER_ROOT(prerenderedShells.get("patcher"));
      if (!indexHtml.includes(patcherRoot))
        throw new Error("rom-weaver-static-assets: prerendered patcher shell not found in dist/index.html");
      // dist/index.html is served at the apex (the patcher); give it the same
      // SoftwareApplication markup the /weave route gets.
      const weaveHtml = injectLdJson(indexHtml, WORKFLOW_SEO_ROUTES.patcher);
      fs.writeFileSync(path.join(distDir, "index.html"), weaveHtml);
      const creatorHtml = withRoutePreloadLinks(
        indexHtml.replace(patcherRoot, PRERENDER_ROOT(prerenderedShells.get("creator"))),
        routePreloadLinks.get("creator"),
      );
      const createHtml = injectLdJson(
        createWorkflowRouteHtml(creatorHtml, WORKFLOW_SEO_ROUTES.creator, channel, channelLabel),
        WORKFLOW_SEO_ROUTES.creator,
      );
      fs.writeFileSync(path.join(distDir, "create.html"), createHtml);
      for (const [slug, html] of [
        ["weave", weaveHtml],
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

// Cloudflare Pages serves dist/_headers on every response, so deployed pages are cross-origin
// isolated from the first network load instead of round-tripping through the service worker's
// COEP-injection reload. Hosts without header control still use the service-worker fallback.
// Emitted at the dist root, which keeps it out of the SW precache globs.
const writeCloudflareHeadersAsset = (channel) => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const headers =
        channel === "prod"
          ? crossOriginIsolationHeaders
          : { ...crossOriginIsolationHeaders, "X-Robots-Tag": "noindex, nofollow" };
      const headerLines = Object.entries(headers)
        .map(([name, value]) => `  ${name}: ${value}`)
        .join("\n");
      const outputPath = path.join(path.resolve(rootDir, outDir), "_headers");
      // The attribution files are named `LICENSE-APACHE`, `COPYING`, `NOTICE`
      // and so on. With no extension Cloudflare types them as a binary
      // download, which both skips its on-the-fly compression (2.1 MB of text
      // over the wire) and makes a browser download rather than display them.
      const licenseContentType =
        "/third_party/licenses/*\n  Content-Type: text/plain; charset=utf-8\n\n/NOTICE\n  Content-Type: text/plain; charset=utf-8\n";
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

// Deploy-only (ROM_WEAVER_PAGES_BROTLI=1): stage quality-11 brotli sidecars
// for every hashed asset where q11 measurably beats Cloudflare's on-the-fly
// recompression (~640 KB on the wasm, ~50 KB on the main JS bundle), and
// write a _routes.json scoping Pages Function invocation
// (functions/assets/[name].js) to exactly the sidecar-backed URLs. The wasm
// sidecar is the prebuilt artifact, byte-verified against the emitted asset;
// everything else is compressed here and kept only when it saves >=2% -
// already-compressed formats (woff2, png, zip) fail that bar and stay on the
// static path. Only /assets/* is eligible: those URLs are content-hashed and
// immutable, while the mutable root files (index.html, the service worker,
// changelog.json) must keep their no-cache semantics and never route through
// the function's immutable-cache response. Off in plain builds on purpose:
// the release tarball asserts dist holds no compression sidecars (the Docker
// image generates its own), and unmatched routes must stay on Pages'
// unmetered static path.
const PAGES_BROTLI_MIN_SAVINGS = 0.02;
// _routes.json rejects more than 100 combined include/exclude entries; leave
// headroom so an asset-count creep fails the build before Cloudflare does.
const PAGES_ROUTES_MAX_INCLUDES = 90;

const writePagesBrotliSidecars = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      if (process.env.ROM_WEAVER_PAGES_BROTLI !== "1") return;
      const distDir = path.resolve(rootDir, outDir);
      const assetsDir = path.join(distDir, "assets");
      const wasmNames = fs.readdirSync(assetsDir).filter((name) => name.endsWith(".wasm"));
      if (wasmNames.length !== 1) {
        throw new Error(`expected exactly one .wasm asset in ${assetsDir}, found: ${wasmNames.join(", ") || "none"}`);
      }
      const sourceWasm = path.join(rootDir, "src", "wasm", "rom-weaver-app.wasm");
      const sourceSidecar = `${sourceWasm}.br`;
      if (!fs.existsSync(sourceSidecar)) {
        throw new Error(
          `ROM_WEAVER_PAGES_BROTLI=1 but ${sourceSidecar} is missing; build the prod wasm artifact first`,
        );
      }
      const emittedWasm = path.join(assetsDir, wasmNames[0]);
      if (!fs.readFileSync(emittedWasm).equals(fs.readFileSync(sourceWasm))) {
        throw new Error(`${emittedWasm} does not match ${sourceWasm}; refusing to stage a mismatched brotli sidecar`);
      }
      fs.copyFileSync(sourceSidecar, `${emittedWasm}.br`);
      const sidecarUrls = [`/assets/${wasmNames[0]}`];
      for (const name of fs.readdirSync(assetsDir)) {
        if (name.endsWith(".wasm") || name.endsWith(".br")) continue;
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
    name: "rom-weaver-pages-brotli-sidecars",
  };
};

// The "What's new" changelog, emitted at the dist root so it stays OUT of the SW
// precache globs (assets/** + named files only). The client fetches it with
// cache: "no-store", so a pending update surfaces the NEW deploy's log rather
// than the stale precached copy the running (old) bundle shipped with.
const CHANGELOG_ASSET_URL = "/changelog.json";

const serveChangelogAsset = () => {
  const middleware = (req, res, next) => {
    if ((req.url ? req.url.split("?")[0] : "") !== CHANGELOG_ASSET_URL) {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(getChangelog()));
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

const writeChangelogAsset = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const outputPath = path.join(path.resolve(rootDir, outDir), "changelog.json");
      fs.writeFileSync(outputPath, JSON.stringify(getChangelog()));
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
// to drift. The client keeps createRoot and replaces the shell on first mount.
const PRERENDER_MOUNT_POINT = '<div id="webapp-root" aria-busy="true"></div>';

// Which prerendered variant a dev request gets, mirroring readWorkflowViewFromPath
// in webapp-controller.ts: the last path segment picks the workflow. Only the
// creator has a shell of its own (the build emits create.html and
// create/index.html from it); trim and tools inherit the patcher markup, exactly
// as writeWebappStaticAssets emits them.
const devPrerenderView = (url) => {
  const segments = String(url || "")
    .split(/[?#]/)[0]
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  const slug = segments.at(-1) || "";
  return slug === "create" || slug === "create.html" ? "creator" : "patcher";
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
        const view = devPrerenderView(ctx.originalUrl ?? ctx.path);
        const shell = await prerender.renderLandingShellWithServer(ctx.server, view);
        // Production ships the bundled CSS as a render-blocking <link>, so its
        // prerendered shell paints styled. Dev serves CSS as HMR'd JS modules
        // that only apply after the bundle runs, which would flash the shell
        // unstyled. Inject the same stylesheets render-blocking (Vite serves
        // ?direct as real text/css) - order mirrors vite-entry.ts's imports.
        // These links are outside the module graph, so a CSS edit only reaches
        // them on a full reload; until then the HMR'd <style> (appended after
        // them, so it wins) carries the change and a *deleted* rule lingers.
        return {
          html: html.replace(PRERENDER_MOUNT_POINT, PRERENDER_ROOT(shell)),
          tags: ["/src/webapp/style.css", "/src/webapp/design-system/index.css"].map((href) => ({
            attrs: { href: `${href}?direct`, rel: "stylesheet" },
            injectTo: "head",
            tag: "link",
          })),
        };
      }
      const patcherShell = await prerender.renderLandingShell("patcher");
      const creatorShell = await prerender.renderLandingShell("creator");
      prerenderedShells.set("patcher", patcherShell);
      prerenderedShells.set("creator", creatorShell);
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
      for (const [view, moduleSuffix] of Object.entries(WORKFLOW_ROUTE_MODULES)) {
        const routeChunk = findChunkForModule(bundle, moduleSuffix);
        if (!routeChunk)
          throw new Error(`rom-weaver-preload-workflow-route-chunks: no chunk emitted for ${moduleSuffix}`);
        const routeFiles = [...collectStaticImportClosure(bundle, [routeChunk])]
          .filter((fileName) => !alreadyLoaded.has(fileName))
          .sort();
        routePreloadLinks.set(view, renderRoutePreloadLinks(routeFiles));
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

// Primary (latin) Archivo woff2 - but not the latin-ext subset, which is only
// fetched on demand via unicode-range and is wasteful to preload eagerly.
const PRIMARY_FONT_PATTERN = /^assets\/archivo-var-latin-(?!ext-)[\w-]+\.woff2$/;

// Preload the primary UI font from the document head so its download starts
// alongside the HTML instead of waiting for the stylesheet to parse and discover
// the @font-face. Build-only: the file name is content-hashed, so the hashed
// name is read out of the emitted bundle at generate time.
const preloadPrimaryFont = () => ({
  apply: "build",
  name: "rom-weaver-preload-primary-font",
  transformIndexHtml: {
    handler(_html, ctx) {
      const fileName = ctx.bundle && Object.keys(ctx.bundle).find((key) => PRIMARY_FONT_PATTERN.test(key));
      if (!fileName) return [];
      return [
        {
          attrs: { as: "font", crossorigin: "", href: `./${fileName}`, rel: "preload", type: "font/woff2" },
          injectTo: "head-prepend",
          tag: "link",
        },
      ];
    },
    order: "post",
  },
});

export default defineConfig(({ command }) => {
  const buildInfo = getBuildInfo();
  const devServiceWorkerEnabled = process.env.VITE_SW_DEV === "1";
  const serviceWorkerEnabled = command === "build" || devServiceWorkerEnabled;
  const appVersion =
    process.env.ROM_WEAVER_APP_VERSION || buildInfo.version || process.env.npm_package_version || "0.1.0";
  const commitHash = process.env.ROM_WEAVER_COMMIT_HASH || buildInfo.commitHash || "unknown";
  const dirtyHash = process.env.ROM_WEAVER_DIRTY_HASH ?? buildInfo.dirtyHash ?? "";
  const gitBranch = process.env.ROM_WEAVER_GIT_BRANCH ?? buildInfo.gitBranch ?? "";
  const versionIsTagged = (buildInfo.isVersionTag ?? false) && !dirtyHash;
  // CI's deploy job already resolves which origin this bundle is headed for;
  // an unset channel means a local build or dev server, never production.
  const appChannel = resolveAppChannel(process.env.ROM_WEAVER_CHANNEL);
  const appChannelLabel = process.env.ROM_WEAVER_CHANNEL_LABEL || appChannel;
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
      },
      target: "es2022",
    },
    clearScreen: false,
    css: {
      transformer: "lightningcss",
    },
    define: {
      __APP_CHANNEL__: JSON.stringify(appChannel),
      __APP_CHANNEL_LABEL__: JSON.stringify(appChannelLabel),
      __APP_VERSION__: JSON.stringify(appVersion),
      __COMMIT_HASH__: JSON.stringify(commitHash),
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
        "valibot",
      ],
    },
    plugins: [
      serveRootStaticAssets(appChannel, appChannelLabel),
      serveChangelogAsset(),
      deferDevHotUpdates(),
      stampChannelIdentity(appChannel, appChannelLabel),
      react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
      prerenderWebappShell(prerenderedShells),
      preloadWorkflowRouteChunks(routePreloadLinks),
      writeWebappStaticAssets(appChannel, appChannelLabel, prerenderedShells, routePreloadLinks),
      writeChangelogAsset(),
      writeCloudflareHeadersAsset(appChannel),
      writePagesBrotliSidecars(),
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
            "index.html",
            "manifest.json",
            "logo.svg",
            "first-weave.zip",
            "favicon.ico",
            "apple-touch-icon.png",
            "create-modified.bin",
            "create-original.bin",
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
      preloadPrimaryFont(),
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
