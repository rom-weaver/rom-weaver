import {
  createCompressionProgressLabel,
  getProgressEventPercent,
  getRawProgressLabel,
} from "../../presentation/workflow-presentation.ts";
import { isVfsFileRef } from "../../storage/vfs/source-ref.ts";
import type { ArchiveEntryInput, JsonValue, ProgressEvent as SharedProgressEvent } from "../../types/runtime.ts";
import type {
  ApplyWorkflowOptions,
  CompressionEntryInput,
  ProgressEvent,
  PublicOutput,
} from "../../types/workflow-runtime.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import { resolveCompressionLevels } from "../compression/compression-settings.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";
import type { PatchFileInstance } from "../input/binary-service.ts";
import { clonePatchFile, decodeUtf8, getPatchFileBytes, getPatchFileExternalSource } from "../input/binary-service.ts";
import { getChdAutoCreateMode, replaceCuePatchFileName } from "../input/disc-file-utils.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { getFileNameWithoutExtension } from "../input/path-utils.ts";
import { reportProgress } from "../progress/progress-reporting.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import { createPatchedOutputPlan, type PatchedOutputPlan } from "./patched-output-plan.ts";

const DEFAULT_CHD_CREATE_CD_CODECS = "cdlz,cdzl,cdfl";
const DEFAULT_CHD_CREATE_DVD_CODECS = "lzma,zlib,huff,flac";

const hasDiscCompressionMetadata = (source: PatchFileInstance | null | undefined) =>
  !!(
    source?._chdSourceFileName ||
    source?._chdCueText ||
    source?._chdMode === "cd" ||
    source?._chdMode === "dvd" ||
    source?._rvzSourceFileName ||
    source?._z3dsSourceFileName
  );

const getOutputCompression = (options: ApplyWorkflowOptions | undefined, source?: PatchFileInstance | null) => {
  if (options?.output?.compression !== undefined && options.output.compression !== null)
    return options.output.compression;
  return hasDiscCompressionMetadata(source) ? "auto" : "7z";
};
const getCompressionProfile = (options: ApplyWorkflowOptions | undefined) =>
  options?.output?.container?.profile || "high";
const getWorkerThreads = (options: ApplyWorkflowOptions | undefined) => options?.workers?.threads;
const getLogLevel = (options: ApplyWorkflowOptions | undefined) => options?.logging?.level;
const getContainerSettings = (options: ApplyWorkflowOptions | undefined) => options?.output?.container || {};

const getDefaultChdCompressionCodecs = (mode: string | null | undefined, compressionProfile: string) =>
  OutputCompressionManager.getChdCodecsForMode(mode, {
    chdCreateCdCodecs: DEFAULT_CHD_CREATE_CD_CODECS,
    chdCreateDvdCodecs: DEFAULT_CHD_CREATE_DVD_CODECS,
    compressionProfile,
  });

const createArchiveProgressReporter =
  (compression: "zip" | "7z", options: ApplyWorkflowOptions | undefined) => (progress: SharedProgressEvent) => {
    const formatLabel = compression === "zip" ? "ZIP" : "7z";
    reportProgress(options, {
      details: progress as RuntimeValue as JsonValue,
      label: createCompressionProgressLabel({
        fallbackLabel: `Compressing to ${formatLabel}`,
        formatLabel,
        threads: getWorkerThreads(options),
      }),
      percent: getProgressEventPercent(progress),
      stage: "output",
    });
  };

const canReusePublicOutputPath = (output: unknown) =>
  !!(
    output &&
    typeof output === "object" &&
    "path" in output &&
    typeof (output as { path?: unknown }).path === "string" &&
    (output as { path: string }).path &&
    "vfs" in output &&
    (output as { vfs?: unknown }).vfs
  );

const createPatchFileFromRuntimeOutput = async (output: PublicOutput, fallbackFileName: string) =>
  createPatchFileFromPublicOutput(
    output,
    fallbackFileName,
    canReusePublicOutputPath(output)
      ? {
          materializeBlob: false,
          preferExternalFilePath: true,
        }
      : undefined,
  );

