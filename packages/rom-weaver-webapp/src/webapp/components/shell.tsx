import {
  Cloud,
  CloudCheck,
  CloudDownload,
  CloudOff,
  createLucideIcon,
  HardDrive,
  Heart,
  House,
  LoaderCircle,
  Menu,
  MonitorCog,
  Moon,
  Newspaper,
  PackageCheck,
  Palette,
  ScrollText,
  Search,
  Settings,
  SunMedium,
  X,
} from "lucide-react";
import type { IconNode } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "./brand-mark.tsx";
import { FIND_SHORTCUT_HINT, FindPalette } from "./find-palette.tsx";
import type { FindAction } from "../find-index.ts";
import { ACCENTS, useAccent } from "../accent.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import { holdTransitionClasses, viewTransitionsUnsupported } from "../../public/react/components/ds/flat-transition.ts";
import { useRomWeaverSettings, useUiLocalizer } from "../../public/react/settings-context.tsx";
import type { ThemePreference } from "../theme.ts";
import { useTheme } from "../theme.ts";
import type { ServiceWorkerStatus } from "../pwa/service-worker-cache-state.ts";

if (typeof window !== "undefined") {
  const layout = new URLSearchParams(window.location.search).get("offline-layout");
  if (layout === "tab" || layout === "strip") {
    document.documentElement.dataset.offlineLayout = layout;
  }
}

const Github = createLucideIcon("github", [
  [
    "path",
    {
      d: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4",
      key: "tonef",
    },
  ],
  ["path", { d: "M9 18c-4.51 2-5-2-7-2", key: "9comsn" }],
] satisfies IconNode);

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

const readPwaState = () => {
  const displayModes = ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"];
  const displayModeMatches =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? displayModes.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)
      : false;
  const iosStandalone =
    typeof navigator !== "undefined" && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return displayModeMatches || iosStandalone;
};

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
type NavGroup = "patches" | "project" | "roms";

const NAV_GROUP_TITLES: Record<NavGroup, MessageId> = {
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
  stateLabel?: string;
  /** Runs instead of following the href, for a row that routes or opens a dialog. */
  onSelect?: () => void;
  /** Runs before an external row opens, for the running-job guard. */
  onExternalClick?: (event: React.MouseEvent) => void;
  /** Extra accessible name where the visible label is deliberately short. */
  title?: string;
};
type NavSectionData = { entries: NavEntry[]; id: string; title: string };

/** Reveal appearance changes from the choice that caused them. */
const runAppearanceWipe = (update: () => void, source: HTMLElement | null, kind: "theme" | "accent") => {
  const root = document.documentElement;
  if (viewTransitionsUnsupported()) {
    update();
    return;
  }
  const rect = source?.getBoundingClientRect();
  const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const cy = rect ? rect.top + rect.height / 2 : 0;
  const radius = Math.hypot(Math.max(cx, window.innerWidth - cx), Math.max(cy, window.innerHeight - cy));
  root.style.setProperty("--wipe-x", `${cx}px`);
  root.style.setProperty("--wipe-y", `${cy}px`);
  root.style.setProperty("--wipe-r", `${radius}px`);
  const release = holdTransitionClasses([`vt-${kind}`]);
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => undefined);
  transition.finished.then(release, release);
};

/** One motion gate for every programmatic scroll and animation in the chrome. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
      <span className="nav-row-label">
        {entry.label}
        {entry.stateLabel ? <span className="nav-row-state">{entry.stateLabel}</span> : null}
      </span>
      {entry.beta ? <span className="nav-beta">{localizer.message("ui.tools.beta")}</span> : null}
    </>
  );
  const rowClass = join(className, entry.className);
  if (entry.href) {
    return (
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
          <NavRow className="nav-row" entry={entry} idPrefix="tab-" key={entry.id} localizer={localizer} />
        ))}
        {section.id === "device" ? appearance : null}
      </div>
    ))}
  </nav>
);

/**
 * Phone primary nav: the three workflows that carry the app, plus Menu. Menu
 * toggles the sheet that holds everything else. A status control spans the
 * dock above those four destinations so its full wording stays readable.
 */
const PhoneDock = ({
  current,
  menuLabel,
  menuOpen,
  navLabel,
  onSelect,
  onToggleMenu,
  status,
  tabs,
  triggerRef,
}: {
  current: string;
  menuLabel: string;
  menuOpen: boolean;
  navLabel: string;
  onSelect: (id: string) => void;
  onToggleMenu: () => void;
  status: ReactNode;
  tabs: WorkflowTab[];
  triggerRef: RefObject<HTMLButtonElement | null>;
}) => (
  <nav aria-label={navLabel} className="dock">
    {tabs.map((tab) => (
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
    ))}
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
    <span className="dock-runtime">{status}</span>
  </nav>
);

const MenuSheet = ({
  appearance,
  findRef,
  localizer,
  onClose,
  onOpenFind,
  open,
  opened,
  sections,
  toolOpen,
  triggerRef,
}: {
  /** Theme and accent rows join This Device after the sheet opens. */
  appearance: ReactNode;
  /** The sheet's own Find row, so Escape can return focus to it on the phone. */
  findRef: RefObject<HTMLButtonElement | null>;
  localizer: Localizer;
  onClose: () => void;
  onOpenFind: () => void;
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
                  {section.entries
                    .filter((entry) => entry.id !== "status")
                    .map((entry) => (
                      <NavRow
                        className="nav-row"
                        entry={entry}
                        key={entry.id}
                        localizer={localizer}
                        onNavigate={onClose}
                      />
                    ))}
                  {section.id === "device" ? appearance : null}
                </div>
              </div>
            ))
          : null}
      </div>
      <div className="menu-sheet-foot">
        <button className="menu-find" onClick={onOpenFind} ref={findRef} type="button">
          <Search aria-hidden="true" />
          <span>{localizer.message("ui.find.placeholder")}</span>
          <kbd>{FIND_SHORTCUT_HINT}</kbd>
        </button>
      </div>
    </nav>
  );
};

/** The Menu sheet's copy of the appearance pair, as its popover keys spell it. */
const MENU_TOOL_SCOPE = "menu";

