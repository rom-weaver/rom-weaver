import { SlidersHorizontal, TextSearch } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import type { Localizer } from "../../presentation/localization/index.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import { join } from "./shell-common.tsx";

/**
 * One entry of the primary nav. Every workflow is named and reachable in both
 * layouts: `group` files it under a heading that carries the noun, so the entry
 * itself only needs the verb. `dock: true` also gives it one of the phone
 * dock's three workflow slots; everything else reaches the phone through Menu.
 * A `beta` entry stays behind the beta-tools setting and wears a chip while it
 * is on.
 */
type WorkflowTab = {
  beta?: boolean;
  dock?: boolean;
  group: NavGroup;
  href: string;
  icon: ReactNode;
  id: string;
  /** Full name: Find, the document title, and the page heading use it. */
  label: string;
  /** Short name for the nav, where the group heading already carries the noun. */
  railLabel?: string;
};
type NavGroup = "files" | "patches" | "project" | "roms";

const NAV_GROUP_TITLES: Record<NavGroup, MessageId> = {
  files: "ui.nav.groupFiles",
  patches: "ui.nav.groupPatches",
  project: "ui.tools.project",
  roms: "ui.nav.groupRoms",
};

/** One rendered nav row, shared by the desktop sidebar and the phone menu. */
type NavEntry = {
  beta?: boolean;
  /** Rendered but not shown: a beta row before the client setting is known. */
  hidden?: boolean;
  className?: string;
  current?: boolean;
  /** Opens in a new tab: the row keeps its href and takes the external guard. */
  external?: boolean;
  href?: string;
  icon: ReactNode;
  id: string;
  label: string;
  /** Runs instead of following the href, for a row that routes or opens a dialog. */
  onSelect?: () => void;
  /** Runs before an external row opens, for the running-job guard. */
  onExternalClick?: (event: React.MouseEvent) => void;
  /** Extra accessible name where the visible label is deliberately short. */
  title?: string;
};
type NavSectionData = { entries: NavEntry[]; id: string; title: string; content?: ReactNode };

/**
 * The full name, when it is safe to use as the accessible name of a row that
 * shows the short one. WCAG 2.5.3 (Label in Name) requires the accessible name
 * to contain the visible text, so a speech user saying what they can read
 * actually activates the row: "Saves" is not contained in "Save Editor", and
 * that row keeps its visible label as its name instead.
 */
const fullNameFor = (tab: WorkflowTab) => {
  if (!tab.railLabel) return undefined;
  return tab.label.toLowerCase().includes(tab.railLabel.toLowerCase()) ? tab.label : undefined;
};

const activateOnClick = (event: React.MouseEvent, run: () => void) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  run();
};

/**
 * A nav row. A destination inside the app is a real link, so middle-click and
 * "open in new tab" keep working and a plain activation routes in place; a
 * surface that opens a dialog is a button, because it is not a URL.
 */
const NavRow = ({
  entry,
  className,
  idPrefix,
  localizer,
  onNavigate,
}: {
  className: string;
  entry: NavEntry;
  /** Only the sidebar copy owns the `tab-<id>` ids the panels are labelled by. */
  idPrefix?: string;
  localizer: Localizer;
  onNavigate?: () => void;
}) => {
  const body = (
    <>
      {entry.icon}
      <span className="nav-row-label">{entry.label}</span>
      {entry.beta ? <span className="nav-beta">{localizer.message("ui.tools.beta")}</span> : null}
    </>
  );
  const rowClass = join(className, entry.className);
  // The sidebar copy is found by its `tab-<id>`; the Menu sheet copy needs its own
  // handle, which stays off the sidebar so the prerendered shell does not carry it.
  const navId = idPrefix ? undefined : entry.id;
  if (entry.href) {
    return (
      <a
        aria-current={entry.current ? "page" : undefined}
        aria-label={entry.title}
        className={rowClass}
        data-nav={navId}
        hidden={entry.hidden}
        href={entry.href}
        id={idPrefix ? `${idPrefix}${entry.id}` : undefined}
        onClick={(event) => {
          onNavigate?.();
          if (entry.external) {
            entry.onExternalClick?.(event);
            return;
          }
          if (entry.onSelect) activateOnClick(event, entry.onSelect);
        }}
        rel={entry.external ? "noreferrer" : undefined}
        target={entry.external ? "_blank" : undefined}
      >
        {body}
      </a>
    );
  }
  return (
    <button
      aria-label={entry.title}
      className={rowClass}
      data-nav={navId}
      hidden={entry.hidden}
      id={idPrefix ? `${idPrefix}${entry.id}` : undefined}
      onClick={() => {
        onNavigate?.();
        entry.onSelect?.();
      }}
      type="button"
    >
      {body}
    </button>
  );
};

/**
 * Desktop primary nav. Every destination the app has, named, under the heading
 * that supplies its noun - there is no second navigation and nothing hides
 * behind an overflow menu.
 */
