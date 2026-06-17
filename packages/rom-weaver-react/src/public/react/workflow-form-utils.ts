import { getErrorCode } from "../../presentation/errors.ts";
import { createTiming, formatTiming } from "../../storage/shared/timing.ts";

type SettingsWithOutput = {
  output?: Record<string, unknown>;
};

// Workflow error codes that the user may dismiss from the form's message banner.
// `AMBIGUOUS_SELECTION` is sticky because it requires an explicit choice before the run can proceed.
const isDismissibleWorkflowError = (code: string) => code !== "AMBIGUOUS_SELECTION";

// Format an elapsed-millisecond duration for display, returning "" when no finite value is present.
// Shared by the apply and create patch forms (the trim form keeps its own `undefined`-returning variant).
const formatElapsedMs = (elapsedMs: number | undefined) =>
  typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? formatTiming(createTiming(elapsedMs)) : "";

// Like `formatElapsedMs`, but renders the "from extract" sentinel when the checksum timing is exactly 0
// (i.e. the checksum was reused from a prior extract rather than recomputed).
const formatChecksumTiming = (elapsedMs: number | undefined) =>
  elapsedMs === 0 ? "from extract" : formatElapsedMs(elapsedMs);

// Like `formatElapsedMs` but returns `undefined` (not "") when no finite value is present, for the
// trim form's optional `timing?` props where an empty string would render an empty chip.
const formatOptionalElapsedMs = (elapsedMs: number | undefined) =>
  typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? formatTiming(createTiming(elapsedMs)) : undefined;

// The status/warnings subset every workflow source state exposes (create, trim, apply). Lets the
// source-notice helpers below stay shared instead of being re-defined per form against each concrete
// source type.
type SourceNoticeState = {
  status?: string;
  warnings?: readonly { message?: string }[];
};

// True when a workflow source failed to prepare or carries warnings; drives the form's queue-blocked
// banner and the input card's invalid state.
const hasSourceQueueWarning = (source: SourceNoticeState | null | undefined) =>
  !!source && (source.status === "failed" || (source.warnings?.length ?? 0) > 0);

const getSourceNoticeMessage = (source: SourceNoticeState | null | undefined) => {
  if (!source) return "";
  const warningMessage = source.warnings
    ?.map((warning) => warning.message)
    .filter(Boolean)
    .join(" ");
  if (warningMessage) return warningMessage;
  if (source.status === "failed") return "Source preparation failed. Choose a different ROM.";
  return "";
};

const getSourceNoticeLevel = (source: SourceNoticeState | null | undefined) =>
  source?.status === "failed" ? "error" : "warn";

// True when an aborted run was cancelled by the user, so the form clears its banner silently.
const isUserRequestedCancellation = (error: unknown, signal: AbortSignal) =>
  signal.aborted && getErrorCode(error) === "CANCELLED";

const createReactWorkflowId = (prefix: string) =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const createSettingsDependencyKey = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "function" ? "[function]" : entry));

const mergeSettingsWithOutput = <TSettings extends SettingsWithOutput>(
  baseSettings: TSettings | undefined,
  overrideSettings: TSettings | undefined,
): TSettings => {
  const merged = { ...(baseSettings || {}), ...(overrideSettings || {}) } as TSettings;
  if (baseSettings?.output || overrideSettings?.output) {
    merged.output = {
      ...(baseSettings?.output || {}),
      ...(overrideSettings?.output || {}),
    };
  }
  return merged;
};

export {
  createReactWorkflowId,
  createSettingsDependencyKey,
  formatChecksumTiming,
  formatElapsedMs,
  formatOptionalElapsedMs,
  getSourceNoticeLevel,
  getSourceNoticeMessage,
  hasSourceQueueWarning,
  isDismissibleWorkflowError,
  isUserRequestedCancellation,
  mergeSettingsWithOutput,
};
