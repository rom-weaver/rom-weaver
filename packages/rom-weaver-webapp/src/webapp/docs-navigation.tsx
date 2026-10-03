import { ChevronLeft, ChevronRight, Monitor, Terminal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DOC_SOURCES, docGroupTitle, groupDocNavigationRoutes } from "./docs-routing.mjs";
import { preloadDocsRouteHtml } from "./workflow-routes.tsx";
import { useDocShelfState, type DocShelfState } from "./use-doc-shelf-state.ts";

type DocsAudience = "browser" | "cli";
type DocShelf = (typeof DOC_SHELVES)[number];
type DocNavRoute = DocShelf["routes"][number];

const DOC_SHELVES = groupDocNavigationRoutes(
  DOC_SOURCES.map((source) => ({ ...source, group: source.group ?? docGroupTitle(source.file) })),
);
/** Shelves about running or building the project rather than using it. */
const PROJECT_SHELF_TITLES = new Set(["Hosting", "Development", "Legal"]);
const START_SHELF = DOC_SHELVES[0];
/** Task shelves carry one guide per audience; a switch picks which one the reader sees. */
const TASK_SHELVES = DOC_SHELVES.filter((shelf) => shelf.routes.some((route) => route.audience));
const LOOKUP_SHELVES = DOC_SHELVES.filter(
  (shelf) => shelf !== START_SHELF && !TASK_SHELVES.includes(shelf) && !PROJECT_SHELF_TITLES.has(shelf.title),
);
const PROJECT_SHELVES = DOC_SHELVES.filter((shelf) => PROJECT_SHELF_TITLES.has(shelf.title));
const AUDIENCE_NAMES: Record<DocsAudience, string> = { browser: "browser", cli: "terminal" };
const AUDIENCE_STORAGE_KEY = "rom-weaver-docs-audience";
const AUDIENCE_EVENT = "rom-weaver:docs-audience";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const warmDocsHtml = (slug: string) => {
  void preloadDocsRouteHtml(slug).catch(() => undefined);
};

const findDocNavRoute = (slug: string) => DOC_SHELVES.flatMap((shelf) => shelf.routes).find((r) => r.slug === slug);
const docShelfFor = (slug: string) => DOC_SHELVES.find((shelf) => shelf.routes.some((route) => route.slug === slug));
const routesForAudience = (shelf: DocShelf, audience: DocsAudience) =>
  shelf.routes.filter((route) => !route.audience || route.audience === audience);
/** The "(browser)" or "(CLI)" suffix says nothing when the switch already names that audience. */
const docsLabelFor = (route: { label: string; slug: string }, audience: DocsAudience) =>
  findDocNavRoute(route.slug)?.audience === audience ? route.label.replace(/ \((browser|CLI)\)$/, "") : route.label;

const readStoredAudience = (): DocsAudience | null => {
  try {
    const stored = localStorage.getItem(AUDIENCE_STORAGE_KEY);
    return stored === "browser" || stored === "cli" ? stored : null;
  } catch {
    // The switch MUST keep working when storage is blocked; it just forgets.
    return null;
  }
};

/**
 * The guide audience the reader chose, shared by every docs surface on the page.
 * The server renders the current guide's own audience; the stored choice applies
 * after mount, and opening a guide for the other audience moves the switch to it.
 */
const useDocsAudience = (currentSlug: string) => {
  const pageAudience = findDocNavRoute(currentSlug)?.audience as DocsAudience | undefined;
  const [audience, setAudienceState] = useState<DocsAudience>(pageAudience ?? "browser");
  const setAudience = useCallback((next: DocsAudience) => {
    setAudienceState(next);
    try {
      localStorage.setItem(AUDIENCE_STORAGE_KEY, next);
    } catch {
      // The switch MUST keep working when storage is blocked; it just forgets.
    }
    window.dispatchEvent(new CustomEvent(AUDIENCE_EVENT, { detail: next }));
  }, []);
  useIsomorphicLayoutEffect(() => {
    if (pageAudience) {
      if (readStoredAudience() === pageAudience) setAudienceState(pageAudience);
      else setAudience(pageAudience);
      return;
    }
    setAudienceState(readStoredAudience() ?? "browser");
  }, [pageAudience, setAudience]);
  useEffect(() => {
    const sync = (event: Event) => setAudienceState((event as CustomEvent<DocsAudience>).detail);
    window.addEventListener(AUDIENCE_EVENT, sync);
    return () => window.removeEventListener(AUDIENCE_EVENT, sync);
  }, []);
  return [audience, setAudience] as const;
};

