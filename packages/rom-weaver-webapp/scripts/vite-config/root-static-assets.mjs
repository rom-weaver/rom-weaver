import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DOCS_SCREENSHOT_NAMES } from "../docs-screenshot-manifest.mjs";
import { createFirstSampleAssetFiles } from "../first-sample-assets.mjs";
import { generatedChannelAssetPath, generatedSocialPreviewPath } from "../generated-icon-assets.mjs";
import { createRootManifestSource, rootManifestSourcePath } from "./channel.mjs";
import { identifyDataSources } from "./identify-data.mjs";
import { repoRoot, rootDir } from "./paths.mjs";

const rootAssetDir = path.join(rootDir, "src", "assets", "app", "root");
const docsScreenshotSources = Object.fromEntries(
  DOCS_SCREENSHOT_NAMES.map((name) => [`/docs/screenshots/${name}`, path.join(repoRoot, "docs", "screenshots", name)]),
);

export const rootStaticAssetSourcesForChannel = (channel) => ({
  "/_redirects": path.join(rootAssetDir, "_redirects"),
  "/apple-touch-icon.png": generatedChannelAssetPath(channel, "apple-touch-icon.png"),
  "/favicon.ico": generatedChannelAssetPath(channel, "favicon.ico"),
  "/favicon-32x32.png": generatedChannelAssetPath(channel, "favicon-32x32.png"),
  "/favicon.svg": generatedChannelAssetPath(channel, "favicon.svg"),
  "/icon-192.png": generatedChannelAssetPath(channel, "icon-192.png"),
  "/icon-512.png": generatedChannelAssetPath(channel, "icon-512.png"),
  "/icon-maskable-512.png": generatedChannelAssetPath(channel, "icon-maskable-512.png"),
  "/install.sh": path.join(repoRoot, "install.sh"),
  "/llms.txt": path.join(rootAssetDir, "llms.txt"),
  "/logo.svg": generatedChannelAssetPath(channel, "logo.svg"),
  "/manifest.json": rootManifestSourcePath,
  "/emulatorjs/LICENSE": path.join(rootDir, "vendor", "emulatorjs", "LICENSE"),
  "/emulatorjs/NOTICE": path.join(rootDir, "vendor", "emulatorjs", "NOTICE"),
  "/rom-weaver-bundle-v2.schema.json": path.join(repoRoot, "docs", "rom-weaver-bundle-v2.schema.json"),
  "/social-preview.avif": generatedSocialPreviewPath("social-preview.avif"),
  "/social-preview.png": generatedSocialPreviewPath("social-preview.png"),
  "/social-preview.webp": generatedSocialPreviewPath("social-preview.webp"),
  ...identifyDataSources,
  ...docsScreenshotSources,
});
export const generatedSampleAssetPaths = new Set([
  "/first-create.zip",
  "/first-weave.zip",
  "/hello-world.nes",
  "/modified-world.nes",
]);
let generatedSampleAssets;
export const getGeneratedSampleAsset = (requestPath) => {
  if (!generatedSampleAssetPaths.has(requestPath)) return null;
  generatedSampleAssets ||= createFirstSampleAssetFiles();
  return generatedSampleAssets.get(requestPath.slice(1));
};
export const generatedLicenseAssetSources = {
  "/NOTICE": path.join(rootDir, "src", "wasm", "NOTICE"),
  "/WEBAPP_NOTICE": path.join(rootDir, "src", "wasm", "WEBAPP_NOTICE"),
};
const setRootStaticAssetContentType = (requestPath, res) => {
  if (requestPath.endsWith(".html")) res.setHeader("Content-Type", "text/html; charset=utf-8");
  else if (requestPath.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
  else if (requestPath.endsWith(".sh")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
  else if (requestPath.endsWith(".txt")) res.setHeader("Content-Type", "text/plain; charset=utf-8");
  else if (requestPath.endsWith(".md")) res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  else if (requestPath.endsWith(".avif")) res.setHeader("Content-Type", "image/avif");
  else if (requestPath.endsWith(".png")) res.setHeader("Content-Type", "image/png");
  else if (requestPath.endsWith(".zip")) res.setHeader("Content-Type", "application/zip");
  else if (requestPath.endsWith(".webp")) res.setHeader("Content-Type", "image/webp");
  else if (requestPath.endsWith(".svg")) res.setHeader("Content-Type", "image/svg+xml");
  else if (requestPath.endsWith(".ico")) res.setHeader("Content-Type", "image/x-icon");
  else if (requestPath.endsWith(".pack")) res.setHeader("Content-Type", "application/octet-stream");
  else if (requestPath.endsWith("LICENSE") || requestPath.endsWith("NOTICE")) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
  }
};

export const LEGACY_WORKFLOW_ROUTES = {
  apply: "apply-patches",
  "apply-patch": "apply-patches",
  bundle: "bundle-patches",
  create: "create-patch",
  identify: "identify-rom",
  test: "test-rom",
  trim: "trim-rom",
  weave: "apply-patches",
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

export const serveRootStaticAssets = (channel, channelLabel) => ({
  apply: "serve",
  configurePreviewServer(server) {
    applyRootStaticAssetMiddleware(server.middlewares, channel, channelLabel);
  },
  configureServer(server) {
    applyRootStaticAssetMiddleware(server.middlewares, channel, channelLabel);
  },
  name: "rom-weaver-root-static-assets",
});
