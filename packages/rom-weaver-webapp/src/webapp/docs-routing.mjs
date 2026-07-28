import { SITE_NAME } from "./workflow-seo.mjs";

const SITE_ORIGIN = "https://rom-weaver.com";

/**
 * @typedef {{
 *   file: string,
 *   label: string,
 *   slug: string,
 * }} DocSource
 */

/** @type {readonly DocSource[]} */
const DOC_SOURCES = Object.freeze([
  Object.freeze({ file: "guides/README.md", label: "Overview", slug: "docs" }),
  Object.freeze({ file: "guides/apply-rom-patches.md", label: "Apply patches", slug: "docs/apply-rom-patches" }),
  Object.freeze({ file: "guides/create-rom-patches.md", label: "Create patches", slug: "docs/create-rom-patches" }),
  Object.freeze({ file: "guides/create-bundles.md", label: "Create bundles", slug: "docs/create-bundles" }),
  Object.freeze({
    file: "guides/fix-checksum-errors.md",
    label: "Fix checksum errors",
    slug: "docs/fix-checksum-errors",
  }),
  Object.freeze({ file: "guides/patch-formats.md", label: "Patch formats", slug: "docs/patch-formats" }),
  Object.freeze({ file: "cli.md", label: "CLI and installation", slug: "docs/cli" }),
  Object.freeze({ file: "self-hosting.md", label: "Self-hosting", slug: "docs/self-hosting" }),
  Object.freeze({ file: "webapp-integration.md", label: "Webapp integration", slug: "docs/webapp-integration" }),
  Object.freeze({ file: "env-vars.md", label: "Environment variables", slug: "docs/environment-variables" }),
  Object.freeze({ file: "webapp-runtime-status.md", label: "Webapp status", slug: "docs/webapp-status" }),
  Object.freeze({ file: "ARCHITECTURE.md", label: "Architecture", slug: "docs/architecture" }),
  Object.freeze({ file: "development.md", label: "Development", slug: "docs/development" }),
  Object.freeze({ file: "references.md", label: "References", slug: "docs/references" }),
  Object.freeze({ file: "guides/notices.md", label: "Notices", slug: "docs/notices" }),
  Object.freeze({ file: "guides/privacy.md", label: "Privacy", slug: "docs/privacy" }),
]);

/**
 * @param {{ description: string, slug: string, title: string }} route
 * @param {string} [channelLabel]
 */
const createDocsSeoMetadata = (route, channelLabel = "") => {
  const siteName = channelLabel ? `${SITE_NAME} ${channelLabel}` : SITE_NAME;
  const title = `${route.title} | ${siteName}`;
  const canonicalUrl = `${SITE_ORIGIN}/${route.slug}`;
  /** @type {Array<[string, string, string]>} */
  const metadata = [
    ["name", "description", route.description],
    ["property", "og:title", title],
    ["property", "og:description", route.description],
    ["property", "og:url", canonicalUrl],
    ["name", "twitter:title", title],
    ["name", "twitter:description", route.description],
  ];
  return {
    canonicalUrl,
    metadata,
    title,
  };
};

/** @param {string} pathname */
const readDocsSlugFromPathname = (pathname) => {
  const segments = String(pathname || "")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  const docsIndex = segments.lastIndexOf("docs");
  if (docsIndex < 0) return "docs";
  const slug = segments
    .slice(docsIndex)
    .join("/")
    .replace(/\.html$/, "");
  return DOC_SOURCES.some((source) => source.slug === slug) ? slug : "docs";
};

export { createDocsSeoMetadata, DOC_SOURCES, readDocsSlugFromPathname, SITE_ORIGIN };
