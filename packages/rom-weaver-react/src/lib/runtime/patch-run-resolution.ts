import type {
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateFormatCandidates,
  RuntimePatchValidateWorkerInput,
} from "../../types/workflow-runtime-adapter.ts";
import type { ThreadBudget } from "../../wasm/index.ts";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventFormat,
} from "../../workers/rom-weaver/rom-weaver-run-events.ts";
import { getFileNameParts, getPathBaseName } from "../path-utils.ts";
import type { RomWeaverRunJsonResult } from "./run-result-parsing.ts";
import { asRecord, getTerminalEvent } from "./run-result-parsing.ts";

const XDELTA_PATCH_FILE_EXTENSION_REGEX = /\.(?:xdelta|delta|dat|vcdiff)$/i;
const BPS_PATCH_FILE_EXTENSION_REGEX = /\.bps$/i;
const PATCH_FORMAT_NORMALIZE_REGEX = /[^a-z0-9]+/g;

// Below this source size a patch apply/validate is forced onto the runner's
// no-pool, single-threaded path. In the browser the wasm engine reads the
// source on the main thread and applies serially for inputs under the in-memory
// apply cap, so a worker thread pool is never used — yet the runner otherwise
// pre-allocates and tears down a full pool command per run (measured at ~50 ms
// of pure setup/teardown for a tiny IPS). Gating well under the 256 MiB
// in-memory cap keeps this provably serial (and therefore byte-identical) for
// every format while covering all cartridge-sized ROMs and their patches.
const SMALL_PATCH_APPLY_FAST_PATH_LIMIT_BYTES = 64 * 1024 * 1024;

const normalizePatchFormat = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(PATCH_FORMAT_NORMALIZE_REGEX, "");
};

const isXdeltaPatchFormat = (value: unknown) => {
  const normalized = normalizePatchFormat(value);
  return normalized === "xdelta" || normalized === "vcdiff";
};

const isBpsPatchFormat = (value: unknown) => normalizePatchFormat(value) === "bps";

const isXdeltaPatchPath = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return XDELTA_PATCH_FILE_EXTENSION_REGEX.test(trimmed);
};

const isBpsPatchPath = (value: unknown) => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return BPS_PATCH_FILE_EXTENSION_REGEX.test(trimmed);
};

const resolvePatchApplyThreadArg = (
  requestedThreadArg: ThreadBudget | null,
  patchFiles: Array<{ patchFileName?: string; patchFilePath?: string; patchFormat?: string }>,
  inputSize?: number,
) => {
  const hasXdeltaPatch = patchFiles.some((patch) => {
    return (
      isXdeltaPatchFormat(patch.patchFormat) ||
      isXdeltaPatchPath(patch.patchFilePath) ||
      isXdeltaPatchPath(patch.patchFileName)
    );
  });
  const hasBpsPatch = patchFiles.some((patch) => {
    return (
      isBpsPatchFormat(patch.patchFormat) || isBpsPatchPath(patch.patchFilePath) || isBpsPatchPath(patch.patchFileName)
    );
  });
  if (hasXdeltaPatch) {
    return {
      forcedSingleThread: requestedThreadArg !== 1,
      forceSingleThreadReason: "xdelta",
      hasBpsPatch,
      hasXdeltaPatch,
      singleThreadNoPool: false,
      threadArg: 1,
    };
  }
  if (hasBpsPatch) {
    return {
      forcedSingleThread: false,
      forceSingleThreadReason: "bps",
      hasBpsPatch,
      hasXdeltaPatch,
      singleThreadNoPool: false,
      threadArg: null,
    };
  }
  // Small non-bps/non-xdelta inputs apply serially in the browser regardless of
  // requested threads, so skip the runner's worker pool entirely (no threads arg
  // + defaultThreads:0 → zero-slot command, matching the bps path).
  const isSmallInput = typeof inputSize === "number" && inputSize <= SMALL_PATCH_APPLY_FAST_PATH_LIMIT_BYTES;
  if (isSmallInput) {
    return {
      forcedSingleThread: true,
      forceSingleThreadReason: "small-input",
      hasBpsPatch,
      hasXdeltaPatch,
      singleThreadNoPool: true,
      threadArg: null,
    };
  }
  return {
    forcedSingleThread: false,
    forceSingleThreadReason: "",
    hasBpsPatch,
    hasXdeltaPatch,
    singleThreadNoPool: false,
    threadArg: requestedThreadArg || null,
  };
};

type RomWeaverProbePatchDetails = {
  format: string | null;
  minimum_source_size: number | null;
  patch_crc32: number | null;
  record_count: number | null;
  source_crc32: number | null;
  source_size: number | null;
  source_window_count: number | null;
  target_crc32: number | null;
  target_size: number | null;
  target_window_count: number | null;
  window_checksum_count: number | null;
};

const toNullableInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
};

const toNullableUint32 = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value >>> 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  if (!normalized) return null;
  if (/^[0-9a-f]+$/i.test(normalized) && normalized.length <= 8) return Number.parseInt(normalized, 16) >>> 0;
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10) >>> 0;
  return null;
};

const toOptionalUint32Hex = (value: unknown): string | undefined => {
  const normalized = toNullableUint32(value);
  return normalized === null ? undefined : normalized.toString(16).padStart(8, "0");
};

const toOptionalChecksumHex = (value: unknown): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return (value >>> 0).toString(16).padStart(8, "0");
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/^0x/, "");
  return normalized && /^[0-9a-f]+$/i.test(normalized) ? normalized : undefined;
};

