import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { SourceObject, SourceRef } from "../../types/source.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import type { ExtractedFileEntry, ExtractStepDetails } from "../../wasm/index.ts";
import { createArchiveSourceBlob } from "../archive-utils.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { romTypeFromEmittedFile } from "../runtime/run-result-parsing.ts";
import { isCueEntryFileName, isGdiEntryFileName } from "./archive.ts";
import type { PatchFileInstance } from "./binary-service.ts";
import {
  createPatchFile,
  decodeUtf8,
  getPatchFileBlob,
  getPatchFileBytes,
  getPatchFileExternalSource,
  getPatchFileHandle,
  isLazyExternalPatchFile,
} from "./binary-service.ts";
import { buildDescentParentCompressions, type DescentExtractStep } from "./input-archive-descent-chain.ts";
import {
  buildPatchArchiveLeaves,
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  resolvePatchArchiveLeaf,
} from "./input-archive-patch-leaves.ts";
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

type ArchiveEntryLike = {
  archiveEntryType?: string;
  fileName?: string;
  filename: string;
  size?: number;
};
type InputPreparationOptions = ApplyWorkflowOptions | CreateWorkflowOptions | undefined;
type InputPreparationRuntimeLike = InputPreparationRuntime | Pick<WorkflowRuntime, "name">;
type CompressionExtractOverrides = {
  checksumAlgorithms?: string[];
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
  ...(typeof overrides.interactiveSelectionEnabled === "boolean"
    ? { interactiveSelectionEnabled: overrides.interactiveSelectionEnabled }
    : {}),
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
  if (!resolvedRuntime.compression.probe) throw new Error("Container probe is unavailable");
  const compressionFormat = getCompressionFormat(file);
  traceArchivePreparation(options, "input.archive.list.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(file),
    patchFilter: !!kindFilter.patchFilter,
    romFilter: !!kindFilter.romFilter,
    runtime: resolvedRuntime.name,
  });
  const result = await resolvedRuntime.compression.probe({
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
  return { ...result, entries };
};

const normalizeSelectedEntryNames = (entryNames: readonly string[] | undefined): string[] =>
  (Array.isArray(entryNames) ? entryNames : [])
    .map((entryName) => String(entryName || "").trim())
    .filter((entryName) => !!entryName);

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
  const selectedEntries = normalizeSelectedEntryNames(selectedArchiveEntry ? [selectedArchiveEntry] : []);
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
    options: getCompressionRuntimeOptions(options, {}, kindFilter),
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

/** Discover a compressed archive's input assets with a SINGLE recursive ingest (classify + descend +
 * checksum): the Rust core descends nested containers, resolving one payload per level (auto-pick when
 * unambiguous, host prompt when not, plus the multi-track CHD CD split-bin prompt), and returns the
 * bottom leaf output(s) with checksums. Builds rom assets, or a cue group when the leaf is a CD image
 * (cue + tracks). */
const resolveArchiveInputAssetsByDescent = async (
  archiveFile: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  sourceIndex: number,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
  selectedInputEntryName?: string,
): Promise<InputAsset[]> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.ingest?.run) throw new Error("Ingest runtime is unavailable");
  const compressionFormat = getCompressionFormat(archiveFile);
  // A resolved keep-one selection pins the payload; otherwise ingest auto-picks a single logical
  // payload (a loose bin+cue/gdi disc stays whole) or prompts the host. Multi-track CHD CD split-bin
  // is decided by ingest's own host prompt — no pre-resolution here.
  const select = normalizeSelectedEntryNames(selectedInputEntryName ? [selectedInputEntryName] : []);
  traceArchivePreparation(options, "input.archive.descent.start", {
    compressionFormat,
    file: describeArchiveFileForTrace(archiveFile),
    selectedEntries: select,
    sourceIndex,
  });
  // Capture each `extract-step` ingest emits (one per descended level) for the extraction-tree UI.
  // Each step carries its full `source` path and the `out_dir` it extracted into; the UI relativizes
  // each level's source against the longest matching `out_dir` to show the path inside its parent.
  const steps: DescentExtractStep[] = [];
  const {
    result: ingestResult,
    outputs,
    patchOutputs,
  } = await resolvedRuntime.ingest.run({
    fileName: archiveFile.fileName,
    source: getCompressionRuntimeSource(archiveFile),
    ...(select.length ? { select } : {}),
    logLevel: options?.logging?.level,
    onLog: options?.onLog,
    onProgress: (progress) => {
      const details = isRecord(progress) ? (progress as { details?: unknown }).details : undefined;
      const step = readSucceededExtractStep(details);
      if (step) {
        const stepOutputs = Array.isArray(step.outputs) ? step.outputs : [];
        const outputSize = stepOutputs.reduce((total, output) => total + toFiniteBytes(output?.size_bytes), 0);
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
      options?.onProgress?.(progress as never);
    },
    ...(options?.signal ? { signal: options.signal } : {}),
  });
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
      // The CHD recompress path keys off the disc format; ingest reports each leaf's optical medium.
      const discFormat = ingestResult.assets[index]?.discFormat;
      if (discFormat) file.metadata = { ...file.metadata, format: discFormat };
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
    const cueText = cueFile ? (cueFile.metadata?.cueText ?? decodeUtf8(getPatchFileBytes(cueFile))) : undefined;
    const gdiText = gdiFile ? (gdiFile.metadata?.gdiText ?? decodeUtf8(getPatchFileBytes(gdiFile))) : undefined;
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
  // Harvest the sidecar patches this same ingest pass already extracted (a mixed ROM+patch archive),
  // so the host never re-scans the archive to discover them. The descriptors carry the name-match
  // (`sidecarOrder`) and the leaves are already materialized into `patchOutputs`. Attach to the primary
  // asset; the decompression loop carries them forward to the finalized input.
  if (ingestResult.patches.length && patchOutputs.length && assets[0]) {
    const extractElapsedMs = steps.reduce(
      (total, step) => (typeof step.extractTimeMs === "number" ? total + step.extractTimeMs : total),
      0,
    );
    const sidecarLeaves = await buildPatchArchiveLeaves(
      archiveFile,
      ingestResult.patches,
      patchOutputs,
      extractElapsedMs || undefined,
      options,
      sourceIndex,
    );
    if (sidecarLeaves.length) {
      assets[0].sidecarPatches = sidecarLeaves.map((leaf) => ({
        file: leaf.file,
        parentCompressions: leaf.parentCompressions,
        ...(typeof leaf.sidecarOrder === "number" ? { sidecarOrder: leaf.sidecarOrder } : {}),
      }));
      traceArchivePreparation(options, "input.archive.descent.sidecar-patches", {
        count: sidecarLeaves.length,
        file: describeArchiveFileForTrace(archiveFile),
        names: sidecarLeaves.map((leaf) => leaf.file.fileName),
        sourceIndex,
      });
    }
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

/**
 * Checksum a bare (non-container) ROM via the `ingest` command and attach the resulting
 * checksums/variants/rom-type to the file as precomputed metadata, so the downstream input-checksum
 * step reuses them (the precomputed branch) and skips re-dispatching `ingest` itself.
 *
 * `ingest` classifies the source first; a bare ROM has no container handler, so it is checksummed in
 * place — no extraction, no copy — by the SAME shared variant engine the archive path's inline
 * checksum drives, fed the full thread budget. So a bare ROM hashes as fast as one extracted from an
 * archive (where `romProbe` is likewise absent — `ingest` never produces it, only a `{ trim: {
 * detected: false } }` placeholder was ever emitted for these inputs).
 *
 * Best-effort: any failure, or a source `ingest` classifies as a patch / yields no ROM asset, leaves
 * the file untouched so the input-checksum step checksums it the usual way (a second `ingest` pass).
 */
const attachBareRomIngestMetadata = async (
  file: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<void> => {
  // Already precomputed (e.g. an archive leaf) — nothing to do.
  if ((file as { checksums?: unknown }).checksums) return;
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.ingest?.run) return;
  try {
    let firstProgressAt = 0;
    const startedAt = Date.now();
    const { result } = await resolvedRuntime.ingest.run({
      fileName: file.fileName,
      logLevel: options?.logging?.level,
      onLog: options?.onLog,
      onProgress: (progress) => {
        if (!firstProgressAt) firstProgressAt = Date.now();
        options?.onProgress?.(progress as never);
      },
      source: getCompressionRuntimeSource(file),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const asset = result.isRom ? result.assets[0] : undefined;
    if (!asset) return;
    if (asset.checksums && Object.keys(asset.checksums).length) {
      (file as { checksums?: typeof asset.checksums }).checksums = asset.checksums;
    }
    if (asset.checksumVariants?.length) {
      (file as { checksumVariants?: typeof asset.checksumVariants }).checksumVariants = asset.checksumVariants;
    }
    const romType = romTypeFromEmittedFile({ discFormat: asset.discFormat, platform: asset.platform });
    if (romType) (file as { romType?: typeof romType }).romType = romType;
    // A bare ROM is checksummed in place (no extract), so it carries a real checksum duration — unlike
    // an archive leaf (checksummed DURING extract, reported as 0 → the "from extract" label). Prefer the
    // Rust-reported hash wall time (`asset.checksumMs`); only if it is absent (e.g. older wasm) fall back
    // to the JS compute span (first progress → done, which excludes the one-time wasm/thread warm-up).
    const checksumMs = asset.checksumMs ?? Date.now() - (firstProgressAt || startedAt);
    (file as { _precomputedChecksumMs?: number })._precomputedChecksumMs = checksumMs;
    traceArchivePreparation(options, "input.archive.bare-rom.ingest", {
      checksumMs,
      checksumMsSource: asset.checksumMs === undefined ? "js-fallback" : "rust",
      file: describeArchiveFileForTrace(file),
      hasChecksums: !!asset.checksums,
      platform: asset.platform || "",
      variantCount: asset.checksumVariants?.length ?? 0,
    });
  } catch (error) {
    // Non-fatal: the input-checksum step will checksum the file the usual way.
    traceArchivePreparation(options, "input.archive.bare-rom.ingest-failed", {
      error: error instanceof Error ? error.message : String(error),
      file: describeArchiveFileForTrace(file),
    });
  }
};

// Shared low-level archive primitives consumed by the sibling modules split out of this orchestrator
// (input-archive-patch-leaves). Not part of the public input-preparation surface — internal to the
// input-archive cluster.
export type { InputPreparationOptions, InputPreparationRuntimeLike };
export {
  attachBareRomIngestMetadata,
  describeArchiveFileForTrace,
  getCompressionFormat,
  getCompressionRuntimeSource,
  getPatchLeafFileForSelection,
  getPatchLeafParentCompressionsForSelection,
  isCompressionFile,
  listDroppedArchiveEntryNames,
  resolveArchiveInput,
  resolveArchiveInputAssets,
  traceArchivePreparation,
};
