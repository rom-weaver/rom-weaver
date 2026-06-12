import { DEFAULT_VFS_ROOT } from "../../storage/vfs/path.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { CandidateSelectionRequest, SelectionFileCandidate } from "../../types/selection.ts";
import type { SourceObject, SourceRef } from "../../types/source.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions, PublicOutput } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { createArchiveSourceBlob } from "../archive-utils.ts";
import { CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS } from "../compression/container-format-registry.ts";
import { RomWeaverError } from "../errors.ts";
import { getPathBaseName } from "../path-utils.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import {
  findArchiveEntryByFileName,
  isCueEntryFileName,
  isGdiEntryFileName,
  parseCueFileReferences,
} from "./archive.ts";
import type { PatchFileInstance } from "./binary-service.ts";
import {
  attachPatchFileCleanup,
  attachPatchFileSourceRef,
  createPatchFile,
  decodeUtf8,
  getPatchFileBlob,
  getPatchFileBytes,
  getPatchFileCleanup,
  getPatchFileExternalSource,
  getPatchFileHandle,
  isLazyExternalPatchFile,
  normalizeArchiveEntryBytes,
} from "./binary-service.ts";
import {
  attachInputPreparationMetrics,
  type InputAsset,
  type InputParentCompression,
  makeCueAsset,
  makeGdiAsset,
  makeInputId,
  makeRomAsset,
  makeTrackAsset,
} from "./input-assets.ts";
import { classifyPatcherInput } from "./input-classification.ts";
import {
  DEFAULT_INPUT_PREPARATION_RUNTIME,
  type InputPreparationRuntime,
  resolveInputPreparationRuntime,
} from "./input-preparation-compression.ts";
import { getBaseFileName, getDirectoryPath, normalizeArchiveEntryName } from "./path-utils.ts";
import { parseCueFile } from "./rom-specific-file-utils.ts";
import { applySidecarPatchOutputLabel, resolveSidecarPatchEntries } from "./sidecar-patch-resolution.ts";

type ArchiveEntryLike = {
  archiveEntryType?: string;
  fileName?: string;
  filename: string;
  size?: number;
};
type CueGroupSelectionMatch = {
  cueFileName: string;
  trackFileNames: string[];
};
type CompressionRomCueGroup = CueGroupSelectionMatch & {
  cueText?: string;
  missingReferences: string[];
  references?: Array<{
    fileName: string;
    patchable?: boolean;
  }>;
};
type CompressionRomProbe = {
  cueGroups: CompressionRomCueGroup[];
  directRomEntries: ArchiveEntryLike[];
  nestedCompressionEntries: ArchiveEntryLike[];
  referencedTrackNames: Set<string>;
  romEntries: ArchiveEntryLike[];
  standaloneEntries: ArchiveEntryLike[];
};
type InputPreparationOptions = ApplyWorkflowOptions | CreateWorkflowOptions | undefined;
type InputPreparationRuntimeLike = InputPreparationRuntime | Pick<WorkflowRuntime, "name">;
type ChdCodecMode = "cd" | "dvd";
type CompressionExtractOverrides = {
  checksumAlgorithms?: string[];
  chdSplitBin?: boolean;
  interactiveSelectionEnabled?: boolean;
};
type CompressionEntryKindFilter = {
  romFilter?: boolean;
  patchFilter?: boolean;
};
type ArchiveFileBackedSource = Blob | FileSystemFileHandle | string;
type ArchiveFileBackedPatchFile = PatchFileInstance & {
  _archiveFileBackedSource?: ArchiveFileBackedSource | null;
};
type ArchiveLimitState = {
  depth?: number;
  seenCompressedFileIdentities?: Set<string>;
  totalCandidates?: number;
  totalEntries?: number;
  totalUncompressedBytes?: number;
};
type ValidatedPatchArchiveEntryCache = Map<string, PatchFileInstance>;
const PATCH_MAGIC_BY_EXTENSION = {
  bps: "BPS1",
  ips: "PATCH",
  ups: "UPS1",
} as const;
const PATH_BACKED_COMPRESSION_FORMATS = new Set<string>(CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS);
const SYNC_READ_ARCHIVE_ENTRY_REGEX =
  /\.(?:cue|ips|ups|bps|aps|rup|ppf|ebp|bdf|bsp|bspatch|mod|xdelta|delta|dat|vcdiff)\d*$/i;
const CHD_MERGED_SELECTION_PREFIX = "rom-weaver:chd-merged:";
const CHD_SPLIT_SELECTION_PREFIX = "rom-weaver:chd-split:";
const validatedPatchArchiveEntriesByFile = new WeakMap<PatchFileInstance, ValidatedPatchArchiveEntryCache>();
const patchArchiveValidationCleanupAttached = new WeakSet<PatchFileInstance>();
// Each ambiguous patch selection extracts every branch ONCE; the resulting (materialized) leaf files
// are stashed against the emitted selection request so the controller can reuse the exact extracted
// file for whichever candidate(s) the user picks — no re-extraction (which would collide on OPFS
// paths) and correct addressing even for two sibling patches in one branch. Keyed by request, so the
// stash is GC'd once the controller drops the request (e.g. on re-stage or source removal).
type RegisteredPatchLeaf = { file: PatchFileInstance; parentCompressions: InputParentCompression[] };
const patchLeafFilesByRequest = new WeakMap<CandidateSelectionRequest, Map<string, RegisteredPatchLeaf>>();

const describeArchiveFileForTrace = (file: PatchFileInstance) => ({
  fileName: file.fileName || "input.bin",
  filePath: typeof file.filePath === "string" ? file.filePath : "",
  fileSize: typeof file.fileSize === "number" && Number.isFinite(file.fileSize) ? file.fileSize : 0,
  isLazyExternal: isLazyExternalPatchFile(file),
  romSpecificOutput: !!(file as { _romSpecificDecompressionOutput?: boolean })._romSpecificDecompressionOutput,
});

const traceArchivePreparation = (
  options: InputPreparationOptions,
  message: string,
  details: Record<string, unknown> = {},
) => {
  if (options?.logging?.level !== "trace") return;
  options.onLog?.({
    details: {
      ...details,
      operation: "input-archive",
    },
    level: "trace",
    message,
    namespace: "workflow:input-archive",
    timestamp: new Date().toISOString(),
  });
};

const summarizeEntryNames = (entries: ArchiveEntryLike[], maxCount = 8) =>
  entries.slice(0, maxCount).map((entry) => entry.filename);

const isCueGroupSelectionMatch = (group: CueGroupSelectionMatch, selectedEntryName: string) =>
  group.cueFileName === selectedEntryName ||
  group.trackFileNames.indexOf(selectedEntryName) !== -1 ||
  getBaseFileName(group.cueFileName).toLowerCase() === getBaseFileName(selectedEntryName).toLowerCase();

const isCompleteCueGroup = (group: Pick<CompressionRomCueGroup, "missingReferences" | "trackFileNames">) =>
  group.missingReferences.length === 0 &&
  group.trackFileNames.length > 0 &&
  group.trackFileNames.some((fileName) => !isCueEntryFileName(fileName));

const getSyntheticCueTrackEntries = (entries: ArchiveEntryLike[], cueFileName: string) =>
  entries.filter(
    (entry) =>
      entry.archiveEntryType === "track" &&
      !isCueEntryFileName(entry.filename) &&
      !isGdiEntryFileName(entry.filename) &&
      (!getDirectoryPath(cueFileName) || getDirectoryPath(entry.filename) === getDirectoryPath(cueFileName)),
  );

