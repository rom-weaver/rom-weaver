import type { ExtractedFileEntry } from "../../wasm/index.ts";
import { RomWeaverError } from "../errors.ts";
import { getPatchFileCleanup, type PatchFileInstance } from "./binary-service.ts";
import {
  type ArchiveEntryLike,
  type CompressionEntryKindFilter,
  describeArchiveFileForTrace,
  extractArchiveEntry,
  filterNestedContainerEntries,
  findArchiveEntryByName,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  isCompressionEntryFileName,
  isCompressionFile,
  listCompressionEntries,
  normalizeSelectedEntryNames,
  traceArchivePreparation,
} from "./input-preparation-archive.ts";

// Cumulative per-descent counters checked against the configured archive limits. Threaded through the
// recursive preflight so total entry/candidate/byte counts and visited-archive identities accrue
// across nested levels.
type ArchiveLimitState = {
  depth?: number;
  seenCompressedFileIdentities?: Set<string>;
  totalCandidates?: number;
  totalEntries?: number;
  totalUncompressedBytes?: number;
};

const getCompressedArchiveVisitKey = (file: PatchFileInstance) =>
  [file.fileName || "", typeof file.filePath === "string" ? file.filePath : "", file.fileSize || 0].join("\u0000");

const markCompressedArchiveVisit = (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  state: ArchiveLimitState,
  message: string,
) => {
  let seen = state.seenCompressedFileIdentities;
  if (!seen) {
    seen = new Set();
    state.seenCompressedFileIdentities = seen;
  }
  const key = getCompressedArchiveVisitKey(file);
  if (!(key && seen.has(key))) {
    if (key) seen.add(key);
    return;
  }
  traceArchivePreparation(options, message, {
    file: describeArchiveFileForTrace(file),
    visitCount: seen.size,
  });
  throw new RomWeaverError("ARCHIVE_DEPTH_EXCEEDED", "Recursive input decompression stalled", {
    details: {
      depth: state.depth || 0,
      fileName: file.fileName,
    },
  });
};

const getConfiguredLimit = (value: unknown) => {
  const configured = Number(value);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : null;
};

const hasConfiguredArchiveLimits = (options: InputPreparationOptions) =>
  [
    options?.limits?.maxArchiveDepth,
    options?.limits?.maxCandidateEntries,
    options?.limits?.maxEntries,
    options?.limits?.maxSingleFileBytes,
    options?.limits?.maxTotalUncompressedBytes,
  ].some((value) => getConfiguredLimit(value) !== null);

const assertArchiveLimit = (
  code: string,
  message: string,
  actual: number,
  configured: unknown,
  details: Record<string, unknown> = {},
) => {
  const limit = getConfiguredLimit(configured);
  if (limit === null || actual <= limit) return;
  throw new RomWeaverError("INVALID_INPUT", message, {
    details: { ...details, actual, code, limit },
  });
};

const assertArchiveDepth = (options: InputPreparationOptions, depth: number) => {
  const maxArchiveDepth = getConfiguredLimit(options?.limits?.maxArchiveDepth);
  if (maxArchiveDepth === null || depth <= maxArchiveDepth) return;
  throw new RomWeaverError("ARCHIVE_DEPTH_EXCEEDED", "Archive nesting exceeds configured depth limit", {
    details: { depth, maxArchiveDepth },
  });
};

const trackArchiveEntries = (
  options: InputPreparationOptions,
  state: ArchiveLimitState,
  entries: ArchiveEntryLike[],
) => {
  state.totalEntries = (state.totalEntries || 0) + entries.length;
  assertArchiveLimit(
    "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
    "Archive entry count exceeds configured limit",
    state.totalEntries,
    options?.limits?.maxEntries,
  );
  const entryBytes = entries.reduce((total, entry) => total + (typeof entry.size === "number" ? entry.size : 0), 0);
  state.totalUncompressedBytes = (state.totalUncompressedBytes || 0) + entryBytes;
  assertArchiveLimit(
    "ARCHIVE_TOTAL_UNCOMPRESSED_LIMIT_EXCEEDED",
    "Archive total uncompressed size exceeds configured limit",
    state.totalUncompressedBytes,
    options?.limits?.maxTotalUncompressedBytes,
  );
};

