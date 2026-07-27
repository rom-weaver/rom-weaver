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
/**
 * @typedef {{
 *   accent: string,
 *   channel: string,
 *   channelLabel: string,
 *   reactShell: string,
 *   stylesheetHref: string,
 * }} ChannelOptions
 */
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
  html { scroll-behavior: smooth; }
  body { margin: 0; min-width: 20rem; background: var(--chassis); }
  .docs-app { min-height: 100dvh; }
  .docs-app .skip {
    position: fixed;
    z-index: 20;
    inset: 0 auto auto 1rem;
    padding: .65rem .9rem;
    border-radius: 0 0 var(--r-s) var(--r-s);
    background: var(--thread);
    color: var(--thread-ink);
    font-size: .82rem;
    font-weight: 700;
    transform: translateY(-120%);
  }
  .docs-app .skip:focus { transform: translateY(0); }
  .docs-app .mode-thumb { display: none; }
  .docs-app .mode { color: var(--ink-2); }
  .docs-app .masthead-tools .tool[aria-current="page"] {
    border-color: color-mix(in oklab, var(--thread) 45%, var(--seam));
    background: color-mix(in oklab, var(--thread) 10%, var(--well));
    color: var(--thread-text);
  }
  .docs-workbench {
    flex: 1 0 auto;
    padding-block: var(--sp-m) clamp(40px, 8vw, 72px);
  }
  .docs-breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-s);
    margin: 0 0 var(--sp-m);
    color: var(--ink-3);
    font-size: .7rem;
    font-weight: 650;
    letter-spacing: .06em;
    text-transform: uppercase;
  }
  .docs-breadcrumbs a { color: var(--ink-3); }
  .docs-layout {
    display: grid;
    grid-template-columns: 11.5rem minmax(0, 1fr);
    align-items: start;
    gap: var(--sp-l);
  }
  .guide-nav {
    position: sticky;
    top: var(--sp-l);
    overflow: hidden;
    border: 1px solid var(--seam);
    border-radius: var(--r-m);
    background: var(--plate);
  }
  .guide-nav-title {
    display: block;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--seam-soft);
    color: var(--ink-3);
    font-size: .68rem;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
  }
  .guide-nav-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 5px;
    list-style: none;
  }
  .guide-nav-list li { margin: 0; }
  .guide-nav-list a {
    display: block;
    padding: 8px 9px;
    border-radius: var(--r-s);
    color: var(--ink-2);
    font-size: .76rem;
    font-weight: 600;
    line-height: 1.3;
  }
  .guide-nav-list a[aria-current="page"] {
    background:
      var(--warp-lines),
      color-mix(in oklab, var(--thread) 10%, var(--well));
    color: var(--thread-text);
  }
  .docs-panel {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--seam);
    border-radius: var(--r-l);
    background: var(--plate);
    box-shadow: 0 18px 50px -38px rgb(0 0 0 / .7);
  }
  .docs-article { padding: clamp(22px, 5vw, 44px); }
  .docs-article h1,
  .docs-article h2,
  .docs-article h3 {
    color: var(--ink);
    font-stretch: 96%;
    letter-spacing: -.025em;
    line-height: 1.15;
    text-wrap: balance;
  }
  .docs-article h1 {
    max-width: 20ch;
    margin: 0 0 var(--sp-m);
    font-size: clamp(1.9rem, 1.35rem + 2.4vw, 2.75rem);
    font-weight: 750;
  }
  .docs-article h1::before {
    display: block;
    width: 3.5rem;
    height: 4px;
    margin-bottom: var(--sp-m);
    border-radius: 999px;
    background: var(--thread);
    content: "";
  }
  .docs-article h2 {
    margin: clamp(34px, 7vw, 52px) 0 var(--sp-m);
    padding-top: var(--sp-xl);
    border-top: 1px solid var(--seam-soft);
    font-size: clamp(1.3rem, 1.08rem + .9vw, 1.65rem);
    font-weight: 700;
  }
  .docs-article h3 {
    margin: var(--sp-xl) 0 var(--sp-s);
    font-size: 1.05rem;
    font-weight: 700;
  }
  .docs-article h1 + p {
    margin: 0 0 var(--sp-xl);
    color: var(--ink-2);
    font-size: 1.02rem;
    line-height: 1.65;
  }
  .docs-article p,
  .docs-article li {
    color: var(--ink-2);
    line-height: 1.65;
  }
  .docs-article p { margin-block: var(--sp-m); }
  .docs-article ul,
  .docs-article ol { padding-inline-start: 1.35rem; }
  .docs-article li { margin-block: var(--sp-s); padding-inline-start: .25rem; }
  .docs-article strong { color: var(--ink); font-weight: 700; }
  .docs-article a {
    color: var(--thread-text);
    font-weight: 600;
    text-decoration: underline;
    text-decoration-color: color-mix(in oklab, var(--thread) 55%, transparent);
    text-underline-offset: .18em;
  }
  .docs-article h2:first-of-type + ul {
    columns: 2 13rem;
    column-gap: var(--sp-xl);
    margin: 0 0 var(--sp-xl);
    padding: var(--sp-m) var(--sp-l) var(--sp-m) 2rem;
    border: 1px solid var(--seam-soft);
    border-radius: var(--r-m);
    background: var(--well);
  }
  .docs-article code {
    padding: .1rem .3rem;
    border: 1px solid var(--seam-soft);
    border-radius: 4px;
    background: var(--well);
    color: var(--weft);
    font: .87em/1.5 var(--mono);
  }
  .docs-article :not(pre) > code { overflow-wrap: anywhere; }
  .docs-article pre {
    overflow-x: auto;
    margin-block: var(--sp-l);
    padding: var(--sp-l);
    border: 1px solid var(--seam);
    border-radius: var(--r-m);
    background: var(--well);
  }
  .docs-article pre code { padding: 0; border: 0; background: transparent; color: var(--ink-2); }
  .docs-article blockquote {
    margin: var(--sp-l) 0;
    padding: var(--sp-m) var(--sp-l);
    border: 1px solid var(--seam-soft);
    border-left: 3px solid var(--thread);
    border-radius: 0 var(--r-s) var(--r-s) 0;
    background: var(--plate-2);
  }
  .docs-article blockquote > :first-child { margin-top: 0; }
  .docs-article blockquote > :last-child { margin-bottom: 0; }
  .docs-cta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-l);
    padding: var(--sp-l) clamp(22px, 5vw, 44px);
    border-top: 1px solid var(--seam);
    background:
      var(--warp-lines),
      color-mix(in oklab, var(--thread) 4%, var(--plate-2));
  }
  .docs-cta h2 {
    margin: 0;
    color: var(--ink);
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -.01em;
  }
  .docs-cta p { margin: 3px 0 0; color: var(--ink-3); font-size: .78rem; }
  .docs-cta-actions { display: flex; flex: none; gap: var(--sp-s); }
  .docs-app .docs-cta .btn { text-decoration: none; }
  @media (max-width: 720px) {
    .docs-layout { grid-template-columns: minmax(0, 1fr); }
    .guide-nav { position: static; }
    .guide-nav-list {
      display: flex;
      overflow-x: auto;
      padding: 5px;
      scrollbar-width: thin;
    }
    .guide-nav-list li { flex: none; }
    .guide-nav-list a { white-space: nowrap; }
  }
  @media (max-width: 520px) {
    .docs-article { padding: 22px 18px 28px; }
    .docs-article h2:first-of-type + ul { columns: auto; }
    .docs-cta { align-items: stretch; flex-direction: column; padding: 18px; }
    .docs-cta-actions { display: grid; grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after { transition: none !important; }
  }
`;

const renderAppearanceScript = () => `
    <script>
      (() => {
        try {
          const savedTheme = localStorage.getItem("rom-weaver-theme");
          const theme = savedTheme === "dark" || savedTheme === "light"
            ? savedTheme
            : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
          document.documentElement.dataset.theme = theme;
          const settings = JSON.parse(localStorage.getItem("rom-weaver-settings") || "null");
          const savedAccent = settings?.common?.accent;
          const accents = ["madder", "woad", "verdigris", "plum", "ochre"];
          const accent = accents.includes(savedAccent) ? savedAccent : document.documentElement.dataset.accent;
          if (accent === "madder") delete document.documentElement.dataset.accent;
          else if (accent) document.documentElement.dataset.accent = accent;
        } catch {
          document.documentElement.dataset.theme = "dark";
        }
      })();
    </script>`;

/**
 * @param {Pick<
 *   RenderPageOptions,
 *   "channel" | "channelLabel" | "description" | "slug" | "stylesheetHref" | "title"
 * >} options
 */
const renderHead = ({ channel, channelLabel, description, slug, stylesheetHref, title }) => {
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
    ${renderAppearanceScript()}
    <link rel="stylesheet" href="${escapeHtml(stylesheetHref)}" />
    <style>${DOCS_STYLES}</style>`;
};