const isCompressionEntryFileName = (fileName: string) => classifyPatcherInput({ fileName }).kind === "compression";

const isBinEntryFileName = (fileName: string) => /\.bin$/i.test(getBaseFileName(fileName));

const parseChdSplitSelection = (
  entryName: string | undefined,
): { chdSplitBin?: boolean; selectedEntryName?: string } => {
  const value = String(entryName || "");
  if (value.startsWith(CHD_SPLIT_SELECTION_PREFIX)) {
    return { chdSplitBin: true };
  }
  if (value.startsWith(CHD_MERGED_SELECTION_PREFIX)) {
    return { chdSplitBin: false };
  }
  return { selectedEntryName: value || undefined };
};

// A CHD disc lists its sheet as a `.cue` (CD-ROM) or `.gdi` (GD-ROM); both mark a
// multi-track disc that should auto-resolve to whole-disc split-bin extraction
// instead of prompting per track.
const getChdDiscSheetEntryName = (entries: ArchiveEntryLike[]) =>
  entries.find((entry) => isCueEntryFileName(entry.filename) || isGdiEntryFileName(entry.filename))?.filename || "";

const getChdBinEntries = (entries: ArchiveEntryLike[]) => entries.filter((entry) => isBinEntryFileName(entry.filename));

const filterNestedContainerEntries = (entries: ArchiveEntryLike[]) =>
  entries.filter((entry) => typeof entry.filename === "string" && isCompressionEntryFileName(entry.filename));

const getChdCodecModeFromMediaKind = (mediaKind: unknown): ChdCodecMode | null => {
  const normalized = String(mediaKind || "")
    .trim()
    .toLowerCase();
  if (normalized === "cd" || normalized === "gd") return "cd";
  if (normalized === "dvd") return "dvd";
  return null;
};

const reportChdCodecMode = (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  chdMode: ChdCodecMode | null,
) => {
  if (!chdMode) return;
  reportProgress(options, {
    details: { chdMode },
    label: "Preparing CHD extraction...",
    percent: null,
    stage: "input",
  });
  traceArchivePreparation(options, "input.archive.chd-mode", {
    chdMode,
    file: describeArchiveFileForTrace(archiveFile),
  });
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

const getNamedArchiveBlobSource = (blob: Blob, fileName?: string | null): Blob => {
  const currentName = (blob as Blob & { name?: unknown }).name;
  if (typeof currentName === "string" && currentName.trim()) return blob;
  const resolvedFileName = fileName || "archive.bin";
  if (typeof File === "function") {
    return new File([blob], resolvedFileName, {
      lastModified:
        typeof (blob as Blob & { lastModified?: unknown }).lastModified === "number"
          ? (blob as Blob & { lastModified: number }).lastModified
          : undefined,
      type: blob.type || "application/octet-stream",
    });
  }
  return Object.assign(blob.slice(0, blob.size, blob.type || "application/octet-stream"), {
    name: resolvedFileName,
  });
};

const getArchiveFileBackedSource = (archiveFile: PatchFileInstance): ArchiveFileBackedSource => {
  const externalSource = getPatchFileExternalSource(archiveFile, archiveFile.fileName || "archive.bin");
  if (externalSource) {
    if (isVfsFileRef(externalSource.source)) return externalSource.source.path;
    return externalSource.source as ArchiveFileBackedSource;
  }
  if (typeof archiveFile.filePath === "string" && archiveFile.filePath.trim()) return archiveFile.filePath;
  const fileHandle = getPatchFileHandle(archiveFile);
  if (fileHandle) return fileHandle;
  const blob = getPatchFileBlob(archiveFile);
  if (blob) return getNamedArchiveBlobSource(blob, archiveFile.fileName);
  const cachedSource = (archiveFile as ArchiveFileBackedPatchFile)._archiveFileBackedSource;
  if (cachedSource) return cachedSource;
  const materializedSource = createArchiveSourceBlob(
    getPatchFileBytes(archiveFile),
    archiveFile.fileName || "archive.bin",
  );
  (archiveFile as ArchiveFileBackedPatchFile)._archiveFileBackedSource = materializedSource;
  return materializedSource;
};

const getCompressionFormat = (file: PatchFileInstance) => {
  const classification = classifyPatcherInput(file);
  if (classification.kind !== "compression") throw new Error(`${file.fileName || "Input"} is not a compression input`);
  return classification.compressionFormat;
};

const isCompressionFile = (file: PatchFileInstance) => classifyPatcherInput(file).kind === "compression";

const getZ3dsCompressedExtensionForExtractedFileName = (
  fileName: string | number | boolean | null | undefined,
): string | null => {
  const normalizedFileName = getBaseFileName(fileName).toLowerCase();
  if (/\.cia$/i.test(normalizedFileName)) return "zcia";
  if (/\.cci$/i.test(normalizedFileName)) return "zcci";
  if (/\.cxi$/i.test(normalizedFileName)) return "zcxi";
  if (/\.3dsx$/i.test(normalizedFileName)) return "z3dsx";
  if (/\.3ds$/i.test(normalizedFileName)) return "z3ds";
  return null;
};

const getZ3dsOutputPathFileName = (
  output: { fileName?: string; filePath?: string; path?: string },
  fallbackFileName: string,
): string => {
  const outputPathFileName = getBaseFileName(output.path || output.filePath || "");
  if (outputPathFileName && getZ3dsCompressedExtensionForExtractedFileName(outputPathFileName)) {
    return outputPathFileName;
  }
  return fallbackFileName;
};

const getCompressionRuntimeSource = (file: PatchFileInstance): SourceRef => {
  const source = getArchiveFileBackedSource(file);
  const sourceFileName = typeof source === "string" ? getBaseFileName(source) : "";
  const runtimeSource: SourceObject = {
    fileName: file.fileName || sourceFileName || "input.bin",
    source,
  };
  if (typeof file.fileSize === "number" && Number.isFinite(file.fileSize)) runtimeSource.size = file.fileSize;
  return runtimeSource;
};

const getCompressionRuntimeOptions = (
  options: InputPreparationOptions,
  overrides: CompressionExtractOverrides = {},
  kindFilter: CompressionEntryKindFilter = {},
) => ({
  ...(Array.isArray(overrides.checksumAlgorithms)
    ? { extractChecksumAlgorithms: [...overrides.checksumAlgorithms] }
    : {}),
  ...(typeof overrides.chdSplitBin === "boolean" ? { chdSplitBin: overrides.chdSplitBin } : {}),
  ...(typeof overrides.interactiveSelectionEnabled === "boolean"
    ? { interactiveSelectionEnabled: overrides.interactiveSelectionEnabled }
    : {}),
  ...(options?.limits ? { limits: options.limits } : {}),
  ...(kindFilter.romFilter ? { romFilter: true } : {}),
  ...(kindFilter.patchFilter ? { patchFilter: true } : {}),
  logLevel: options?.logging?.level,
  onLog: options?.onLog,
  onProgress: options?.onProgress,
  workerThreads: options?.workers?.threads,
});

// A multi-track CHD cue can be extracted as split bins; the split-bin affordance rides on the
// visible track rows (the cue itself is no longer shown as a row).
const isChdSplitBinCue = (archiveFile: PatchFileInstance, cueText: string): boolean =>
  getCompressionFormat(archiveFile) === "chd" && parseCueFile(cueText).tracks.length > 1;

const listCompressionEntries = async (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  kindFilter: CompressionEntryKindFilter = {},
  overrides: CompressionExtractOverrides = {},
) => {
  const result = await listCompressionEntryResult(file, options, runtime, kindFilter, overrides);
  return result.entries || [];
};

const listCompressionEntryResult = async (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  kindFilter: CompressionEntryKindFilter = {},
  overrides: CompressionExtractOverrides = {},
) => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.list) throw new Error("Compression listing is unavailable");
  const compressionFormat = getCompressionFormat(file);
  traceArchivePreparation(options, "input.archive.list.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(file),
    patchFilter: !!kindFilter.patchFilter,
    romFilter: !!kindFilter.romFilter,
    runtime: resolvedRuntime.name,
  });
  const result = await resolvedRuntime.compression.list({
    format: compressionFormat,
    options: getCompressionRuntimeOptions(options, overrides, kindFilter),
    source: getCompressionRuntimeSource(file),
  });
  const entries = result.entries || [];
  const chdMode = getChdCodecModeFromMediaKind(result.chdMediaKind);
  traceArchivePreparation(options, "input.archive.list.finish", {
    chdMode: chdMode || "",
    compressionFormat,
    entryCount: entries.length,
    entrySample: summarizeEntryNames(entries),
    file: describeArchiveFileForTrace(file),
    patchFilter: !!kindFilter.patchFilter,
    romFilter: !!kindFilter.romFilter,
    runtime: resolvedRuntime.name,
  });
  return { ...result, chdMode, entries };
};

