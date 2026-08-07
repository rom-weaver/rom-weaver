import { Marked, Parser, Renderer } from "marked";
import { docGroupTitle, DOC_SOURCES, SITE_ORIGIN } from "./docs-routing.mjs";

// Build-time only. `marked` must never reach a browser bundle: the client
// imports already-rendered HTML from `virtual:rom-weaver-docs` instead. Build
// tooling sits outside the webapp's shipped dependency graph, so anything
// imported here is absent from the generated attribution inventories.

const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver/blob/main";

/**
 * @typedef {{ id: string, label: string }} DocSection
 * @typedef {{
 *   description: string,
 *   group: string,
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

/** @param {import("marked").Token[]} tokens @returns {string} */
const plainHeading = (tokens) =>
  decodeHeadingEntities(
    tokens
      .map((token) => {
        if (token.type === "html") return "";
        if ("tokens" in token && token.tokens) return plainHeading(token.tokens);
        if (token.type === "br") return " ";
        return "text" in token ? token.text : "";
      })
      .join(""),
  )
    .replace(/\s+/g, " ")
    .trim();

/** @param {string} value */
const headingSlug = (value) =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

/**
 * Raw HTML remains available to the trusted, repository-owned document body,
 * but headings feed both HTML and navigation metadata, so only Markdown inline
 * formatting is rendered there.
 *
 * The inline lexer marks text inside a `<script>` or `<pre>` as `escaped`,
 * which tells the default renderer to emit the source verbatim. That only holds
 * while the surrounding tags survive, so clearing the flag hands the text back
 * to marked's own escaping rather than reimplementing it here.
 */
/**
 * @param {{ unwrapLinks?: boolean }} [options] `unwrapLinks` renders a link as
 * its label text. Section headings need it because they are wrapped in their
 * own self-link, and a nested `<a>` would make the HTML parser split the outer
 * one mid-heading.
 */
const createHeadingRenderer = ({ unwrapLinks = false } = {}) => {
  const renderer = new Renderer();
  renderer.html = () => "";
  renderer.text = (token) =>
    Renderer.prototype.text.call(renderer, "escaped" in token && token.escaped ? { ...token, escaped: false } : token);
  if (unwrapLinks) {
    renderer.link = function unwrapLink(token) {
      return this.parser.parseInline(token.tokens);
    };
  }
  return renderer;
};

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
  if (repositoryPath.startsWith("docs/screenshots/")) {
    return `/docs/screenshots/${repositoryPath.split("/").at(-1)}`;
  }
  return href;
};

// Lucide's `link` glyph (https://lucide.dev/icons/link), inlined because this
// HTML is a marked render-time string, so the lucide-react component the rest
// of the app uses cannot mount here.
const SECTION_LINK_ICON =
  '<svg aria-hidden="true" class="docs-section-link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

/**
 * @param {string} markdown @param {string} slug @param {string} sourceFile
 * @returns {{ html: string, sections: DocSection[] }}
 */
const renderMarkdown = (markdown, slug, sourceFile) => {
  const seen = new Map();
  /** @type {DocSection[]} */
  const sections = [];
  const defaultRenderer = new Renderer();
  // `Parser.parseInline` rebinds `renderer.parser` on every call, so the
  // heading renderer stays local to one render rather than being shared.
  const headingRenderer = createHeadingRenderer();
  const sectionHeadingRenderer = createHeadingRenderer({ unwrapLinks: true });
  const parser = new Marked({
    renderer: {
      code(token) {
        defaultRenderer.parser = this.parser;
        return defaultRenderer.code(token).replace("<pre>", '<pre tabindex="0">');
      },
      // Narrow viewports turn a wide table into its own scroll region, which a
      // keyboard user can only reach if it can take focus.
      table(token) {
        defaultRenderer.parser = this.parser;
        return defaultRenderer.table(token).replace("<table>", '<table tabindex="0">');
      },
      heading({ depth, tokens }) {
        const label = plainHeading(tokens);
        const base = headingSlug(label);
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        if (depth === 2) {
          sections.push({ id, label });
          const html = Parser.parseInline(tokens, { renderer: sectionHeadingRenderer });
          return `<h2 id="${id}"><a class="docs-section-link" href="/${slug}#${id}">${SECTION_LINK_ICON}<span class="docs-section-title">${html}</span></a></h2>\n`;
        }
        return `<h${depth} id="${id}">${Parser.parseInline(tokens, { renderer: headingRenderer })}</h${depth}>\n`;
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
 * @param {{ file: string, group?: string, label: string, slug: string }} source
 * @param {string} markdown
 * @returns {Readonly<DocRoute>}
 */
const createDocRoute = ({ file, group, label, slug }, markdown) => {
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
    group: group ?? docGroupTitle(file),
    html,
    label,
    sections: Object.freeze(sections),
    slug,
    source: `docs/${file}`,
    title: stripMarkdown(title),
  });
};

export { createDocRoute, DOC_SOURCES };
