import { Marked, Renderer } from "marked";
import { DOC_SOURCES, SITE_ORIGIN } from "./docs-routing.mjs";

// Build-time only. `marked` must never reach a browser bundle: the client
// imports already-rendered HTML from `virtual:rom-weaver-docs` instead. Build
// tooling sits outside the webapp's shipped dependency graph, so anything
// imported here is absent from the generated attribution inventories.

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver/blob/main";

/**
 * @typedef {{ id: string, label: string }} DocSection
 * @typedef {{
 *   description: string,
 *   html: string,
 *   label: string,
 *   sections: readonly DocSection[],
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

// doctoc owns the in-file table of contents so the guides read well on GitHub.
// The published pages navigate by the section rail instead, so the generated
// block is dropped rather than rendered as a second copy of the outline.
const DOCTOC_BLOCK = /<!--\s*START doctoc[\s\S]*?<!--\s*END doctoc\s*-->/i;

/** @param {string} markdown */
const stripDoctoc = (markdown) => markdown.replace(DOCTOC_BLOCK, "").replace(/\n{3,}/g, "\n\n");

/** Entities marked emits would otherwise leak their digits into a slug ("&#39;" -> "39"). */
const HEADING_ENTITIES = /** @type {Record<string, string>} */ ({
  amp: " and ",
  apos: "",
  gt: " ",
  lt: " ",
  nbsp: " ",
  quot: "",
});

/** @param {string} value */
const decodeHeadingEntities = (value) =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, reference) => {
    const name = String(reference).toLowerCase();
    const named = HEADING_ENTITIES[name];
    if (named !== undefined) return named;
    if (!name.startsWith("#")) return " ";
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
  });

/** @param {string} value */
const plainHeading = (value) => stripMarkdown(decodeHeadingEntities(value.replace(/<[^>]+>/g, "")));

/** @param {string} value */
const headingSlug = (value) =>
  plainHeading(value)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/**
 * Guide links are authored as repository-relative paths so the Markdown also
 * reads correctly on GitHub; the published pages rewrite them to routes. The
 * parser supplies the href separately, so anchored links like
 * `patch-formats.md#ips` follow the same path as a bare file link.
 *
 * Links to the app are authored against the production origin for the same
 * reason, and come out root-relative so a page served from beta, nightly, or a
 * PR preview keeps the reader on that deployment instead of bouncing them to
 * production.
 *
 * @param {string} href @param {string} slug @param {string} sourceFile
 */
const rewriteDocHref = (href, slug, sourceFile) => {
  if (href.startsWith(`${SITE_ORIGIN}/`)) return href.slice(SITE_ORIGIN.length);
  if (href.startsWith("#")) return `/${slug}${href}`;
  if (/^(?:[a-z]+:|\/\/)/i.test(href)) return href;

  const resolved = new URL(href, `https://repository.invalid/docs/${sourceFile}`);
  if (!resolved.pathname.endsWith(".md")) return href;
  const repositoryPath = resolved.pathname.slice(1);
  const docsPath = repositoryPath.startsWith("docs/") ? repositoryPath.slice("docs/".length) : "";
  const route = DOC_SOURCES.find((entry) => entry.file === docsPath);
  if (route) return `/${route.slug}${resolved.hash}`;
  return `${REPOSITORY_URL}/${repositoryPath}${resolved.hash}`;
};

/** @param {string} href @param {string} sourceFile */
const rewriteDocImage = (href, sourceFile) => {
  if (/^(?:[a-z]+:|\/\/|data:)/i.test(href)) return href;
  const resolved = new URL(href, `https://repository.invalid/docs/${sourceFile}`);
  const repositoryPath = resolved.pathname.slice(1);
  if (repositoryPath.startsWith("packages/rom-weaver-webapp/design/")) {
    return `/docs/screenshots/${repositoryPath.split("/").at(-1)}`;
  }
  return href;
};

/**
 * @param {string} markdown @param {string} slug @param {string} sourceFile
 * @returns {{ html: string, sections: DocSection[] }}
 */
const renderMarkdown = (markdown, slug, sourceFile) => {
  const seen = new Map();
  /** @type {DocSection[]} */
  const sections = [];
  const defaultRenderer = new Renderer();
  const parser = new Marked({
    renderer: {
      code(token) {
        defaultRenderer.parser = this.parser;
        return defaultRenderer.code(token).replace("<pre>", '<pre tabindex="0">');
      },
      heading({ depth, text, tokens }) {
        const base = headingSlug(text);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        if (depth === 2) sections.push({ id, label: plainHeading(text) });
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
    walkTokens(token) {
      if (token.type === "link") token.href = rewriteDocHref(token.href, slug, sourceFile);
      if (token.type === "image") token.href = rewriteDocImage(token.href, sourceFile);
    },
  });
  return { html: parser.parse(stripDoctoc(markdown), { async: false }), sections };
};

/**
 * @param {{ file: string, label: string, slug: string }} source
 * @param {string} markdown
 * @returns {Readonly<DocRoute>}
 */
const createDocRoute = ({ file, label, slug }, markdown) => {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1];
  if (!title) throw new Error(`${file} must have one level-one heading`);
  const description = stripDoctoc(markdown)
    .split(/\n\s*\n/)
    .map(stripMarkdown)
    .find((block) => block && !block.startsWith("#") && !block.startsWith("<!--"));
  if (!description) throw new Error(`${file} must start with a descriptive paragraph`);
  const { html, sections } = renderMarkdown(markdown, slug, file);
  return Object.freeze({
    description,
    html,
    label,
    sections: Object.freeze(sections),
    slug,
    source: `docs/${file}`,
    title: stripMarkdown(title),
  });
};

export { createDocRoute, DOC_SOURCES };