const THEME_CHOICES: ReadonlyArray<{ icon: ReactNode; label: MessageId; value: ThemePreference }> = [
  { icon: <SunMedium aria-hidden="true" />, label: "ui.theme.light", value: "light" },
  { icon: <Moon aria-hidden="true" />, label: "ui.theme.dark", value: "dark" },
  { icon: <MonitorCog aria-hidden="true" />, label: "ui.theme.matchSystem", value: "auto" },
];

/** Nav panels MUST enter the top layer so the scroll boxes cannot clip them. */
const useNavToolPopover = (
  open: boolean,
  navRow: boolean,
  buttonRef: RefObject<HTMLButtonElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
) => {
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!(open && navRow && button && panel)) return undefined;

    if (typeof panel.showPopover === "function") panel.showPopover();
    else panel.removeAttribute("popover");

    const position = () => {
      const trigger = button.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const margin = 8;
      const gap = 4;
      const left = Math.max(margin, Math.min(trigger.left, window.innerWidth - width - margin));
      const below = trigger.bottom + gap;
      const above = trigger.top - height - gap;
      let top = below;
      if (below + height > window.innerHeight - margin) {
        top = above >= margin ? above : Math.max(margin, Math.min(below, window.innerHeight - height - margin));
      }
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      if (typeof panel.hidePopover === "function" && panel.matches(":popover-open")) panel.hidePopover();
    };
  }, [open, navRow, buttonRef, panelRef]);
};

/**
 * Theme as a menu, not a cycle: three named choices, each showing which one is
 * on. A toggle could not say what "follow the system" was doing, and a second
 * click on a cycle was the control users read as broken.
 */