const AudienceSwitch = ({
  audience,
  labelId,
  onChange,
}: {
  audience: DocsAudience;
  labelId: string;
  onChange: (audience: DocsAudience) => void;
}) => (
  <fieldset aria-labelledby={labelId} className="docs-audience">
    <button aria-pressed={audience === "browser"} onClick={() => onChange("browser")} type="button">
      <Monitor aria-hidden="true" />
      Browser
    </button>
    <button aria-pressed={audience === "cli"} onClick={() => onChange("cli")} type="button">
      <Terminal aria-hidden="true" />
      Terminal
    </button>
  </fieldset>
);

const GuideLink = ({
  audience,
  currentSlug,
  id,
  onNavigate,
  onSelectOverview,
  route,
}: {
  audience: DocsAudience;
  currentSlug: string;
  id?: string;
  onNavigate?: () => void;
  onSelectOverview?: () => void;
  route: DocNavRoute;
}) => (
  <a
    aria-current={route.slug === currentSlug ? "page" : undefined}
    // The visible label MAY drop "(CLI)"; the accessible name keeps it for readers who skipped the switch.
    aria-label={docsLabelFor(route, audience) === route.label ? undefined : route.label}
    href={`/${route.slug}`}
    id={id}
    onClick={(event) => {
      onNavigate?.();
      if (route.slug !== "docs" || !onSelectOverview) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onSelectOverview();
    }}
    onFocus={() => warmDocsHtml(route.slug)}
    onPointerEnter={() => warmDocsHtml(route.slug)}
  >
    {docsLabelFor(route, audience)}
  </a>
);

