import type { LogLevel } from "../../types/logging.ts";
import type { WorkflowRuntimeLog } from "../../types/workflow-runtime-adapter.ts";
import type {
  RomWeaverRunJsonOptions as BaseRomWeaverRunJsonOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverRunJsonEvent,
} from "../../wasm/index.ts";
import { emitTraceLog } from "../logging.ts";

type RomWeaverRunJsonOptions = BaseRomWeaverRunJsonOptions<RomWeaverRunJsonEvent, RuntimeValue> &
  RomWeaverBrowserOpfsRunOptions & { signal?: AbortSignal };

const BROWSER_SYNC_ACCESS_MODES = new Set<RomWeaverBrowserSyncAccessMode>([
  "read-only",
  "readwrite",
  "readwrite-unsafe",
]);

const nowIso = () => new Date().toISOString();

const emitRuntimeLog = (
  onLog: ((log: WorkflowRuntimeLog) => void) | undefined,
  level: WorkflowRuntimeLog["level"],
  message: string,
  details?: Record<string, unknown>,
) => {
  onLog?.(
    details
      ? {
          details,
          level,
          message,
          namespace: "runtime:rom-weaver",
          timestamp: nowIso(),
        }
      : {
          level,
          message,
          namespace: "runtime:rom-weaver",
          timestamp: nowIso(),
        },
  );
};

const toBrowserSyncAccessMode = (value: unknown): RomWeaverBrowserSyncAccessMode | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim() as RomWeaverBrowserSyncAccessMode;
  return BROWSER_SYNC_ACCESS_MODES.has(normalized) ? normalized : undefined;
};

const isTraceEnabled = (logLevel: LogLevel | string | undefined) => String(logLevel || "").toLowerCase() === "trace";

const emitRuntimeTrace = (
  input: {
    logLevel?: LogLevel | string;
    onLog?: (log: WorkflowRuntimeLog) => void;
  },
  message: string,
  details?: Record<string, unknown>,
) => emitTraceLog({ logLevel: input.logLevel, namespace: "runtime:rom-weaver", onLog: input.onLog }, message, details);

const getTraceMessage = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.trim() : String(value || "").trim();
  } catch (_error) {
    return String(value || "").trim();
  }
};

const toRomWeaverOptions = (input: {
  defaultThreads?: number | null;
  interactiveSelectionEnabled?: boolean;
  invalidateMountCacheBeforeRun?: boolean;
  knownInputPaths?: string[];
  logLevel?: LogLevel | string;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onLog?: (log: WorkflowRuntimeLog) => void;
  signal?: AbortSignal;
  syncAccessMode?: string;
  virtualFiles?: RuntimeValue[];
  virtualOnlyMounts?: boolean;
}): RomWeaverRunJsonOptions => {
  const traceEnabled = isTraceEnabled(input.logLevel);
  const options: RomWeaverRunJsonOptions = {
    onEvent: input.onEvent,
    onTraceEvent: traceEnabled
      ? (event) => {
          const message = getTraceMessage(event);
          if (!message) return;
          emitRuntimeLog(input.onLog, "trace", message);
        }
      : undefined,
    onTraceNonJsonLine: (line) => {
      const message = String(line || "").trim();
      if (!message) return;
      // `[perf]` timing lines (command timings, file-io throughput) are always emitted by the runner
      // regardless of trace mode; surface them at info so they show at the default verbosity instead of
      // requiring the trace level. Everything else stays trace.
      emitRuntimeLog(input.onLog, message.startsWith("[perf]") ? "info" : "trace", message);
    },
    signal: input.signal,
  };
  if (traceEnabled) {
    options.env = {
      RUST_BACKTRACE: "full",
    };
    options.trace = true;
  }
  if (typeof input.defaultThreads === "number" && Number.isFinite(input.defaultThreads)) {
    options.defaultThreads = Math.floor(input.defaultThreads);
  }
  const syncAccessMode = toBrowserSyncAccessMode(input.syncAccessMode);
  if (syncAccessMode) options.syncAccessMode = syncAccessMode;
  if (input.invalidateMountCacheBeforeRun) options.invalidateMountCacheBeforeRun = true;
  if (Array.isArray(input.knownInputPaths)) {
    const knownInputPaths = input.knownInputPaths
      .map((pathValue) => String(pathValue || "").trim())
      .filter((pathValue) => !!pathValue);
    if (knownInputPaths.length) options.knownInputPaths = knownInputPaths;
  }
  if (Array.isArray(input.virtualFiles)) options.virtualFiles = input.virtualFiles;
  if (typeof input.virtualOnlyMounts === "boolean") options.virtualOnlyMounts = input.virtualOnlyMounts;
  if (typeof input.interactiveSelectionEnabled === "boolean")
    options.interactiveSelectionEnabled = input.interactiveSelectionEnabled;
  return options;
};

export { emitRuntimeTrace, isTraceEnabled, toRomWeaverOptions };
