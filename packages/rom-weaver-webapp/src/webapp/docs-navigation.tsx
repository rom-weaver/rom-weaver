import { useEffect, useLayoutEffect, useRef } from "react";
import { DOC_SOURCES, docGroupTitle, groupDocNavigationRoutes } from "./docs-routing.mjs";
import { preloadDocsRouteHtml } from "./workflow-routes.tsx";
import { useDocShelfState, type DocShelfState } from "./use-doc-shelf-state.ts";

const DOC_SHELVES = groupDocNavigationRoutes(
  DOC_SOURCES.map((source) => ({ ...source, group: source.group ?? docGroupTitle(source.file) })),
);
const GUIDE_BRANCHES = (["browser", "cli"] as const).map((audience) => ({
  title: audience === "browser" ? "Browser guides" : "CLI guides",
  shelves: DOC_SHELVES.map((shelf) => ({
    ...shelf,
    key: `${audience}:${shelf.title}`,
    routes: shelf.routes.filter((route) => route.audience === audience),
  })).filter((shelf) => shelf.routes.length),
}));
const SHARED_SHELVES = DOC_SHELVES.map((shelf) => ({
  ...shelf,
  routes: shelf.routes.filter((route) => !route.audience),
})).filter((shelf) => shelf.routes.length);
const NAV_STATE_SHELVES = [
  ...SHARED_SHELVES,
  ...GUIDE_BRANCHES.flatMap((branch) => [
    { title: branch.title },
    ...branch.shelves.map((shelf) => ({ title: shelf.key })),
  ]),
];
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const warmDocsHtml = (slug: string) => {
  void preloadDocsRouteHtml(slug).catch(() => undefined);
};

/** Compact task groups, independent of the source documentation folders. */
const DocsNav = ({
  currentSlug,
  onNavigate,
  onShelfToggle,
  openShelves,
  onSelectOverview,
  overviewId,
}: {
  currentSlug: string;
  onNavigate?: () => void;
  onShelfToggle: (title: string, open: boolean) => void;
  openShelves: DocShelfState;
  onSelectOverview?: () => void;
  overviewId?: string;
}) => {
  const navRef = useRef<HTMLElement | null>(null);
  const positionedSlug = useRef<string | null>(null);
  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    const scrollport = nav?.closest<HTMLElement>(".side-rail, .menu-sheet-body");
    if (!(nav && scrollport) || positionedSlug.current === currentSlug) return;
    const current = nav.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
    if (!current) {
      positionedSlug.current = null;
      return;
    }
    if (current.closest("details:not([open])")) return;
    // The outer navigation MUST own scrolling, including revealing the active guide.
    const observer = new ResizeObserver(() => positionCurrentGuide());
    const positionCurrentGuide = () => {
      if (!scrollport.clientHeight) return;
      const linkBounds = current.getBoundingClientRect();
      const portBounds = scrollport.getBoundingClientRect();
      if (linkBounds.top < portBounds.top || linkBounds.bottom > portBounds.bottom) {
        scrollport.scrollTop += linkBounds.top - portBounds.top - (scrollport.clientHeight - linkBounds.height) / 2;
      }
      positionedSlug.current = currentSlug;
      observer.disconnect();
    };
    observer.observe(scrollport);
    positionCurrentGuide();
    return () => observer.disconnect();
  }, [currentSlug, openShelves]);
  const renderLinks = (routes: (typeof DOC_SHELVES)[number]["routes"], key?: string, grouped = false) =>
    routes.length ? (
      <ul className="guide-nav-list" key={key}>
        {routes.map((entry) => (
          <li key={entry.slug}>
            <a
              aria-current={entry.slug === currentSlug ? "page" : undefined}
              href={`/${entry.slug}`}
              id={entry.slug === "docs" ? overviewId : undefined}
              aria-label={grouped ? entry.label : undefined}
              onClick={(event) => {
                onNavigate?.();
                if (entry.slug !== "docs" || !onSelectOverview) return;
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onSelectOverview();
              }}
              onFocus={() => warmDocsHtml(entry.slug)}
              onPointerEnter={() => warmDocsHtml(entry.slug)}
            >
              {grouped ? entry.label.replace(/ \((browser|CLI)\)$/, "") : entry.label}
            </a>
          </li>
        ))}
      </ul>
    ) : null;
  const renderShelf = (shelf: (typeof DOC_SHELVES)[number], key = shelf.title, nested = false) => {
    const Heading = nested ? "h4" : "h3";
    return (
      <details
        className="guide-shelf"
        key={key}
        onToggle={(event) => {
          if (event.target === event.currentTarget) onShelfToggle(key, event.currentTarget.open);
        }}
        open={openShelves[key]}
      >
        <summary>
          <Heading className="guide-shelf-title">{shelf.title}</Heading>
        </summary>
        {renderLinks(shelf.routes, undefined, nested)}
      </details>
    );
  };
  return (
    <nav aria-label="Docs" className="guide-nav" ref={navRef}>
      {SHARED_SHELVES.filter((shelf) => shelf.title === "Start here").map((shelf) =>
        renderLinks(shelf.routes, shelf.title),
      )}
      {GUIDE_BRANCHES.map((branch) => (
        <details
          className="guide-shelf guide-branch"
          key={branch.title}
          onToggle={(event) => {
            if (event.target === event.currentTarget) onShelfToggle(branch.title, event.currentTarget.open);
          }}
          open={openShelves[branch.title]}
        >
          <summary>
            <h3 className="guide-shelf-title">{branch.title}</h3>
          </summary>
          <div className="guide-branch-topics">
            {branch.shelves.map((shelf) => renderShelf(shelf, shelf.key, true))}
          </div>
        </details>
      ))}
      {SHARED_SHELVES.filter((shelf) => shelf.title !== "Start here").map((shelf) => renderShelf(shelf))}
    </nav>
  );
};

const DocsNavigation = ({
  currentSlug,
  onNavigate,
  onSelectOverview,
  overviewId,
}: {
  currentSlug: string;
  onNavigate?: () => void;
  onSelectOverview?: () => void;
  overviewId?: string;
}) => {
  const { onShelfToggle, openShelves } = useDocShelfState(NAV_STATE_SHELVES);
  useEffect(() => {
    for (const branch of GUIDE_BRANCHES) {
      const shelf = branch.shelves.find((entry) => entry.routes.some((route) => route.slug === currentSlug));
      if (!shelf) continue;
      onShelfToggle(branch.title, true);
      onShelfToggle(shelf.key, true);
      return;
    }
    const shelf = SHARED_SHELVES.find((entry) => entry.routes.some((route) => route.slug === currentSlug));
    if (shelf) onShelfToggle(shelf.title, true);
  }, [currentSlug, onShelfToggle]);
  return (
    <DocsNav
      currentSlug={currentSlug}
      onNavigate={onNavigate}
      onSelectOverview={onSelectOverview}
      overviewId={overviewId}
      onShelfToggle={onShelfToggle}
      openShelves={openShelves}
    />
  );
};

export { DocsNavigation };