const trackArchiveCandidates = (
  options: InputPreparationOptions,
  state: ArchiveLimitState,
  entries: ArchiveEntryLike[],
) => {
  state.totalCandidates = (state.totalCandidates || 0) + entries.length;
  assertArchiveLimit(
    "ARCHIVE_CANDIDATE_LIMIT_EXCEEDED",
    "Archive candidate count exceeds configured limit",
    state.totalCandidates,
    options?.limits?.maxCandidateEntries,
  );
};

const assertArchiveEntryFileSize = (
  options: InputPreparationOptions,
  entry: ArchiveEntryLike | undefined,
  entryName: string,
) => {
  assertArchiveLimit(
    "ARCHIVE_SINGLE_FILE_LIMIT_EXCEEDED",
    "Archive entry size exceeds configured limit",
    typeof entry?.size === "number" ? entry.size : 0,
    options?.limits?.maxSingleFileBytes,
    { entryName },
  );
};

const preflightArchiveLimitsForDescent = async (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
  kindFilter: CompressionEntryKindFilter,
  selectedEntryNames: readonly string[] = [],
  state: ArchiveLimitState = {},
): Promise<void> => {
  if (!hasConfiguredArchiveLimits(options)) return;
  const depth = state.depth || 0;
  assertArchiveDepth(options, depth);
  markCompressedArchiveVisit(file, options, state, "input.archive.limit-preflight.stall");
  const entries = await listCompressionEntries(file, options, runtime, kindFilter);
  trackArchiveEntries(options, state, entries);
  trackArchiveCandidates(options, state, entries);
  const selectedNames = normalizeSelectedEntryNames(selectedEntryNames);
  for (const selectedName of selectedNames) {
    assertArchiveEntryFileSize(options, findArchiveEntryByName(entries, selectedName), selectedName);
  }
  const selectedEntry = selectedNames[0] ? findArchiveEntryByName(entries, selectedNames[0] || "") : undefined;
  const nestedEntries = filterNestedContainerEntries(entries);
  const directEntries = entries.filter(
    (entry) => !nestedEntries.some((candidate) => candidate.filename === entry.filename),
  );
  const nestedEntry =
    selectedEntry && isCompressionEntryFileName(selectedEntry.filename)
      ? selectedEntry
      : !selectedEntry && directEntries.length === 0 && nestedEntries.length === 1
        ? nestedEntries[0]
        : undefined;
  if (!nestedEntry) return;
  assertArchiveEntryFileSize(options, nestedEntry, nestedEntry.filename);
  const extracted = await extractArchiveEntry(
    file,
    nestedEntry.filename,
    undefined,
    options,
    runtime,
    undefined,
    kindFilter,
  );
  try {
    if (!isCompressionFile(extracted)) return;
    await preflightArchiveLimitsForDescent(
      extracted,
      options,
      runtime,
      kindFilter,
      selectedEntry ? selectedNames.slice(1) : [],
      {
        ...state,
        depth: depth + 1,
      },
    );
  } finally {
    await Promise.resolve(getPatchFileCleanup(extracted)?.()).catch(() => undefined);
  }
};

// `outputs` are the per-level extract-step entries (Rust `ExtractedFileEntry`): `file_name` plus an
// optional `size_bytes` (ts-rs renders the `u64` as `bigint`, though the JSON value is a number).
const assertDescentOutputLimits = (
  options: InputPreparationOptions,
  depth: number,
  outputs: ExtractedFileEntry[],
  totalOutputBytes: number,
) => {
  assertArchiveDepth(options, depth);
  for (const output of outputs) {
    if (!output) continue;
    const rawSize = output.size_bytes;
    const numericSize = typeof rawSize === "bigint" ? Number(rawSize) : rawSize;
    const size = typeof numericSize === "number" && Number.isFinite(numericSize) ? numericSize : 0;
    const entryName = typeof output.file_name === "string" ? output.file_name : "";
    assertArchiveLimit(
      "ARCHIVE_SINGLE_FILE_LIMIT_EXCEEDED",
      "Archive entry size exceeds configured limit",
      size,
      options?.limits?.maxSingleFileBytes,
      { entryName },
    );
  }
  assertArchiveLimit(
    "ARCHIVE_TOTAL_UNCOMPRESSED_LIMIT_EXCEEDED",
    "Archive total uncompressed size exceeds configured limit",
    totalOutputBytes,
    options?.limits?.maxTotalUncompressedBytes,
  );
};

export { assertDescentOutputLimits, preflightArchiveLimitsForDescent };
