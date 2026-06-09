import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { SelectionGroupCandidate } from "../../types/selection.ts";
import type { SourceObject, SourceRef } from "../../types/source.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { createArchiveSourceBlob } from "../archive-utils.ts";
import { CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS } from "../compression/container-format-registry.ts";
import { RomWeaverError } from "../errors.ts";
import { getPathBaseName } from "../path-utils.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { findArchiveEntryByFileName, isCueEntryFileName, parseCueFileReferences } from "./archive.ts";
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
type CompressionExtractOverrides = {
  checksumAlgorithms?: string[];
  chdSplitBin?: boolean;
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
      (!getDirectoryPath(cueFileName) || getDirectoryPath(entry.filename) === getDirectoryPath(cueFileName)),
  );

const isCompressionEntryFileName = (fileName: string) => classifyPatcherInput({ fileName }).kind === "compression";

const isBinEntryFileName = (fileName: string) => /\.bin$/i.test(getBaseFileName(fileName));

const encodeChdSplitSelection = (entryName: string, splitBin: boolean) =>
  `${splitBin ? CHD_SPLIT_SELECTION_PREFIX : CHD_MERGED_SELECTION_PREFIX}${entryName}`;

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

const getChdCueEntryName = (entries: ArchiveEntryLike[]) =>
  entries.find((entry) => isCueEntryFileName(entry.filename))?.filename || "";

const getChdBinEntries = (entries: ArchiveEntryLike[]) => entries.filter((entry) => isBinEntryFileName(entry.filename));

const formatChdEntryListLabel = (entries: ArchiveEntryLike[]) =>
  entries.map((entry) => getBaseFileName(entry.filename)).join(" + ");

const filterNestedContainerEntries = (entries: ArchiveEntryLike[]) =>
  entries.filter((entry) => typeof entry.filename === "string" && isCompressionEntryFileName(entry.filename));

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
  ...(options?.limits ? { limits: options.limits } : {}),
  ...(kindFilter.romFilter ? { romFilter: true } : {}),
  ...(kindFilter.patchFilter ? { patchFilter: true } : {}),
  logLevel: options?.logging?.level,
  onLog: options?.onLog,
  onProgress: options?.onProgress,
  workerThreads: options?.workers?.threads,
});

const markChdCueSplitBinAvailability = (
  asset: InputAsset,
  archiveFile: PatchFileInstance,
  cueText: string,
): InputAsset => {
  if (getCompressionFormat(archiveFile) !== "chd") return asset;
  const cue = parseCueFile(cueText);
  if (cue.tracks.length <= 1) return asset;
  return {
    ...asset,
    disc: {
      ...asset.disc,
      splitBinAvailable: true,
    },
  };
};

const listCompressionEntries = async (
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
  traceArchivePreparation(options, "input.archive.list.finish", {
    compressionFormat,
    entryCount: entries.length,
    entrySample: summarizeEntryNames(entries),
    file: describeArchiveFileForTrace(file),
    patchFilter: !!kindFilter.patchFilter,
    romFilter: !!kindFilter.romFilter,
    runtime: resolvedRuntime.name,
  });
  return entries;
};

const makeChdOutputModeCandidate = ({
  cueEntryName,
  entries,
  id,
  label,
  splitBin,
}: {
  cueEntryName: string;
  entries: ArchiveEntryLike[];
  id: string;
  label: string;
  splitBin: boolean;
}): SelectionGroupCandidate => ({
  candidateIds: [],
  id,
  kind: "chd-output-mode",
  label: `${label}: ${formatChdEntryListLabel(entries)}`,
  path: encodeChdSplitSelection(cueEntryName, splitBin),
  selectable: true,
  type: "group",
  warnings: [],
});

