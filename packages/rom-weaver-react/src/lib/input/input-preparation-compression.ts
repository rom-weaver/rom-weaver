import { getProgressEventPercent, getRawProgressLabel } from "../../presentation/workflow-presentation.ts";
import type { JsonValue, ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type { ApplyWorkflowOptions, CreateWorkflowOptions } from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import {
  CHD_DECOMPRESSION_INPUT_EXTENSIONS,
  hasDiscExtension,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
} from "../compression/disc-format-support.ts";
import { RomWeaverError } from "../errors.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import type { PatchFileInstance } from "./binary-service.ts";
import {
  getPatchFileBlob,
  getPatchFileCleanup,
  getPatchFileExternalSource,
  isLazyExternalPatchFile,
} from "./binary-service.ts";
import { getChdExtractedFileName, getRvzExtractedFileName, getZ3dsExtractedFileName } from "./disc-file-utils.ts";

const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const MAX_RECURSIVE_DECOMPRESSION_PASSES = 8;

type InputPreparationOptions = ApplyWorkflowOptions | CreateWorkflowOptions | undefined;
type InputPreparationRuntime = Pick<WorkflowRuntime, "compression" | "name" | "workerIo">;
type CompressionInputKind = "chd" | "rvz" | "z3ds";
const DEFAULT_INPUT_PREPARATION_RUNTIME: Pick<WorkflowRuntime, "name"> = {
  name: "browser",
};
const CHD_MAGIC = [0x4d, 0x43, 0x6f, 0x6d, 0x70, 0x72, 0x48, 0x44];
const RVZ_MAGIC = [0x52, 0x56, 0x5a, 0x00];
const Z3DS_MAGIC = [0x5a, 0x33, 0x44, 0x53];

let defaultBrowserRuntimePromise: Promise<WorkflowRuntime> | null = null;

type BrowserRuntimeModule = {
  createBrowserRuntime: () => WorkflowRuntime;
};

const importBrowserRuntimeModule = () =>
  import("../../platform/browser/workflow-runtime.ts") as Promise<BrowserRuntimeModule>;

const resolveBrowserInputPreparationRuntime = async (): Promise<InputPreparationRuntime> => {
  if (!defaultBrowserRuntimePromise) {
    defaultBrowserRuntimePromise = importBrowserRuntimeModule().then(({ createBrowserRuntime }) =>
      createBrowserRuntime(),
    );
  }
  return defaultBrowserRuntimePromise;
};

const resolveDefaultInputPreparationRuntime = async (): Promise<InputPreparationRuntime> =>
  resolveBrowserInputPreparationRuntime();

const resolveNamedInputPreparationRuntime = async (runtimeName: WorkflowRuntime["name"]) => {
  if (runtimeName === "browser") return resolveBrowserInputPreparationRuntime();
  return resolveDefaultInputPreparationRuntime();
};

const resolveInputPreparationRuntime = async (
  runtime: InputPreparationRuntime | Pick<WorkflowRuntime, "name"> = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<InputPreparationRuntime> => {
  if ("workerIo" in runtime && runtime.workerIo) return runtime;
  return resolveNamedInputPreparationRuntime(runtime.name);
};

const canInspectDiscMagicSynchronously = (binFile: PatchFileInstance) =>
  binFile._u8array instanceof Uint8Array || (!binFile._browserFileBacked && typeof binFile.readIntoAt === "function");

const isDiscDecompressionOutput = (binFile: PatchFileInstance) =>
  !!(binFile as { _discDecompressionOutput?: boolean })._discDecompressionOutput;

const readSyncHeader = (binFile: PatchFileInstance, length: number) => {
  try {
    if (binFile._u8array instanceof Uint8Array) return binFile._u8array.subarray(0, length);
    if (binFile._browserFileBacked || typeof binFile.readIntoAt !== "function") return null;
    const buffer = new Uint8Array(length);
    const read = binFile.readIntoAt(buffer, 0, length, 0);
    return typeof read === "number" ? buffer.subarray(0, read) : buffer;
  } catch (_error) {
    return null;
  }
};

const hasMagicPrefix = (bytes: Uint8Array | null | undefined, magic: number[]) =>
  !!bytes && bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);

const resolveDiscKindFromHeader = (header: Uint8Array | null | undefined): CompressionInputKind | null => {
  if (hasMagicPrefix(header, CHD_MAGIC)) return "chd";
  if (hasMagicPrefix(header, RVZ_MAGIC)) return "rvz";
  if (hasMagicPrefix(header, Z3DS_MAGIC)) return "z3ds";
  return null;
};

const readBlobHeader = async (binFile: PatchFileInstance, length: number): Promise<Uint8Array | null> => {
  const blob = getPatchFileBlob(binFile);
  if (!blob) return null;
  const header = await blob.slice(0, length).arrayBuffer();
  return new Uint8Array(header, 0, Math.min(length, header.byteLength));
};

const resolveDiscCompressionKind = async (binFile: PatchFileInstance): Promise<CompressionInputKind | null> => {
  if (canInspectDiscMagicSynchronously(binFile)) {
    const kind = resolveDiscKindFromHeader(readSyncHeader(binFile, CHD_MAGIC.length));
    if (kind || isDiscDecompressionOutput(binFile)) return kind;
  }
  const header = await readBlobHeader(binFile, CHD_MAGIC.length);
  if (header) {
    const kind = resolveDiscKindFromHeader(header);
    if (kind || isDiscDecompressionOutput(binFile)) return kind;
  }
  if (isDiscDecompressionOutput(binFile)) return null;
  if (typeof binFile.getExtension === "function") {
    const extension = binFile.getExtension();
    if (hasDiscExtension(CHD_DECOMPRESSION_INPUT_EXTENSIONS, extension)) return "chd";
    if (hasDiscExtension(RVZ_DECOMPRESSION_INPUT_EXTENSIONS, extension)) return "rvz";
    if (hasDiscExtension(Z3DS_DECOMPRESSION_INPUT_EXTENSIONS, extension)) return "z3ds";
  }
  return null;
};

const looksLikeRvzFile = (binFile: PatchFileInstance) =>
  hasMagicPrefix(readSyncHeader(binFile, RVZ_MAGIC.length), RVZ_MAGIC) ||
  (!isDiscDecompressionOutput(binFile) &&
    hasDiscExtension(RVZ_DECOMPRESSION_INPUT_EXTENSIONS, getFileExtension(binFile)));

const looksLikeZ3dsFile = (binFile: PatchFileInstance) =>
  hasMagicPrefix(readSyncHeader(binFile, Z3DS_MAGIC.length), Z3DS_MAGIC) ||
  (!isDiscDecompressionOutput(binFile) &&
    hasDiscExtension(Z3DS_DECOMPRESSION_INPUT_EXTENSIONS, getFileExtension(binFile)));

const getDiscCompressionInputProgressLabel = (file: PatchFileInstance): string | null => {
  if (looksLikeChdFile(file)) return "Preparing CHD extraction...";
  if (looksLikeRvzFile(file)) return "Preparing RVZ extraction...";
  if (looksLikeZ3dsFile(file)) return "Preparing Z3DS extraction...";
  return null;
};

const getFileExtension = (binFile: PatchFileInstance) => {
  if (typeof binFile.getExtension === "function") return binFile.getExtension();
  const fileName = String(binFile.fileName || "").replace(FILE_QUERY_OR_HASH_REGEX, "");
  const extensionIndex = fileName.lastIndexOf(".");
  return extensionIndex === -1 ? "" : fileName.slice(extensionIndex + 1);
};

const looksLikeChdFile = (binFile: PatchFileInstance) => {
  if (hasMagicPrefix(readSyncHeader(binFile, CHD_MAGIC.length), CHD_MAGIC)) return true;
  if (isDiscDecompressionOutput(binFile)) return false;
  if (hasDiscExtension(CHD_DECOMPRESSION_INPUT_EXTENSIONS, getFileExtension(binFile))) return true;
  return false;
};

const decorateCompressionPatchFile = (
  file: PatchFileInstance,
  result: Partial<{
    chdCueFileName?: string;
    chdCueText?: string;
    chdMode?: string;
    chdSourceFileName?: string;
    rvzMode?: string;
    rvzSourceFileName?: string;
    z3dsMetadata?: RuntimeValue;
    z3dsSourceFileName?: string;
    z3dsUnderlyingMagic?: string;
  }>,
) => {
  if (result.chdMode) file._chdMode = result.chdMode;
  if (result.chdCueText) file._chdCueText = result.chdCueText;
  if (result.chdCueFileName) file._chdCueFileName = result.chdCueFileName;
  if (result.chdSourceFileName) file._chdSourceFileName = result.chdSourceFileName;
  if (result.rvzMode) file._rvzMode = result.rvzMode;
  if (result.rvzSourceFileName) file._rvzSourceFileName = result.rvzSourceFileName;
  if (result.z3dsMetadata)
    file._z3dsMetadata = result.z3dsMetadata as Record<
      string,
      string | number | boolean | Uint8Array | null | undefined
    >;
  if (result.z3dsSourceFileName) file._z3dsSourceFileName = result.z3dsSourceFileName;
  if (result.z3dsUnderlyingMagic) file._z3dsUnderlyingMagic = result.z3dsUnderlyingMagic;
  return file;
};

const createInputProgressReporter =
  (options: InputPreparationOptions, label: string) => (progress: SharedProgressEvent) =>
    reportProgress(options, {
      details: progress as RuntimeValue as JsonValue,
      label: getRawProgressLabel(progress, label),
      percent: getProgressEventPercent(progress),
      stage: "input",
    });

const cleanupIntermediateFile = async (file: PatchFileInstance, originalFile: PatchFileInstance) => {
  if (file === originalFile) return;
  await Promise.resolve(getPatchFileCleanup(file)?.()).catch(() => undefined);
};

const resolveSingleCompressionInput = async (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntime | Pick<WorkflowRuntime, "name"> = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<PatchFileInstance | null> => {
  const resolvedRuntime = await resolveInputPreparationRuntime(runtime);
  if (!resolvedRuntime.compression.extract) throw new Error("Compression extraction is unavailable");
  const logLevel = options?.logging?.level;
  const onLog = options?.onLog;
  const workerThreads = options?.workers?.threads;
  const extractInRuntime = async (format: "chd" | "rvz" | "z3ds", outputName: string, progressLabel: string) => {
    const externalSource = getPatchFileExternalSource(file, file.fileName || outputName);
    const blobSource = getPatchFileBlob(file);
    if (!(externalSource || blobSource))
      throw new Error(`Disc decompression requires filesystem-backed sources: ${file.fileName || outputName}`);
    const source = externalSource
      ? {
          fileName: externalSource.fileName || file.fileName || outputName,
          ...(typeof externalSource.size === "number" ? { size: externalSource.size } : {}),
          source: externalSource.source,
        }
      : {
          ...(typeof file.fileSize === "number" && Number.isFinite(file.fileSize) ? { size: file.fileSize } : {}),
          fileName: file.fileName || outputName,
          source: blobSource as Blob,
        };
    const result = await resolvedRuntime.compression.extract!({
      entries: [outputName],
      format,
      options: {
        logLevel,
        onLog,
        onProgress: createInputProgressReporter(options, progressLabel),
        workerThreads,
      },
      outputName,
      source,
    });
    const output = result.outputs[0];
    if (!output) throw new Error(`Compression extraction did not return output: ${format}`);
    const extracted = await createPatchFileFromPublicOutput(output, output.fileName || outputName, {
      materializeBlob: false,
    });
    extracted.fileName = output.fileName || outputName;
    return decorateCompressionPatchFile(extracted, {});
  };
  const compressionKind = await resolveDiscCompressionKind(file);
  if (compressionKind === "chd") {
    const decompressed = await extractInRuntime("chd", getChdExtractedFileName(file), "Extracting CHD...");
    (decompressed as { _discDecompressionOutput?: boolean })._discDecompressionOutput = true;
    return decompressed;
  }
  if (compressionKind === "rvz") {
    const decompressed = await extractInRuntime("rvz", getRvzExtractedFileName(file), "Extracting RVZ...");
    (decompressed as { _discDecompressionOutput?: boolean })._discDecompressionOutput = true;
    return decompressed;
  }
  if (compressionKind === "z3ds") {
    const decompressed = await extractInRuntime("z3ds", getZ3dsExtractedFileName(file), "Extracting Z3DS...");
    (decompressed as { _discDecompressionOutput?: boolean })._discDecompressionOutput = true;
    return decompressed;
  }
  return null;
};

const resolveDiscCompressionInput = async (
  file: PatchFileInstance,
  options: InputPreparationOptions,
  runtime: InputPreparationRuntime | Pick<WorkflowRuntime, "name"> = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<PatchFileInstance> => {
  if (options?.input?.containerInputsEnabled === false) return file;
  let current = file;
  for (let pass = 0; pass < MAX_RECURSIVE_DECOMPRESSION_PASSES; pass += 1) {
    const decompressed = await resolveSingleCompressionInput(current, options, runtime);
    if (!decompressed) return current;
    await cleanupIntermediateFile(current, file);
    if (
      isLazyExternalPatchFile(decompressed) ||
      (isDiscDecompressionOutput(decompressed) && !canInspectDiscMagicSynchronously(decompressed))
    )
      return decompressed;
    current = decompressed;
  }
  await cleanupIntermediateFile(current, file);
  throw new RomWeaverError("COMPRESSION_FAILED", "Recursive input decompression exceeded the supported limit", {
    details: { maxDecompressionPasses: MAX_RECURSIVE_DECOMPRESSION_PASSES },
  });
};

const resolveCompressionInput = resolveDiscCompressionInput;

export type { InputPreparationRuntime };
export {
  DEFAULT_INPUT_PREPARATION_RUNTIME,
  getDiscCompressionInputProgressLabel,
  resolveCompressionInput,
  resolveDiscCompressionInput,
  resolveInputPreparationRuntime,
};
