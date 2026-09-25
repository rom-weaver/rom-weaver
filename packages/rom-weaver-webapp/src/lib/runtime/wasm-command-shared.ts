import { withBrowserOutputStorageFailureContext } from "../../storage/browser/browser-output-storage-guard.ts";
import {
  formatBrowserStorageEstimateState,
  getBrowserStorageEstimateState,
} from "../../storage/browser/browser-storage-estimate.ts";
import type { PatchBasisMode } from "../../wasm/index.ts";
import { getRomWeaverFailureMessage, withRomWeaverFailureKind } from "../../workers/rom-weaver/runner-errors.ts";
import type { runRomWeaverJson as runRomWeaverJsonType } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { toSimpleProgress } from "./run-result-parsing.ts";
import type { RomWeaverRunJsonResult } from "./run-result-parsing.ts";

type RunRomWeaverJson = typeof runRomWeaverJsonType;
let runnerModulePromise: Promise<typeof import("../../workers/rom-weaver/rom-weaver-runner.ts")> | undefined;
const loadRomWeaverRunner = () => (runnerModulePromise ??= import("../../workers/rom-weaver/rom-weaver-runner.ts"));
const runRomWeaverJson = async (...args: Parameters<RunRomWeaverJson>): ReturnType<RunRomWeaverJson> =>
  (await loadRomWeaverRunner()).runRomWeaverJson(...args);

const relaySimpleProgress =
  (onProgress?: (progress: NonNullable<ReturnType<typeof toSimpleProgress>>) => void) =>
  (event: Parameters<typeof toSimpleProgress>[0]) => {
    const progress = toSimpleProgress(event);
    if (progress) onProgress?.(progress);
  };

const appendBrowserStorageContext = async (message: string, operationLabel: string) => {
  const contextualized = await withBrowserOutputStorageFailureContext(new Error(message), { operationLabel });
  if (!(contextualized instanceof Error) || contextualized.name !== "OutputStorageError") return message;
  const state = await getBrowserStorageEstimateState();
  return `${message} [storage: ${formatBrowserStorageEstimateState(state)}]`;
};

const throwRomWeaverFailureWithBrowserOutputContext = async (
  result: RomWeaverRunJsonResult,
  fallbackMessage: string,
  operationLabel: string,
): Promise<never> => {
  const message = getRomWeaverFailureMessage(result, fallbackMessage);
  const contextualized = await withBrowserOutputStorageFailureContext(new Error(message), {
    operationLabel,
  });
  const error = contextualized instanceof Error ? contextualized : new Error(String(contextualized || message));
  throw withRomWeaverFailureKind(error, result);
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