const createArchiveEntryInputFromPatchFile = (
  file: PatchFileInstance,
  outputFileName: string,
): { entry: ArchiveEntryInput; size: number } => {
  const sourceRef = getPatchFileExternalSource(file, outputFileName);
  if (sourceRef) {
    if (typeof sourceRef.source === "string" && sourceRef.source.trim()) {
      return {
        entry: { filename: outputFileName, filePath: sourceRef.source },
        size: sourceRef.size || file.fileSize || 0,
      };
    }
    if (isVfsFileRef(sourceRef.source)) {
      return {
        entry: { filename: outputFileName, filePath: sourceRef.source.path },
        size: sourceRef.size || file.fileSize || 0,
      };
    }
    if (typeof Blob !== "undefined" && sourceRef.source instanceof Blob) {
      return {
        entry: { file: sourceRef.source, filename: outputFileName },
        size: sourceRef.size || sourceRef.source.size || file.fileSize || 0,
      };
    }
  }

  const data = getPatchFileBytes(file);
  return {
    entry: { data, filename: outputFileName },
    size: data.byteLength,
  };
};

const toBlobPart = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const createRuntimeSourceFromPatchFile = (file: PatchFileInstance, fallbackFileName: string) => {
  const sourceRef = getPatchFileExternalSource(file, fallbackFileName);
  if (sourceRef) {
    if (typeof sourceRef.source === "string" && sourceRef.source.trim()) return sourceRef.source;
    if (isVfsFileRef(sourceRef.source)) return sourceRef.source;
    if (typeof Blob !== "undefined" && sourceRef.source instanceof Blob) return sourceRef.source;
  }

  const bytes = getPatchFileBytes(file);
  if (typeof File !== "undefined")
    return new File([toBlobPart(bytes)], fallbackFileName, { type: "application/octet-stream" });
  return new Blob([toBlobPart(bytes)], { type: "application/octet-stream" });
};

const toRuntimeCompressionEntry = (entry: ArchiveEntryInput): CompressionEntryInput => {
  const fileName = entry.fileName || entry.filename || entry.name || "entry.bin";
  const file =
    entry.file && typeof File === "function"
      ? entry.file instanceof File
        ? entry.file
        : new File([entry.file as BlobPart], fileName, { type: "application/octet-stream" })
      : undefined;
  return {
    arrayBuffer: entry.arrayBuffer,
    data: entry.data,
    file,
    fileName,
    filename: entry.filename || fileName,
    filePath: entry.filePath,
    lastModified: entry.lastModified,
    mtime: entry.mtime,
    name: entry.name || fileName,
    text: entry.text,
    u8array: entry.u8array,
  };
};

const createRuntimeDiscOutputFiles = async (
  compression: string,
  patchedRom: PatchFileInstance,
  outputPlan: PatchedOutputPlan,
  options: ApplyWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
): Promise<PatchFileInstance[] | null> => {
  type RuntimeCompressionCreateRequest = Parameters<NonNullable<WorkflowRuntime["compression"]["create"]>>[0];

  if (!runtime?.compression.create) return null;
  if (compression !== "chd" && compression !== "rvz" && compression !== "z3ds") return null;

  const inputFileName = outputPlan.inputFileName || patchedRom.fileName || "patched.bin";
  const source = createRuntimeSourceFromPatchFile(patchedRom, inputFileName);
  const runtimeOptions = {
    logLevel: getLogLevel(options),
    onLog: options?.onLog,
    onProgress: (progress: ProgressEvent) => reportProgress(options, progress),
    workerThreads: getWorkerThreads(options),
  };
  let request: RuntimeCompressionCreateRequest;
  if (compression === "chd") {
    request = {
      chdSourceMode: outputPlan.chdSourceMode,
      compressionCodecs: outputPlan.chdCompressionCodecs,
      cueText: outputPlan.chdCueText,
      fileName: inputFileName,
      format: "chd",
      mode: outputPlan.chdCreateMode,
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      source,
    };
  } else if (compression === "rvz") {
    request = {
      fileName: inputFileName,
      format: "rvz",
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      rvzBlockSize: outputPlan.rvzOptions?.rvzBlockSize as string | number | null | undefined,
      rvzCompression: outputPlan.rvzOptions?.rvzCompression as string | null | undefined,
      rvzCompressionLevel: outputPlan.rvzOptions?.rvzCompressionLevel as string | number | null | undefined,
      rvzMode: outputPlan.rvzMode,
      rvzScrub: outputPlan.rvzOptions?.rvzScrub as boolean | string | number | null | undefined,
      rvzSourceFileName: outputPlan.rvzSourceFileName,
      source,
    };
  } else {
    request = {
      fileName: inputFileName,
      format: "z3ds",
      options: runtimeOptions,
      outputName: outputPlan.finalOutputFileName,
      source,
      z3dsCompressionLevel: outputPlan.z3dsOptions?.compressionLevel as string | number | null | undefined,
      z3dsMetadata: outputPlan.z3dsMetadata,
      z3dsSourceFileName: outputPlan.z3dsSourceFileName,
      z3dsUnderlyingMagic: outputPlan.z3dsUnderlyingMagic,
    };
  }
  const result = await runtime.compression.create(request);
  const output = "output" in result ? result.output : result;
  return [await createPatchFileFromRuntimeOutput(output, outputPlan.finalOutputFileName)];
};