const resolveChdSplitBinSelection = async ({
  archiveFile,
  compressionFormat,
  kindFilter,
  options,
  runtime,
  selectedEntryName,
  sourceIndex,
}: {
  archiveFile: PatchFileInstance;
  compressionFormat: string;
  kindFilter: CompressionEntryKindFilter;
  options: InputPreparationOptions;
  runtime: InputPreparationRuntimeLike;
  selectedEntryName?: string;
  sourceIndex: number;
}): Promise<{ selectedEntryName?: string; chdSplitBin?: boolean }> => {
  const parsedSelection = parseChdSplitSelection(selectedEntryName);
  if (parsedSelection.chdSplitBin !== undefined || parsedSelection.selectedEntryName) return parsedSelection;
  if (compressionFormat !== "chd" || !kindFilter.romFilter || typeof options?.onCandidatesFound !== "function") {
    return parsedSelection;
  }

  const mergedEntries = await listCompressionEntries(archiveFile, options, runtime, kindFilter, { chdSplitBin: false });
  const splitEntries = await listCompressionEntries(archiveFile, options, runtime, kindFilter, { chdSplitBin: true });
  const mergedBinEntries = getChdBinEntries(mergedEntries);
  const splitBinEntries = getChdBinEntries(splitEntries);
  const cueEntryName = getChdCueEntryName(mergedEntries) || getChdCueEntryName(splitEntries);
  if (!(cueEntryName && mergedBinEntries.length === 1 && splitBinEntries.length > 1)) return parsedSelection;

  const request = {
    candidates: [
      makeChdOutputModeCandidate({
        cueEntryName,
        entries: mergedBinEntries,
        id: makeInputId(sourceIndex, `${cueEntryName}-merged-bin`, normalizeArchiveEntryName),
        label: "Merged BIN",
        splitBin: false,
      }),
      makeChdOutputModeCandidate({
        cueEntryName,
        entries: splitBinEntries,
        id: makeInputId(sourceIndex, `${cueEntryName}-split-bin`, normalizeArchiveEntryName),
        label: "Split BIN tracks",
        splitBin: true,
      }),
    ],
    role: "input" as const,
    sourceName: archiveFile.fileName || "CHD input",
    warnings: [],
  };
  options.onCandidatesFound(request);
  throw new RomWeaverError("AMBIGUOUS_SELECTION", `${request.sourceName} requires CHD output selection`, {
    details: { request },
  });
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
    if (!isCueEntryFileName(cueFileName)) continue;
    const syntheticTrackEntries =
      entry.archiveEntryType === "cue" ? getSyntheticCueTrackEntries(entries, cueFileName) : [];
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
  const standaloneEntries = romEntries.filter(
    (entry) => !(isCueEntryFileName(entry.filename) || referencedTrackNames.has(entry.filename)),
  );
  return {
    cueGroups,
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
  const chdSelection = await resolveChdSplitBinSelection({
    archiveFile: file,
    compressionFormat,
    kindFilter,
    options,
    runtime,
    selectedEntryName: selectedArchiveEntry,
    sourceIndex,
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
    sourceIndex,
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
      const shouldMaterializeForSyncRead = isCueEntryFileName(fileName);
      const file = await createPatchFileFromPublicOutput(output, fileName, {
        materializeBlob: shouldMaterializeForSyncRead,
        preferExternalFilePath: !shouldMaterializeForSyncRead,
      });
      file.fileName = fileName;
      return file;
    }),
  );
  traceArchivePreparation(options, "input.archive.descent.finish", {
    compressionFormat,
    outputCount: files.length,
    outputNames: files.map((file) => file.fileName),
    sourceIndex,
  });
  const cueFile = files.find((file) => isCueEntryFileName(file.fileName));
  let assets: InputAsset[];
  if (cueFile && files.length > 1) {
    const cueText = decodeUtf8(getPatchFileBytes(cueFile));
    const groupId = makeInputId(sourceIndex, cueFile.fileName, normalizeArchiveEntryName, "-group");
    assets = files
      .filter((file) => file !== cueFile)
      .map((trackFile) =>
        makeTrackAsset(
          makeInputId(sourceIndex, trackFile.fileName, normalizeArchiveEntryName),
          trackFile.fileName,
          trackFile,
          groupId,
          { patchable: true },
        ),
      );
    assets.push(
      markChdCueSplitBinAvailability(
        makeCueAsset(`${groupId}-cue`, cueFile.fileName, cueFile, groupId, cueText),
        archiveFile,
        cueText,
      ),
    );
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

export { prepareAutoPatchInputs, resolveArchiveInput, resolveArchiveInputAssets };
