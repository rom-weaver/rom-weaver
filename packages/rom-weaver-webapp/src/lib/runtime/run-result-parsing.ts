import type { ChecksumMap, ChecksumVariant, ExtractTiming, RomTypeTag } from "../../types/checksum.ts";
import type { CompressionProbeResult } from "../../types/workflow-runtime-types.ts";
import type { ExtractedFileEntry } from "@rom-weaver/wasm/generated/rom-weaver-rust-types";
import type { RomWeaverRunJsonResult as BaseRomWeaverRunJsonResult, RomWeaverRunJsonEvent } from "@rom-weaver/wasm";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventEffectiveThreads,
  getRomWeaverRunEventElapsedMs,
  getRomWeaverRunEventLabel,
  getRomWeaverRunEventPercent,
  isRomWeaverLiveRunEvent,
  isRomWeaverTerminalRunEvent,
} from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getRomWeaverFailureMessage, withRomWeaverFailureKind } from "../../workers/rom-weaver/rom-weaver-runner.ts";
import { getPathBaseName } from "../path-utils.ts";
import { markWasmFirstProgress } from "../perf/op-perf-marks.ts";

type RomWeaverRunJsonResult = BaseRomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

/** Keeps parsed field reads tied to generated Rust keys while leaving runtime values untrusted. */
type WireRecord<T> = { [K in keyof T]?: unknown };

type SimpleRuntimeProgress = {
  details?: RuntimeValue;
  elapsed_ms?: number | null;
  label?: string;
  message?: string;
  percent?: number | null;
  stage?: string;
};

const clampPercent = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
};

const isLiveProgressEvent = (event: RomWeaverRunJsonEvent): boolean => {
  return isRomWeaverLiveRunEvent(event);
};

const getLastEvent = (result: RomWeaverRunJsonResult): RomWeaverRunJsonEvent | null => {
  const events = Array.isArray(result.events) ? result.events : [];
  if (!events.length) return null;
  const last = events.at(-1);
  return last || null;
};

const getTerminalEvent = (result: RomWeaverRunJsonResult): RomWeaverRunJsonEvent | null => {
  const events = Array.isArray(result.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isRomWeaverTerminalRunEvent(event)) return event;
  }
  return getLastEvent(result);
};

const createRuntimeTiming = (elapsedMs: unknown) => {
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return undefined;
  const normalizedMs = Math.round(elapsedMs);
  return {
    elapsedMs: normalizedMs,
    elapsedSeconds: normalizedMs / 1000,
  };
};

const getRunResultTiming = (result: RomWeaverRunJsonResult) => {
  const terminal = getTerminalEvent(result);
  return terminal ? createRuntimeTiming(getRomWeaverRunEventElapsedMs(terminal)) : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const getEmittedFileDetails = (
  result: RomWeaverRunJsonResult,
): { fileName?: string; path?: string; sizeBytes?: number } | null => {
  const emittedFiles = getEmittedFiles(result);
  if (!emittedFiles.length) return null;
  const first = emittedFiles[0] || null;
  if (!first) return null;
  return {
    fileName: first.fileName,
    path: first.path,
    sizeBytes: first.sizeBytes,
  };
};

type RomWeaverEmittedFile = {
  checksums?: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  /** Disc image format (e.g. "CD" | "GD-ROM" | "DVD"); see Rust `emitted_files[].disc_format`. */
  discFormat?: string;
  /** Elapsed time (ms) of the extract step that produced this file; see Rust `extract_time_ms`. */
  extractTimeMs?: number;
  /** Decode/checksum/overlap split for this file; see Rust `emitted_files[].timing`. */
  extractTiming?: ExtractTiming;
  fileName: string;
  kind?: string;
  path: string;
  /** ROM platform label (e.g. "Sony PlayStation"); see Rust `emitted_files[].platform`. */
  platform?: string;
  sizeBytes?: number;
  /** Disc structure (see Rust `attach_disc_group_details`): the cue/gdi sheet text, the shared
   * disc group id, and a track's 1-based number - so the host groups + renders a disc without
   * parsing the sheet itself. */
  cueText?: string;
  gdiText?: string;
  discGroupId?: string;
  trackNumber?: number;
};

const normalizeExtractTiming = (value: unknown): ExtractTiming | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const num = (input: unknown): number | undefined =>
    typeof input === "number" && Number.isFinite(input) ? input : undefined;
  const timing: ExtractTiming = {
    checksumMs: num(record.checksum_ms),
    decodeMs: num(record.decode_ms),
    opfsWriteMs: num(record.opfs_write_ms),
    overlapMs: num(record.overlap_ms),
    threaded: typeof record.threaded === "boolean" ? record.threaded : undefined,
    totalMs: num(record.total_ms),
    workers: num(record.workers),
  };
  return Object.values(timing).some((entry) => entry !== undefined) ? timing : undefined;
};

