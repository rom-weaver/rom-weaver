import OutputCompressionManager from "../lib/compression/output-compression-manager.ts";
import {
  isArchiveCompressionFormat,
  type RomSpecificCompressionFormat,
} from "../lib/compression/container-format-registry.ts";
import { toPublicOutput } from "../lib/apply/patch-apply-service.ts";
import { createBlobBackedPatchFile, getPatchFileCleanup } from "../lib/input/binary-service.ts";
import { parseCueFileReferences } from "../lib/input/archive.ts";
import type { InputAsset } from "../lib/input/input-assets.ts";
import { buildSessionOutputFiles, createSingleFileRomSpecificOutput } from "../lib/output/output-build-service.ts";
import { createArchiveOutput } from "../lib/output/archive-output-service.ts";
import { getBaseFileName, getFileNameWithoutExtension } from "../lib/input/path-utils.ts";
import { getChdAutoCreateMode } from "../lib/input/rom-specific-file-utils.ts";
import { isLikelyDiscImageSize } from "../lib/compression/disc-image-policy.ts";
import { ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS } from "../lib/compression/rom-specific-format-support.ts";
import { createLogger } from "../lib/logging.ts";
import { isArchiveFileName } from "../public/react/file-classification.ts";
import type { WorkflowRuntime } from "../types/workflow-runtime-adapter.ts";
import type {
  ApplyWorkflowOptions,
  CompressionWorkflowOptions,
  PublicOutput,
} from "../types/workflow-runtime-types.ts";

type ConcreteCompressFormat = "zip" | "7z" | RomSpecificCompressionFormat;

type CompressSource = {
  fileName: string;
  size: number;
  metadata?: Record<string, unknown>;
};

/** One entry listed in an archive, by its path inside the archive. */
type ListedCompressEntry = { path: string; size?: number };
/** One file extracted from an opened archive. `output` owns the stored copy that `file` reads. */
type OpenedCompressEntry = { file: File; output: PublicOutput; path: string };

type ValidatedCompressInput = {
  cue?: File;
  files: File[];
  cueProblem?: string;
  source: CompressSource;
};

const logger = createLogger("compress-service");
const ARCHIVE_FORMATS = ["zip", "7z"] as const;
const ROM_SPECIFIC_FORMATS = ["chd", "rvz", "z3ds"] as const;
const getExtension = (fileName: string) => fileName.match(/\.([^./\\]+)$/)?.[1]?.toLowerCase() || "";

const assertFiles = (files: File[]) => {
  if (files.length === 0) throw new Error("Select at least one file to compress");
  const names = new Set<string>();
  for (const file of files) {
    if (!file.name) throw new Error("Every compression input must have a file name");
    if (names.has(file.name)) throw new Error(`Duplicate archive entry path: ${file.name}`);
    names.add(file.name);
  }
};

const validateInputs = async (files: File[]): Promise<ValidatedCompressInput> => {
  assertFiles(files);
  const cueFiles = files.filter((file) => getExtension(file.name) === "cue");
  if (cueFiles.length === 0) {
    return {
      files,
      source: {
        fileName: files[0]?.name || "input.bin",
        size: files[0]?.size || 0,
        ...(/\.(bin|iso)$/i.test(files[0]?.name || "")
          ? {
              metadata: { mode: getChdAutoCreateMode({ fileName: files[0]?.name, size: files[0]?.size }) },
            }
          : {}),
      },
    };
  }
  if (cueFiles.length !== 1) {
    return {
      files,
      cueProblem: "Compress accepts one CUE disc group at a time",
      source: { fileName: files[0]?.name || "input.bin", size: files[0]?.size || 0 },
    };
  }
  const cue = cueFiles[0];
  if (!cue) throw new Error("CUE input is unavailable");
  const references = parseCueFileReferences(await cue.text()).map((reference) => reference.fileName);
  let cueProblem: string | undefined;
  if (references.length === 0) cueProblem = `CUE file has no referenced tracks: ${cue.name}`;
  const trackName = (name: string) => getBaseFileName(name).toLowerCase();
  const referenced = new Set(references.map(trackName));
  if (!cueProblem && referenced.size !== references.length)
    cueProblem = `CUE file has ambiguous track names: ${cue.name}`;
  const suppliedTracks = files.filter((file) => file !== cue);
  const suppliedNames = new Set(suppliedTracks.map((file) => trackName(file.name)));
  if (!cueProblem && suppliedNames.size !== suppliedTracks.length)
    cueProblem = "CUE disc group has ambiguous track names";
  const missing = references.filter((name) => !suppliedNames.has(trackName(name)));
  if (!cueProblem && missing.length > 0) cueProblem = `CUE file references missing track: ${missing[0]}`;
  const extra = suppliedTracks.find((file) => !referenced.has(trackName(file.name)));
  if (!cueProblem && extra) cueProblem = `CUE disc group contains an unreferenced file: ${extra.name}`;
  return {
    cue,
    cueProblem,
    files,
    source: {
      fileName: cue.name,
      size: cue.size,
      metadata: { cuePath: cue.name, format: "CD", mode: "cd" },
    },
  };
};

