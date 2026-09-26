import { ChevronDown, Menu, Search } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect } from "react";
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
  children?: ReactNode;
  expanded?: boolean;
  onToggle?: (open: boolean) => void;
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
type NavSectionData = { entries: NavEntry[]; id: string; title: string };

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

/**
 * The first candidate the current layout actually shows, falling back to the
 * first that exists. The chrome renders some controls twice and hides one copy
 * with CSS, and `focus()` on a `display: none` element silently does nothing
 * and drops focus to the body. The fallback matters where there is no layout
 * to read - a test environment, or a control measured before first paint.
 */
const visibleFirst = <T extends HTMLElement>(candidates: Iterable<T | null | undefined>): T | null => {
  let fallback: T | null = null;
  for (const node of candidates) {
    if (node?.offsetParent) return node;
    fallback ??= node ?? null;
  }
  return fallback;
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
  if (entry.href) {
    const row = (
      <a
        aria-current={entry.current ? "page" : undefined}
        aria-label={entry.title}
        className={rowClass}
        hidden={entry.hidden}
        href={entry.href}
        id={idPrefix ? `${idPrefix}${entry.id}` : undefined}
        onClick={(event) => {
          onNavigate?.();
          if (entry.external) {
            entry.onExternalClick?.(event);
            return;
          }
          activateOnClick(event, () => entry.onSelect?.());
        }}
        rel={entry.external ? "noreferrer" : undefined}
        target={entry.external ? "_blank" : undefined}
      >
        {body}
      </a>
    );
    if (!entry.children) return row;
    return (
      <div className="nav-docs-disclosure" data-expanded={entry.expanded ? "true" : "false"}>
        <div className="nav-docs-summary">
          {row}
          <button
            aria-expanded={entry.expanded}
            aria-label={`${entry.label} navigation`}
            className="nav-docs-toggle"
            onClick={() => entry.onToggle?.(!entry.expanded)}
            type="button"
          >
            <ChevronDown aria-hidden="true" />
          </button>
        </div>
        {entry.expanded ? entry.children : null}
      </div>
    );
  }
  return (
    <button
      aria-label={entry.title}
      className={rowClass}
      hidden={entry.hidden}
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
        <h2 className="nav-group-label">{section.title}</h2>
        {section.entries.map((entry) => (
          <div hidden={entry.hidden} key={entry.id}>
            <NavRow className="nav-row" entry={entry} idPrefix="tab-" localizer={localizer} />
          </div>
        ))}
        {section.id === "device" ? appearance : null}
      </div>
    ))}
  </nav>
);

const PhoneDock = ({
  current,
  findLabel,
  findOpen,
  findTriggerRef,
  menuLabel,
  menuOpen,
  navLabel,
  onSelect,
  onToggleFind,
  onToggleMenu,
  tabs,
  triggerRef,
}: {
  current: string;
  findLabel: string;
  findOpen: boolean;
  findTriggerRef: RefObject<HTMLButtonElement | null>;
  menuLabel: string;
  menuOpen: boolean;
  navLabel: string;
  onSelect: (id: string) => void;
  onToggleFind: () => void;
  onToggleMenu: () => void;
  tabs: WorkflowTab[];
  triggerRef: RefObject<HTMLButtonElement | null>;
}) => {
  const findIndex = Math.ceil(tabs.length / 2);
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
    <nav aria-label={navLabel} className="dock">
      {tabs.slice(0, findIndex).map(renderWorkflowTab)}
      <button
        aria-controls="find-palette"
        aria-expanded={findOpen}
        aria-haspopup="dialog"
        aria-keyshortcuts="/ Control+K Meta+K"
        aria-label={findLabel}
        className="dock-tab dock-find"
        onClick={onToggleFind}
        ref={findTriggerRef}
        type="button"
      >
        <Search aria-hidden="true" />
        <span>{findLabel}</span>
      </button>
      {tabs.slice(findIndex).map(renderWorkflowTab)}
      <button
        aria-controls="menu-sheet"
        aria-expanded={menuOpen}
        aria-label={menuLabel}
        className="dock-tab dock-menu"
        onClick={onToggleMenu}
        ref={triggerRef}
        type="button"
      >
        <Menu aria-hidden="true" />
        <span>{menuLabel}</span>
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
                <h2 className="nav-group-label">{section.title}</h2>
                {/* Two columns: the heading carries the noun, so every label is
                short enough to pair up and the whole index fits one screen. */}
                <div className="nav-group-grid">
                  {section.entries.map((entry) => (
                    <div className={entry.children ? "nav-docs-entry" : undefined} hidden={entry.hidden} key={entry.id}>
                      <NavRow className="nav-row" entry={entry} localizer={localizer} onNavigate={onClose} />
                    </div>
                  ))}
                  {section.id === "device" ? appearance : null}
                </div>
              </div>
            ))
          : null}
      </div>
    </nav>
  );
};

export type { NavGroup, NavSectionData, WorkflowTab };
export { MenuSheet, NAV_GROUP_TITLES, PhoneDock, SideNav, fullNameFor, visibleFirst };
