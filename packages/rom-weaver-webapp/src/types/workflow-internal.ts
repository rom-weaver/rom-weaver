import type { PatchFileInstance } from "../workers/protocol/patch-engine.ts";
import type { JsonValue } from "./runtime.ts";

type SharedProgressEventLike = {
  details?: JsonValue;
  label?: string;
  message?: string;
  percent?: string | number | null;
  stage?: string;
  loaded?: string | number | boolean | null;
  total?: string | number | boolean | null;
};

// Worker apply-result summary contract, produced by the runtime adapter and
// read by the apply workflow. Declared once here so both sides cannot drift.
type PatchApplySummary = {
  outputSize?: number;
  patches?: Array<{
    fileName: string;
    format: string;
    size?: number;
  }>;
  patchSize?: number;
  rom?: {
    fileName: string;
    size?: number;
  };
  timing?: {
    elapsedMs?: number;
    elapsedSeconds?: number;
  } | null;
};

export type { PatchApplySummary, PatchFileInstance, SharedProgressEventLike };
