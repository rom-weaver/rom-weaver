import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { SITE_NAME } from "./workflow-seo.mjs";

const SITE_ORIGIN = "https://rom-weaver.com";
const REPOSITORY_DOCS_URL = "https://github.com/rom-weaver/rom-weaver/blob/main/docs";
const docsDirectory = path.resolve(import.meta.dirname, "../../../../docs/guides");

/** @typedef {{ file: string, slug: string }} DocSource */
/**
 * @typedef {{
 *   description: string,
 *   markdown: string,
 *   slug: string,
 *   source: string,
 *   title: string,
 * }} DocRoute
 */
/** @typedef {{ channel: string, channelLabel: string }} ChannelOptions */
/** @typedef {DocRoute & ChannelOptions} RenderPageOptions */

/** @type {readonly DocSource[]} */
const DOC_SOURCES = Object.freeze([
  Object.freeze({ file: "README.md", slug: "docs" }),
  Object.freeze({ file: "apply-rom-patches.md", slug: "docs/apply-rom-patches" }),
  Object.freeze({ file: "create-rom-patches.md", slug: "docs/create-rom-patches" }),
  Object.freeze({ file: "fix-checksum-errors.md", slug: "docs/fix-checksum-errors" }),
  Object.freeze({ file: "patch-formats.md", slug: "docs/patch-formats" }),
]);

/** @param {string} value */
const stripMarkdown = (value) =>
  value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** @param {DocSource} source */
