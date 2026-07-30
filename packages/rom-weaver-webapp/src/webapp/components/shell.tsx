import { createLucideIcon, Heart, Moon, Palette, RotateCcw, ScrollText, Settings, SunMedium, X } from "lucide-react";
import type { IconNode } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrandMark } from "./brand-mark.tsx";
import { ACCENTS, useAccent } from "../accent.ts";
import { LOCALE_OPTIONS, type Localizer } from "../../presentation/localization/index.ts";
import { viewTransitionsUnsupported } from "../../public/react/components/ds/flat-transition.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
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
const supportsAnchoredThumb = () =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("anchor-name", "--rw-tab");

/**
 * Workflow mode rail: tabs with a sliding thumb. Where CSS anchor positioning
 * exists the thumb pins itself to the selected tab; otherwise a layout-effect
 * measure positions it (and re-positions on resize / font swap).
 */
const ModeRail = ({
  tabs,
  current,
  onSelect,
  controlsPanels = true,
}: {
  tabs: WorkflowTab[];
  current: string;
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
  const selectedIndex = tabs.findIndex((tab) => tab.id === current);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const order = tabs.map((tab) => tab.id);
    const currentIndex = focusIndex;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (currentIndex + 1) % order.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (currentIndex + order.length - 1) % order.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = order.length - 1;
    const nextId = next >= 0 ? order[next] : undefined;
    if (nextId === undefined) return;
    event.preventDefault();
    onSelect(nextId);
    railRef.current?.querySelector<HTMLAnchorElement>(`.mode[data-mode="${nextId}"]`)?.focus();
  };

  return (
    <nav aria-label="Workflow mode" className="modes">
      <div
        aria-label="Workflow"
        aria-orientation="horizontal"
        className="mode-rail"
        onKeyDown={handleKeyDown}
        ref={railRef}
        role="tablist"
      >
        <span aria-hidden="true" className="mode-thumb" ref={thumbRef} />
        {tabs.map((tab, index) => (
          <a
            aria-controls={controlsPanels ? `panel-${tab.id}` : undefined}
            aria-selected={tab.id === current}
            className="mode"
            data-mode={tab.id}
            href={tab.href}
            id={`tab-${tab.id}`}
            key={tab.id}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onSelect(tab.id);
            }}
            role="tab"
            tabIndex={index === focusIndex ? 0 : -1}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </a>
        ))}
      </div>
    </nav>
  );
};

/**
 * Theme toggle with the loom circle-wipe: the new theme clip-reveals from the
 * button via a view transition. The wipe itself is the CSS `theme-wipe`
 * keyframe; this only feeds the origin custom properties and flips the theme.
 *
 * Gated on `viewTransitionsUnsupported`, not `viewTransitionsUnavailable`:
 * iOS WebKit is excluded from the latter because named elements misbehave
 * mid-capture, and `html.vt-theme` suppresses every name, so the wipe is a
 * plain root snapshot there.
 */
