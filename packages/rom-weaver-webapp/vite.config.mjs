import path from "node:path";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { compileLinguiCatalogs } from "./scripts/compile-lingui-catalogs.mjs";
import { docsVirtualModule } from "./scripts/docs-virtual-module.mjs";
import { getBuildInfo, getVersionBranch } from "./scripts/version.mjs";
import { writeBrotliSidecars } from "./scripts/vite-config/brotli-sidecars.mjs";
import { serveChangelogAsset } from "./scripts/vite-config/changelog.mjs";
import {
  releaseVersionForChannel,
  resolveAppChannel,
  resolveSiteOrigin,
  stampChannelIdentity,
} from "./scripts/vite-config/channel.mjs";
import { stampBuildChannel } from "./scripts/vite-config/channel-stamp.mjs";
import { deferDevHotUpdates, runtimeScratchIgnorePatterns } from "./scripts/vite-config/dev-hot-updates.mjs";
import { emulatorJsLock, serveEmulatorJsAssets } from "./scripts/vite-config/emulatorjs.mjs";
import { securityHeaders } from "./scripts/vite-config/headers.mjs";
import { identifyManifestFiles, identifyOptionalPackGroups } from "./scripts/vite-config/identify-data.mjs";
import { repoRoot, rootDir } from "./scripts/vite-config/paths.mjs";
import { prerenderWebappShell } from "./scripts/vite-config/prerender-shell.mjs";
import { redirectSourcePaths, serveRootStaticAssets } from "./scripts/vite-config/root-static-assets.mjs";
import { preloadWorkflowRouteChunks } from "./scripts/vite-config/route-preload.mjs";
import { writeWebappStaticAssets } from "./scripts/vite-config/static-assets.mjs";
import {
  nameWorkerRuntimeGroup,
  nameWorkerSharedGroup,
  shareWorkerRuntimeChunks,
} from "./scripts/vite-config/worker-chunks.mjs";
import { nameWorkflowSharedGroup, resetWorkflowChunks } from "./scripts/vite-config/workflow-chunks.mjs";
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
  // Origin named by llms.txt, the Markdown alternates, openapi.json and the API catalog.
  const siteOrigin = resolveSiteOrigin(process.env.ROM_WEAVER_SITE_ORIGIN);
  const appChannelLabel = process.env.ROM_WEAVER_CHANNEL_LABEL || appChannel;
  const releaseVersion = releaseVersionForChannel(appChannel, appVersion);
  // The channel stamp renders the prerendered shells after the build, possibly
  // in another job, so it reuses these instead of reading git again.
  const buildInfoDefines = {
    __APP_VERSION__: JSON.stringify(appVersion),
    __COMMIT_HASH__: JSON.stringify(commitHash),
    __COMMITS_SINCE_VERSION__: JSON.stringify(commitsSinceVersion),
    __DIRTY_HASH__: JSON.stringify(dirtyHash),
    __GIT_BRANCH__: JSON.stringify(gitBranch),
    __VERSION_BRANCH__: JSON.stringify(versionBranch),
    __VERSION_IS_TAGGED__: JSON.stringify(versionIsTagged),
  };
  const serviceWorkerDefines = {
    __SERVICE_WORKER_ENABLED__: JSON.stringify(serviceWorkerEnabled),
    __SERVICE_WORKER_UPDATE_INTERVAL_MS__: JSON.stringify(command === "build" ? 60000 : 5000),
  };
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
              { includeDependenciesRecursively: false, minShareCount: 2, name: nameWorkerRuntimeGroup, priority: 3 },
              { includeDependenciesRecursively: false, minShareCount: 2, name: nameWorkerSharedGroup, priority: 2 },
              { includeDependenciesRecursively: false, minShareCount: 2, name: nameWorkflowSharedGroup, priority: 1 },
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
      ...buildInfoDefines,
      __EMULATORJS_VERSION__: JSON.stringify(emulatorJsLock.version),
      __IDENTIFY_MANIFEST_FILES__: JSON.stringify(identifyManifestFiles),
      __IDENTIFY_OPTIONAL_PACK_GROUPS__: JSON.stringify(identifyOptionalPackGroups),
      __REDIRECT_SOURCE_PATHS__: JSON.stringify(redirectSourcePaths()),
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
      resetWorkflowChunks(),
      serveRootStaticAssets(appChannel, appChannelLabel, siteOrigin),
      serveEmulatorJsAssets(),
      serveChangelogAsset(releaseVersion),
      deferDevHotUpdates(),
      stampChannelIdentity(appChannel, appChannelLabel, serviceWorkerEnabled),
      react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
      prerenderWebappShell(appChannel, appChannelLabel),
      preloadWorkflowRouteChunks(routePreloadLinks),
      writeWebappStaticAssets(),
      writeBrotliSidecars(),
      VitePWA({
        devOptions: {
          disableRuntimeConfig: true,
          enabled: devServiceWorkerEnabled,
          type: "module",
        },
        filename: "rom-weaver-service-worker.ts",
        injectManifest: {
          // The channel stamp injects the precache manifest (scripts/vite-config/precache.mjs),
          // because the documents it lists differ per channel.
          injectionPoint: undefined,
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
      stampBuildChannel({
        channel: appChannel,
        channelLabel: appChannelLabel,
        define: buildInfoDefines,
        routePreloadLinks,
        siteOrigin,
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