const resolveChdSplitBinSelection = async ({
  archiveFile,
  compressionFormat,
  kindFilter,
  options,
  runtime,
  selectedEntryName,
}: {
  archiveFile: PatchFileInstance;
  compressionFormat: string;
  kindFilter: CompressionEntryKindFilter;
  options: InputPreparationOptions;
  runtime: InputPreparationRuntimeLike;
  selectedEntryName?: string;
}): Promise<{ selectedEntryName?: string; chdMode?: ChdCodecMode; chdSplitBin?: boolean }> => {
  const parsedSelection = parseChdSplitSelection(selectedEntryName);
  if (parsedSelection.chdSplitBin !== undefined) return { ...parsedSelection, chdMode: "cd" };
  if (parsedSelection.selectedEntryName) return parsedSelection;
  if (compressionFormat !== "chd" || !kindFilter.romFilter || typeof options?.onCandidatesFound !== "function") {
    return parsedSelection;
  }

  const mergedResult = await listCompressionEntryResult(archiveFile, options, runtime, kindFilter, {
    chdSplitBin: false,
  });
  const splitResult = await listCompressionEntryResult(archiveFile, options, runtime, kindFilter, {
    chdSplitBin: true,
  });
  const chdMode = mergedResult.chdMode || splitResult.chdMode;
  reportChdCodecMode(archiveFile, options, chdMode);
  const mergedEntries = mergedResult.entries;
  const splitEntries = splitResult.entries;
  const mergedBinEntries = getChdBinEntries(mergedEntries);
  const splitBinEntries = getChdBinEntries(splitEntries);
  const cueEntryName = getChdDiscSheetEntryName(mergedEntries) || getChdDiscSheetEntryName(splitEntries);
  if (!(cueEntryName && mergedBinEntries.length === 1 && splitBinEntries.length > 1))
    return { ...parsedSelection, ...(chdMode ? { chdMode } : {}) };

  // A multi-track CD/GD disc is one logical ROM. Default to per-track split bins
  // — so each track gets its own checksums and can be patch-targeted, matching
  // how loose bin+cue discs are handled — instead of prompting Merged vs Split.
  return { chdMode: chdMode || "cd", chdSplitBin: true };
};

const extractCompressionEntries = async (
  file: PatchFileInstance,
  entryNames: string[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  outputName?: string,
  checksumAlgorithms?: string[],
  kindFilter: CompressionEntryKindFilter = {},
) => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.extract) throw new Error("Compression extraction is unavailable");
  const compressionFormat = getCompressionFormat(file);
  traceArchivePreparation(options, "input.archive.extract.start", {
    compressionFormat,
    entries: entryNames,
    file: describeArchiveFileForTrace(file),
    outputName: outputName || "",
    patchFilter: !!kindFilter.patchFilter,
    romFilter: !!kindFilter.romFilter,
    runtime: resolvedRuntime.name,
  });
  const result = await resolvedRuntime.compression.extract({
    entries: entryNames,
    format: compressionFormat,
    options: getCompressionRuntimeOptions(options, { checksumAlgorithms }, kindFilter),
    outputName,
    source: getCompressionRuntimeSource(file),
  });
  const isPathBackedCompressionOutput = PATH_BACKED_COMPRESSION_FORMATS.has(compressionFormat);
  traceArchivePreparation(options, "input.archive.extract.finish", {
    compressionFormat,
    entryCount: entryNames.length,
    file: describeArchiveFileForTrace(file),
    outputCount: result.outputs.length,
    outputNames: result.outputs.map((output) => output.fileName || ""),
    patchFilter: !!kindFilter.patchFilter,
    pathBackedCompressionOutput: isPathBackedCompressionOutput,
    romFilter: !!kindFilter.romFilter,
    runtime: resolvedRuntime.name,
  });
  return Promise.all(
    result.outputs.map(async (output, index) => {
      const requestedEntryName = entryNames[index] || output.fileName || "output.bin";
      const selectedEntryFileName = getBaseFileName(requestedEntryName);
      const usePathBackedOutput = isPathBackedCompressionOutput && !isCueEntryFileName(selectedEntryFileName);
      const isRomSpecificExtractionOutput = isPathBackedCompressionOutput && !isCueEntryFileName(selectedEntryFileName);
      const shouldMaterializeForSyncRead = SYNC_READ_ARCHIVE_ENTRY_REGEX.test(selectedEntryFileName);
      const resolvedFileName = isPathBackedCompressionOutput
        ? compressionFormat === "z3ds"
          ? getZ3dsOutputPathFileName(output, selectedEntryFileName)
          : selectedEntryFileName
        : output.fileName || selectedEntryFileName;
      const binFile = await createPatchFileFromPublicOutput(output, resolvedFileName, {
        materializeBlob: shouldMaterializeForSyncRead,
        preferExternalFilePath: !shouldMaterializeForSyncRead,
      });
      binFile.fileName = resolvedFileName;
      const externalSource = getPatchFileExternalSource(binFile, resolvedFileName, { preferDirectBrowserSource: true });
      if (externalSource)
        attachPatchFileSourceRef(binFile, {
          ...externalSource,
          fileName: resolvedFileName,
          size:
            typeof binFile.fileSize === "number" && Number.isFinite(binFile.fileSize)
              ? binFile.fileSize
              : externalSource.size,
        });
      if (isRomSpecificExtractionOutput)
        (binFile as { _romSpecificDecompressionOutput?: boolean })._romSpecificDecompressionOutput = true;
      traceArchivePreparation(options, "input.archive.extract.output", {
        compressionFormat,
        output: describeArchiveFileForTrace(binFile),
        requestedEntryName,
        resolvedFileName,
        usePathBackedOutput,
      });
      (binFile as { _archiveEntryName?: string })._archiveEntryName = requestedEntryName;
      (binFile as { _archiveFileName?: string })._archiveFileName = file.fileName;
      return binFile;
    }),
  );
};

