import Globe from "lucide-react/dist/esm/icons/globe.js";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import ScrollText from "lucide-react/dist/esm/icons/scroll-text.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import Sun from "lucide-react/dist/esm/icons/sun.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";
import type { Localizer } from "../../presentation/localization/index.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { SETTINGS_FIELD_METADATA } from "../settings/settings-state.ts";
import { useTheme } from "../theme.ts";

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type WorkflowTab = { id: string; label: string; icon: ReactNode };
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
      const selected = rail.querySelector<HTMLButtonElement>('.mode[aria-selected="true"]');
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
    railRef.current?.querySelector<HTMLButtonElement>(`.mode[data-mode="${nextId}"]`)?.focus();
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
          <button
            aria-controls={`panel-${tab.id}`}
            aria-selected={tab.id === current}
            className="mode"
            data-mode={tab.id}
            id={`tab-${tab.id}`}
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            role="tab"
            tabIndex={tab.id === current ? 0 : -1}
            type="button"
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
};

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    if (typeof document.startViewTransition !== "function" || reducedMotion()) {
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
      <Sun aria-hidden="true" className="ico-sun" />
    </button>
  );
};

const LanguageSelector = ({
  language,
  label,
  onChange,
}: {
  language: string;
  label: string;
  onChange: (language: string) => void;
}) => {
  const options = SETTINGS_FIELD_METADATA.language.options || [];
  return (
    <label className="tool language-tool" title={label}>
      <Globe aria-hidden="true" />
      <select aria-label={label} onChange={(event) => onChange(event.currentTarget.value)} value={language}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
};

const Masthead = ({
  logoSrc,
  tabs,
  currentTab,
  onSelectTab,
  onOpenLog,
  onOpenSettings,
  language,
  onLanguageChange,
}: {
  logoSrc?: string;
  tabs: WorkflowTab[];
  currentTab: string;
  onSelectTab: (id: string) => void;
  onOpenLog: () => void;
  onOpenSettings: () => void;
  language: string;
  onLanguageChange: (language: string) => void;
}) => {
  const localizer = useUiLocalizer();
  const logLabel = localizer.message("ui.tools.log");
  const settingsLabel = localizer.message("ui.settings.title");
  return (
    <header className="masthead">
      <span className="brand">
        {logoSrc ? <img alt="" className="brand-mark" height={44} src={logoSrc} width={44} /> : null}
        <h1 className="brand-word">
          rom<span className="brand-hy">–</span>
          <b>weaver</b>
        </h1>
      </span>
      <ModeRail current={currentTab} onSelect={onSelectTab} tabs={tabs} />
      <div className="masthead-tools">
        <LanguageSelector
          label={localizer.message("settings.language")}
          language={language}
          onChange={onLanguageChange}
        />
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
        </button>
        <button
          aria-haspopup="dialog"
          aria-label={settingsLabel}
          className="tool"
          onClick={onOpenSettings}
          title={settingsLabel}
          type="button"
        >
          <Settings aria-hidden="true" />
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
      <div className="updates" role="status">
        <span aria-hidden="true" className="updates-pulse" />
        <span className="updates-text">
          <b>{localizer.message("ui.update.ready")}</b>{" "}
          <button className="updates-ver mono" onClick={onShowChangelog} type="button">
            {title}
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

/** Edge-to-edge status strip at the very bottom of the page. */
const Selvage = ({
  version,
  threads,
  githubHref,
  donateHref,
  confirmExternalNavigation,
}: {
  version?: string;
  threads?: number;
  githubHref?: string;
  donateHref?: string;
  /** Resolves false to block the navigation (e.g. staged work would be lost). */
  confirmExternalNavigation?: (href: string) => Promise<boolean>;
}) => {
  const localizer = useUiLocalizer();
  const guardExternalClick = (event: { preventDefault: () => void }, href: string) => {
    if (!confirmExternalNavigation) return;
    event.preventDefault();
    void confirmExternalNavigation(href).then((accepted) => {
      if (accepted) window.open(href, "_blank", "noopener,noreferrer");
    });
  };
  return (
    <footer className="selvage">
      <div className="sv-inner">
        {version ? <span className="sv-meta mono">v{version}</span> : null}
        {threads ? (
          <span className="sv-meta mono sv-threads">
            {threads} {localizer.message("ui.env.threads")}
          </span>
        ) : null}
        <span className="sv-spacer" />
        {githubHref ? (
          <a
            className="sv-link"
            href={githubHref}
            onClick={(event) => guardExternalClick(event, githubHref)}
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        ) : null}
        {donateHref ? (
          <a
            className="sv-link donate"
            href={donateHref}
            onClick={(event) => guardExternalClick(event, donateHref)}
            rel="noreferrer"
            target="_blank"
          >
            ♥ <span>{localizer.message("ui.footer.donate")}</span>
          </a>
        ) : null}
      </div>
    </footer>
  );
};

export { Masthead, Reveal, Selvage, UpdateBanner, WakeLockBanner };
