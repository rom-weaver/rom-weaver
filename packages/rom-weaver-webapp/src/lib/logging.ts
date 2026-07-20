import { LOG_LEVELS, type LogDetails, type LogLevel, type LogRecord } from "../types/logging.ts";

type LogSink = (record: LogRecord) => void;
type LogOptions = {
  level?: LogLevel | string | null;
};
type TraceLogContext = {
  logLevel?: LogLevel | string | null;
  namespace: string;
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
};

type Logger = {
  debug: (message: string, details?: LogDetails, options?: LogOptions) => void;
  error: (message: string, details?: LogDetails, options?: LogOptions) => void;
  info: (message: string, details?: LogDetails, options?: LogOptions) => void;
  trace: (message: string, details?: LogDetails, options?: LogOptions) => void;
  warn: (message: string, details?: LogDetails, options?: LogOptions) => void;
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 4,
  error: 1,
  info: 3,
  off: 0,
  trace: 5,
  warn: 2,
};

const CONSOLE_METHOD_BY_LEVEL: Record<LogRecord["level"], "debug" | "error" | "info" | "warn"> = {
  debug: "debug",
  error: "error",
  info: "info",
  trace: "debug",
  warn: "warn",
};

const BROWSER_LEVEL_COLORS: Record<LogRecord["level"], string> = {
  debug: "color: #2563eb; font-weight: 700",
  error: "color: #dc2626; font-weight: 700",
  info: "color: #0f766e; font-weight: 700",
  trace: "color: #7c3aed; font-weight: 700",
  warn: "color: #b45309; font-weight: 700",
};

let globalLogLevel: LogLevel = "warn";
let globalLogSink: LogSink | null = null;

const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);

const normalizeLogLevel = (value: unknown, fallback: LogLevel = "warn"): LogLevel => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : fallback;
};

const isTraceLogEnabled = (value: unknown): boolean => normalizeLogLevel(value, "off") === "trace";

const shouldLog = (messageLevel: LogRecord["level"], configuredLevel: LogLevel): boolean =>
  configuredLevel !== "off" && LEVEL_PRIORITY[messageLevel] <= LEVEL_PRIORITY[configuredLevel];

const summarizeBinaryValue = (value: unknown): string | null => {
  if (typeof Blob !== "undefined" && value instanceof Blob) return `[Blob ${value.size} bytes]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
  return null;
};

const isBinaryDetailKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return (
    normalized === "file" ||
    normalized === "blob" ||
    normalized === "data" ||
    normalized === "buffer" ||
    normalized === "bytes" ||
    normalized === "u8array" ||
    normalized.endsWith("buffer") ||
    normalized.endsWith("bytes") ||
    normalized.endsWith("blob") ||
    normalized.endsWith("u8array")
  );
};

const sanitizePathValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || "[path]";
};

const isPathDetailKey = (key: string): boolean => {
  const normalized = key.toLowerCase();
  return (
    normalized === "path" ||
    normalized === "filepath" ||
    normalized === "opfspath" ||
    normalized === "temppath" ||
    normalized.endsWith("path") ||
    normalized.endsWith("paths")
  );
};

const sanitizeLogValue = (value: unknown, depth = 0): unknown => {
  const binarySummary = summarizeBinaryValue(value);
  if (binarySummary) return binarySummary;
  if (value instanceof Error) return { message: value.message, name: value.name, stack: value.stack };
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (depth >= 3) return "[Object]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeLogValue(item, depth + 1));
  const output: LogDetails = {};
  for (const [key, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (isPathDetailKey(key)) {
      output[key] = Array.isArray(childValue)
        ? childValue.slice(0, 20).map(sanitizePathValue)
        : sanitizePathValue(childValue);
      continue;
    }
    if (isBinaryDetailKey(key)) {
      output[key] = summarizeBinaryValue(childValue) || (childValue ? `[${typeof childValue}]` : childValue);
      continue;
    }
    output[key] = sanitizeLogValue(childValue, depth + 1);
  }
  return output;
};

const sanitizeLogDetails = (details?: LogDetails): LogDetails | undefined => {
  if (!details) return undefined;
  return sanitizeLogValue(details) as LogDetails;
};

const getDefaultConsoleSink = (): LogSink => {
  const isBrowserConsole = typeof window !== "undefined" && typeof document !== "undefined";
  return (record) => {
    if (typeof console === "undefined") return;
    const method = console[CONSOLE_METHOD_BY_LEVEL[record.level]] || console.log;
    const details = record.details && Object.keys(record.details).length ? record.details : undefined;
    if (isBrowserConsole) {
      // Embed the ISO timestamp in the line text (dim) so browser/JS trace lines are self-timed like the
      // Rust trace lines (`2026-…Z TRACE …`), without relying on the console-capture envelope's metadata.
      // Namespace and message go through `%s` rather than into the format string: a `%c`/`%s` inside a
      // caller-supplied message would otherwise consume the style arguments and garble the line.
      method.call(
        console,
        `%c${record.timestamp}%c %c${record.level.toUpperCase()}%c %s`,
        "color: #6b7280; font-weight: 400",
        "color: inherit; font-weight: inherit",
        BROWSER_LEVEL_COLORS[record.level],
        "color: inherit; font-weight: inherit",
        `${record.namespace}: ${record.message}`,
        ...(details ? [details] : []),
      );
      return;
    }
    method.call(console, formatLogRecord(record), ...(details ? [details] : []));
  };
};

const emitLogRecord = (
  namespace: string,
  level: LogRecord["level"],
  message: string,
  details?: LogDetails,
  options?: LogOptions,
) => {
  const configuredLevel =
    options && "level" in options ? normalizeLogLevel(options.level, globalLogLevel) : globalLogLevel;
  if (!shouldLog(level, configuredLevel)) return;
  const record: LogRecord = {
    details: sanitizeLogDetails(details),
    level,
    message,
    namespace,
    timestamp: new Date().toISOString(),
  };
  (globalLogSink || getDefaultConsoleSink())(record);
};

const emitTraceLog = (context: TraceLogContext, message: string, details: LogDetails = {}) => {
  if (!isTraceLogEnabled(context.logLevel)) return;
  context.onLog?.({
    details,
    level: "trace",
    message,
    namespace: context.namespace,
    timestamp: new Date().toISOString(),
  });
};

const createLogger = (namespace: string, defaults?: LogOptions): Logger => {
  const logWithLevel = (level: LogRecord["level"], message: string, details?: LogDetails, options?: LogOptions) =>
    emitLogRecord(namespace, level, message, details, options || defaults);
  return {
    debug: (message, details, options) => logWithLevel("debug", message, details, options),
    error: (message, details, options) => logWithLevel("error", message, details, options),
    info: (message, details, options) => logWithLevel("info", message, details, options),
    trace: (message, details, options) => logWithLevel("trace", message, details, options),
    warn: (message, details, options) => logWithLevel("warn", message, details, options),
  };
};

const configureLogger = (options: { level?: LogLevel | string | null; sink?: LogSink | null }) => {
  if ("level" in options) globalLogLevel = normalizeLogLevel(options.level, globalLogLevel);
  if ("sink" in options) globalLogSink = options.sink || null;
};

/** The console sink used when no custom sink is configured. Exported so a
 * capturing sink (the in-app log viewer) can chain to it. */
const getConsoleLogSink = (): LogSink => getDefaultConsoleSink();

const formatLogRecord = (record: LogRecord): string =>
  `${record.timestamp} ${record.level.toUpperCase()} ${record.namespace}: ${record.message}`;

export type { LogSink };
export { configureLogger, createLogger, emitTraceLog, getConsoleLogSink };
