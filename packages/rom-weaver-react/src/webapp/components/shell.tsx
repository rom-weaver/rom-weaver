import ClipboardList from "lucide-react/dist/esm/icons/clipboard-list.js";
import Github from "lucide-react/dist/esm/icons/github.js";
import Heart from "lucide-react/dist/esm/icons/heart.js";
import Moon from "lucide-react/dist/esm/icons/moon.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import Sun from "lucide-react/dist/esm/icons/sun.js";
import Terminal from "lucide-react/dist/esm/icons/terminal.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTheme } from "../theme.ts";

/**
 * App-shell primitives: the top bar (wordmark, workflow tabs, theme toggle,
 * settings), the workflow tab list, the footer, and the update/wake-lock
 * banner. Composed by the redesigned webapp root.
 */

const join = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

type WorkflowTab = { id: string; label: string; icon: ReactNode };
const MOBILE_DEVTOOLS_STATE_EVENT = "rom-weaver:mobile-devtools-state";

const readMobileDevToolsOpen = () => typeof window !== "undefined" && window.ROM_WEAVER_ERUDA_PANEL_OPEN === true;

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

const ConsoleLogCopyButton = ({ onCopyConsoleLogs }: { onCopyConsoleLogs: () => Promise<void | string> }) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const label =
    state === "copied" ? "Console logs copied" : state === "failed" ? "Copy console logs failed" : "Copy console logs";
  return (
    <button
      aria-label={label}
      className={join("iconbtn console-copy-toggle", state !== "idle" && state)}
      onClick={() => {
        void onCopyConsoleLogs()
          .then(() => {
            setState("copied");
            window.setTimeout(() => setState("idle"), 1800);
          })
          .catch((error) => {
            console.error("Failed to copy console logs", error);
            setState("failed");
            window.setTimeout(() => setState("idle"), 2400);
          });
      }}
      title={label}
      type="button"
    >
      <ClipboardList aria-hidden="true" />
    </button>
  );
};

const MobileDevToolsButton = ({ onToggleMobileDevTools }: { onToggleMobileDevTools: () => void }) => {
  const [open, setOpen] = useState(readMobileDevToolsOpen);
  useEffect(() => {
    const syncOpenState = () => setOpen(readMobileDevToolsOpen());
    syncOpenState();
    window.addEventListener(MOBILE_DEVTOOLS_STATE_EVENT, syncOpenState);
    return () => window.removeEventListener(MOBILE_DEVTOOLS_STATE_EVENT, syncOpenState);
  }, []);
  return (
    <button
      aria-label="Mobile dev tools"
      aria-pressed={open ? "true" : "false"}
      className="iconbtn mobile-devtools-toggle"
      onClick={onToggleMobileDevTools}
      title="Mobile dev tools"
      type="button"
    >
      <Terminal aria-hidden="true" />
    </button>
  );
};

const Topbar = ({
  logoSrc,
  mobileDevToolsEnabled,
  tabs,
  currentTab,
  onCopyConsoleLogs,
  onSelectTab,
  onToggleMobileDevTools,
  onOpenSettings,
}: {
  logoSrc?: string;
  mobileDevToolsEnabled: boolean;
  tabs: WorkflowTab[];
  currentTab: string;
  onCopyConsoleLogs: () => Promise<void | string>;
  onSelectTab: (id: string) => void;
  onToggleMobileDevTools: () => void;
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
    {mobileDevToolsEnabled ? (
      <>
        <ConsoleLogCopyButton onCopyConsoleLogs={onCopyConsoleLogs} />
        <MobileDevToolsButton onToggleMobileDevTools={onToggleMobileDevTools} />
      </>
    ) : null}
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
