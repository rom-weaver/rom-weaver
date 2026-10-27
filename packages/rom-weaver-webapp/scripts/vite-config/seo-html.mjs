import path from "node:path";
import { readDocLastmod } from "../docs-discovery.mjs";
import { readNoticesLastmod } from "../notices-lastmod.mjs";
import { docSourcePath } from "../../src/webapp/docs-pages.mjs";
import { DOC_SOURCES } from "../../src/webapp/docs-routing.mjs";
import {
  BETA_ROUTE_TITLES,
  SITE_ALTERNATE_NAMES,
  SITE_NAME,
  WORKFLOW_SEO_ROUTES,
  WORKFLOW_ENTRY_ROUTES,
} from "../../src/webapp/workflow-seo.mjs";
import { repoRoot, rootDir } from "./paths.mjs";

export const createRobotsSource = (channel) =>
  `User-agent: *\nContent-Signal: ai-train=${channel === "prod" ? "yes" : "no"}, search=${channel === "prod" ? "yes" : "no"}, ai-input=${channel === "prod" ? "yes" : "no"}\n` +
  (channel === "prod" ? "Allow: /\nSitemap: https://rom-weaver.com/sitemap.xml\n" : "Disallow: /\n");

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
  return routeHtml.replace(
    "</head>",
    `  <link rel="alternate" type="text/markdown" href="/${route.slug || "index"}.md" />\n</head>`,
  );
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

// The Trim and Save Editor tabs are still beta - they navigate in
// production but must not be indexed, so strip the shared index directive to
// noindex and point their canonical at themselves.
export const makeBetaRouteNoindex = (html, slug, channel = "prod", channelLabel = "") => {
  let betaHtml = html
    .replace('<meta name="robots" content="index, follow" />', '<meta name="robots" content="noindex, nofollow" />')
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1https://rom-weaver.com/${slug}$2`);
  const baseTitle = BETA_ROUTE_TITLES[slug];
  if (!baseTitle) return betaHtml;
  const title = channel === "prod" ? baseTitle : baseTitle.replace(SITE_NAME, `${SITE_NAME} ${channelLabel}`);
  betaHtml = betaHtml.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  for (const [attribute, name] of [
    ["property", "og:title"],
    ["name", "twitter:title"],
  ])
    betaHtml = replaceMetaContent(betaHtml, attribute, name, title);
  return betaHtml;
};

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

// A workflow page's <lastmod> is the newest commit of the files that carry its indexable text: the
// route table, the message catalog and, for the apex, the landing components and format lists.
// Hard-coded form text in a view's own component is not tracked, so a commit that edits only that
// can leave the date behind. A dirty or shallow checkout yields none, and the entry then omits
// <lastmod> rather than guess.
const WORKFLOW_LASTMOD_SOURCES = ["src/webapp/workflow-seo.mjs", "src/presentation/localization/messages.ts"];
const HOME_LASTMOD_SOURCES = [
  "src/webapp/components/home-page.tsx",
  "src/webapp/components/home-sections.tsx",
  "src/webapp/components/home-loom.tsx",
  "src/wasm/generated/rom-weaver-format-metadata.ts",
];
const readWorkflowLastmod = (route, root, repo) => {
  const files = route.slug === "" ? [...WORKFLOW_LASTMOD_SOURCES, ...HOME_LASTMOD_SOURCES] : WORKFLOW_LASTMOD_SOURCES;
  const dates = files.map((file) => readDocLastmod(path.join(root, file), repo));
  return dates.includes(null) ? null : dates.sort((a, b) => a.localeCompare(b)).at(-1);
};

// Notices is generated and untracked, so git cannot date it; readNoticesLastmod finds the release
// that last changed its text.
export const createSitemapSource = ({
  root = rootDir,
  repo = repoRoot,
  generatedLastmod = readNoticesLastmod(repo),
} = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...Object.values(WORKFLOW_SEO_ROUTES), ...Object.values(WORKFLOW_ENTRY_ROUTES)]
  .map((route) => {
    const lastmod = readWorkflowLastmod(route, root, repo);
    return `  <url><loc>https://rom-weaver.com/${route.slug}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
  })
  .join("\n")}
${DOC_SOURCES.map((source) => {
  const lastmod = source.file.startsWith("wasm/") ? generatedLastmod : readDocLastmod(docSourcePath(source), repo);
  return `  <url><loc>https://rom-weaver.com/${source.slug}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
}).join("\n")}
</urlset>
`;

// The Canonical line names production; the links name the serving deployment.
export const createWorkflowMarkdown = (route, siteOrigin = "https://rom-weaver.com") =>
  `Canonical: https://rom-weaver.com/${route.slug}\n\n# ${route.title}\n\n${route.description}\n\n[Open in browser](${siteOrigin}/${route.slug})\n\n[Documentation](${siteOrigin}/docs.md)\n`;