/** @param {string} reactShell */
const renderMasthead = (reactShell) => {
  let masthead = reactShell.match(/<header class="masthead">[\s\S]*?<\/header>/)?.[0];
  if (!masthead) throw new Error("The prerendered React shell must contain the app masthead");

  for (const [button] of masthead.matchAll(/(<button[\s\S]*?<\/button>)/g)) {
    if (!button.includes("ico-sun")) masthead = masthead.replace(button, "");
  }

  return masthead
    .replace('<header class="masthead">', '<header class="masthead" data-react-shell="masthead">')
    .replace('<h1 class="brand-word">', '<span class="brand-word">')
    .replace("</h1>", "</span>")
    .replaceAll('href="weave"', 'href="/weave"')
    .replaceAll('href="create"', 'href="/create"')
    .replaceAll('href="tools"', 'href="/tools"')
    .replace('href="docs"', 'aria-current="page" href="/docs"')
    .replace(/\saria-controls="[^"]*"/g, "")
    .replace(/\saria-orientation="horizontal"/g, "")
    .replace(/\saria-selected="(?:true|false)"/g, "")
    .replace(/\srole="tablist"/g, "")
    .replace(/\srole="tab"/g, "")
    .replace(/\stabindex="[^"]*"/g, "");
};

const GUIDE_LABELS = Object.freeze([
  "Overview",
  "Apply patches",
  "Create patches",
  "Fix checksum errors",
  "Patch formats",
]);

