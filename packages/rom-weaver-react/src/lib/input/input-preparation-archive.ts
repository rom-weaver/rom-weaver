import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { SourceObject, SourceRef } from "../../types/source.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import type { ExtractedFileEntry, ExtractStepDetails } from "../../wasm/index.ts";
import { createArchiveSourceBlob } from "../archive-utils.ts";
import { CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS } from "../compression/container-format-registry.ts";
import { getPathBaseName } from "../path-utils.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { isCueEntryFileName, isGdiEntryFileName } from "./archive.ts";
import type { PatchFileInstance } from "./binary-service.ts";
import {
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
import { buildDescentParentCompressions, type DescentExtractStep } from "./input-archive-descent-chain.ts";
import {
  probeCompressionRomEntriesForSource,
  resolveChdSplitBinSelection,
  resolveCompressionRomAutoPickEntryName,
} from "./input-archive-disc-groups.ts";
import { assertDescentOutputLimits, preflightArchiveLimitsForDescent } from "./input-archive-limits.ts";
import {
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  resolvePatchArchiveLeaf,
} from "./input-archive-patch-leaves.ts";
import { filterValidPatchArchiveEntriesForSource } from "./input-archive-patch-validity.ts";
import { getZ3dsOutputPathFileName } from "./input-archive-z3ds-paths.ts";
import {
  attachInputPreparationMetrics,
  type InputAsset,
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
import { getBaseFileName, normalizeArchiveEntryName } from "./path-utils.ts";
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
const PATH_BACKED_COMPRESSION_FORMATS = new Set<string>(CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS);
const SYNC_READ_ARCHIVE_ENTRY_REGEX =
  /\.(?:cue|ips|ups|bps|aps|rup|ppf|ebp|bdf|bsp|bspatch|mod|xdelta|delta|dat|vcdiff)\d*$/i;
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

const isCompressionEntryFileName = (fileName: string) => classifyPatcherInput({ fileName }).kind === "compression";

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

/**
 * List a dropped archive's entry file names (a pure read — no byte extraction) so the drop router
 * can decide its bucket (ROM source vs patch bundle) from the archive's CONTENTS before staging it.
 * Routing a patch-only archive into the ROM input list would re-stage (re-extract) the already
 * staged ROM and briefly flash a ROM card before Rust's probe-manifest reclassifies it. Cheap and
 * cached — the listing is shared with the later staging descent via the `_file` key — so a real ROM
 * archive only pays one list here, then extracts once. Returns [] on any failure so the caller
 * falls back to the default (ROM) bucket, where Rust's reclassify still corrects a misroute.
 */
const listDroppedArchiveEntryNames = async (source: SourceRef): Promise<string[]> => {
  const file = await createPatchFile(source as Parameters<typeof createPatchFile>[0], "archive.bin");
  const entries = await listCompressionEntries(file, undefined);
  return entries
    .map((entry) => (typeof entry === "string" ? entry : String((entry as { filename?: string }).filename || "")))
    .filter((name) => !!name);
};

// Memoize entry listings per (source bytes, filter + overrides). One input load enumerates the same
// archive several times — the drop-routing probe classifies it, then chd-split detection, disc-group
// naming, and the limit preflight each re-list it — and every pass is a full worker round-trip that
// returns identical entries (the archive is immutable). Key on the underlying File/Blob (`_file`) when
// present so the probe's listing and the prep's descent share one result even though they wrap the
// dropped file in different PatchFileInstances; fall back to the instance when there is no shared
// blob. Parity-safe: listing is a pure read that never affects extracted bytes. A transient failure is
// evicted so a retry re-lists.
const listEntryResultCache = new WeakMap<object, Map<string, ReturnType<typeof computeListCompressionEntryResult>>>();

const getListEntryCacheKeyObject = (file: PatchFileInstance): object => (file as { _file?: object })._file ?? file;

const listCompressionEntryResult = (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  kindFilter: CompressionEntryKindFilter = {},
  overrides: CompressionExtractOverrides = {},
): ReturnType<typeof computeListCompressionEntryResult> => {
  const keyObject = getListEntryCacheKeyObject(file);
  let perFile = listEntryResultCache.get(keyObject);
  if (!perFile) {
    perFile = new Map();
    listEntryResultCache.set(keyObject, perFile);
  }
  const cacheKey = `${!!kindFilter.romFilter}|${!!kindFilter.patchFilter}|${JSON.stringify(overrides ?? {})}`;
  const existing = perFile.get(cacheKey);
  if (existing) return existing;
  const pending = computeListCompressionEntryResult(file, options, runtime, kindFilter, overrides);
  perFile.set(cacheKey, pending);
  void pending.catch(() => {
    if (perFile?.get(cacheKey) === pending) perFile.delete(cacheKey);
  });
  return pending;
};

const computeListCompressionEntryResult = async (
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

// ts-rs maps Rust `u64` to `bigint`, but these byte counts arrive over JSON as plain numbers; coerce
// whatever the runtime delivers (number or bigint) to a finite number, defaulting to 0.
const toFiniteBytes = (value: ExtractedFileEntry["size_bytes"] | undefined): number => {
  const numeric = typeof value === "bigint" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : 0;
};

// The `extract_step` payload is typed end-to-end (Rust `ExtractStepDetails`); the wire value still
// arrives as `unknown`, so this guards shape at runtime and hands back the generated type so field
// access below is compile-checked against the Rust producer. Returns `null` for any non-`succeeded`
// step (the `running` step fires before the work and carries no outputs/time).
const readSucceededExtractStep = (progressDetails: unknown): ExtractStepDetails | null => {
  const step = isRecord(progressDetails) ? (progressDetails as { extract_step?: unknown }).extract_step : undefined;
  if (!(isRecord(step) && step.status === "succeeded" && typeof step.source_name === "string" && step.source_name)) {
    return null;
  }
  return step as unknown as ExtractStepDetails;
};

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
  // With no pinned entry the Rust descend keeps a loose bin+cue/gdi disc whole on its own (a disc
  // is one logical payload, so the sheet + every track extract together — see the
  // `extract_emits_disc_group_structure` cli_smoke proof), so the host no longer pre-expands the
  // disc group itself.
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
  const steps: DescentExtractStep[] = [];
  let totalDescentOutputBytes = 0;
  const runtimeOptions = getCompressionRuntimeOptions(
    options,
    { chdSplitBin: chdSelection.chdSplitBin },
    { romFilter: true },
  );
  const forwardProgress = runtimeOptions.onProgress;
  runtimeOptions.onProgress = (progress) => {
    const details = isRecord(progress) ? (progress as { details?: unknown }).details : undefined;
    const step = readSucceededExtractStep(details);
    if (step) {
      const outputs = Array.isArray(step.outputs) ? step.outputs : [];
      const outputSize = outputs.reduce((total, output) => total + toFiniteBytes(output?.size_bytes), 0);
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
        ...(step.extract_time_ms !== null &&
        step.extract_time_ms !== undefined &&
        Number.isFinite(Number(step.extract_time_ms))
          ? { extractTimeMs: Number(step.extract_time_ms) }
          : {}),
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
    // Prefer the sheet text Rust extract folded into the output (`attach_disc_group_details`); only
    // fall back to reading + decoding the extracted sheet when it is absent (e.g. a non-libarchive
    // container that does not carry it).
    const cueText = cueFile
      ? ((cueFile as { _cueText?: string })._cueText ?? decodeUtf8(getPatchFileBytes(cueFile)))
      : undefined;
    const gdiText = gdiFile
      ? ((gdiFile as { _gdiText?: string })._gdiText ?? decodeUtf8(getPatchFileBytes(gdiFile)))
      : undefined;
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
  const parentCompressions = buildDescentParentCompressions({ archiveFile, files, outputs, steps });
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
  let selectedRomEntryName: string | null;
  try {
    selectedRomEntryName = resolveCompressionRomAutoPickEntryName(archiveFile.fileName, romProbe, "");
  } catch {
    // Multiple competing ROMs: sidecar patches cannot be attributed to one ROM until the user
    // keeps a single ROM, so skip implicit patch discovery and let the ROM descent prompt first.
    return [];
  }
  if (!selectedRomEntryName) return [];

  const sidecarPatches = await resolveSidecarPatchEntries(selectedRomEntryName, patchEntries);
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

/**
 * Whether an archive holds at least one valid, selectable patch — the gate the UI's implicit-patch
 * discovery uses to decide a ROM-bearing archive should surface its patches through the patch
 * selection flow (1 auto-adds, 2+ prompts). Unlike {@link prepareAutoPatchInputs} (which name-matches
 * sidecars for the non-interactive apply execution), this never attributes by name — the user picks.
 * Path-backed disc images (chd/rvz/z3ds) never carry sidecar patches, so they short-circuit to false.
 */
const archiveHasSelectablePatches = async (
  source: SourceRef,
  options: ApplyWorkflowOptions | undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<boolean> => {
  const archiveFile = await createPatchFile(source, "input.bin");
  if (options?.input?.containerInputsEnabled === false || !isCompressionFile(archiveFile)) return false;
  if (PATH_BACKED_COMPRESSION_FORMATS.has(getCompressionFormat(archiveFile))) return false;
  const patchEntries = await filterValidPatchArchiveEntriesForSource(archiveFile, options, runtime).catch(() => []);
  return patchEntries.length > 0;
};

// Shared low-level archive primitives consumed by the sibling modules split out of this orchestrator
// (input-archive-limits, input-archive-disc-groups, input-archive-patch-leaves). Not part of the
// public input-preparation surface — internal to the input-archive cluster.
export type {
  ArchiveEntryLike,
  ChdCodecMode,
  CompressionEntryKindFilter,
  CompressionRomCueGroup,
  CompressionRomProbe,
  CueGroupSelectionMatch,
  InputPreparationOptions,
  InputPreparationRuntimeLike,
};
export {
  archiveHasSelectablePatches,
  describeArchiveFileForTrace,
  extractArchiveEntry,
  extractArchiveEntryBytes,
  filterNestedContainerEntries,
  findArchiveEntryByName,
  getCompressionFormat,
  getCompressionRuntimeOptions,
  getCompressionRuntimeSource,
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  isCompressionEntryFileName,
  isCompressionFile,
  listCompressionEntries,
  listCompressionEntryResult,
  listDroppedArchiveEntryNames,
  normalizeSelectedEntryNames,
  prepareAutoPatchInputs,
  resolveArchiveInput,
  resolveArchiveInputAssets,
  traceArchivePreparation,
};
