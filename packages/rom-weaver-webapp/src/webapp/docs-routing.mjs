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
  Object.freeze({ file: "README.md", label: "Overview", slug: "docs" }),
  Object.freeze({ file: "faq.md", label: "FAQ", slug: "docs/faq" }),
  Object.freeze({ file: "tutorials/first-patch.md", label: "Your first patch", slug: "docs/get-started" }),
  Object.freeze({
    file: "tutorials/cli-first-weave.md",
    label: "Your first weave (CLI)",
    slug: "docs/cli-get-started",
  }),
  Object.freeze({
    file: "how-to/apply-rom-patches.md",
    label: "Apply patches (browser)",
    slug: "docs/apply-rom-patches",
  }),
  Object.freeze({
    file: "how-to/create-rom-patches.md",
    label: "Create patches (browser)",
    slug: "docs/create-rom-patches",
  }),
  Object.freeze({ file: "how-to/create-bundles.md", label: "Create bundles (browser)", slug: "docs/create-bundles" }),
  Object.freeze({
    file: "how-to/fix-checksum-errors.md",
    label: "Fix checksum errors",
    slug: "docs/fix-checksum-errors",
  }),
  Object.freeze({ file: "how-to/install-cli.md", label: "Install the CLI", slug: "docs/install" }),
  Object.freeze({
    file: "how-to/verify-downloads.md",
    label: "Verify a download",
    slug: "docs/verify-downloads",
  }),
  Object.freeze({ file: "how-to/cli-apply.md", label: "Apply patches (CLI)", slug: "docs/cli-apply" }),
  Object.freeze({ file: "how-to/cli-create.md", label: "Create patches (CLI)", slug: "docs/cli-create" }),
  Object.freeze({ file: "how-to/cli-bundles.md", label: "Bundles (CLI)", slug: "docs/cli-bundles" }),
  Object.freeze({ file: "how-to/work-with-archives.md", label: "Work with archives", slug: "docs/formats" }),
  Object.freeze({
    file: "how-to/fix-permission-errors.md",
    label: "Fix permission errors",
    slug: "docs/fix-permission-errors",
  }),
  Object.freeze({ file: "reference/cli.md", label: "CLI reference", slug: "docs/cli" }),
  Object.freeze({
    file: "reference/formats.md",
    label: "Supported formats",
    slug: "docs/supported-formats",
  }),
  Object.freeze({
    file: "explanation/how-patching-works.md",
    label: "How patching works",
    slug: "docs/how-patching-works",
  }),
  Object.freeze({ file: "explanation/local-first.md", label: "Why files stay local", slug: "docs/local-first" }),
  Object.freeze({ file: "explanation/patch-formats.md", label: "Patch formats", slug: "docs/patch-formats" }),
  Object.freeze({
    file: "explanation/compression-formats.md",
    label: "Compression formats",
    slug: "docs/compression-formats",
  }),
  Object.freeze({ file: "explanation/bundles.md", label: "What a bundle is", slug: "docs/bundles" }),
  Object.freeze({ file: "explanation/browser-and-cli.md", label: "Browser and CLI", slug: "docs/browser-and-cli" }),
  Object.freeze({
    file: "explanation/release-provenance.md",
    label: "Release provenance",
    slug: "docs/release-provenance",
  }),
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
  Object.freeze({ file: "legal/about.md", label: "About", slug: "docs/about" }),
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
const DOC_GROUP_TITLES = Object.freeze({
  "": "Start here",
  "how-to": "How-to guides",
});

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

/**
 * The pages that are not guides. Schema.org calls these WebPage rather than
 * TechArticle, and the prerender and its verifier have to agree on which is
 * which - so they ask here rather than each keeping a list.
 *
 * @param {string} slug
 */
const isLegalDocRoute = (slug) => slug === "docs/about" || slug === "docs/notices" || slug === "docs/privacy";

export {
  createDocsSeoMetadata,
  DOC_SOURCES,
  docGroupTitle,
  groupDocRoutes,
  isLegalDocRoute,
  readDocsSlugFromPathname,
  SITE_ORIGIN,
};
