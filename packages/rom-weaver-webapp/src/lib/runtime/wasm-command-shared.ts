import { waitForBrowserOpfsBootCleanup } from "../../storage/browser/browser-opfs-cleanup.ts";
import {
  formatBrowserStorageEstimateState,
  getBrowserStorageEstimateState,
} from "../../storage/browser/browser-storage-estimate.ts";
import type { PatchBasisMode } from "../../wasm/index.ts";
import {
  getRomWeaverFailureCode,
  getRomWeaverFailureMessage,
  withRomWeaverFailure,
} from "../../workers/rom-weaver/runner-errors.ts";
import type { runRomWeaverJson as runRomWeaverJsonType } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { toSimpleProgress } from "./run-result-parsing.ts";
import type { RomWeaverRunJsonResult } from "./run-result-parsing.ts";

type RunRomWeaverJson = typeof runRomWeaverJsonType;
let runnerModulePromise: Promise<typeof import("../../workers/rom-weaver/rom-weaver-runner.ts")> | undefined;
const loadRomWeaverRunner = () => (runnerModulePromise ??= import("../../workers/rom-weaver/rom-weaver-runner.ts"));
// Every command may create or read scratch under /work/{weave-parse,input,operations,...}, the exact
// directories the page-boot sweep deletes. A command that starts before the sweep finishes would have its
// fresh scratch deleted underneath it (e.g. "OPFS prefix file not found: /work/weave-parse/<id>/...").
const runRomWeaverJson = async (...args: Parameters<RunRomWeaverJson>): ReturnType<RunRomWeaverJson> => {
  await waitForBrowserOpfsBootCleanup();
  return (await loadRomWeaverRunner()).runRomWeaverJson(...args);
};

const relaySimpleProgress =
  (onProgress?: (progress: NonNullable<ReturnType<typeof toSimpleProgress>>) => void) =>
  (event: Parameters<typeof toSimpleProgress>[0]) => {
    const progress = toSimpleProgress(event);
    if (progress) onProgress?.(progress);
  };

// The engine codes a write that ran out of storage as `io.storage_full`; add the browser storage estimate.
const appendBrowserStorageContext = async (result: RomWeaverRunJsonResult, fallbackMessage: string) => {
  const message = getRomWeaverFailureMessage(result, fallbackMessage);
  if (getRomWeaverFailureCode(result) !== "io.storage_full") return message;
  const state = await getBrowserStorageEstimateState();
  return `${message} [storage: ${formatBrowserStorageEstimateState(state)}]`;
};

const throwRomWeaverFailureWithBrowserOutputContext = async (
  result: RomWeaverRunJsonResult,
  fallbackMessage: string,
  operationLabel: string,
): Promise<never> => {
  const error = withRomWeaverFailure(new Error(getRomWeaverFailureMessage(result, fallbackMessage)), result);
  if (getRomWeaverFailureCode(result) === "io.storage_full")
    Object.assign(error, { details: { ...(error as { details?: object }).details, operationLabel } });
  throw error;
};

const normalizeN64ByteOrder = (
  value: unknown,
): "auto" | "keep" | "big-endian" | "little-endian" | "byte-swapped" | undefined => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "auto" ||
    normalized === "keep" ||
    normalized === "big-endian" ||
    normalized === "little-endian" ||
    normalized === "byte-swapped"
    ? normalized
    : undefined;
};

/** Trimmed, non-empty strings from an unknown list; anything else drops out. */
const toTrimmedList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : []).map((entry) => String(entry || "").trim()).filter(Boolean);

const normalizePatchBasisMode = (mode: unknown): PatchBasisMode | undefined =>
  mode === "auto" || mode === "base" || mode === "previous" ? mode : undefined;

type RomWeaverJsonResult = Awaited<ReturnType<typeof runRomWeaverJson>>;

export {
  runRomWeaverJson,
  relaySimpleProgress,
  appendBrowserStorageContext,
  throwRomWeaverFailureWithBrowserOutputContext,
  normalizeN64ByteOrder,
  toTrimmedList,
  normalizePatchBasisMode,
};
export type { RomWeaverJsonResult };
