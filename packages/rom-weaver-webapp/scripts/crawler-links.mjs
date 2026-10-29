import fs from "node:fs";
import path from "node:path";
import { documentNodes, parseDocument } from "./html-document.mjs";

// A crawler may ignore `<base href>`, so a link is only safe when it points at a
// real file after resolving against the page's own URL. Browsers hide the
// difference: the link audit in the E2E suite follows `<base>` and cannot see it.
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

const walkHtml = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    const file = path.join(entry.parentPath, entry.name);
    return entry.isFile() && entry.name.endsWith(".html") ? [file] : [];
  });

/** The clean URL path a static host serves a built file at: `a.html` and `a/index.html` are `/a`. */
export const pageUrlPath = (distDir, file) => {
  const relative = path.relative(distDir, file).split(path.sep).join("/");
  const route = relative.replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/, "");
  return `/${route}`;
};

const safeDecode = (pathname) => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
};

const builtTargetExists = (distDir, pathname) => {
  const decoded = safeDecode(pathname);
  if (decoded === null) return false;
  const relative = decoded.replace(/^\/+/, "");
  const candidates = relative ? [relative, `${relative}.html`, path.join(relative, "index.html")] : ["index.html"];
  return candidates.some(
    (candidate) => fs.existsSync(path.join(distDir, candidate)) && fs.statSync(path.join(distDir, candidate)).isFile(),
  );
};

// Paths the static host answers with a redirect have no built file; a crawler follows them.
const redirectSources = (distDir) => {
  const file = path.join(distDir, "_redirects");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0]);
};

export const internalHrefs = (html) => {
  const hrefs = [];
  for (const node of documentNodes(parseDocument(html))) {
    if (node.tagName !== "a") continue;
    const href = node.attrs?.find((attr) => attr.name === "href")?.value.trim();
    if (href && !EXTERNAL.test(href)) hrefs.push(href);
  }
  return hrefs;
};

/**
 * Same-origin links in the built pages whose target does not exist when resolved
 * against the page URL alone. `allowed` lists `<pathname>` values served by a
 * function instead of a file; `_redirects` sources are allowed too.
 */
export const findCrawlerBrokenLinks = (distDir, { allowed = [] } = {}) => {
  const served = new Set([...allowed, ...redirectSources(distDir)]);
  const broken = [];
  for (const file of walkHtml(distDir)) {
    const page = pageUrlPath(distDir, file);
    const seen = new Set();
    for (const href of internalHrefs(fs.readFileSync(file, "utf8"))) {
      const { pathname } = new URL(href, `https://crawler.invalid${page}`);
      if (seen.has(pathname) || served.has(pathname) || builtTargetExists(distDir, pathname)) continue;
      seen.add(pathname);
      broken.push({ href, page, pathname });
    }
  }
  return broken;
};
