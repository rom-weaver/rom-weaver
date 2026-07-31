import type { RomWeaverRunJsonEvent, RomWeaverRunJsonResult as BaseRomWeaverRunJsonResult } from "../../wasm/index.ts";
import {
  getRomWeaverRunEventErrorKind,
  getRomWeaverRunEventLabel,
  isRomWeaverFailedRunEvent,
} from "./rom-weaver-run-events.ts";

type RomWeaverRunJsonResult = BaseRomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

const getRecordErrorMessage = (record: { message?: unknown; kind?: unknown }) =>
  typeof record.message === "string" && record.message.trim()
    ? record.message.trim()
    : typeof record.kind === "string" && record.kind.trim()
      ? `rom-weaver error (${record.kind.trim()})`
      : "";

const getErrorContextSuffix = (context: unknown) => {
  if (!(context && typeof context === "object")) return "";
  const record = context as { command?: unknown; stage?: unknown };
  const command = typeof record.command === "string" ? record.command.trim() : "";
  const stage = typeof record.stage === "string" ? record.stage.trim() : "";
  if (!(command || stage)) return "";
  return ` (${[command ? `command=${command}` : "", stage ? `stage=${stage}` : ""].filter(Boolean).join(", ")})`;
};

const getErrorMessage = (value: unknown) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return String(value.message || "").trim();
  if (typeof value === "object") {
    const record = value as { message?: unknown; kind?: unknown; context?: unknown };
    const message = getRecordErrorMessage(record);
    if (!message) return "";
    return `${message}${getErrorContextSuffix(record.context)}`;
  }
  return "";
};

const TRACE_STDERR_LINE_REGEX = /^\d{4}-\d{2}-\d{2}T\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+[\w:]+:/;

const getNonTraceStderr = (result: Partial<RomWeaverRunJsonResult> | null | undefined) => {
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (!stderr) return "";
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !TRACE_STDERR_LINE_REGEX.test(line));
  return lines.join("\n").trim();
};

const getRomWeaverFailureMessage = (
  result: Partial<RomWeaverRunJsonResult> | null | undefined,
  fallback = "rom-weaver operation failed",
) => {
  const events = Array.isArray(result?.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!(event && isRomWeaverFailedRunEvent(event))) continue;
    const label = getRomWeaverRunEventLabel(event).trim();
    if (label) return label;
  }

  const nonJsonLines = Array.isArray(result?.nonJsonLines) ? result.nonJsonLines : [];
  for (let index = nonJsonLines.length - 1; index >= 0; index -= 1) {
    const line = String(nonJsonLines[index] || "").trim();
    if (line) return line;
  }

  const errorMessage = getErrorMessage((result as { error?: unknown } | null | undefined)?.error);
  if (errorMessage) return errorMessage;

  const stderr = getNonTraceStderr(result);
  if (stderr) return stderr;

  return fallback;
};

type RomWeaverFailureKind = NonNullable<ReturnType<typeof getRomWeaverRunEventErrorKind>>;

const getRomWeaverFailureKind = (
  result: Partial<RomWeaverRunJsonResult> | null | undefined,
): RomWeaverFailureKind | undefined => {
  const events = Array.isArray(result?.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!(event && isRomWeaverFailedRunEvent(event))) continue;
    const kind = getRomWeaverRunEventErrorKind(event);
    if (kind) return kind;
  }
  return undefined;
};

const withRomWeaverFailureKind = <E extends Error>(
  error: E,
  result: Partial<RomWeaverRunJsonResult> | null | undefined,
): E => {
  const kind = getRomWeaverFailureKind(result);
  if (kind) (error as E & { kind?: RomWeaverFailureKind }).kind = kind;
  return error;
};

export { getRomWeaverFailureMessage, withRomWeaverFailureKind };
