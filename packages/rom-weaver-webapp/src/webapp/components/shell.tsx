import { createLucideIcon, Heart, Moon, RotateCcw, ScrollText, Settings, SunMedium, X } from "lucide-react";
import type { IconNode } from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import { BrandMark } from "./brand-mark.tsx";
import type { Localizer } from "../../presentation/localization/index.ts";
import { viewTransitionsUnavailable } from "../../public/react/components/ds/flat-transition.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { useTheme } from "../theme.ts";

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
}: {
  tabs: WorkflowTab[];
  current: string;
  onSelect: (id: string) => void;
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

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const order = tabs.map((tab) => tab.id);
    const currentIndex = order.indexOf(current);
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
        {tabs.map((tab) => (
          <a
            aria-controls={`panel-${tab.id}`}
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
            tabIndex={tab.id === current ? 0 : -1}
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
 */
const ThemeToggle = ({ localizer }: { localizer: Localizer }) => {
  const { theme, toggleTheme } = useTheme();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const label = localizer.message(theme === "dark" ? "ui.theme.toLight" : "ui.theme.toDark");
  const handleClick = () => {
    const root = document.documentElement;
    if (viewTransitionsUnavailable()) {
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

const Masthead = ({
  channelBadge,
  tabs,
  currentTab,
  onSelectTab,
  onOpenLog,
  onOpenSettings,
  onReset,
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
  tabs: WorkflowTab[];
  currentTab: string;
  onSelectTab: (id: string) => void;
  onOpenLog: () => void;
  onOpenSettings: () => void;
  onReset: () => void;
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
  githubHref?: string;
  donateHref?: string;
  settingsOpen?: boolean;
  threads?: number;
  version?: string;
  versionTitle?: string;
}) => {
  const localizer = useUiLocalizer();
  const logLabel = localizer.message("ui.tools.log");
  const settingsLabel = localizer.message("ui.settings.title");
  const guardExternalClick = (event: { preventDefault: () => void }, href: string) => {
    if (!confirmExternalNavigation) return;
    event.preventDefault();
    void confirmExternalNavigation(href).then((accepted) => {
      if (accepted) window.open(href, "_blank", "noopener,noreferrer");
    });
  };
  return (
    <header className="masthead">
      <span className="brand">
        <BrandMark />
        <span className="brand-copy">
          <span className="brand-line">
            <h1 className="brand-word">
              rom<span className="brand-hy">–</span>
              <b>weaver</b>
            </h1>
            {channelBadge ? <span className="channel-badge">{channelBadge}</span> : null}
          </span>
          {version ? (
            <span className="masthead-version mono">
              <span className="build-version-label" title={versionTitle}>
                {version}
              </span>
              {threads ? (
                <span className="masthead-threads">
                  · {threads} {localizer.message("ui.env.threads")}
                </span>
              ) : null}
            </span>
          ) : null}
        </span>
      </span>
      <ModeRail current={currentTab} onSelect={onSelectTab} tabs={tabs} />
      <div className="masthead-tools">
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
        <button
          aria-haspopup="dialog"
          aria-label={logLabel}
          className="tool"
          onClick={onOpenLog}
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
