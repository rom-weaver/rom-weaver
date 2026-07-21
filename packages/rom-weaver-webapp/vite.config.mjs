import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { getBuildInfo, getChangelog } from "./scripts/version.mjs";

const rootDir = process.cwd();
const repoRoot = path.resolve(rootDir, "../..");

const rootManifestSourcePath = path.join(rootDir, "src", "assets", "app", "root", "manifest.json");
const packagedWasmPath = path.join(rootDir, "src", "wasm", "rom-weaver-app.wasm");
const packagedWasmBrotliPath = `${packagedWasmPath}.br`;
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
});
const generatedLicenseAssetSources = {
  "/NOTICE": path.join(rootDir, "src", "wasm", "NOTICE"),
  "/THIRD_PARTY_LICENSES.md": path.join(rootDir, "src", "wasm", "THIRD_PARTY_LICENSES.md"),
};
const compressibleAssetExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".svg", ".wasm"]);
const securityHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
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

const suppressNestedWorkerFactoryBundling = () => {
  const workerFactoriesPath = path.join(rootDir, "src", "workers", "protocol", "worker-factories.ts");
  const nestedWorkerPattern = /new Worker\(\s*new URL\(/g;
  return {
    apply: "build",
    enforce: "pre",
    name: "rom-weaver-suppress-nested-worker-factory-bundling",
    transform(code, id) {
      const filePath = id.split("?")[0];
      if (path.normalize(filePath) !== workerFactoriesPath) return null;
      if (!nestedWorkerPattern.test(code)) return null;
      nestedWorkerPattern.lastIndex = 0;
      return {
        code: code.replace(nestedWorkerPattern, "new Worker(new URL(/* @vite-ignore */ "),
        map: null,
      };
    },
  };
};

const setRootStaticAssetContentType = (requestPath, res) => {
  if (requestPath.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
  else if (requestPath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
  else if (requestPath.endsWith(".zip")) res.setHeader("Content-Type", "application/zip");
  else if (requestPath.endsWith(".webp")) res.setHeader("Content-Type", "image/webp");
  else if (requestPath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  else if (requestPath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
  else if (requestPath.endsWith(".md") || requestPath.endsWith("/NOTICE")) {
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

// The prebuilt `.br` sibling exists only to skip the slow quality-11 compress of the ~6 MB wasm, and
// it is a gitignored artifact that can lag the wasm it was built from. Shipping a stale one would
// serve an OUTDATED wasm to every brotli-capable browser while the raw `.wasm` is current. Decoding
// costs milliseconds against the tens of seconds it saves, so just verify it round-trips to the exact
// bytes being emitted; anything stale or corrupt falls through to compressing the real asset.
const packagedBrotliPathForDistAsset = (filePath) => {
  if (path.extname(filePath) !== ".wasm") return null;
  if (!fs.existsSync(packagedWasmBrotliPath)) return null;
  try {
    const decoded = zlib.brotliDecompressSync(fs.readFileSync(packagedWasmBrotliPath));
    return decoded.equals(fs.readFileSync(filePath)) ? packagedWasmBrotliPath : null;
  } catch {
    return null;
  }
};

// A sibling that did not actually shrink would cost a request its own bytes, so
// only keep one that beats the original.
const writeSiblingIfSmaller = (siblingPath, compressed, source) => {
  if (compressed.byteLength >= source.byteLength) return;
  fs.writeFileSync(siblingPath, compressed);
};

// Both siblings are required: `compression-static` in sws.toml serves whichever
// encoding the client asked for and falls back to the raw file, so shipping only
// `.br` silently sends uncompressed bytes to any gzip-only client.
const writeCompressedAssets = (filePath) => {
  const source = fs.readFileSync(filePath);

  const precompressedPath = packagedBrotliPathForDistAsset(filePath);
  if (precompressedPath) {
    copyFile(precompressedPath, `${filePath}.br`);
  } else {
    writeSiblingIfSmaller(
      `${filePath}.br`,
      zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }),
      source,
    );
  }

  writeSiblingIfSmaller(`${filePath}.gz`, zlib.gzipSync(source, { level: 9 }), source);
};

const writeCompressedAssetsInDirectory = (directory) => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      writeCompressedAssetsInDirectory(filePath);
      continue;
    }
    if (entry.name.endsWith(".br") || entry.name.endsWith(".gz")) continue;
    if (!compressibleAssetExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    writeCompressedAssets(filePath);
  }
};

const APP_CHANNELS = new Set(["prod", "beta", "nightly", "preview", "dev"]);

// An unset channel is a local build or the dev server. Production is only ever
// reached by CI passing it explicitly, so a typo degrades to "dev" (marked)
// rather than silently impersonating production (unmarked).
const resolveAppChannel = (value) => {
  const channel = String(value || "").trim();
  if (!channel) return "dev";
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

// The tab title and the iOS home-screen label are the two places the channel has
// to show up before the bundle has even booted.
const stampChannelIdentity = (channel, channelLabel) => ({
  name: "rom-weaver-channel-identity",
  transformIndexHtml: {
    handler(html) {
      if (channel === "prod") return html;
      return html
        .replace("<title>rom-weaver</title>", `<title>rom-weaver ${channelLabel}</title>`)
        .replace(/(<meta name="apple-mobile-web-app-title" content=")([^"]*)(")/, `$1$2 ${channelLabel}$3`);
    },
    order: "pre",
  },
});

const writeWebappStaticAssets = (channel, channelLabel) => {
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
      fs.cpSync(path.join(rootDir, "src", "wasm", "third_party"), path.join(distDir, "third_party"), {
        recursive: true,
      });
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-static-assets",
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

const writeStaticCompressedAssets = () => {
  let outDir = "dist";
  return {
    apply: "build",
    // Must stay `post`: vite-plugin-pwa emits cache-service-worker.js from its
    // own closeBundle, so without this the walker runs first and the service
    // worker is the one asset shipped uncompressed.
    enforce: "post",
    closeBundle() {
      writeCompressedAssetsInDirectory(path.resolve(rootDir, outDir));
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-static-compressed-assets",
  };
};

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

export default defineConfig(({ command, mode }) => {
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
        "lucide-react/dist/esm/icons/github.js",
        "lucide-react/dist/esm/icons/heart.js",
        "lucide-react/dist/esm/icons/refresh-cw.js",
        "lucide-react/dist/esm/icons/rotate-ccw.js",
        "lucide-react/dist/esm/icons/save.js",
        "lucide-react/dist/esm/icons/settings.js",
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
      writeWebappStaticAssets(appChannel, appChannelLabel),
      writeChangelogAsset(),
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
      // `selfhost`, not `docker`: the container and the static release tarball
      // are one bundle now, and both are served by a static server that reads
      // precompressed siblings rather than a CDN that compresses on the fly.
      ...(mode === "selfhost" ? [writeStaticCompressedAssets()] : []),
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
      plugins: () => [suppressNestedWorkerFactoryBundling()],
    },
  };
});