const buildOutputFiles = async (
  romFile: PatchFileInstance,
  patchedRom: PatchFileInstance,
  options: ApplyWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
): Promise<PatchFileInstance[]> => {
  const compression = OutputCompressionManager.resolveOutputCompression(romFile, {
    compressionFormat: getOutputCompression(options, romFile),
  });
  if (compression === "none") return [patchedRom];

  const archiveSettings = getContainerSettings(options);
  const levels = resolveCompressionLevels({
    compressionProfile: getCompressionProfile(options),
    sevenZipCodec: archiveSettings.sevenZipCodec,
    sevenZipLevel: archiveSettings.sevenZipLevel,
    z3dsCompressionLevel: archiveSettings.z3dsCompressionLevel,
    zipCodec: archiveSettings.zipCodec,
    zipLevel: archiveSettings.zipLevel,
  });
  const outputPlan = createPatchedOutputPlan({
    chdOutputMode: "auto",
    compressionFormat: compression,
    compressionSettings: levels,
    patchedFileName: patchedRom.fileName,
    replaceCuePatchFileName: (cueText: string, outputName: string) => replaceCuePatchFileName(cueText, outputName),
    resolveChdCodecMode: (_fileName: string, mode: string | null) =>
      mode === "auto" ? getChdAutoCreateMode(patchedRom) : mode,
    resolveChdCompressionCodecs: (mode: string | null) =>
      getDefaultChdCompressionCodecs(mode, getCompressionProfile(options)),
    romFile,
    rvzOptions: {},
    z3dsOptions: {
      compressionLevel: levels.z3dsCompressionLevel,
    },
  });
  if (compression === "zip" || compression === "7z") {
    const archiveEntryFileName =
      "archiveEntryFileName" in outputPlan && typeof outputPlan.archiveEntryFileName === "string"
        ? outputPlan.archiveEntryFileName
        : patchedRom.fileName;
    const entries = [createArchiveEntryInputFromPatchFile(patchedRom, archiveEntryFileName || patchedRom.fileName)];
    if (outputPlan.cueOutput) {
      const data = new TextEncoder().encode(outputPlan.cueOutput.text);
      entries.push({
        entry: { data, filename: outputPlan.cueOutput.fileName },
        size: data.byteLength,
      });
    }
    return [
      await createCompressedArchive(
        entries.map((entry) => entry.entry),
        compression,
        outputPlan.finalOutputFileName,
        options,
        runtime,
      ),
    ];
  }
  const runtimeDiscOutputs = await createRuntimeDiscOutputFiles(compression, patchedRom, outputPlan, options, runtime);
  if (runtimeDiscOutputs) return runtimeDiscOutputs;
  throw new Error("Runtime disc compression create capability is unavailable");
};

