import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { getBuildInfo } from "./scripts/version.mjs";

const rootDir = process.cwd();
const repoRoot = path.resolve(rootDir, "../..");
const rootManifestSourcePath = path.join(rootDir, "src", "assets", "app", "root", "manifest.json");
const rootStaticAssetSources = {
  "/apple-touch-icon-precomposed.png": path.join(
    rootDir,
    "src",
    "assets",
    "app",
    "root",
    "apple-touch-icon-precomposed.png",
  ),
  "/apple-touch-icon.png": path.join(rootDir, "src", "assets", "app", "root", "apple-touch-icon.png"),
  "/favicon.ico": path.join(rootDir, "src", "assets", "app", "root", "favicon.ico"),
  "/logo.svg": path.join(rootDir, "src", "assets", "app", "logo.svg"),
  "/manifest.json": rootManifestSourcePath,
};
const staticAppAssetSourceDir = path.join(rootDir, "src", "assets", "app");
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
  "../rom-weaver-wasm/*.wasm",
  "../rom-weaver-wasm/*.wasm.br",
  path.join(os.tmpdir(), "rpjs-vfs*").replace(/\\/g, "/"),
];

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

const serveRootStaticAssets = () => ({
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
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
        if (requestPath.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
        else if (requestPath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
        else if (requestPath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
        else if (requestPath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
        res.setHeader("Cache-Control", "no-cache");
        res.end(source);
      });
    });
  },
  name: "rom-weaver-root-static-assets",
});

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

const copyDirectory = (from, to, filter) => {
  if (!fs.existsSync(from)) return;
  const entries = fs.readdirSync(from, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(from, entry.name);
    const targetPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath, filter);
    } else if (!filter || filter(sourcePath)) {
      copyFile(sourcePath, targetPath);
    }
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
      copyDirectory(
        staticAppAssetSourceDir,
        path.join(distDir, "assets", "app"),
        (filePath) => /\.(png|svg|jpe?g|webp)$/i.test(filePath) && !/[/\\]root[/\\]/.test(filePath),
      );
    },
    configResolved(config) {
      outDir = config.build.outDir;
    },
    name: "rom-weaver-static-assets",
  };
};

export default defineConfig(({ command }) => {
  const buildInfo = getBuildInfo();
  const devServiceWorkerEnabled = process.env.VITE_SW_DEV === "1";
  const serviceWorkerEnabled = command === "build" || devServiceWorkerEnabled;
  const appVersion =
    process.env.ROM_WEAVER_APP_VERSION || buildInfo.version || process.env.npm_package_version || "0.1.0";
  const commitHash = process.env.ROM_WEAVER_COMMIT_HASH || buildInfo.commitHash || "unknown";
  const dirtyHash = process.env.ROM_WEAVER_DIRTY_HASH ?? buildInfo.dirtyHash ?? "";
  const gitBranch = process.env.ROM_WEAVER_GIT_BRANCH ?? buildInfo.gitBranch ?? "";
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
      ...serviceWorkerDefines,
    },
    optimizeDeps: {
      exclude: ["rom-weaver-wasm"],
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
        "zustand/vanilla",
      ],
    },
    plugins: [
      serveRootStaticAssets(),
      react(),
      tailwindcss(),
      writeWebappStaticAssets(),
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
            "apple-touch-icon-precomposed.png",
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
