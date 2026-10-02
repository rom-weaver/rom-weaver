import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  HardDrive,
  Info,
  MonitorCheck,
  RefreshCw,
  RotateCcw,
  Save,
  ScrollText,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import { GITHUB_URL } from "../project-links.ts";
import {
  downloadOfflineCopy,
  getInitialOfflineCopyState,
  getOfflineCopyState,
  queryOfflineCachedFiles,
  setOfflineWarmupEnabled,
  subscribeOfflineCopyState,
} from "../pwa/offline-warmup-client.ts";
import type { ServiceWorkerStatus } from "../pwa/service-worker-cache-state.ts";
import type { OfflineCachedFile } from "../offline-warmup.ts";
import { isReactWebappDevelopmentMode } from "../development-defaults.ts";
import { setAdvancedSettings, useAdvancedSettings } from "../advanced-settings.ts";
import {
  ADVANCED_SETTINGS_FIELDS,
  SETTINGS_FIELD_ID_TO_KEY,
  SETTINGS_FIELD_METADATA,
  SETTINGS_PANEL_SECTIONS,
  settingsGroupId,
} from "../settings/settings-state.ts";
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
 * The settings console: one native dialog holding settings, the offline app,
 * saves and storage, logs, and About. Desktop shows a sidebar; a phone shows a
 * full-screen page that slides in from the right with its sections at the foot.
 * The log level control updates the persisted setting used by the logger and subsequent workflow runs.
 */

const logger = createLogger("log-dialog");

const PREVIEW_STATE_LABELS: Record<RuntimeState, string> = {
  active: "Offline active",
  ready: "Offline ready",
  update: "Update ready",
  installing: "Installing 40%",
  online: "Online only",
  disabled: "Offline disabled",
};

