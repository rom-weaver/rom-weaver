import { createTiming, formatTiming } from "../../lib/progress/timing.ts";

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
  isDismissibleWorkflowError,
  mergeSettingsWithOutput,
};