const ThemeTile = ({
  localizer,
  navRow = false,
  onToggle,
  open,
}: {
  localizer: Localizer;
  navRow?: boolean;
  onToggle: (button: HTMLButtonElement | null) => void;
  open: boolean;
}) => {
  const { preference, setPreference, theme } = useTheme();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useNavToolPopover(open, navRow, buttonRef, panelRef);
  const label = localizer.message("ui.tools.theme");
  const current = THEME_CHOICES.find((choice) => choice.value === preference);
  const currentName = localizer.message(current?.label ?? "ui.theme.matchSystem");
  return (
    <span className={navRow ? "tool-anchor nav-tool-anchor" : "tool-anchor"}>
      <button
        aria-expanded={open}
        aria-label={`${label}: ${currentName}`}
        className={navRow ? "tool nav-row nav-tool" : "tool"}
        onClick={() => onToggle(buttonRef.current)}
        ref={buttonRef}
        type="button"
      >
        <Moon aria-hidden="true" className="ico-moon" />
        <SunMedium aria-hidden="true" className="ico-sun" />
        {navRow ? (
          <span className="nav-row-label">{label}</span>
        ) : (
          <span aria-hidden="true" className="tip">
            {label}
          </span>
        )}
      </button>
      {open ? (
        <div
          className={navRow ? "tool-pop nav-tool-pop" : "tool-pop"}
          popover={navRow ? "manual" : undefined}
          ref={panelRef}
          role="menu"
        >
          <p className="tool-pop-head">{label}</p>
          {THEME_CHOICES.map((choice) => (
            <button
              aria-checked={choice.value === preference}
              className="tool-pop-item"
              key={choice.value}
              onClick={(event) => {
                runAppearanceWipe(() => setPreference(choice.value), event.currentTarget, "theme");
                onToggle(buttonRef.current);
              }}
              role="menuitemradio"
              type="button"
            >
              {choice.icon}
              {localizer.message(choice.label)}
              {choice.value === "auto" ? (
                <span className="tool-pop-note">
                  {localizer.message(theme === "dark" ? "ui.theme.dark" : "ui.theme.light")}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
};

/**
 * Accent quick picker: the button wears the live dye, and opening it drops the
 * six lots below it. Choosing one commits immediately - the picker exists
 * precisely to skip the settings panel's draft/Save round trip, and an accent
 * is self-evidently reversible. It stays open on pick so comparing two lots
 * does not cost a reopen.
 */
const AccentTile = ({
  localizer,
  name,
  navRow = false,
  onChange,
  onToggle,
  open,
}: {
  localizer: Localizer;
  /** Radio group name. Two pickers share the page, and one name would join them. */
  name: string;
  navRow?: boolean;
  onChange: (accent: string) => void;
  onToggle: (button: HTMLButtonElement | null) => void;
  open: boolean;
}) => {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);
  useNavToolPopover(open, navRow, buttonRef, panelRef);
  const accent = useAccent();
  const label = localizer.message("ui.tools.accent");
  const currentLabel = ACCENTS.find((entry) => entry.value === accent)?.label ?? "";

  // Opening with the keyboard has to land somewhere; the current lot is the
  // only sensible anchor for the arrow keys that follow.
  useEffect(() => {
    if (!open) return;
    trayRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [open]);

  return (
    <span className={navRow ? "tool-anchor nav-tool-anchor" : "tool-anchor"}>
      <button
        aria-expanded={open}
        aria-label={`${label}: ${currentLabel}`}
        className={navRow ? "tool accent-tool nav-row nav-tool" : "tool accent-tool"}
        onClick={() => onToggle(buttonRef.current)}
        ref={buttonRef}
        type="button"
      >
        <Palette aria-hidden="true" />
        <span aria-hidden="true" className="accent-tool-dot" />
        {navRow ? (
          <span className="nav-row-label">{label}</span>
        ) : (
          <span aria-hidden="true" className="tip">
            {label}
          </span>
        )}
      </button>
      {open ? (
        <div
          className={navRow ? "tool-pop accent-pop nav-tool-pop" : "tool-pop accent-pop"}
          popover={navRow ? "manual" : undefined}
          ref={panelRef}
        >
          <p className="tool-pop-head">{`${label}: ${currentLabel}`}</p>
          <div aria-label={label} className="accent-tray" ref={trayRef} role="radiogroup">
            {ACCENTS.map((entry) => (
              <label className="accent-chip" key={entry.value} title={entry.label}>
                <input
                  aria-label={entry.label}
                  checked={entry.value === accent}
                  name={name}
                  onChange={(event) =>
                    runAppearanceWipe(() => onChange(entry.value), event.currentTarget.closest("label"), "accent")
                  }
                  type="radio"
                  value={entry.value}
                />
                <span aria-hidden="true" className="accent-chip-dot" style={{ background: entry.swatch }} />
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
};

/** Docs, source and support: the same three links, in the same order, in both layouts. */
const ProjectTiles = ({
  confirmExternalNavigation,
  docsHref,
  donateHref,
  githubHref,
  localizer,
  onOpenDocs,
}: {
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  docsHref: string;
  donateHref?: string;
  githubHref?: string;
  localizer: Localizer;
  onOpenDocs: () => void;
}) => {
  const docsLabel = localizer.message("ui.nav.docs");
  const githubLabel = localizer.message("ui.tools.github");
  const supportLabel = localizer.message("ui.footer.donate");
  return (
    <>
      <a
        aria-label={docsLabel}
        className="tool"
        href={docsHref}
        onClick={(event) => activateOnClick(event, onOpenDocs)}
      >
        <BookOpenGlyph />
        <span aria-hidden="true" className="tip">
          {docsLabel}
        </span>
      </a>
      {githubHref ? (
        <a
          aria-label={githubLabel}
          className="tool"
          href={githubHref}
          onClick={(event) => guardExternalClick(event, githubHref, confirmExternalNavigation)}
          rel="noreferrer"
          target="_blank"
        >
          <Github aria-hidden="true" />
          <span aria-hidden="true" className="tip">
            {localizer.message("ui.tools.githubShort")}
          </span>
        </a>
      ) : null}
      {donateHref ? (
        <a
          aria-label={supportLabel}
          className="tool tool-support"
          href={donateHref}
          onClick={(event) => guardExternalClick(event, donateHref, confirmExternalNavigation)}
          rel="noreferrer"
          target="_blank"
        >
          <Heart aria-hidden="true" />
          <span aria-hidden="true" className="tip">
            {supportLabel}
          </span>
        </a>
      ) : null}
    </>
  );
};

const BookOpenGlyph = () => (
  <svg
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
  >
    <path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
  </svg>
);

/**
 * The prerendered shells ship a placeholder runtime status that the parser-time
 * resolver in `index.html` rewrites before React loads - that is what stops the
 * value visibly changing at hydration. The resolver decides synchronously, from
 * the isolation flag and `navigator.serviceWorker.controller`; the store's
 * status arrives from an async registration and reads "off" until it lands.
 *
 * So the first render has to answer the way the resolver already did, or React
 * hydrates "sw off" against the DOM's "sw", throws, and discards the server
 * HTML for the whole page. Keep this in step with the resolver in `index.html`.
 */
const readResolvedServiceWorkerStatus = (): ServiceWorkerStatus | null => {
  if (typeof document === "undefined" || typeof navigator === "undefined") return null;
  const enabled = document.documentElement.dataset.serviceWorkerEnabled === "true";
  const serviceWorker = navigator.serviceWorker;
  if (!(enabled && serviceWorker)) return "off";
  // A controller alone is not "ready" any more: the offline copy also needs the
  // background warm-up (EmulatorJS + identify packs). The warm-up client
  // persists completion under this key; the resolver in `index.html` reads the
  // same key and MUST stay in step.
  let warmupReady = false;
  try {
    warmupReady = localStorage.getItem("rom-weaver-offline-ready") === "true";
  } catch {
    warmupReady = false;
  }
  if (serviceWorker.controller && warmupReady) return typeof MessageChannel === "function" ? "active" : "ready";
  return null;
};

const useHydratedServiceWorkerStatus = (status: ServiceWorkerStatus | null | undefined) => {
  const [resolved] = useState(readResolvedServiceWorkerStatus);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated ? status : resolved;
};

/**
 * The runtime status control and its dialog share these states in display order.
 * A controlling worker or a ready cache does not prove that this document was served from cache.
 */
type RuntimeState = "active" | "ready" | "update" | "installing" | "disabled" | "online";

const RUNTIME_STATES: readonly RuntimeState[] = ["active", "ready", "update", "installing", "online", "disabled"];

const RUNTIME_MESSAGES: Record<RuntimeState, { label: MessageId; description: MessageId }> = {
  active: { description: "ui.runtime.activeDesc", label: "ui.runtime.active" },
  disabled: { description: "ui.runtime.disabledDesc", label: "ui.runtime.disabled" },
  installing: { description: "ui.runtime.installingDesc", label: "ui.runtime.installing" },
  online: { description: "ui.runtime.offlineDisabledDetail", label: "ui.runtime.offlineDisabled" },
  ready: { description: "ui.runtime.readyDesc", label: "ui.runtime.ready" },
  update: { description: "ui.runtime.updateDesc", label: "ui.runtime.update" },
};

/** Byte progress of the background offline warm-up, when the page knows it. */
type OfflineWarmupDisplayProgress = {
  cachedBytes: number;
  /** Files already cached (EmulatorJS files and identify packs counted individually). */
  cachedFiles?: number;
  /** Human description of the unit the progress event is about. */
  detail?: { kind: string; name: string } | null;
  /**
   * The install stage that emitted these combined precache and warm-up totals.
   */
  phase?: "precache" | "warmup";
  ready: boolean;
  totalBytes: number;
  totalFiles?: number;
  /** Measured encoded bytes transferred for cached offline target files. */
  transferredBytes?: number;
  /** One or more cached target files have no measured encoded size. */
  transferBytesIncomplete?: boolean;
  /** Warm-up unit label, e.g. "emulatorjs:loader.js" or "identify-group:<id>". */
  unit?: string | null;
  /** Bytes of the in-flight unit downloaded so far; null/absent outside a download. */
  unitLoadedBytes?: number | null;
  unitTotalBytes?: number | null;
};

/**
 * Whole percent for an incomplete install; null when no total is known yet.
 * Both install stages report the same combined byte totals - the app's own
 * precache plus the warm-up set - so one percentage covers the whole install.
 * Entry counts are the fallback for a build with no precache size map (dev, or
 * a host still serving an older bundle).
 */
const offlineWarmupPercent = (progress: OfflineWarmupDisplayProgress | null): number | null => {
  if (!progress || progress.ready) return null;
  const wholePercent = (done: number, total: number) => Math.min(99, Math.floor((done / total) * 100));
  if (progress.totalBytes > 0) return wholePercent(progress.cachedBytes, progress.totalBytes);
  if (typeof progress.totalFiles === "number" && progress.totalFiles > 0) {
    return wholePercent(progress.cachedFiles ?? 0, progress.totalFiles);
  }
  return null;
};

/**
 * Human wording for a warm-up unit, for the status detail line. Prefers the
 * structured detail (which carries a group's display label); falls back to
 * parsing the internal unit label.
 */
const describeWarmupUnit = (
  localizer: { message: (id: MessageId, values?: Record<string, unknown>) => string },
  progress: Pick<OfflineWarmupDisplayProgress, "detail" | "unit"> | null | undefined,
): string | null => {
  let kind = progress?.detail?.kind;
  let name = progress?.detail?.name;
  if (!(kind && name)) {
    const unit = progress?.unit;
    if (typeof unit !== "string" || !unit) return null;
    const separator = unit.indexOf(":");
    if (separator < 0) return null;
    kind = unit.slice(0, separator);
    name = unit.slice(separator + 1);
  }
  if (!name) return null;
  if (kind === "emulatorjs") return localizer.message("ui.runtime.detailEmulatorFile", { name });
  if (kind === "identify-group") return localizer.message("ui.runtime.detailIdentifyGroup", { name });
  return null;
};

/**
 * A pending update takes priority over cache readiness.
 * Offline readiness also requires EmulatorJS and the required or selected identify groups to finish caching.
 */
const resolveRuntimeState = (
  status: ServiceWorkerStatus | null | undefined,
  updateReady: boolean,
  offlineProgress: OfflineWarmupDisplayProgress | null = null,
  offlineCopyEnabled = true,
): RuntimeState => {
  if (updateReady) return "update";
  if (status === "off") return "disabled";
  if (!offlineCopyEnabled) return "online";
  if ((status === "active" || status === "ready") && !offlineProgress?.ready) return "installing";
  if (status === "active") return "active";
  if (status === "ready") return "ready";
  return "installing";
};

/**
 * The install wording on its own. Callers that print the percent in their own
 * element MUST use this rather than {@link installingRuntimeLabel}, or the page
 * states the same percentage twice.
 */
const installingRuntimeWording = (
  localizer: { message: (id: MessageId, values?: Record<string, unknown>) => string },
  offlineProgress: OfflineWarmupDisplayProgress | null,
) => localizer.message(offlineProgress?.phase === "precache" ? "ui.runtime.installingApp" : "ui.runtime.installing");

/** The install wording with the percent folded in, for a single-string caller. */
const installingRuntimeLabel = (
  localizer: { message: (id: MessageId, values?: Record<string, unknown>) => string },
  offlineProgress: OfflineWarmupDisplayProgress | null,
) => {
  const percent = offlineWarmupPercent(offlineProgress);
  if (percent === null) return installingRuntimeWording(localizer, offlineProgress);
  return localizer.message(
    offlineProgress?.phase === "precache" ? "ui.runtime.installingAppProgress" : "ui.runtime.installingProgress",
    { percent },
  );
};

const RUNTIME_ICONS = {
  active: CloudCheck,
  disabled: CloudOff,
  installing: LoaderCircle,
  online: CloudOff,
  ready: PackageCheck,
  update: CloudDownload,
} satisfies Record<RuntimeState, typeof CloudCheck>;

const PROGRESS_RING_RADIUS = 9;
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_RADIUS;

/** Determinate ring on the Lucide 24-box: the arc fills clockwise from 12 o'clock. */
const ProgressRingGlyph = ({ percent }: { percent: number }) => {
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * PROGRESS_RING_CIRCUMFERENCE;
  return (
    <svg
      aria-hidden="true"
      className="sw-progress-ring"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" opacity="0.25" r={PROGRESS_RING_RADIUS} />
      <circle
        cx="12"
        cy="12"
        r={PROGRESS_RING_RADIUS}
        strokeDasharray={`${filled} ${PROGRESS_RING_CIRCUMFERENCE - filled}`}
        strokeDashoffset={PROGRESS_RING_CIRCUMFERENCE / 4}
        strokeLinecap="round"
      />
    </svg>
  );
};

/**
 * Uses the shared Lucide set for every service-worker state. An installing
 * state with a known percent gets a determinate progress ring instead of the
 * indeterminate spinner.
 */
const RuntimeGlyph = ({ state, percent = null }: { state: RuntimeState; percent?: number | null }) => {
  if (state === "installing" && typeof percent === "number") return <ProgressRingGlyph percent={percent} />;
  const Icon = RUNTIME_ICONS[state];
  return <Icon aria-hidden="true" strokeWidth={2.4} />;
};

/**
 * The offline state, as a word rather than a lone glyph. `.sub-status` and its
 * inner `.sub-status-text` are what the parser-time resolver in `index.html`
 * rewrites, so both class names are load-bearing.
 */
const StatusChip = ({
  label,
  onOpenStatus,
  percent,
  state,
  title,
}: {
  label: string;
  onOpenStatus: () => void;
  percent: number | null;
  state: RuntimeState;
  title: string;
}) => (
  <button
    aria-haspopup="dialog"
    aria-label={title}
    className="sub-chip sub-status"
    data-sw={state}
    onClick={onOpenStatus}
    title={title}
    type="button"
  >
    <RuntimeGlyph percent={percent} state={state} />
    <span className="sub-status-text">{label}</span>
    {percent === null ? null : <span className="sub-status-percent">{`${percent}%`}</span>}
  </button>
);

const guardExternalClick = (
  event: { preventDefault: () => void },
  href: string,
  confirmExternalNavigation?: (href: string) => Promise<boolean>,
) => {
  if (!confirmExternalNavigation) return;
  event.preventDefault();
  void confirmExternalNavigation(href).then((accepted) => {
    if (accepted) window.open(href, "_blank", "noopener,noreferrer");
  });
};

/**
 * Version and channel merge into one build tag: a plain dotted link on stable
 * that opens the changelog, and a compact channel label everywhere else. A PR
 * preview is the exception - the number IS the useful identity, so it links
 * straight to the pull request.
 */
const CHANNEL_SUFFIXES: Record<string, string> = { beta: "b", dev: "d", nightly: "n" };
const CHANNEL_MESSAGES: Record<string, MessageId> = {
  beta: "ui.channel.beta",
  dev: "ui.channel.dev",
  nightly: "ui.channel.nightly",
  preview: "ui.channel.preview",
};

const BuildTag = ({
  channelBadge,
  commitDistance,
  confirmExternalNavigation,
  dirty,
  githubBaseHref,
  localizer,
  onOpenWhatsNew,
  version,
  versionTitle,
}: {
  channelBadge?: string;
  commitDistance: number;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  dirty?: boolean;
  githubBaseHref?: string;
  localizer: Localizer;
  onOpenWhatsNew: () => void;
  version: string;
  versionTitle?: string;
}) => {
  const suffix = CHANNEL_SUFFIXES[channelBadge?.toLowerCase() ?? ""] ?? "";
  const versionText = `v${version}${suffix}${commitDistance ? `+${commitDistance}` : ""}${dirty ? "*" : ""}`;
  const prNumber = channelBadge?.match(/^pr-(\d+)$/i)?.[1];
  if (prNumber) {
    const prHref = githubBaseHref ? `${githubBaseHref}pull/${prNumber}` : undefined;
    const prLabel = `${localizer.message("ui.channel.prPreview")}, PR #${prNumber}, ${versionText}`;
    return (
      <span className="build-tag">
        <a
          aria-label={prLabel}
          className="sub-chip channel-badge"
          data-channel="pr"
          href={prHref ?? "#"}
          onClick={(event) => (prHref ? guardExternalClick(event, prHref, confirmExternalNavigation) : undefined)}
          rel="noreferrer"
          target="_blank"
        >
          {`PR-#${prNumber}`}
          <span className="tag-extra">
            <span aria-hidden="true" className="tag-separator">
              {" / "}
            </span>
            <span className="tag-version">{versionText}</span>
          </span>
        </a>
      </span>
    );
  }
  if (channelBadge) {
    const key = channelBadge.toLowerCase();
    const letter = channelBadge.slice(0, 1).toUpperCase();
    const nameId = CHANNEL_MESSAGES[key];
    const name = nameId ? localizer.message(nameId) : channelBadge;
    let channelText: ReactNode = null;
    if (!suffix) channelText = <b className="tag-letter">{letter}</b>;
    return (
      <span className="build-tag">
        <button
          aria-haspopup="dialog"
          aria-label={`${name}, ${versionText}`}
          className="sub-chip channel-badge"
          data-channel={key}
          onClick={onOpenWhatsNew}
          type="button"
        >
          {channelText}
          {suffix ? null : (
            <span aria-hidden="true" className="tag-separator">
              {" / "}
            </span>
          )}
          <span className="tag-version">{versionText}</span>
        </button>
      </span>
    );
  }
  return (
    <span className="build-tag">
      <button
        aria-haspopup="dialog"
        className="sub-chip sub-link"
        onClick={onOpenWhatsNew}
        title={versionTitle}
        type="button"
      >
        {versionText}
      </button>
    </span>
  );
};

/** Version and worker threads: the two facts that only change on release or in Settings. */
const BuildFacts = ({
  buildTag,
  onOpenThreads,
  onPreloadSettings,
  threads,
  threadsLabel,
}: {
  buildTag: ReactNode;
  onOpenThreads: () => void;
  onPreloadSettings?: () => void;
  threads?: number;
  threadsLabel: string;
}) => (
  <span className="build-facts">
    {buildTag}
    {buildTag && threads ? (
      <span aria-hidden="true" className="sub-separator">
        /
      </span>
    ) : null}
    {threads ? (
      <button
        aria-haspopup="dialog"
        aria-label={`${threads} ${threadsLabel}`}
        className="sub-chip sub-link masthead-threads"
        data-thread-label={threadsLabel}
        onClick={onOpenThreads}
        onFocus={onPreloadSettings}
        onPointerDown={onPreloadSettings}
        onPointerEnter={onPreloadSettings}
        type="button"
      >
        <span className="masthead-threads-count">{threads}</span>
        <span aria-hidden="true" className="masthead-threads-space">
          {" "}
        </span>
        <span aria-hidden="true">{threadsLabel}</span>
      </button>
    ) : null}
  </span>
);

const Masthead = ({
  channelBadge,
  commitsSinceVersion,
  onAccentChange,
  tabs,
  currentTab,
  dirty,
  homeHref,
  onSelectTab,
  onOpenWhatsNew,
  onOpenLog,
  onOpenStatus,
  onOpenStorage,
  onPreloadLog,
  onOpenSettings,
  onOpenSettingsField,
  onOpenThreads,
  onPreloadSettings,
  serviceWorkerStatus,
  offlineProgress = null,
  previewRuntimeState = null,
  confirmExternalNavigation,
  donateHref,
  githubHref,
  threads,
  updateReady = false,
  version,
  versionTitle,
}: {
  /** Deploy channel marker; empty on production, which wears the plain brand. */
  channelBadge?: string;
  commitsSinceVersion?: number | null;
  onAccentChange?: (accent: string) => void;
  tabs: WorkflowTab[];
  currentTab: string;
  dirty?: boolean;
  /** Base URL of the app's Home route. */
  homeHref: string;
  onSelectTab: (id: string) => void;
  onOpenWhatsNew: () => void;
  onOpenLog: () => void;
  onOpenStatus: () => void;
  onOpenStorage?: () => void;
  onPreloadLog?: () => void;
  onOpenSettings: () => void;
  /** Find's deep link into one settings field; falls back to plain Settings. */
  onOpenSettingsField?: (fieldId: string) => void;
  /** Deep link from the thread count into the Threads setting; falls back to plain Settings. */
  onOpenThreads?: () => void;
  onPreloadSettings?: () => void;
  serviceWorkerStatus?: ServiceWorkerStatus | null;
  offlineProgress?: OfflineWarmupDisplayProgress | null;
  previewRuntimeState?: RuntimeState | null;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  donateHref?: string;
  githubHref?: string;
  threads?: number;
  updateReady?: boolean;
  version?: string;
  versionTitle?: string;
}) => {
  const settings = useRomWeaverSettings();
  const localizer = useUiLocalizer();
  const betaToolsEnabled = settings.betaToolsEnabled !== false;
  /* Keyed by kind AND copy: the same viewport now shows the pair twice - the
     chrome copy and the one inside the navigation - and a key of "theme" alone
     would open both menus from one press. */
  const [openTool, setOpenTool] = useState<string | null>(null);
  /* The control that opened the popover, so Escape returns focus to it. Several
     copies of the pair are in the DOM at once, so the DOM cannot say which one
     the user actually used. */
  const openToolRef = useRef<HTMLButtonElement | null>(null);
  const toggleTool = (key: string, button: HTMLButtonElement | null) => {
    openToolRef.current = button;
    setOpenTool((open) => (open === key ? null : key));
  };
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const findTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuFindRef = useRef<HTMLButtonElement | null>(null);
  /* Find opens from the top bar on desktop and from the Menu sheet's foot on
     the phone. Escape restores focus to whichever of those the layout shows,
     resolved at call time rather than stored, because the layout is CSS's
     decision and this component never reads a breakpoint. */
  const activeFindRef = useMemo(
    () => ({
      get current() {
        return visibleFirst([findTriggerRef.current, menuFindRef.current, menuTriggerRef.current]);
      },
      set current(node: HTMLButtonElement | null) {
        findTriggerRef.current = node;
      },
    }),
    [],
  );
  const navLabel = localizer.message("ui.nav.primary");
  const threadsLabel = localizer.message("ui.env.threads");
  const docsHref = tabs.find((tab) => tab.id === "docs")?.href ?? "docs";

  /* The beta-tools setting is client-only, so the prerendered shell must not
     disagree with the first hydration pass: every beta row is in the markup
     from the start and is revealed once the client setting is known. */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const betaVisible = hydrated && betaToolsEnabled;
  // Find honours the beta-tools setting the way the nav does. It never renders
  // before hydration, so it can read the setting directly.
  const findSources = useMemo(
    () => ({
      baseHref: homeHref,
      donateHref,
      githubHref,
      tabs: tabs.filter((tab) => betaToolsEnabled || !tab.beta),
    }),
    [betaToolsEnabled, donateHref, githubHref, homeHref, tabs],
  );
  const closeFind = useCallback(() => setFindOpen(false), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const onFindAction = (action: FindAction) => {
    if (action.type === "view") onSelectTab(action.view);
    else if (action.type === "settings") {
      if (action.fieldId && onOpenSettingsField) onOpenSettingsField(action.fieldId);
      else onOpenSettings();
    } else if (action.type === "status") onOpenStatus();
    else if (action.type === "storage") (onOpenStorage ?? onOpenLog)();
    else if (action.type === "logs") onOpenLog();
    else if (action.type === "changelog") onSelectTab("whats-new");
    else if (action.type === "external") openExternalFromFind(action.href, confirmExternalNavigation);
  };
  // `/` from anywhere outside a text field, plus the ⌘K / Ctrl+K alias.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey) return;
      const modified = event.metaKey || event.ctrlKey;
      const chord = modified && !event.shiftKey && event.key.toLowerCase() === "k";
      const slash = !modified && event.key === "/" && !isTextEntryTarget(event.target);
      if (!(chord || slash)) return;
      // A modal dialog makes the shell inert; the shortcut must not open a
      // palette nobody can reach behind its backdrop.
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      setMenuOpen(false);
      setFindOpen((open) => !open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /* The sheet covers the page and its scrim blocks pointer input, so the
     keyboard has to agree: what the sheet covers goes inert while it is open,
     or Tab walks into controls nobody can see or click. The dock stays live
     because its Menu button is what closes the sheet again, and the scrim is a
     close control in its own right. Only attributes set here are cleared, so a
     dialog that inerted the same node keeps its own. */
  useEffect(() => {
    if (!menuOpen) return undefined;
    const sheet = document.getElementById("menu-sheet");
    const covered = Array.from(sheet?.parentElement?.children ?? []).filter(
      (node) => node !== sheet && !node.matches(".dock, .scrim") && !node.hasAttribute("inert"),
    );
    for (const node of covered) node.setAttribute("inert", "");
    return () => {
      for (const node of covered) node.removeAttribute("inert");
    };
  }, [menuOpen]);

  // Pointer-down rather than click so a press that starts outside dismisses
  // before the target's own handler runs.
  useEffect(() => {
    if (!openTool) return undefined;
    /* Scoped to the anchor, not to one cluster: the appearance tiles render in
       several places and a press inside the copy the current layout shows would
       otherwise count as "outside", closing the popover on pointerdown so the
       click never reached the choice. */
    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".tool-anchor")) return;
      setOpenTool(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenTool(null);
      openToolRef.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [openTool]);

  const hydratedStatus = useHydratedServiceWorkerStatus(serviceWorkerStatus);
  const runtimeState =
    previewRuntimeState ??
    resolveRuntimeState(hydratedStatus, updateReady, offlineProgress, settings.offlineCopyEnabled);
  /* The chip prints the percent in its own tabular-numeral span, so the visible
     wording stays percent-free; only the accessible name, which replaces the
     whole chip rather than adding to it, carries the number. */
  const runtimeLabel =
    runtimeState === "installing"
      ? installingRuntimeWording(localizer, offlineProgress)
      : localizer.message(RUNTIME_MESSAGES[runtimeState].label);
  const runtimeSpokenLabel =
    runtimeState === "installing" ? installingRuntimeLabel(localizer, offlineProgress) : runtimeLabel;
  const runtimePercent = runtimeState === "installing" ? offlineWarmupPercent(offlineProgress) : null;
  const runtimeDetail = runtimeState === "installing" ? describeWarmupUnit(localizer, offlineProgress) : null;
  /* A middle dot, not a second colon: the installing wording already ends in
     ": <percent>%", and "copy: 25%: EmulatorJS file x" reads as one broken list. */
  const runtimeTitle = runtimeDetail ? `${runtimeSpokenLabel} · ${runtimeDetail}` : runtimeSpokenLabel;

  const githubBaseHref = githubHref ? `${githubHref.replace(/\/$/, "")}/` : undefined;
  const commitDistance =
    typeof commitsSinceVersion === "number" && Number.isInteger(commitsSinceVersion) && commitsSinceVersion > 0
      ? commitsSinceVersion
      : 0;
  const openThreads = onOpenThreads ?? onOpenSettings;
  const openStorage = onOpenStorage ?? onOpenLog;

  /* One description of the nav, rendered by the sidebar and by the phone menu.
     Both layouts therefore carry every destination, in the same order, under
     the same headings - there is no second, shorter navigation to fall out of
     step with this one. */
  const sections: NavSectionData[] = useMemo(() => {
    const workflowGroup = (group: NavGroup): NavSectionData => ({
      entries: tabs
        .filter((tab) => tab.group === group)
        .map((tab) => ({
          beta: tab.beta,
          current: tab.id === currentTab,
          // The page you are on is always in the nav, even a beta one reached
          // by URL while the setting is off.
          hidden: tab.beta && !betaVisible && tab.id !== currentTab,
          href: tab.href,
          icon: tab.icon,
          id: tab.id,
          label: tab.railLabel ?? tab.label,
          onSelect: () => onSelectTab(tab.id),
          title: fullNameFor(tab),
        })),
      id: group,
      title: localizer.message(NAV_GROUP_TITLES[group]),
    });
    const device: NavSectionData = {
      entries: [
        {
          /* The first client render MUST match the prerendered glyph. The
             parser-time resolver only updates the identity status chips. */
          icon: hydrated && runtimeState === "update" ? <RuntimeGlyph state="update" /> : <Cloud aria-hidden="true" />,
          id: "status",
          label: localizer.message("ui.log.tabStatus"),
          onSelect: onOpenStatus,
          stateLabel: hydrated && runtimeState === "update" ? localizer.message("ui.runtime.update") : undefined,
        },
        {
          icon: <HardDrive aria-hidden="true" />,
          id: "storage",
          label: localizer.message("ui.log.tabStorage"),
          onSelect: openStorage,
        },
        {
          icon: <ScrollText aria-hidden="true" />,
          id: "logs",
          label: localizer.message("ui.log.tabLogs"),
          onSelect: onOpenLog,
        },
        {
          icon: <Settings aria-hidden="true" />,
          id: "settings",
          label: localizer.message("ui.settings.title"),
          onSelect: onOpenSettings,
        },
      ],
      id: "device",
      title: localizer.message("ui.nav.groupDevice"),
    };
    const project = workflowGroup("project");
    project.entries.unshift({
      current: currentTab === "home",
      href: homeHref,
      icon: <House aria-hidden="true" />,
      id: "home",
      label: localizer.message("ui.nav.homeShort"),
      onSelect: () => onSelectTab("home"),
    });
    project.entries.push({
      current: currentTab === "whats-new",
      href: "whats-new",
      icon: <Newspaper aria-hidden="true" />,
      id: "whats-new",
      label: localizer.message("ui.update.whatsNew"),
      onSelect: () => onSelectTab("whats-new"),
    });
    if (githubHref) {
      project.entries.push({
        external: true,
        href: githubHref,
        icon: <Github aria-hidden="true" />,
        id: "github",
        label: localizer.message("ui.tools.githubShort"),
        onExternalClick: (event) => guardExternalClick(event, githubHref, confirmExternalNavigation),
        title: localizer.message("ui.tools.github"),
      });
    }
    if (donateHref) {
      project.entries.push({
        className: "nav-support",
        external: true,
        href: donateHref,
        icon: <Heart aria-hidden="true" />,
        id: "support",
        label: localizer.message("ui.footer.donate"),
        onExternalClick: (event) => guardExternalClick(event, donateHref, confirmExternalNavigation),
      });
    }
    return [workflowGroup("patches"), workflowGroup("roms"), device, project];
  }, [
    betaVisible,
    confirmExternalNavigation,
    currentTab,
    donateHref,
    githubHref,
    homeHref,
    hydrated,
    localizer,
    onOpenLog,
    onOpenSettings,
    onOpenStatus,
    onSelectTab,
    openStorage,
    runtimeState,
    tabs,
  ]);

  // No beta workflow claims a dock slot, so the dock needs no reveal pass.
  const dockTabs = tabs.filter((tab) => tab.dock && !tab.beta);
  // Docs and the landing page bring their own h1, so the brand steps down to a
  // span there rather than giving the document two.
  const BrandHeading = currentTab === "docs" || currentTab === "home" ? "span" : "h1";
  const buildTag = version ? (
    <BuildTag
      channelBadge={channelBadge}
      commitDistance={commitDistance}
      confirmExternalNavigation={confirmExternalNavigation}
      dirty={dirty}
      githubBaseHref={githubBaseHref}
      localizer={localizer}
      onOpenWhatsNew={onOpenWhatsNew}
      version={version}
      versionTitle={versionTitle}
    />
  ) : null;
  /* Theme and accent appear in the chrome (the top bar on desktop, the brand
     row on the phone) and again inside the navigation (the sidebar foot and the
     Menu sheet), so each copy owns its own popover key and radio group name.
     Everything about the app's identity below is rendered exactly once. */
  const appearanceTiles = (scope: string, navRow = false) => (
    <>
      <ThemeTile
        localizer={localizer}
        navRow={navRow}
        onToggle={(button) => toggleTool(`theme:${scope}`, button)}
        open={openTool === `theme:${scope}`}
      />
      <AccentTile
        localizer={localizer}
        name={`shell-accent-${scope}`}
        navRow={navRow}
        onChange={(accent) => onAccentChange?.(accent)}
        onToggle={(button) => toggleTool(`accent:${scope}`, button)}
        open={openTool === `accent:${scope}`}
      />
    </>
  );
  const projectTiles = (
    <ProjectTiles
      confirmExternalNavigation={confirmExternalNavigation}
      docsHref={docsHref}
      donateHref={donateHref}
      githubHref={githubHref}
      localizer={localizer}
      onOpenDocs={() => onSelectTab("docs")}
    />
  );

  return (
    <>
      <a className="skip-link" href="#main-content">
        {localizer.message("ui.common.skipToMain")}
      </a>
      {/* One banner for the whole chrome. It is `display: contents` on desktop,
          so the identity block and the top bar each land in their own grid cell
          while staying inside a single landmark - two `header` elements at this
          level would leave the page with two banners. */}
      <header className="shell-banner">
        {/* One column on desktop, one page header on the phone. Build facts stay
            with the brand, and the phone dock carries runtime status. */}
        <div className="side-col">
          <div className="shell-head">
            <div className="shell-head-top">
              <span className="brand">
                <a aria-label={localizer.message("ui.nav.home")} className="brand-mark-link" href={homeHref}>
                  <BrandMark />
                </a>
                <span className="brand-copy">
                  <a className="brand-word-link" href={homeHref}>
                    <BrandHeading className="brand-word">
                      rom<span className="brand-hy">-</span>
                      <b>weaver</b>
                    </BrandHeading>
                  </a>
                  <BuildFacts
                    buildTag={buildTag}
                    onOpenThreads={openThreads}
                    onPreloadSettings={onPreloadSettings}
                    threads={threads}
                    threadsLabel={threadsLabel}
                  />
                </span>
              </span>
              <div className="shell-head-tools">
                {appearanceTiles("phone")}
                <span aria-hidden="true" className="tool-separator" />
                <span className="phone-project-tools">{projectTiles}</span>
              </div>
            </div>
          </div>
          {/* Desktop: every destination the app has, named, in one column. */}
          <aside className="side-rail">
            <SideNav
              appearance={appearanceTiles("rail", true)}
              localizer={localizer}
              navLabel={navLabel}
              sections={sections}
            />
          </aside>
        </div>
        {/* Desktop top bar: the one box that reaches everything, and the controls
          that change this browser rather than the app. No destinations, so
          nothing in the app is listed in two navigations. */}
        <div className="topbar">
          <button
            aria-controls="find-palette"
            aria-expanded={findOpen}
            aria-haspopup="dialog"
            aria-keyshortcuts="/ Control+K Meta+K"
            className="topbar-find"
            onClick={() => setFindOpen((open) => !open)}
            ref={findTriggerRef}
            type="button"
          >
            <Search aria-hidden="true" />
            <span className="topbar-find-text">{localizer.message("ui.find.placeholder")}</span>
            <kbd>{FIND_SHORTCUT_HINT}</kbd>
          </button>
          <div className="topbar-tools">
            <StatusChip
              label={runtimeLabel}
              onOpenStatus={onOpenStatus}
              percent={runtimePercent}
              state={runtimeState}
              title={runtimeTitle}
            />
            {appearanceTiles("desktop")}
            <span aria-hidden="true" className="tool-separator" />
            {projectTiles}
          </div>
        </div>
      </header>
      <FindPalette
        localizer={localizer}
        onAction={onFindAction}
        onClose={closeFind}
        open={findOpen}
        sources={findSources}
        triggerRef={activeFindRef}
      />
      <PhoneDock
        current={currentTab}
        menuLabel={localizer.message("ui.tools.menu")}
        menuOpen={menuOpen}
        navLabel={navLabel}
        onSelect={onSelectTab}
        onToggleMenu={() => {
          setFindOpen(false);
          onPreloadLog?.();
          setMenuMounted(true);
          setMenuOpen((open) => !open);
        }}
        status={
          <StatusChip
            label={runtimeLabel}
            onOpenStatus={() => {
              closeMenu();
              onOpenStatus();
            }}
            percent={runtimePercent}
            state={runtimeState}
            title={runtimeTitle}
          />
        }
        tabs={dockTabs}
        triggerRef={menuTriggerRef}
      />
      {/* The parser-time resolver runs here, after the identity slots exist. */}
      <span className="shell-identity" hidden />
      <MenuSheet
        appearance={appearanceTiles(MENU_TOOL_SCOPE, true)}
        localizer={localizer}
        onClose={closeMenu}
        findRef={menuFindRef}
        onOpenFind={() => {
          setMenuOpen(false);
          setFindOpen(true);
        }}
        open={menuOpen}
        opened={menuMounted}
        sections={sections}
        toolOpen={openTool === `theme:${MENU_TOOL_SCOPE}` || openTool === `accent:${MENU_TOOL_SCOPE}`}
        triggerRef={menuTriggerRef}
      />
      {/* A real button, so the backdrop is dismissable by keyboard too and
          carries a name rather than being an unlabelled click surface. */}
      <button
        aria-label={localizer.message("ui.common.close")}
        className="scrim"
        hidden={!menuOpen}
        onClick={closeMenu}
        type="button"
      />
    </>
  );
};

/** `/` MUST keep typing into a field; only a bare `/` on the page opens Find. */
const isTextEntryTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
  );
};

/** Find's external rows open like the nav links: guarded when a job is running. */
const openExternalFromFind = (href: string, confirmExternalNavigation?: (href: string) => Promise<boolean>) => {
  if (!confirmExternalNavigation) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  void confirmExternalNavigation(href).then((accepted) => {
    if (accepted) window.open(href, "_blank", "noopener,noreferrer");
  });
};

/** Update-ready banner inside a {@link Reveal}. */
const UpdateBanner = ({
  open,
  title,
  onReload,
  onDismiss,
  onOpenWhatsNew,
}: {
  open: boolean;
  title: string;
  onReload: () => void;
  onDismiss: () => void;
  onOpenWhatsNew: () => void;
}) => {
  const localizer = useUiLocalizer();
  return (
    <Reveal open={open}>
      <div className="updates update-ready" role="status">
        <span aria-hidden="true" className="updates-pulse" />
        <span className="updates-text">
          <b>{localizer.message("ui.update.ready")}</b>{" "}
          <button
            aria-label={`${localizer.message("ui.update.whatsNew")}: ${title}`}
            className="updates-ver mono"
            onClick={onOpenWhatsNew}
            type="button"
          >
            {localizer.message("ui.update.whatsNew")}
          </button>
        </span>
        <button className="btn slim primary" onClick={onReload} type="button">
          {localizer.message("ui.update.reload")}
        </button>
        <BannerDismissButton label={localizer.message("ui.common.dismiss")} onDismiss={onDismiss} />
      </div>
    </Reveal>
  );
};

/** CSS-only slide reveal wrapper (banners). JS only flips hidden + is-open. */
const Reveal = ({ open, children }: { open: boolean; children: ReactNode }) => (
  <div className={join("reveal", open && "is-open")} hidden={!open}>
    {children}
  </div>
);

const BannerDismissButton = ({ label, onDismiss }: { label: string; onDismiss: () => void }) => (
  <button aria-label={label} className="banner-x" onClick={onDismiss} title={label} type="button">
    <X aria-hidden="true" />
  </button>
);

export type { OfflineWarmupDisplayProgress, RuntimeState, WorkflowTab };
export {
  describeWarmupUnit,
  installingRuntimeLabel,
  Masthead,
  offlineWarmupPercent,
  prefersReducedMotion,
  readPwaState,
  Reveal,
  RUNTIME_MESSAGES,
  resolveRuntimeState,
  RUNTIME_STATES,
  RuntimeGlyph,
  UpdateBanner,
};