/** @param {string} slug */
const renderGuideNav = (slug) => `
  <nav class="guide-nav" aria-label="Guides">
    <span class="guide-nav-title">Guides</span>
    <ul class="guide-nav-list">
      ${DOC_ROUTES.map(
        (route, index) =>
          `<li><a href="/${route.slug}"${route.slug === slug ? ' aria-current="page"' : ""}>${GUIDE_LABELS[index]}</a></li>`,
      ).join("")}
    </ul>
  </nav>`;

const renderShellScript = () => `
  <script>
    (() => {
      const root = document.documentElement;
      const themeButton = document.querySelector(".masthead-tools button:has(.ico-sun)");
      const syncThemeButton = () => {
        if (!themeButton) return;
        const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
        const label = \`Switch to \${nextTheme} theme\`;
        themeButton.setAttribute("aria-label", label);
        themeButton.setAttribute("title", label);
        document.querySelector('meta[name="theme-color"]')?.setAttribute(
          "content",
          root.dataset.theme === "dark" ? "#0c0f13" : "#ece9e1",
        );
      };
      themeButton?.addEventListener("click", () => {
        root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
        try {
          localStorage.setItem("rom-weaver-theme", root.dataset.theme);
        } catch {}
        syncThemeButton();
      });
      const threads = document.querySelector(".masthead-threads");
      if (threads && navigator.hardwareConcurrency) {
        threads.textContent = \`\${navigator.hardwareConcurrency} threads\`;
      }
      syncThemeButton();
    })();
  </script>`;

/** @param {RenderPageOptions} options */
const renderPage = ({
  accent,
  channel,
  channelLabel,
  description,
  markdown,
  reactShell,
  slug,
  source,
  stylesheetHref,
  title,
}) => {
  const hub = slug === "docs";
  const accentAttribute = accent === "madder" ? "" : ` data-accent="${escapeHtml(accent)}"`;
  return `<!doctype html>
<html${accentAttribute} lang="en" translate="no">
  <head>${renderHead({ channel, channelLabel, description, slug, stylesheetHref, title })}
  </head>
  <body>
    <div class="rw-app docs-app" id="column">
      <a class="skip" href="#main">Skip to content</a>
      <div class="app">
        ${renderMasthead(reactShell)}
        <main class="docs-workbench" id="main">
          <nav class="docs-breadcrumbs" aria-label="Breadcrumb">
            <a href="/weave">${SITE_NAME}</a><span aria-hidden="true">/</span>
            ${
              hub
                ? '<span aria-current="page">Guides</span>'
                : `<a href="/docs">Guides</a><span aria-hidden="true">/</span><span aria-current="page">${escapeHtml(title)}</span>`
            }
          </nav>
          <div class="docs-layout">
            ${renderGuideNav(slug)}
            <section class="docs-panel">
              <article class="docs-article" data-markdown-source="${escapeHtml(source)}">
                ${renderMarkdown(markdown)}
              </article>
              <aside class="docs-cta">
                <div>
                  <h2>Ready to work with a patch?</h2>
                  <p>Use the browser app without uploading your files.</p>
                </div>
                <div class="docs-cta-actions">
                  <a class="btn primary" href="/weave">Apply patches</a>
                  <a class="btn" href="/create">Create a patch</a>
                </div>
              </aside>
            </section>
          </div>
        </main>
      </div>
    </div>
    ${renderShellScript()}
  </body>
</html>
`;
};

/** @param {ChannelOptions} options */
const renderDocsPages = (options) =>
  new Map(DOC_ROUTES.map((route) => [route.slug, renderPage({ ...options, ...route })]));

export { DOC_ROUTES, renderDocsPages };
