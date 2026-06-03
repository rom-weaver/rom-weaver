import Github from "lucide-react/dist/esm/icons/github.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import Sun from "lucide-react/dist/esm/icons/sun.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";
import { useTheme } from "../theme.ts";

/**
 * App-shell primitives: the top bar (wordmark, workflow tabs, theme toggle,
 * settings), the workflow tab list, the footer, and the update/wake-lock
 * banner. Composed by the redesigned webapp root.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type WorkflowTab = { id: string; label: string; icon: ReactNode };

const WorkflowTabs = ({
  tabs,
  current,
  onSelect,
}: {
  tabs: WorkflowTab[];
  current: string;
  onSelect: (id: string) => void;
}) => (
  <div aria-label="Workflow" className="tabs" role="tablist">
    {tabs.map((tab) => (
      <button
        aria-selected={tab.id === current}
        className="tab"
        key={tab.id}
        onClick={() => onSelect(tab.id)}
        role="tab"
        type="button"
      >
        {tab.icon}
        {tab.label}
      </button>
    ))}
  </div>
);

const ThemeToggle = () => {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      aria-label="Toggle light / dark theme"
      className="iconbtn theme-toggle"
      onClick={toggleTheme}
      title="Toggle light / dark"
      type="button"
    >
      {theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
};

const Topbar = ({
  logoSrc,
  tabs,
  currentTab,
  onSelectTab,
  onOpenSettings,
}: {
  logoSrc?: string;
  tabs: WorkflowTab[];
  currentTab: string;
  onSelectTab: (id: string) => void;
  onOpenSettings: () => void;
}) => (
  <header className="topbar">
    <span className="wordmark">
      {logoSrc ? <img alt="" className="logo" src={logoSrc} /> : null}
      <span className="wm-text">
        rom<span className="hy">-</span>
        <b>weaver</b>
      </span>
    </span>
    <WorkflowTabs current={currentTab} onSelect={onSelectTab} tabs={tabs} />
    <span className="spacer" />
    <ThemeToggle />
    <button aria-label="Settings" className="iconbtn" onClick={onOpenSettings} title="Settings" type="button">
      <Settings aria-hidden="true" />
    </button>
  </header>
);

/** Update-available / wake-lock notice bar. `onReload` shows the reload action; `warn` styles it amber. */
const Banner = ({
  warn,
  icon,
  children,
  onReload,
  onDismiss,
}: {
  warn?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  onReload?: () => void;
  onDismiss?: () => void;
}) => (
  <div className={join("updbar", warn && "warn")} role="status">
    {onReload ? (
      <button aria-label="Reload" className="u-btn" onClick={onReload} title="Reload" type="button">
        <RefreshCw aria-hidden="true" />
      </button>
    ) : (
      icon
    )}
    <span className="u-text">{children}</span>
    {onDismiss ? (
      <button aria-label="Dismiss" className="u-x" onClick={onDismiss} type="button">
        <X aria-hidden="true" />
      </button>
    ) : null}
  </div>
);

const Footer = ({
  version,
  cacheVersion,
  docsHref,
  githubHref,
  donateHref,
}: {
  version?: string;
  cacheVersion?: string;
  docsHref?: string;
  githubHref?: string;
  donateHref?: string;
}) => (
  <footer className="foot">
    {version ? <span className="mono">{version}</span> : null}
    {cacheVersion ? <span className="mono">{cacheVersion}</span> : null}
    {docsHref ? <a href={docsHref}>Docs</a> : null}
    {githubHref ? (
      <a href={githubHref} rel="noreferrer" target="_blank">
        <Github aria-hidden="true" className="inline-block h-[1em] w-[1em] align-[-0.15em]" /> GitHub
      </a>
    ) : null}
    {donateHref ? (
      <a className="donate" href={donateHref} rel="noreferrer" target="_blank">
        <Heart aria-hidden="true" />
        Donate
      </a>
    ) : null}
  </footer>
);

export { Banner, Footer, ThemeToggle, Topbar, type WorkflowTab, WorkflowTabs };
