/**
 * @typedef {{
 *   file: string,
 *   label: string,
 *   slug: string,
 * }} DocSource
 */

/** @type {readonly DocSource[]} */
const DOC_SOURCES = Object.freeze([
  Object.freeze({ file: "README.md", label: "Overview", slug: "docs" }),
  Object.freeze({ file: "apply-rom-patches.md", label: "Apply patches", slug: "docs/apply-rom-patches" }),
  Object.freeze({ file: "create-rom-patches.md", label: "Create patches", slug: "docs/create-rom-patches" }),
  Object.freeze({ file: "fix-checksum-errors.md", label: "Fix checksum errors", slug: "docs/fix-checksum-errors" }),
  Object.freeze({ file: "patch-formats.md", label: "Patch formats", slug: "docs/patch-formats" }),
  Object.freeze({ file: "notices.md", label: "Notices", slug: "docs/notices" }),
  Object.freeze({ file: "privacy.md", label: "Privacy", slug: "docs/privacy" }),
]);

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

export { DOC_SOURCES, readDocsSlugFromPathname };
