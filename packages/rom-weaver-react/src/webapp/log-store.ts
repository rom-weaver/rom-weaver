import { configureLogger, createLogger, getConsoleLogSink, type LogSink } from "../lib/logging.ts";
import type { LogRecord } from "../types/logging.ts";

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

/** Install the capturing sink. Safe to call repeatedly; only installs once. */
const installLogStore = () => {
  if (installed) return;
  installed = true;
  const consoleSink: LogSink = getConsoleLogSink();
  configureLogger({
    sink: (record) => {
      consoleSink(record);
      push(record);
    },
  });
  logger.trace("Log store sink installed", { maxLines: MAX_LOG_LINES });
};

const getLogEntries = (): readonly LogStoreEntry[] => entries;

const clearLogEntries = () => {
  entries = [];
  notify();
};

const subscribeLogEntries = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type { LogStoreEntry };
export { clearLogEntries, getLogEntries, installLogStore, subscribeLogEntries };