const extractArchiveEntryBytes = async (
  archiveFile: PatchFileInstance,
  entryName: string,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  checksumAlgorithms?: string[],
  kindFilter: CompressionEntryKindFilter = {},
) => {
  const [entryFile] = await extractCompressionEntries(
    archiveFile,
    [entryName],
    options,
    runtime,
    getBaseFileName(entryName),
    checksumAlgorithms,
    kindFilter,
  );
  if (!entryFile) throw new Error(`Archive entry data is not available: ${entryName}`);
  try {
    return normalizeArchiveEntryBytes(getPatchFileBytes(entryFile));
  } finally {
    await Promise.resolve(getPatchFileCleanup(entryFile)?.()).catch(() => undefined);
  }
};

const extractArchiveEntry = async (
  archiveFile: PatchFileInstance,
  entryName: string,
  fileName?: string,
  options: InputPreparationOptions = undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  checksumAlgorithms?: string[],
  kindFilter: CompressionEntryKindFilter = {},
): Promise<PatchFileInstance> => {
  const [entryFile] = await extractCompressionEntries(
    archiveFile,
    [entryName],
    options,
    runtime,
    fileName || getBaseFileName(entryName),
    checksumAlgorithms,
    kindFilter,
  );
  if (!entryFile) throw new Error(`Archive entry data is not available: ${entryName}`);
  entryFile.fileName = fileName || entryFile.fileName || getBaseFileName(entryName);
  (entryFile as { _archiveEntryName?: string })._archiveEntryName = entryName;
  (entryFile as { _archiveFileName?: string })._archiveFileName = archiveFile.fileName;
  return entryFile;
};

const normalizeSelectedEntryNames = (entryNames: readonly string[] | undefined): string[] =>
  (Array.isArray(entryNames) ? entryNames : [])
    .map((entryName) => String(entryName || "").trim())
    .filter((entryName) => !!entryName);

const findArchiveEntryByName = (entries: ArchiveEntryLike[], entryName: string) =>
  entries.find((entry) => entry.filename === entryName || getBaseFileName(entry.filename) === entryName);

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