const readDoc = ({ file, slug }) => {
  const markdown = fs.readFileSync(path.join(docsDirectory, file), "utf8");
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

/** @type {readonly DocRoute[]} */
const DOC_ROUTES = Object.freeze(DOC_SOURCES.map(readDoc));

/** @param {unknown} value */
const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

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

/** @param {string} html */
const rewriteDocLinks = (html) => {
  let rewritten = html;
  for (const route of DOC_ROUTES) {
    const file = route.source.split("/").at(-1);
    rewritten = rewritten.replaceAll(`href="${file}"`, `href="/${route.slug}"`);
  }
  return rewritten
    .replaceAll(`href="../cli.md`, `href="${REPOSITORY_DOCS_URL}/cli.md`)
    .replaceAll(`href="../README.md`, `href="${REPOSITORY_DOCS_URL}/README.md`);
};

/** @param {string} markdown */
const renderMarkdown = (markdown) =>
  rewriteDocLinks(addHeadingIds(marked.parse(markdown, { async: false }))).replaceAll("<pre>", '<pre tabindex="0">');

const DOCS_STYLES = `
  :root {
    color-scheme: dark light;
    --accent: #ef7d32;
    --accent-strong: #ff9a55;
    --bg: #0c0f13;
    --panel: #14181e;
    --panel-2: #1a2028;
    --seam: #323b47;
    --ink: #f2eee6;
    --muted: #abb4bf;
    --code: #080a0d;
    --shadow: rgba(0, 0, 0, 0.28);
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background:
      radial-gradient(circle at 85% -10%, rgba(217, 105, 15, 0.13), transparent 28rem),
      var(--bg);
    color: var(--ink);
    font: 500 1rem/1.7 Arial, "Helvetica Neue", system-ui, sans-serif;
    text-rendering: optimizeLegibility;
  }
  a { color: var(--accent-strong); text-underline-offset: 0.2em; }
  a:hover { color: var(--ink); }
  a:focus-visible, .button:focus-visible {
    outline: 3px solid var(--accent);
    outline-offset: 3px;
  }
  .skip {
    position: fixed;
    z-index: 10;
    inset: 0 auto auto 1rem;
    padding: 0.7rem 1rem;
    background: var(--ink);
    color: var(--bg);
    transform: translateY(-120%);
  }
  .skip:focus { transform: translateY(0); }
  .site-header {
    border-bottom: 1px solid var(--seam);
    background: color-mix(in srgb, var(--bg) 90%, transparent);
    backdrop-filter: blur(14px);
  }
  .site-header-inner, .page, .site-footer {
    width: min(100% - 2rem, 70rem);
    margin-inline: auto;
  }
  .site-header-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 4.5rem;
    gap: 1.5rem;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    color: var(--ink);
    font-size: 1.1rem;
    font-weight: 800;
    letter-spacing: -0.025em;
    text-decoration: none;
  }
  .brand img { width: 2rem; height: 2rem; }
  .channel {
    padding: 0.12rem 0.45rem;
    border: 1px solid var(--seam);
    border-radius: 999px;
    color: var(--muted);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .site-nav { display: flex; align-items: center; gap: 1.15rem; }
  .site-nav a {
    color: var(--muted);
    font-size: 0.88rem;
    font-weight: 700;
    text-decoration: none;
  }
  .site-nav a[aria-current="page"], .site-nav a:hover { color: var(--ink); }
  .page { padding-block: 2.5rem 5rem; }
  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 2.25rem;
    color: var(--muted);
    font-size: 0.82rem;
  }
  .breadcrumbs a { color: inherit; }
  .docs-article { max-width: 52rem; }
  h1, h2, h3 {
    line-height: 1.15;
    letter-spacing: -0.035em;
    text-wrap: balance;
  }
  h1 {
    max-width: 18ch;
    margin: 0 0 1.25rem;
    font-size: clamp(2.35rem, 7vw, 4.8rem);
  }
  h2 {
    margin: 3rem 0 1rem;
    padding-top: 2.25rem;
    border-top: 1px solid var(--seam);
    font-size: clamp(1.55rem, 3vw, 2.15rem);
  }
  h3 { margin-top: 2rem; font-size: 1.25rem; }
  h1 + p {
    max-width: 48rem;
    margin-bottom: 2.5rem;
    color: var(--muted);
    font-size: 1.17rem;
  }
  p, li { max-width: 47rem; }
  li { margin-block: 0.4rem; }
  strong { color: var(--ink); }
  code {
    padding: 0.1rem 0.34rem;
    border: 1px solid var(--seam);
    border-radius: 0.25rem;
    background: var(--code);
    color: var(--ink);
    font: 0.88em ui-monospace, "SFMono-Regular", Consolas, monospace;
  }
  :not(pre) > code { overflow-wrap: anywhere; }
  pre {
    overflow-x: auto;
    padding: 1rem 1.2rem;
    border: 1px solid var(--seam);
    border-radius: 0.55rem;
    background: var(--code);
  }
  pre code { padding: 0; border: 0; }
  blockquote {
    margin-inline: 0;
    padding: 0.75rem 1.2rem;
    border-left: 0.35rem solid var(--accent);
    background: var(--panel);
    color: var(--muted);
  }
  .cta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    max-width: 52rem;
    margin-top: 3.5rem;
    padding: 1.5rem;
    border: 1px solid var(--seam);
    border-radius: 0.75rem;
    background: linear-gradient(145deg, var(--panel-2), var(--panel));
    box-shadow: 0 1rem 3rem var(--shadow);
  }
  .cta h2 { margin: 0; padding: 0; border: 0; font-size: 1.35rem; }
  .cta p { margin: 0.3rem 0 0; color: var(--muted); }
  .cta-actions { display: flex; flex: none; gap: 0.7rem; }
  .button {
    display: inline-flex;
    align-items: center;
    min-height: 2.75rem;
    padding: 0.55rem 0.9rem;
    border: 1px solid var(--accent);
    border-radius: 0.45rem;
    background: var(--accent);
    color: #140a02;
    font-weight: 800;
    text-decoration: none;
  }
  .button:hover { background: var(--accent-strong); color: #140a02; }
  .button.secondary { background: transparent; color: var(--ink); }
  .site-footer {
    display: flex;
    justify-content: space-between;
    gap: 1.5rem;
    padding-block: 2rem;
    border-top: 1px solid var(--seam);
    color: var(--muted);
    font-size: 0.8rem;
  }
  .site-footer nav { display: flex; gap: 1rem; }
  .site-footer a { color: inherit; }
  @media (prefers-color-scheme: light) {
    :root {
      --accent: #b84e08;
      --accent-strong: #9b3f05;
      --bg: #ece9e1;
      --panel: #f8f5ed;
      --panel-2: #e4dfd3;
      --seam: #c0b9ac;
      --ink: #1a2027;
      --muted: #59616b;
      --code: #e1dcd0;
      --shadow: rgba(44, 37, 28, 0.08);
    }
  }
  @media (max-width: 48rem) {
    .site-header-inner {
      align-items: flex-start;
      flex-direction: column;
      padding-block: 1rem;
    }
    .site-nav { width: 100%; justify-content: space-between; }
    .page { padding-top: 1.8rem; }
    .cta { align-items: flex-start; flex-direction: column; }
    .site-footer { flex-direction: column; }
  }
  @media (max-width: 31rem) {
    .site-nav { gap: 0.7rem; }
    .site-nav a { font-size: 0.78rem; }
    .cta-actions { width: 100%; flex-direction: column; }
    .button { justify-content: center; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { transition: none !important; }
  }
`;

/** @param {Pick<RenderPageOptions, "channel" | "channelLabel" | "description" | "slug" | "title">} options */
const renderHead = ({ channel, channelLabel, description, slug, title }) => {
  const production = channel === "prod";
  const displayTitle = production ? `${title} | ${SITE_NAME}` : `${title} | ${SITE_NAME} ${channelLabel}`;
  const url = `${SITE_ORIGIN}/${slug}`;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    description,
    headline: title,
    publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_ORIGIN },
    url,
  };
  return `
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(displayTitle)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="${production ? "index, follow" : "noindex, nofollow"}" />
    <meta name="theme-color" content="#0c0f13" />
    <meta name="color-scheme" content="dark light" />
    <link rel="canonical" href="${url}" />
    <link rel="icon" href="/logo.svg" type="image/svg+xml" />
    <meta property="og:site_name" content="${SITE_NAME}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(displayTitle)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${SITE_ORIGIN}/social-preview.png" />
    <meta property="og:image:alt" content="${SITE_NAME} browser ROM patching toolkit" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(displayTitle)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${SITE_ORIGIN}/social-preview.png" />
    <script type="application/ld+json">${JSON.stringify(structuredData)}</script>
    <style>${DOCS_STYLES}</style>`;
};

