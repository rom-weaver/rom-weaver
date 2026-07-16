import X from "lucide-react/dist/esm/icons/x.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { createLogger } from "../../lib/logging.ts";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { LOG_LEVELS, type LogLevel } from "../../types/logging.ts";
import { getLastSessionEntries, getLogEntries, type LogStoreEntry, subscribeLogEntries } from "../log-store.ts";

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

// Cap how many lines render at once. A trace-level session fills the ring with thousands of entries,
// and rendering them all as buttons spikes DOM/memory enough to OOM-reload a memory-constrained tab
// (iOS Safari especially, mid-run). Render only the newest N; the filter narrows to find older lines
// and Copy/Download still cover the full filtered set.
const MAX_RENDERED_LINES = 500;

const formatDetails = (details: LogStoreEntry["details"]) => {
  if (!details || Object.keys(details).length === 0) return "";
  try {
    const json = JSON.stringify(details);
    return json.length > MAX_DETAILS_CHARS ? `${json.slice(0, MAX_DETAILS_CHARS)}… (${json.length} chars)` : json;
  } catch {
    return "";
  }
};

// The line number (`id`) is a UI-only column (see TraceLine) - copy/download text omits it so the output
// is clean, paste-ready log lines. A gap in the on-screen numbers still shows where the ring dropped lines.
// Lines use the short time column shown on screen and a fixed-width level so pasted/downloaded logs stay
// aligned in a monospace view. `formatLine` (capped details) feeds the filter - capping keeps a giant
// payload from being re-serialized on every keystroke; `formatCopyLine` (full details) feeds copy/download,
// where the on-screen cap and its "…(N chars)" marker would just corrupt a saved log.
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
      <span className="ln-no">{entry.id}</span>
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

const LogDialog = ({
  open,
  onClose,
  level,
  onLevelChange,
}: {
  open: boolean;
  onClose: () => void;
  level?: string;
  onLevelChange: (level: string) => void;
}) => {
  const localizer = useUiLocalizer();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const traceRef = useRef<HTMLDivElement | null>(null);
  const currentLevel = normalizeLevel(level);
  const [filter, setFilter] = useState("");
  const [copiedAll, setCopiedAll] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [view, setView] = useState<"current" | "previous">("current");
  // Previous session's entries (promoted from localStorage at boot); the "previous" view shows a run that
  // OOM-reloaded the tab. Stable for the session, so read once.
  const previousEntries = useMemo(() => getLastSessionEntries(), []);
  const hasPrevious = previousEntries.length > 0;
  const showingPrevious = view === "previous" && hasPrevious;
  // Subscribe to the live store only when actually showing it, so the previous/closed case doesn't
  // re-render every frame during trace-heavy runs.
  const liveEntries = useSyncExternalStore(
    open && !showingPrevious ? subscribeLogEntries : noopSubscribe,
    open && !showingPrevious ? getLogEntries : getEmptyEntries,
    getEmptyEntries,
  );
  const entries = showingPrevious ? previousEntries : liveEntries;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => formatLine(entry).toLowerCase().includes(query));
  }, [entries, filter]);

  // Only the newest MAX_RENDERED_LINES are mounted; copy/download below still use the full `visible`
  // set, so capping the DOM never drops data from a saved log.
  const rendered = visible.length > MAX_RENDERED_LINES ? visible.slice(-MAX_RENDERED_LINES) : visible;
  const hiddenLineCount = visible.length - rendered.length;

  // Keep the newest lines in view while the dialog is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scrolling follows the rendered line count while the dialog is open.
  useEffect(() => {
    const trace = traceRef.current;
    if (open && trace) trace.scrollTop = trace.scrollHeight;
  }, [open, visible.length]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close mirrors <dialog> cancel semantics.
    <dialog
      aria-labelledby="log-title"
      className="dlg log-dlg"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      ref={dialogRef}
    >
      <div className="dlg-frame">
        <header className="dlg-head">
          <h2 className="dlg-title" id="log-title">
            {localizer.message("ui.tools.log")}
          </h2>
          <div className="dlg-actions log-actions">
            {hasPrevious ? (
              <fieldset className="logview">
                <legend className="sr-only">{localizer.message("ui.log.viewLabel")}</legend>
                <button
                  aria-pressed={!showingPrevious}
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
            <button
              className={`btn slim ghost${copiedAll ? " copied" : ""}${copyFailed ? " copy-failed" : ""}`}
              onClick={() => {
                copyToClipboard(visible.map(formatCopyLine).join("\n"))
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
              type="button"
            >
              {localizer.message("ui.common.copy")}
            </button>
            <button
              className="btn slim ghost"
              onClick={() => {
                void triggerBrowserDownload(
                  visible.map(formatCopyLine).join("\n"),
                  showingPrevious ? "rom-weaver-previous-log.txt" : "rom-weaver-log.txt",
                );
              }}
              type="button"
            >
              {localizer.message("ui.result.download")}
            </button>
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
          </div>
          <button aria-label={localizer.message("ui.common.close")} className="dlg-x" onClick={onClose} type="button">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="log-filter-bar">
          <input
            aria-label={localizer.message("ui.log.filterLabel")}
            className="input mono log-filter"
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder={localizer.message("ui.log.filter")}
            type="search"
            value={filter}
          />
        </div>
        <div className="dlg-body log-body">
          <div aria-atomic="false" aria-live="polite" className="tracelog mono" ref={traceRef}>
            {visible.length === 0 ? (
              <div className="tracelog-empty">
                {filter.trim() ? localizer.message("ui.log.emptyFilter", { q: filter.trim() }) : "-"}
              </div>
            ) : (
              <>
                {hiddenLineCount > 0 ? (
                  <div className="tracelog-truncated">
                    {`${hiddenLineCount} earlier line(s) hidden - filter to narrow, or Download for the full log`}
                  </div>
                ) : null}
                {rendered.map((entry) => (
                  <TraceLine entry={entry} key={entry.id} />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
};

export { LogDialog };