const ThemeToggle = ({ localizer }: { localizer: Localizer }) => {
  const { theme, toggleTheme } = useTheme();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const label = localizer.message(theme === "dark" ? "ui.theme.toLight" : "ui.theme.toDark");
  const handleClick = () => {
    const root = document.documentElement;
    if (viewTransitionsUnsupported()) {
      toggleTheme();
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    const radius = Math.hypot(Math.max(cx, window.innerWidth - cx), Math.max(cy, window.innerHeight - cy));
    root.style.setProperty("--wipe-x", `${cx}px`);
    root.style.setProperty("--wipe-y", `${cy}px`);
    root.style.setProperty("--wipe-r", `${radius}px`);
    root.classList.add("vt-theme");
    const transition = document.startViewTransition(() => toggleTheme());
    transition.ready.catch(() => undefined);
    const clear = () => root.classList.remove("vt-theme");
    transition.finished.then(clear, clear);
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

type QuickTool = "accent" | "language";

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

/**
 * Language quick picker. The list is `LOCALE_OPTIONS` - one entry per shipped
 * catalog - so every choice here actually changes what the app says.
 */
const LanguagePicker = ({
  language,
  localizer,
  onChange,
  onToggle,
  open,
}: {
  language: string;
  localizer: Localizer;
  onChange: (language: string) => void;
  onToggle: () => void;
  open: boolean;
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const label = localizer.message("ui.tools.language");
  const current = LOCALE_OPTIONS.find((locale) => locale.value === language) || LOCALE_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  return (
    <div className="tool-anchor">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="tool tool-code"
        onClick={onToggle}
        title={label}
        type="button"
      >
        <span aria-hidden="true">{(current?.value || "").slice(0, 2).toUpperCase()}</span>
      </button>
      {open ? (
        <div aria-label={label} className="tool-menu" ref={menuRef} role="menu">
          {LOCALE_OPTIONS.map((locale) => (
            <button
              aria-checked={locale.value === language}
              className="tool-menu-item"
              key={locale.value}
              lang={locale.value}
              onClick={() => onChange(locale.value)}
              role="menuitemradio"
              type="button"
            >
              {locale.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

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

const Masthead = ({
  channelBadge,
  commitHash,
  commitsSinceVersion,
  language,
  onAccentChange,
  onLanguageChange,
  tabs,
  currentTab,
  dirty,
  onSelectTab,
  onOpenLog,
  onPreloadLog,
  onOpenSettings,
  onPreloadSettings,
  onReset,
  tabsControlPanels = true,
  serviceWorkerStatus,
  confirmExternalNavigation,
  githubHref,
  donateHref,
  settingsOpen,
  threads,
  version,
  versionTitle,
}: {
  /** Deploy channel marker; empty on production, which wears the plain brand. */
  channelBadge?: string;
  commitHash?: string;
  commitsSinceVersion?: number | null;
  language?: string;
  onAccentChange?: (accent: string) => void;
  onLanguageChange?: (language: string) => void;
  tabs: WorkflowTab[];
  currentTab: string;
  dirty?: boolean;
  onSelectTab: (id: string) => void;
  onOpenLog: () => void;
  onPreloadLog?: () => void;
  onOpenSettings: () => void;
  onPreloadSettings?: () => void;
  onReset: () => void;
  tabsControlPanels?: boolean;
  serviceWorkerStatus?: ServiceWorkerStatus | null;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  githubHref?: string;
  donateHref?: string;
  settingsOpen?: boolean;
  threads?: number;
  version?: string;
  versionTitle?: string;
}) => {
  const localizer = useUiLocalizer();
  // One slot, so opening either picker closes the other - the two trays sit
  // side by side and would otherwise overlap.
  const [openTool, setOpenTool] = useState<QuickTool | null>(null);
  const toolsRef = useRef<HTMLDivElement | null>(null);
  const BrandHeading = currentTab === "docs" ? "span" : "h1";
  const logLabel = localizer.message("ui.tools.log");
  const settingsLabel = localizer.message("ui.settings.title");
  const threadsLabel = localizer.message("ui.env.threads");
  const isPwa = readPwaState();
  const hydratedStatus = useHydratedServiceWorkerStatus(serviceWorkerStatus);
  const serviceWorkerLabel = hydratedStatus === "off" ? "sw off" : "sw";
  const runtimeStatus = `· ${isPwa ? "pwa" : "web"} · ${serviceWorkerLabel}`;
  const runtimeStatusTitle =
    hydratedStatus === "active"
      ? "This page is controlled by the service worker and its offline cache is available."
      : hydratedStatus === "ready"
        ? "A service worker is installed and ready to take control."
        : hydratedStatus === "off"
          ? "Service-worker offline support is unavailable."
          : undefined;
  // Pointer-down rather than click so a press that starts outside dismisses
  // before the target's own handler runs.
  useEffect(() => {
    if (!openTool) return undefined;
    const dismiss = (event: Event) => {
      const tools = toolsRef.current;
      if (tools && event.target instanceof Node && tools.contains(event.target)) return;
      setOpenTool(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenTool(null);
      toolsRef.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [openTool]);

  const toggleTool = (tool: QuickTool) => setOpenTool((previous) => (previous === tool ? null : tool));

  const guardExternalClick = (event: { preventDefault: () => void }, href: string) => {
    if (!confirmExternalNavigation) return;
    event.preventDefault();
    void confirmExternalNavigation(href).then((accepted) => {
      if (accepted) window.open(href, "_blank", "noopener,noreferrer");
    });
  };
  const githubBaseHref = githubHref ? `${githubHref.replace(/\/$/, "")}/` : undefined;
  const versionHref = version && githubBaseHref ? `${githubBaseHref}releases/tag/v${version}` : undefined;
  const commitHref = commitHash && githubBaseHref ? `${githubBaseHref}commit/${commitHash}` : undefined;
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
          <a aria-label="Home" className="brand-mark-link" href="/">
            <BrandMark />
          </a>
          <span className="brand-copy">
            <span className="brand-line">
              <a aria-label="rom-weaver home" href="/">
                <BrandHeading className="brand-word">
                  rom<span className="brand-hy">-</span>
                  <b>weaver</b>
                </BrandHeading>
              </a>
              {channelBadge ? <span className="channel-badge">{channelBadge}</span> : null}
            </span>
            {version ? (
              <span className="masthead-version mono">
                <span className="build-version-label" title={versionTitle}>
                  {versionHref ? (
                    <a
                      className="build-version-link"
                      href={versionHref}
                      onClick={(event) => guardExternalClick(event, versionHref)}
                      rel="noreferrer"
                      target="_blank"
                    >
                      v{version}
                      {commitDistance ? `+${commitDistance}` : null}
                    </a>
                  ) : (
                    `v${version}${commitDistance ? `+${commitDistance}` : ""}`
                  )}
                  {commitHash ? (
                    <>
                      <span aria-hidden="true"> · </span>
                      {commitHref ? (
                        <a
                          className="build-version-link"
                          href={commitHref}
                          onClick={(event) => guardExternalClick(event, commitHref)}
                          rel="noreferrer"
                          target="_blank"
                        >
                          {commitHash.slice(0, 7)}
                        </a>
                      ) : (
                        commitHash.slice(0, 7)
                      )}
                      {dirty ? "*" : null}
                    </>
                  ) : null}
                </span>
                <span
                  className="masthead-threads"
                  data-thread-label={threadsLabel}
                  title={threads ? `${threads} ${threadsLabel}` : undefined}
                >
                  {threads ? (
                    <>
                      <span aria-hidden="true" className="masthead-threads-full">
                        {`· ${threads} ${threadsLabel}`}
                      </span>
                      <span aria-hidden="true" className="masthead-threads-short">
                        {`· ${threads}T`}
                      </span>
                      <span className="sr-only">{`${threads} ${threadsLabel}`}</span>
                    </>
                  ) : null}
                </span>
                <span className="masthead-runtime" title={runtimeStatusTitle}>
                  {runtimeStatus}
                </span>
              </span>
            ) : null}
          </span>
        </span>
        <ModeRail controlsPanels={tabsControlPanels} current={currentTab} onSelect={onSelectTab} tabs={tabs} />
        <div className="masthead-tools" ref={toolsRef}>
          {githubHref ? (
            <a
              aria-label="GitHub"
              className="tool"
              href={githubHref}
              onClick={(event) => guardExternalClick(event, githubHref)}
              rel="noreferrer"
              target="_blank"
              title="GitHub"
            >
              <Github aria-hidden="true" />
              <span aria-hidden="true" className="tool-text">
                GitHub
              </span>
            </a>
          ) : null}
          {donateHref ? (
            <a
              aria-label={localizer.message("ui.footer.donate")}
              className="tool masthead-donate"
              href={donateHref}
              onClick={(event) => guardExternalClick(event, donateHref)}
              rel="noreferrer"
              target="_blank"
              title={localizer.message("ui.footer.donate")}
            >
              <Heart aria-hidden="true" />
              <span aria-hidden="true" className="tool-text">
                {localizer.message("ui.footer.donate")}
              </span>
            </a>
          ) : null}
          {githubHref || donateHref ? <span aria-hidden="true" className="tools-sep" /> : null}
          <button
            aria-label={localizer.message("ui.settings.reset")}
            className="tool"
            onClick={onReset}
            title={localizer.message("ui.settings.reset")}
            type="button"
          >
            <RotateCcw aria-hidden="true" />
            <span aria-hidden="true" className="tool-text">
              {localizer.message("ui.settings.reset")}
            </span>
          </button>
          <ThemeToggle localizer={localizer} />
          {/* stays open on pick: arrow keys walk the radio group, and comparing
              two lots should not cost a reopen */}
          <AccentPicker
            localizer={localizer}
            onChange={(accent) => onAccentChange?.(accent)}
            onToggle={() => toggleTool("accent")}
            open={openTool === "accent"}
          />
          <LanguagePicker
            language={language || ""}
            localizer={localizer}
            onChange={(next) => {
              onLanguageChange?.(next);
              setOpenTool(null);
            }}
            onToggle={() => toggleTool("language")}
            open={openTool === "language"}
          />
          <button
            aria-haspopup="dialog"
            aria-label={logLabel}
            className="tool"
            onClick={onOpenLog}
            onFocus={onPreloadLog}
            onPointerDown={onPreloadLog}
            onPointerEnter={onPreloadLog}
            title={logLabel}
            type="button"
          >
            <ScrollText aria-hidden="true" />
            <span aria-hidden="true" className="tool-text">
              {logLabel}
            </span>
          </button>
          <button
            aria-expanded={settingsOpen}
            aria-haspopup="dialog"
            aria-label={settingsLabel}
            className="tool"
            onClick={onOpenSettings}
            onFocus={onPreloadSettings}
            onPointerDown={onPreloadSettings}
            onPointerEnter={onPreloadSettings}
            title={settingsLabel}
            type="button"
          >
            <Settings aria-hidden="true" />
            <span aria-hidden="true" className="tool-text">
              {settingsLabel}
            </span>
          </button>
        </div>
      </header>
    </>
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

/** Update-ready banner inside a {@link Reveal}. */
const UpdateBanner = ({
  open,
  title,
  onReload,
  onDismiss,
  onShowChangelog,
}: {
  open: boolean;
  title: string;
  onReload: () => void;
  onDismiss: () => void;
  onShowChangelog: () => void;
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
            onClick={onShowChangelog}
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

export { Masthead, Reveal, UpdateBanner, WakeLockBanner };
