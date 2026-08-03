import {
  createLucideIcon,
  Heart,
  Info,
  Moon,
  MoreHorizontal,
  Newspaper,
  Palette,
  ScrollText,
  Settings,
  SunMedium,
  Wrench,
  X,
} from "lucide-react";
import type { IconNode } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrandMark } from "./brand-mark.tsx";
import { ACCENTS, useAccent } from "../accent.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import type { MessageId } from "../../presentation/localization/catalog.ts";
import { holdTransitionClasses, viewTransitionsUnsupported } from "../../public/react/components/ds/flat-transition.ts";
import { useRomWeaverSettings, useUiLocalizer } from "../../public/react/settings-context.tsx";
import { useTheme } from "../theme.ts";
import type { ServiceWorkerStatus } from "../pwa/service-worker-cache-state.ts";

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

type WorkflowTab = { href: string; id: string; label: string; icon: ReactNode };
const isBetaWorkflowTab = (tab: WorkflowTab) => tab.id === "trim" || tab.id === "tools";
const supportsAnchoredThumb = () =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("anchor-name", "--rw-tab");

/** One motion gate for every programmatic scroll in the chrome. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const scrollTabIntoView = (tab: HTMLElement | null | undefined) => {
  if (!tab?.offsetParent) return;
  tab.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest", inline: "nearest" });
};

/**
 * Tablist keyboard contract shared by the mode rail and the phone dock: arrows
 * and Home/End roam, and both Space and Enter activate. Anchors already fire on
 * Enter, so only Space needs intercepting.
 */
const createTabListKeyDown =
  (order: string[], current: string, onSelect: (id: string) => void, focusTab: (id: string) => void) =>
  (event: React.KeyboardEvent) => {
    if (order.length === 0) return;
    const index = Math.max(0, order.indexOf(current));
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      onSelect(order[index] as string);
      return;
    }
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % order.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + order.length - 1) % order.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = order.length - 1;
    const nextId = next >= 0 ? order[next] : undefined;
    if (nextId === undefined) return;
    event.preventDefault();
    onSelect(nextId);
    focusTab(nextId);
  };

const activateTabOnClick = (event: React.MouseEvent, id: string, onSelect: (id: string) => void) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  onSelect(id);
};

/** Reveal light/dark changes from the theme control that caused them. */
const runThemeWipe = (update: () => void, source: HTMLElement | null) => {
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
  const release = holdTransitionClasses(["vt-theme"]);
  const transition = document.startViewTransition(update);
  transition.ready.catch(() => undefined);
  transition.finished.then(release, release);
};

/**
 * Workflow mode rail: tabs with a sliding thumb. Where CSS anchor positioning
 * exists the thumb pins itself to the selected tab; otherwise a layout-effect
 * measure positions it (and re-positions on resize / font swap).
 */