const normalizeEmittedFileChecksums = (value: unknown): Record<string, string> | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checksums: Record<string, string> = {};
  for (const [algorithm, checksum] of Object.entries(record)) {
    const key = algorithm.trim().toLowerCase();
    const normalized = typeof checksum === "string" ? checksum.trim().toLowerCase() : "";
    if (key && normalized) checksums[key] = normalized;
  }
  return Object.keys(checksums).length ? checksums : undefined;
};

const readChecksumMap = (value: unknown): ChecksumMap | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const checksums: ChecksumMap = {};
  for (const [algorithm, checksum] of Object.entries(record)) {
    const normalizedAlgorithm = String(algorithm || "")
      .trim()
      .toLowerCase();
    const normalizedChecksum =
      typeof checksum === "string"
        ? checksum.trim().toLowerCase()
        : typeof checksum === "number" || typeof checksum === "bigint"
          ? checksum.toString(16).toLowerCase()
          : "";
    if (normalizedAlgorithm && /^[0-9a-f]+$/i.test(normalizedChecksum)) {
      checksums[normalizedAlgorithm] = normalizedChecksum;
    }
  }
  return Object.keys(checksums).length ? checksums : undefined;
};

const cloneRuntimeRecord = (value: unknown): Record<string, unknown> | undefined => {
  const record = asRecord(value);
  return record ? { ...record } : undefined;
};

const parseChecksumVariants = (details: unknown): ChecksumVariant[] | undefined => {
  const rows = asRecord(details)?.checksum_variants;
  if (!Array.isArray(rows)) return undefined;
  const variants: ChecksumVariant[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const checksums = readChecksumMap(record?.checksums);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!(record && id && checksums)) continue;
    variants.push({
      applyCompatibility: cloneRuntimeRecord(record.applyCompatibility),
      checksums,
      id,
      label: typeof record.label === "string" && record.label.trim() ? record.label.trim() : id,
      transforms: cloneRuntimeRecord(record.transforms),
    });
  }
  return variants.length ? variants : undefined;
};

const romTypeFromEmittedFile = (
  entry: { platform?: string; discFormat?: string; recommendedFormat?: string } | undefined,
): RomTypeTag | undefined => {
  const platform = entry?.platform?.trim() ? entry.platform.trim() : undefined;
  const discFormat = entry?.discFormat?.trim() ? entry.discFormat.trim() : undefined;
  const recommendedFormat = entry?.recommendedFormat?.trim() ? entry.recommendedFormat.trim() : undefined;
  if (!(platform || discFormat || recommendedFormat)) return undefined;
  return {
    ...(platform ? { platform } : {}),
    ...(discFormat ? { discFormat } : {}),
    ...(recommendedFormat ? { recommendedFormat } : {}),
  };
};

const getOptionalStringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
};

const getOptionalTrimmedStringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const getOptionalFiniteNumberField = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const parseEmittedFile = (value: unknown): RomWeaverEmittedFile | null => {
  const entry = asRecord(value);
  if (!entry) return null;
  const path = typeof entry.path === "string" ? entry.path : "";
  if (!path) return null;
  const fileName = getOptionalStringField(entry, "file_name") || getPathBaseName(path, "output.bin");
  return {
    checksums: normalizeEmittedFileChecksums(entry.checksums),
    checksumVariants: parseChecksumVariants(entry),
    cueText: getOptionalStringField(entry, "cue_text"),
    discFormat: getOptionalTrimmedStringField(entry, "disc_format"),
    discGroupId: getOptionalStringField(entry, "disc_group_id"),
    extractTimeMs: getOptionalFiniteNumberField(entry, "extract_time_ms"),
    extractTiming: normalizeExtractTiming(entry.timing),
    fileName,
    gdiText: getOptionalStringField(entry, "gdi_text"),
    kind: getOptionalStringField(entry, "kind"),
    path,
    platform: getOptionalTrimmedStringField(entry, "platform"),
    sizeBytes: getOptionalFiniteNumberField(entry, "size_bytes"),
    trackNumber: getOptionalFiniteNumberField(entry, "track_number"),
  };
};

