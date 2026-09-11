import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const CHUNK_BYTES = 1024 * 1024;
const ROOT_PRECACHE_URLS = ["404.html", "index.html", "logo.svg", "manifest.json"];

const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

const fileContentType = (url) => {
  url = url.split(/[?#]/u, 1)[0];
  const extension = path.posix.extname(url.endsWith(".br") ? url.slice(0, -3) : url).toLowerCase();
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".zip") return "application/zip";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
};

const entryUrl = (entry) => {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.url === "string") return entry.url;
  throw new TypeError("offline download entries must be URL strings or Workbox entries");
};

const pathForUrl = (url) => {
  if (typeof url !== "string" || !url) throw new TypeError("offline download URL must be a non-empty string");
  const pathname = url.split(/[?#]/u, 1)[0];
  if (
    !pathname ||
    pathname.startsWith("/") ||
    pathname.startsWith("\\") ||
    pathname.includes("\\") ||
    /^[a-z][a-z\d+.-]*:/iu.test(pathname)
  ) {
    throw new Error(`offline download URL must be relative: ${url}`);
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new Error(`offline download URL has invalid encoding: ${url}`);
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`offline download URL escapes dist: ${url}`);
  }
  return decoded;
};

const fileInDist = (distDir, relativePath) => {
  const resolvedDistDir = path.resolve(distDir);
  const filePath = path.resolve(resolvedDistDir, ...relativePath.split("/"));
  const relative = path.relative(resolvedDistDir, filePath);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`offline download URL escapes dist: ${relativePath}`);
  }
  return filePath;
};

const readOriginalBytes = (distDir, url) => {
  const relativePath = pathForUrl(url);
  const filePath = fileInDist(distDir, relativePath);
  if (fs.existsSync(filePath)) {
    const source = fs.readFileSync(filePath);
    return relativePath.endsWith(".br") ? zlib.brotliDecompressSync(source) : source;
  }
  if (!relativePath.endsWith(".br") && fs.existsSync(`${filePath}.br`)) {
    return zlib.brotliDecompressSync(fs.readFileSync(`${filePath}.br`));
  }
  throw new Error(`offline download asset is missing from dist: ${url}`);
};

const gzipChunk = (contents) => zlib.gzipSync(contents, { level: zlib.constants.Z_BEST_COMPRESSION });

/**
 * Build the immutable gzip pieces that resumable offline downloads fetch.
 * The caller chooses the URLs so HTML and route-only code do not enter this manifest.
 */
export function writeOfflineDownloads(distDir, entries) {
  if (!Array.isArray(entries)) throw new TypeError("offline download entries must be an array");
  const manifest = {};
  const chunkDir = path.join(distDir, "offline-chunks");
  const urls = [...new Set(entries.map(entryUrl))].sort((left, right) => left.localeCompare(right));

  for (const url of urls) {
    const contents = readOriginalBytes(distDir, url);
    if (contents.length < CHUNK_BYTES) continue;
    const chunks = [];
    for (let offset = 0; offset < contents.length; offset += CHUNK_BYTES) {
      const decoded = contents.subarray(offset, offset + CHUNK_BYTES);
      const compressed = gzipChunk(decoded);
      const chunkSha256 = sha256(decoded);
      const chunkPath = path.join(chunkDir, `${chunkSha256}.gz`);
      if (!fs.existsSync(chunkPath)) {
        fs.mkdirSync(chunkDir, { recursive: true });
        fs.writeFileSync(chunkPath, compressed, { flag: "wx" });
      }
      chunks.push({
        encoding: "gzip",
        sha256: chunkSha256,
        sizeBytes: decoded.length,
        url: `offline-chunks/${chunkSha256}.gz`,
      });
    }
    manifest[url] = {
      chunks,
      contentType: fileContentType(url),
      revision: sha256(contents),
      sizeBytes: contents.length,
    };
  }

  const serializedManifest = `${JSON.stringify(manifest)}\n`;
  const revision = sha256(serializedManifest);
  const url = `offline-downloads-${revision}.json`;
  fs.writeFileSync(path.join(distDir, url), serializedManifest);
  return { manifest, revision, url };
}

const readAttribute = (tag, name) => {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
};

const htmlAssetUrl = (value) => {
  if (!value || value.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(value)) return null;
  const pathname = value.split(/[?#]/u, 1)[0].replace(/^\.\//u, "").replace(/^\//u, "");
  if (!pathname || pathname.startsWith("../") || pathname.includes("\\")) return null;
  return pathname;
};

const rootHtmlAssets = (html) => {
  const urls = new Set();
  for (const match of html.matchAll(/<script\b[^>]*>/giu)) {
    const url = htmlAssetUrl(readAttribute(match[0], "src"));
    if (url) urls.add(url);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = readAttribute(match[0], "rel")?.toLowerCase().split(/\s+/u) ?? [];
    const isFontPreload = rel.includes("preload") && readAttribute(match[0], "as")?.toLowerCase() === "font";
    if (!(rel.includes("stylesheet") || rel.includes("modulepreload") || isFontPreload)) continue;
    const url = htmlAssetUrl(readAttribute(match[0], "href"));
    if (url) urls.add(url);
  }
  return urls;
};

/** Return the resources needed to load the root document, without lazy routes or binary assets. */
export function initialPrecacheUrls(distDir) {
  const viteManifestPath = path.join(distDir, ".vite", "manifest.json");
  const viteManifest = JSON.parse(fs.readFileSync(viteManifestPath, "utf8"));
  const rootEntryKey = Object.hasOwn(viteManifest, "index.html")
    ? "index.html"
    : Object.keys(viteManifest).find((key) => viteManifest[key].src === "index.html");
  if (!rootEntryKey) throw new Error("Vite manifest has no index.html entry");

  const urls = new Set(ROOT_PRECACHE_URLS);
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = viteManifest[key];
    if (!entry) throw new Error(`Vite manifest import is missing: ${key}`);
    if (entry.file) urls.add(entry.file);
    for (const css of entry.css ?? []) urls.add(css);
    for (const importedKey of entry.imports ?? []) visit(importedKey);
  };
  visit(rootEntryKey);
  for (const url of rootHtmlAssets(fs.readFileSync(path.join(distDir, "index.html"), "utf8"))) urls.add(url);
  return urls;
}
