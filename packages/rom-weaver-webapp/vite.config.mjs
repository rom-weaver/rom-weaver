import path from "node:path";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { compileLinguiCatalogs } from "./scripts/compile-lingui-catalogs.mjs";
import { docsVirtualModule } from "./scripts/docs-virtual-module.mjs";
import { revisionUnhashedAssets } from "./scripts/precache-revisions.mjs";
import { getBuildInfo, getVersionBranch } from "./scripts/version.mjs";
import { writeBrotliSidecars } from "./scripts/vite-config/brotli-sidecars.mjs";
import { serveChangelogAsset, writeChangelogAsset } from "./scripts/vite-config/changelog.mjs";
import { resolveAppChannel, stampChannelIdentity } from "./scripts/vite-config/channel.mjs";
import { deferDevHotUpdates, runtimeScratchIgnorePatterns } from "./scripts/vite-config/dev-hot-updates.mjs";
import { emulatorJsLock, serveEmulatorJsAssets } from "./scripts/vite-config/emulatorjs.mjs";
import { securityHeaders, writeCloudflareHeadersAsset } from "./scripts/vite-config/headers.mjs";
import { identifyManifestFiles, identifyOptionalPackGroups } from "./scripts/vite-config/identify-data.mjs";
import { minifyDocumentInlineScripts } from "./scripts/vite-config/minify-document-inline-scripts.mjs";
import { repoRoot, rootDir } from "./scripts/vite-config/paths.mjs";
import { preparePrecacheEntries, writePrecacheSizes } from "./scripts/vite-config/precache.mjs";
import { prerenderWebappShell } from "./scripts/vite-config/prerender-shell.mjs";
import { serveRootStaticAssets } from "./scripts/vite-config/root-static-assets.mjs";
import { preloadWorkflowRouteChunks } from "./scripts/vite-config/route-preload.mjs";
import { writeWebappStaticAssets } from "./scripts/vite-config/static-assets.mjs";
import {
  nameWorkerRuntimeGroup,
  nameWorkerSharedGroup,
  shareWorkerRuntimeChunks,
} from "./scripts/vite-config/worker-chunks.mjs";
import { DOC_ROUTES } from "./src/webapp/docs-pages.mjs";

/** Shared chunks below this many raw bytes are folded back into their importer; see build.rollupOptions.output. */
const SHARED_CHUNK_MIN_SIZE = 30_000;

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
            "favicon*.png",
            "favicon*.svg",
            "apple-touch-icon.png",
            "hello-world.nes",
            "modified-world.nes",
            "assets/**/*.{css,js,mjs,json,png,svg,jpg,jpeg,webp,woff2,wasm}",
            "icon-192.png",
            "icon-512.png",
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