const getOutputBaseName = (assets: InputAsset[]) => {
  const cueAsset = assets.find((asset) => asset.kind === "cue");
  const firstAsset = cueAsset || assets[0];
  const name = firstAsset?.fileName || "patched.bin";
  return getFileNameWithoutExtension(name) || "patched";
};

const createCompressedArchive = async (
  entries: ArchiveEntryInput[],
  compression: "zip" | "7z",
  fileName: string,
  options: ApplyWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
) => {
  const archiveSettings = getContainerSettings(options);
  const levels = resolveCompressionLevels({
    compressionProfile: getCompressionProfile(options),
    sevenZipCodec: archiveSettings.sevenZipCodec,
    sevenZipLevel: archiveSettings.sevenZipLevel,
    zipCodec: archiveSettings.zipCodec,
    zipLevel: archiveSettings.zipLevel,
  });
  if (!runtime?.compression.create) throw new Error("Runtime compression create capability is unavailable");
  const result = await runtime.compression.create({
    entries: entries.map((entry) => toRuntimeCompressionEntry(entry)),
    format: compression,
    options: {
      compression,
      compressionProfile: getCompressionProfile(options),
      logLevel: getLogLevel(options),
      onLog: options?.onLog,
      onProgress: createArchiveProgressReporter(compression, options),
      outputName: fileName,
      sevenZipCodec: levels.sevenZipCodec as "lzma2" | "zstd",
      sevenZipLevel: levels.sevenZipLevel,
      workerThreads: getWorkerThreads(options),
      zipCodec: levels.zipCodec as "deflate" | "store" | "zstd",
      zipLevel: levels.zipLevel,
    },
  });
  const output = "output" in result ? result.output : result;
  return createPatchFileFromRuntimeOutput(output, fileName);
};

const createArchiveEntryFromPatchFile = (
  asset: InputAsset,
  file: PatchFileInstance,
): { entry: ArchiveEntryInput; size: number } => {
  if (asset.kind === "cue") {
    const cueText = asset.disc?.cueText || decodeUtf8(getPatchFileBytes(file));
    const data = new TextEncoder().encode(cueText);
    return {
      entry: { data, filename: asset.fileName },
      size: data.byteLength,
    };
  }

  const sourceRef = getPatchFileExternalSource(file, asset.fileName);
  if (sourceRef) {
    if (typeof sourceRef.source === "string" && sourceRef.source.trim()) {
      return {
        entry: { filename: asset.fileName, filePath: sourceRef.source },
        size: sourceRef.size || file.fileSize || 0,
      };
    }
    if (isVfsFileRef(sourceRef.source)) {
      return {
        entry: { filename: asset.fileName, filePath: sourceRef.source.path },
        size: sourceRef.size || file.fileSize || 0,
      };
    }
    if (typeof Blob !== "undefined" && sourceRef.source instanceof Blob) {
      return {
        entry: { file: sourceRef.source, filename: asset.fileName },
        size: sourceRef.size || sourceRef.source.size || file.fileSize || 0,
      };
    }
  }

  const data = getPatchFileBytes(file);
  return {
    entry: { data, filename: asset.fileName },
    size: data.byteLength,
  };
};

const assertOutputSizeLimit = (rawOutputSize: number, options: ApplyWorkflowOptions | undefined) => {
  const maxOutputBytes = Number(options?.limits?.maxOutputBytes);
  if (Number.isFinite(maxOutputBytes) && maxOutputBytes >= 0 && rawOutputSize > maxOutputBytes) {
    throw new Error("Output size exceeds configured limit");
  }
};

