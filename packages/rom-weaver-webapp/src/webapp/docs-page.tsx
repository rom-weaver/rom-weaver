import "./design-system/docs-route.css";
import { ChevronUp } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DOC_ROUTES } from "virtual:rom-weaver-docs";
import { CHANNEL_BADGE } from "./build-channel.ts";
import { Modal } from "../public/react/components/ds/modal.tsx";
import { useRomWeaverAssetBaseUrl } from "../public/react/settings-context.tsx";
import { createDocsSeoMetadata, groupDocRoutes } from "./docs-routing.mjs";
import { AUTHORED_SAMPLE_BASE, retargetSampleUrls } from "./docs-sample-origin.ts";
import { useReadingProgress } from "./use-reading-progress.ts";
import { SITE_NAME } from "./workflow-seo.mjs";

type DocRoute = (typeof DOC_ROUTES)[number];

/** Shelves are fixed at build time; the route table never changes at runtime. */
const DOC_SHELVES = groupDocRoutes(DOC_ROUTES);

const syncDocsSeoMetadata = (route: DocRoute) => {
  const { canonicalUrl, metadata, title } = createDocsSeoMetadata(route, CHANNEL_BADGE);
  document.title = title;
  for (const [attribute, name, content] of metadata) {
    document.querySelector<HTMLMetaElement>(`meta[${attribute}="${name}"]`)?.setAttribute("content", content);
  }
  document.querySelector<HTMLMetaElement>('meta[property="og:type"]')?.setAttribute("content", "article");
  document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.setAttribute("href", canonicalUrl);
};

const findDocsRoute = (slug: string) => {
  const route = DOC_ROUTES.find((entry) => entry.slug === slug) ?? DOC_ROUTES.at(0);
  if (!route) throw new Error("Docs must define at least one route");
  return route;
};

const sectionNumber = (index: number) => String(index + 1).padStart(2, "0");

/** One outline entry: index, label, and the weft pick that marks the read one. */
const OutlineLink = ({
  current,
  href,
  index,
  label,
  onNavigate,
}: {
  current: boolean;
  href: string;
  index: number;
  label: string;
  onNavigate?: () => void;
}) => (
  <a aria-current={current ? "true" : undefined} href={href} onClick={onNavigate}>
    <span aria-hidden="true" className="warp-pick" />
    <span aria-hidden="true" className="warp-index">
      {sectionNumber(index)}
    </span>
    <span className="warp-label">{label}</span>
  </a>
);

/**
 * The warp: the lengthwise threads a piece is woven on. A guide's section order
 * is its own structural axis, so the rail carries the outline and marks the
 * section being read with a weft pick crossing the warp line.
 */
const SectionRail = ({
  activeIndex,
  route,
  onNavigate,
}: {
  activeIndex: number;
  route: DocRoute;
  onNavigate?: () => void;
}) => (
  <nav aria-label="On this page" className="warp-rail">
    <span className="warp-rail-title">On this page</span>
    <ol className="warp-rail-list">
      {route.sections.map((section, index) => (
        <li key={section.id}>
          <OutlineLink
            current={index === activeIndex}
            href={`/${route.slug}#${section.id}`}
            index={index}
            label={section.label}
            onNavigate={onNavigate}
          />
        </li>
      ))}
    </ol>
  </nav>
);

