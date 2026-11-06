import fs from "node:fs";
import path from "node:path";
import { createDocRoute, DOC_SOURCES } from "./docs-content.mjs";
import { createDocsSeoMetadata, isLegalDocRoute, isRootPath, mapDocImageUrls, SITE_ORIGIN } from "./docs-routing.mjs";
import { SITE_NAME } from "./workflow-seo.mjs";

const docsDirectory = path.resolve(import.meta.dirname, "../../../../docs");
const generatedDocsDirectory = path.resolve(import.meta.dirname, "../wasm");

/** @param {{ file: string }} source */
const docSourcePath = (source) =>
  source.file.startsWith("wasm/")
    ? path.join(generatedDocsDirectory, source.file.slice("wasm/".length))
    : path.join(docsDirectory, source.file);

/** Read and render every published document from disk. The dev plugin re-runs this on edit. */
const readDocRoutes = () =>
  Object.freeze(DOC_SOURCES.map((source) => createDocRoute(source, fs.readFileSync(docSourcePath(source), "utf8"))));

const DOC_ROUTES = readDocRoutes();

/** @param {unknown} value */
const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// A `<script>` element is raw text: the parser reads no entities and closes on
// the first `</script`, so guide-derived JSON headed for an inline script has
// its `<` escaped. `<` is the same character to a JSON reader.
/** @param {unknown} value */
const serializeInlineJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

// Guide-derived text can contain `$`, which `String.replace` reads as a match
// reference in a replacement *string* - every substitution here goes through a
// replacer function so the content is inserted literally.
/** @param {string} html @param {RegExp} pattern @param {string} content */
const replaceBetween = (html, pattern, content) =>
  html.replace(pattern, (_match, open, close) => `${open}${escapeHtml(content)}${close}`);

/** @param {string} html @param {string} attribute @param {string} name @param {string} content */
const replaceMetaContent = (html, attribute, name, content) =>
  replaceBetween(html, new RegExp(`(<meta\\s+${attribute}="${name}"\\s+content=")[^"]*(")`), content);

/**
 * Guides name their screenshots by root-absolute path (`/docs/screenshots/x.webp`). Written
 * relative instead, the page's `<base>` resolves them against the app root on any deployment,
 * so a sub-path host does not request them from the origin root before the app has booted.
 */
const relativeImagePaths = (/** @type {string} */ html) =>
  mapDocImageUrls(html, (/** @type {string} */ url) => (isRootPath(url) ? url.slice(1) : url));

/**
 * Point the shell's relative asset URLs at the app root from wherever a static host serves
 * the file: `docs/faq.html` answers at `/docs/faq`, `docs/faq/index.html` at `/docs/faq/`.
 * A fixed `<base href="/">` would send a sub-path deployment's assets to the origin root.
 * `docs.html` at the app root still gets `./`: soft navigation into a guide moves the URL to
 * `/docs/<slug>`, and without a base `document.baseURI` would follow it.
 *
 * @param {string} html
 * @param {string} slug
 * @param {boolean} directoryIndex whether this is the `<slug>/index.html` copy
 */
const withDocsBase = (html, slug, directoryIndex) => {
  const depth = slug.split("/").length - (directoryIndex ? 0 : 1);
  const base = depth === 0 ? "./" : "../".repeat(depth);
  return relativeImagePaths(html).replace("<head>", `<head>\n    <base href="${base}" />`);
};

/**
 * Stamp route-specific metadata onto the same app document and React shell used
 * by every other top-level page.
 *
 * @param {string} html
 * @param {(typeof DOC_ROUTES)[number]} route
 * @param {string} channel
 * @param {string} channelLabel
 * @param {string | null} [dateModified] the page's sitemap `<lastmod>`; omitted when unknown
 */
const createDocsRouteHtml = (html, route, channel, channelLabel, dateModified) => {
  const { canonicalUrl, metadata, title } = createDocsSeoMetadata(route, channel === "prod" ? "" : channelLabel);
  const legalPage = isLegalDocRoute(route.slug);
  const structuredData = {
    "@context": "https://schema.org",
    "@type": legalPage ? "WebPage" : "TechArticle",
    ...(dateModified ? { dateModified } : {}),
    description: route.description,
    headline: route.title,
    publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_ORIGIN },
    url: canonicalUrl,
  };
  let routeHtml = replaceBetween(html, /(<title>)[^<]*(<\/title>)/, title);
  routeHtml = replaceBetween(routeHtml, /(<link\s+rel="canonical"\s+href=")[^"]*(")/, canonicalUrl);
  routeHtml = routeHtml.replace(/(<meta\s+property="og:type"\s+content=")[^"]*(")/, "$1article$2");
  for (const [attribute, name, content] of metadata) {
    routeHtml = replaceMetaContent(routeHtml, attribute, name, content);
  }
  return routeHtml.replace(
    "</head>",
    `  <link rel="alternate" type="text/markdown" href="${escapeHtml(route.slug)}.md" />\n  <script type="application/ld+json">${serializeInlineJson(structuredData)}</script>\n  </head>`,
  );
};

export {
  createDocsRouteHtml,
  DOC_ROUTES,
  docsDirectory,
  docSourcePath,
  generatedDocsDirectory,
  readDocRoutes,
  withDocsBase,
};
