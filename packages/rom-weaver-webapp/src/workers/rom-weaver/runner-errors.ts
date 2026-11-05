import type { RomWeaverRunJsonEvent, RomWeaverRunJsonResult as BaseRomWeaverRunJsonResult } from "../../wasm/index.ts";
import { ROM_WEAVER_ERROR_CODES } from "../../wasm/generated/rom-weaver-format-metadata.ts";
import type { RomWeaverErrorKind } from "../../wasm/rom-weaver-types.d.ts";
import { isWorkflowErrorCode } from "../../lib/errors.ts";
import type { WorkflowErrorCode } from "../../types/errors.ts";
import { describeError } from "../shared/error-description.ts";
import {
  getRomWeaverRunEventErrorKind,
  getRomWeaverRunEventLabel,
  isRomWeaverFailedRunEvent,
} from "./rom-weaver-run-events.ts";

type RomWeaverRunJsonResult = BaseRomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

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

  const errorMessage = describeError((result as { error?: unknown } | null | undefined)?.error, { context: true });
  if (errorMessage) return errorMessage;

  const stderr = getNonTraceStderr(result);
  if (stderr) return stderr;

  return fallback;
};

type RomWeaverEngineErrorCode = keyof typeof ROM_WEAVER_ERROR_CODES;
type RomWeaverEngineErrorFields = NonNullable<RomWeaverRunJsonEvent["error_fields"]>;
type RomWeaverEngineError = Error & {
  code?: unknown;
  details?: Record<string, unknown>;
  kind?: RomWeaverErrorKind;
};

// Failures of these commands are archive or codec errors.
const ARCHIVE_COMMANDS: ReadonlySet<string> = new Set(["compress", "extract", "plan-extract-batch"]);

const isEngineErrorCode = (code: string): code is RomWeaverEngineErrorCode =>
  Object.hasOwn(ROM_WEAVER_ERROR_CODES, code);

const getFailedEvents = (result: Partial<RomWeaverRunJsonResult> | null | undefined): RomWeaverRunJsonEvent[] =>
  (Array.isArray(result?.events) ? result.events : [])
    .filter((event): event is RomWeaverRunJsonEvent => !!event && isRomWeaverFailedRunEvent(event))
    .reverse();

/** The stable engine code of a failed run, if the engine coded its failure. */
const getRomWeaverFailureCode = (result: Partial<RomWeaverRunJsonResult> | null | undefined): string | undefined =>
  getFailedEvents(result).find((event) => event.error_code)?.error_code ?? undefined;

/**
 * The workflow code of an engine failure: its stable code through the generated table, else its typed kind
 * or command. Never derived from the failure text.
 */
const getEngineWorkflowCode = (event: RomWeaverRunJsonEvent): WorkflowErrorCode => {
  const code = event.error_code;
  if (code && isEngineErrorCode(code)) return ROM_WEAVER_ERROR_CODES[code];
  const kind = getRomWeaverRunEventErrorKind(event);
  if (kind === "cancelled") return "CANCELLED";
  if (kind === "unknown_format") return "UNSUPPORTED_FORMAT";
  return ARCHIVE_COMMANDS.has(event.command) ? "COMPRESSION_FAILED" : "INVALID_INPUT";
};

/**
 * Attach the engine's classification of a failed run to `error`: the typed kind, a workflow `code` (unless an
 * earlier layer set one), and the stable engine code and fields under `details.engineCode`/`engineFields`.
 */
const withRomWeaverFailure = <E extends Error>(
  error: E,
  result: Partial<RomWeaverRunJsonResult> | null | undefined,
): E => {
  const events = getFailedEvents(result);
  const failure = events[0];
  if (!failure) return error;
  const coded = events.find((event) => event.error_code) ?? failure;
  const record = error as E & RomWeaverEngineError;
  const kind = events.map(getRomWeaverRunEventErrorKind).find(Boolean);
  if (kind) record.kind = kind;
  if (!isWorkflowErrorCode(record.code)) record.code = getEngineWorkflowCode(coded);
  if (coded.error_code) {
    const fields: RomWeaverEngineErrorFields = coded.error_fields ?? {};
    record.details = { ...record.details, engineCode: coded.error_code, engineFields: fields };
  }
  return error;
};

export { getRomWeaverFailureCode, getRomWeaverFailureMessage, withRomWeaverFailure };
export type { RomWeaverEngineErrorCode, RomWeaverEngineErrorFields };
