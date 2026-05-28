import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { CandidateSelectionRequest, SelectionFileCandidate } from "../../types/selection.ts";
import type { SourceObject, SourceRef } from "../../types/source.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { createArchiveSourceBlob } from "../archive-utils.ts";
import { RomWeaverError } from "../errors.ts";
import { filterRomEntries } from "../input/archive-entry-filter-utils.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { findArchiveEntryByFileName, findCueBinEntry, isCueEntryFileName, parseCueFileReferences } from "./archive.ts";
import type { PatchFileInstance } from "./binary-service.ts";
import {
  attachPatchFileCleanup,
  attachPatchFileSourceRef,
  createBlobBackedPatchFile,
  createPatchFile,
  decodeUtf8,
  getPatchFileBlob,
  getPatchFileBytes,
  getPatchFileCleanup,
  getPatchFileExternalSource,
  getPatchFileHandle,
  normalizeArchiveEntryBytes,
  PatchFile,
} from "./binary-service.ts";
import {
  attachInputPreparationMetrics,
  type CueCandidateGroup,
  getInputPreparationMetrics,
  type InputAsset,
  type InputParentCompression,
  makeCueAsset,
  makeInputCandidateGroup,
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
type CompressionRomInspection = {
  cueGroups: CompressionRomCueGroup[];
  directRomEntries: ArchiveEntryLike[];
  nestedCompressionEntries: ArchiveEntryLike[];
  referencedTrackNames: Set<string>;
  romEntries: ArchiveEntryLike[];
  standaloneEntries: ArchiveEntryLike[];
};
type InputPreparationOptions = ApplyWorkflowOptions | CreateWorkflowOptions | undefined;
type InputPreparationRuntimeLike = InputPreparationRuntime | Pick<WorkflowRuntime, "name">;
type ArchiveFileBackedSource = Blob | FileSystemFileHandle | string;
type ArchiveFileBackedPatchFile = PatchFileInstance & {
  _archiveFileBackedSource?: ArchiveFileBackedSource | null;
};
type ValidatedPatchArchiveEntryCache = Map<string, PatchFileInstance>;
const PATCH_ENTRY_REGEX = /\.(ips|ups|bps|aps|rup|ppf|ebp|bdf|bspatch|mod|xdelta|vcdiff)\d*$/i;
const PATCH_MAGIC_BY_EXTENSION = {
  bps: "BPS1",
  ips: "PATCH",
  ups: "UPS1",
} as const;
type NestedArchiveOptions = {
  archivePath?: string[];
  breadcrumbs?: string[];
  depth?: number;
  seenCompressedFileIdentities?: Set<string>;
  totalCandidates?: number;
  totalEntries?: number;
  totalUncompressedBytes?: number;
};
const NESTED_ARCHIVE_SELECTION_PREFIX = "nested:";
const PATH_BACKED_COMPRESSION_FORMATS = new Set(["chd", "rvz", "z3ds"]);
const validatedPatchArchiveEntriesByFile = new WeakMap<PatchFileInstance, ValidatedPatchArchiveEntryCache>();
const patchArchiveValidationCleanupAttached = new WeakSet<PatchFileInstance>();

const describeArchiveFileForTrace = (file: PatchFileInstance) => ({
  discOutput: !!(file as { _discDecompressionOutput?: boolean })._discDecompressionOutput,
  fileName: file.fileName || "input.bin",
  filePath: typeof file.filePath === "string" ? file.filePath : "",
  fileSize: typeof file.fileSize === "number" && Number.isFinite(file.fileSize) ? file.fileSize : 0,
});

const getArchiveFileSourceIdentity = (file: PatchFileInstance) => {
  const externalSource = getPatchFileExternalSource(file, file.fileName || "input.bin");
  const source = externalSource?.source;
  if (typeof source === "string" && source.trim()) return source;
  if (isVfsFileRef(source)) return source.path;
  return typeof file.filePath === "string" && file.filePath.trim() ? file.filePath : "";
};

const getCompressedArchiveFileIdentity = (file: PatchFileInstance) =>
  [
    file.fileName || "input.bin",
    typeof file.fileSize === "number" && Number.isFinite(file.fileSize) ? file.fileSize : 0,
    getArchiveFileSourceIdentity(file),
  ].join("|");

const throwRecursiveArchiveExtractionStall = (file: PatchFileInstance): never => {
  throw new RomWeaverError(
    "COMPRESSION_FAILED",
    "Recursive input decompression stalled on the same compressed output",
    {
      details: {
        fileName: file.fileName || "input.bin",
        fileSize: typeof file.fileSize === "number" && Number.isFinite(file.fileSize) ? file.fileSize : undefined,
      },
    },
  );
};

const markCompressedArchiveVisit = (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  nested: NestedArchiveOptions,
  message: string,
) => {
  let seen = nested.seenCompressedFileIdentities;
  if (!seen) {
    seen = new Set<string>();
    nested.seenCompressedFileIdentities = seen;
  }
  const identity = getCompressedArchiveFileIdentity(file);
  if (seen.has(identity)) {
    traceArchivePreparation(options, message, {
      file: describeArchiveFileForTrace(file),
      reason: "repeat-compressed-file-identity",
    });
    throwRecursiveArchiveExtractionStall(file);
  }
  seen.add(identity);
};

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

const getMaxArchiveDepth = (options: InputPreparationOptions) => {
  const configured = Number(options?.limits?.maxArchiveDepth);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 4;
};

const assertArchiveDepth = (options: InputPreparationOptions, depth: number) => {
  if (depth <= getMaxArchiveDepth(options)) return;
  throw new RomWeaverError("ARCHIVE_DEPTH_EXCEEDED", "Archive nesting exceeds configured depth limit", {
    details: { depth, maxArchiveDepth: getMaxArchiveDepth(options) },
  });
};

const getConfiguredLimit = (value: unknown) => {
  const configured = Number(value);
  return Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : null;
};

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

const trackArchiveEntries = (
  options: InputPreparationOptions,
  nested: NestedArchiveOptions,
  entries: ArchiveEntryLike[],
) => {
  nested.totalEntries = (nested.totalEntries || 0) + entries.length;
  assertArchiveLimit(
    "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
    "Archive entry count exceeds configured limit",
    nested.totalEntries,
    options?.limits?.maxEntries,
  );
  const entryBytes = entries.reduce((total, entry) => total + (typeof entry.size === "number" ? entry.size : 0), 0);
  nested.totalUncompressedBytes = (nested.totalUncompressedBytes || 0) + entryBytes;
  assertArchiveLimit(
    "ARCHIVE_TOTAL_UNCOMPRESSED_LIMIT_EXCEEDED",
    "Archive total uncompressed size exceeds configured limit",
    nested.totalUncompressedBytes,
    options?.limits?.maxTotalUncompressedBytes,
  );
};

const trackArchiveCandidates = (
  options: InputPreparationOptions,
  nested: NestedArchiveOptions,
  candidates: ArchiveEntryLike[],
) => {
  nested.totalCandidates = (nested.totalCandidates || 0) + candidates.length;
  assertArchiveLimit(
    "ARCHIVE_CANDIDATE_LIMIT_EXCEEDED",
    "Archive candidate count exceeds configured limit",
    nested.totalCandidates,
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

const isCompressionEntryFileName = (fileName: string) => classifyPatcherInput({ fileName }).kind === "compression";

const filterNestedContainerEntries = (entries: ArchiveEntryLike[]) =>
  entries.filter((entry) => typeof entry.filename === "string" && isCompressionEntryFileName(entry.filename));

const filterPatchLikeEntries = (entries: ArchiveEntryLike[]) =>
  entries.filter((entry) => typeof entry.filename === "string" && PATCH_ENTRY_REGEX.test(entry.filename));

const mergeUniqueArchiveEntries = (...groups: ArchiveEntryLike[][]) => {
  const merged: ArchiveEntryLike[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      const entryName = String(entry?.filename || "");
      if (!entryName || seen.has(entryName)) continue;
      seen.add(entryName);
      merged.push(entry);
    }
  }
  return merged;
};

const getDisplayBreadcrumbs = (nested: NestedArchiveOptions, fileName: string) => [
  ...(nested.breadcrumbs || []),
  normalizeArchiveEntryName(fileName) || getBaseFileName(fileName),
];

const serializeNestedArchiveSelectionPath = (pathParts: string[]) =>
  `${NESTED_ARCHIVE_SELECTION_PREFIX}${JSON.stringify(pathParts)}`;

const parseNestedArchiveSelectionPath = (selectedEntryName: string): string[] | null => {
  if (!selectedEntryName.startsWith(NESTED_ARCHIVE_SELECTION_PREFIX)) return null;
  try {
    const parsed = JSON.parse(selectedEntryName.slice(NESTED_ARCHIVE_SELECTION_PREFIX.length));
    return Array.isArray(parsed) && parsed.every((part) => typeof part === "string") ? parsed : null;
  } catch (_error) {
    return null;
  }
};

const getSelectionPath = (nested: NestedArchiveOptions, entryName: string) =>
  nested.archivePath?.length ? serializeNestedArchiveSelectionPath([...nested.archivePath, entryName]) : undefined;

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

const getKnownDecompressionTimeMs = (entries: InputParentCompression[]): number | undefined => {
  let total = 0;
  let found = false;
  for (const entry of entries) {
    if (typeof entry.decompressionTimeMs === "number" && Number.isFinite(entry.decompressionTimeMs)) {
      total += entry.decompressionTimeMs;
      found = true;
    }
  }
  return found ? total : undefined;
};

const createParentCompressionStep = (
  source: PatchFileInstance,
  output: PatchFileInstance,
  decompressionTimeMs: number,
): InputParentCompression => ({
  decompressionTimeMs,
  depth: 0,
  fileName: source.fileName || "input.bin",
  kind: getCompressionFormat(source),
  outputSize: typeof output.fileSize === "number" && Number.isFinite(output.fileSize) ? output.fileSize : undefined,
  sourceSize: typeof source.fileSize === "number" && Number.isFinite(source.fileSize) ? source.fileSize : undefined,
});

const prependCompressionStepMetrics = (assets: InputAsset[], step: InputParentCompression): InputAsset[] => {
  const nestedMetrics = getInputPreparationMetrics(assets);
  const nestedSteps = nestedMetrics?.parentCompressions || [];
  const nestedTimeMs =
    typeof nestedMetrics?.decompressionTimeMs === "number" && Number.isFinite(nestedMetrics.decompressionTimeMs)
      ? nestedMetrics.decompressionTimeMs
      : (getKnownDecompressionTimeMs(nestedSteps) ?? 0);
  const stepTimeMs =
    typeof step.decompressionTimeMs === "number" && Number.isFinite(step.decompressionTimeMs)
      ? step.decompressionTimeMs
      : 0;
  const mergedSteps = [step, ...nestedSteps].map((entry, depth) => ({
    ...entry,
    depth,
  }));
  return attachInputPreparationMetrics(assets, {
    decompressionTimeMs: stepTimeMs + nestedTimeMs,
    parentCompressions: mergedSteps,
    sourceSize:
      typeof step.sourceSize === "number" && Number.isFinite(step.sourceSize)
        ? step.sourceSize
        : nestedMetrics?.sourceSize,
    wasDecompressed: true,
  });
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

const getCompressionRuntimeOptions = (options: InputPreparationOptions) => ({
  logLevel: options?.logging?.level,
  onLog: options?.onLog,
  onProgress: options?.onProgress,
  workerThreads: options?.workers?.threads,
});

const listCompressionEntries = async (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
) => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.list) throw new Error("Compression listing is unavailable");
  const compressionFormat = getCompressionFormat(file);
  traceArchivePreparation(options, "input.archive.list.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(file),
    runtime: resolvedRuntime.name,
  });
  const result = await resolvedRuntime.compression.list({
    format: compressionFormat,
    options: getCompressionRuntimeOptions(options),
    source: getCompressionRuntimeSource(file),
  });
  const entries = result.entries || [];
  traceArchivePreparation(options, "input.archive.list.finish", {
    compressionFormat,
    entryCount: entries.length,
    entrySample: summarizeEntryNames(entries),
    file: describeArchiveFileForTrace(file),
    runtime: resolvedRuntime.name,
  });
  return entries;
};

