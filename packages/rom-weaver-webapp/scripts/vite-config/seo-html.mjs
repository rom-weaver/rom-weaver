import { readDocLastmod } from "../docs-discovery.mjs";
import { docSourcePath } from "../../src/webapp/docs-pages.mjs";
import { DOC_SOURCES } from "../../src/webapp/docs-routing.mjs";
import { SITE_ALTERNATE_NAMES, SITE_NAME } from "../../src/webapp/workflow-seo.mjs";
import { repoRoot } from "./paths.mjs";

export const createRobotsSource = (channel) =>
  channel === "prod"
    ? "User-agent: *\nAllow: /\nSitemap: https://rom-weaver.com/sitemap.xml\n"
    : "User-agent: *\nDisallow: /\n";

const replaceMetaContent = (html, attribute, name, content) =>
  html.replace(new RegExp(`(<meta\\s+${attribute}="${name}"\\s+content=")[^"]*(")`), `$1${content}$2`);

export const createWorkflowRouteHtml = (html, route, channel, channelLabel) => {
  const title = channel === "prod" ? route.title : route.title.replace(SITE_NAME, `${SITE_NAME} ${channelLabel}`);
  const canonicalUrl = `https://rom-weaver.com/${route.slug}`;
  let routeHtml = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${canonicalUrl}$2`);
  for (const [attribute, name, content] of [
    ["name", "description", route.description],
    ["property", "og:title", title],
    ["property", "og:description", route.description],
    ["property", "og:url", canonicalUrl],
    ["name", "twitter:title", title],
    ["name", "twitter:description", route.description],
  ]) {
    routeHtml = replaceMetaContent(routeHtml, attribute, name, content);
  }
  return routeHtml;
};

// Describe both the site name and free browser tool in one graph. alternateName
// keeps legacy spellings discoverable without making the visible brand inconsistent.
const createStructuredDataLdJson = (route, includeWebsite) => {
  const graph = [];
  if (includeWebsite) {
    graph.push({
      "@type": "WebSite",
      alternateName: SITE_ALTERNATE_NAMES,
      name: SITE_NAME,
      url: "https://rom-weaver.com/",
    });
  }
  graph.push({
    "@type": "SoftwareApplication",
    alternateName: SITE_ALTERNATE_NAMES,
    applicationCategory: "UtilitiesApplication",
    description: route.description,
    name: SITE_NAME,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    operatingSystem: "Web browser",
    url: `https://rom-weaver.com/${route.slug}`,
  });
  const data = {
    "@context": "https://schema.org",
    "@graph": graph,
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
};

export const injectLdJson = (html, route, includeWebsite = false) =>
  html.replace("</head>", `  ${createStructuredDataLdJson(route, includeWebsite)}\n  </head>`);

// The Trim, PPF undo, and Save Editor tabs are still beta - they navigate in
// production but must not be indexed, so strip the shared index directive to
// noindex and point their canonical at themselves.
export const makeBetaRouteNoindex = (html, slug) =>
  html
    .replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />')
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1https://rom-weaver.com/${slug}$2`);

export const createNotFoundHtml = (html, channel, channelLabel) => {
  const title = `Page not found | ${SITE_NAME}${channel === "prod" ? "" : ` ${channelLabel}`}`;
  const description = "The requested rom-weaver page could not be found.";
  // Cloudflare serves 404.html as the body at whatever URL missed, so the
  // base:"./" relative asset URLs resolve wrong at any nested path without this.
  let notFoundHtml = html
    .replace("<html ", '<html data-page="not-found" ')
    .replace("<head>", '<head>\n    <base href="/" />')
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<meta\s+name="robots"\s+content=")[^"]*(")/, "$1noindex$2")
    .replace(
      'aria-selected="true" class="mode" data-mode="patcher"',
      'aria-selected="false" class="mode" data-mode="patcher"',
    )
    .replace(/\s*<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/, "");
  for (const [attribute, name, content] of [
    ["name", "description", description],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ["property", "og:url", "https://rom-weaver.com/"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
  ]) {
    notFoundHtml = replaceMetaContent(notFoundHtml, attribute, name, content);
  }
  return notFoundHtml;
};

export const createSitemapSource = () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://rom-weaver.com/</loc></url>
  <url><loc>https://rom-weaver.com/apply-patches</loc></url>
  <url><loc>https://rom-weaver.com/bundle-patches</loc></url>
  <url><loc>https://rom-weaver.com/create-patch</loc></url>
  <url><loc>https://rom-weaver.com/extract</loc></url>
  <url><loc>https://rom-weaver.com/identify-rom</loc></url>
  <url><loc>https://rom-weaver.com/test-rom</loc></url>
${DOC_SOURCES.map((source) => {
  const lastmod = readDocLastmod(docSourcePath(source), repoRoot);
  return `  <url><loc>https://rom-weaver.com/${source.slug}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
}).join("\n")}
</urlset>
`;
