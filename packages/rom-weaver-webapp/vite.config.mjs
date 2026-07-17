import crypto from "node:crypto";
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
const rootStaticAssetSources = {
  "/CNAME": path.join(rootDir, "src", "assets", "app", "root", "CNAME"),
  "/apple-touch-icon.png": path.join(rootDir, "src", "assets", "app", "root", "apple-touch-icon.png"),
  "/favicon.ico": path.join(rootDir, "src", "assets", "app", "root", "favicon.ico"),
  "/icon-maskable-192.png": path.join(rootDir, "src", "assets", "app", "root", "icon-maskable-192.png"),
  "/icon-maskable-512.png": path.join(rootDir, "src", "assets", "app", "root", "icon-maskable-512.png"),
  "/logo.svg": path.join(rootDir, "src", "assets", "app", "root", "logo.svg"),
  "/manifest.json": rootManifestSourcePath,
};
const brotliAssetExtensions = new Set([".css", ".html", ".js", ".json", ".mjs", ".svg", ".wasm"]);
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
  else if (requestPath.endsWith(".webp")) res.setHeader("Content-Type", "image/webp");
  else if (requestPath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  else if (requestPath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
};

const applyRootStaticAssetMiddleware = (middlewares) => {
  middlewares.use((req, res, next) => {
    const requestPath = req.url ? req.url.split("?")[0] : "";
    const sourcePath = rootStaticAssetSources[requestPath];
    if (!sourcePath) {
      next();
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

const serveRootStaticAssets = () => ({
  apply: "serve",
  configurePreviewServer(server) {
    applyRootStaticAssetMiddleware(server.middlewares);
  },
  configureServer(server) {
    applyRootStaticAssetMiddleware(server.middlewares);
  },
  name: "rom-weaver-root-static-assets",
});

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

const sha256File = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

const packagedBrotliPathForDistAsset = (filePath) => {
  if (path.extname(filePath) !== ".wasm") return null;
  if (!(fs.existsSync(packagedWasmPath) && fs.existsSync(packagedWasmBrotliPath))) return null;
  if (sha256File(filePath) !== sha256File(packagedWasmPath)) return null;
  // The prebuilt `.br` sibling exists only to skip the slow quality-11 compress of the ~6 MB wasm. But
  // it is a gitignored build artifact that can lag the wasm (e.g. the wasm is rebuilt - gaining a new
  // command - without regenerating its `.br`). Shipping a stale `.br` serves an OUTDATED wasm to every
  // brotli-capable browser (i.e. all of them) while the raw `.wasm` is current - silently breaking the
  // app in prod even though dev (raw wasm) works. Verify the sibling decodes back to the wasm; if it is
  // stale or corrupt, fall through to compress the real asset.
  try {
    const decoded = zlib.brotliDecompressSync(fs.readFileSync(packagedWasmBrotliPath));
    if (!decoded.equals(fs.readFileSync(packagedWasmPath))) return null;
  } catch {
    return null;
  }
  return packagedWasmBrotliPath;
};

const writeBrotliAsset = (filePath) => {
  const brotliPath = `${filePath}.br`;
  const precompressedPath = packagedBrotliPathForDistAsset(filePath);
  if (precompressedPath) {
    copyFile(precompressedPath, brotliPath);
    return;
  }

  const source = fs.readFileSync(filePath);
  const compressed = zlib.brotliCompressSync(source, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  if (compressed.byteLength >= source.byteLength) return;
  fs.writeFileSync(brotliPath, compressed);
};

const writeBrotliAssetsInDirectory = (directory) => {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      writeBrotliAssetsInDirectory(filePath);
      continue;
    }
    if (entry.name.endsWith(".br")) continue;
    if (!brotliAssetExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    writeBrotliAsset(filePath);
  }
};

const createRootManifestSource = () =>
  fs.readFileSync(rootManifestSourcePath, "utf8").replace(/"src\/assets\/app\//g, '"assets/app/');

const writeWebappStaticAssets = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(rootDir, outDir);
      for (const assetPath of Object.keys(rootStaticAssetSources)) {
        const outputPath = path.join(distDir, assetPath);
        if (assetPath === "/manifest.json") {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, createRootManifestSource());
          continue;
        }
        copyFile(rootStaticAssetSources[assetPath], outputPath);
      }
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

const writePreviewBrotliAssets = () => {
  let outDir = "dist";
  return {
    apply: "build",
    closeBundle() {
      writeBrotliAssetsInDirectory(path.resolve(rootDir, outDir));
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-preview-brotli-assets",
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
      serveRootStaticAssets(),
      serveChangelogAsset(),
      deferDevHotUpdates(),
      react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
      writeWebappStaticAssets(),
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
            "favicon.ico",
            "apple-touch-icon.png",
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
      ...(mode === "docker" ? [writePreviewBrotliAssets()] : []),
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
