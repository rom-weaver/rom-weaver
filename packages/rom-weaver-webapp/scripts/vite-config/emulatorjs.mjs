import fs from "node:fs";
import path from "node:path";
import { rootDir } from "./paths.mjs";

const EMULATORJS_DATA_PREFIX = "/emulatorjs/data/";
const EMULATORJS_MANIFEST_PATH = "/emulatorjs/manifest.json";
const emulatorJsDataSourceDir = path.join(rootDir, "vendor", "emulatorjs", "data");
export const emulatorJsLock = JSON.parse(fs.readFileSync(path.join(rootDir, "vendor", "emulatorjs.lock.json"), "utf8"));

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

export const serveEmulatorJsAssets = () => {
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

export const copyEmulatorJsAssets = (distDir) => {
  const outputDir = path.join(distDir, "emulatorjs");
  fs.cpSync(path.join(rootDir, "vendor", "emulatorjs"), outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify(createEmulatorJsManifest(outputDir)) + "\n");
};