const buildSessionOutputFiles = async (
  assets: InputAsset[],
  patchedById: Map<string, PatchFileInstance>,
  options: ApplyWorkflowOptions | undefined,
  runtime?: WorkflowRuntime,
): Promise<{ files: PatchFileInstance[]; rawOutputSize: number }> => {
  const outputAssets = assets.map((asset) => {
    const patched = patchedById.get(asset.id);
    const file = patched ? patched : clonePatchFile(asset.file);
    if (!file.fileName) file.fileName = asset.fileName;
    return { asset, file };
  });
  const compressionSource =
    outputAssets.find(({ asset }) => asset.patchable)?.asset.file || outputAssets[0]?.asset.file;
  const compression = OutputCompressionManager.resolveOutputCompression(compressionSource, {
    compressionFormat: getOutputCompression(options, compressionSource),
  });
  if (outputAssets.length === 1) {
    const onlyOutput = outputAssets[0];
    if (!onlyOutput) throw new Error("No output file was produced");
    const onlyFile = onlyOutput.file;
    assertOutputSizeLimit(onlyFile.fileSize, options);
    if (compression === "none") return { files: [onlyFile], rawOutputSize: onlyFile.fileSize };
    return {
      files: await buildOutputFiles(onlyOutput.asset.file, onlyFile, options, runtime),
      rawOutputSize: onlyFile.fileSize,
    };
  }

  const entries = outputAssets.map(({ asset, file }) => createArchiveEntryFromPatchFile(asset, file));
  const rawOutputSize = entries.reduce((total, entry) => total + entry.size, 0);
  assertOutputSizeLimit(rawOutputSize, options);

  if (compression === "none") {
    throw new Error(
      "output.compression: 'none' cannot be used for multi-file output; use output.compression: 'zip' with zipCodec: 'store'",
    );
  }
  if (compression === "rvz") throw new Error("RVZ output is not supported for CD disc groups");
  if (compression === "z3ds") throw new Error("Z3DS output is not supported for CD disc groups");

  const baseName = getOutputBaseName(assets);
  if (compression === "zip")
    return {
      files: [
        await createCompressedArchive(
          entries.map((entry) => entry.entry),
          "zip",
          `${baseName}.zip`,
          options,
          runtime,
        ),
      ],
      rawOutputSize,
    };
  if (compression === "7z")
    return {
      files: [
        await createCompressedArchive(
          entries.map((entry) => entry.entry),
          "7z",
          `${baseName}.7z`,
          options,
          runtime,
        ),
      ],
      rawOutputSize,
    };
  if (compression === "chd") {
    const cueAsset = assets.find((asset) => asset.kind === "cue");
    const trackAssets = outputAssets.filter(({ asset }) => asset.kind === "track");
    if (!cueAsset || trackAssets.length !== 1)
      throw new Error("CHD output currently requires a single-track CUE disc group");
    const trackAsset = trackAssets[0];
    if (!trackAsset) throw new Error("CHD output currently requires a single-track CUE disc group");
    if (!runtime?.compression.create) throw new Error("Runtime CHD compression capability is unavailable");
    const inputFile = clonePatchFile(trackAsset.file);
    inputFile.fileName = trackAsset.asset.fileName;
    const source = createRuntimeSourceFromPatchFile(inputFile, inputFile.fileName);
    const result = await runtime.compression.create({
      compressionCodecs: getDefaultChdCompressionCodecs("cd", getCompressionProfile(options)),
      cueText: cueAsset.disc?.cueText,
      fileName: inputFile.fileName,
      format: "chd",
      mode: "cd",
      options: {
        logLevel: getLogLevel(options),
        onLog: options?.onLog,
        onProgress: (progress: SharedProgressEvent) =>
          reportProgress(options, {
            details: progress as RuntimeValue as JsonValue,
            label: getRawProgressLabel(
              progress,
              createCompressionProgressLabel({
                fallbackLabel: "Compressing to CHD",
                formatLabel: "CHD",
                threads: getWorkerThreads(options),
              }),
            ),
            percent: getProgressEventPercent(progress),
            stage: "output",
          }),
        workerThreads: getWorkerThreads(options),
      },
      outputName: `${baseName}.chd`,
      source,
    });
    const output = "output" in result ? result.output : result;
    return {
      files: [await createPatchFileFromRuntimeOutput(output, `${baseName}.chd`)],
      rawOutputSize,
    };
  }
  return {
    files: [
      await createCompressedArchive(
        entries.map((entry) => entry.entry),
        "7z",
        `${baseName}.7z`,
        options,
        runtime,
      ),
    ],
    rawOutputSize,
  };
};

export { buildSessionOutputFiles };