const normalizeLevel = (value: string | undefined): LogLevel =>
  value && (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : "warn";

const formatTimestamp = (iso: string) => {
  const timePart = iso.split("T")[1] || iso;
  return timePart.replace("Z", "").slice(0, 12);
};

// Limit rendered detail text so a large log entry does not fill the view.
// The JSON serialization itself still processes the whole detail object.
const MAX_DETAILS_CHARS = 4096;

// Keep the scroll range for every matching line while mounting only the rows near the viewport.
// The row height is fixed in CSS so the native scrollbar stays exact without a heavyweight list library.
const TRACE_ROW_HEIGHT = 25;
const VIRTUAL_OVERSCAN_ROWS = 12;

// While an install is running the cached-file list re-reads the caches on this
// interval so files appear as they land. Each pass measures every stored body,
// so this stays well clear of the warm-up's own progress cadence.
const CACHE_INVENTORY_REFRESH_MS = 2500;

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
 * Every chrome-level surface the app owns, in one console. Settings leads
 * because it is the section people come here for; About closes the list.
 */
const DIALOG_TABS = ["settings", "offline", "storage", "logs", "about"] as const;
type LogDialogTab = (typeof DIALOG_TABS)[number];
const TAB_MESSAGES = {
  about: "ui.console.about",
  logs: "ui.log.tabLogs",
  offline: "ui.console.offline",
  settings: "ui.settings.title",
  storage: "ui.console.storage",
} as const;
// Phone section bar: five columns beside the back link, so every label is one short word.
const TAB_SHORT_MESSAGES = {
  about: "ui.console.about",
  logs: "ui.log.tabLogs",
  offline: "ui.status.offline",
  settings: "ui.settings.title",
  storage: "ui.log.tabStorage",
} as const;
const TAB_DESCRIPTIONS = {
  about: "ui.console.aboutDescription",
  logs: "ui.console.logsDescription",
  offline: "ui.console.offlineDescription",
  settings: "ui.console.settingsDescription",
  storage: "ui.console.storageDescription",
} as const;
const TAB_ICONS = {
  about: Info,
  logs: ScrollText,
  offline: MonitorCheck,
  settings: Settings,
  storage: HardDrive,
} as const;
// Levels that only matter when chasing a bug; the select offers them with Advanced on.
const ADVANCED_LOG_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>(["debug", "trace"]);

/** How long to keep looking for a deep-linked field while its lazy panel loads. */
const FOCUS_HINT_MAX_FRAMES = 90;

const GITHUB_BASE = GITHUB_URL.replace(/\/$/, "");
const PR_NUMBER = CHANNEL_BADGE.match(/^pr-(\d+)$/i)?.[1];

/**
 * Offline controls MUST stay separate from the build facts so action notes
 * can use the full section width.
 */
const StatusRows = ({
  localizer,
  offlineProgress,
  runtimeState,
  children,
  downloadRequested,
  downloadUnavailable,
  onDownload,
  offlineCopyEnabled,
  removing,
  removeUnavailable,
  onRemove,
  onUpdate,
}: {
  localizer: Localizer;
  downloadRequested: boolean;
  downloadUnavailable: boolean;
  onDownload: () => void;
  offlineCopyEnabled: boolean;
  removing: boolean;
  removeUnavailable: boolean;
  onRemove: () => void;
  onUpdate?: () => void;
  offlineProgress?: OfflineWarmupDisplayProgress | null;
  runtimeState: RuntimeState;
  children?: ReactNode;
}) => {
  const removePointerDown = useRef(false);
  const transferredBytes = offlineProgress?.transferredBytes;
  const transferDetail =
    typeof transferredBytes === "number" && Number.isFinite(transferredBytes) && transferredBytes >= 0
      ? localizer.message(
          offlineProgress?.transferBytesIncomplete ? "ui.runtime.transferredAtLeast" : "ui.runtime.transferred",
          { size: localizer.formatBytes(transferredBytes) },
        )
      : null;
  const showRemove = (runtimeState !== "disabled" && offlineCopyEnabled) || removing || removeUnavailable;
  const OfflineActionIcon = showRemove ? Trash2 : Download;
  let actionLabel = localizer.message("ui.runtime.downloadOffline");
  if (showRemove) {
    actionLabel = localizer.message(removing ? "ui.runtime.removingOffline" : "ui.runtime.removeOffline");
  } else if (downloadRequested) {
    actionLabel = localizer.message("ui.runtime.downloadRequested");
  }
  const offlineStatus = (
    <div className="sw-status-cell">
      <span className="sr-only" role="status">
        {runtimeState === "installing"
          ? installingRuntimeLabel(localizer, offlineProgress ?? null)
          : localizer.message(RUNTIME_MESSAGES[runtimeState].label)}
      </span>
      <div className="sw-cache-action">
        <button
          className="btn primary"
          disabled={runtimeState === "disabled" || (showRemove ? removing : downloadRequested)}
          onClick={() => {
            if (removePointerDown.current) {
              removePointerDown.current = false;
              return;
            }
            if (showRemove) onRemove();
            else onDownload();
          }}
          onPointerDown={(event) => {
            if (showRemove && event.button === 0) {
              removePointerDown.current = true;
              onRemove();
            }
          }}
          type="button"
        >
          <OfflineActionIcon aria-hidden="true" size={18} />
          {actionLabel}
        </button>
        {removeUnavailable ? (
          <span className="sw-cache-error" role="alert">
            {localizer.message("ui.runtime.removeUnavailable")}
          </span>
        ) : null}
        {downloadUnavailable ? (
          <span className="sw-cache-error" role="alert">
            {localizer.message("ui.runtime.downloadUnavailable")}
          </span>
        ) : null}
      </div>
      {runtimeState === "installing" && offlineProgress && !offlineProgress.ready ? (
        <>
          {typeof offlineProgress.cachedFiles === "number" &&
          typeof offlineProgress.totalFiles === "number" &&
          offlineProgress.totalFiles > 0 ? (
            <span className="sw-progress-detail">
              {localizer.message("ui.runtime.detailFiles", {
                cached: offlineProgress.cachedFiles,
                total: offlineProgress.totalFiles,
              })}
            </span>
          ) : null}
          {(() => {
            const detail = describeWarmupUnit(localizer, offlineProgress);
            if (!detail) return null;
            return <span className="sw-progress-detail">{detail}</span>;
          })()}
        </>
      ) : null}
      {transferDetail ? <span className="sw-progress-detail">{transferDetail}</span> : null}
    </div>
  );
  return (
    <section className="status-group offline-group">
      <h3 className="dlg-section-title">{localizer.message("ui.status.offline")}</h3>
      <OfflineLegend
        current={runtimeState}
        localizer={localizer}
        offlineProgress={offlineProgress}
        onUpdate={onUpdate}
      />
      {offlineStatus}
      {children}
    </section>
  );
};

/** Version, commit, branch, channel or PR, and environment of the running build. */
const BuildFacts = ({ localizer }: { localizer: Localizer }) => {
  const distance =
    typeof COMMITS_SINCE_VERSION === "number" && COMMITS_SINCE_VERSION > 0 ? `+${COMMITS_SINCE_VERSION}` : "";
  const rows: Array<[string, React.ReactNode]> = [
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
 * About: what this is, the build facts a bug report needs, and the ways out to
 * the full changelog and the license notices, which keep their own pages.
 */
const AboutPanel = ({
  licensesHref,
  localizer,
  onOpenWhatsNew,
}: {
  licensesHref?: string;
  localizer: Localizer;
  onOpenWhatsNew?: () => void;
}) => (
  <>
    <section className="status-group about-ident">
      <h3 className="about-name">{`rom-weaver ${APP_VERSION}`}</h3>
      <p className="about-tagline">{localizer.message("ui.console.aboutTagline")}</p>
    </section>
    <BuildFacts localizer={localizer} />
    <nav aria-label={localizer.message("ui.console.about")} className="about-links">
      {onOpenWhatsNew ? (
        <button className="about-link" onClick={onOpenWhatsNew} type="button">
          <span>{localizer.message("ui.update.whatsNew")}</span>
          <ChevronRight aria-hidden="true" />
        </button>
      ) : null}
      {licensesHref ? (
        <a className="about-link" href={licensesHref}>
          <span>{localizer.message("ui.console.licenses")}</span>
          <ChevronRight aria-hidden="true" />
        </a>
      ) : null}
      <a className="about-link" href={`${GITHUB_BASE}/issues`} rel="noreferrer" target="_blank">
        <span>{localizer.message("ui.console.reportIssue")}</span>
        <ExternalLink aria-hidden="true" />
      </a>
    </nav>
  </>
);

const OfflineLegend = ({
  current,
  localizer,
  offlineProgress,
  onUpdate,
}: {
  current: RuntimeState;
  localizer: Localizer;
  offlineProgress?: OfflineWarmupDisplayProgress | null;
  onUpdate?: () => void;
}) => (
  <div className="sw-legend">
    <ul>
      {RUNTIME_STATES.map((state) => {
        const description = `${localizer.message(RUNTIME_MESSAGES[state].label)}: ${localizer.message(RUNTIME_MESSAGES[state].description)}`;
        return (
          <li className="sw-legend-row" data-current={state === current ? "" : undefined} key={state}>
            <span
              aria-label={description}
              className="sw-chip sw-legend-icon"
              data-sw={state}
              role="img"
              title={description}
            >
              <RuntimeGlyph
                percent={
                  state === current && state === "installing" ? offlineWarmupPercent(offlineProgress ?? null) : null
                }
                state={state}
              />
            </span>
            <div className="sw-legend-details">
              <span className="sw-legend-label">{localizer.message(RUNTIME_MESSAGES[state].label)}</span>
              <span className="sw-legend-description">{localizer.message(RUNTIME_MESSAGES[state].description)}</span>
              {state === current && state === "update" && onUpdate ? (
                <button className="btn slim primary sw-update-action" onClick={onUpdate} type="button">
                  {localizer.message("ui.update.reloadNow")}
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  </div>
);

// Path only: the cache name and revision/sha query params are noise in the
// list - the full URL stays on the row's hover title.
const cachedFileLabel = (url: string) => new URL(url).pathname;

/**
 * Compressed (transfer) and uncompressed (stored) totals over an inventory.
 * A file missing one measurement counts its other one in both totals, so an
 * unencoded or unreadable entry never drops out of a sum.
 */
const cachedFileTotals = (files: OfflineCachedFile[]) => {
  let compressedBytes = 0;
  let sizeBytes = 0;
  for (const file of files) {
    compressedBytes += file.compressedBytes ?? file.sizeBytes ?? 0;
    sizeBytes += file.sizeBytes ?? file.compressedBytes ?? 0;
  }
  return { compressedBytes, sizeBytes };
};

/** Which column the cached-file list is ordered by, and which way. */
type CachedFileSort = { column: "path" | "compressed" | "stored"; direction: "asc" | "desc" };

// Opening a column for the first time answers the question that column is
// usually asked: paths alphabetically, sizes largest first.
const CACHED_FILE_SORT_DEFAULTS: Record<CachedFileSort["column"], CachedFileSort["direction"]> = {
  compressed: "desc",
  path: "asc",
  stored: "desc",
};

const cachedFileColumnBytes = (file: OfflineCachedFile, column: CachedFileSort["column"]) =>
  column === "compressed" ? file.compressedBytes : file.sizeBytes;

/**
 * Sorted copy. Equal sizes fall back to the path so the order never wobbles,
 * and a file with no measurement for the sorted column sits at the end rather
 * than posing as zero.
 */
const sortCachedFiles = (files: OfflineCachedFile[], sort: CachedFileSort) => {
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...files].sort((left, right) => {
    const byPath = cachedFileLabel(left.url).localeCompare(cachedFileLabel(right.url));
    if (sort.column === "path") return factor * byPath;
    const leftBytes = cachedFileColumnBytes(left, sort.column);
    const rightBytes = cachedFileColumnBytes(right, sort.column);
    if (leftBytes === null && rightBytes === null) return byPath;
    if (leftBytes === null) return 1;
    if (rightBytes === null) return -1;
    return leftBytes === rightBytes ? byPath : factor * (leftBytes - rightBytes);
  });
};

const cachedFileBytesLabel = (localizer: Localizer, bytes: number | null) =>
  bytes === null ? "—" : localizer.formatBytes(bytes);

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
}) => {
  const totals = cachedFileTotals(files);
  const [sort, setSort] = useState<CachedFileSort>({ column: "path", direction: "asc" });
  const sorted = useMemo(() => sortCachedFiles(files, sort), [files, sort]);
  // Re-clicking the active column reverses it; a new column opens at its own default.
  const toggleSort = (column: CachedFileSort["column"]) =>
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: CACHED_FILE_SORT_DEFAULTS[column] },
    );
  const sortHeader = (column: CachedFileSort["column"], label: string) => (
    <th
      aria-sort={sort.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={`sw-cache-col sw-cache-col-${column}`}
      scope="col"
    >
      <button
        className="sw-cache-sort"
        onClick={() => toggleSort(column)}
        title={localizer.message("ui.status.cachedFilesSortBy", { column: label })}
        type="button"
      >
        {label}
        <ArrowUp aria-hidden="true" className="sw-cache-sort-arrow" data-direction={sort.direction} />
      </button>
    </th>
  );
  return (
    <section className="sw-cached-files">
      <h3 className="sr-only">{localizer.message("ui.status.cachedFiles")}</h3>
      <Drawer
        className="sw-cache-drawer"
        label={localizer.message("ui.status.cachedFiles")}
        readouts={
          <>
            <DrawerReadout muted>{loading ? "…" : files.length}</DrawerReadout>
            {!loading && files.length > 0 ? (
              <DrawerReadout muted>
                {localizer.message("ui.runtime.offlineSizes", {
                  compressed: localizer.formatBytes(totals.compressedBytes),
                  uncompressed: localizer.formatBytes(totals.sizeBytes),
                })}
              </DrawerReadout>
            ) : null}
          </>
        }
      >
        {loading ? <p className="sw-cache-note">{localizer.message("ui.status.cachedFilesLoading")}</p> : null}
        {!loading && error ? <p className="sw-cache-note sw-cache-error">{error}</p> : null}
        {!(loading || error) && files.length === 0 ? (
          <p className="sw-cache-note">{localizer.message("ui.status.cachedFilesEmpty")}</p>
        ) : null}
        {!(loading || error) && files.length > 0 ? (
          <div className="sw-cache-scroll">
            <table className="sw-cache-list">
              <thead>
                <tr>
                  {sortHeader("path", localizer.message("ui.status.cachedFilesPath"))}
                  {sortHeader("compressed", localizer.message("ui.status.cachedFilesTransferred"))}
                  {sortHeader("stored", localizer.message("ui.status.cachedFilesStored"))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((file) => (
                  <tr data-cache={file.cache} key={`${file.cache}:${file.url}`}>
                    <td>
                      <code title={`${file.cache}: ${file.url}`}>{cachedFileLabel(file.url)}</code>
                    </td>
                    <td className="sw-cache-size">{cachedFileBytesLabel(localizer, file.compressedBytes)}</td>
                    <td className="sw-cache-size">{cachedFileBytesLabel(localizer, file.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Drawer>
    </section>
  );
};

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

/** Settings groups the jump links can reach, in panel order. */
const visibleSettingsGroups = (advanced: boolean) =>
  SETTINGS_PANEL_SECTIONS.filter((section) =>
    section.fields.some(
      (fieldKey) =>
        SETTINGS_FIELD_METADATA[fieldKey].kind !== "hidden" && (advanced || !ADVANCED_SETTINGS_FIELDS.has(fieldKey)),
    ),
  );

const AdvancedSwitch = ({ advanced, id, localizer }: { advanced: boolean; id: string; localizer: Localizer }) => (
  <button
    aria-checked={advanced}
    className="console-advanced"
    id={id}
    onClick={() => setAdvancedSettings(!advanced)}
    role="switch"
    type="button"
  >
    <span className="console-advanced-text">
      <span className="console-advanced-label">{localizer.message("ui.console.advanced")}</span>
      <span className="console-advanced-hint">{localizer.message("ui.console.advancedHint")}</span>
    </span>
    <span aria-hidden="true" className="console-switch" />
  </button>
);

/** One line naming what Advanced would show here, with the switch's shortcut. */
const HiddenNote = ({ children, localizer }: { children: ReactNode; localizer: Localizer }) => (
  <p className="console-hidden-note">
    <span>{children}</span>
    <button className="console-hidden-show" onClick={() => setAdvancedSettings(true)} type="button">
      {localizer.message("ui.console.showAdvanced")}
    </button>
  </p>
);

/**
 * The console's section list. Desktop draws it as a sidebar with jump links
 * under Settings and the Advanced switch at its foot; a phone draws it as the
 * bar at the foot of the page, led by the back link (see dialogs.css).
 */
const ConsoleNav = ({
  advanced,
  localizer,
  offlinePercent,
  onClose,
  onJump,
  onSelect,
  runtimeState,
  tab,
}: {
  advanced: boolean;
  localizer: Localizer;
  offlinePercent: number | null;
  onClose: () => void;
  onJump: (title: string) => void;
  onSelect: (tab: LogDialogTab) => void;
  runtimeState: RuntimeState;
  tab: LogDialogTab;
}) => {
  const tabsRef = useRef<HTMLDivElement | null>(null);
  return (
    <nav aria-label={localizer.message("ui.log.tabsLabel")} className="console-nav">
      <h2 className="console-nav-title">{localizer.message("ui.settings.title")}</h2>
      <button aria-label={localizer.message("ui.tools.tools")} className="console-back" onClick={onClose} type="button">
        <ChevronLeft aria-hidden="true" />
        <span>{localizer.message("ui.console.back")}</span>
      </button>
      <div
        aria-label={localizer.message("ui.log.tabsLabel")}
        aria-orientation="vertical"
        className="console-tabs"
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
              className="console-tab"
              data-logtab={entry}
              id={`logtab-${entry}`}
              key={entry}
              onClick={() => onSelect(entry)}
              role="tab"
              tabIndex={entry === tab ? 0 : -1}
              type="button"
            >
              {entry === "offline" ? (
                <span className="nav-runtime" data-sw={runtimeState}>
                  <RuntimeGlyph percent={offlinePercent} state={runtimeState} />
                </span>
              ) : (
                <TabIcon aria-hidden="true" />
              )}
              <span className="console-tab-label">{localizer.message(TAB_MESSAGES[entry])}</span>
              <span aria-hidden="true" className="console-tab-short">
                {localizer.message(TAB_SHORT_MESSAGES[entry])}
              </span>
            </button>
          );
        })}
      </div>
      {tab === "settings" ? (
        <ul className="console-jumps">
          {visibleSettingsGroups(advanced).map((section) => (
            <li key={section.title}>
              <button className="console-jump" onClick={() => onJump(section.title)} type="button">
                {section.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="console-nav-foot">
        <AdvancedSwitch advanced={advanced} id="console-advanced-desktop" localizer={localizer} />
        <span className="console-build">{`v${APP_VERSION}`}</span>
      </div>
    </nav>
  );
};

/**
 * Phone only: drag the section bar or the page's left edge to the right to
 * close, the way a pushed page goes back. The frame follows the finger, and a
 * release past a third of the width, or a flick, finishes the close.
 */
const PHONE_QUERY = "(max-width: 720px), (max-width: 860px) and (max-height: 520px)";
// Matches the frame's slide transition in dialogs.css.
const SLIDE_MS = 260;

/**
 * The root unmounts the dialog the moment it closes, so on a phone the page
 * slides out first and reports the close once it is off screen.
 */
const useSlideClose = (frameRef: RefObject<HTMLDivElement | null>, onClose: () => void) => {
  const leavingRef = useRef(false);
  useEffect(
    () => () => {
      leavingRef.current = false;
    },
    [],
  );
  return useCallback(() => {
    const frame = frameRef.current;
    if (!frame || prefersReducedMotion() || !window.matchMedia(PHONE_QUERY).matches) {
      onClose();
      return;
    }
    if (leavingRef.current) return;
    leavingRef.current = true;
    frame.style.transform = "translateX(100%)";
    window.setTimeout(() => {
      leavingRef.current = false;
      onClose();
      // A close the settings draft holds back (discard prompt) leaves the
      // dialog mounted, so the page slides back in under the prompt.
      frame.style.removeProperty("transform");
    }, SLIDE_MS);
  }, [frameRef, onClose]);
};

const useSwipeToClose = (frameRef: RefObject<HTMLDivElement | null>, onClose: () => void, open: boolean) => {
  useEffect(() => {
    const frame = frameRef.current;
    if (!(open && frame)) return undefined;
    const phone = window.matchMedia(PHONE_QUERY);
    let drag: {
      id: number;
      lastTime: number;
      lastX: number;
      on: boolean;
      velocity: number;
      x: number;
      y: number;
    } | null = null;
    let suppressClick = false;
    const release = () => {
      frame.classList.remove("is-dragging");
      frame.style.removeProperty("transform");
    };
    const onDown = (event: PointerEvent) => {
      suppressClick = false;
      if (!phone.matches || event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target?.closest(".console-nav, .console-edge")) return;
      drag = {
        id: event.pointerId,
        lastTime: event.timeStamp,
        lastX: event.clientX,
        on: false,
        velocity: 0,
        x: event.clientX,
        y: event.clientY,
      };
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      if (!drag.on) {
        if (Math.abs(dx) < 8) return;
        if (Math.abs(event.clientY - drag.y) > Math.abs(dx)) {
          drag = null;
          return;
        }
        drag.on = true;
        frame.classList.add("is-dragging");
        frame.setPointerCapture(drag.id);
      }
      frame.style.transform = `translateX(${Math.max(0, dx)}px)`;
      const elapsed = event.timeStamp - drag.lastTime;
      if (elapsed > 0) drag.velocity = (event.clientX - drag.lastX) / elapsed;
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
    };
    const onUp = (event: PointerEvent) => {
      const current = drag;
      drag = null;
      if (!current?.on) return;
      suppressClick = true;
      const dx = event.clientX - current.x;
      const closing = current.velocity > 0.4 || (current.velocity > -0.4 && dx > frame.clientWidth / 3);
      logger.trace("console swipe released", { closing, dx, velocity: current.velocity });
      frame.classList.remove("is-dragging");
      if (closing) onClose();
      else frame.style.removeProperty("transform");
    };
    // A drag that ends over a button must not also press it.
    const onClickCapture = (event: MouseEvent) => {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    frame.addEventListener("pointerdown", onDown);
    frame.addEventListener("pointermove", onMove);
    frame.addEventListener("pointerup", onUp);
    frame.addEventListener("pointercancel", onUp);
    frame.addEventListener("click", onClickCapture, true);
    return () => {
      release();
      frame.removeEventListener("pointerdown", onDown);
      frame.removeEventListener("pointermove", onMove);
      frame.removeEventListener("pointerup", onUp);
      frame.removeEventListener("pointercancel", onUp);
      frame.removeEventListener("click", onClickCapture, true);
    };
  }, [frameRef, onClose, open]);
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
  <fieldset className="seg logview">
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
  advanced,
  currentLevel,
  localizer,
  onLevelChange,
}: {
  advanced: boolean;
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
      {LOG_LEVELS.filter((value) => advanced || value === currentLevel || !ADVANCED_LOG_LEVELS.has(value)).map(
        (value) => (
          <option key={value} value={value}>
            {`level: ${value}`}
          </option>
        ),
      )}
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
  advanced,
  entries,
  filter,
  localizer,
  onScroll,
  traceRef,
  scrollTop,
  viewportHeight,
}: {
  advanced: boolean;
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
      className={advanced ? "tracelog mono" : "tracelog mono no-caller"}
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
  advanced,
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
  advanced: boolean;
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
  // The raw OPFS listing is a debugging tool, so without Advanced the storage
  // section is the emulator saves alone.
  if (showingOpfs && !advanced) {
    return (
      <div aria-labelledby="logtab-storage" className="dlg-body storage-body" id="logpanel-storage" role="tabpanel">
        <EmulatorSavesPanel active />
        <HiddenNote localizer={localizer}>{localizer.message("ui.console.hiddenOpfs")}</HiddenNote>
      </div>
    );
  }
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
            <LogLevelSelect
              advanced={advanced}
              currentLevel={currentLevel}
              localizer={localizer}
              onLevelChange={onLevelChange}
            />
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
            advanced={advanced}
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
  initialTab = "offline",
  licensesHref,
  onOpenWhatsNew,
  onRestoreDefaults,
  onSaveSettings,
  onTabChange,
  serviceWorkerStatus,
  offlineProgress = null,
  offlineCopyEnabled = true,
  onOfflineCopyEnabledChange,
  settingsFocusHint,
  settingsPanel,
  updateReady = false,
  previewRuntimeState = null,
  onPreviewRuntimeStateChange,
  onReloadUpdate,
}: {
  open: boolean;
  onClose: () => void;
  level?: string;
  onLevelChange: (level: string) => void;
  initialTab?: LogDialogTab;
  /** The license notices page; About links to it rather than repeating it. */
  licensesHref?: string;
  /** Opens the What's New page, which owns the full changelog. */
  onOpenWhatsNew?: () => void;
  onRestoreDefaults?: () => void;
  onSaveSettings?: () => void;
  onTabChange?: (tab: LogDialogTab) => void;
  serviceWorkerStatus?: ServiceWorkerStatus | null;
  offlineProgress?: OfflineWarmupDisplayProgress | null;
  offlineCopyEnabled?: boolean;
  onOfflineCopyEnabledChange?: (enabled: boolean) => void;
  settingsFocusHint?: SettingsFocusHint | null;
  /** The lazy settings panel, mounted only while its tab is showing. */
  settingsPanel?: ReactNode;
  updateReady?: boolean;
  previewRuntimeState?: RuntimeState | null;
  onPreviewRuntimeStateChange?: (state: RuntimeState | null) => void;
  onReloadUpdate?: () => void;
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
  const advanced = useAdvancedSettings();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const close = useSlideClose(frameRef, onClose);
  useSwipeToClose(frameRef, close, open);
  // A deep link to a field Advanced hides (Find, a tool's Threads link) turns Advanced on, or it would land nowhere.
  useEffect(() => {
    const fieldKey = settingsFocusHint ? SETTINGS_FIELD_ID_TO_KEY[settingsFocusHint.fieldId] : undefined;
    if (fieldKey && ADVANCED_SETTINGS_FIELDS.has(fieldKey)) setAdvancedSettings(true);
  }, [settingsFocusHint]);
  const jumpToGroup = useCallback((title: string) => {
    const group = document.getElementById(settingsGroupId(title));
    if (!group) return;
    logger.trace("settings jump link", { title });
    group.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }, []);
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
  const runtimeState =
    previewRuntimeState ?? resolveRuntimeState(serviceWorkerStatus, updateReady, offlineProgress, offlineCopyEnabled);
  const offlineCopy = useSyncExternalStore(subscribeOfflineCopyState, getOfflineCopyState, getInitialOfflineCopyState);
  const [opfsEntries, setOpfsEntries] = useState<StorageEntry[]>([]);
  const [opfsLoading, setOpfsLoading] = useState(false);
  const [opfsError, setOpfsError] = useState<string | null>(null);
  const [downloadUnavailable, setDownloadUnavailable] = useState(false);
  const requestDownload = () => {
    if (previewRuntimeState !== null) {
      onPreviewRuntimeStateChange?.("installing");
      return;
    }
    onOfflineCopyEnabledChange?.(true);
    const accepted = downloadOfflineCopy();
    setDownloadUnavailable(!accepted);
  };
  const requestUpdate = () => {
    if (previewRuntimeState !== null) {
      onPreviewRuntimeStateChange?.("ready");
      return;
    }
    onReloadUpdate?.();
  };
  const requestRemoval = () => {
    if (previewRuntimeState !== null) {
      onPreviewRuntimeStateChange?.("online");
      return;
    }
    setDownloadUnavailable(false);
    onOfflineCopyEnabledChange?.(false);
    setOfflineWarmupEnabled(false);
  };
  const [cachedFiles, setCachedFiles] = useState<OfflineCachedFile[]>([]);
  const [cachedFilesLoading, setCachedFilesLoading] = useState(false);
  const [cachedFilesError, setCachedFilesError] = useState<string | null>(null);
  // The previous-session snapshot is fixed at boot and remains available after any reload.
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
  // The inventory reads every cached body to measure it, so it is refreshed on
  // a slow tick rather than per progress event, and only while an install is
  // actually adding files with this panel in front of the user.
  const installing = runtimeState === "installing";
  useEffect(() => {
    if (!(open && tab === "offline" && advanced) || offlineCopy.pending) return undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (initial: boolean) => {
      if (initial) {
        setCachedFilesLoading(true);
        setCachedFilesError(null);
      }
      void queryOfflineCachedFiles()
        .then((files) => {
          if (active) setCachedFiles(files);
        })
        .catch((error) => {
          // A refresh that fails leaves the list as it was; only the first
          // load has nothing to show and so reports the error.
          if (active && initial) setCachedFilesError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!active) return;
          if (initial) setCachedFilesLoading(false);
          if (installing) timer = setTimeout(() => load(false), CACHE_INVENTORY_REFRESH_MS);
        });
    };
    load(true);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [advanced, installing, offlineCopy.pending, open, tab]);
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
      aria-label={localizer.message("ui.settings.title")}
      className="dlg log-dlg"
      /* focusable only on purpose: the open effect parks focus here so no
         control wears a ring before the user reaches it */
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
      ref={dialogRef}
    >
      <div className="dlg-frame console" ref={frameRef}>
        <ConsoleNav
          advanced={advanced}
          localizer={localizer}
          onClose={close}
          offlinePercent={runtimeState === "installing" ? offlineWarmupPercent(offlineProgress) : null}
          onJump={jumpToGroup}
          onSelect={selectTab}
          runtimeState={runtimeState}
          tab={tab}
        />
        <section aria-labelledby="console-pane-title" className="console-pane">
          <header className="dlg-head console-head">
            <div className="console-titles">
              <h2 className="console-title" id="console-pane-title">
                {localizer.message(TAB_MESSAGES[tab])}
              </h2>
              <p className="console-description">{localizer.message(TAB_DESCRIPTIONS[tab])}</p>
            </div>
            <AdvancedSwitch advanced={advanced} id="console-advanced-phone" localizer={localizer} />
            <button
              aria-label={localizer.message("ui.common.close")}
              className="dlg-x"
              onClick={close}
              title={localizer.message("ui.common.close")}
              type="button"
            >
              <X aria-hidden="true" />
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
          {tab === "offline" ? (
            <div
              aria-labelledby="logtab-offline"
              className="dlg-body status-panel"
              id="logpanel-offline"
              role="tabpanel"
            >
              <StatusRows
                downloadRequested={previewRuntimeState === null && offlineCopy.downloadRequested}
                downloadUnavailable={
                  previewRuntimeState === null && (downloadUnavailable || (offlineCopy.enabled && !!offlineCopy.error))
                }
                offlineCopyEnabled={
                  previewRuntimeState === null
                    ? offlineCopyEnabled
                    : previewRuntimeState !== "online" && previewRuntimeState !== "disabled"
                }
                removing={previewRuntimeState === null && !offlineCopy.enabled && offlineCopy.pending}
                removeUnavailable={previewRuntimeState === null && !offlineCopy.enabled && !!offlineCopy.error}
                onRemove={requestRemoval}
                onUpdate={onReloadUpdate || onPreviewRuntimeStateChange ? requestUpdate : undefined}
                localizer={localizer}
                offlineProgress={offlineProgress}
                onDownload={requestDownload}
                runtimeState={runtimeState}
              >
                {advanced ? (
                  <OfflineCachedFiles
                    error={cachedFilesError}
                    files={cachedFiles}
                    loading={cachedFilesLoading}
                    localizer={localizer}
                  />
                ) : (
                  <HiddenNote localizer={localizer}>{localizer.message("ui.console.hiddenCachedFiles")}</HiddenNote>
                )}
              </StatusRows>
              {isReactWebappDevelopmentMode() && onPreviewRuntimeStateChange ? (
                <section aria-label="Development" className="status-group sw-preview">
                  <h3 className="dlg-section-title">Development</h3>
                  <div className="sw-preview-control">
                    <label htmlFor="dev-offline-state">Offline status preview</label>
                    <span className="sw-preview-select">
                      <select
                        aria-describedby="dev-offline-state-help"
                        className="select"
                        id="dev-offline-state"
                        value={previewRuntimeState ?? "actual"}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          if (value === "actual") onPreviewRuntimeStateChange?.(null);
                          else if ((RUNTIME_STATES as readonly string[]).includes(value)) {
                            onPreviewRuntimeStateChange?.(value as RuntimeState);
                          }
                        }}
                      >
                        <option value="actual">Actual</option>
                        {RUNTIME_STATES.map((value) => (
                          <option key={value} value={value}>
                            {PREVIEW_STATE_LABELS[value]}
                          </option>
                        ))}
                      </select>
                    </span>
                  </div>
                  <p className="sw-cache-note" id="dev-offline-state-help">
                    Preview only. Resets on reload. Does not change the offline cache or service worker.
                  </p>
                </section>
              ) : null}
            </div>
          ) : null}
          {tab === "logs" || tab === "storage" ? (
            <LogsStoragePanel
              advanced={advanced}
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
          {tab === "about" ? (
            <div
              aria-labelledby="logtab-about"
              className="dlg-body status-panel about-panel"
              id="logpanel-about"
              role="tabpanel"
            >
              <AboutPanel licensesHref={licensesHref} localizer={localizer} onOpenWhatsNew={onOpenWhatsNew} />
            </div>
          ) : null}
        </section>
        {/* Phone only: a strip on the left edge that starts the swipe back. */}
        <div aria-hidden="true" className="console-edge" />
      </div>
    </dialog>
  );
};

export { cachedFileBytesLabel, cachedFileTotals, LogDialog, sortCachedFiles };
export type { LogDialogTab, SettingsFocusHint };