const assertDescentOutputLimits = (
  options: InputPreparationOptions,
  depth: number,
  outputs: unknown[],
  totalOutputBytes: number,
) => {
  assertArchiveDepth(options, depth);
  for (const output of outputs) {
    if (!isRecord(output)) continue;
    const size = typeof output.size_bytes === "number" ? output.size_bytes : 0;
    const entryName =
      typeof output.path === "string"
        ? getBaseFileName(output.path)
        : typeof output.file_name === "string"
          ? output.file_name
          : "";
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

const getValidatedPatchArchiveEntryCache = (archiveFile: PatchFileInstance): ValidatedPatchArchiveEntryCache => {
  const existing = validatedPatchArchiveEntriesByFile.get(archiveFile);
  if (existing) return existing;
  const created = new Map<string, PatchFileInstance>();
  validatedPatchArchiveEntriesByFile.set(archiveFile, created);
  return created;
};

const releaseValidatedPatchArchiveEntries = async (archiveFile: PatchFileInstance) => {
  const cache = validatedPatchArchiveEntriesByFile.get(archiveFile);
  if (!cache?.size) {
    validatedPatchArchiveEntriesByFile.delete(archiveFile);
    return;
  }
  validatedPatchArchiveEntriesByFile.delete(archiveFile);
  await Promise.all(
    [...cache.values()].map((file) => Promise.resolve(getPatchFileCleanup(file)?.()).catch(() => undefined)),
  );
};

const ensureValidatedPatchArchiveEntryCleanup = (archiveFile: PatchFileInstance) => {
  if (patchArchiveValidationCleanupAttached.has(archiveFile)) return;
  patchArchiveValidationCleanupAttached.add(archiveFile);
  attachPatchFileCleanup(archiveFile, async () => {
    patchArchiveValidationCleanupAttached.delete(archiveFile);
    await releaseValidatedPatchArchiveEntries(archiveFile);
  });
};

const isValidPatchPatchFile = async (patchFile: PatchFileInstance): Promise<boolean> => {
  try {
    patchFile.littleEndian = false;
    patchFile.seek(0);
    const header = patchFile.readString(8);
    patchFile.seek(0);
    const extension = String(patchFile.fileName || "")
      .match(/\.([^.]+?)(?:\d+)?$/)?.[1]
      ?.toLowerCase();
    if (!extension) return false;
    const expectedMagic = PATCH_MAGIC_BY_EXTENSION[extension as keyof typeof PATCH_MAGIC_BY_EXTENSION];
    return expectedMagic ? header.startsWith(expectedMagic) : true;
  } catch (_error) {
    return false;
  }
};

const filterValidPatchArchiveEntriesForSource = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
) => {
  const listedPatchEntries = await listCompressionEntries(archiveFile, options, runtime, { patchFilter: true }).catch(
    () => [],
  );
  // Skip nested-container entries up front: extracting them only to discard them (they fail the
  // `isCompressionFile` check below) is a wasteful re-extraction of every nested archive level, and
  // patches inside nested archives are not auto-discovered anyway.
  const nestedContainerNames = new Set(filterNestedContainerEntries(listedPatchEntries).map((entry) => entry.filename));
  const patchEntries = listedPatchEntries.filter((entry) => !nestedContainerNames.has(entry.filename));
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  const validEntries: ArchiveEntryLike[] = [];
  for (const entry of patchEntries) {
    if (cache.has(entry.filename)) {
      validEntries.push(entry);
      continue;
    }
    const patchFile = await extractArchiveEntry(archiveFile, entry.filename, undefined, options, runtime, [], {
      patchFilter: true,
    }).catch(() => null);
    if (!patchFile) continue;
    try {
      if (isCompressionFile(patchFile)) continue;
      if (!(await isValidPatchPatchFile(patchFile))) continue;
      ensureValidatedPatchArchiveEntryCleanup(archiveFile);
      cache.set(entry.filename, patchFile);
      validEntries.push(entry);
    } finally {
      if (!cache.has(entry.filename)) await Promise.resolve(getPatchFileCleanup(patchFile)?.()).catch(() => undefined);
    }
  }
  return validEntries;
};

const probeCompressionRomEntriesForSource = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<CompressionRomProbe> => {
  const nestedCompressionEntries = filterNestedContainerEntries(entries);
  const directRomEntries = entries.filter(
    (entry) => !nestedCompressionEntries.some((candidate) => candidate.filename === entry.filename),
  );
  const romEntries = entries;
  const cueGroups: CompressionRomCueGroup[] = [];
  const referencedTrackNames = new Set<string>();
  for (const entry of romEntries) {
    const cueFileName = String(entry.filename || "");
    const sheetIsCue = isCueEntryFileName(cueFileName);
    const sheetIsGdi = isGdiEntryFileName(cueFileName);
    // A CHD CD/GD-ROM lists a `.cue`/`.gdi` sheet plus per-track `.bin`s; both
    // describe one disc, so group the tracks under the sheet (a GD-ROM `.gdi`
    // gets a synthetic disc group exactly like a `.cue`).
    if (!(sheetIsCue || sheetIsGdi)) continue;
    const syntheticTrackEntries =
      entry.archiveEntryType === "cue" || entry.archiveEntryType === "gdi"
        ? getSyntheticCueTrackEntries(entries, cueFileName)
        : [];
    if (syntheticTrackEntries.length) {
      const references = syntheticTrackEntries.map((trackEntry, index) => ({
        fileName: trackEntry.filename,
        mode: "MODE1/2048",
        patchable: true,
        trackNumber: index + 1,
        type: "BINARY",
      }));
      cueGroups.push({
        cueFileName,
        missingReferences: [],
        references,
        trackFileNames: syntheticTrackEntries.map((trackEntry) => {
          referencedTrackNames.add(trackEntry.filename);
          return trackEntry.filename;
        }),
      });
      continue;
    }
    // Only `.cue` text is read+parsed for references; a `.gdi` without synthetic
    // track entries is left for standalone handling rather than mis-parsed.
    if (!sheetIsCue) continue;
    try {
      const cueText = decodeUtf8(
        await extractArchiveEntryBytes(archiveFile, cueFileName, options, runtime, undefined, {
          romFilter: true,
        }),
      );
      const references = parseCueFileReferences(cueText);
      const trackFileNames: string[] = [];
      const missingReferences: string[] = [];
      for (const reference of references) {
        const trackEntry = findArchiveEntryByFileName(entries, cueFileName, reference.fileName) as
          | { filename: string }
          | undefined;
        if (!trackEntry) {
          missingReferences.push(reference.fileName);
          continue;
        }
        trackFileNames.push(trackEntry.filename);
        referencedTrackNames.add(trackEntry.filename);
      }
      cueGroups.push({
        cueFileName,
        cueText,
        missingReferences,
        references,
        trackFileNames,
      });
    } catch (_error) {
      cueGroups.push({
        cueFileName,
        missingReferences: ["Invalid or unreadable CUE"],
        trackFileNames: [],
      });
    }
  }
  // A single disc can ship both a `.cue` and a `.gdi` describing the same tracks
  // (e.g. a GD-ROM with a low-density CUE alongside its GDI). Each sheet builds its
  // own group above, so collapse sheets covering an identical track set into one
  // disc group — otherwise the disc reads as two competing candidates and prompts.
  const trackSetKey = (group: CompressionRomCueGroup) => JSON.stringify([...group.trackFileNames].sort());
  const dedupedCueGroups: CompressionRomCueGroup[] = [];
  const seenTrackSets = new Set<string>();
  for (const group of cueGroups) {
    const key = trackSetKey(group);
    if (key && seenTrackSets.has(key)) continue;
    if (key) seenTrackSets.add(key);
    dedupedCueGroups.push(group);
  }
  const standaloneEntries = romEntries.filter(
    (entry) =>
      !(
        isCueEntryFileName(entry.filename) ||
        isGdiEntryFileName(entry.filename) ||
        referencedTrackNames.has(entry.filename)
      ),
  );
  return {
    cueGroups: dedupedCueGroups,
    directRomEntries,
    nestedCompressionEntries,
    referencedTrackNames,
    romEntries,
    standaloneEntries,
  };
};

const resolveCompressionRomCueGroup = (
  cueGroups: CompressionRomCueGroup[],
  selectedEntryName: string,
): CompressionRomCueGroup | null =>
  cueGroups.find((group) => isCueGroupSelectionMatch(group, selectedEntryName)) || null;

const resolveCompressionRomAutoPickEntryName = (
  archiveFileName: string | undefined,
  probe: CompressionRomProbe,
  selectedEntryName: string,
): string | null => {
  const completeCueGroups = probe.cueGroups.filter((group) => isCompleteCueGroup(group));
  if (selectedEntryName) {
    const selectedGroup = resolveCompressionRomCueGroup(completeCueGroups, selectedEntryName);
    if (selectedGroup) return selectedGroup.cueFileName;
    const selectedEntry = probe.romEntries.find((entry) => entry.filename === selectedEntryName);
    return selectedEntry?.filename || selectedEntryName;
  }
  if (!probe.romEntries.length) return null;
  if (completeCueGroups.length === 1 && probe.standaloneEntries.length === 0)
    return completeCueGroups[0]?.cueFileName || null;
  if (completeCueGroups.length === 0 && probe.standaloneEntries.length === 1)
    return probe.standaloneEntries[0]?.filename || null;
  if (completeCueGroups.length === 0 && probe.romEntries.length === 1) return probe.romEntries[0]?.filename || null;
  throw new Error(`${archiveFileName || "Archive"} contains multiple input candidates`);
};

type PatchArchiveLeaf = {
  candidate: SelectionFileCandidate;
  file: PatchFileInstance;
  parentCompressions: InputParentCompression[];
};

const PATCH_LEAF_ROOT_SEGMENTS = DEFAULT_VFS_ROOT.split("/").filter(Boolean);

/** Compute a leaf's archive-nesting breadcrumbs by stripping the extraction root (`/work`): a direct
 * patch yields `[]`, a nested patch yields its chain of containing nested-archive directories (named
 * after each archive, e.g. `["B_disc1"]`, `["C_set", "C_sub"]`). Stripping the fixed root (rather
 * than the prefix shared across leaves) keeps the nesting visible even when every patch sits under
 * the same nested archive. */
const derivePatchLeafBreadcrumbs = (path: string): string[] => {
  const dirSegments = String(path || "")
    .split("/")
    .filter(Boolean)
    .slice(0, -1);
  let start = 0;
  while (start < PATCH_LEAF_ROOT_SEGMENTS.length && dirSegments[start] === PATCH_LEAF_ROOT_SEGMENTS[start]) {
    start += 1;
  }
  return dirSegments.slice(start);
};

/** Extract EVERY patch across all (nested) branches of a patch archive in one recursive descent with
 * interactive selection OFF, so an ambiguous multi-branch container fully unpacks instead of
 * prompting for a single branch. Each valid leaf patch is cached by its unique extracted path so the
 * re-entrant selection (and the multi-select fan-out) can reuse it without re-extracting — essential
 * because two sibling patches in one branch cannot be addressed by a primary-container `--select`. */
const enumeratePatchLeaves = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
  sourceIndex: number,
): Promise<PatchArchiveLeaf[]> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.extract) throw new Error("Compression extraction is unavailable");
  const compressionFormat = getCompressionFormat(archiveFile);
  await preflightArchiveLimitsForDescent(archiveFile, options, runtime, { patchFilter: true }, []);
  traceArchivePreparation(options, "input.archive.patch.enumerate.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(archiveFile),
  });
  const result = await resolvedRuntime.compression.extract({
    descendSinglePayload: true,
    entries: [],
    format: compressionFormat,
    options: getCompressionRuntimeOptions(options, { interactiveSelectionEnabled: false }, { patchFilter: true }),
    source: getCompressionRuntimeSource(archiveFile),
  });
  const outputs: PublicOutput[] = Array.isArray(result.outputs) ? result.outputs : result.output ? [result.output] : [];
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  const leaves: PatchArchiveLeaf[] = [];
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    if (!output) continue;
    const displayPath = String(output.path || "");
    const fileName = getBaseFileName(output.fileName || `patch-${index + 1}.bin`);
    let file = displayPath ? cache.get(displayPath) : undefined;
    if (!file) {
      file = await createPatchFileFromPublicOutput(output, fileName, { materializeBlob: true });
      file.fileName = fileName;
    }
    if (isCompressionFile(file) || !(await isValidPatchPatchFile(file))) {
      if (!(displayPath && cache.has(displayPath)))
        await Promise.resolve(getPatchFileCleanup(file)?.()).catch(() => undefined);
      continue;
    }
    if (displayPath) {
      ensureValidatedPatchArchiveEntryCleanup(archiveFile);
      cache.set(displayPath, file);
    }
    // Full archive-nesting path: the source archive, then each nested archive/folder it descends
    // through (the leaf file name is shown separately as the candidate's primary label).
    const breadcrumbs = [archiveFile.fileName || "archive", ...derivePatchLeafBreadcrumbs(displayPath)];
    // Surface the same chain as parentCompressions so a fanned-out patch keeps its "extract section"
    // (the archive › nested-archive path) in the patch stack row. The runtime only reports a single
    // extract elapsed time and the leaf size (not per-intermediate-archive sizes), so attach the
    // elapsed time to the root entry but leave parent sizes unset — synthesizing the whole-archive
    // size as a single leaf's parent would compute a nonsensical compression ratio (archive ÷ leaf).
    const extractElapsedMs =
      typeof output.timing?.elapsedMs === "number" && Number.isFinite(output.timing.elapsedMs)
        ? output.timing.elapsedMs
        : undefined;
    const parentCompressions: InputParentCompression[] = breadcrumbs.map((entryName, depth) => ({
      depth,
      fileName: entryName,
      kind: "archive",
      ...(depth === 0 && extractElapsedMs !== undefined ? { decompressionTimeMs: extractElapsedMs } : {}),
    }));
    leaves.push({
      candidate: {
        ...(breadcrumbs.length ? { breadcrumbs } : {}),
        fileName,
        id: makeInputId(sourceIndex, displayPath || fileName, normalizeArchiveEntryName),
        kind: "patch",
        path: displayPath || fileName,
        selectable: true,
        size: output.size,
        type: "file",
      },
      file,
      parentCompressions,
    });
  }
  traceArchivePreparation(options, "input.archive.patch.enumerate.finish", {
    compressionFormat,
    file: describeArchiveFileForTrace(archiveFile),
    leafCandidateIds: leaves.map((leaf) => leaf.candidate.id),
    leafCount: leaves.length,
    leafPaths: leaves.map((leaf) => leaf.candidate.path),
    outputCount: outputs.length,
  });
  return leaves;
};