const extractCompressionEntries = async (
  file: PatchFileInstance,
  entryNames: string[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  outputName?: string,
) => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.extract) throw new Error("Compression extraction is unavailable");
  const compressionFormat = getCompressionFormat(file);
  traceArchivePreparation(options, "input.archive.extract.start", {
    compressionFormat,
    entries: entryNames,
    file: describeArchiveFileForTrace(file),
    outputName: outputName || "",
    runtime: resolvedRuntime.name,
  });
  const result = await resolvedRuntime.compression.extract({
    entries: entryNames,
    format: compressionFormat,
    options: getCompressionRuntimeOptions(options),
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
    pathBackedCompressionOutput: isPathBackedCompressionOutput,
    runtime: resolvedRuntime.name,
  });
  return Promise.all(
    result.outputs.map(async (output, index) => {
      const requestedEntryName = entryNames[index] || output.fileName || "output.bin";
      const selectedEntryFileName = getBaseFileName(requestedEntryName);
      const usePathBackedOutput = isPathBackedCompressionOutput && !isCueEntryFileName(selectedEntryFileName);
      const isDiscExtractionOutput = isPathBackedCompressionOutput && !isCueEntryFileName(selectedEntryFileName);
      const resolvedFileName = isPathBackedCompressionOutput
        ? selectedEntryFileName
        : output.fileName || selectedEntryFileName;
      const binFile = await createPatchFileFromPublicOutput(output, resolvedFileName, {
        materializeBlob: !usePathBackedOutput,
        preferExternalFilePath: resolvedRuntime.name === "browser" && !isPathBackedCompressionOutput,
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
      if (isDiscExtractionOutput) (binFile as { _discDecompressionOutput?: boolean })._discDecompressionOutput = true;
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
) => {
  const [entryFile] = await extractCompressionEntries(
    archiveFile,
    [entryName],
    options,
    runtime,
    getBaseFileName(entryName),
  );
  if (!entryFile) throw new Error(`Archive entry data is not available: ${entryName}`);
  try {
    return normalizeArchiveEntryBytes(getPatchFileBytes(entryFile));
  } finally {
    await Promise.resolve(getPatchFileCleanup(entryFile)?.()).catch(() => undefined);
  }
};

const createArchiveEntryPatchFileFromBytes = (
  data: Uint8Array,
  archiveFile: PatchFileInstance,
  entryName: string,
  fileName?: string,
  cleanup?: () => Promise<void> | void,
): PatchFileInstance => {
  const binFile = new PatchFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  binFile.fileName = fileName || getBaseFileName(entryName);
  attachPatchFileCleanup(binFile as PatchFileInstance, cleanup);
  (binFile as { _archiveEntryName?: string })._archiveEntryName = entryName;
  (binFile as { _archiveFileName?: string })._archiveFileName = archiveFile.fileName;
  return binFile as PatchFileInstance;
};

const extractArchiveEntry = async (
  archiveFile: PatchFileInstance,
  entryName: string,
  fileName?: string,
  options: InputPreparationOptions = undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<PatchFileInstance> => {
  const [entryFile] = await extractCompressionEntries(
    archiveFile,
    [entryName],
    options,
    runtime,
    fileName || getBaseFileName(entryName),
  );
  if (!entryFile) throw new Error(`Archive entry data is not available: ${entryName}`);
  entryFile.fileName = fileName || entryFile.fileName || getBaseFileName(entryName);
  (entryFile as { _archiveEntryName?: string })._archiveEntryName = entryName;
  (entryFile as { _archiveFileName?: string })._archiveFileName = archiveFile.fileName;
  return entryFile;
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

const takeValidatedPatchArchiveEntry = async (
  archiveFile: PatchFileInstance,
  entryName: string,
): Promise<PatchFileInstance | null> => {
  const cache = validatedPatchArchiveEntriesByFile.get(archiveFile);
  if (!cache?.size) return null;
  const selected = cache.get(entryName) || null;
  if (selected) cache.delete(entryName);
  await releaseValidatedPatchArchiveEntries(archiveFile);
  return selected;
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
    return expectedMagic ? header.startsWith(expectedMagic) : PATCH_ENTRY_REGEX.test(patchFile.fileName || "");
  } catch (_error) {
    return false;
  }
};

const filterValidPatchArchiveEntriesForSource = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
) => {
  const patchEntries = filterPatchLikeEntries(entries);
  const cache = getValidatedPatchArchiveEntryCache(archiveFile);
  const validEntries = await Promise.all(
    patchEntries.map(async (entry) => {
      if (cache.has(entry.filename)) return entry;
      const patchFile = await extractArchiveEntry(archiveFile, entry.filename, undefined, options, runtime).catch(
        () => null,
      );
      if (!patchFile) return null;
      try {
        if (!(await isValidPatchPatchFile(patchFile))) return null;
        ensureValidatedPatchArchiveEntryCleanup(archiveFile);
        cache.set(entry.filename, patchFile);
        return entry;
      } finally {
        if (!cache.has(entry.filename))
          await Promise.resolve(getPatchFileCleanup(patchFile)?.()).catch(() => undefined);
      }
    }),
  );
  return validEntries.filter((entry): entry is ArchiveEntryLike => !!entry);
};

const inspectCompressionRomEntriesForSource = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<CompressionRomInspection> => {
  const directRomEntries = filterRomEntries(entries);
  const nestedCompressionEntries = filterNestedContainerEntries(entries);
  const romEntries = mergeUniqueArchiveEntries(directRomEntries, nestedCompressionEntries);
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
      const cueText = decodeUtf8(await extractArchiveEntryBytes(archiveFile, cueFileName, options, runtime));
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
  inspection: CompressionRomInspection,
  selectedEntryName: string,
): string | null => {
  const completeCueGroups = inspection.cueGroups.filter((group) => isCompleteCueGroup(group));
  if (selectedEntryName) {
    const selectedGroup = resolveCompressionRomCueGroup(completeCueGroups, selectedEntryName);
    if (selectedGroup) return selectedGroup.cueFileName;
    const selectedEntry = inspection.romEntries.find((entry) => entry.filename === selectedEntryName);
    return selectedEntry?.filename || selectedEntryName;
  }
  if (!inspection.romEntries.length) return null;
  if (completeCueGroups.length === 1 && inspection.standaloneEntries.length === 0)
    return completeCueGroups[0]?.cueFileName || null;
  if (completeCueGroups.length === 0 && inspection.standaloneEntries.length === 1)
    return inspection.standaloneEntries[0]?.filename || null;
  if (completeCueGroups.length === 0 && inspection.romEntries.length === 1)
    return inspection.romEntries[0]?.filename || null;
  throw new Error(`${archiveFileName || "Archive"} contains multiple input candidates`);
};

const resolveArchiveInput = async (
  file: PatchFileInstance,
  role: "rom" | "patch",
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedArchiveEntry?: string,
  sourceIndex = 0,
  nested: NestedArchiveOptions = {},
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
  const depth = nested.depth || 0;
  assertArchiveDepth(options, depth);
  markCompressedArchiveVisit(file, options, nested, "input.archive.resolve.stall");
  traceArchivePreparation(options, "input.archive.resolve.start", {
    archivePath: nested.archivePath || [],
    depth,
    file: describeArchiveFileForTrace(file),
    role,
    selectedArchiveEntry: selectedArchiveEntry || "",
    sourceIndex,
  });
  const entries = await listCompressionEntries(file, options, runtime);
  trackArchiveEntries(options, nested, entries);
  const selectedPath = selectedArchiveEntry ? parseNestedArchiveSelectionPath(selectedArchiveEntry) : null;
  const selectedEntryName = selectedPath?.[0] || selectedArchiveEntry || "";
  const romInspection =
    role === "rom" ? await inspectCompressionRomEntriesForSource(file, entries, options, runtime) : null;
  const nestedContainerCandidates = romInspection?.nestedCompressionEntries || filterNestedContainerEntries(entries);
  const candidates =
    role === "patch"
      ? await filterValidPatchArchiveEntriesForSource(file, entries, options, runtime)
      : romInspection?.romEntries || nestedContainerCandidates;
  const patchFallbackCandidates = role === "patch" && !candidates.length ? filterPatchLikeEntries(entries) : [];
  const selectableCandidates = candidates.length ? candidates : nestedContainerCandidates;
  const selectionCandidates = selectableCandidates.length ? selectableCandidates : patchFallbackCandidates;
  trackArchiveCandidates(options, nested, selectionCandidates);
  traceArchivePreparation(options, "input.archive.resolve.candidates", {
    candidateCount: candidates.length,
    depth,
    file: describeArchiveFileForTrace(file),
    nestedContainerCandidateCount: nestedContainerCandidates.length,
    role,
    selectedEntryName,
    selectionCandidateCount: selectionCandidates.length,
    selectionCandidateSample: summarizeEntryNames(selectionCandidates),
    sourceIndex,
  });

  if (selectedEntryName) {
    assertArchiveEntryFileSize(
      options,
      entries.find((entry) => entry.filename === selectedEntryName),
      selectedEntryName,
    );
    if (role === "patch") {
      const cachedPatch = await takeValidatedPatchArchiveEntry(file, selectedEntryName);
      if (cachedPatch) return cachedPatch;
    }
    const selected = await extractArchiveEntry(file, selectedEntryName, undefined, options, runtime);
    traceArchivePreparation(options, "input.archive.resolve.selected", {
      depth,
      extracted: describeArchiveFileForTrace(selected),
      file: describeArchiveFileForTrace(file),
      role,
      selectedEntryName,
      sourceIndex,
    });
    if (isCompressionFile(selected)) {
      const nestedSelection =
        selectedPath && selectedPath.length > 1
          ? serializeNestedArchiveSelectionPath(selectedPath.slice(1))
          : undefined;
      traceArchivePreparation(options, "input.archive.resolve.recurse", {
        depth,
        file: describeArchiveFileForTrace(selected),
        nestedSelection: nestedSelection || "",
        reason: "selected-entry-is-compression",
        role,
        selectedEntryName,
        sourceIndex,
      });
      return resolveArchiveInput(selected, role, options, runtime, nestedSelection, sourceIndex, {
        ...nested,
        archivePath: [...(nested.archivePath || []), selectedEntryName],
        breadcrumbs: getDisplayBreadcrumbs(nested, selectedEntryName),
        depth: depth + 1,
      });
    }
    return selected;
  }
  if (role === "patch" && candidates.length !== 1) {
    reportInputCandidates(options, {
      candidates: selectionCandidates.map((entry) => ({
        breadcrumbs: getDisplayBreadcrumbs(nested, entry.filename),
        fileName: entry.filename,
        id: makeInputId(sourceIndex, entry.filename, normalizeArchiveEntryName),
        kind: "patch",
        path: getSelectionPath(nested, entry.filename),
        selectable: true,
        size: "size" in entry ? entry.size : undefined,
        type: "file",
      })),
      role: "patch",
      sourceIndex,
      sourceName: file.fileName || `patch-${sourceIndex + 1}`,
      warnings: [],
    });
  }
  const autoPickedRomEntryName =
    role === "rom" && romInspection
      ? resolveCompressionRomAutoPickEntryName(file.fileName, romInspection, selectedEntryName)
      : null;
  const cueGroup =
    role === "rom" && romInspection
      ? resolveCompressionRomCueGroup(
          romInspection.cueGroups.filter((group) => isCompleteCueGroup(group)),
          autoPickedRomEntryName || "",
        ) || null
      : null;
  const cueEntryName = cueGroup?.cueFileName || null;
  if (role === "rom" && cueEntryName && cueGroup) {
    const cueEntry = entries.find((entry) => entry.filename === cueEntryName);
    if (!cueEntry) throw new Error(`${file.fileName || "Archive"} does not contain a CUE entry`);
    if (!cueGroup.cueText && cueGroup.references) {
      const reference = cueGroup.references.find((entry) => entry.patchable !== false) || cueGroup.references[0];
      const trackEntry = reference ? findArchiveEntryByFileName(entries, cueEntryName, reference.fileName) : null;
      const trackEntryName = String(trackEntry?.filename || "");
      if (!trackEntryName) throw new Error(`CUE file references missing archive entry: ${reference?.fileName || ""}`);
      traceArchivePreparation(options, "input.archive.resolve.cue", {
        binEntryName: trackEntryName,
        cueEntryName,
        depth,
        file: describeArchiveFileForTrace(file),
        role,
        sourceIndex,
        trackReferenceCount: cueGroup.references.length,
      });
      const [cueFile, binFile] = await extractCompressionEntries(
        file,
        [cueEntryName, trackEntryName],
        options,
        runtime,
      );
      if (!binFile) throw new Error(`Archive entry data is not available: ${trackEntryName}`);
      (binFile as { _archiveCueEntryName?: string })._archiveCueEntryName = cueEntryName;
      (binFile as { _chdMode?: string })._chdMode = "cd";
      (binFile as { _chdCueText?: string })._chdCueText = cueFile ? decodeUtf8(getPatchFileBytes(cueFile)) : "";
      (binFile as { _chdCueFileName?: string })._chdCueFileName = getBaseFileName(cueEntryName);
      return binFile;
    }
    const cueText =
      cueGroup.cueText || decodeUtf8(await extractArchiveEntryBytes(file, cueEntryName, options, runtime));
    const cueInfo = findCueBinEntry(cueEntryName, cueText, entries);
    const binEntryName = String(cueInfo.binEntry.filename || "");
    traceArchivePreparation(options, "input.archive.resolve.cue", {
      binEntryName,
      cueEntryName,
      depth,
      file: describeArchiveFileForTrace(file),
      role,
      sourceIndex,
      trackReferenceCount: parseCueFileReferences(cueInfo.cueText).length,
    });
    const binFile = await extractArchiveEntry(
      file,
      binEntryName,
      getBaseFileName(cueInfo.plan.fileName || binEntryName),
      options,
      runtime,
    );
    (binFile as { _archiveCueEntryName?: string })._archiveCueEntryName = cueEntryName;
    (binFile as { _chdMode?: string })._chdMode = "cd";
    (binFile as { _chdCueText?: string })._chdCueText = cueInfo.cueText;
    (binFile as { _chdCueFileName?: string })._chdCueFileName = getBaseFileName(cueEntryName);
    return binFile;
  }
  if (role === "rom" && !selectedEntryName && autoPickedRomEntryName) {
    const autoPickedEntry = candidates.find((entry) => entry.filename === autoPickedRomEntryName);
    if (autoPickedEntry) {
      assertArchiveEntryFileSize(options, autoPickedEntry, autoPickedEntry.filename);
      const extracted = await extractArchiveEntry(file, autoPickedEntry.filename, undefined, options, runtime);
      traceArchivePreparation(options, "input.archive.resolve.autopick", {
        autoPickedEntryName: autoPickedEntry.filename,
        depth,
        extracted: describeArchiveFileForTrace(extracted),
        file: describeArchiveFileForTrace(file),
        role,
        sourceIndex,
      });
      if (isCompressionFile(extracted))
        traceArchivePreparation(options, "input.archive.resolve.recurse", {
          autoPickedEntryName: autoPickedEntry.filename,
          depth,
          file: describeArchiveFileForTrace(extracted),
          reason: "autopicked-entry-is-compression",
          role,
          sourceIndex,
        });
      if (isCompressionFile(extracted))
        return resolveArchiveInput(extracted, role, options, runtime, undefined, sourceIndex, {
          ...nested,
          archivePath: [...(nested.archivePath || []), autoPickedEntry.filename],
          breadcrumbs: getDisplayBreadcrumbs(nested, autoPickedEntry.filename),
          depth: depth + 1,
        });
      return extracted;
    }
  }
  if (selectionCandidates.length !== 1) {
    throw new Error(
      `${file.fileName || "Archive"} contains ${selectionCandidates.length ? "multiple" : "no"} ${role} candidates`,
    );
  }
  const candidate = selectionCandidates[0];
  if (!candidate) throw new Error(`${file.fileName || "Archive"} contains no ${role} candidates`);
  assertArchiveEntryFileSize(options, candidate, candidate.filename);
  if (role === "patch") {
    const cachedPatch = await takeValidatedPatchArchiveEntry(file, candidate.filename);
    if (cachedPatch) return cachedPatch;
  }
  const extracted = await extractArchiveEntry(file, candidate.filename, undefined, options, runtime);
  traceArchivePreparation(options, "input.archive.resolve.default", {
    candidateEntryName: candidate.filename,
    depth,
    extracted: describeArchiveFileForTrace(extracted),
    file: describeArchiveFileForTrace(file),
    role,
    sourceIndex,
  });
  if (isCompressionFile(extracted))
    traceArchivePreparation(options, "input.archive.resolve.recurse", {
      candidateEntryName: candidate.filename,
      depth,
      file: describeArchiveFileForTrace(extracted),
      reason: "default-candidate-is-compression",
      role,
      sourceIndex,
    });
  if (isCompressionFile(extracted))
    return resolveArchiveInput(extracted, role, options, runtime, undefined, sourceIndex, {
      ...nested,
      archivePath: [...(nested.archivePath || []), candidate.filename],
      breadcrumbs: getDisplayBreadcrumbs(nested, candidate.filename),
      depth: depth + 1,
    });
  return extracted;
};

const reportInputCandidates = (options: InputPreparationOptions, request: CandidateSelectionRequest) => {
  if (typeof options?.onCandidatesFound === "function") options.onCandidatesFound(request);
};

const inspectArchiveInput = async (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  sourceIndex: number,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  nested: NestedArchiveOptions = {},
) => {
  assertArchiveDepth(options, nested.depth || 0);
  markCompressedArchiveVisit(archiveFile, options, nested, "input.archive.inspect.stall");
  const entries = await listCompressionEntries(archiveFile, options, runtime);
  trackArchiveEntries(options, nested, entries);
  const romInspection = await inspectCompressionRomEntriesForSource(archiveFile, entries, options, runtime);
  const directRomEntries = romInspection.directRomEntries;
  const nestedContainerEntries = romInspection.nestedCompressionEntries;
  const romEntries = romInspection.romEntries;
  if (!directRomEntries.length && nestedContainerEntries.length === 1) {
    const nestedEntry = nestedContainerEntries[0];
    if (!nestedEntry) throw new Error(`${archiveFile.fileName || "Archive"} contains no input candidates`);
    assertArchiveEntryFileSize(options, nestedEntry, nestedEntry.filename);
    const extracted = await extractArchiveEntry(archiveFile, nestedEntry.filename, undefined, options, runtime);
    return inspectArchiveInput(extracted, options, sourceIndex, runtime, {
      ...nested,
      archivePath: [...(nested.archivePath || []), nestedEntry.filename],
      breadcrumbs: getDisplayBreadcrumbs(nested, nestedEntry.filename),
      depth: (nested.depth || 0) + 1,
    });
  }
  trackArchiveCandidates(options, nested, romEntries);
  const candidates: SelectionFileCandidate[] = [];
  const groups: CueCandidateGroup[] = [];
  const warnings: string[] = [];

  for (const entry of romEntries as Array<{
    filename: string;
    size?: number;
  }>) {
    const entryName = String(entry.filename || "");
    if (!entryName) continue;
    if (isCueEntryFileName(entryName)) {
      const groupId = makeInputId(sourceIndex, entryName, normalizeArchiveEntryName, "-group");
      const cachedCueGroup = romInspection.cueGroups.find(
        (group) => group.cueFileName === entryName && (typeof group.cueText === "string" || !!group.references),
      );
      const cueText =
        cachedCueGroup?.cueText ||
        (cachedCueGroup?.references
          ? ""
          : decodeUtf8(await extractArchiveEntryBytes(archiveFile, entryName, options, runtime)));
      const references = cachedCueGroup?.references || parseCueFileReferences(cueText);
      const trackFileNames: string[] = [];
      const missingReferences: string[] = [];
      candidates.push({
        breadcrumbs: getDisplayBreadcrumbs(nested, entryName),
        fileName: entryName,
        id: `${groupId}-cue`,
        kind: "cue",
        parentCandidateId: groupId,
        patchable: false,
        path: getSelectionPath(nested, entryName),
        selectable: false,
        size: entry.size,
        type: "file",
      });
      for (const reference of references) {
        const trackEntry = findArchiveEntryByFileName(entries, entryName, reference.fileName) as
          | { filename: string; size?: number }
          | undefined;
        if (trackEntry) {
          trackFileNames.push(trackEntry.filename);
          candidates.push({
            breadcrumbs: getDisplayBreadcrumbs(nested, trackEntry.filename),
            fileName: trackEntry.filename,
            id: makeInputId(sourceIndex, trackEntry.filename, normalizeArchiveEntryName),
            kind: "track",
            parentCandidateId: groupId,
            patchable: reference.patchable,
            path: getSelectionPath(nested, trackEntry.filename),
            selectable: reference.patchable !== false,
            size: trackEntry.size,
            type: "file",
          });
        } else {
          missingReferences.push(reference.fileName);
          candidates.push({
            breadcrumbs: getDisplayBreadcrumbs(nested, `${getDirectoryPath(entryName)}${reference.fileName}`),
            fileName: `${getDirectoryPath(entryName)}${reference.fileName}`,
            id: makeInputId(
              sourceIndex,
              `${getDirectoryPath(entryName)}${reference.fileName}`,
              normalizeArchiveEntryName,
            ),
            kind: "track",
            parentCandidateId: groupId,
            patchable: reference.patchable,
            path: getSelectionPath(nested, `${getDirectoryPath(entryName)}${reference.fileName}`),
            reason: "Missing referenced file",
            selectable: false,
            type: "file",
          });
        }
      }
      if (missingReferences.length)
        warnings.push(`${entryName} references missing file(s): ${missingReferences.join(", ")}`);
      groups.push(
        makeInputCandidateGroup({
          breadcrumbs: getDisplayBreadcrumbs(nested, entryName),
          cueFileName: entryName,
          groupId,
          missingReferences,
          patchable: missingReferences.length === 0 && references.some((reference) => reference.patchable),
          path: getSelectionPath(nested, entryName),
          trackFileNames,
        }),
      );
    } else {
      candidates.push({
        breadcrumbs: getDisplayBreadcrumbs(nested, entryName),
        fileName: entryName,
        id: makeInputId(sourceIndex, entryName, normalizeArchiveEntryName),
        kind: "rom",
        patchable: true,
        path: getSelectionPath(nested, entryName),
        selectable: true,
        size: entry.size,
        type: "file",
      });
    }
  }

  reportInputCandidates(options, {
    candidates: [...candidates, ...groups],
    role: "input",
    sourceName: archiveFile.fileName || `input-${sourceIndex + 1}`,
    warnings,
  });

  return {
    archiveFile,
    archivePath: nested.archivePath || [],
    breadcrumbs: nested.breadcrumbs || [],
    entries,
    groups,
    romEntries,
    romInspection,
  };
};

const resolveArchiveInputAssets = async (
  archiveFile: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  sourceIndex: number,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedInputEntryName?: string,
  nested: NestedArchiveOptions = {},
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
  const depth = nested.depth || 0;
  assertArchiveDepth(options, depth);
  traceArchivePreparation(options, "input.archive.assets.start", {
    archivePath: nested.archivePath || [],
    depth,
    file: describeArchiveFileForTrace(archiveFile),
    selectedInputEntryName: selectedInputEntryName || "",
    sourceIndex,
  });
  const inspection = await inspectArchiveInput(archiveFile, options, sourceIndex, runtime, { ...nested, depth });
  const inspectedArchiveFile = inspection.archiveFile;
  const selectedPath = selectedInputEntryName ? parseNestedArchiveSelectionPath(selectedInputEntryName) : null;
  const selectedPathIndex = selectedPath ? inspection.archivePath.length : 0;
  const selectedEntryName = selectedPath?.[selectedPathIndex] || (selectedPath ? "" : selectedInputEntryName || "");
  const completeGroups = inspection.romInspection.cueGroups.filter((group) => isCompleteCueGroup(group));
  const selectedAnyGroup = selectedEntryName
    ? inspection.romInspection.cueGroups.find((group) => isCueGroupSelectionMatch(group, selectedEntryName))
    : null;
  traceArchivePreparation(options, "input.archive.assets.inspect", {
    completeCueGroupCount: completeGroups.length,
    depth,
    file: describeArchiveFileForTrace(inspectedArchiveFile),
    romEntryCount: inspection.romEntries.length,
    selectedEntryName,
    sourceIndex,
  });
  if (selectedAnyGroup?.missingReferences.length)
    throw new Error(`CUE file references missing file(s): ${selectedAnyGroup.missingReferences.join(", ")}`);

  const standaloneCandidates = inspection.romInspection.standaloneEntries;
  traceArchivePreparation(options, "input.archive.assets.candidates", {
    completeCueGroupCount: completeGroups.length,
    depth,
    file: describeArchiveFileForTrace(inspectedArchiveFile),
    selectedEntryName,
    sourceIndex,
    standaloneCandidateCount: standaloneCandidates.length,
  });
  let selectedGroup = null;
  if (selectedEntryName) {
    selectedGroup = completeGroups.find((group) => isCueGroupSelectionMatch(group, selectedEntryName));
  } else if (completeGroups.length === 1 && standaloneCandidates.length === 0) {
    selectedGroup = completeGroups[0] || null;
  }

  if (selectedGroup) {
    const cueEntryName = selectedGroup.cueFileName;
    traceArchivePreparation(options, "input.archive.assets.cue", {
      cueEntryName,
      depth,
      file: describeArchiveFileForTrace(inspectedArchiveFile),
      sourceIndex,
      trackReferenceCount: selectedGroup.references?.length || 0,
    });
    const initialReferences = selectedGroup.references || null;
    const resolveTrackEntries = (references: NonNullable<CompressionRomCueGroup["references"]>) =>
      references.map((reference) => {
        const trackEntry = findArchiveEntryByFileName(
          inspection.entries,
          selectedGroup.cueFileName,
          reference.fileName,
        ) as { filename: string } | undefined;
        if (!trackEntry) throw new Error(`CUE file references missing archive entry: ${reference.fileName}`);
        return trackEntry;
      });
    if (!selectedGroup.cueText && initialReferences) {
      const trackEntries = resolveTrackEntries(initialReferences);
      const extractedFiles = await extractCompressionEntries(
        inspectedArchiveFile,
        [cueEntryName, ...trackEntries.map((trackEntry) => trackEntry.filename)],
        options,
        runtime,
      );
      const cueFile = extractedFiles[0];
      if (!cueFile) throw new Error(`Archive entry data is not available: ${cueEntryName}`);
      cueFile.fileName = getBaseFileName(cueEntryName);
      const cueText = decodeUtf8(getPatchFileBytes(cueFile));
      const groupId = makeInputId(sourceIndex, cueEntryName, normalizeArchiveEntryName, "-group");
      const cueAsset = makeCueAsset(`${groupId}-cue`, cueFile.fileName, cueFile, groupId, cueText);
      const assets: InputAsset[] = [];
      trackEntries.forEach((trackEntry, index) => {
        const trackFile = extractedFiles[index + 1];
        if (!trackFile) throw new Error(`Archive entry data is not available: ${trackEntry.filename}`);
        const reference = initialReferences[index] || {
          fileName: trackEntry.filename,
          patchable: true,
        };
        assets.push(
          makeTrackAsset(
            makeInputId(sourceIndex, trackEntry.filename, normalizeArchiveEntryName),
            trackFile.fileName,
            trackFile,
            groupId,
            reference,
          ),
        );
      });
      assets.push(cueAsset);
      traceArchivePreparation(options, "input.archive.assets.cue.finish", {
        assetCount: assets.length,
        cueEntryName,
        depth,
        file: describeArchiveFileForTrace(inspectedArchiveFile),
        sourceIndex,
      });
      return assets;
    }
    const cueData = selectedGroup.cueText
      ? new TextEncoder().encode(selectedGroup.cueText)
      : await extractArchiveEntryBytes(inspectedArchiveFile, cueEntryName, options, runtime);
    const cueFile = createArchiveEntryPatchFileFromBytes(
      cueData,
      inspectedArchiveFile,
      cueEntryName,
      getBaseFileName(cueEntryName),
    );
    const cueText = selectedGroup.cueText || decodeUtf8(cueData);
    const references = selectedGroup.references || parseCueFileReferences(cueText);
    const trackEntries = resolveTrackEntries(references);
    const groupId = makeInputId(sourceIndex, cueEntryName, normalizeArchiveEntryName, "-group");
    const cueAsset = makeCueAsset(`${groupId}-cue`, cueFile.fileName, cueFile, groupId, cueText);
    const assets: InputAsset[] = [];
    for (const [index, reference] of references.entries()) {
      const trackEntry = trackEntries[index];
      if (!trackEntry) continue;
      const trackFile = await extractArchiveEntry(
        inspectedArchiveFile,
        trackEntry.filename,
        getBaseFileName(reference.fileName),
        options,
        runtime,
      );
      assets.push(
        makeTrackAsset(
          makeInputId(sourceIndex, trackEntry.filename, normalizeArchiveEntryName),
          trackFile.fileName,
          trackFile,
          groupId,
          reference,
        ),
      );
    }
    assets.push(cueAsset);
    traceArchivePreparation(options, "input.archive.assets.cue.finish", {
      assetCount: assets.length,
      cueEntryName,
      depth,
      file: describeArchiveFileForTrace(inspectedArchiveFile),
      sourceIndex,
    });
    return assets;
  }

  if (!selectedEntryName && completeGroups.length)
    throw new Error(`${inspectedArchiveFile.fileName || "Archive"} contains multiple input candidates`);

  const createRomAssetFromEntry = async (entryName: string) => {
    assertArchiveEntryFileSize(
      options,
      inspection.entries.find((entry) => entry.filename === entryName),
      entryName,
    );
    const startedAt = Date.now();
    const extracted = await extractArchiveEntry(inspectedArchiveFile, entryName, undefined, options, runtime);
    const durationMs = Date.now() - startedAt;
    traceArchivePreparation(options, "input.archive.assets.entry", {
      decompressionTimeMs: durationMs,
      depth,
      entryName,
      extracted: describeArchiveFileForTrace(extracted),
      file: describeArchiveFileForTrace(inspectedArchiveFile),
      sourceIndex,
    });
    if (isCompressionFile(extracted)) {
      const nestedSelection =
        selectedPath && selectedPath.length > selectedPathIndex + 1 ? selectedInputEntryName : undefined;
      traceArchivePreparation(options, "input.archive.assets.recurse", {
        depth,
        entryName,
        file: describeArchiveFileForTrace(extracted),
        nestedSelection: nestedSelection || "",
        sourceIndex,
      });
      const nestedAssets = await resolveArchiveInputAssets(extracted, options, sourceIndex, runtime, nestedSelection, {
        ...nested,
        archivePath: [...inspection.archivePath, entryName],
        breadcrumbs: getDisplayBreadcrumbs({ breadcrumbs: inspection.breadcrumbs }, entryName),
        depth: inspection.archivePath.length + 1,
      });
      return prependCompressionStepMetrics(
        nestedAssets,
        createParentCompressionStep(inspectedArchiveFile, extracted, durationMs),
      );
    }
    traceArchivePreparation(options, "input.archive.assets.entry.finish", {
      depth,
      entryName,
      file: describeArchiveFileForTrace(extracted),
      sourceIndex,
    });
    return prependCompressionStepMetrics(
      [makeRomAsset(makeInputId(sourceIndex, extracted.fileName, normalizeArchiveEntryName), extracted)],
      createParentCompressionStep(inspectedArchiveFile, extracted, durationMs),
    );
  };
  if (selectedEntryName) return createRomAssetFromEntry(selectedEntryName);
  if (standaloneCandidates.length !== 1) {
    throw new Error(
      `${inspectedArchiveFile.fileName || "Archive"} contains ${standaloneCandidates.length ? "multiple" : "no"} input candidates`,
    );
  }
  const candidate = standaloneCandidates[0];
  if (!candidate) throw new Error(`${inspectedArchiveFile.fileName || "Archive"} contains no input candidates`);
  return createRomAssetFromEntry(candidate.filename);
};

const prepareAutoPatchInputs = async (
  source: SourceRef,
  options: ApplyWorkflowOptions | undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<PatchFileInstance[]> => {
  const archiveFile = await createPatchFile(source, "input.bin");
  if (options?.input?.containerInputsEnabled === false || !isCompressionFile(archiveFile)) return [];
  const entries = await listCompressionEntries(archiveFile, options, runtime);
  const romInspection = await inspectCompressionRomEntriesForSource(archiveFile, entries, options, runtime);
  const patchEntries = await filterValidPatchArchiveEntriesForSource(archiveFile, entries, options, runtime);
  if (!patchEntries.length) return [];
  const selectedRomEntryName = resolveCompressionRomAutoPickEntryName(archiveFile.fileName, romInspection, "");
  if (!selectedRomEntryName) return [];

  const sidecarPatches = resolveSidecarPatchEntries(selectedRomEntryName, patchEntries);
  const patchFiles: PatchFileInstance[] = [];
  for (const sidecarPatch of sidecarPatches) {
    const entryName = sidecarPatch.entry.filename;
    if (!entryName) continue;
    const patchFile = await extractArchiveEntry(archiveFile, entryName, undefined, options, runtime);
    applySidecarPatchOutputLabel(patchFile, sidecarPatch.outputLabel);
    patchFiles.push(patchFile);
  }
  return patchFiles;
};

export { prepareAutoPatchInputs, reportInputCandidates, resolveArchiveInput, resolveArchiveInputAssets };
