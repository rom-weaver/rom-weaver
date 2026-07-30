import { SITE_NAME } from "./workflow-seo.mjs";

const SITE_ORIGIN = "https://rom-weaver.com";

/**
 * @typedef {{
 *   file: string,
 *   group?: string,
 *   label: string,
 *   slug: string,
 * }} DocSource
 */

/** @type {readonly DocSource[]} */
const DOC_SOURCES = Object.freeze([
  Object.freeze({ file: "usage/README.md", label: "Overview", slug: "docs" }),
  Object.freeze({ file: "usage/get-started.md", label: "Browser usage", slug: "docs/get-started" }),
  Object.freeze({ file: "usage/apply-rom-patches.md", label: "Apply patches", slug: "docs/apply-rom-patches" }),
  Object.freeze({ file: "usage/create-rom-patches.md", label: "Create patches", slug: "docs/create-rom-patches" }),
  Object.freeze({ file: "usage/create-bundles.md", label: "Create bundles", slug: "docs/create-bundles" }),
  Object.freeze({
    file: "usage/fix-checksum-errors.md",
    label: "Fix checksum errors",
    slug: "docs/fix-checksum-errors",
  }),
  Object.freeze({ file: "usage/faq.md", label: "FAQ", slug: "docs/faq" }),
  Object.freeze({ file: "usage/patch-formats.md", label: "Patch formats", slug: "docs/patch-formats" }),
  Object.freeze({ file: "hosting/cli.md", label: "CLI usage", slug: "docs/cli" }),
  Object.freeze({ file: "hosting/self-hosting.md", label: "Self-hosting", slug: "docs/self-hosting" }),
  Object.freeze({
    file: "hosting/webapp-integration.md",
    label: "Webapp integration",
    slug: "docs/webapp-integration",
  }),
  Object.freeze({ file: "hosting/env-vars.md", label: "Environment variables", slug: "docs/environment-variables" }),
  Object.freeze({ file: "hosting/webapp-runtime-status.md", label: "Webapp status", slug: "docs/webapp-status" }),
  Object.freeze({ file: "development/ARCHITECTURE.md", label: "Architecture", slug: "docs/architecture" }),
  Object.freeze({ file: "development/development.md", label: "Development", slug: "docs/development" }),
  Object.freeze({ file: "development/references.md", label: "References", slug: "docs/references" }),
  Object.freeze({ file: "wasm/notices.md", group: "Legal", label: "Notices", slug: "docs/notices" }),
  Object.freeze({ file: "legal/privacy.md", label: "Privacy", slug: "docs/privacy" }),
]);

/**
 * Shelves come from where a page lives on disk, not from a field beside it, so
 * the two can never disagree: moving a file between folders moves it between
 * shelves. Only the display title is mapped here, for the folders whose name is
 * not already the words we want to show.
 */
/** @type {Readonly<Record<string, string>>} */
const DOC_GROUP_TITLES = Object.freeze({ hosting: "Install & hosting", usage: "Browser usage" });

/**
 * Title of the shelf a source file sits on, from its directory under `docs/`.
 * An unmapped folder falls back to its own capitalized name, so adding
 * `docs/tutorials/` yields a "Tutorials" shelf with no edit here.
 *
 * @param {string} file
 */
const docGroupTitle = (file) => {
  const separator = file.lastIndexOf("/");
  const folder = separator < 0 ? "" : file.slice(0, separator);
  return DOC_GROUP_TITLES[folder] ?? `${folder.charAt(0).toUpperCase()}${folder.slice(1)}`;
};

/**
 * Bucket routes onto their shelves, in the order the shelves first appear.
 *
 * @template {{ group: string }} Route
 * @param {readonly Route[]} routes
 * @returns {readonly { title: string, routes: readonly Route[] }[]}
 */
const groupDocRoutes = (routes) => {
  /** @type {Map<string, Route[]>} */
  const shelves = new Map();
  for (const route of routes) {
    const shelf = shelves.get(route.group);
    if (shelf) shelf.push(route);
    else shelves.set(route.group, [route]);
  }
  return Object.freeze(
    [...shelves].map(([title, grouped]) => Object.freeze({ title, routes: Object.freeze(grouped) })),
  );
};

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

export { createDocsSeoMetadata, DOC_SOURCES, docGroupTitle, groupDocRoutes, readDocsSlugFromPathname, SITE_ORIGIN };