const toOptionalInt = (value: unknown): number | undefined => {
  const normalized = toNullableInt(value);
  return normalized === null ? undefined : normalized;
};

const getPatchDetailsFromProbe = (result: RomWeaverRunJsonResult): RomWeaverProbePatchDetails => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const patch = asRecord(details?.patch);
  const formatValue = patch?.format ?? patch?.patch_format ?? details?.format;
  return {
    format: typeof formatValue === "string" && formatValue.trim() ? formatValue.trim() : null,
    minimum_source_size: toNullableInt(patch?.minimum_source_size ?? patch?.minimumSourceSize),
    patch_crc32: toNullableUint32(patch?.patch_crc32 ?? patch?.patchCrc32),
    record_count: toNullableInt(patch?.record_count ?? patch?.recordCount),
    source_crc32: toNullableUint32(patch?.source_crc32 ?? patch?.sourceCrc32),
    source_size: toNullableInt(patch?.source_size ?? patch?.sourceSize),
    source_window_count: toNullableInt(patch?.source_window_count ?? patch?.sourceWindowCount),
    target_crc32: toNullableUint32(patch?.target_crc32 ?? patch?.targetCrc32),
    target_size: toNullableInt(patch?.target_size ?? patch?.targetSize),
    target_window_count: toNullableInt(patch?.target_window_count ?? patch?.targetWindowCount),
    window_checksum_count: toNullableInt(patch?.window_checksum_count ?? patch?.windowChecksumCount),
  };
};

const normalizePatchValidationChecksumEntries = (value: unknown): string[] => {
  const entries: string[] = [];
  const push = (algorithm: string, checksum: unknown) => {
    const normalizedAlgorithm = String(algorithm || "")
      .trim()
      .toLowerCase();
    const normalizedChecksum = toOptionalChecksumHex(checksum);
    if (normalizedAlgorithm && normalizedChecksum) entries.push(`${normalizedAlgorithm}=${normalizedChecksum}`);
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim()) entries.push(entry.trim());
      else {
        const record = asRecord(entry);
        if (record) {
          for (const [algorithm, checksum] of Object.entries(record)) push(algorithm, checksum);
        }
      }
    }
    return entries;
  }
  const record = asRecord(value);
  if (!record) return entries;
  for (const [algorithm, checksum] of Object.entries(record)) push(algorithm, checksum);
  return entries;
};

const getPatchValidationRequirements = (options: RuntimePatchValidateWorkerInput["options"]) => {
  const optionRecord = asRecord(options);
  const requirementsValue = optionRecord?.validationRequirements;
  if (Array.isArray(requirementsValue)) return asRecord(requirementsValue[0]) || null;
  return asRecord(requirementsValue);
};

const getPatchApplyOutputFileName = (input: RuntimePatchApplyWorkerInput) => {
  const options = input.options || {};
  const outputName = typeof options.outputName === "string" ? options.outputName.trim() : "";
  if (outputName) return getPathBaseName(outputName, "patched.bin");
  const { extension, stem } = getFileNameParts(input.romFileName || "input.bin");
  const outputExtension = typeof options.outputExtension === "string" ? options.outputExtension.trim() : "";
  const normalizedOutputExtension = outputExtension
    ? outputExtension.startsWith(".")
      ? outputExtension
      : `.${outputExtension}`
    : extension;
  const patchStem = input.patchFiles
    .map((patch) => getFileNameParts(patch.patchFileName || "patch.bin").stem)
    .filter((value) => !!value)
    .join("-");
  const suffix = options.appendOutputSuffix === false ? "" : patchStem ? `-${patchStem}` : "-patched";
  return `${stem}${suffix}${normalizedOutputExtension || ".bin"}`;
};

const readPatchCreateFormatCandidates = (result: RomWeaverRunJsonResult): RuntimePatchCreateFormatCandidates => {
  const terminal = getTerminalEvent(result);
  const details = asRecord(terminal ? getRomWeaverRunEventDetails(terminal) : null);
  const candidates = asRecord(details?.patch_create_format_candidates);
  const rawFormats = Array.isArray(candidates?.formats) ? candidates.formats : [];
  const formats = rawFormats
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter((value) => !!value);
  const defaultFormat =
    (typeof candidates?.default === "string" ? candidates.default.trim().toLowerCase() : "") ||
    (terminal
      ? String(getRomWeaverRunEventFormat(terminal) || "")
          .trim()
          .toLowerCase()
      : "") ||
    formats[0] ||
    "bps";
  const rawLimits = asRecord(candidates?.limits);
  const limits: Record<string, number> = {};
  if (rawLimits) {
    for (const [key, value] of Object.entries(rawLimits)) {
      if (typeof value === "number" && Number.isFinite(value)) limits[key] = value;
    }
  }
  return {
    defaultFormat,
    formats: formats.length ? formats : [defaultFormat],
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(asRecord(candidates?.source_values) ? { sourceValues: asRecord(candidates?.source_values) || undefined } : {}),
  };
};

export type { RomWeaverProbePatchDetails };
export {
  getPatchApplyOutputFileName,
  getPatchDetailsFromProbe,
  getPatchValidationRequirements,
  normalizePatchValidationChecksumEntries,
  readPatchCreateFormatCandidates,
  resolvePatchApplyThreadArg,
  toOptionalInt,
  toOptionalUint32Hex,
};