const getCompressSource = async (files: File[]): Promise<CompressSource | null> => {
  if (files.length === 0) return null;
  return (await validateInputs(files)).source;
};

const getCompressFormats = async (files: File[]): Promise<ConcreteCompressFormat[]> => {
  if (files.length === 0) return [];
  const input = await validateInputs(files);
  if (input.cue) return input.cueProblem ? [...ARCHIVE_FORMATS] : [...ARCHIVE_FORMATS, "chd"];
  if (input.files.length !== 1) return [...ARCHIVE_FORMATS];

  const source = { ...input.source, metadata: { ...input.source.metadata } };
  const extension = getExtension(source.fileName);
  if (extension === "gdi" || ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS.includes(extension))
    return [...ARCHIVE_FORMATS];
  return [
    ...ARCHIVE_FORMATS,
    ...ROM_SPECIFIC_FORMATS.filter(
      (format) =>
        OutputCompressionManager.supportsOutputCompression(source, format) &&
        (format !== "chd" || (source.size > 0 && isLikelyDiscImageSize(source.size))),
    ),
  ];
};

const createAssets = async (input: ValidatedCompressInput): Promise<InputAsset[]> => {
  const cueText = input.cue ? await input.cue.text() : undefined;
  return Promise.all(
    input.files.map(async (source, index) => {
      const file = await createBlobBackedPatchFile(source, source.name, undefined, null, { materialize: false });
      const isCue = source === input.cue;
      if (isCue) file.metadata = { ...file.metadata, cueText };
      else if (!input.cue) file.metadata = { ...file.metadata, ...input.source.metadata };
      let kind: InputAsset["kind"] = "rom";
      if (input.cue) kind = isCue ? "cue" : "track";
      return {
        file,
        fileName: source.name,
        groupId: input.cue ? "compress-cue-group" : undefined,
        id: `compress-${index}`,
        kind,
        patchable: !isCue,
        size: source.size,
      } satisfies InputAsset;
    }),
  );
};

const isOpenableCompressInput = (file: File): boolean => isArchiveFileName(file.name);

const getEntryBaseName = (path: string): string => path.split("/").filter(Boolean).pop() || path;

/** Lists an archive's entries without extracting any of them. Directory entries are left out. */
const listCompressInput = async (
  file: File,
  runtime: WorkflowRuntime,
  options: Pick<CompressionWorkflowOptions, "onProgress" | "signal"> = {},
): Promise<ListedCompressEntry[]> => {
  const probe = runtime.compression.probe;
  if (!probe) throw new Error("Reading archives is not available in this browser.");
  logger.trace("list.start", { fileName: file.name, size: file.size });
  const result = await probe({ source: file, options });
  const entries = result.entries
    .filter((entry) => entry.filename && !entry.filename.endsWith("/") && entry.fileType !== "directory")
    .map((entry) => ({ path: entry.filename, ...(typeof entry.size === "number" ? { size: entry.size } : {}) }));
  logger.trace("list.done", { entryCount: entries.length, fileName: file.name });
  return entries;
};

const disposeOpenedOutputs = async (outputs: PublicOutput[]) => {
  await Promise.all(
    outputs.map((output) =>
      output.dispose().catch((cause: unknown) => logger.warn("Extracted file cleanup failed", { cause })),
    ),
  );
};