const getEmittedFiles = (result: RomWeaverRunJsonResult): RomWeaverEmittedFile[] => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const emitted = Array.isArray(details?.emitted_files) ? details?.emitted_files : [];
  const output: RomWeaverEmittedFile[] = [];
  for (const value of emitted) {
    const parsed = parseEmittedFile(value);
    if (parsed) output.push(parsed);
  }
  return output;
};

const parseContainerEntry = (entry: unknown): CompressionProbeResult["entries"][number] | null => {
  if (typeof entry === "string") {
    const normalized = entry.trim();
    return normalized
      ? {
          fileName: normalized,
          filename: normalized,
          name: getPathBaseName(normalized, normalized),
        }
      : null;
  }
  const record = asRecord(entry);
  if (!record) return null;
  const typed = record as WireRecord<ExtractedFileEntry>;
  const fileName = String(typed.file_name || record.fileName || record.filename || record.name || "").trim();
  if (!fileName) return null;
  const sizeValue = typed.size_bytes ?? record.size;
  const size = typeof sizeValue === "number" && Number.isFinite(sizeValue) ? sizeValue : undefined;
  return {
    fileName,
    filename: fileName,
    name: getPathBaseName(fileName, fileName),
    size,
  };
};

const getContainerEntriesFromProbe = (result: RomWeaverRunJsonResult): CompressionProbeResult["entries"] => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const container = asRecord(details?.container);
  const entryRecords = Array.isArray(container?.entry_records) ? container.entry_records : [];
  const entries = entryRecords.length ? entryRecords : Array.isArray(container?.entries) ? container.entries : [];
  return entries.flatMap((entry) => {
    const parsed = parseContainerEntry(entry);
    return parsed ? [parsed] : [];
  });
};

// The Rust ProgressEvent carries effective_threads as a sibling of `details`.
// Fold it into the details object so the presentation layer can surface the
// thread count in the bottom-left of the progress indicator (as the prototype
// did) without threading a dedicated field through every runtime call site.
const withEffectiveThreads = (details: RuntimeValue, event: RomWeaverRunJsonEvent): RuntimeValue => {
  const effectiveThreads = getRomWeaverRunEventEffectiveThreads(event);
  if (typeof effectiveThreads !== "number" || !Number.isFinite(effectiveThreads) || effectiveThreads <= 0) {
    return details === null || details === undefined ? undefined : details;
  }
  const baseDetails = asRecord(details) || {};
  return { ...baseDetails, effective_threads: effectiveThreads } as RuntimeValue;
};

const toSimpleProgress = (event: RomWeaverRunJsonEvent): SimpleRuntimeProgress | null => {
  if (!isLiveProgressEvent(event)) return null;
  // First live progress event from wasm closes the perceived-latency lead-in (romweaver:before-start).
  markWasmFirstProgress();
  const label = getRomWeaverRunEventLabel(event);
  const details = withEffectiveThreads(getRomWeaverRunEventDetails(event) as RuntimeValue, event);
  return {
    details,
    elapsed_ms: getRomWeaverRunEventElapsedMs(event),
    label: label ? label : undefined,
    message: undefined,
    percent: clampPercent(getRomWeaverRunEventPercent(event)),
    stage: typeof event.stage === "string" && event.stage ? event.stage : undefined,
  };
};

const ensureRomWeaverSuccess = (result: RomWeaverRunJsonResult, fallbackMessage: string) => {
  if (result.ok && result.exitCode === 0) return;
  throw withRomWeaverFailureKind(new Error(getRomWeaverFailureMessage(result, fallbackMessage)), result);
};

export type { RomWeaverRunJsonResult, WireRecord };
export {
  asRecord,
  ensureRomWeaverSuccess,
  getContainerEntriesFromProbe,
  getEmittedFileDetails,
  getEmittedFiles,
  getLastEvent,
  getRunResultTiming,
  getTerminalEvent,
  parseChecksumVariants,
  romTypeFromEmittedFile,
  toSimpleProgress,
};