const ModeRail = ({
  betaToolsEnabled = true,
  tabs,
  current,
  navLabel,
  onSelect,
  controlsPanels = true,
}: {
  betaToolsEnabled?: boolean;
  tabs: WorkflowTab[];
  current: string;
  navLabel: string;
  onSelect: (id: string) => void;
  controlsPanels?: boolean;
}) => {
  const railRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const measuredOnceRef = useRef(false);

  useLayoutEffect(() => {
    if (supportsAnchoredThumb()) return undefined;
    const rail = railRef.current;
    const thumb = thumbRef.current;
    if (!(rail && thumb)) return undefined;
    const position = (animate: boolean) => {
      const selected = rail.querySelector<HTMLAnchorElement>('.mode[aria-selected="true"]');
      if (!selected) return;
      if (!animate) thumb.style.transition = "none";
      thumb.style.left = `${selected.offsetLeft}px`;
      thumb.style.width = `${selected.offsetWidth}px`;
      if (!animate) requestAnimationFrame(() => thumb.style.removeProperty("transition"));
    };
    position(measuredOnceRef.current);
    measuredOnceRef.current = true;
    const reposition = () => position(false);
    window.addEventListener("resize", reposition);
    document.fonts?.ready?.then(reposition).catch(() => undefined);
    return () => window.removeEventListener("resize", reposition);
  }, []);

  // A tablist needs exactly one tabIndex 0 to stay keyboard reachable, and the
  // current view is not always one of these tabs - the 404 shell renders the
  // rail with nothing selected. Roving focus falls back to the first tab.
  const railTabs = tabs.filter((tab) => tab.id !== "tools");
  const interactiveTabs = betaToolsEnabled ? railTabs : railTabs.filter((tab) => !isBetaWorkflowTab(tab));
  const selectedIndex = interactiveTabs.findIndex((tab) => tab.id === current);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const focusedId = interactiveTabs[focusIndex]?.id ?? "";

  // The rail can be scrolled past its column in the snug 1000-1159px band, so
  // the tab that just became current must never be left off-screen.
  useEffect(() => {
    scrollTabIntoView(railRef.current?.querySelector<HTMLAnchorElement>(`.mode[data-mode="${current}"]`));
  }, [current]);

  const handleKeyDown = createTabListKeyDown(
    interactiveTabs.map((tab) => tab.id),
    focusedId,
    onSelect,
    (id) => railRef.current?.querySelector<HTMLAnchorElement>(`.mode[data-mode="${id}"]`)?.focus(),
  );

  return (
    <nav aria-label={navLabel} className="modes">
      <div
        aria-label={navLabel}
        aria-orientation="horizontal"
        className="mode-rail"
        onKeyDown={handleKeyDown}
        ref={railRef}
        role="tablist"
      >
        <span aria-hidden="true" className="mode-thumb" ref={thumbRef} />
        {railTabs.map((tab) => (
          <a
            aria-controls={controlsPanels ? `panel-${tab.id}` : undefined}
            aria-selected={tab.id === current}
            className="mode"
            data-beta-tool={isBetaWorkflowTab(tab) ? "" : undefined}
            data-mode={tab.id}
            href={tab.href}
            id={`tab-${tab.id}`}
            key={tab.id}
            onClick={(event) => activateTabOnClick(event, tab.id, onSelect)}
            role="tab"
            tabIndex={tab.id === focusedId ? 0 : -1}
          >
            {tab.icon}
            <span className="mode-label">{tab.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
};

/**
 * Phone primary nav. Same tablist semantics as the mode rail - roving tabindex,
 * arrows/Home/End, Space and Enter - inside a safe-area-aware fixed dock. The
 * selected tab carries a thread stitch along the dock's top seam, pinned with
 * CSS anchor positioning where it exists and drawn by the tab itself where it
 * does not (see phone dock rules in masthead.css).
 */
const PhoneDock = ({
  betaToolsEnabled = true,
  controlsPanels = true,
  current,
  mobileActions,
  navLabel,
  onSelect,
  tabs,
}: {
  betaToolsEnabled?: boolean;
  controlsPanels?: boolean;
  current: string;
  mobileActions?: ReactNode;
  navLabel: string;
  onSelect: (id: string) => void;
  tabs: WorkflowTab[];
}) => {
  const dockRef = useRef<HTMLDivElement | null>(null);
  const dockTabs = tabs.filter((tab) => tab.id !== "tools");
  const interactiveTabs = betaToolsEnabled ? dockTabs : dockTabs.filter((tab) => !isBetaWorkflowTab(tab));
  const selectedIndex = interactiveTabs.findIndex((tab) => tab.id === current);
  const focusedId = interactiveTabs[selectedIndex >= 0 ? selectedIndex : 0]?.id ?? "";
  const handleKeyDown = createTabListKeyDown(
    interactiveTabs.map((tab) => tab.id),
    focusedId,
    onSelect,
    (id) => dockRef.current?.querySelector<HTMLAnchorElement>(`.dock-tab[data-mode="${id}"]`)?.focus(),
  );
  return (
    <nav aria-label={navLabel} className="dock-nav">
      <div className="dock">
        <div
          aria-label={navLabel}
          aria-orientation="horizontal"
          className="dock-tabs"
          onKeyDown={handleKeyDown}
          ref={dockRef}
          role="tablist"
        >
          <span aria-hidden="true" className="dock-thumb" />
          {dockTabs.map((tab) => (
            <a
              aria-controls={controlsPanels ? `panel-${tab.id}` : undefined}
              aria-selected={tab.id === current}
              className="dock-tab"
              data-beta-tool={isBetaWorkflowTab(tab) ? "" : undefined}
              data-mode={tab.id}
              href={tab.href}
              id={`docktab-${tab.id}`}
              key={tab.id}
              onClick={(event) => activateTabOnClick(event, tab.id, onSelect)}
              role="tab"
              tabIndex={tab.id === focusedId ? 0 : -1}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </a>
          ))}
        </div>
        {mobileActions}
      </div>
    </nav>
  );
};

/** Theme toggle with the loom circle-wipe, retained as a fast masthead action. */
const ThemeToggle = ({ localizer }: { localizer: Localizer }) => {
  const { theme, toggleTheme } = useTheme();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const label = localizer.message(theme === "dark" ? "ui.theme.toLight" : "ui.theme.toDark");
  const handleClick = () => {
    runThemeWipe(toggleTheme, buttonRef.current);
  };
  return (
    <button aria-label={label} className="tool" onClick={handleClick} ref={buttonRef} title={label} type="button">
      <Moon aria-hidden="true" className="ico-moon" />
      <SunMedium aria-hidden="true" className="ico-sun" />
      <span aria-hidden="true" className="tool-text">
        {localizer.message("ui.tools.theme")}
      </span>
    </button>
  );
};

/**
 * Accent quick picker: the button wears the live dye, and opening it drops the
 * six lots below the toolbar. Choosing one commits immediately - the picker
 * exists precisely to skip the settings panel's draft/Save round trip, and an
 * accent is self-evidently reversible.
 *
 * Same swatch radios as the settings panel's picker, so arrow-key roving comes
 * from the native radio group rather than a hand-rolled one.
 */
const AccentPicker = ({
  localizer,
  onChange,
  onToggle,
  open,
}: {
  localizer: Localizer;
  onChange: (accent: string) => void;
  onToggle: () => void;
  open: boolean;
}) => {
  const accent = useAccent();
  const trayRef = useRef<HTMLDivElement | null>(null);
  const label = localizer.message("ui.tools.accent");

  // Opening with the keyboard has to land somewhere; the current lot is the
  // only sensible anchor for the arrow keys that follow.
  useEffect(() => {
    if (!open) return;
    trayRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
  }, [open]);

  return (
    <div className="tool-anchor">
      <button
        aria-expanded={open}
        aria-label={label}
        className="tool accent-tool"
        onClick={onToggle}
        title={label}
        type="button"
      >
        <Palette aria-hidden="true" />
        <span aria-hidden="true" className="accent-tool-dot" />
      </button>
      {open ? (
        <div aria-label={label} className="accent-tray" ref={trayRef} role="radiogroup">
          {ACCENTS.map((entry) => (
            <label className="accent-chip" key={entry.value} title={entry.label}>
              <input
                aria-label={entry.label}
                checked={entry.value === accent}
                name="masthead-accent"
                onChange={() => onChange(entry.value)}
                type="radio"
                value={entry.value}
              />
              <span aria-hidden="true" className="accent-chip-dot" style={{ background: entry.swatch }} />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
};

type UtilityMenuProps = {
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  donateHref?: string;
  githubHref?: string;
  localizer: Localizer;
  menuClassName?: string;
  onOpenChangelog: () => void;
  onOpenLog: () => void;
  onOpenStatus: () => void;
  onOpenStorage?: () => void;
  onOpenTools?: () => void;
  toolsEnabled?: boolean;
  toolsLabel?: string;
};

const UtilityMenu = ({
  confirmExternalNavigation,
  donateHref,
  githubHref,
  localizer,
  menuId,
  onClose,
  onOpenChangelog,
  onOpenLog,
  onOpenStatus,
  onOpenStorage,
  onOpenTools,
  toolsEnabled,
  toolsLabel,
  menuClassName,
  open,
  triggerRef,
}: UtilityMenuProps & {
  menuId: string;
  onClose: () => void;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const toolsButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (toolsButtonRef.current) toolsButtonRef.current.hidden = !(toolsEnabled && onOpenTools);
  }, [onOpenTools, toolsEnabled]);

  useEffect(() => {
    if (!open) return;
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    firstItem?.focus();
  }, [open]);

  const menuItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []).filter(
      (item) => !item.hidden,
    );
  const focusItem = (offset: number) => {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = current < 0 ? 0 : (current + offset + items.length) % items.length;
    items[next]?.focus();
  };

  const select = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <div
      aria-label={localizer.message("ui.tools.more")}
      className={`more-menu${menuClassName ? ` ${menuClassName}` : ""}`}
      hidden={!open}
      id={menuId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
          triggerRef.current?.focus();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          focusItem(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focusItem(-1);
        } else if (event.key === "Home") {
          event.preventDefault();
          menuItems()[0]?.focus();
        } else if (event.key === "End") {
          event.preventDefault();
          menuItems().at(-1)?.focus();
        }
      }}
      ref={menuRef}
      role="menu"
    >
      <button onClick={() => select(onOpenStatus)} role="menuitem" type="button">
        <Info aria-hidden="true" />
        {localizer.message("ui.log.tabStatus")}
      </button>
      <button onClick={() => select(onOpenStorage ?? onOpenLog)} role="menuitem" type="button">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M4 8.5h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z" />
          <path d="M6.5 5h11l2 3.5h-15Z" />
        </svg>
        {localizer.message("ui.log.tabStorage")}
      </button>
      <button onClick={() => select(onOpenLog)} role="menuitem" type="button">
        <ScrollText aria-hidden="true" />
        {localizer.message("ui.log.tabLogs")}
      </button>
      <button onClick={() => select(onOpenChangelog)} role="menuitem" type="button">
        <Newspaper aria-hidden="true" />
        {localizer.message("ui.log.tabChangelog")}
      </button>
      <button
        hidden
        onClick={() => {
          if (onOpenTools) select(onOpenTools);
        }}
        ref={toolsButtonRef}
        role="menuitem"
        type="button"
      >
        <Wrench aria-hidden="true" />
        {toolsLabel ?? "Tools"}
      </button>
      <span aria-hidden="true" className="more-separator" />
      {githubHref ? (
        <a
          className="more-link"
          href={githubHref}
          onClick={(event) => {
            onClose();
            guardFooterExternalClick(event, githubHref, confirmExternalNavigation);
          }}
          rel="noreferrer"
          role="menuitem"
          target="_blank"
        >
          <Github aria-hidden="true" />
          {localizer.message("ui.tools.github")}
        </a>
      ) : null}
      {donateHref ? (
        <a
          className="more-link"
          href={donateHref}
          onClick={(event) => {
            onClose();
            guardFooterExternalClick(event, donateHref, confirmExternalNavigation);
          }}
          rel="noreferrer"
          role="menuitem"
          target="_blank"
        >
          <Heart aria-hidden="true" />
          {localizer.message("ui.footer.donate")}
        </a>
      ) : null}
    </div>
  );
};

const MoreMenu = ({
  buttonClassName,
  className,
  menuId,
  moreLabel,
  onClose,
  onPreloadLog,
  onToggle,
  open,
  renderMenu = true,
  triggerRef,
  ...menuProps
}: UtilityMenuProps & {
  buttonClassName: string;
  className: string;
  menuId: string;
  moreLabel: string;
  onClose: () => void;
  onPreloadLog?: () => void;
  onToggle: () => void;
  open: boolean;
  renderMenu?: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) => (
  <span className={className}>
    <button
      aria-controls={menuId}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={moreLabel}
      className={buttonClassName}
      onClick={onToggle}
      onFocus={onPreloadLog}
      onPointerDown={onPreloadLog}
      onPointerEnter={onPreloadLog}
      ref={triggerRef}
      type="button"
    >
      <MoreHorizontal aria-hidden="true" />
      <span className="tool-text">{moreLabel}</span>
      {buttonClassName === "tool" ? (
        <span aria-hidden="true" className="tip">
          {moreLabel}
        </span>
      ) : null}
    </button>
    {renderMenu ? (
      <UtilityMenu menuId={menuId} onClose={onClose} open={open} triggerRef={triggerRef} {...menuProps} />
    ) : null}
  </span>
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
  if (serviceWorker.controller) return typeof MessageChannel === "function" ? "active" : "ready";
  return null;
};

const useHydratedServiceWorkerStatus = (status: ServiceWorkerStatus | null | undefined) => {
  const [resolved] = useState(readResolvedServiceWorkerStatus);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated ? status : resolved;
};

/**
 * Runtime health the brand's status control paints, and the status dialog
 * explains. `active` and `ready` are the two halves of a working cache: active
 * means this very page came out of it, ready means the copy is there and the
 * next load will. The order below is the order the legend lists them in.
 */
type RuntimeState = "active" | "ready" | "update" | "installing" | "disabled";

const RUNTIME_STATES: readonly RuntimeState[] = ["active", "ready", "update", "installing", "disabled"];

const RUNTIME_MESSAGES: Record<RuntimeState, { label: MessageId; description: MessageId }> = {
  active: { description: "ui.runtime.activeDesc", label: "ui.runtime.active" },
  disabled: { description: "ui.runtime.disabledDesc", label: "ui.runtime.disabled" },
  installing: { description: "ui.runtime.installingDesc", label: "ui.runtime.installing" },
  ready: { description: "ui.runtime.readyDesc", label: "ui.runtime.ready" },
  update: { description: "ui.runtime.updateDesc", label: "ui.runtime.update" },
};

/** An update outranks everything: it is the only state that asks for an action. */
const resolveRuntimeState = (status: ServiceWorkerStatus | null | undefined, updateReady: boolean): RuntimeState => {
  if (updateReady) return "update";
  if (status === "off") return "disabled";
  if (status === "active") return "active";
  if (status === "ready") return "ready";
  return "installing";
};

const CLOUD_PATH = "M17.5 19H9a7 7 0 1 1 6.71-9h.79a4.5 4.5 0 1 1 2 8.5";

/** A cache being served from wears the cloud; a cache only stored wears the box
 * it is stored in. Two states one tint apart on the same cloud read as the same
 * state at 13px, which is the only size either is ever drawn at. */
const STORE_PATH = "M4 8.5h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z";
const CHECK_PATH = "m9 13.5 2.2 2.2L15 12";

/** Cloud checked when the page came from the cache, a checked store when the
 * copy is only saved, bobbing arrow on an update, spinner while installing,
 * slashed cloud when offline support is off. */
const RuntimeGlyph = ({ state }: { state: RuntimeState }) => (
  <svg aria-hidden="true" strokeWidth={2.4} viewBox="0 0 24 24">
    {state === "installing" ? <path d="M21 12a9 9 0 1 1-6.2-8.56" /> : null}
    {state === "ready" ? (
      <>
        <path d="M6.5 5h11l2 3.5h-15Z" />
        <path d={STORE_PATH} />
        <path d={CHECK_PATH} />
      </>
    ) : null}
    {state === "active" || state === "disabled" || state === "update" ? <path d={CLOUD_PATH} /> : null}
    {state === "active" ? <path d={CHECK_PATH} /> : null}
    {state === "disabled" ? <path d="m4 4 16 16" /> : null}
    {state === "update" ? (
      <g className="dl-arrow">
        <path d="M12 12v6" />
        <path d="m9.5 15.5 2.5 2.5 2.5-2.5" />
      </g>
    ) : null}
  </svg>
);

const guardFooterExternalClick = (
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
const CHANNEL_LETTERS: Record<string, string> = { beta: "B", dev: "D", nightly: "N", preview: "P" };
const CHANNEL_PREFIXES: Record<string, string> = { beta: "beta", nightly: "nightly" };
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
  onOpenChangelog,
  version,
  versionTitle,
}: {
  channelBadge?: string;
  commitDistance: number;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  dirty?: boolean;
  githubBaseHref?: string;
  localizer: Localizer;
  onOpenChangelog: () => void;
  version: string;
  versionTitle?: string;
}) => {
  const versionText = `v${version}${commitDistance ? `+${commitDistance}` : ""}${dirty ? "*" : ""}`;
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
          onClick={(event) => (prHref ? guardFooterExternalClick(event, prHref, confirmExternalNavigation) : undefined)}
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
    const letter = CHANNEL_LETTERS[key] ?? channelBadge.slice(0, 1).toUpperCase();
    const prefix = CHANNEL_PREFIXES[key];
    const nameId = CHANNEL_MESSAGES[key];
    const name = nameId ? localizer.message(nameId) : channelBadge;
    return (
      <span className="build-tag">
        <button
          aria-haspopup="dialog"
          aria-label={`${name}, ${versionText}`}
          className="sub-chip channel-badge"
          data-channel={key}
          onClick={onOpenChangelog}
          type="button"
        >
          {prefix ? <span className="tag-channel">{prefix}</span> : <b className="tag-letter">{letter}</b>}
          <span aria-hidden="true" className="tag-separator">
            {" / "}
          </span>
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
        onClick={onOpenChangelog}
        title={versionTitle}
        type="button"
      >
        {versionText}
      </button>
    </span>
  );
};

const Masthead = ({
  channelBadge,
  commitsSinceVersion,
  onAccentChange,
  tabs,
  currentTab,
  dirty,
  donateHref,
  homeHref,
  onSelectTab,
  onOpenChangelog,
  onOpenLog,
  onOpenStatus,
  onOpenStorage,
  onPreloadLog,
  onOpenSettings,
  onOpenThreads,
  onPreloadSettings,
  tabsControlPanels = true,
  serviceWorkerStatus,
  confirmExternalNavigation,
  githubHref,
  settingsOpen,
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
  donateHref?: string;
  /** The workbench, as a route: a bare "/" maps to no route and so hard-reloads. */
  homeHref: string;
  onSelectTab: (id: string) => void;
  onOpenChangelog: () => void;
  onOpenLog: () => void;
  onOpenStatus: () => void;
  onOpenStorage?: () => void;
  onPreloadLog?: () => void;
  onOpenSettings: () => void;
  /** Deep link from the thread count into the Threads setting; falls back to plain Settings. */
  onOpenThreads?: () => void;
  onPreloadSettings?: () => void;
  tabsControlPanels?: boolean;
  serviceWorkerStatus?: ServiceWorkerStatus | null;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  githubHref?: string;
  settingsOpen?: boolean;
  threads?: number;
  updateReady?: boolean;
  version?: string;
  versionTitle?: string;
}) => {
  const settings = useRomWeaverSettings();
  const localizer = useUiLocalizer();
  const betaToolsEnabled = settings.betaToolsEnabled !== false;
  const [accentOpen, setAccentOpen] = useState(false);
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [utilityPlacement, setUtilityPlacement] = useState<"desktop" | "mobile">("desktop");
  const desktopMoreRef = useRef<HTMLButtonElement | null>(null);
  const mobileMoreRef = useRef<HTMLButtonElement | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const BrandHeading = currentTab === "docs" ? "span" : "h1";
  const moreLabel = localizer.message("ui.tools.more");
  const toolsLabel = tabs.find((tab) => tab.id === "tools")?.label ?? "Tools";
  const settingsLabel = localizer.message("ui.settings.title");
  const threadsLabel = localizer.message("ui.env.threads");
  const navLabel = localizer.message("ui.nav.primary");
  const githubLabel = localizer.message("ui.tools.github");
  const supportLabel = localizer.message("ui.footer.donate");
  const hydratedStatus = useHydratedServiceWorkerStatus(serviceWorkerStatus);
  const runtimeState = resolveRuntimeState(hydratedStatus, updateReady);
  const runtimeLabel = localizer.message(RUNTIME_MESSAGES[runtimeState].label);
  const activeMoreRef = utilityPlacement === "mobile" ? mobileMoreRef : desktopMoreRef;
  const toggleUtility = (placement: "desktop" | "mobile") => {
    setUtilityPlacement(placement);
    setUtilityOpen((open) => !open);
  };
  const closeUtility = () => {
    setUtilityOpen(false);
    activeMoreRef.current?.focus();
  };

  // Pointer-down rather than click so a press that starts outside dismisses
  // before the target's own handler runs.
  useEffect(() => {
    if (!(accentOpen || utilityOpen)) return undefined;
    const dismiss = (event: Event) => {
      const tools = toolsRef.current;
      const target = event.target;
      const moreAnchors = [desktopMoreRef.current?.parentElement, mobileMoreRef.current?.parentElement];
      if (target instanceof Node && (tools?.contains(target) || moreAnchors.some((anchor) => anchor?.contains(target))))
        return;
      setAccentOpen(false);
      setUtilityOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (utilityOpen) {
        setUtilityOpen(false);
        activeMoreRef.current?.focus();
      } else {
        setAccentOpen(false);
        toolsRef.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [accentOpen, activeMoreRef, utilityOpen]);

  const githubBaseHref = githubHref ? `${githubHref.replace(/\/$/, "")}/` : undefined;
  const commitDistance =
    typeof commitsSinceVersion === "number" && Number.isInteger(commitsSinceVersion) && commitsSinceVersion > 0
      ? commitsSinceVersion
      : 0;
  return (
    <>
      <a className="skip-link" href="#main-content">
        {localizer.message("ui.common.skipToMain")}
      </a>
      <header className="masthead">
        <span className="brand">
          <a aria-label={localizer.message("ui.nav.home")} className="brand-mark-link" href={homeHref}>
            <BrandMark />
          </a>
          <span className="brand-copy">
            <span className="brand-word-row">
              <a className="brand-word-link" href={homeHref}>
                <BrandHeading className="brand-word">
                  rom<span className="brand-hy">-</span>
                  <b>weaver</b>
                </BrandHeading>
              </a>
            </span>
            <span className="brand-sub-row">
              {version ? (
                <span className="sub-item">
                  <BuildTag
                    channelBadge={channelBadge}
                    commitDistance={commitDistance}
                    confirmExternalNavigation={confirmExternalNavigation}
                    dirty={dirty}
                    githubBaseHref={githubBaseHref}
                    localizer={localizer}
                    onOpenChangelog={onOpenChangelog}
                    version={version}
                    versionTitle={versionTitle}
                  />
                </span>
              ) : null}
              {version && threads ? (
                <span aria-hidden="true" className="sub-separator">
                  /
                </span>
              ) : null}
              {threads ? (
                <span className="sub-item">
                  <button
                    aria-haspopup="dialog"
                    aria-label={`${threads} ${threadsLabel}`}
                    className="sub-chip sub-link masthead-threads"
                    data-thread-label={threadsLabel}
                    onClick={onOpenThreads ?? onOpenSettings}
                    onFocus={onPreloadSettings}
                    onPointerDown={onPreloadSettings}
                    onPointerEnter={onPreloadSettings}
                    type="button"
                  >
                    <span className="masthead-threads-count">{threads}</span>
                    <span aria-hidden="true" className="masthead-threads-space">
                      {" "}
                    </span>
                    <span aria-hidden="true">Threads</span>
                  </button>
                </span>
              ) : null}
            </span>
          </span>
        </span>
        <ModeRail
          betaToolsEnabled={betaToolsEnabled}
          controlsPanels={tabsControlPanels}
          current={currentTab}
          navLabel={navLabel}
          onSelect={onSelectTab}
          tabs={tabs}
        />
        <div className="masthead-tools" ref={toolsRef}>
          {githubHref ? (
            <a
              className="tool mobile-utility-source"
              href={githubHref}
              onClick={(event) => guardFooterExternalClick(event, githubHref, confirmExternalNavigation)}
              rel="noreferrer"
              target="_blank"
            >
              <Github aria-hidden="true" />
              <span aria-hidden="true" className="tip">
                {githubLabel}
              </span>
              <span className="sr-only">{githubLabel}</span>
            </a>
          ) : null}
          {donateHref ? (
            <a
              className="tool tool-support mobile-utility-support"
              href={donateHref}
              onClick={(event) => guardFooterExternalClick(event, donateHref, confirmExternalNavigation)}
              rel="noreferrer"
              target="_blank"
            >
              <Heart aria-hidden="true" />
              <span aria-hidden="true" className="tip">
                {supportLabel}
              </span>
              <span className="sr-only">{supportLabel}</span>
            </a>
          ) : null}
          <span aria-hidden="true" className="actions-sep" />
          <button
            aria-haspopup="dialog"
            aria-label={runtimeLabel}
            className="tool masthead-status sub-status"
            data-sw={runtimeState}
            onClick={onOpenStatus}
            type="button"
          >
            <RuntimeGlyph state={runtimeState} />
            <span className="sr-only sub-status-text">{runtimeLabel}</span>
          </button>
          <ThemeToggle localizer={localizer} />
          {/* stays open on pick: arrow keys walk the radio group, and comparing
              two lots should not cost a reopen */}
          <AccentPicker
            localizer={localizer}
            onChange={(accent) => onAccentChange?.(accent)}
            onToggle={() => setAccentOpen((open) => !open)}
            open={accentOpen}
          />
          <button
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-label={settingsLabel}
            className="tool masthead-settings"
            onClick={onOpenSettings}
            onFocus={onPreloadSettings}
            onPointerDown={onPreloadSettings}
            onPointerEnter={onPreloadSettings}
            type="button"
          >
            <Settings aria-hidden="true" />
            <span aria-hidden="true" className="tool-text">
              {settingsLabel}
            </span>
            <span aria-hidden="true" className="tip">
              {settingsLabel}
            </span>
          </button>
          <MoreMenu
            buttonClassName="tool"
            className="desktop-more"
            confirmExternalNavigation={confirmExternalNavigation}
            donateHref={donateHref}
            githubHref={githubHref}
            localizer={localizer}
            menuId="more-menu"
            moreLabel={moreLabel}
            onClose={closeUtility}
            onOpenChangelog={onOpenChangelog}
            onOpenLog={onOpenLog}
            onOpenStatus={onOpenStatus}
            onOpenStorage={onOpenStorage ?? onOpenLog}
            onOpenTools={() => onSelectTab("tools")}
            onPreloadLog={onPreloadLog}
            onToggle={() => toggleUtility("desktop")}
            open={utilityOpen && utilityPlacement === "desktop"}
            renderMenu={false}
            toolsEnabled={betaToolsEnabled}
            toolsLabel={toolsLabel}
            triggerRef={desktopMoreRef}
          />
          {utilityOpen ? (
            <UtilityMenu
              confirmExternalNavigation={confirmExternalNavigation}
              donateHref={donateHref}
              githubHref={githubHref}
              localizer={localizer}
              menuClassName="shared-more-menu"
              menuId="more-menu"
              onClose={closeUtility}
              onOpenChangelog={onOpenChangelog}
              onOpenLog={onOpenLog}
              onOpenStatus={onOpenStatus}
              onOpenStorage={onOpenStorage ?? onOpenLog}
              onOpenTools={() => onSelectTab("tools")}
              open
              toolsEnabled={betaToolsEnabled}
              toolsLabel={toolsLabel}
              triggerRef={activeMoreRef}
            />
          ) : null}
        </div>
        {/* The parser-time resolver in index.html rewrites the thread count and
            runtime status before the shell paints, and removes itself. Keep its
            marker after the action group so both slots exist when it runs. */}
        <span className="shell-identity" hidden />
      </header>
      <PhoneDock
        betaToolsEnabled={betaToolsEnabled}
        controlsPanels={tabsControlPanels}
        current={currentTab}
        mobileActions={
          <>
            <button
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              className="dock-action dock-settings"
              onClick={onOpenSettings}
              onFocus={onPreloadSettings}
              onPointerDown={onPreloadSettings}
              onPointerEnter={onPreloadSettings}
              type="button"
            >
              <Settings aria-hidden="true" />
              <span>{settingsLabel}</span>
            </button>
            <MoreMenu
              buttonClassName="dock-action"
              className="mobile-more"
              confirmExternalNavigation={confirmExternalNavigation}
              donateHref={donateHref}
              githubHref={githubHref}
              localizer={localizer}
              menuId="more-menu"
              moreLabel={moreLabel}
              onClose={closeUtility}
              onOpenChangelog={onOpenChangelog}
              onOpenLog={onOpenLog}
              onOpenStatus={onOpenStatus}
              onOpenStorage={onOpenStorage ?? onOpenLog}
              onOpenTools={() => onSelectTab("tools")}
              onPreloadLog={onPreloadLog}
              onToggle={() => toggleUtility("mobile")}
              open={utilityOpen && utilityPlacement === "mobile"}
              renderMenu={false}
              toolsEnabled={betaToolsEnabled}
              toolsLabel={toolsLabel}
              triggerRef={mobileMoreRef}
            />
          </>
        }
        navLabel={navLabel}
        onSelect={onSelectTab}
        tabs={tabs}
      />
    </>
  );
};

/** Update-ready banner inside a {@link Reveal}. */
const UpdateBanner = ({
  open,
  title,
  onReload,
  onDismiss,
  onOpenChangelog,
}: {
  open: boolean;
  title: string;
  onReload: () => void;
  onDismiss: () => void;
  onOpenChangelog: () => void;
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
            onClick={onOpenChangelog}
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

/** Wake-lock caution banner inside a {@link Reveal}. */
const WakeLockBanner = ({
  open,
  children,
  onDismiss,
}: {
  open: boolean;
  children: ReactNode;
  onDismiss?: () => void;
}) => {
  const localizer = useUiLocalizer();
  return (
    <Reveal open={open}>
      <div className="wakelock" role="status">
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 3a6 6 0 0 1 6 6c0 2.2-1.2 3.4-2.2 4.6-.8 1-1.3 1.7-1.3 2.9h-5c0-1.2-.5-1.9-1.3-2.9C7.2 12.4 6 11.2 6 9a6 6 0 0 1 6-6Z" />
          <path d="M10 20h4m-3.4 2.5h2.8" />
        </svg>
        <span className="wakelock-text">{children}</span>
        {onDismiss ? (
          <BannerDismissButton label={localizer.message("ui.common.dismiss")} onDismiss={onDismiss} />
        ) : null}
      </div>
    </Reveal>
  );
};

export type { RuntimeState };
export {
  Masthead,
  prefersReducedMotion,
  readPwaState,
  Reveal,
  RUNTIME_MESSAGES,
  resolveRuntimeState,
  RUNTIME_STATES,
  RuntimeGlyph,
  UpdateBanner,
  WakeLockBanner,
};
