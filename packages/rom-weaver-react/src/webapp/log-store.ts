import { configureLogger, createLogger, getConsoleLogSink, type LogSink } from "../lib/logging.ts";
import type { LogLevel, LogRecord } from "../types/logging.ts";
import { type ConsoleLogRecord, subscribeConsoleLogRecords } from "./console-log-capture.ts";

/**
 * Ring buffer behind the in-app log viewer (the masthead Log dialog). Installs
 * a capturing logger sink that chains to the default console sink, so the
 * dialog mirrors exactly what reaches the console at the configured level.
 * Subscribe/getSnapshot follow the vanilla-store shape for
 * useSyncExternalStore.
 *
 * Pushes are O(1) and never touch React: appends land in a mutable buffer and
 * a single flush is coalesced onto the next animation frame, which trims to the
 * cap, rebuilds the immutable snapshot once, and notifies listeners once. Under
 * trace logging the buffer can take hundreds of lines per frame (each Rust
 * tracing line is a record); coalescing keeps that a single re-render per frame
 * instead of one full-array rebuild and render per line.
 */

const MAX_LOG_LINES = 2500;

type LogStoreEntry = LogRecord & { id: number };

const logger = createLogger("log-store");

// Mutable append buffer; `snapshot` is the immutable view handed to React.
const buffer: LogStoreEntry[] = [];
let snapshot: readonly LogStoreEntry[] = [];
let snapshotDirty = false;
let nextId = 1;
let installed = false;
let flushScheduled = false;
const listeners = new Set<() => void>();

// The session log is mirrored to localStorage so a run that OOM-reloads the tab stays recoverable: the
// in-memory ring buffer dies with the tab, but a synchronous localStorage write survives the reload.
// Stored as a JSON array of the WHOLE session (not just the viewer's MAX_LOG_LINES ring) so a long trace
// run isn't truncated to its tail; structured (not flattened text) so the previous-session view renders
// with full fidelity — no lossy re-parse. Two keys: this session streams into `currentLog`; on boot the
// previous session's `currentLog` is promoted to `lastLog` (below) before this session overwrites it, so
// the prior — possibly crashed — run is what the Log panel can show. The write rides the snapshot flush
// (coalesced to once per animation frame, only when new lines landed), so the freshest lines before a
// crash are saved without an O(n^2) rewrite-the-whole-log-per-line.
const CURRENT_LOG_STORAGE_KEY = "currentLog";
const LAST_LOG_STORAGE_KEY = "lastLog";
// Cap the persisted session so its JSON stays well under the ~5 MB localStorage quota; oldest entries
// drop first (the crash window is the most recent). The on-screen viewer keeps its own MAX_LOG_LINES cap.
const PERSIST_MAX_ENTRIES = 20000;

const readLocalStorage = (key: string): string | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null; // disabled / private mode / quota
  }
};

const writeLocalStorage = (key: string, value: string) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
  } catch {
    // quota exceeded / disabled — the in-memory store still works, only crash-recovery is lost
  }
};

const removeLocalStorage = (key: string) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(key);
  } catch {
    // ignore
  }
};

const parseStoredEntries = (raw: string | null): LogStoreEntry[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LogStoreEntry[]) : [];
  } catch {
    return []; // corrupt/partial JSON (e.g. a write cut off by the crash) — drop it rather than throw
  }
};

// Promote the previous session's live log to `lastLog`, then start this session clean. Runs once at
// module load, ahead of any push/persist, so the crashed run's `currentLog` is preserved before this
// session begins streaming over it. `lastSessionEntries` is what the Log panel's "previous" view shows.
const promoteCurrentLogToLast = (): LogStoreEntry[] => {
  const previous = readLocalStorage(CURRENT_LOG_STORAGE_KEY);
  if (previous !== null) {
    writeLocalStorage(LAST_LOG_STORAGE_KEY, previous);
    removeLocalStorage(CURRENT_LOG_STORAGE_KEY);
    return parseStoredEntries(previous);
  }
  return parseStoredEntries(readLocalStorage(LAST_LOG_STORAGE_KEY));
};
const lastSessionEntries = promoteCurrentLogToLast();

/** The previous session's log entries (promoted from `currentLog` at boot), or empty. Shown by the Log
 * panel's "previous" view so a run that reloaded the tab can still be inspected/downloaded. */
const getLastSessionEntries = (): readonly LogStoreEntry[] => lastSessionEntries;