// Only the named entries are extracted, one at a time, so an unpicked multi-GB image never touches
// browser storage. Each `File` is the disk-backed snapshot of its stored copy, so it is never read into
// memory either. Callers MUST dispose every returned output.
const extractCompressEntries = async (
  file: File,
  paths: string[],
  runtime: WorkflowRuntime,
  options: Pick<CompressionWorkflowOptions, "onProgress" | "signal"> = {},
): Promise<OpenedCompressEntry[]> => {
  const extract = runtime.compression.extract;
  if (!extract) throw new Error("Extraction is not available in this browser.");
  // Entries keep their base name so CUE references still match. Entries that share a base name in
  // different folders take their folder path instead, or every compress run rejects them as duplicates.
  const baseNameCounts = new Map<string, number>();
  for (const path of paths)
    baseNameCounts.set(getEntryBaseName(path), (baseNameCounts.get(getEntryBaseName(path)) ?? 0) + 1);
  const entries: OpenedCompressEntry[] = [];
  const outputs: PublicOutput[] = [];
  try {
    for (const [index, path] of paths.entries()) {
      if (options.signal?.aborted) throw new DOMException("Opening cancelled", "AbortError");
      logger.trace("extract.entry", { fileName: file.name, index, path });
      const result = await extract({
        entries: [path],
        options: {
          directExtract: true,
          onProgress: (event) =>
            options.onProgress?.({
              ...event,
              percent:
                typeof event.percent === "number"
                  ? ((index + event.percent / 100) / paths.length) * 100
                  : event.percent,
            }),
          signal: options.signal,
        },
        source: file,
      });
      outputs.push(...result.outputs);
      const [output] = result.outputs;
      if (!output) throw new Error(`Extraction returned no file for ${path}`);
      const stored = await output.vfs.getFile?.(output.path);
      if (!stored) throw new Error(`Extracted file is not available: ${path}`);
      const baseName = getEntryBaseName(path);
      const name = (baseNameCounts.get(baseName) ?? 0) > 1 ? path.split("/").filter(Boolean).join(" - ") : baseName;
      entries.push({
        file: new File([stored], name, {
          lastModified: stored.lastModified,
          type: stored.type || "application/octet-stream",
        }),
        output,
        path,
      });
    }
    if (options.signal?.aborted) throw new DOMException("Opening cancelled", "AbortError");
  } catch (error) {
    await disposeOpenedOutputs(outputs);
    throw error;
  }
  logger.trace("extract.done", { entryCount: entries.length, fileName: file.name });
  return entries;
};

const compressFiles = async (
  files: File[],
  options: ApplyWorkflowOptions,
  runtime: WorkflowRuntime,
): Promise<PublicOutput> => {
  assertFiles(files);
  if (options.signal?.aborted) throw new DOMException("Compression cancelled", "AbortError");
  const compression = options.output?.compression;
  if (typeof compression !== "string" || !compression || compression === "auto" || compression === "none") {
    throw new Error("Compress requires a concrete output format");
  }
  if (isArchiveCompressionFormat(compression)) {
    const baseName = options.output?.outputName?.trim() || getFileNameWithoutExtension(files[0]?.name || "archive");
    return createArchiveOutput({
      compression,
      entries: files.map((file) => ({ file, filename: file.name })),
      options,
      outputName: `${baseName}.${compression}`,
      runtime,
    });
  }
  const input = await validateInputs(files);
  if (compression === "chd" && input.cueProblem) throw new Error(input.cueProblem);
  const supported = await getCompressFormats(files);
  if (!supported.includes(compression as ConcreteCompressFormat)) {
    throw new Error(`Compression format ${compression} does not support this file set`);
  }

  const assets = await createAssets(input);
  let outputFile: Awaited<ReturnType<typeof buildSessionOutputFiles>>["files"][number] | undefined;
  try {
    if (assets.length === 1 && assets[0]) {
      outputFile =
        (await createSingleFileRomSpecificOutput({
          compression: compression as RomSpecificCompressionFormat,
          outputFile: assets[0].file,
          options,
          runtime,
        })) || undefined;
    } else {
      const result = await buildSessionOutputFiles(assets, new Map(), options, runtime);
      outputFile = result.files[0];
    }
    if (!outputFile) throw new Error("Compression did not produce an output file");
    const output = await toPublicOutput(outputFile, runtime);
    return output;
  } catch (error) {
    await Promise.resolve(outputFile ? getPatchFileCleanup(outputFile)?.() : undefined).catch(() => undefined);
    throw error;
  }
};

export type { CompressSource, ListedCompressEntry, OpenedCompressEntry };
export {
  compressFiles,
  disposeOpenedOutputs,
  getCompressFormats,
  getCompressSource,
  extractCompressEntries,
  isOpenableCompressInput,
  listCompressInput,
};
