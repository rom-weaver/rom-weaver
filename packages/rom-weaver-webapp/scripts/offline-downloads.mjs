import fs from "node:fs";
import path from "node:path";

const ROOT_PRECACHE_URLS = ["404.html", "index.html", "logo.svg", "manifest.json"];

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
