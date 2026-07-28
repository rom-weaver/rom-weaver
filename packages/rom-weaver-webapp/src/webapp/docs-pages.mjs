import fs from "node:fs";
import path from "node:path";
import { createDocRoute, DOC_SOURCES } from "./docs-content.mjs";
import { SITE_NAME } from "./workflow-seo.mjs";

const SITE_ORIGIN = "https://rom-weaver.com";
const docsDirectory = path.resolve(import.meta.dirname, "../../../../docs/guides");

const DOC_ROUTES = Object.freeze(
  DOC_SOURCES.map((source) => createDocRoute(source, fs.readFileSync(path.join(docsDirectory, source.file), "utf8"))),
);

/** @param {unknown} value */
const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** @param {string} html @param {string} attribute @param {string} name @param {string} content */
const replaceMetaContent = (html, attribute, name, content) =>
  html.replace(new RegExp(`(<meta\\s+${attribute}="${name}"\\s+content=")[^"]*(")`), `$1${escapeHtml(content)}$2`);

/**
 * Stamp route-specific metadata onto the same app document and React shell used
 * by every other top-level page.
 *
 * @param {string} html
 * @param {(typeof DOC_ROUTES)[number]} route
 * @param {string} channel
 * @param {string} channelLabel
 */
const createDocsRouteHtml = (html, route, channel, channelLabel) => {
  const siteName = channel === "prod" ? SITE_NAME : `${SITE_NAME} ${channelLabel}`;
  const title = `${route.title} | ${siteName}`;
  const canonicalUrl = `${SITE_ORIGIN}/${route.slug}`;
  const legalPage = route.slug === "docs/notices" || route.slug === "docs/privacy";
  const structuredData = {
    "@context": "https://schema.org",
    "@type": legalPage ? "WebPage" : "TechArticle",
    description: route.description,
    headline: route.title,
    publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_ORIGIN },
    url: canonicalUrl,
  };
  let routeHtml = html
    .replace("<head>", '<head>\n    <base href="/" />')
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${canonicalUrl}$2`)
    .replace(/(<meta\s+property="og:type"\s+content=")[^"]*(")/, "$1article$2");
  /** @type {Array<[string, string, string]>} */
  const metadata = [
    ["name", "description", route.description],
    ["property", "og:title", title],
    ["property", "og:description", route.description],
    ["property", "og:url", canonicalUrl],
    ["name", "twitter:title", title],
    ["name", "twitter:description", route.description],
  ];
  for (const [attribute, name, content] of metadata) {
    routeHtml = replaceMetaContent(routeHtml, attribute, name, content);
  }
  return routeHtml.replace(
    "</head>",
    `  <script type="application/ld+json">${JSON.stringify(structuredData)}</script>\n  </head>`,
  );
};

export { createDocsRouteHtml, DOC_ROUTES };
