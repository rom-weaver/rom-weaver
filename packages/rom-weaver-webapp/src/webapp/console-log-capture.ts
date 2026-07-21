type ConsoleLogLevel = "debug" | "error" | "info" | "log" | "trace" | "warn";
type ConsoleLogSource = "console" | "unhandledrejection" | "window.error";

type ConsoleLogRecord = {
  args: unknown[];
  elapsedMs: number | null;
  id: number;
  level: ConsoleLogLevel;
  source: ConsoleLogSource;
  timestamp: string;
};

type ConsoleLogReport = {
  app: {
    branch?: string;
    channel?: string;
    commit?: string;
    dirty?: string;
    version?: string;
  };
  logs: ConsoleLogRecord[];
  page: {
    href: string;
    referrer: string;
    title: string;
  };
  runtime: {
    atomicsWaitAsync: string;
    crossOriginIsolated: boolean;
    isSecureContext: boolean;
    language: string;
    logCount: number;
    platform: string;
    sharedArrayBuffer: string;
    userAgent: string;
    viewport: {
      devicePixelRatio: number;
      height: number;
      width: number;
    };
  };
};

type ConsoleLogReportMetadata = Omit<ConsoleLogReport, "logs">;

const CONSOLE_LOG_METHODS = ["debug", "error", "info", "log", "trace", "warn"] as const;
const MAX_LOG_RECORDS = 1000;
const MAX_STRING_LENGTH = 20_000;
const MAX_ARRAY_ITEMS = 30;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 4;

let nextRecordId = 1;
const records: ConsoleLogRecord[] = [];
const originalConsole = new Map<ConsoleLogLevel, (...args: unknown[]) => void>();

const nowIso = () => new Date().toISOString();
const elapsedMs = () => {
  if (typeof performance === "undefined" || typeof performance.now !== "function") return null;
  return Math.round(performance.now());
};

const truncateString = (value: string): string =>
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}... [truncated]` : value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const summarizeBinaryValue = (value: unknown): string | null => {
  if (typeof Blob !== "undefined" && value instanceof Blob) return `[Blob ${value.size} bytes]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
  return null;
};

const serializeArrayValue = (value: unknown[], depth: number, seen: WeakSet<object>) => {
  const output = value.slice(0, MAX_ARRAY_ITEMS).map((item) => serializeLogValue(item, depth + 1, seen));
  if (value.length > MAX_ARRAY_ITEMS) output.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
  return output;
};

const serializeEventValue = (value: Event) => ({
  target: value.target instanceof Element ? value.target.tagName.toLowerCase() : null,
  type: value.type,
});

const serializeRecordValue = (value: Record<string, unknown>, depth: number, seen: WeakSet<object>) => {
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  const output: Record<string, unknown> = {};
  for (const [key, childValue] of entries) output[key] = serializeLogValue(childValue, depth + 1, seen);
  if (Object.keys(value).length > MAX_OBJECT_KEYS) output.__truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
  return output;
};

const serializeLogValue = (value: unknown, depth = 0, seen = new WeakSet<object>()): unknown => {
  const binarySummary = summarizeBinaryValue(value);
  if (binarySummary) return binarySummary;
  if (typeof value === "string") return truncateString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof Error) return { message: value.message, name: value.name, stack: value.stack };
  if (depth >= MAX_DEPTH) return `[${Object.prototype.toString.call(value)}]`;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return serializeArrayValue(value, depth, seen);
  if (value instanceof Event) return serializeEventValue(value);
  if (!isRecord(value)) return String(value);
  return serializeRecordValue(value, depth, seen);
};

const recordListeners = new Set<(record: ConsoleLogRecord) => void>();

/** Notify on every captured console record (the in-app log viewer taps this). */
const subscribeConsoleLogRecords = (listener: (record: ConsoleLogRecord) => void) => {
  recordListeners.add(listener);
  return () => {
    recordListeners.delete(listener);
  };
};

const captureRecord = (level: ConsoleLogLevel, source: ConsoleLogSource, args: unknown[]) => {
  const record: ConsoleLogRecord = {
    args: args.map((arg) => serializeLogValue(arg)),
    elapsedMs: elapsedMs(),
    id: nextRecordId,
    level,
    source,
    timestamp: nowIso(),
  };
  records.push(record);
  nextRecordId += 1;
  if (records.length > MAX_LOG_RECORDS) records.splice(0, records.length - MAX_LOG_RECORDS);
  for (const listener of recordListeners) listener(record);
};

