import { useEffect } from "react";
import { DOC_ROUTES } from "virtual:rom-weaver-docs";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { useActiveSection } from "./use-active-section.ts";
import { SITE_NAME } from "./workflow-seo.mjs";

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

/**
 * The warp: the lengthwise threads a piece is woven on. A guide's section order
 * is its own structural axis, so the rail carries the outline and marks the
 * section being read with a weft pick crossing the warp line.
 */
const SectionRail = ({ activeId, route }: { activeId: string; route: (typeof DOC_ROUTES)[number] }) => (
  <nav aria-label="On this page" className="warp-rail">
    <span className="warp-rail-title">On this page</span>
    <ol className="warp-rail-list">
      {route.sections.map((section, index) => (
        <li key={section.id}>
          <a aria-current={section.id === activeId ? "true" : undefined} href={`/${route.slug}#${section.id}`}>
            <span aria-hidden="true" className="warp-pick" />
            <span aria-hidden="true" className="warp-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="warp-label">{section.label}</span>
          </a>
        </li>
      ))}
    </ol>
  </nav>
);

const DocsPage = ({ active, slug }: { active: boolean; slug: string }) => {
  const route = findDocsRoute(slug);
  const hub = route.slug === "docs";
  const activeId = useActiveSection(route.sections, active);
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
            <span aria-current="page">{route.label}</span>
          </>
        )}
      </nav>
      <div className="docs-layout">
        <div className="docs-rails">
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
          {route.sections.length > 0 ? <SectionRail activeId={activeId} route={route} /> : null}
        </div>
        <section className="docs-panel">
          <article
            className="docs-article"
            data-markdown-source={route.source}
            // Committed repository Markdown, rendered to HTML at build time by
            // the same parser that feeds the prerendered page.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted repository Markdown is the page source
            dangerouslySetInnerHTML={{ __html: route.html }}
          />
          <aside className="docs-cta">
            <div>
              <h2>Try it in the browser</h2>
              <p>Nothing uploads. rom-weaver reads and writes your files on this device.</p>
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