/**
 * @param {string} channel
 * @param {string} channelLabel
 */
const renderHeader = (channel, channelLabel) => `
  <header class="site-header">
    <div class="site-header-inner">
      <a class="brand" href="/weave" aria-label="${SITE_NAME} patcher">
        <img src="/logo.svg" alt="" width="32" height="32" />
        <span>${SITE_NAME}</span>
        ${channel === "prod" ? "" : `<span class="channel">${escapeHtml(channelLabel)}</span>`}
      </a>
      <nav class="site-nav" aria-label="Main navigation">
        <a href="/weave">Apply patches</a>
        <a href="/create">Create a patch</a>
        <a href="/docs" aria-current="page">Docs</a>
      </nav>
    </div>
  </header>`;

const renderFooter = () => `
  <footer class="site-footer">
    <span>Files are processed locally on your device.</span>
    <nav aria-label="Footer navigation">
      <a href="/weave">Patcher</a>
      <a href="/create">Patch creator</a>
      <a href="https://github.com/rom-weaver/rom-weaver">GitHub</a>
    </nav>
  </footer>`;

/** @param {RenderPageOptions} options */
const renderPage = ({ channel, channelLabel, description, markdown, slug, source, title }) => {
  const hub = slug === "docs";
  return `<!doctype html>
<html lang="en">
  <head>${renderHead({ channel, channelLabel, description, slug, title })}
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    ${renderHeader(channel, channelLabel)}
    <main class="page" id="main">
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <a href="/weave">${SITE_NAME}</a><span aria-hidden="true">/</span>
        ${hub ? "<span>Docs</span>" : `<a href="/docs">Docs</a><span aria-hidden="true">/</span><span>${escapeHtml(title)}</span>`}
      </nav>
      <article class="docs-article" data-markdown-source="${escapeHtml(source)}">
        ${renderMarkdown(markdown)}
      </article>
      <aside class="cta">
        <div>
          <h2>Ready to work with a patch?</h2>
          <p>Use the browser app without uploading your files.</p>
        </div>
        <div class="cta-actions">
          <a class="button" href="/weave">Apply patches</a>
          <a class="button secondary" href="/create">Create a patch</a>
        </div>
      </aside>
    </main>
    ${renderFooter()}
  </body>
</html>
`;
};

/** @param {ChannelOptions} options */
const renderDocsPages = ({ channel, channelLabel }) =>
  new Map(DOC_ROUTES.map((route) => [route.slug, renderPage({ channel, channelLabel, ...route })]));

export { DOC_ROUTES, renderDocsPages };
