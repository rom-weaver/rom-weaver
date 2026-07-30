import "./design-system/docs-route.css";
import { ArrowUpToLine, ChevronDown } from "lucide-react";
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

/** The landing route: an index of the guides rather than one of them. */
const HUB_SLUG = "docs";

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

/** Which list the tapped crumb promised; null while the sheet is shut. */
type TrailSheet = "pages" | "sections";

/**
 * The trail: phone-width navigation folded into the breadcrumb it replaces.
 *
 * A guide already needs a breadcrumb, so on a phone that row does the
 * navigating too - `Docs` opens every guide, the section crumb opens this
 * guide's outline - and the reading position rides its bottom edge as a warp of
 * one tick per section. Two crumbs, not four: the masthead brands the page and
 * the guide's own title is the heading below, which buys the room to name the
 * section, the one part of the trail that changes while you read.
 *
 * It sticks to the top rather than holding the bottom of the screen. The bottom
 * is where the phone browser parks its own collapsing toolbar, which is what
 * the old bar had to reserve scroll room to clear.
 */
const TrailHead = ({
  activeIndex,
  fraction,
  route,
  weights,
}: {
  activeIndex: number;
  fraction: number;
  route: DocRoute;
  weights: readonly number[];
}) => {
  const [sheet, setSheet] = useState<TrailSheet | null>(null);
  const current = route.sections[activeIndex];
  const close = () => setSheet(null);
  // A page with no headings - the index - keeps the guide menu and drops the half
  // of the trail that reports a position it does not have. Returning nothing here
  // would leave that page with no breadcrumb at all on a phone, since the plain
  // one is hidden at this width.
  const outlined = route.sections.length > 0;

  return (
    <div className="docs-trail">
      <nav aria-label="Breadcrumb" className="trail-crumbs">
        <button
          aria-expanded={sheet === "pages"}
          className="trail-crumb"
          onClick={() => setSheet("pages")}
          type="button"
        >
          Docs
          <ChevronDown aria-hidden="true" />
        </button>
        {outlined ? (
          <>
            <span aria-hidden="true" className="trail-sep">
              /
            </span>
            <button
              aria-expanded={sheet === "sections"}
              aria-label={`Section ${activeIndex + 1} of ${route.sections.length}: ${current?.label ?? ""}. Open this guide's outline.`}
              className="trail-crumb is-section"
              onClick={() => setSheet("sections")}
              type="button"
            >
              <b aria-hidden="true" className="trail-index">
                {sectionNumber(activeIndex)}
              </b>
              <span aria-hidden="true" className="trail-label">
                {current?.label}
              </span>
              <ChevronDown aria-hidden="true" />
            </button>
          </>
        ) : null}
      </nav>
      {outlined ? (
        <span aria-hidden="true" className="warp-gauge">
          {route.sections.map((section, index) => (
            <i key={section.id} style={{ flexGrow: weights[index] ?? 1 }} />
          ))}
          <span className="warp-gauge-weft" style={{ width: `${fraction * 100}%` }} />
        </span>
      ) : null}

      {/* Only the list the tapped crumb named: tapping `Docs` and getting this
          guide's outline first would break the promise the label made. */}
      <Modal onClose={close} open={sheet !== null} title={route.title} variant="guide-sheet">
        {sheet === "sections" ? (
          <SectionRail activeIndex={activeIndex} onNavigate={close} route={route} />
        ) : (
          <DocsNav currentSlug={route.slug} onNavigate={close} />
        )}
      </Modal>
    </div>
  );
};

/**
 * The way back up, at the end of the guide.
 *
 * Deliberately the only thing here. Onward links are already the last paragraph
 * of every guide, hand-written and pointing at whatever actually follows from
 * what you just read - "Ready to make your own? See Create a patch." An
 * auto-generated previous/next pair sat one screen under that saying the same
 * thing worse: shelf-adjacent is not the same as logically next, and on the
 * first guide it duplicated a link the prose had just made.
 */
const ArticleEnd = () => (
  <div className="docs-onward">
    {/* A button, not an `#top` anchor: the guide routes are paths, and a hash here
        would leave a destination in the address bar that is not one. `scrollTo`
        still picks up the page's own `scroll-behavior`. */}
    <button className="docs-to-top" onClick={() => window.scrollTo({ top: 0 })} type="button">
      <ArrowUpToLine aria-hidden="true" />
      Back to top
    </button>
  </div>
);

const DocsPage = ({ active, slug }: { active: boolean; slug: string }) => {
  const route = findDocsRoute(slug);
  const hub = route.slug === HUB_SLUG;
  // One subscription for the page: the desktop rail and the phone trail read the
  // same position, and the hook measures the document on every scroll frame.
  const { activeIndex, fraction, weights } = useReadingProgress(route.sections, active);
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
        <a href="/apply">{SITE_NAME}</a>
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
      {/* Keyed on the route so moving to another guide closes the sheet with it,
          rather than leaving it open over a guide it no longer describes. */}
      <TrailHead activeIndex={activeIndex} fraction={fraction} key={route.slug} route={route} weights={weights} />
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
          {/* Hub only, and above the index rather than below it. Sixteen guides
              each ending in the same three buttons made the pitch furniture
              rather than an offer, and every guide already closes on a link its
              author chose. On the index it is the shortest answer to "what do you
              want to do", so it goes before the list of everything. */}
          {hub ? (
            <aside className="docs-cta">
              <div>
                <h2>Try rom-weaver</h2>
                <p>Use a guided browser sample, or copy a CLI install command.</p>
              </div>
              <div className="docs-cta-actions">
                <a className="btn primary" href="/apply?guide=apply">
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
          ) : null}
          {hub ? <DocsIndex currentSlug={route.slug} /> : null}
        </section>
      </div>
      <ArticleEnd />
    </div>
  );
};

export { DocsPage };