// Full-session entries mirrored to localStorage as JSON on each flush. Separate from `buffer` (the viewer
// ring, capped at MAX_LOG_LINES) so the saved log keeps the whole run; oldest trimmed past the cap.
const persistEntries: LogStoreEntry[] = [];

const persistCurrentLog = () => {
  writeLocalStorage(CURRENT_LOG_STORAGE_KEY, JSON.stringify(persistEntries));
};

const notify = () => {
  for (const listener of listeners) listener();
};

// Trim to the cap and rebuild the immutable snapshot. Trimming here (not per
// push) keeps push O(1); this runs at most once per frame, or lazily when a
// reader asks for the snapshot while it is dirty.
const rebuildSnapshot = () => {
  if (buffer.length > MAX_LOG_LINES) buffer.splice(0, buffer.length - MAX_LOG_LINES);
  snapshot = buffer.slice();
  snapshotDirty = false;
};

const scheduleFlush = () => {
  if (flushScheduled) return;
  flushScheduled = true;
  const flush = () => {
    flushScheduled = false;
    if (snapshotDirty) rebuildSnapshot();
    notify();
    persistCurrentLog();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
  else setTimeout(flush, 0);
};

const push = (record: LogRecord) => {
  const entry = { ...record, id: nextId };
  buffer.push(entry);
  nextId += 1;
  persistEntries.push(entry);
  if (persistEntries.length > PERSIST_MAX_ENTRIES) {
    persistEntries.splice(0, persistEntries.length - PERSIST_MAX_ENTRIES);
  }
  snapshotDirty = true;
  scheduleFlush();
};

/* Rust `tracing` lines ride inside log messages ("2026-…Z TRACE
   rom_weaver_app::detect: message") — via the workflow sink (namespace
   runtime:rom-weaver) and occasionally the raw console. Parse them back into
   structured records so the dialog's caller column shows the Rust target,
   like the loom prototype's inspector. */
const RUST_TRACE_LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s*(.*)$/s;

/** Re-attribute a record whose message is a Rust tracing line. */
const parseRustTraceRecord = (record: LogRecord): LogRecord => {
  const rust = record.message.match(RUST_TRACE_LINE);
  if (!rust) return record;
  return {
    ...record,
    level: (rust[2] || record.level).toLowerCase() as LogRecord["level"],
    message: (rust[4] || "").trim(),
    namespace: rust[3] || record.namespace,
    timestamp: rust[1] || record.timestamp,
  };
};

const toConsoleEntry = (record: ConsoleLogRecord): LogRecord | null => {
  const first = record.args[0];
  if (typeof first !== "string") return null;
  // logger-formatted lines (%c…) already arrive through the sink — skip the
  // duplicate the default console sink produces
  if (first.startsWith("%c")) return null;
  if (RUST_TRACE_LINE.test(first)) {
    return parseRustTraceRecord({
      level: "info" as LogLevel,
      message: first,
      namespace: "console",
      timestamp: record.timestamp,
    } as LogRecord);
  }
  // other console output (vite client, libraries) — keep, attributed to console
  const rest = record.args
    .slice(1)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ");
  return {
    level: (record.level === "log" ? "info" : record.level) as LogLevel,
    message: rest ? `${first} ${rest}` : first,
    namespace: record.source === "console" ? "console" : record.source,
    timestamp: record.timestamp,
  } as LogRecord;
};

/** Install the capturing sink. Safe to call repeatedly; only installs once. */
const installLogStore = () => {
  if (installed) return;
  installed = true;
  const consoleSink: LogSink = getConsoleLogSink();
  configureLogger({
    sink: (record) => {
      consoleSink(record);
      push(parseRustTraceRecord(record));
    },
  });
  subscribeConsoleLogRecords((record) => {
    const entry = toConsoleEntry(record);
    if (entry) push(entry);
  });
  // Final synchronous flush on a graceful unload so the tail past the last throttled write is saved.
  // An OOM tab-reload won't fire this, but the ~250 ms throttle already captures nearly all of it.
  if (typeof window !== "undefined") window.addEventListener("pagehide", persistCurrentLog);
  logger.trace("Log store sink installed", { maxLines: MAX_LOG_LINES });
};

const getLogEntries = (): readonly LogStoreEntry[] => {
  if (snapshotDirty) rebuildSnapshot();
  return snapshot;
};

const subscribeLogEntries = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type { LogStoreEntry };
export { getLastSessionEntries, getLogEntries, installLogStore, parseRustTraceRecord, subscribeLogEntries };