/** Resolve one patch leaf from a (possibly nested) patch archive. Returns the cached/extracted leaf
 * for an explicit selection, auto-picks a lone leaf, prompts (flat multi-select across all branches)
 * when several exist, and returns `null` when no valid patch is discovered so the caller can fall
 * back to the generic single-payload descent. */
const resolvePatchArchiveLeaf = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
  selectedArchiveEntry: string | undefined,
  sourceIndex: number,
): Promise<PatchFileInstance | null> => {
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  if (selectedArchiveEntry) {
    const cached = cache.get(selectedArchiveEntry);
    if (cached) return cached;
  }
  const leaves = await enumeratePatchLeaves(archiveFile, options, runtime, sourceIndex);
  if (selectedArchiveEntry) {
    const leaf = leaves.find((entry) => entry.candidate.path === selectedArchiveEntry);
    if (leaf) return leaf.file;
    throw new RomWeaverError(
      "SELECTION_NOT_FOUND",
      `${archiveFile.fileName || "Patch archive"} has no patch entry "${selectedArchiveEntry}"`,
    );
  }
  if (leaves.length === 0) return null;
  if (leaves.length === 1) return leaves[0]?.file ?? null;
  if (typeof options?.onCandidatesFound !== "function") return leaves[0]?.file ?? null;
  const request: CandidateSelectionRequest = {
    candidates: leaves.map((entry) => entry.candidate),
    multiSelect: true,
    role: "patch",
    sourceIndex,
    sourceName: archiveFile.fileName || "Patch archive",
    warnings: [],
  };
  patchLeafFilesByRequest.set(
    request,
    new Map(
      leaves.map((entry) => [entry.candidate.id, { file: entry.file, parentCompressions: entry.parentCompressions }]),
    ),
  );
  traceArchivePreparation(options, "input.archive.patch.register", {
    candidateIds: leaves.map((entry) => entry.candidate.id),
    count: leaves.length,
    sourceName: request.sourceName,
  });
  options.onCandidatesFound(request);
  throw new RomWeaverError("AMBIGUOUS_SELECTION", `${request.sourceName} requires patch selection`, {
    details: { request },
  });
};

/** Resolve a single compressed input/patch FILE with one recursive `extract` (no `list`): the Rust
 * core descends nested containers and resolves a single payload per level via the interactive
 * callback, returning the bottom leaf file. Used by the patch (and rom file-staging) path. */
const resolveArchiveInputFileByDescent = async (
  file: PatchFileInstance,
  role: "rom" | "patch",
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedArchiveEntry?: string,
  sourceIndex = 0,
): Promise<PatchFileInstance> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.extract) throw new Error("Compression extraction is unavailable");
  const compressionFormat = getCompressionFormat(file);
  const kindFilter = role === "patch" ? { patchFilter: true } : { romFilter: true };
  if (role === "patch") {
    // Discover EVERY patch across all nested branches and (when ambiguous) prompt with a flat
    // multi-select list; a discovered leaf is returned directly. Only fall through to the generic
    // single-payload descent below when no valid patch leaf was found.
    const patchLeaf = await resolvePatchArchiveLeaf(file, options, runtime, selectedArchiveEntry, sourceIndex);
    if (patchLeaf) return patchLeaf;
  }
  const chdSelection = await resolveChdSplitBinSelection({
    archiveFile: file,
    compressionFormat,
    kindFilter,
    options,
    runtime,
    selectedEntryName: selectedArchiveEntry,
  });
  const selectedEntries = normalizeSelectedEntryNames(
    chdSelection.selectedEntryName ? [chdSelection.selectedEntryName] : [],
  );
  await preflightArchiveLimitsForDescent(file, options, runtime, kindFilter, selectedEntries);
  traceArchivePreparation(options, "input.archive.file.descent.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(file),
    role,
    selectedEntries,
  });
  const result = await resolvedRuntime.compression.extract({
    descendSinglePayload: true,
    entries: selectedEntries,
    format: compressionFormat,
    options: getCompressionRuntimeOptions(options, { chdSplitBin: chdSelection.chdSplitBin }, kindFilter),
    source: getCompressionRuntimeSource(file),
  });
  const output = result.output || (Array.isArray(result.outputs) ? result.outputs[0] : undefined);
  if (!output) throw new Error(`${file.fileName || "Archive"} produced no extractable ${role}`);
  const fileName = getBaseFileName(output.fileName || file.fileName || (role === "patch" ? "patch.bin" : "rom.bin"));
  const extracted = await createPatchFileFromPublicOutput(output, fileName, {
    materializeBlob: false,
    preferExternalFilePath: true,
  });
  extracted.fileName = fileName;
  if (chdSelection.chdMode) extracted._chdMode = chdSelection.chdMode;
  traceArchivePreparation(options, "input.archive.file.descent.finish", {
    compressionFormat,
    fileName,
    role,
  });
  return extracted;
};