/** Desktop rail: the same groups and audience switch as the phone drawer, as open-in-place shelves. */
const DocsNav = ({
  audience,
  currentSlug,
  onAudienceChange,
  onNavigate,
  onSelectOverview,
  onShelfToggle,
  openShelves,
  overviewId,
}: {
  audience: DocsAudience;
  currentSlug: string;
  onAudienceChange: (audience: DocsAudience) => void;
  onNavigate?: () => void;
  onSelectOverview?: () => void;
  onShelfToggle: (title: string, open: boolean) => void;
  openShelves: DocShelfState;
  overviewId?: string;
}) => {
  const navRef = useRef<HTMLElement | null>(null);
  const positionedSlug = useRef<string | null>(null);
  useIsomorphicLayoutEffect(() => {
    const nav = navRef.current;
    const scrollport = nav?.closest<HTMLElement>(".side-rail");
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
  }, [currentSlug, openShelves, audience]);
  const renderShelf = (shelf: DocShelf) => {
    const routes = routesForAudience(shelf, audience);
    return (
      <details
        className="guide-shelf"
        key={shelf.title}
        onToggle={(event) => onShelfToggle(shelf.title, event.currentTarget.open)}
        open={openShelves[shelf.title]}
      >
        <summary>
          <h3 className="guide-shelf-title">{shelf.title}</h3>
          <span className="guide-shelf-count">{routes.length}</span>
        </summary>
        <ul className="guide-nav-list">
          {routes.map((route) => (
            <li key={route.slug}>
              <GuideLink audience={audience} currentSlug={currentSlug} onNavigate={onNavigate} route={route} />
            </li>
          ))}
        </ul>
      </details>
    );
  };
  return (
    <nav aria-label="Docs" className="guide-nav" ref={navRef}>
      <ul className="guide-nav-list guide-nav-start">
        {START_SHELF?.routes.map((route) => (
          <li key={route.slug}>
            <GuideLink
              audience={audience}
              currentSlug={currentSlug}
              id={route.slug === "docs" ? overviewId : undefined}
              onNavigate={onNavigate}
              onSelectOverview={onSelectOverview}
              route={route}
            />
          </li>
        ))}
      </ul>
      <h2 className="guide-group" id="docs-rail-task-label">
        Task guides
      </h2>
      <AudienceSwitch audience={audience} labelId="docs-rail-task-label" onChange={onAudienceChange} />
      {TASK_SHELVES.map(renderShelf)}
      <h2 className="guide-group">Look things up</h2>
      {LOOKUP_SHELVES.map(renderShelf)}
      <h2 className="guide-group">About the project</h2>
      {PROJECT_SHELVES.map(renderShelf)}
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
  const { onShelfToggle, openShelves } = useDocShelfState(DOC_SHELVES);
  const [audience, setAudience] = useDocsAudience(currentSlug);
  useEffect(() => {
    const shelf = docShelfFor(currentSlug);
    if (shelf && shelf !== START_SHELF) onShelfToggle(shelf.title, true);
  }, [currentSlug, onShelfToggle]);
  return (
    <DocsNav
      audience={audience}
      currentSlug={currentSlug}
      onAudienceChange={setAudience}
      onNavigate={onNavigate}
      onSelectOverview={onSelectOverview}
      onShelfToggle={onShelfToggle}
      openShelves={openShelves}
      overviewId={overviewId}
    />
  );
};

const ShelfRow = ({
  audience,
  current,
  onOpen,
  shelf,
}: {
  audience: DocsAudience;
  current: boolean;
  onOpen: (title: string) => void;
  shelf: DocShelf;
}) => {
  const routes = routesForAudience(shelf, audience);
  const names = routes.map((route) => docsLabelFor(route, audience));
  const preview = names.slice(0, 2).join(", ") + (names.length > 2 ? ", and more" : "");
  return (
    <li>
      <button className={current ? "docs-row is-here" : "docs-row"} onClick={() => onOpen(shelf.title)} type="button">
        <b>{shelf.title}</b>
        <span className="docs-row-sub">{current ? "You are here" : preview}</span>
        <span className="docs-row-count">{routes.length}</span>
        <ChevronRight aria-hidden="true" />
      </button>
    </li>
  );
};

/**
 * Phone drawer: level one lists shelves, level two lists one shelf's pages.
 * Each level fits about one screen, which a single long list of every page did not.
 */
const DocsDrawerNav = ({
  currentSlug,
  onNavigate,
  onOpenShelf,
  openShelf,
}: {
  currentSlug: string;
  onNavigate: () => void;
  onOpenShelf: (title: string | null) => void;
  openShelf: string | null;
}) => {
  const [audience, setAudience] = useDocsAudience(currentSlug);
  const currentShelf = docShelfFor(currentSlug);
  const shelf = openShelf ? DOC_SHELVES.find((entry) => entry.title === openShelf) : undefined;
  if (shelf) {
    const routes = routesForAudience(shelf, audience);
    const isTask = TASK_SHELVES.includes(shelf);
    const other: DocsAudience = audience === "browser" ? "cli" : "browser";
    const otherCount = isTask ? shelf.routes.filter((route) => route.audience === other).length : 0;
    const noun = routes.length === 1 ? "guide" : "guides";
    return (
      <div className="docs-drawer-level">
        <div className="docs-drawer-head">
          <button className="docs-drawer-back" onClick={() => onOpenShelf(null)} type="button">
            <ChevronLeft aria-hidden="true" />
            All docs
          </button>
          <h2>{shelf.title}</h2>
          <p>{isTask ? `${routes.length} ${AUDIENCE_NAMES[audience]} ${noun}` : `${routes.length} pages`}</p>
        </div>
        <ul className="docs-drawer-pages">
          {routes.map((route) => (
            <li key={route.slug}>
              <GuideLink audience={audience} currentSlug={currentSlug} onNavigate={onNavigate} route={route} />
            </li>
          ))}
        </ul>
        {otherCount ? (
          <div className="docs-drawer-twin">
            <span>{`${otherCount} ${otherCount === 1 ? "guide" : "guides"} for the ${AUDIENCE_NAMES[other]}`}</span>
            <button onClick={() => setAudience(other)} type="button">
              {`Show ${AUDIENCE_NAMES[other]}`}
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  const rows = (shelves: readonly DocShelf[]) =>
    shelves
      .filter((entry) => routesForAudience(entry, audience).length > 0)
      .map((entry) => (
        <ShelfRow
          audience={audience}
          current={entry === currentShelf}
          key={entry.title}
          onOpen={onOpenShelf}
          shelf={entry}
        />
      ));
  return (
    <div className="docs-drawer-level">
      <div className="docs-drawer-group">
        <h2 id="docs-drawer-task-label">Task guides</h2>
        <AudienceSwitch audience={audience} labelId="docs-drawer-task-label" onChange={setAudience} />
      </div>
      <ul className="docs-rows">{rows(TASK_SHELVES)}</ul>
      <div className="docs-drawer-group">
        <h2>Look things up</h2>
      </div>
      <ul className="docs-rows">
        {START_SHELF?.routes.map((route) => (
          <li key={route.slug}>
            <a
              aria-current={route.slug === currentSlug ? "page" : undefined}
              className="docs-row is-link"
              href={`/${route.slug}`}
              onClick={onNavigate}
              onFocus={() => warmDocsHtml(route.slug)}
            >
              <b>{route.label}</b>
              <ChevronRight aria-hidden="true" />
            </a>
          </li>
        ))}
        {rows(LOOKUP_SHELVES)}
      </ul>
      <div className="docs-drawer-group">
        <h2>About the project</h2>
      </div>
      <ul className="docs-rows">{rows(PROJECT_SHELVES)}</ul>
    </div>
  );
};

export type { DocsAudience };
export { DocsDrawerNav, DocsNavigation, docShelfFor, docsLabelFor, useDocsAudience };
