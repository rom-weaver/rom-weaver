import X from "lucide-react/dist/esm/icons/x.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { createLogger } from "../../lib/logging.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { LOG_LEVELS, type LogLevel } from "../../types/logging.ts";
import { getLogEntries, type LogStoreEntry, subscribeLogEntries } from "../log-store.ts";

/**
 * The masthead Log dialog: a native <dialog> trace inspector over the
 * in-app log store, with a capture-level selector, text search, copy-all, and
 * click-to-copy lines — the loom prototype's inspector wired to the real
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

const formatDetails = (details: LogStoreEntry["details"]) => {
  if (!details || Object.keys(details).length === 0) return "";
  try {
    const json = JSON.stringify(details);
    return json.length > MAX_DETAILS_CHARS ? `${json.slice(0, MAX_DETAILS_CHARS)}… (${json.length} chars)` : json;
  } catch {
    return "";
  }
};

const formatLine = (entry: LogStoreEntry) => {
  const details = formatDetails(entry.details);
  return `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.namespace}: ${entry.message}${details ? ` ${details}` : ""}`;
};

const EMPTY_ENTRIES: readonly LogStoreEntry[] = [];
// While the dialog is closed there is nothing to show, so subscribe to a no-op
// store: otherwise useSyncExternalStore re-renders the whole list every
// animation frame during trace-heavy operations even though it is off-screen.
const getEmptyEntries = () => EMPTY_ENTRIES;
const noopUnsubscribe = () => undefined;
const noopSubscribe = () => noopUnsubscribe;

const TraceLine = ({ entry }: { entry: LogStoreEntry }) => {
  const [copied, setCopied] = useState(false);
  const details = formatDetails(entry.details);
  return (
    <button
      className={copied ? "ln copied" : "ln"}
      onClick={() => {
        copyToClipboard(formatLine(entry))
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          })
          .catch((error) => logger.trace("Log line copy failed", { message: String(error) }));
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
  const entries = useSyncExternalStore(
    open ? subscribeLogEntries : noopSubscribe,
    open ? getLogEntries : getEmptyEntries,
    getEmptyEntries,
  );

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

  // Keep the newest lines in view while the dialog is open.
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
            <input
              aria-label={localizer.message("ui.log.filterLabel")}
              className="input mono log-filter"
              onChange={(event) => setFilter(event.currentTarget.value)}
              placeholder={localizer.message("ui.log.filter")}
              type="search"
              value={filter}
            />
            <label className="loglevel">
              <span className="sr-only">{localizer.message("settings.logLevel")}</span>
              <select
                className="select mono"
                onChange={(event) => onLevelChange(event.currentTarget.value)}
                value={currentLevel}
              >
                {LOG_LEVELS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn slim ghost"
              onClick={() => {
                copyToClipboard(visible.map(formatLine).join("\n"))
                  .then(() => {
                    setCopiedAll(true);
                    window.setTimeout(() => setCopiedAll(false), 1300);
                  })
                  .catch((error) => logger.trace("Log copy failed", { message: String(error) }));
              }}
              type="button"
            >
              {copiedAll ? localizer.message("ui.announce.copied") : localizer.message("ui.common.copy")}
            </button>
          </div>
          <button aria-label={localizer.message("ui.common.close")} className="dlg-x" onClick={onClose} type="button">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="dlg-body log-body">
          <div aria-atomic="false" aria-live="polite" className="tracelog mono" ref={traceRef}>
            {visible.length === 0 ? (
              <div className="tracelog-empty">
                {filter.trim() ? localizer.message("ui.log.emptyFilter", { q: filter.trim() }) : "—"}
              </div>
            ) : (
              visible.map((entry) => <TraceLine entry={entry} key={entry.id} />)
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
};

export { LogDialog };
