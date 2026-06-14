import { configureLogger, createLogger, getConsoleLogSink, type LogSink } from "../lib/logging.ts";
import type { LogLevel, LogRecord } from "../types/logging.ts";
import { type ConsoleLogRecord, subscribeConsoleLogRecords } from "./console-log-capture.ts";

/**
 * Ring buffer behind the in-app log viewer (the masthead Log dialog). Installs
 * a capturing logger sink that chains to the default console sink, so the
 * dialog mirrors exactly what reaches the console at the configured level.
 * Subscribe/getSnapshot follow the vanilla-store shape for
 * useSyncExternalStore.
 */

const MAX_LOG_LINES = 500;

type LogStoreEntry = LogRecord & { id: number };

const logger = createLogger("log-store");

let entries: readonly LogStoreEntry[] = [];
let nextId = 1;
let installed = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

const push = (record: LogRecord) => {
  const entry: LogStoreEntry = { ...record, id: nextId };
  nextId += 1;
  entries = entries.length >= MAX_LOG_LINES ? [...entries.slice(-(MAX_LOG_LINES - 1)), entry] : [...entries, entry];
  notify();
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
  logger.trace("Log store sink installed", { maxLines: MAX_LOG_LINES });
};

const getLogEntries = (): readonly LogStoreEntry[] => entries;

const subscribeLogEntries = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type { LogStoreEntry };
export { getLogEntries, installLogStore, parseRustTraceRecord, subscribeLogEntries };