const installConsoleHooks = () => {
  if (typeof console === "undefined") return;
  const writableConsole = console as unknown as Record<ConsoleLogLevel, (...args: unknown[]) => void>;
  for (const method of CONSOLE_LOG_METHODS) {
    const original = writableConsole[method];
    if (typeof original !== "function" || originalConsole.has(method)) continue;
    originalConsole.set(method, original.bind(console));
    writableConsole[method] = (...args: unknown[]) => {
      captureRecord(method, "console", args);
      originalConsole.get(method)?.(...args);
    };
  }
};

const getConsoleForInternalLog = (level: ConsoleLogLevel) =>
  originalConsole.get(level) || console[level] || console.log;

const getReportApp = (): ConsoleLogReport["app"] => ({
  branch: typeof __GIT_BRANCH__ === "undefined" ? undefined : __GIT_BRANCH__,
  // Which origin the report came from; a nightly bug reads very differently from a prod one.
  channel: typeof __APP_CHANNEL__ === "undefined" ? undefined : __APP_CHANNEL__,
  commit: typeof __COMMIT_HASH__ === "undefined" ? undefined : __COMMIT_HASH__,
  dirty: typeof __DIRTY_HASH__ === "undefined" ? undefined : __DIRTY_HASH__,
  version: typeof __APP_VERSION__ === "undefined" ? undefined : __APP_VERSION__,
});

const getReportPage = (): ConsoleLogReport["page"] => ({
  href: typeof location === "undefined" ? "" : location.href,
  referrer: typeof document === "undefined" ? "" : document.referrer,
  title: typeof document === "undefined" ? "" : document.title,
});

const getReportRuntime = (): ConsoleLogReport["runtime"] => ({
  atomicsWaitAsync: typeof Atomics === "undefined" ? "undefined" : typeof Atomics.waitAsync,
  crossOriginIsolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
  isSecureContext: typeof isSecureContext === "boolean" ? isSecureContext : false,
  language: typeof navigator === "undefined" ? "" : navigator.language,
  logCount: records.length,
  platform: typeof navigator === "undefined" ? "" : navigator.platform,
  sharedArrayBuffer: typeof SharedArrayBuffer,
  userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
  viewport: {
    devicePixelRatio: typeof devicePixelRatio === "number" ? devicePixelRatio : 1,
    height: typeof innerHeight === "number" ? innerHeight : 0,
    width: typeof innerWidth === "number" ? innerWidth : 0,
  },
});

const getReport = (): ConsoleLogReport => ({
  app: getReportApp(),
  logs: records.slice(),
  page: getReportPage(),
  runtime: getReportRuntime(),
});

const getReportMetadata = (): ConsoleLogReportMetadata => {
  const { logs: _logs, ...metadata } = getReport();
  return metadata;
};

const formatConsoleLogsJsonLines = (): string => {
  const metadata = getReportMetadata();
  return [
    JSON.stringify({ ...metadata, type: "meta" }),
    ...records.map((record) => JSON.stringify({ ...record, type: "log" })),
  ].join("\n");
};

const writeClipboardText = async (text: string) => {
  let clipboardError: unknown = null;
  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }
  if (typeof document === "undefined" || !document.body) {
    throw clipboardError || new Error("Clipboard API is unavailable");
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  textarea.remove();
  if (!copied) throw clipboardError || new Error("Clipboard write failed");
};

const copyConsoleLogs = async (): Promise<string> => {
  const text = formatConsoleLogsJsonLines();
  await writeClipboardText(text);
  getConsoleForInternalLog("info").call(console, "Console logs copied");
  return text;
};

const installGlobalErrorHooks = () => {
  window.addEventListener("error", (event) => {
    captureRecord("error", "window.error", [
      event.message,
      {
        colno: event.colno,
        error: event.error,
        filename: event.filename,
        lineno: event.lineno,
      },
    ]);
  });
  window.addEventListener("unhandledrejection", (event) => {
    captureRecord("error", "unhandledrejection", [event.reason]);
  });
};

installConsoleHooks();
installGlobalErrorHooks();

window.ROM_WEAVER_CONSOLE_LOGS = {
  clear: () => {
    records.length = 0;
  },
  copy: copyConsoleLogs,
  formatJsonLines: formatConsoleLogsJsonLines,
  getReport,
  size: () => records.length,
};

export type { ConsoleLogRecord };
export { subscribeConsoleLogRecords };