const resolveArchiveInput = async (
  file: PatchFileInstance,
  role: "rom" | "patch",
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedArchiveEntry?: string,
  sourceIndex = 0,
): Promise<PatchFileInstance> => {
  if (options?.input?.containerInputsEnabled === false) {
    traceArchivePreparation(options, "input.archive.resolve.skip", {
      file: describeArchiveFileForTrace(file),
      reason: "container-inputs-disabled",
      role,
      sourceIndex,
    });
    return file;
  }
  if (!isCompressionFile(file)) {
    traceArchivePreparation(options, "input.archive.resolve.skip", {
      file: describeArchiveFileForTrace(file),
      reason: "not-compression",
      role,
      sourceIndex,
    });
    return file;
  }
  return resolveArchiveInputFileByDescent(file, role, options, runtime, selectedArchiveEntry, sourceIndex);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Discover a compressed archive's input assets with a SINGLE recursive `extract` (no `list`): the
 * Rust core descends nested containers, resolving one payload per level via the interactive selection
 * callback (auto-pick when unambiguous, prompt when not), and returns the bottom leaf output(s) with
 * checksums. Builds rom assets, or a cue group when the leaf is a CD image (cue + tracks). */
const resolveArchiveInputAssetsByDescent = async (
  archiveFile: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  sourceIndex: number,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedInputEntryName?: string,
): Promise<InputAsset[]> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.extract) throw new Error("Compression extraction is unavailable");
  const compressionFormat = getCompressionFormat(archiveFile);
  const chdSelection = await resolveChdSplitBinSelection({
    archiveFile,
    compressionFormat,
    kindFilter: { romFilter: true },
    options,
    runtime,
    selectedEntryName: selectedInputEntryName,
  });
  const selectedEntries = normalizeSelectedEntryNames(
    chdSelection.selectedEntryName ? [chdSelection.selectedEntryName] : [],
  );
  await preflightArchiveLimitsForDescent(archiveFile, options, runtime, { romFilter: true }, selectedEntries);
  traceArchivePreparation(options, "input.archive.descent.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(archiveFile),
    selectedEntries,
    sourceIndex,
  });
  // Capture each `extract-step` the Rust descent emits (one per descended level), so the existing
  // extraction-tree UI can show the nested archive chain. Each step carries its full `source` path
  // and the `out_dir` it extracted into; the UI relativizes each level's source (and the final leaf)
  // against the longest matching `out_dir` to show the path *inside* its immediate parent archive.
  const steps: Array<{
    depth: number;
    sourceName: string;
    source: string;
    outDir: string;
    outputSize: number;
    format: string;
  }> = [];
  let totalDescentOutputBytes = 0;
  const runtimeOptions = getCompressionRuntimeOptions(
    options,
    { chdSplitBin: chdSelection.chdSplitBin },
    { romFilter: true },
  );
  const forwardProgress = runtimeOptions.onProgress;
  runtimeOptions.onProgress = (progress) => {
    const details = isRecord(progress) ? (progress as { details?: unknown }).details : undefined;
    const step = isRecord(details) ? (details as { extract_step?: unknown }).extract_step : undefined;
    if (isRecord(step) && step.status === "succeeded" && typeof step.source_name === "string" && step.source_name) {
      const outputs = Array.isArray(step.outputs) ? step.outputs : [];
      const outputSize = outputs.reduce(
        (total, output) => total + (isRecord(output) && typeof output.size_bytes === "number" ? output.size_bytes : 0),
        0,
      );
      totalDescentOutputBytes += outputSize;
      assertDescentOutputLimits(
        options,
        typeof step.depth === "number" ? step.depth : steps.length,
        outputs,
        totalDescentOutputBytes,
      );
      steps.push({
        depth: typeof step.depth === "number" ? step.depth : steps.length,
        format: typeof step.format === "string" && step.format ? step.format : compressionFormat,
        outDir: typeof step.out_dir === "string" ? step.out_dir : "",
        outputSize,
        source: typeof step.source === "string" ? step.source : "",
        sourceName: getBaseFileName(step.source_name),
      });
    }
    forwardProgress?.(progress as never);
  };
  const result = await resolvedRuntime.compression.extract({
    descendSinglePayload: true,
    entries: selectedEntries,
    format: compressionFormat,
    options: runtimeOptions,
    source: getCompressionRuntimeSource(archiveFile),
  });
  const outputs = Array.isArray(result.outputs) ? result.outputs : [];
  if (!outputs.length) throw new Error(`${archiveFile.fileName || "Archive"} produced no extractable payload`);
  const files = await Promise.all(
    outputs.map(async (output, index) => {
      const fileName = getBaseFileName(output.fileName || `payload-${index + 1}.bin`);
      // Sheet sidecars (cue/gdi) are read as text below, so materialize their bytes
      // for synchronous read; tracks stay path-backed.
      const shouldMaterializeForSyncRead = isCueEntryFileName(fileName) || isGdiEntryFileName(fileName);
      const file = await createPatchFileFromPublicOutput(output, fileName, {
        materializeBlob: shouldMaterializeForSyncRead,
        preferExternalFilePath: !shouldMaterializeForSyncRead,
      });
      file.fileName = fileName;
      if (chdSelection.chdMode) file._chdMode = chdSelection.chdMode;
      return file;
    }),
  );
  traceArchivePreparation(options, "input.archive.descent.finish", {
    compressionFormat,
    outputCount: files.length,
    outputNames: files.map((file) => file.fileName),
    sourceIndex,
  });
  // A CD ships a `.cue`, a GD-ROM a `.gdi`, and some discs carry both; either (or
  // both) sheet marks a single multi-track disc whose tracks group under it. The
  // sheets are non-patchable sidecars carried alongside their tracks.
  const cueFile = files.find((file) => isCueEntryFileName(file.fileName));
  const gdiFile = files.find((file) => isGdiEntryFileName(file.fileName));
  const sheetFiles = files.filter((file) => file === cueFile || file === gdiFile);
  const trackFiles = files.filter((file) => !sheetFiles.includes(file));
  let assets: InputAsset[];
  if (sheetFiles.length && trackFiles.length) {
    const cueText = cueFile ? decodeUtf8(getPatchFileBytes(cueFile)) : undefined;
    const gdiText = gdiFile ? decodeUtf8(getPatchFileBytes(gdiFile)) : undefined;
    const primarySheet = cueFile ?? (gdiFile as PatchFileInstance);
    const groupId = makeInputId(sourceIndex, primarySheet.fileName, normalizeArchiveEntryName, "-group");
    const splitBinAvailable = cueText ? isChdSplitBinCue(archiveFile, cueText) : true;
    assets = trackFiles.map((trackFile) =>
      makeTrackAsset(
        makeInputId(sourceIndex, trackFile.fileName, normalizeArchiveEntryName),
        trackFile.fileName,
        trackFile,
        groupId,
        { patchable: true },
        { cueText, gdiText, splitBinAvailable },
      ),
    );
    if (cueFile && cueText !== undefined) {
      assets.push(makeCueAsset(`${groupId}-cue`, cueFile.fileName, cueFile, groupId, cueText));
    }
    if (gdiFile && gdiText !== undefined) {
      assets.push(makeGdiAsset(`${groupId}-gdi`, gdiFile.fileName, gdiFile, groupId, gdiText));
    }
  } else {
    assets = files.map((file) =>
      makeRomAsset(makeInputId(sourceIndex, file.fileName, normalizeArchiveEntryName), file),
    );
  }
  // Build the archive chain for the UI. Each level's displayed size is the container's OWN size
  // (depth 0 = the input file, depth N = the output the previous level produced). The displayed name
  // is the path *inside the immediate parent archive*: a full work path relativized against the
  // longest level `out_dir` that contains it (depth 0 is the input archive itself, shown by name).
  const orderedSteps = [...steps].sort((left, right) => left.depth - right.depth);
  const outDirs = orderedSteps.map((step) => step.outDir).filter(Boolean);
  const inArchivePath = (fullPath: string): string => {
    let longestContainer = "";
    for (const dir of outDirs) {
      if (fullPath.startsWith(`${dir}/`) && dir.length > longestContainer.length) longestContainer = dir;
    }
    return longestContainer ? fullPath.slice(longestContainer.length + 1) : getBaseFileName(fullPath);
  };
  const parentCompressions: InputParentCompression[] = orderedSteps.map((step, index) => {
    const sourceSize = index === 0 ? archiveFile.fileSize : orderedSteps[index - 1]?.outputSize;
    const fileName = index === 0 ? step.sourceName : inArchivePath(step.source);
    return {
      depth: index,
      fileName,
      kind: step.format,
      ...(typeof sourceSize === "number" && sourceSize > 0 ? { sourceSize } : {}),
      ...(step.outputSize > 0 ? { outputSize: step.outputSize } : {}),
    };
  });
  // Append the extracted payload itself as the final chain level, showing its path inside its
  // immediate parent archive. Only for a single payload; cue groups display their primary entry.
  const leafOutput = outputs.length === 1 ? outputs[0] : undefined;
  const leafFile = files.length === 1 ? files[0] : undefined;
  if (leafOutput && leafFile) {
    parentCompressions.push({
      depth: parentCompressions.length,
      fileName: inArchivePath(leafOutput.path),
      kind: "rom",
      ...(leafFile.fileSize > 0 ? { sourceSize: leafFile.fileSize } : {}),
    });
  }
  return attachInputPreparationMetrics(assets, {
    sourceSize: archiveFile.fileSize,
    wasDecompressed: true,
    ...(parentCompressions.length ? { parentCompressions } : {}),
  });
};