/** Every page, on the shelf its folder puts it on. */
const DocsNav = ({ currentSlug, onNavigate }: { currentSlug: string; onNavigate?: () => void }) => (
  <nav aria-label="Docs" className="guide-nav">
    <span className="guide-nav-title">Docs</span>
    {DOC_SHELVES.map((shelf) => (
      <div className="guide-shelf" key={shelf.title}>
        <h3 className="guide-shelf-title">{shelf.title}</h3>
        <ul className="guide-nav-list">
          {shelf.routes.map((entry) => (
            <li key={entry.slug}>
              <a
                aria-current={entry.slug === currentSlug ? "page" : undefined}
                href={`/${entry.slug}`}
                onClick={onNavigate}
              >
                {entry.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    ))}
  </nav>
);

/**
 * Hub index: every page with the sentence it opens on, so the landing route
 * answers "which one do I want" without opening four of them. Built from the
 * routes themselves, so a new page appears here the moment it is published.
 */
const DocsIndex = ({ currentSlug }: { currentSlug: string }) => (
  <nav aria-label="All documentation" className="docs-index">
    {DOC_SHELVES.map((shelf) => (
      <section key={shelf.title}>
        <h2>{shelf.title}</h2>
        <ul>
          {shelf.routes
            .filter((entry) => entry.slug !== currentSlug)
            .map((entry) => (
              <li key={entry.slug}>
                <a href={`/${entry.slug}`}>
                  <span className="docs-index-label">{entry.label}</span>
                  <span className="docs-index-blurb">{entry.description}</span>
                </a>
              </li>
            ))}
        </ul>
      </section>
    ))}
  </nav>
);

/**
 * The weft bar: the phone-width navigation, and the reading position it reports
 * for free.
 *
 * Closed it is a readout rather than a menu button - the section being read,
 * over a warp of one tick per section. Each tick is as wide as its section is
 * long, so a single continuous scroll fraction still lands inside the right
 * tick. Opening the sheet is its secondary job, which is why it can afford to
 * hold the bottom of every screen.
 */
const ReadingBar = ({ active, route }: { active: boolean; route: DocRoute }) => {
  const [open, setOpen] = useState(false);
  const { activeIndex, fraction, weights } = useReadingProgress(route.sections, active);
  const current = route.sections[activeIndex];
  const close = () => setOpen(false);

  if (route.sections.length === 0) return null;
  return (
    <div className="weft-dock">
      <button
        aria-expanded={open}
        aria-label={`Open docs navigation. Reading section ${activeIndex + 1} of ${route.sections.length}: ${current?.label ?? ""}`}
        className="weft-bar"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span aria-hidden="true" className="weft-bar-index">
          {sectionNumber(activeIndex)}
        </span>
        <span aria-hidden="true" className="weft-bar-label">
          {current?.label}
        </span>
        <ChevronUp aria-hidden="true" className="weft-bar-chevron" />
        <span aria-hidden="true" className="warp-gauge">
          {route.sections.map((section, index) => (
            <i key={section.id} style={{ flexGrow: weights[index] ?? 1 }} />
          ))}
          <span className="warp-gauge-weft" style={{ width: `${fraction * 100}%` }} />
        </span>
      </button>

      <Modal onClose={close} open={open} title={route.title} variant="guide-sheet">
        <SectionRail activeIndex={activeIndex} onNavigate={close} route={route} />
        <DocsNav currentSlug={route.slug} onNavigate={close} />
      </Modal>
    </div>
  );
};

const DocsPage = ({ active, slug }: { active: boolean; slug: string }) => {
  const route = findDocsRoute(slug);
  const hub = route.slug === "docs";
  const { activeIndex } = useReadingProgress(route.sections, active);
  const assetBaseUrl = useRomWeaverAssetBaseUrl();
  // Starts on the base the guides are authored against, which is what the
  // served document was rendered with, so hydration has nothing to reconcile.
  // The deployment's own base applies after mount, and only re-renders the
  // guides where the two differ.
  const [sampleBase, setSampleBase] = useState(AUTHORED_SAMPLE_BASE);
  const html = useMemo(() => retargetSampleUrls(route.html, sampleBase), [route, sampleBase]);
  useEffect(() => {
    if (!active) return;
    syncDocsSeoMetadata(route);
  }, [active, route]);
  useEffect(() => setSampleBase(assetBaseUrl || AUTHORED_SAMPLE_BASE), [assetBaseUrl]);
  return (
    <div className="docs-workbench" id="main">
      <nav aria-label="Breadcrumb" className="docs-breadcrumbs">
        <a href="/weave">{SITE_NAME}</a>
        <span aria-hidden="true">/</span>
        {hub ? (
          <span aria-current="page">Docs</span>
        ) : (
          <>
            <a href="/docs">Docs</a>
            <span aria-hidden="true">/</span>
            <span aria-current="page">{route.label}</span>
          </>
        )}
      </nav>
      <div className="docs-layout">
        <div className="docs-rails">
          <DocsNav currentSlug={route.slug} />
          {route.sections.length > 0 ? <SectionRail activeIndex={activeIndex} route={route} /> : null}
        </div>
        <section className="docs-panel">
          <article
            className="docs-article"
            data-markdown-source={route.source}
            // Committed repository Markdown, rendered to HTML at build time by
            // the same parser that feeds the prerendered page.
            // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted repository Markdown is the page source
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {hub ? <DocsIndex currentSlug={route.slug} /> : null}
          <aside className="docs-cta">
            <div>
              <h2>Try rom-weaver</h2>
              <p>Use a guided browser sample, or copy a CLI install command.</p>
            </div>
            <div className="docs-cta-actions">
              <a className="btn primary" href="/weave?guide=apply">
                Guided Apply
              </a>
              <a className="btn" href="/create?guide=create">
                Guided Create
              </a>
              <a className="btn" href="/docs/cli#install">
                Install the CLI
              </a>
            </div>
          </aside>
        </section>
      </div>
      {/* Keyed on the route so moving to another page closes the sheet with it,
          rather than leaving it open over a guide it no longer describes. */}
      <ReadingBar active={active} key={route.slug} route={route} />
    </div>
  );
};

export { DocsPage };