const SideNav = ({
  appearance,
  localizer,
  navLabel,
  sections,
}: {
  appearance: ReactNode;
  localizer: Localizer;
  navLabel: string;
  sections: NavSectionData[];
}) => (
  <nav aria-label={navLabel} className="side-nav">
    {sections.map((section) => (
      <div className="nav-group" key={section.id}>
        {section.title ? <h2 className="nav-group-label">{section.title}</h2> : null}
        {section.entries.map((entry) => (
          <div hidden={entry.hidden} key={entry.id}>
            <NavRow className="nav-row" entry={entry} idPrefix="tab-" localizer={localizer} />
          </div>
        ))}
        {section.content}
        {section.id === "device" ? appearance : null}
      </div>
    ))}
  </nav>
);

/**
 * The phone dock: two workflows, Menu, the third workflow, then Controls. Menu
 * opens the menu sheet, which carries every destination and the Find box;
 * Controls opens the settings console from the right-hand edge, where a leftward
 * swipe across the dock also pulls it in.
 */
const PhoneDock = ({
  appLabel,
  current,
  menuLabel,
  menuOpen,
  navLabel,
  onOpenApp,
  onSelect,
  onToggleMenu,
  tabs,
  triggerRef,
}: {
  appLabel: string;
  current: string;
  menuLabel: string;
  menuOpen: boolean;
  navLabel: string;
  onOpenApp: () => void;
  onSelect: (id: string) => void;
  onToggleMenu: () => void;
  tabs: WorkflowTab[];
  triggerRef: RefObject<HTMLButtonElement | null>;
}) => {
  const toolsIndex = Math.ceil(tabs.length / 2);
  // Mostly-vertical drags are page scrolls, not a request for the console.
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const renderWorkflowTab = (tab: WorkflowTab) => (
    <a
      aria-current={tab.id === current ? "page" : undefined}
      className="dock-tab"
      data-mode={tab.id}
      href={tab.href}
      key={tab.id}
      onClick={(event) => activateOnClick(event, () => onSelect(tab.id))}
    >
      {tab.icon}
      <span>{tab.railLabel ?? tab.label}</span>
    </a>
  );

  return (
    <nav
      aria-label={navLabel}
      className="dock"
      onPointerCancel={() => {
        swipeRef.current = null;
      }}
      onPointerDown={(event) => {
        swipeRef.current = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
      }}
      onPointerUp={(event) => {
        const start = swipeRef.current;
        swipeRef.current = null;
        if (!start) return;
        const dx = event.clientX - start.x;
        if (dx < -60 && Math.abs(dx) > 2 * Math.abs(event.clientY - start.y)) onOpenApp();
      }}
    >
      {tabs.slice(0, toolsIndex).map(renderWorkflowTab)}
      <button
        aria-controls="menu-sheet"
        aria-expanded={menuOpen}
        aria-label={menuLabel}
        className="dock-tab dock-menu"
        onClick={onToggleMenu}
        ref={triggerRef}
        type="button"
      >
        <TextSearch aria-hidden="true" />
        <span>{menuLabel}</span>
      </button>
      {tabs.slice(toolsIndex).map(renderWorkflowTab)}
      <button className="dock-tab dock-app" onClick={onOpenApp} type="button">
        <SlidersHorizontal aria-hidden="true" />
        <span>{appLabel}</span>
      </button>
    </nav>
  );
};

const MenuSheet = ({
  appearance,
  localizer,
  onClose,
  open,
  opened,
  search,
  sections,
  toolOpen,
  triggerRef,
}: {
  /** Theme and accent rows join This Device after the sheet opens. */
  appearance: ReactNode;
  localizer: Localizer;
  onClose: () => void;
  open: boolean;
  /** The secondary nav mounts after the first open, once hydration is complete. */
  opened: boolean;
  /** The Find box, pinned to the sheet's foot; while it holds a query its results replace the nav. */
  search?: ReactNode;
  sections: NavSectionData[];
  /** True while a popover inside THIS sheet is open; Escape closes that first.
      A popover in the chrome must not count: it is inert behind the sheet, so
      letting it claim the press would spend it on nothing. */
  toolOpen: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) => {
  useEffect(() => {
    if (!open || toolOpen) return undefined;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [onClose, open, toolOpen, triggerRef]);

  return (
    <nav aria-label={localizer.message("ui.tools.menu")} className="menu-sheet" hidden={!open} id="menu-sheet">
      <div className="menu-sheet-body">
        {opened
          ? sections.map((section) => (
              <div className="nav-group" key={section.id}>
                {section.title ? <h2 className="nav-group-label">{section.title}</h2> : null}
                {/* Tool rows pair up on phones. */}
                <div className="nav-group-grid">
                  {section.entries.map((entry) => (
                    <div hidden={entry.hidden} key={entry.id}>
                      <NavRow className="nav-row" entry={entry} localizer={localizer} onNavigate={onClose} />
                    </div>
                  ))}
                  {section.id === "device" ? appearance : null}
                </div>
                {section.content}
              </div>
            ))
          : null}
      </div>
      {search}
    </nav>
  );
};

export type { NavGroup, NavSectionData, WorkflowTab };
export { MenuSheet, NAV_GROUP_TITLES, PhoneDock, SideNav, fullNameFor };
