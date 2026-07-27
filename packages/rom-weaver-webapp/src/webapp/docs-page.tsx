import { useEffect } from "react";
import applyRomPatchesMarkdown from "../../../../docs/guides/apply-rom-patches.md?raw";
import createRomPatchesMarkdown from "../../../../docs/guides/create-rom-patches.md?raw";
import fixChecksumErrorsMarkdown from "../../../../docs/guides/fix-checksum-errors.md?raw";
import overviewMarkdown from "../../../../docs/guides/README.md?raw";
import patchFormatsMarkdown from "../../../../docs/guides/patch-formats.md?raw";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { createDocRoute, DOC_SOURCES, renderMarkdown } from "./docs-content.mjs";
import { SITE_NAME } from "./workflow-seo.mjs";

const markdownByFile = new Map([
  ["README.md", overviewMarkdown],
  ["apply-rom-patches.md", applyRomPatchesMarkdown],
  ["create-rom-patches.md", createRomPatchesMarkdown],
  ["fix-checksum-errors.md", fixChecksumErrorsMarkdown],
  ["patch-formats.md", patchFormatsMarkdown],
]);

const DOC_ROUTES = DOC_SOURCES.map((source) => {
  const markdown = markdownByFile.get(source.file);
  if (markdown === undefined) throw new Error(`Missing Markdown source for ${source.file}`);
  return { ...createDocRoute(source, markdown), label: source.label };
});

const syncDocsSeoMetadata = (route: (typeof DOC_ROUTES)[number]) => {
  const siteName = CHANNEL_BADGE ? `${SITE_NAME} ${CHANNEL_BADGE}` : SITE_NAME;
  const title = `${route.title} | ${siteName}`;
  const canonicalUrl = `https://rom-weaver.com/${route.slug}`;
  document.title = title;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", route.description);
  document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.setAttribute("content", title);
  document
    .querySelector<HTMLMetaElement>('meta[property="og:description"]')
    ?.setAttribute("content", route.description);
  document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.setAttribute("content", "article");
  document.querySelector<HTMLMetaElement>('meta[property="og:url"]')?.setAttribute("content", canonicalUrl);
  document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]')?.setAttribute("content", title);
  document
    .querySelector<HTMLMetaElement>('meta[name="twitter:description"]')
    ?.setAttribute("content", route.description);
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
};

const findDocsRoute = (slug: string) => {
  const route = DOC_ROUTES.find((entry) => entry.slug === slug) ?? DOC_ROUTES.at(0);
  if (!route) throw new Error("Docs must define at least one route");
  return route;
};

const DocsPage = ({ active, slug }: { active: boolean; slug: string }) => {
  const route = findDocsRoute(slug);
  const hub = route.slug === "docs";
  useEffect(() => {
    if (!active) return;
    syncDocsSeoMetadata(route);
  }, [active, route]);
  return (
    <div className="docs-workbench" id="main">
      <nav aria-label="Breadcrumb" className="docs-breadcrumbs">
        <a href="/weave">{SITE_NAME}</a>
        <span aria-hidden="true">/</span>
        {hub ? (
          <span aria-current="page">Guides</span>
        ) : (
          <>
            <a href="/docs">Guides</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{route.title}</span>
          </>
        )}
      </nav>
      <div className="docs-layout">
        <nav aria-label="Guides" className="guide-nav">
          <span className="guide-nav-title">Guides</span>
          <ul className="guide-nav-list">
            {DOC_ROUTES.map((entry) => (
              <li key={entry.slug}>
                <a aria-current={entry.slug === route.slug ? "page" : undefined} href={`/${entry.slug}`}>
                  {entry.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <section className="docs-panel">
          <article
            className="docs-article"
            data-markdown-source={route.source}
            // The Markdown is committed project content, rendered by the same
            // parser at build time and in the lazy client route.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted repository Markdown is the page source
            dangerouslySetInnerHTML={{ __html: renderMarkdown(route.markdown, route.slug) }}
          />
          <aside className="docs-cta">
            <div>
              <h2>Ready to work with a patch?</h2>
              <p>Use the browser app without uploading your files.</p>
            </div>
            <div className="docs-cta-actions">
              <a className="btn primary" href="/weave">
                Apply patches
              </a>
              <a className="btn" href="/create">
                Create a patch
              </a>
            </div>
          </aside>
        </section>
      </div>
    </div>
  );
};

export { DocsPage };
