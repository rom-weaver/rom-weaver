import { configureLogger, createLogger, getConsoleLogSink, type LogSink } from "../lib/logging.ts";
import type { LogLevel, LogRecord } from "../types/logging.ts";
import { type ConsoleLogRecord, subscribeConsoleLogRecords } from "./console-log-capture.ts";

/**
 * Ring buffer behind the in-app log viewer, mirroring the configured console
 * sink through a useSyncExternalStore-compatible API.
 *
 * Pushes append to a mutable buffer; one animation-frame flush trims, snapshots,
 * and notifies so trace bursts cause at most one render per frame.
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

// Persist a bounded session log on coalesced flushes so it can be inspected after a reload.
// Boot moves currentLog to lastLog before the new session starts.
const CURRENT_LOG_STORAGE_KEY = "currentLog";
const LAST_LOG_STORAGE_KEY = "lastLog";
// Bound the number of persisted entries, dropping the oldest first.
// Entry sizes vary, so this count does not guarantee that the JSON fits the storage quota.
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
    // quota exceeded / disabled - the in-memory store still works, only crash-recovery is lost
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
    return []; // corrupt/partial JSON (e.g. a write cut off by the crash) - drop it rather than throw
  }
};

// Preserve the previous session before this session starts writing logs.
// The Log panel reads these entries in its previous-session view.
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

// Persist a larger bounded history than the on-screen ring buffer so saved logs can cover longer runs.
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
   rom_weaver_app::detect: message") - via the workflow sink (namespace
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
  // logger-formatted lines (%c…) already arrive through the sink - skip the
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
  // other console output (vite client, libraries) - keep, attributed to console
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
  // Flush the latest entries on pagehide when the browser delivers it.
  // An abrupt termination can lose entries since the last completed storage write.
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
