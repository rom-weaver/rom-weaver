import { marked } from "marked";
import { DOC_SOURCES } from "./docs-routing.mjs";

const REPOSITORY_DOCS_URL = "https://github.com/rom-weaver/rom-weaver/blob/main/docs";

/**
 * @typedef {{
 *   description: string,
 *   markdown: string,
 *   slug: string,
 *   source: string,
 *   title: string,
 * }} DocRoute
 */

/** @param {string} value */
const stripMarkdown = (value) =>
  value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * @param {{ file: string, slug: string }} source
 * @param {string} markdown
 * @returns {Readonly<DocRoute>}
 */
const createDocRoute = ({ file, slug }, markdown) => {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1];
  if (!title) throw new Error(`${file} must have one level-one heading`);
  const description = markdown
    .split(/\n\s*\n/)
    .map(stripMarkdown)
    .find((block) => block && !block.startsWith("#") && !block.startsWith("<!--"));
  if (!description) throw new Error(`${file} must start with a descriptive paragraph`);
  return Object.freeze({
    description,
    markdown,
    slug,
    source: `docs/guides/${file}`,
    title: stripMarkdown(title),
  });
};

/** @param {string} value */
const headingSlug = (value) =>
  value
    .replace(/<[^>]+>/g, "")
    .replaceAll("&amp;", "and")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/** @param {string} html */
const addHeadingIds = (html) => {
  const seen = new Map();
  return html.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (_match, level, content) => {
    const base = headingSlug(content);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
    return `<h${level} id="${id}">${content}</h${level}>`;
  });
};

/** @param {string} html @param {string} slug */
const rewriteDocLinks = (html, slug) => {
  let rewritten = html;
  for (const route of DOC_SOURCES) {
    rewritten = rewritten.replaceAll(`href="${route.file}"`, `href="/${route.slug}"`);
  }
  return rewritten
    .replaceAll('href="#', `href="/${slug}#`)
    .replaceAll(`href="../cli.md`, `href="${REPOSITORY_DOCS_URL}/cli.md`)
    .replaceAll(`href="../README.md`, `href="${REPOSITORY_DOCS_URL}/README.md`);
};

/** @param {string} markdown @param {string} slug */
const renderMarkdown = (markdown, slug) =>
  rewriteDocLinks(addHeadingIds(marked.parse(markdown, { async: false })), slug).replaceAll(
    "<pre>",
    '<pre tabindex="0">',
  );

export { createDocRoute, DOC_SOURCES, renderMarkdown };
