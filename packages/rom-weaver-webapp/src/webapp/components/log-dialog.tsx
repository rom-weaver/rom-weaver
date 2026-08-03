import { Check, Copy, Download, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { createLogger } from "../../lib/logging.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { listBrowserOpfs } from "../../storage/browser/browser-opfs-cleanup.ts";
import { LOG_LEVELS, type LogLevel } from "../../types/logging.ts";
import { getActiveBrowserVirtualFiles, type BrowserVirtualFile } from "../../workers/protocol/browser-virtual-files.ts";
import type { BrowserOpfsEntry } from "../../workers/protocol/browser-opfs-worker-client.ts";
import { getLastSessionEntries, getLogEntries, type LogStoreEntry, subscribeLogEntries } from "../log-store.ts";
import { APP_VERSION, COMMITS_SINCE_VERSION, COMMIT_HASH, DIRTY_HASH, GIT_BRANCH } from "../build-version.ts";
import { CHANNEL_BADGE } from "../build-channel.ts";
import { ABOUT_URL, GITHUB_URL } from "../project-links.ts";
import type { ServiceWorkerStatus } from "../pwa/service-worker-cache-state.ts";
import { ChangelogPanel } from "./changelog-panel.tsx";
import {
  prefersReducedMotion,
  readPwaState,
  resolveRuntimeState,
  RUNTIME_MESSAGES,
  RUNTIME_STATES,
  RuntimeGlyph,
} from "./shell.tsx";
import type { RuntimeState } from "./shell.tsx";
import type { Localizer } from "../../presentation/localization/index.ts";

/**
 * The masthead Log dialog: a native <dialog> trace inspector over the
 * in-app log store, with a capture-level selector, text search, copy-all, and
 * click-to-copy lines - the loom prototype's inspector wired to the real
 * logger sink. The level selector drives the persisted `logLevel` setting (the
 * same source `configureLogger` and every workflow run read), so raising it to
 * debug/trace here makes the next run capture detailed logs for a bug report.
 */

const logger = createLogger("log-dialog");

const normalizeLevel = (value: string | undefined): LogLevel =>
  value && (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : "warn";

const formatTimestamp = (iso: string) => {
  const timePart = iso.split("T")[1] || iso;
  return timePart.replace("Z", "").slice(0, 12);
};

// Detail objects are untyped (Record<string, unknown>); a single oversized
// payload would otherwise be stringified on render, on every filter keystroke,
// and on copy-all, which can spike memory enough to OOM-crash the tab. Cap the
// serialized length well past anything useful to read inline.
const MAX_DETAILS_CHARS = 4096;

// Keep the scroll range for every matching line while mounting only the rows near the viewport.
// The row height is fixed in CSS so the native scrollbar stays exact without a heavyweight list library.
const TRACE_ROW_HEIGHT = 25;
const VIRTUAL_OVERSCAN_ROWS = 12;

const formatDetails = (details: LogStoreEntry["details"]) => {
  if (!details || Object.keys(details).length === 0) return "";
  try {
    const json = JSON.stringify(details);
    return json.length > MAX_DETAILS_CHARS ? `${json.slice(0, MAX_DETAILS_CHARS)}… (${json.length} chars)` : json;
  } catch {
    return "";
  }
};

// Filter capped UI lines to avoid repeated large serialization; copy and download retain full details.
const renderLine = (entry: LogStoreEntry, detailsText: string) =>
  `${formatTimestamp(entry.timestamp)} ${entry.level.toUpperCase().padEnd(5)} ${entry.namespace}: ${entry.message}${detailsText ? ` ${detailsText}` : ""}`;

const serializeDetails = (details: LogStoreEntry["details"]): string => {
  if (!details || Object.keys(details).length === 0) return "";
  try {
    return JSON.stringify(details);
  } catch {
    return "";
  }
};

const formatLine = (entry: LogStoreEntry) => renderLine(entry, formatDetails(entry.details));
const formatCopyLine = (entry: LogStoreEntry) => renderLine(entry, serializeDetails(entry.details));

const formatOpfsSize = (size: number | undefined) => (size === undefined ? "—" : `${size.toLocaleString()} B`);
type StorageEntry = BrowserOpfsEntry & { virtual?: boolean };
const formatStorageEntryKind = (entry: StorageEntry) => (entry.virtual ? "virtual" : entry.kind);
const formatOpfsEntry = (entry: StorageEntry) =>
  `${formatStorageEntryKind(entry).padEnd(9)} ${formatOpfsSize(entry.size).padStart(12)} ${entry.path}`;
const OPFS_CONTAINER_PATHS = new Set(["/operations", "/rom-weaver-out"]);
const getOpfsLeafEntries = (entries: readonly BrowserOpfsEntry[]) =>
  entries.filter(
    (entry) =>
      !(
        OPFS_CONTAINER_PATHS.has(entry.path) || entries.some((candidate) => candidate.path.startsWith(`${entry.path}/`))
      ),
  );
const formatOpfsEntryCount = (count: number) => `${count.toLocaleString()} entr${count === 1 ? "y" : "ies"}`;

const getVirtualFileSize = (source: BrowserVirtualFile["source"]) => {
  if (!source) return undefined;
  return source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size;
};

const getActiveVirtualStorageEntries = (): StorageEntry[] =>
  getActiveBrowserVirtualFiles().map(({ path, source }) => ({
    kind: "file",
    path,
    size: getVirtualFileSize(source),
    virtual: true,
  }));

const EMPTY_ENTRIES: readonly LogStoreEntry[] = [];
// While the dialog is closed there is nothing to show, so subscribe to a no-op
// store: otherwise useSyncExternalStore re-renders the whole list every
// animation frame during trace-heavy operations even though it is off-screen.
const getEmptyEntries = () => EMPTY_ENTRIES;
const noopUnsubscribe = () => undefined;
const noopSubscribe = () => noopUnsubscribe;

const lineClassName = (copied: boolean, failed: boolean) => {
  if (failed) return "ln copy-failed";
  if (copied) return "ln copied";
  return "ln";
};

const TraceLine = ({ entry }: { entry: LogStoreEntry }) => {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const details = formatDetails(entry.details);
  return (
    <button
      className={lineClassName(copied, failed)}
      onClick={() => {
        copyToClipboard(formatCopyLine(entry))
          .then(() => {
            setFailed(false);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch((error) => {
            logger.warn("Log line copy failed", { message: String(error) });
            setCopied(false);
            setFailed(true);
            window.setTimeout(() => setFailed(false), 1600);
          });
      }}
      type="button"
    >
      <span className="ts">{formatTimestamp(entry.timestamp)}</span>
      <span className={`lv ${entry.level}`}>{entry.level}</span>
      <span className="caller">{entry.namespace}</span>
      <span className="msg">
        {entry.message}
        {details ? ` ${details}` : ""}
      </span>
    </button>
  );
};

/**
 * Every chrome-level surface the app owns, in one dialog: the tabs ARE the
 * header, so there is no title. Settings leads because it is the tab people
 * come here for; the rest are diagnostics.
 */
const DIALOG_TABS = ["settings", "status", "logs", "storage", "changelog"] as const;
type LogDialogTab = (typeof DIALOG_TABS)[number];
const TAB_MESSAGES: Record<
  LogDialogTab,
  "ui.settings.title" | "ui.log.tabStatus" | "ui.log.tabLogs" | "ui.log.tabStorage" | "ui.log.tabChangelog"
> = {
  changelog: "ui.log.tabChangelog",
  logs: "ui.log.tabLogs",
  settings: "ui.settings.title",
  status: "ui.log.tabStatus",
  storage: "ui.log.tabStorage",
};

/** How long to keep looking for a deep-linked field while its lazy panel loads. */
const FOCUS_HINT_MAX_FRAMES = 90;

const GITHUB_BASE = GITHUB_URL.replace(/\/$/, "");
const PR_NUMBER = CHANNEL_BADGE.match(/^pr-(\d+)$/i)?.[1];

/**
 * Build facts, plainly listed: what is running, from where, and in what host.
 * The offline state is one of those facts, so it is the first row rather than a
 * card above them - the badge is its value, the same way the commit hash is the
 * commit row's.
 */
const StatusRows = ({ localizer, runtimeState }: { localizer: Localizer; runtimeState: RuntimeState }) => {
  const distance =
    typeof COMMITS_SINCE_VERSION === "number" && COMMITS_SINCE_VERSION > 0 ? `+${COMMITS_SINCE_VERSION}` : "";
  const rows: Array<[string, React.ReactNode]> = [
    [
      localizer.message("ui.status.offline"),
      <span className="sw-chip" data-sw={runtimeState} key="sw" role="status">
        <RuntimeGlyph state={runtimeState} />
        {localizer.message(RUNTIME_MESSAGES[runtimeState].label)}
      </span>,
    ],
    [localizer.message("ui.status.version"), `v${APP_VERSION}${distance}${DIRTY_HASH ? "*" : ""}`],
    [
      localizer.message("ui.status.commit"),
      COMMIT_HASH ? (
        <a href={`${GITHUB_BASE}/commit/${COMMIT_HASH}`} key="commit" rel="noreferrer" target="_blank">
          <code>{`${COMMIT_HASH.slice(0, 8)}${DIRTY_HASH ? "*" : ""}`}</code>
        </a>
      ) : (
        "—"
      ),
    ],
    [localizer.message("ui.status.branch"), <code key="branch">{GIT_BRANCH || "—"}</code>],
  ];
  if (PR_NUMBER) {
    rows.push([
      localizer.message("ui.status.pullRequest"),
      <a href={`${GITHUB_BASE}/pull/${PR_NUMBER}`} key="pr" rel="noreferrer" target="_blank">
        {`#${PR_NUMBER}`}
      </a>,
    ]);
  } else if (CHANNEL_BADGE) {
    rows.push([
      localizer.message("ui.status.channel"),
      <span className="channel-badge" data-channel={CHANNEL_BADGE.toLowerCase()} key="channel">
        {CHANNEL_BADGE}
      </span>,
    ]);
  }
  rows.push([
    localizer.message("ui.status.environment"),
    localizer.message(readPwaState() ? "ui.status.envPwa" : "ui.status.envWeb"),
  ]);
  return (
    <dl className="status-rows">
      {rows.map(([label, value]) => (
        <div className="status-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
};

/**
 * Every offline state at once, so the badge in the row above is read against the
 * four it could have been rather than on its own. The current one is marked
 * instead of being left out - a reader looking for what they have should find it
 * in the same list, not by elimination.
 */
const OfflineLegend = ({ current, localizer }: { current: RuntimeState; localizer: Localizer }) => (
  <section className="sw-legend">
    <h3 className="sw-legend-title">{localizer.message("ui.status.offlineLegend")}</h3>
    <dl>
      {RUNTIME_STATES.map((state) => (
        <div className="sw-legend-row" data-current={state === current ? "" : undefined} key={state}>
          <dt>
            <span className="sw-chip" data-sw={state}>
              <RuntimeGlyph state={state} />
              {localizer.message(RUNTIME_MESSAGES[state].label)}
            </span>
          </dt>
          <dd>{localizer.message(RUNTIME_MESSAGES[state].description)}</dd>
        </div>
      ))}
    </dl>
  </section>
);

/**
 * One line out to the About guide, which is where licence, attribution and
 * privacy are now written in full. Three paragraphs of them under the status
 * rows made the tab a page about the project rather than a readout of it.
 */
const AboutLink = ({ localizer }: { localizer: Localizer }) => (
  <div className="status-about">
    <a className="about-link" href={ABOUT_URL}>
      {localizer.message("ui.status.about")}
    </a>
  </div>
);

/** Which settings field a deep link asks for; `token` re-arms an unchanged field. */
type SettingsFocusHint = { fieldId: string; token: number };

/**
 * Deep link into a settings field: scroll it into view, focus its control, and
 * flash its row so the eye lands where the focus ring already is. The panel is
 * lazy, so the element may not exist for a few frames after the tab opens.
 */
const useSettingsFieldFocus = (active: boolean, focusHint: SettingsFocusHint | null | undefined) => {
  useEffect(() => {
    if (!(active && focusHint)) return undefined;
    let frame = 0;
    let attempts = 0;
    const reduced = prefersReducedMotion();
    const settle = () => {
      const field = document.getElementById(focusHint.fieldId);
      if (!field) {
        attempts += 1;
        if (attempts > FOCUS_HINT_MAX_FRAMES) {
          logger.debug("settings focus hint field never appeared", { fieldId: focusHint.fieldId });
          return;
        }
        frame = requestAnimationFrame(settle);
        return;
      }
      logger.trace("settings focus hint resolved", { fieldId: focusHint.fieldId });
      field.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      field.focus({ preventScroll: true });
      if (reduced) return;
      const row = field.closest(".setrow") || field;
      row.classList.add("field-flash");
      row.addEventListener("animationend", () => row.classList.remove("field-flash"), { once: true });
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [active, focusHint]);
};

const LogDialog = ({
  open,
  onClose,
  level,
  onLevelChange,
  initialTab = "status",
  onReload,
  onRestoreDefaults,
  onSaveSettings,
  onTabChange,
  serviceWorkerStatus,
  settingsFocusHint,
  settingsPanel,
  updateReady = false,
}: {
  open: boolean;
  onClose: () => void;
  level?: string;
  onLevelChange: (level: string) => void;
  initialTab?: LogDialogTab;
  onReload?: () => void;
  onRestoreDefaults?: () => void;
  onSaveSettings?: () => void;
  onTabChange?: (tab: LogDialogTab) => void;
  serviceWorkerStatus?: ServiceWorkerStatus | null;
  settingsFocusHint?: SettingsFocusHint | null;
  /** The lazy settings panel, mounted only while its tab is showing. */
  settingsPanel?: ReactNode;
  updateReady?: boolean;
}) => {
  const localizer = useUiLocalizer();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const traceRef = useRef<HTMLDivElement | null>(null);
  const currentLevel = normalizeLevel(level);
  const [filter, setFilter] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [view, setView] = useState<"current" | "previous">("current");
  const [tab, setTab] = useState<LogDialogTab>(initialTab);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  // Each open lands on the tab the control that opened it names.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [initialTab, open]);
  const selectTab = useCallback(
    (next: LogDialogTab) => {
      setTab(next);
      onTabChange?.(next);
    },
    [onTabChange],
  );
  useSettingsFieldFocus(open && tab === "settings", settingsFocusHint);
  const runtimeState = resolveRuntimeState(serviceWorkerStatus, updateReady);
  const [opfsEntries, setOpfsEntries] = useState<StorageEntry[]>([]);
  const [opfsLoading, setOpfsLoading] = useState(false);
  const [opfsError, setOpfsError] = useState<string | null>(null);
  // Previous session's entries (promoted from localStorage at boot); the "previous" view shows a run that
  // OOM-reloaded the tab. Stable for the session, so read once.
  const previousEntries = useMemo(() => getLastSessionEntries(), []);
  const hasPrevious = previousEntries.length > 0;
  const showingPrevious = view === "previous" && hasPrevious;
  const showingOpfs = tab === "storage";
  const refreshOpfs = useCallback(async () => {
    setOpfsLoading(true);
    setOpfsError(null);
    try {
      setOpfsEntries([...(await listBrowserOpfs()), ...getActiveVirtualStorageEntries()]);
    } catch (error) {
      setOpfsError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpfsLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!(open && showingOpfs)) return;
    void refreshOpfs();
  }, [open, refreshOpfs, showingOpfs]);
  // Subscribe to the live store only when actually showing it, so the previous/closed case doesn't
  // re-render every frame during trace-heavy runs.
  const liveEntries = useSyncExternalStore(
    open && tab === "logs" && !showingPrevious ? subscribeLogEntries : noopSubscribe,
    open && tab === "logs" && !showingPrevious ? getLogEntries : getEmptyEntries,
    getEmptyEntries,
  );
  const entries = showingPrevious ? previousEntries : liveEntries;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal() hands focus to the first tabbable descendant, which is the
      // selected tab, and the browser paints a focus ring on it even when the
      // dialog was opened by a tap. That read as a stray accent line beside the
      // tab on every open. Parking focus on the dialog itself keeps it inside
      // the modal - screen readers still announce it, Tab still walks into the
      // rail - without lighting up a control nobody has reached yet.
      dialog.focus({ preventScroll: true });
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => formatLine(entry).toLowerCase().includes(query));
  }, [entries, filter]);

  const visibleOpfs = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const leafEntries = getOpfsLeafEntries(opfsEntries);
    if (!query) return leafEntries;
    return leafEntries.filter((entry) => `${formatOpfsEntry(entry)} ${entry.path}`.toLowerCase().includes(query));
  }, [filter, opfsEntries]);
  const exportText = showingOpfs ? visibleOpfs.map(formatOpfsEntry).join("\n") : visible.map(formatCopyLine).join("\n");

  const virtualStart = Math.max(0, Math.floor(scrollTop / TRACE_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS);
  const virtualEnd = Math.min(
    visible.length,
    Math.ceil((scrollTop + viewportHeight) / TRACE_ROW_HEIGHT) + VIRTUAL_OVERSCAN_ROWS,
  );
  const rendered = visible.slice(virtualStart, virtualEnd);
  const totalHeight = visible.length * TRACE_ROW_HEIGHT;

  useEffect(() => {
    if (!open) return;
    const trace = traceRef.current;
    if (!trace) return;
    const updateViewport = () => setViewportHeight(trace.clientHeight);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [open]);

  // Keep the newest lines in view while the dialog is open.
  useEffect(() => {
    const trace = traceRef.current;
    if (open && trace && viewportHeight > 0) {
      trace.scrollTop = trace.scrollHeight;
      setScrollTop(trace.scrollTop);
    }
  }, [open, viewportHeight]);

  return (
    <dialog
      aria-label={localizer.message("ui.log.tabStatus")}
      className="dlg log-dlg"
      /* focusable only on purpose: the open effect parks focus here so no
         control wears a ring before the user reaches it */
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      ref={dialogRef}
    >
      <div className="dlg-frame">
        <header className="dlg-head">
          {/* the weft sub-rail IS the header: no title competing with it, and the
              close button parks at the rail's end */}
          <div
            aria-label={localizer.message("ui.log.tabStatus")}
            aria-orientation="horizontal"
            className="subrail dialog-subrail"
            onKeyDown={(event) => {
              const index = DIALOG_TABS.indexOf(tab);
              let next = -1;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % DIALOG_TABS.length;
              if (event.key === "ArrowLeft" || event.key === "ArrowUp")
                next = (index + DIALOG_TABS.length - 1) % DIALOG_TABS.length;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = DIALOG_TABS.length - 1;
              if (next < 0) return;
              event.preventDefault();
              const nextTab = DIALOG_TABS[next] as LogDialogTab;
              selectTab(nextTab);
              tabsRef.current?.querySelector<HTMLButtonElement>(`[data-logtab="${nextTab}"]`)?.focus();
            }}
            ref={tabsRef}
            role="tablist"
          >
            {DIALOG_TABS.map((entry) => (
              <button
                aria-controls={`logpanel-${entry}`}
                aria-selected={entry === tab}
                className="subtab"
                data-logtab={entry}
                id={`logtab-${entry}`}
                key={entry}
                onClick={() => selectTab(entry)}
                role="tab"
                tabIndex={entry === tab ? 0 : -1}
                type="button"
              >
                {localizer.message(TAB_MESSAGES[entry])}
              </button>
            ))}
          </div>
          <button
            aria-label={localizer.message("ui.common.close")}
            className="dlg-x"
            onClick={onClose}
            title={localizer.message("ui.common.close")}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {tab === "settings" && (onRestoreDefaults || onSaveSettings) ? (
          <div className="dlg-subhead">
            <div className="log-controls">
              <div className="dlg-actions settings-actions">
                {onRestoreDefaults ? (
                  <button
                    className="btn ghost"
                    onClick={onRestoreDefaults}
                    title={localizer.message("ui.settings.defaults")}
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" />
                    <span className="bl">{localizer.message("ui.settings.defaults")}</span>
                  </button>
                ) : null}
                {onSaveSettings ? (
                  <button
                    className="btn primary"
                    onClick={onSaveSettings}
                    title={localizer.message("ui.settings.save")}
                    type="button"
                  >
                    <Save aria-hidden="true" />
                    <span className="bl">{localizer.message("ui.settings.save")}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {tab === "settings" ? (
          <div
            aria-labelledby="logtab-settings"
            className="dlg-body settings-body"
            id="logpanel-settings"
            role="tabpanel"
          >
            {settingsPanel}
          </div>
        ) : null}
        {tab === "status" ? (
          <div aria-labelledby="logtab-status" className="dlg-body status-panel" id="logpanel-status" role="tabpanel">
            <StatusRows localizer={localizer} runtimeState={runtimeState} />
            {runtimeState === "update" && onReload ? (
              <div className="sw-summary">
                <button className="btn primary" onClick={onReload} type="button">
                  {localizer.message("ui.update.reloadNow")}
                </button>
              </div>
            ) : null}
            <OfflineLegend current={runtimeState} localizer={localizer} />
            <AboutLink localizer={localizer} />
          </div>
        ) : null}
        {tab === "changelog" ? (
          <div
            aria-labelledby="logtab-changelog"
            className="dlg-body status-panel"
            id="logpanel-changelog"
            role="tabpanel"
          >
            {/* The tab lists what has shipped, and - while a deploy is waiting -
                leads with the same data asked the other question: what that
                deploy would bring. */}
            <ChangelogPanel
              active={tab === "changelog"}
              localizer={localizer}
              onReload={onReload}
              updateReady={updateReady}
            />
          </div>
        ) : null}
        {tab === "logs" || tab === "storage" ? (
          <>
            <div className="dlg-subhead">
              {/* The controls take the row; the filter gets the next one to
                  itself. Sharing one row meant the filter and the view toggle
                  fought for the same width, and on a phone both lost - the
                  toggle ellipsed its labels while the filter shrank to a slot
                  too narrow to read what you had typed. */}
              <div className="log-controls">
                {tab === "logs" && hasPrevious ? (
                  <fieldset className="logview">
                    <legend className="sr-only">{localizer.message("ui.log.viewLabel")}</legend>
                    <button
                      aria-pressed={view === "current"}
                      className="seg-btn"
                      onClick={() => setView("current")}
                      type="button"
                    >
                      {localizer.message("ui.log.viewCurrent")}
                    </button>
                    <button
                      aria-pressed={showingPrevious}
                      className="seg-btn"
                      onClick={() => setView("previous")}
                      type="button"
                    >
                      {localizer.message("ui.log.viewPrevious")}
                    </button>
                  </fieldset>
                ) : null}
                {showingOpfs ? (
                  <button
                    aria-label="Refresh OPFS"
                    className="btn slim ghost log-refresh"
                    disabled={opfsLoading}
                    onClick={() => void refreshOpfs()}
                    title="Refresh OPFS"
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" className={opfsLoading ? "spin" : undefined} />
                  </button>
                ) : (
                  <label className="loglevel">
                    <span className="sr-only">{localizer.message("settings.logLevel")}</span>
                    <select
                      className="select mono"
                      onChange={(event) => onLevelChange(event.currentTarget.value)}
                      value={currentLevel}
                    >
                      {LOG_LEVELS.map((value) => (
                        <option key={value} value={value}>
                          {`level: ${value}`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="dlg-actions log-actions">
                  <button
                    aria-label={localizer.message("ui.common.copy")}
                    className={`btn slim ghost log-icon-btn${copiedAll ? " copied" : ""}${copyFailed ? " copy-failed" : ""}`}
                    onClick={() => {
                      copyToClipboard(exportText)
                        .then(() => {
                          setCopyFailed(false);
                          setCopiedAll(true);
                          window.setTimeout(() => setCopiedAll(false), 1300);
                        })
                        .catch((error) => {
                          logger.warn("Log copy failed", { message: String(error) });
                          setCopiedAll(false);
                          setCopyFailed(true);
                          window.setTimeout(() => setCopyFailed(false), 1600);
                        });
                    }}
                    title={localizer.message("ui.common.copy")}
                    type="button"
                  >
                    {copiedAll ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  </button>
                  <button
                    aria-label={localizer.message("ui.result.download")}
                    className="btn slim ghost log-icon-btn"
                    onClick={() => {
                      void triggerBrowserDownload(
                        exportText,
                        showingOpfs
                          ? "rom-weaver-opfs.txt"
                          : showingPrevious
                            ? "rom-weaver-previous-log.txt"
                            : "rom-weaver-log.txt",
                      );
                    }}
                    title={localizer.message("ui.result.download")}
                    type="button"
                  >
                    <Download aria-hidden="true" />
                  </button>
                </div>
              </div>
              <input
                aria-label={localizer.message("ui.log.filterLabel")}
                className="input mono log-filter"
                onChange={(event) => {
                  setFilter(event.currentTarget.value);
                  if (traceRef.current) traceRef.current.scrollTop = 0;
                  setScrollTop(0);
                }}
                placeholder={localizer.message("ui.log.filter")}
                type="search"
                value={filter}
              />
            </div>
            <div
              aria-labelledby={showingOpfs ? "logtab-storage" : "logtab-logs"}
              className="dlg-body log-body"
              id={showingOpfs ? "logpanel-storage" : "logpanel-logs"}
              role="tabpanel"
            >
              {showingOpfs ? (
                <div aria-live="polite" className="opfs-inspector mono">
                  <div className="opfs-summary">
                    {opfsLoading ? "Loading OPFS…" : formatOpfsEntryCount(visibleOpfs.length)}
                  </div>
                  {opfsError ? (
                    <div className="tracelog-empty">{opfsError}</div>
                  ) : visibleOpfs.length === 0 ? (
                    <div className="tracelog-empty">
                      {filter.trim() ? "No matching entries" : "OPFS has no entries"}
                    </div>
                  ) : (
                    <ul className="opfs-list">
                      {visibleOpfs.map((entry) => (
                        <li className="opfs-row" key={`${entry.kind}:${entry.path}`}>
                          <span className="opfs-kind">{formatStorageEntryKind(entry)}</span>
                          <span className="opfs-path">{entry.path}</span>
                          <span className="opfs-size">{formatOpfsSize(entry.size)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div
                  aria-atomic="false"
                  aria-live="polite"
                  className="tracelog mono"
                  onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                  ref={traceRef}
                >
                  {visible.length === 0 ? (
                    <div className="tracelog-empty">
                      {filter.trim() ? localizer.message("ui.log.emptyFilter", { q: filter.trim() }) : "-"}
                    </div>
                  ) : (
                    <div className="tracelog-virtual-content" style={{ height: totalHeight }}>
                      <div className="tracelog-virtual-window" style={{ top: virtualStart * TRACE_ROW_HEIGHT }}>
                        {rendered.map((entry) => (
                          <TraceLine entry={entry} key={entry.id} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </dialog>
  );
};

export { LogDialog };
export type { LogDialogTab, SettingsFocusHint };