const resolveArchiveInputAssets = async (
  archiveFile: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  sourceIndex: number,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedInputEntryName?: string,
): Promise<InputAsset[]> => {
  if (options?.input?.containerInputsEnabled === false) {
    traceArchivePreparation(options, "input.archive.assets.skip", {
      file: describeArchiveFileForTrace(archiveFile),
      reason: "container-inputs-disabled",
      selectedInputEntryName: selectedInputEntryName || "",
      sourceIndex,
    });
    return [];
  }
  if (!isCompressionFile(archiveFile)) {
    traceArchivePreparation(options, "input.archive.assets.skip", {
      file: describeArchiveFileForTrace(archiveFile),
      reason: "not-compression",
      selectedInputEntryName: selectedInputEntryName || "",
      sourceIndex,
    });
    return [];
  }
  return resolveArchiveInputAssetsByDescent(archiveFile, options, sourceIndex, runtime, selectedInputEntryName);
};

const prepareAutoPatchInputs = async (
  source: SourceRef,
  options: ApplyWorkflowOptions | undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<PatchFileInstance[]> => {
  const archiveFile = await createPatchFile(source, "input.bin");
  if (options?.input?.containerInputsEnabled === false || !isCompressionFile(archiveFile)) return [];
  // chd/rvz/z3ds are single-disc image formats, not archives that can carry sidecar patch files.
  // Scanning them for patches re-extracts the whole disc image for nothing (a redundant decode of the
  // entire input), so skip auto-patch discovery for them entirely.
  if (PATH_BACKED_COMPRESSION_FORMATS.has(getCompressionFormat(archiveFile))) return [];
  const romEntries = await listCompressionEntries(archiveFile, options, runtime, { romFilter: true }).catch(() => []);
  const romProbe = await probeCompressionRomEntriesForSource(archiveFile, romEntries, options, runtime);
  const patchEntries = await filterValidPatchArchiveEntriesForSource(archiveFile, options, runtime);
  if (!patchEntries.length) return [];
  const selectedRomEntryName = resolveCompressionRomAutoPickEntryName(archiveFile.fileName, romProbe, "");
  if (!selectedRomEntryName) return [];

  const sidecarPatches = resolveSidecarPatchEntries(selectedRomEntryName, patchEntries);
  const patchFiles: PatchFileInstance[] = [];
  for (const sidecarPatch of sidecarPatches) {
    const entryName = sidecarPatch.entry.filename;
    if (!entryName) continue;
    const patchFile = await extractArchiveEntry(
      archiveFile,
      entryName,
      getPathBaseName(entryName),
      options,
      runtime,
      [],
      {
        patchFilter: true,
      },
    );
    applySidecarPatchOutputLabel(patchFile, sidecarPatch.outputLabel);
    patchFiles.push(patchFile);
  }
  return patchFiles;
};

/** Retrieve the already-extracted leaf patch file for a candidate of an emitted patch-selection
 * request, so the controller can stage the user's pick(s) without re-extracting. */
const getPatchLeafFileForSelection = (
  request: CandidateSelectionRequest,
  candidateId: string,
): PatchFileInstance | undefined => patchLeafFilesByRequest.get(request)?.get(candidateId)?.file;

/** Retrieve the archive-nesting chain (source archive › nested archives) for a registered patch
 * leaf so a fanned-out patch entry keeps its "extract section" in the patch stack row. */
const getPatchLeafParentCompressionsForSelection = (
  request: CandidateSelectionRequest,
  candidateId: string,
): InputParentCompression[] | undefined => patchLeafFilesByRequest.get(request)?.get(candidateId)?.parentCompressions;

/**
 * Probe whether an archive/container holds a pickable ROM. The unified Apply
 * drop surface uses this to route a dropped archive: one with a ROM is a ROM
 * source (embedded patches are surfaced separately by {@link prepareAutoPatchInputs}),
 * while one without a ROM is treated as a patch container. Path-backed disc
 * images (chd/rvz/z3ds) are always ROM sources and never carry sidecar patches.
 */
const archiveContainsRomEntry = async (
  source: SourceRef,
  options: ApplyWorkflowOptions | undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<boolean> => {
  const archiveFile = await createPatchFile(source, "input.bin");
  if (!isCompressionFile(archiveFile)) return false;
  if (PATH_BACKED_COMPRESSION_FORMATS.has(getCompressionFormat(archiveFile))) return true;
  const romEntries = await listCompressionEntries(archiveFile, options, runtime, { romFilter: true }).catch(() => []);
  if (!romEntries.length) return false;
  // When every candidate is itself a nested container, the listing proves nothing about ROM
  // content at this level. Route such bundles to the patch flow: its extract-all descends nested
  // archives (the designed nested-patch-bundle path) and surfaces a clear error when no patch
  // exists, whereas the ROM flow would dead-end on an ambiguous container pick.
  const directRomEntries = romEntries.filter(
    (entry) => !(typeof entry.filename === "string" && isCompressionEntryFileName(entry.filename)),
  );
  if (!directRomEntries.length) return false;
  const romProbe = await probeCompressionRomEntriesForSource(archiveFile, romEntries, options, runtime);
  return !!resolveCompressionRomAutoPickEntryName(archiveFile.fileName, romProbe, "");
};

export {
  archiveContainsRomEntry,
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  prepareAutoPatchInputs,
  resolveArchiveInput,
  resolveArchiveInputAssets,
};
