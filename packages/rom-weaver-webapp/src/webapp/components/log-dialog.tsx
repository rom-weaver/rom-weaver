import {
  Activity,
  Check,
  Copy,
  Download,
  HardDrive,
  Newspaper,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Settings,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { createLogger } from "../../lib/logging.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { DropdownSelect } from "../../public/react/components/ds/dropdown-select.tsx";
import { Drawer, DrawerReadout } from "../../public/react/components/ds/drawer.tsx";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { listBrowserOpfs } from "../../storage/browser/browser-opfs-cleanup.ts";
import { LOG_LEVELS, type LogLevel } from "../../types/logging.ts";
import { getActiveBrowserVirtualFiles, type BrowserVirtualFile } from "../../workers/protocol/browser-virtual-files.ts";
import type { BrowserOpfsEntry } from "../../workers/protocol/browser-opfs-worker-client.ts";
import { getLastSessionEntries, getLogEntries, type LogStoreEntry, subscribeLogEntries } from "../log-store.ts";
import { APP_VERSION, COMMITS_SINCE_VERSION, COMMIT_HASH, DIRTY_HASH, GIT_BRANCH } from "../build-version.ts";
import { CHANNEL_BADGE } from "../build-channel.ts";
import { ABOUT_URL, GITHUB_URL } from "../project-links.ts";
import { queryOfflineCachedFiles } from "../pwa/offline-warmup-client.ts";
import type { ServiceWorkerStatus } from "../pwa/service-worker-cache-state.ts";
import type { OfflineCachedFile } from "../offline-warmup.ts";
import { ChangelogPanel } from "./changelog-panel.tsx";
import { EmulatorSavesPanel } from "./emulator-saves-panel.tsx";
import {
  describeWarmupUnit,
  installingRuntimeLabel,
  offlineWarmupPercent,
  prefersReducedMotion,
  readPwaState,
  resolveRuntimeState,
  RUNTIME_MESSAGES,
  RUNTIME_STATES,
  RuntimeGlyph,
} from "./shell.tsx";
import type { OfflineWarmupDisplayProgress, RuntimeState } from "./shell.tsx";
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
/** Sizes are per-entry and optional, so the total covers only the entries that report one. */
const totalOpfsSize = (entries: readonly StorageEntry[]) =>
  entries.reduce((total, entry) => total + (entry.size ?? 0), 0);

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

/**
 * Copy with the transient copied/failed states the buttons paint. The two call
 * sites flash for slightly different durations, so the timings are arguments.
 */
const useCopyFeedback = (copiedMs: number, failedMs: number) => {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = useCallback(
    (text: string, failureLabel: string) => {
      copyToClipboard(text)
        .then(() => {
          setFailed(false);
          setCopied(true);
          window.setTimeout(() => setCopied(false), copiedMs);
        })
        .catch((error) => {
          logger.warn(failureLabel, { message: String(error) });
          setCopied(false);
          setFailed(true);
          window.setTimeout(() => setFailed(false), failedMs);
        });
    },
    [copiedMs, failedMs],
  );
  return { copied, copy, failed };
};

type CopyFeedback = ReturnType<typeof useCopyFeedback>;

const TraceLine = ({ entry }: { entry: LogStoreEntry }) => {
  const { copied, copy, failed } = useCopyFeedback(1200, 1600);
  const details = formatDetails(entry.details);
  return (
    <button
      className={lineClassName(copied, failed)}
      onClick={() => copy(formatCopyLine(entry), "Log line copy failed")}
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
 * come here for; the rest are diagnostics. Storage hosts the OPFS inspector.
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
const TAB_ICONS = {
  changelog: Newspaper,
  logs: ScrollText,
  settings: Settings,
  status: Activity,
  storage: HardDrive,
} as const;

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
const StatusRows = ({
  localizer,
  offlineProgress,
  runtimeState,
}: {
  localizer: Localizer;
  offlineProgress?: OfflineWarmupDisplayProgress | null;
  runtimeState: RuntimeState;
}) => {
  const distance =
    typeof COMMITS_SINCE_VERSION === "number" && COMMITS_SINCE_VERSION > 0 ? `+${COMMITS_SINCE_VERSION}` : "";
  const rows: Array<[string, React.ReactNode]> = [
    [
      localizer.message("ui.status.offline"),
      <span className="sw-status-cell" key="sw">
        <span className="sw-chip" data-sw={runtimeState} role="status">
          <RuntimeGlyph
            percent={runtimeState === "installing" ? offlineWarmupPercent(offlineProgress ?? null) : null}
            state={runtimeState}
          />
          {runtimeState === "installing"
            ? installingRuntimeLabel(localizer, offlineProgress ?? null)
            : localizer.message(RUNTIME_MESSAGES[runtimeState].label)}
        </span>
        {runtimeState === "installing" &&
        offlineProgress &&
        !offlineProgress.ready &&
        offlineProgress.totalBytes > 0 ? (
          <>
            <span className="sw-progress-detail">
              {typeof offlineProgress.cachedFiles === "number" && typeof offlineProgress.totalFiles === "number"
                ? `${localizer.message("ui.runtime.detailFiles", {
                    cached: offlineProgress.cachedFiles,
                    total: offlineProgress.totalFiles,
                  })} · `
                : ""}
              {`${localizer.formatBytes(offlineProgress.cachedBytes)} / ${localizer.formatBytes(offlineProgress.totalBytes)}`}
            </span>
            {(() => {
              const detail = describeWarmupUnit(localizer, offlineProgress);
              if (!detail) return null;
              const { unitLoadedBytes, unitTotalBytes } = offlineProgress;
              const unitBytes =
                typeof unitLoadedBytes === "number" && typeof unitTotalBytes === "number" && unitTotalBytes > 0
                  ? ` (${localizer.formatBytes(unitLoadedBytes)} / ${localizer.formatBytes(unitTotalBytes)})`
                  : "";
              return <span className="sw-progress-detail">{`${detail}${unitBytes}`}</span>;
            })()}
          </>
        ) : null}
      </span>,
    ],
    [
      localizer.message("ui.status.version"),
      <span className="status-build-id" key="version">{`v${APP_VERSION}${distance}${DIRTY_HASH ? "*" : ""}`}</span>,
    ],
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
    [
      localizer.message("ui.status.branch"),
      GIT_BRANCH ? (
        <a href={`${GITHUB_BASE}/tree/${encodeURIComponent(GIT_BRANCH)}`} key="branch" rel="noreferrer" target="_blank">
          <code>{GIT_BRANCH}</code>
        </a>
      ) : (
        "—"
      ),
    ],
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
    <section className="status-group">
      <h3 className="dlg-section-title">{localizer.message("ui.status.build")}</h3>
      <dl className="status-rows">
        {rows.map(([label, value]) => (
          <div className="status-row" key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
};

/**
 * Every offline state at once, so the badge in the row above is read against the
 * four it could have been rather than on its own. The current one is marked
 * instead of being left out - a reader looking for what they have should find it
 * in the same list, not by elimination.
 */
const OfflineLegend = ({ current, localizer }: { current: RuntimeState; localizer: Localizer }) => (
  <section className="status-group sw-legend">
    <h3 className="dlg-section-title">{localizer.message("ui.status.offlineLegend")}</h3>
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

const cachedFileLabel = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

const OfflineCachedFiles = ({
  error,
  files,
  loading,
  localizer,
}: {
  error: string | null;
  files: OfflineCachedFile[];
  loading: boolean;
  localizer: Localizer;
}) => (
  <section className="sw-cached-files">
    <h3 className="sr-only">{localizer.message("ui.status.cachedFiles")}</h3>
    <Drawer
      className="sw-cache-drawer"
      label={localizer.message("ui.status.cachedFiles")}
      readouts={<DrawerReadout muted>{loading ? "…" : files.length}</DrawerReadout>}
    >
      {loading ? <p className="sw-cache-note">{localizer.message("ui.status.cachedFilesLoading")}</p> : null}
      {!loading && error ? <p className="sw-cache-note sw-cache-error">{error}</p> : null}
      {!(loading || error) && files.length === 0 ? (
        <p className="sw-cache-note">{localizer.message("ui.status.cachedFilesEmpty")}</p>
      ) : null}
      {!(loading || error) && files.length > 0 ? (
        <ul className="sw-cache-list">
          {files.map((file) => (
            <li data-cache={file.cache} key={`${file.cache}:${file.url}`}>
              <span title={file.cache}>{file.cache}</span>
              <code title={file.url}>{cachedFileLabel(file.url)}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </Drawer>
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

/** Roving-tabindex movement across the rail; -1 means the key moves nothing. */
const nextTabIndex = (key: string, index: number): number => {
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % DIALOG_TABS.length;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index + DIALOG_TABS.length - 1) % DIALOG_TABS.length;
  if (key === "Home") return 0;
  if (key === "End") return DIALOG_TABS.length - 1;
  return -1;
};

/**
 * The weft sub-rail that doubles as the dialog header. On a phone the whole head
 * drops to the foot of the sheet - see responsive.css.
 */
const DialogTabRail = ({
  localizer,
  onSelect,
  tab,
}: {
  localizer: Localizer;
  onSelect: (tab: LogDialogTab) => void;
  tab: LogDialogTab;
}) => {
  const tabsRef = useRef<HTMLDivElement | null>(null);
  return (
    <div
      aria-label={localizer.message("ui.log.tabsLabel")}
      aria-orientation="horizontal"
      className="subrail dialog-subrail"
      onKeyDown={(event) => {
        const next = nextTabIndex(event.key, DIALOG_TABS.indexOf(tab));
        if (next < 0) return;
        event.preventDefault();
        const nextTab = DIALOG_TABS[next] as LogDialogTab;
        onSelect(nextTab);
        tabsRef.current?.querySelector<HTMLButtonElement>(`[data-logtab="${nextTab}"]`)?.focus();
      }}
      ref={tabsRef}
      role="tablist"
    >
      {DIALOG_TABS.map((entry) => {
        const TabIcon = TAB_ICONS[entry];
        return (
          <button
            aria-controls={`logpanel-${entry}`}
            aria-selected={entry === tab}
            className="subtab"
            data-logtab={entry}
            id={`logtab-${entry}`}
            key={entry}
            onClick={() => onSelect(entry)}
            role="tab"
            tabIndex={entry === tab ? 0 : -1}
            type="button"
          >
            <TabIcon aria-hidden="true" />
            <span>{localizer.message(TAB_MESSAGES[entry])}</span>
          </button>
        );
      })}
    </div>
  );
};

/** Save/restore for the settings tab; absent handlers drop their buttons. */
const SettingsActionsBar = ({
  localizer,
  onRestoreDefaults,
  onSaveSettings,
}: {
  localizer: Localizer;
  onRestoreDefaults?: () => void;
  onSaveSettings?: () => void;
}) => {
  if (!(onRestoreDefaults || onSaveSettings)) return null;
  return (
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
  );
};

/** Current-vs-previous session switch; only shown when a previous session exists. */
const LogViewToggle = ({
  localizer,
  onChange,
  showingPrevious,
}: {
  localizer: Localizer;
  onChange: (view: "current" | "previous") => void;
  showingPrevious: boolean;
}) => (
  <fieldset className="logview">
    <legend className="sr-only">{localizer.message("ui.log.viewLabel")}</legend>
    <button aria-pressed={!showingPrevious} className="seg-btn" onClick={() => onChange("current")} type="button">
      {localizer.message("ui.log.viewCurrent")}
    </button>
    <button aria-pressed={showingPrevious} className="seg-btn" onClick={() => onChange("previous")} type="button">
      {localizer.message("ui.log.viewPrevious")}
    </button>
  </fieldset>
);

const LogLevelSelect = ({
  currentLevel,
  localizer,
  onLevelChange,
}: {
  currentLevel: LogLevel;
  localizer: Localizer;
  onLevelChange: (level: string) => void;
}) => (
  <label className="loglevel" htmlFor="rom-weaver-log-level">
    <span className="sr-only">{localizer.message("settings.logLevel")}</span>
    <DropdownSelect
      className="select mono"
      id="rom-weaver-log-level"
      onChange={(event) => onLevelChange(event.currentTarget.value)}
      value={currentLevel}
    >
      {LOG_LEVELS.map((value) => (
        <option key={value} value={value}>
          {`level: ${value}`}
        </option>
      ))}
    </DropdownSelect>
  </label>
);

const logDownloadName = (showingOpfs: boolean, showingPrevious: boolean) => {
  if (showingOpfs) return "rom-weaver-opfs.txt";
  return showingPrevious ? "rom-weaver-previous-log.txt" : "rom-weaver-log.txt";
};

/** Copy-all and download for whichever listing the body is showing. */
const LogExportActions = ({
  copyFeedback,
  exportText,
  localizer,
  showingOpfs,
  showingPrevious,
}: {
  copyFeedback: CopyFeedback;
  exportText: string;
  localizer: Localizer;
  showingOpfs: boolean;
  showingPrevious: boolean;
}) => {
  const { copied, copy, failed } = copyFeedback;
  return (
    <div className="dlg-actions log-actions">
      <button
        aria-label={localizer.message("ui.common.copy")}
        className={`btn slim ghost log-icon-btn${copied ? " copied" : ""}${failed ? " copy-failed" : ""}`}
        onClick={() => copy(exportText, "Log copy failed")}
        title={localizer.message("ui.common.copy")}
        type="button"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      <button
        aria-label={localizer.message("ui.result.download")}
        className="btn slim ghost log-icon-btn"
        onClick={() => {
          void triggerBrowserDownload(exportText, logDownloadName(showingOpfs, showingPrevious));
        }}
        title={localizer.message("ui.result.download")}
        type="button"
      >
        <Download aria-hidden="true" />
      </button>
    </div>
  );
};

const OpfsInspector = ({
  entries,
  error,
  filter,
  loading,
}: {
  entries: readonly StorageEntry[];
  error: string | null;
  filter: string;
  loading: boolean;
}) => {
  const emptyMessage = filter.trim() ? "No matching entries" : "OPFS has no entries";
  return (
    <div aria-live="polite" className="opfs-inspector mono">
      {/* The count keeps its own element: it is what the listing is checked
          against, and the bytes beside it are a second reading of the same set. */}
      <div className="opfs-readout">
        <span className="opfs-summary">{loading ? "Loading OPFS…" : formatOpfsEntryCount(entries.length)}</span>
        {!loading && entries.length > 0 ? (
          <span className="opfs-total">{formatOpfsSize(totalOpfsSize(entries))}</span>
        ) : null}
      </div>
      {error ? <div className="opfs-error">{error}</div> : null}
      {!error && entries.length === 0 ? <div className="opfs-empty">{emptyMessage}</div> : null}
      {!error && entries.length > 0 ? (
        <ul className="opfs-list">
          {entries.map((entry) => (
            <li className="opfs-row" key={`${entry.kind}:${entry.path}`}>
              <span className="opfs-kind" data-kind={formatStorageEntryKind(entry)}>
                {formatStorageEntryKind(entry)}
              </span>
              <span className="opfs-path">{entry.path}</span>
              <span className="opfs-size">{formatOpfsSize(entry.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/**
 * The virtualized trace listing. Only rows near the viewport are mounted; the
 * fixed CSS row height keeps the native scrollbar exact without a list library.
 * The scroll state lives on the dialog, so leaving this tab and coming back does
 * not re-run the scroll-to-newest effect and lose the reader's place.
 */
const TraceList = ({
  entries,
  filter,
  localizer,
  onScroll,
  traceRef,
  scrollTop,
  viewportHeight,
}: {
  entries: readonly LogStoreEntry[];
  filter: string;
  localizer: Localizer;
  onScroll: (scrollTop: number) => void;
  traceRef: React.RefObject<HTMLDivElement | null>;
  scrollTop: number;
  viewportHeight: number;
}) => {
  const virtualStart = Math.max(0, Math.floor(scrollTop / TRACE_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS);
  const virtualEnd = Math.min(
    entries.length,
    Math.ceil((scrollTop + viewportHeight) / TRACE_ROW_HEIGHT) + VIRTUAL_OVERSCAN_ROWS,
  );
  const emptyMessage = filter.trim() ? localizer.message("ui.log.emptyFilter", { q: filter.trim() }) : "-";
  return (
    <div
      aria-atomic="false"
      aria-live="polite"
      className="tracelog mono"
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
      ref={traceRef}
    >
      {entries.length === 0 ? (
        <div className="tracelog-empty">{emptyMessage}</div>
      ) : (
        <div className="tracelog-virtual-content" style={{ height: entries.length * TRACE_ROW_HEIGHT }}>
          <div className="tracelog-virtual-window" style={{ top: virtualStart * TRACE_ROW_HEIGHT }}>
            {entries.slice(virtualStart, virtualEnd).map((entry) => (
              <TraceLine entry={entry} key={entry.id} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The logs and storage tabs, which share one toolbar and body. Every piece of
 * state it renders is owned by the dialog, so switching tabs keeps the fetched
 * OPFS listing, the filter, and the reader's scroll position.
 */
const LogsStoragePanel = ({
  copyFeedback,
  currentLevel,
  entries,
  filter,
  hasPrevious,
  localizer,
  onFilterChange,
  onLevelChange,
  onRefreshOpfs,
  onScroll,
  onViewChange,
  opfsEntries,
  opfsError,
  opfsLoading,
  scrollTop,
  showingPrevious,
  tab,
  traceRef,
  viewportHeight,
}: {
  copyFeedback: CopyFeedback;
  currentLevel: LogLevel;
  entries: readonly LogStoreEntry[];
  filter: string;
  hasPrevious: boolean;
  localizer: Localizer;
  onFilterChange: (filter: string) => void;
  onLevelChange: (level: string) => void;
  onRefreshOpfs: () => void;
  onScroll: (scrollTop: number) => void;
  onViewChange: (view: "current" | "previous") => void;
  opfsEntries: readonly StorageEntry[];
  opfsError: string | null;
  opfsLoading: boolean;
  scrollTop: number;
  showingPrevious: boolean;
  tab: LogDialogTab;
  traceRef: React.RefObject<HTMLDivElement | null>;
  viewportHeight: number;
}) => {
  const showingOpfs = tab === "storage";
  const exportText = showingOpfs ? opfsEntries.map(formatOpfsEntry).join("\n") : entries.map(formatCopyLine).join("\n");
  return (
    <>
      {showingOpfs ? <EmulatorSavesPanel active /> : null}
      <div className="dlg-subhead">
        {showingOpfs ? (
          <h3 className="dlg-section-title storage-section-title" id="storage-opfs-title">
            OPFS
          </h3>
        ) : null}
        {/* The controls take the row; the filter gets the next one to itself.
            Sharing one row meant the filter and the view toggle fought for the
            same width, and on a phone both lost - the toggle ellipsed its labels
            while the filter shrank to a slot too narrow to read what you had
            typed. */}
        <div className="log-controls">
          {tab === "logs" && hasPrevious ? (
            <LogViewToggle localizer={localizer} onChange={onViewChange} showingPrevious={showingPrevious} />
          ) : null}
          {showingOpfs ? (
            <button
              aria-label="Refresh OPFS"
              className="btn slim ghost log-refresh"
              disabled={opfsLoading}
              onClick={onRefreshOpfs}
              title="Refresh OPFS"
              type="button"
            >
              <RefreshCw aria-hidden="true" className={opfsLoading ? "spin" : undefined} />
            </button>
          ) : (
            <LogLevelSelect currentLevel={currentLevel} localizer={localizer} onLevelChange={onLevelChange} />
          )}
          <LogExportActions
            copyFeedback={copyFeedback}
            exportText={exportText}
            localizer={localizer}
            showingOpfs={showingOpfs}
            showingPrevious={showingPrevious}
          />
        </div>
        <input
          aria-label={localizer.message("ui.log.filterLabel")}
          className="input mono log-filter"
          onChange={(event) => onFilterChange(event.currentTarget.value)}
          placeholder={localizer.message("ui.log.filter")}
          type="search"
          value={filter}
        />
      </div>
      <div
        aria-labelledby={showingOpfs ? "logtab-storage" : "logtab-logs"}
        className={showingOpfs ? "dlg-body log-body storage-body" : "dlg-body log-body"}
        id={showingOpfs ? "logpanel-storage" : "logpanel-logs"}
        role="tabpanel"
      >
        {showingOpfs ? (
          <section aria-labelledby="storage-opfs-title" className="storage-section storage-section-opfs">
            <OpfsInspector entries={opfsEntries} error={opfsError} filter={filter} loading={opfsLoading} />
          </section>
        ) : (
          <TraceList
            entries={entries}
            filter={filter}
            localizer={localizer}
            onScroll={onScroll}
            scrollTop={scrollTop}
            traceRef={traceRef}
            viewportHeight={viewportHeight}
          />
        )}
      </div>
    </>
  );
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
  offlineProgress = null,
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
  offlineProgress?: OfflineWarmupDisplayProgress | null;
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
  const [view, setView] = useState<"current" | "previous">("current");
  const [tab, setTab] = useState<LogDialogTab>(initialTab);
  const copyFeedback = useCopyFeedback(1300, 1600);
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
  const runtimeState = resolveRuntimeState(serviceWorkerStatus, updateReady, offlineProgress);
  const [opfsEntries, setOpfsEntries] = useState<StorageEntry[]>([]);
  const [opfsLoading, setOpfsLoading] = useState(false);
  const [opfsError, setOpfsError] = useState<string | null>(null);
  const [cachedFiles, setCachedFiles] = useState<OfflineCachedFile[]>([]);
  const [cachedFilesLoading, setCachedFilesLoading] = useState(false);
  const [cachedFilesError, setCachedFilesError] = useState<string | null>(null);
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
  useEffect(() => {
    if (!(open && tab === "status")) return;
    let active = true;
    setCachedFilesLoading(true);
    setCachedFilesError(null);
    void queryOfflineCachedFiles()
      .then((files) => {
        if (active) setCachedFiles(files);
      })
      .catch((error) => {
        if (active) setCachedFilesError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setCachedFilesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, tab]);
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
  useEffect(() => {
    if (!(open && tab === "logs")) return;
    const trace = traceRef.current;
    if (!trace) return;
    const updateViewport = () => setViewportHeight(trace.clientHeight);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [open, tab]);

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
      aria-label={localizer.message("ui.log.dialogLabel")}
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
        {/* the weft sub-rail IS the header: no title competing with it, and the
            close button parks at the rail's end. On a phone the whole head
            drops to the foot of the sheet - see responsive.css. */}
        <header className="dlg-head">
          <DialogTabRail localizer={localizer} onSelect={selectTab} tab={tab} />
          <button
            aria-label={localizer.message("ui.common.close")}
            className="dlg-x"
            onClick={onClose}
            title={localizer.message("ui.common.close")}
            type="button"
          >
            <X aria-hidden="true" />
            {/* Only shown when the head is the phone's bottom bar, where a bare
                glyph among labelled columns is the odd one out. */}
            <span className="dlg-x-label">{localizer.message("ui.common.close")}</span>
          </button>
        </header>
        {tab === "settings" ? (
          <SettingsActionsBar
            localizer={localizer}
            onRestoreDefaults={onRestoreDefaults}
            onSaveSettings={onSaveSettings}
          />
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
            <StatusRows localizer={localizer} offlineProgress={offlineProgress} runtimeState={runtimeState} />
            <OfflineCachedFiles
              error={cachedFilesError}
              files={cachedFiles}
              loading={cachedFilesLoading}
              localizer={localizer}
            />
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
          <LogsStoragePanel
            copyFeedback={copyFeedback}
            currentLevel={currentLevel}
            entries={visible}
            filter={filter}
            hasPrevious={hasPrevious}
            localizer={localizer}
            onFilterChange={(next) => {
              setFilter(next);
              // A new query re-ranges the list, so start reading it from the top.
              if (traceRef.current) traceRef.current.scrollTop = 0;
              setScrollTop(0);
            }}
            onLevelChange={onLevelChange}
            onRefreshOpfs={() => void refreshOpfs()}
            onScroll={setScrollTop}
            onViewChange={setView}
            opfsEntries={visibleOpfs}
            opfsError={opfsError}
            opfsLoading={opfsLoading}
            scrollTop={scrollTop}
            showingPrevious={showingPrevious}
            tab={tab}
            traceRef={traceRef}
            viewportHeight={viewportHeight}
          />
        ) : null}
      </div>
    </dialog>
  );
};

export { LogDialog };
export type { LogDialogTab, SettingsFocusHint };
